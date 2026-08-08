/**
 * Bounded decoder for native Claude, Codex, and Kimi hook payloads.
 *
 * A provider hook invokes the CLI with one JSON object on stdin. This module
 * maps the supported hook events onto normalized `RegistryEvent` values while
 * enforcing the privacy contract: only allowlisted fields are read, every
 * accepted string is capped at 256 Unicode code points, and the working
 * directory survives only as its basename. Payloads with missing identity,
 * unknown hook names, or non-object shapes decode to zero events.
 */

import { basename } from "node:path";
import type { Provider, RegistryEvent } from "../protocol";

/**
 * The only payload keys this decoder may read, as alias groups in priority
 * order (underscore spellings first, camel-case fallbacks after).
 */
const SAFE_FIELDS = {
  hookEventName: ["hook_event_name", "hookEventName"],
  sessionId: ["session_id", "sessionId"],
  agentId: ["agent_id", "agentId"],
  agentType: ["agent_type", "agentType", "agent_name"],
  source: ["source"],
  notificationType: ["notification_type", "notificationType"],
  toolName: ["tool_name", "toolName"],
  cwd: ["cwd"],
  title: ["title", "session_title", "sessionTitle"],
} as const;

/**
 * Child identity for subagent events: Claude sends `agent_id`; Kimi payloads
 * carry only `agent_name` (official docs name no `agent_id`), so the first
 * non-empty allowlisted value among all three identifies the child.
 */
const CHILD_IDENTITY_FIELDS = [
  ...SAFE_FIELDS.agentId,
  "agent_name",
] as const;

const MAX_STRING_CODE_POINTS = 256;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Unicode-safe cap: count code points, never UTF-16 code units. */
const boundString = (value: string): string =>
  Array.from(value).slice(0, MAX_STRING_CODE_POINTS).join("");

/**
 * First non-empty string among the allowlisted aliases, bounded. Non-string
 * and empty values count as absent.
 */
const firstAllowlistedString = (
  record: Record<string, unknown>,
  aliases: readonly string[],
): string | undefined => {
  for (const alias of aliases) {
    const value = record[alias];
    if (typeof value === "string" && value.length > 0) {
      return boundString(value);
    }
  }
  return undefined;
};

/** Only the basename of the allowlisted working directory survives. */
const projectFromCwd = (cwd: string | undefined): string | null => {
  if (cwd === undefined) {
    return null;
  }
  const base = basename(cwd);
  return base.length > 0 ? base : null;
};

const statusEvent = (
  kind: "Activity" | "Attention" | "Stop" | "StopFailure" | "SessionEnd" | "SubagentStop",
  provider: Provider,
  sessionId: string,
  now: string,
): RegistryEvent => ({ kind, provider, sessionId, observedAt: now });

const sessionFacts = (
  provider: Provider,
  sessionId: string,
  value: Record<string, unknown>,
  now: string,
): Omit<Extract<RegistryEvent, { kind: "SessionObserved" }>, "kind"> => ({
  provider,
  sessionId,
  title: firstAllowlistedString(value, SAFE_FIELDS.title) ?? null,
  project: projectFromCwd(firstAllowlistedString(value, SAFE_FIELDS.cwd)),
  observedAt: now,
});

const sessionStartEvent = (
  provider: Provider,
  sessionId: string,
  value: Record<string, unknown>,
  now: string,
): Extract<RegistryEvent, { kind: "SessionStart" }> => ({
  kind: "SessionStart",
  ...sessionFacts(provider, sessionId, value, now),
  ghosttyTerminalId: null,
});

const sessionObservedEvent = (
  provider: Provider,
  sessionId: string,
  value: Record<string, unknown>,
  now: string,
): Extract<RegistryEvent, { kind: "SessionObserved" }> => ({
  kind: "SessionObserved",
  ...sessionFacts(provider, sessionId, value, now),
});

/**
 * Decode one parsed native hook payload into zero or more normalized events.
 * Unknown hook names and invalid payloads return an empty sequence; nothing
 * throws into the hook caller.
 *
 * A payload whose `transcript_path` is explicitly null declares an ephemeral
 * thread: Codex Desktop's hidden ambient-suggestion sessions fire the same
 * SessionStart/UserPromptSubmit hooks as user threads but keep no transcript
 * and are never user-visible. They decode to zero events so they never reach
 * the registry or the grid. Providers that omit the field (Kimi) or always
 * send a real path (Claude) are unaffected. The path itself is never read or
 * retained — only the null is inspected.
 */
export const decodeNativeHook = (
  provider: Provider,
  value: unknown,
  now: string,
): RegistryEvent[] => {
  if (!isRecord(value)) {
    return [];
  }
  if ("transcript_path" in value && value["transcript_path"] === null) {
    return [];
  }
  const hookEventName = firstAllowlistedString(value, SAFE_FIELDS.hookEventName);
  if (hookEventName === undefined) {
    return [];
  }
  const sessionId = firstAllowlistedString(value, SAFE_FIELDS.sessionId);
  if (sessionId === undefined) {
    return [];
  }

  switch (hookEventName) {
    case "SessionStart": {
      const event = sessionStartEvent(provider, sessionId, value, now);
      return provider === "kimi" && event.title === null ? [] : [event];
    }
    case "UserPromptSubmit":
      return provider === "kimi"
        ? [
            sessionObservedEvent(provider, sessionId, value, now),
            statusEvent("Activity", provider, sessionId, now),
          ]
        : [statusEvent("Activity", provider, sessionId, now)];
    case "PostToolUse":
      return [statusEvent("Activity", provider, sessionId, now)];
    case "PreToolUse":
      // A pending AskUserQuestion blocks the turn on the user's answer, so its
      // start is the attention signal; the answering PostToolUse maps back to
      // Activity like every other tool. No provider fires PermissionRequest,
      // Notification, or TaskStarted for a foreground question.
      return [
        statusEvent(
          firstAllowlistedString(value, SAFE_FIELDS.toolName) === "AskUserQuestion"
            ? "Attention"
            : "Activity",
          provider,
          sessionId,
          now,
        ),
      ];
    case "PermissionRequest":
      return [statusEvent("Attention", provider, sessionId, now)];
    case "Notification":
      return firstAllowlistedString(value, SAFE_FIELDS.notificationType) === "permission_prompt"
        ? [statusEvent("Attention", provider, sessionId, now)]
        : [];
    case "Stop":
      return [statusEvent("Stop", provider, sessionId, now)];
    case "Interrupt":
      // Stop does not fire on interrupts, so Interrupt alone carries the
      // turn-ended signal — including a dismissed question prompt.
      return [statusEvent("Stop", provider, sessionId, now)];
    case "StopFailure":
      return [statusEvent("StopFailure", provider, sessionId, now)];
    case "SessionEnd":
      return [statusEvent("SessionEnd", provider, sessionId, now)];
    case "SubagentStart": {
      const childId = firstAllowlistedString(value, CHILD_IDENTITY_FIELDS);
      if (childId === undefined) {
        return [];
      }
      return [
        {
          kind: "SubagentStart",
          provider,
          sessionId: childId,
          parentSessionId: sessionId,
          title: firstAllowlistedString(value, SAFE_FIELDS.agentType) ?? null,
          project: projectFromCwd(firstAllowlistedString(value, SAFE_FIELDS.cwd)),
          observedAt: now,
        },
      ];
    }
    case "SubagentStop": {
      const childId = firstAllowlistedString(value, CHILD_IDENTITY_FIELDS);
      if (childId === undefined) {
        return [];
      }
      return [statusEvent("SubagentStop", provider, childId, now)];
    }
    default:
      return [];
  }
};
