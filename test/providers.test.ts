import { describe, expect, test } from "bun:test";
import { decodeNativeHook } from "../src/core/providers";
import type { RegistryEvent } from "../src/protocol";

const NOW = "2026-08-06T00:00:00.000Z";

const decode = (value: unknown, provider: "claude" | "codex" | "kimi" = "claude"): RegistryEvent[] =>
  decodeNativeHook(provider, value, NOW);

describe("field extraction", () => {
  test("accepts underscore aliases", () => {
    expect(
      decode({
        hook_event_name: "SessionStart",
        session_id: "s1",
        cwd: "/users/drew/project-x",
        session_title: "Fix the thing",
        source: "startup",
      }),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "s1",
        title: "Fix the thing",
        project: "project-x",
        observedAt: NOW,
      },
    ]);
  });

  test("accepts camel-case aliases", () => {
    expect(
      decode({ hookEventName: "SessionStart", sessionId: "s2", sessionTitle: "Camel" }),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "s2",
        title: "Camel",
        project: null,
        observedAt: NOW,
      },
    ]);
  });

  test("prefers the first non-empty alias value", () => {
    expect(decode({ hook_event_name: "Stop", session_id: "", sessionId: "fallback" })).toEqual([
      { kind: "Stop", provider: "claude", sessionId: "fallback", observedAt: NOW },
    ]);
    expect(decode({ hook_event_name: "Stop", session_id: "primary", sessionId: "other" })).toEqual([
      { kind: "Stop", provider: "claude", sessionId: "primary", observedAt: NOW },
    ]);
  });

  test("treats non-string field values as absent", () => {
    expect(decode({ hook_event_name: "Stop", session_id: 42 })).toEqual([]);
    expect(decode({ hook_event_name: ["Stop"], session_id: "s1" })).toEqual([]);
  });

  test("treats an empty title as null and an empty cwd as no project", () => {
    expect(
      decode({ hook_event_name: "SessionStart", session_id: "s1", session_title: "", cwd: "" }),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: null,
        observedAt: NOW,
      },
    ]);
  });

  test("derives project only as the basename of the allowlisted cwd", () => {
    const start = (cwd: string): RegistryEvent[] =>
      decode({ hook_event_name: "SessionStart", session_id: "s1", cwd });
    expect(start("/users/drew/work/repo")).toEqual([
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: "repo",
        observedAt: NOW,
      },
    ]);
    // A bare root has no basename, so no project is recorded.
    expect(start("/")).toEqual([
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: null,
        observedAt: NOW,
      },
    ]);
  });

  test("bounds accepted strings to 256 Unicode code points", () => {
    const longId = "x".repeat(300);
    const events = decode({ hook_event_name: "SessionStart", session_id: longId });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: "x".repeat(256) });

    const astral = "🙂".repeat(300);
    const titled = decode({ hook_event_name: "SessionStart", session_id: "s1", title: astral });
    expect(titled[0]).toMatchObject({ title: "🙂".repeat(256) });
    expect(Array.from((titled[0] as { title: string }).title)).toHaveLength(256);
  });

  test("rejects missing or empty identity fields", () => {
    expect(decode({})).toEqual([]);
    expect(decode({ session_id: "s1" })).toEqual([]);
    expect(decode({ hook_event_name: "Stop" })).toEqual([]);
    expect(decode({ hook_event_name: "Stop", session_id: "" })).toEqual([]);
    expect(decode({ hook_event_name: "", session_id: "s1" })).toEqual([]);
  });

  test("rejects non-object payloads", () => {
    expect(decode(null)).toEqual([]);
    expect(decode(undefined)).toEqual([]);
    expect(decode("Stop")).toEqual([]);
    expect(decode(42)).toEqual([]);
    expect(decode([{ hook_event_name: "Stop", session_id: "s1" }])).toEqual([]);
  });
});

