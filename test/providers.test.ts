import { describe, expect, test } from "bun:test";
import { decodeNativeHook } from "../src/core/providers";
import type { RegistryEvent } from "../src/protocol";

const NOW = "2026-08-06T00:00:00.000Z";

const decode = (
  value: unknown,
  provider: "claude" | "codex" | "kimi" | "pi" | "omp" | "zcode" | "deepseek" = "claude",
): RegistryEvent[] => decodeNativeHook(provider, value, NOW);

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
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
    ]);
  });

  test("accepts camel-case aliases", () => {
    expect(decode({ hookEventName: "SessionStart", sessionId: "s2", sessionTitle: "Camel" })).toEqual([
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "s2",
        title: "Camel",
        project: null,
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
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
    expect(decode({ hook_event_name: "SessionStart", session_id: "s1", session_title: "", cwd: "" })).toEqual([
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: null,
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
    ]);
  });

  test("derives project only as the basename of the allowlisted cwd", () => {
    const start = (cwd: string): RegistryEvent[] => decode({ hook_event_name: "SessionStart", session_id: "s1", cwd });
    expect(start("/users/drew/work/repo")).toEqual([
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: "repo",
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
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
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
    ]);
  });

  test("carries a real transcript path onto SessionStart and SessionObserved", () => {
    expect(
      decode({
        hook_event_name: "SessionStart",
        session_id: "s1",
        cwd: "/users/drew/repo",
        transcript_path: "/Users/drew/.claude/projects/-users-drew-repo/s1.jsonl",
      }),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: "repo",
        ghosttyTerminalId: null,
        transcriptPath: "/Users/drew/.claude/projects/-users-drew-repo/s1.jsonl",
        model: null,
        observedAt: NOW,
      },
    ]);
    expect(
      decode({
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        cwd: "/users/drew/repo",
        transcriptPath: "/Users/drew/.claude/projects/-users-drew-repo/s1.jsonl",
      }),
    ).toEqual([
      {
        kind: "SessionObserved",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: "repo",
        transcriptPath: "/Users/drew/.claude/projects/-users-drew-repo/s1.jsonl",
        model: null,
        observedAt: NOW,
      },
      { kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW },
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
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
    ]);
  });

  test("defers titleless Kimi sessions until the first prompt", () => {
    expect(decode(withIdentity({ hook_event_name: "SessionStart", cwd: "/users/drew/project-x" }), "kimi")).toEqual([]);

    expect(
      decode(
        withIdentity({
          hook_event_name: "UserPromptSubmit",
          cwd: "/users/drew/project-x",
          prompt: "SENTINEL_PROMPT_NEVER_STORED",
        }),
        "kimi",
      ),
    ).toEqual([
      {
        kind: "SessionObserved",
        provider: "kimi",
        sessionId: "s1",
        title: null,
        project: "project-x",
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
      { kind: "Activity", provider: "kimi", sessionId: "s1", observedAt: NOW },
    ]);
  });

  test("keeps titled Kimi starts so resumed sessions join the registry", () => {
    expect(
      decode(withIdentity({ hook_event_name: "SessionStart", session_title: "Existing session" }), "kimi"),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "kimi",
        sessionId: "s1",
        title: "Existing session",
        project: null,
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
    ]);
  });

  test("maps UserPromptSubmit, PreToolUse, and PostToolUse to Activity", () => {
    // A prompt also emits SessionObserved first: it late-joins sessions whose
    // SessionStart was missed or whose row was pruned, and no-ops otherwise.
    expect(decode(withIdentity({ hook_event_name: "UserPromptSubmit" }))).toEqual([
      {
        kind: "SessionObserved",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
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

  test("maps PreToolUse for AskUserQuestion to Attention (a question blocks the turn)", () => {
    expect(decode(withIdentity({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }), "kimi")).toEqual([
      { kind: "Attention", provider: "kimi", sessionId: "s1", observedAt: NOW },
    ]);
    expect(decode(withIdentity({ hook_event_name: "PreToolUse", toolName: "AskUserQuestion" }))).toEqual([
      { kind: "Attention", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
  });

  test("keeps AskUserQuestion PostToolUse and other tools' PreToolUse as Activity", () => {
    // PostToolUse fires when the answered question completes the tool call, so
    // it must map back to working, never to waiting.
    expect(decode(withIdentity({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" }), "kimi")).toEqual([
      { kind: "Activity", provider: "kimi", sessionId: "s1", observedAt: NOW },
    ]);
    expect(decode(withIdentity({ hook_event_name: "PreToolUse", tool_name: "Bash" }), "kimi")).toEqual([
      { kind: "Activity", provider: "kimi", sessionId: "s1", observedAt: NOW },
    ]);
  });

  test("maps Interrupt to Stop (Stop does not fire on interrupts)", () => {
    expect(decode(withIdentity({ hook_event_name: "Interrupt", reason: "cancelled" }), "kimi")).toEqual([
      { kind: "Stop", provider: "kimi", sessionId: "s1", observedAt: NOW },
    ]);
  });

  test("maps Notification to Attention only for permission prompts", () => {
    expect(decode(withIdentity({ hook_event_name: "Notification", notification_type: "permission_prompt" }))).toEqual([
      { kind: "Attention", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    expect(decode(withIdentity({ hook_event_name: "Notification", notificationType: "permission_prompt" }))).toEqual([
      { kind: "Attention", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    for (const other of ["idle_prompt", "elicitation_dialog", "agent_needs_input", ""]) {
      expect(decode(withIdentity({ hook_event_name: "Notification", notification_type: other }))).toEqual([]);
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
    expect(decode({ hook_event_name: "SubagentStop", session_id: "parent", agent_id: "child-1" })).toEqual([
      { kind: "SubagentStop", provider: "claude", sessionId: "child-1", observedAt: NOW },
    ]);
    expect(decode({ hook_event_name: "SubagentStop", session_id: "parent", agentId: "child-2" })).toEqual([
      { kind: "SubagentStop", provider: "claude", sessionId: "child-2", observedAt: NOW },
    ]);
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
    expect(decode({ hook_event_name: "SubagentStop", session_id: "parent", agent_name: "researcher" }, "kimi")).toEqual(
      [{ kind: "SubagentStop", provider: "kimi", sessionId: "researcher", observedAt: NOW }],
    );
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
    expect(decode({ hook_event_name: "SubagentStart", session_id: "parent", agent_id: "" })).toEqual([]);
    expect(decode({ hook_event_name: "SubagentStop", session_id: "parent" })).toEqual([]);
  });

  test("drops events from ephemeral threads that declare no transcript", () => {
    // Codex Desktop spawns hidden ambient-suggestion threads that fire
    // SessionStart/UserPromptSubmit with an explicit `"transcript_path": null`;
    // real user threads always carry a rollout path. The null declares an
    // ephemeral thread: it never reaches the registry, so it never gets a tile.
    const ambientStart = {
      session_id: "ambient-1",
      transcript_path: null,
      cwd: "/users/drew/project-x",
      hook_event_name: "SessionStart",
      model: "gpt-5.6-terra",
      permission_mode: "bypassPermissions",
      source: "startup",
    };
    expect(decode(ambientStart, "codex")).toEqual([]);
    expect(
      decode(
        {
          session_id: "ambient-1",
          turn_id: "turn-1",
          transcript_path: null,
          cwd: "/users/drew/project-x",
          hook_event_name: "UserPromptSubmit",
          prompt: "Generate 0 to 3 hyperpersonalized suggestions",
        },
        "codex",
      ),
    ).toEqual([]);
    expect(decode({ hook_event_name: "SessionEnd", session_id: "ambient-1", transcript_path: null }, "codex")).toEqual(
      [],
    );

    // A real transcript path keeps the event decodable and is carried along.
    expect(
      decode(
        {
          hook_event_name: "SessionStart",
          session_id: "c1",
          cwd: "/work/app",
          transcript_path: "/Users/drew/.codex/sessions/rollout-1.jsonl",
        },
        "codex",
      ),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "codex",
        sessionId: "c1",
        title: null,
        project: "app",
        ghosttyTerminalId: null,
        transcriptPath: "/Users/drew/.codex/sessions/rollout-1.jsonl",
        model: null,
        observedAt: NOW,
      },
    ]);
  });

  test("decodes the configured Codex subset with the same normalized meanings", () => {
    expect(decode({ hook_event_name: "SessionStart", session_id: "c1", cwd: "/work/app" }, "codex")).toEqual([
      {
        kind: "SessionStart",
        provider: "codex",
        sessionId: "c1",
        title: null,
        project: "app",
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
    ]);
    expect(decode({ hook_event_name: "UserPromptSubmit", session_id: "c1" }, "codex")).toEqual([
      {
        kind: "SessionObserved",
        provider: "codex",
        sessionId: "c1",
        title: null,
        project: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
      { kind: "Activity", provider: "codex", sessionId: "c1", observedAt: NOW },
    ]);
    expect(decode({ hook_event_name: "SessionEnd", session_id: "c1" }, "codex")).toEqual([
      { kind: "SessionEnd", provider: "codex", sessionId: "c1", observedAt: NOW },
    ]);
  });

  test("returns no events for unknown hook names", () => {
    for (const name of ["PostToolUseFailure", "PreCompact", "SessionHeartbeat", "Banana"]) {
      expect(decode({ hook_event_name: name, session_id: "s1" })).toEqual([]);
    }
  });
});

describe("background shell tracking (Claude only)", () => {
  const withIdentity = (fields: Record<string, unknown>): Record<string, unknown> => ({
    session_id: "s1",
    ...fields,
  });

  test("marks a Claude Bash run_in_background PreToolUse as BackgroundWorkStarted", () => {
    const events = decode(
      withIdentity({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "SENTINEL_BG_COMMAND", run_in_background: true },
      }),
    );
    expect(events).toEqual([
      { kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW },
      { kind: "BackgroundWorkStarted", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
  });

  test("accepts the camelCase toolInput alias and ignores non-true run_in_background values", () => {
    expect(
      decode(
        withIdentity({ hook_event_name: "PreToolUse", tool_name: "Bash", toolInput: { run_in_background: true } }),
      ),
    ).toEqual([
      { kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW },
      { kind: "BackgroundWorkStarted", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    for (const toolInput of [
      { run_in_background: false },
      { run_in_background: "true" },
      { run_in_background: 1 },
      {},
      null,
      "run_in_background",
    ]) {
      expect(decode(withIdentity({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: toolInput }))).toEqual(
        [{ kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW }],
      );
    }
  });

  test("marks a Claude TaskStop PreToolUse as BackgroundWorkCleared", () => {
    expect(
      decode(withIdentity({ hook_event_name: "PreToolUse", tool_name: "TaskStop", tool_input: { task_id: "b1" } })),
    ).toEqual([
      { kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW },
      { kind: "BackgroundWorkCleared", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
  });

  test("keeps an AskUserQuestion PreToolUse as bare Attention even with a background flag present", () => {
    expect(
      decode(
        withIdentity({
          hook_event_name: "PreToolUse",
          tool_name: "AskUserQuestion",
          tool_input: { run_in_background: true, questions: [] },
        }),
      ),
    ).toEqual([{ kind: "Attention", provider: "claude", sessionId: "s1", observedAt: NOW }]);
  });

  test("marks a Claude task-notification UserPromptSubmit as BackgroundWorkCleared without reading the text", () => {
    const events = decode(
      withIdentity({
        hook_event_name: "UserPromptSubmit",
        prompt: "<task-notification>\n<task-id>SENTINEL_TASK_ID</task-id>\n<output-file>/tmp/x</output-file>",
      }),
    );
    expect(events).toEqual([
      {
        kind: "SessionObserved",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
      { kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW },
      { kind: "BackgroundWorkCleared", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
  });

  test("keeps ordinary Claude prompts and other providers free of background events", () => {
    expect(decode(withIdentity({ hook_event_name: "UserPromptSubmit", prompt: "how we lookin" }))).toEqual([
      {
        kind: "SessionObserved",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
      { kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    expect(
      decode(
        withIdentity({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { run_in_background: true } }),
        "kimi",
      ),
    ).toEqual([{ kind: "Activity", provider: "kimi", sessionId: "s1", observedAt: NOW }]);
    expect(
      decode(
        withIdentity({ hook_event_name: "PreToolUse", tool_name: "TaskStop", tool_input: { task_id: "b1" } }),
        "codex",
      ),
    ).toEqual([{ kind: "Activity", provider: "codex", sessionId: "s1", observedAt: NOW }]);
    expect(
      decode(
        withIdentity({ hook_event_name: "UserPromptSubmit", prompt: "<task-notification>\n<task-id>b1</task-id>" }),
        "codex",
      ),
    ).toEqual([
      {
        kind: "SessionObserved",
        provider: "codex",
        sessionId: "s1",
        title: null,
        project: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
      { kind: "Activity", provider: "codex", sessionId: "s1", observedAt: NOW },
    ]);
    expect(
      decode(
        withIdentity({ hook_event_name: "UserPromptSubmit", prompt: "<task-notification>\n<task-id>b1</task-id>" }),
        "kimi",
      ),
    ).toEqual([
      {
        kind: "SessionObserved",
        provider: "kimi",
        sessionId: "s1",
        title: null,
        project: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
      { kind: "Activity", provider: "kimi", sessionId: "s1", observedAt: NOW },
    ]);
  });
});

describe("model field", () => {
  test("decodes an allowlisted model field on SessionStart", () => {
    expect(
      decode(
        {
          hook_event_name: "SessionStart",
          session_id: "k1",
          session_title: "Existing session",
          cwd: "/users/drew/project-x",
          model: "k3",
        },
        "kimi",
      ),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "kimi",
        sessionId: "k1",
        title: "Existing session",
        project: "project-x",
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: "k3",
        observedAt: NOW,
      },
    ]);
  });

  test("a payload without a model field decodes model as null", () => {
    expect(
      decode(
        {
          hook_event_name: "SessionStart",
          session_id: "k1",
          session_title: "Existing session",
          cwd: "/users/drew/project-x",
        },
        "kimi",
      ),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "kimi",
        sessionId: "k1",
        title: "Existing session",
        project: "project-x",
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
    ]);
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
    expect(events).toEqual([{ kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW }]);
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
    expect(events).toEqual([{ kind: "StopFailure", provider: "claude", sessionId: "s1", observedAt: NOW }]);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
  });

  test("UserPromptSubmit decodes to observed-plus-activity with no prompt content", () => {
    const events = decode({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      prompt: "SENTINEL_USER_PROMPT",
      transcript_path: "/tmp/SENTINEL_TRANSCRIPT",
    });
    expect(events).toEqual([
      {
        kind: "SessionObserved",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: null,
        transcriptPath: "/tmp/SENTINEL_TRANSCRIPT",
        model: null,
        observedAt: NOW,
      },
      { kind: "Activity", provider: "claude", sessionId: "s1", observedAt: NOW },
    ]);
    // The allowlisted transcript path is retained by design; the prompt is not.
    expect(JSON.stringify(events)).not.toContain("SENTINEL_USER_PROMPT");
  });

  test("AskUserQuestion decodes to a bare Attention with no question content", () => {
    const events = decode(
      {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{ question: "SENTINEL_QUESTION", options: [{ label: "SENTINEL_OPTION" }] }],
        },
      },
      "kimi",
    );
    expect(events).toEqual([{ kind: "Attention", provider: "kimi", sessionId: "s1", observedAt: NOW }]);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
  });
});

describe("SessionTitleChanged", () => {
  test("decodes a non-empty title", () => {
    expect(decode({ hook_event_name: "SessionTitleChanged", session_id: "s1", title: "Fresh name" }, "pi")).toEqual([
      {
        kind: "SessionTitleChanged",
        provider: "pi",
        sessionId: "s1",
        title: "Fresh name",
        observedAt: NOW,
      },
    ]);
  });

  test("decodes to zero events when the title is missing or empty", () => {
    expect(decode({ hook_event_name: "SessionTitleChanged", session_id: "s1" }, "pi")).toEqual([]);
    expect(decode({ hook_event_name: "SessionTitleChanged", session_id: "s1", title: "" }, "pi")).toEqual([]);
  });
});

describe("zcode PostToolUseFailure", () => {
  const failure = { hook_event_name: "PostToolUseFailure", session_id: "z1", is_interrupt: true };

  test("maps an interrupt to Stop for zcode only", () => {
    expect(decode(failure, "zcode")).toEqual([{ kind: "Stop", provider: "zcode", sessionId: "z1", observedAt: NOW }]);
    expect(decode(failure, "claude")).toEqual([]);
    expect(decode(failure, "kimi")).toEqual([]);
  });

  test("ignores non-interrupt failures and string-typed is_interrupt", () => {
    expect(decode({ ...failure, is_interrupt: false }, "zcode")).toEqual([]);
    expect(decode({ ...failure, is_interrupt: "true" }, "zcode")).toEqual([]);
    expect(decode({ hook_event_name: "PostToolUseFailure", session_id: "z1" }, "zcode")).toEqual([]);
  });
});

describe("zcode transcript suppression", () => {
  test("stores null instead of the deleted temp path", () => {
    expect(
      decode(
        {
          hook_event_name: "SessionStart",
          session_id: "z1",
          cwd: "/users/drew/proj",
          transcript_path: "/tmp/zcode-hook-123.jsonl",
        },
        "zcode",
      ),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "zcode",
        sessionId: "z1",
        title: null,
        project: "proj",
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
    ]);
  });

  test("other providers keep transcript_path", () => {
    const events = decode(
      { hook_event_name: "SessionStart", session_id: "s1", transcript_path: "/real/transcript.jsonl" },
      "claude",
    );
    expect(events[0]).toMatchObject({ transcriptPath: "/real/transcript.jsonl" });
  });
});

describe("ephemeral transcript_path filter scope", () => {
  test("explicit null drops the event for codex", () => {
    expect(decode({ hook_event_name: "SessionStart", session_id: "c1", transcript_path: null }, "codex")).toEqual([]);
  });

  test("explicit null does not drop the event for other providers", () => {
    expect(decode({ hook_event_name: "Stop", session_id: "k1", transcript_path: null }, "kimi")).toEqual([
      { kind: "Stop", provider: "kimi", sessionId: "k1", observedAt: NOW },
    ]);
  });
});
