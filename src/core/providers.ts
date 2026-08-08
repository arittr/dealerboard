/**
 * Bounded decoder for native Claude, Codex, and Kimi hook payloads.
 *
 * A provider hook invokes the CLI with one JSON object on stdin. This module
 * maps the supported hook events onto normalized `RegistryEvent` values while
 * enforcing the privacy contract: only allowlisted fields are read, every
 * accepted string is capped at 256 Unicode code points, and the working
 * directory survives only as its basename. Payloads with missing identity,
 * unknown hook names, or non-object shapes decode to zero events.
 *
 * Two further Claude-only signals are classified in place, never stored: the
 * `run_in_background` boolean of a Bash tool input (a background shell arms
 * `BackgroundWorkStarted`, and `TaskStop` clears it) and the constant
 * `<task-notification>` prefix of a synthetic prompt (the only completion
 * signal a background shell produces). Command text and prompt bodies are
 * never inspected beyond these checks.
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
const CHILD_IDENTITY_FIELDS = [...SAFE_FIELDS.agentId, "agent_name"] as const;

const MAX_STRING_CODE_POINTS = 256;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Unicode-safe cap: count code points, never UTF-16 code units. */
const boundString = (value: string): string => Array.from(value).slice(0, MAX_STRING_CODE_POINTS).join("");

/**
 * First non-empty string among the allowlisted aliases, bounded. Non-string
 * and empty values count as absent.
 */
const firstAllowlistedString = (record: Record<string, unknown>, aliases: readonly string[]): string | undefined => {
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
  kind:
    | "Activity"
    | "Attention"
    | "Stop"
    | "StopFailure"
    | "SessionEnd"
    | "SubagentStop"
    | "BackgroundWorkStarted"
    | "BackgroundWorkCleared",
  provider: Provider,
  sessionId: string,
  now: string,
): RegistryEvent => ({ kind, provider, sessionId, observedAt: now });

const TASK_NOTIFICATION_PREFIX = "<task-notification>";

/**
 * Claude delivers a finished background task as a synthetic prompt beginning
 * with the constant `<task-notification>` tag. Only that constant prefix is
 * ever compared; the prompt text itself is neither read further nor retained.
 */
const isTaskNotificationPrompt = (value: Record<string, unknown>): boolean => {
  const prompt = value["prompt"];
  return typeof prompt === "string" && prompt.startsWith(TASK_NOTIFICATION_PREFIX);
};

/**
 * Only the `run_in_background` boolean is read out of a tool input; command
 * text and every other argument are never inspected.
 */
const isBackgroundToolCall = (value: Record<string, unknown>): boolean => {
  const toolInput = value["tool_input"] ?? value["toolInput"];
  return isRecord(toolInput) && toolInput["run_in_background"] === true;
};

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
export const decodeNativeHook = (provider: Provider, value: unknown, now: string): RegistryEvent[] => {
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
    case "UserPromptSubmit": {
      const activity = statusEvent("Activity", provider, sessionId, now);
      if (provider === "kimi") {
        return [sessionObservedEvent(provider, sessionId, value, now), activity];
      }
      // A task-notification delivery is the only completion signal a Claude
      // background shell ever produces; it clears the outstanding flag.
      return provider === "claude" && isTaskNotificationPrompt(value)
        ? [activity, statusEvent("BackgroundWorkCleared", provider, sessionId, now)]
        : [activity];
    }
    case "PostToolUse":
      return [statusEvent("Activity", provider, sessionId, now)];
    case "PreToolUse": {
      // A pending AskUserQuestion blocks the turn on the user's answer, so its
      // start is the attention signal; the answering PostToolUse maps back to
      // Activity like every other tool. No provider fires PermissionRequest,
      // Notification, or TaskStarted for a foreground question.
      const toolName = firstAllowlistedString(value, SAFE_FIELDS.toolName);
      if (toolName === "AskUserQuestion") {
        return [statusEvent("Attention", provider, sessionId, now)];
      }
      const activity = statusEvent("Activity", provider, sessionId, now);
      // Background tracking is Claude-only: a Bash run_in_background call arms
      // it, and TaskStop (which receives no completion notification) clears it.
      if (provider !== "claude") {
        return [activity];
      }
      if (toolName === "Bash" && isBackgroundToolCall(value)) {
        return [activity, statusEvent("BackgroundWorkStarted", provider, sessionId, now)];
      }
      if (toolName === "TaskStop") {
        return [activity, statusEvent("BackgroundWorkCleared", provider, sessionId, now)];
      }
      return [activity];
    }
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