describe("event mapping", () => {
  const withIdentity = (fields: Record<string, unknown>): Record<string, unknown> => ({
    session_id: "s1",
    ...fields,
  });

  test("maps SessionStart to SessionStart", () => {
    expect(decode(withIdentity({ hook_event_name: "SessionStart" }))).toEqual([
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: null,
        observedAt: NOW,
      },
    ]);
  });

  test("maps UserPromptSubmit, PreToolUse, and PostToolUse to Activity", () => {
    expect(decode(withIdentity({ hook_event_name: "UserPromptSubmit" }))).toEqual([
      { kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    expect(decode(withIdentity({ hook_event_name: "PreToolUse" }))).toEqual([
      { kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    // PostToolUse is the event that fires when an answered prompt unblocks the
    // tool call; without it a tile stays waiting until the next mapped event.
    expect(decode(withIdentity({ hook_event_name: "PostToolUse" }))).toEqual([
      { kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
  });

  test("maps PermissionRequest to Attention", () => {
    expect(decode(withIdentity({ hook_event_name: "PermissionRequest" }))).toEqual([
      { kind: "Attention", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
  });

  test("maps Notification to Attention only for permission prompts", () => {
    expect(
      decode(withIdentity({ hook_event_name: "Notification", notification_type: "permission_prompt" })),
    ).toEqual([{ kind: "Attention", provider: "claude", sessionId: "s1", observedAt: NOW }]);
    expect(
      decode(withIdentity({ hook_event_name: "Notification", notificationType: "permission_prompt" })),
    ).toEqual([{ kind: "Attention", provider: "claude", sessionId: "s1", observedAt: NOW }]);
    for (const other of ["idle_prompt", "elicitation_dialog", "agent_needs_input", ""]) {
      expect(decode(withIdentity({ hook_event_name: "Notification", notification_type: other }))).toEqual(
        [],
      );
    }
    expect(decode(withIdentity({ hook_event_name: "Notification" }))).toEqual([]);
  });

  test("maps Stop, StopFailure, and SessionEnd to their normalized kinds", () => {
    expect(decode(withIdentity({ hook_event_name: "Stop" }))).toEqual([
      { kind: "Stop", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    expect(decode(withIdentity({ hook_event_name: "StopFailure" }))).toEqual([
      { kind: "StopFailure", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    expect(decode(withIdentity({ hook_event_name: "SessionEnd" }))).toEqual([
      { kind: "SessionEnd", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
  });

  test("maps SubagentStart to a child start under the parent session_id", () => {
    expect(
      decode({
        hook_event_name: "SubagentStart",
        session_id: "parent",
        agent_id: "child-1",
        agent_type: "Explore",
        cwd: "/users/drew/repo",
      }),
    ).toEqual([
      {
        kind: "SubagentStart",
        provider: "claude",
        sessionId: "child-1",
        parentSessionId: "parent",
        title: "Explore",
        project: "repo",
        observedAt: NOW,
      },
    ]);
  });

  test("maps SubagentStop to a child stop using the child identity", () => {
    expect(
      decode({ hook_event_name: "SubagentStop", session_id: "parent", agent_id: "child-1" }),
    ).toEqual([{ kind: "SubagentStop", provider: "claude", sessionId: "child-1", observedAt: NOW }]);
    expect(
      decode({ hook_event_name: "SubagentStop", session_id: "parent", agentId: "child-2" }),
    ).toEqual([{ kind: "SubagentStop", provider: "claude", sessionId: "child-2", observedAt: NOW }]);
  });

  test("falls back to agent_name for the child identity (Kimi payloads carry no agent_id)", () => {
    expect(
      decode(
        {
          hook_event_name: "SubagentStart",
          session_id: "parent",
          agent_name: "researcher",
          session_title: "Parent Title",
        },
        "kimi",
      ),
    ).toEqual([
      {
        kind: "SubagentStart",
        provider: "kimi",
        sessionId: "researcher",
        parentSessionId: "parent",
        title: "researcher",
        project: null,
        observedAt: NOW,
      },
    ]);
    expect(
      decode(
        { hook_event_name: "SubagentStop", session_id: "parent", agent_name: "researcher" },
        "kimi",
      ),
    ).toEqual([{ kind: "SubagentStop", provider: "kimi", sessionId: "researcher", observedAt: NOW }]);
  });

  test("prefers agent_id over agent_name for the child identity", () => {
    expect(
      decode({
        hook_event_name: "SubagentStart",
        session_id: "parent",
        agent_id: "child-1",
        agent_name: "ignored-name",
      }),
    ).toEqual([
      {
        kind: "SubagentStart",
        provider: "claude",
        sessionId: "child-1",
        parentSessionId: "parent",
        title: "ignored-name",
        project: null,
        observedAt: NOW,
      },
    ]);
  });

  test("rejects subagent events without a child identity", () => {
    expect(decode({ hook_event_name: "SubagentStart", session_id: "parent" })).toEqual([]);
    expect(decode({ hook_event_name: "SubagentStart", session_id: "parent", agent_id: "" })).toEqual(
      [],
    );
    expect(decode({ hook_event_name: "SubagentStop", session_id: "parent" })).toEqual([]);
  });

  test("decodes the configured Codex subset with the same normalized meanings", () => {
    expect(
      decode({ hook_event_name: "SessionStart", session_id: "c1", cwd: "/work/app" }, "codex"),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "codex",
        sessionId: "c1",
        title: null,
        project: "app",
        observedAt: NOW,
      },
    ]);
    expect(decode({ hook_event_name: "UserPromptSubmit", session_id: "c1" }, "codex")).toEqual([
      { kind: "Activity", provider: "codex", sessionId: "c1", observedAt: NOW },
    ]);
    expect(decode({ hook_event_name: "SessionEnd", session_id: "c1" }, "codex")).toEqual([
      { kind: "SessionEnd", provider: "codex", sessionId: "c1", observedAt: NOW },
    ]);
  });

  test("returns no events for unknown hook names", () => {
    for (const name of [
      "PostToolUseFailure",
      "PreCompact",
      "Interrupt",
      "SessionHeartbeat",
      "Banana",
    ]) {
      expect(decode({ hook_event_name: name, session_id: "s1" })).toEqual([]);
    }
  });
});

describe("privacy boundaries", () => {
  test("never carries prompts, tool data, errors, or extra keys into normalized events", () => {
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      prompt: "SENTINEL_PROMPT",
      tool_name: "Bash",
      tool_input: { command: "SENTINEL_TOOL_INPUT" },
      tool_output: "SENTINEL_TOOL_OUTPUT",
      error: "SENTINEL_ERROR",
      last_assistant_message: "SENTINEL_ASSISTANT",
      transcript_path: "/tmp/SENTINEL_TRANSCRIPT",
      env: { SECRET: "SENTINEL_ENV" },
      totally_unexpected: "SENTINEL_EXTRA",
    };
    const events = decode(payload);
    expect(events).toEqual([
      { kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
  });

  test("StopFailure decodes without the provider's error text", () => {
    const events = decode({
      hook_event_name: "StopFailure",
      session_id: "s1",
      error: "SENTINEL_RATE_LIMIT",
      error_details: "SENTINEL_ERROR_DETAILS",
      error_message: "SENTINEL_KIMI_ERROR",
    });
    expect(events).toEqual([
      { kind: "StopFailure", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
  });

  test("UserPromptSubmit decodes to a bare Activity with no prompt content", () => {
    const events = decode({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      prompt: "SENTINEL_USER_PROMPT",
    });
    expect(events).toEqual([
      { kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
  });
});
