import { describe, expect, test } from "bun:test";
import { decodeNativeHook } from "../src/core/providers";
import type { RegistryEvent } from "../src/protocol";

const NOW = "2026-08-06T00:00:00.000Z";

const decode = (
  value: unknown,
  provider: "claude" | "codex" | "kimi" | "pi" | "omp" | "zcode" | "deepseek" | "grok" | "qwen" = "claude",
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

  test("keeps titleless Kimi starts, model included — the projection hides the idle row", () => {
    // A blank Kimi Web page fires SessionStart eagerly with no title. The row
    // registers (so the start's model lands), but an idle, never-unread row
    // is never projected — the grid stays clean until the first prompt.
    expect(
      decode(withIdentity({ hook_event_name: "SessionStart", cwd: "/users/drew/project-x", model: "k3" }), "kimi"),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "kimi",
        sessionId: "s1",
        title: null,
        project: "project-x",
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: "k3",
        observedAt: NOW,
      },
    ]);

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

  test("maps an interrupt to Stop for zcode", () => {
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

describe("qwen native envelopes", () => {
  test("SessionStart registers with the pushed model and transcript path", () => {
    expect(
      decode(
        {
          hook_event_name: "SessionStart",
          session_id: "q1",
          cwd: "/users/drew/proj",
          transcript_path: "/users/drew/.qwen/projects/proj/chats/q1.jsonl",
          model: "qwen3.8-max-preview",
          source: "startup",
        },
        "qwen",
      ),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "qwen",
        sessionId: "q1",
        title: null,
        project: "proj",
        ghosttyTerminalId: null,
        transcriptPath: "/users/drew/.qwen/projects/proj/chats/q1.jsonl",
        model: "qwen3.8-max-preview",
        observedAt: NOW,
      },
    ]);
  });

  test("maps an interrupt to Stop like zcode, and ignores plain tool failures", () => {
    const failure = { hook_event_name: "PostToolUseFailure", session_id: "q1", is_interrupt: true };
    expect(decode(failure, "qwen")).toEqual([{ kind: "Stop", provider: "qwen", sessionId: "q1", observedAt: NOW }]);
    expect(decode({ ...failure, is_interrupt: false }, "qwen")).toEqual([]);
    expect(decode({ hook_event_name: "PostToolUseFailure", session_id: "q1" }, "qwen")).toEqual([]);
  });

  test("permission_prompt is Attention, StopFailure is error, SessionEnd deletes", () => {
    expect(
      decode({ hook_event_name: "Notification", session_id: "q1", notification_type: "permission_prompt" }, "qwen"),
    ).toEqual([{ kind: "Attention", provider: "qwen", sessionId: "q1", observedAt: NOW }]);
    expect(decode({ hook_event_name: "StopFailure", session_id: "q1" }, "qwen")).toEqual([
      { kind: "StopFailure", provider: "qwen", sessionId: "q1", observedAt: NOW },
    ]);
    expect(decode({ hook_event_name: "SessionEnd", session_id: "q1" }, "qwen")).toEqual([
      { kind: "SessionEnd", provider: "qwen", sessionId: "q1", observedAt: NOW },
    ]);
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

describe("grok native envelopes", () => {
  const grok = (value: unknown): RegistryEvent[] => decode(value, "grok");

  test("session_start decodes with project basename and model passthrough", () => {
    // fixture: session-start.json — the capture carries no model field, so the
    // start registers model: null; the resolver backfills it later.
    expect(
      grok({
        hookEventName: "session_start",
        sessionId: "01a00e7d-588a-7de0-88a1-d9c0848594c1",
        cwd: "/Users/you/project",
        workspaceRoot: "/Users/you/project",
        timestamp: "2026-08-17T06:51:31.511454+00:00",
        permissionMode: "auto",
        source: "new",
      }),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "grok",
        sessionId: "01a00e7d-588a-7de0-88a1-d9c0848594c1",
        title: null,
        project: "project",
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
    ]);
  });

  test("user_prompt_submit late-joins with SessionObserved + Activity", () => {
    // fixture: user-prompt-submit.json — the prompt body is never read.
    const events = grok({
      hookEventName: "user_prompt_submit",
      sessionId: "01a00e7d-588a-7de0-88a1-d9c0848594c1",
      cwd: "/Users/you/project",
      workspaceRoot: "/Users/you/project",
      timestamp: "2026-08-17T06:51:32.020365+00:00",
      transcriptPath: "/Users/you/project/.grok-sessions/01a00e7d-588a-7de0-88a1-d9c0848594c1/updates.jsonl",
      permissionMode: "auto",
      promptId: "037a891e-f1fa-4bfc-ab07-7c3eab9e9ad7",
      prompt:
        "<user_query>\nUse the terminal to run this exact command: curl -s --max-time 5 https://example.com — then report the HTTP status only.\n</user_query>",
    });
    expect(events.map((event) => event.kind)).toEqual(["SessionObserved", "Activity"]);
  });

  test("pre_tool_use and post_tool_use map to Activity", () => {
    // fixture: pre-tool-use.json — tool input and command text are never read.
    expect(
      grok({
        hookEventName: "pre_tool_use",
        sessionId: "01a00e7d-588a-7de0-88a1-d9c0848594c1",
        cwd: "/Users/you/project",
        workspaceRoot: "/Users/you/project",
        timestamp: "2026-08-17T06:51:56.637719+00:00",
        transcriptPath: "/Users/you/project/.grok-sessions/01a00e7d-588a-7de0-88a1-d9c0848594c1/updates.jsonl",
        permissionMode: "auto",
        toolName: "run_terminal_command",
        toolUseId: "call-70ddf75c-98b3-4909-8b01-3ac665ad0b3e-1",
        toolInput: {
          command: 'curl -s --max-time 5 -o /dev/null -w "%{http_code}" https://example.com',
          description: "Get HTTP status code from example.com",
        },
        toolInputTruncated: false,
      }),
    ).toEqual([
      { kind: "Activity", provider: "grok", sessionId: "01a00e7d-588a-7de0-88a1-d9c0848594c1", observedAt: NOW },
    ]);
    // fixture: post-tool-use.json — the tool result payload is never read.
    expect(
      grok({
        hookEventName: "post_tool_use",
        sessionId: "01a00e7d-588a-7de0-88a1-d9c0848594c1",
        cwd: "/Users/you/project",
        workspaceRoot: "/Users/you/project",
        timestamp: "2026-08-17T06:52:02.690704+00:00",
        transcriptPath: "/Users/you/project/.grok-sessions/01a00e7d-588a-7de0-88a1-d9c0848594c1/updates.jsonl",
        permissionMode: "auto",
        toolName: "run_terminal_command",
        toolUseId: "call-70ddf75c-98b3-4909-8b01-3ac665ad0b3e-1",
        toolInput: {
          command: 'curl -s --max-time 5 -o /dev/null -w "%{http_code}" https://example.com',
          description: "Get HTTP status code from example.com",
        },
        toolResult: {
          type: "Bash",
          output: [50, 48, 48],
          output_for_prompt: "exit: 0\n200",
          exit_code: 0,
          command: 'curl -s --max-time 5 -o /dev/null -w "%{http_code}" https://example.com',
          truncated: false,
          signal: null,
          timed_out: false,
          description: "Get HTTP status code from example.com",
          current_dir: "/Users/you/project",
          output_file:
            "/Users/you/project/.grok-sessions/01a00e7d-588a-7de0-88a1-d9c0848594c1/terminal/call-70ddf75c-98b3-4909-8b01-3ac665ad0b3e-1.log",
          total_bytes: 3,
        },
        toolInputTruncated: false,
        toolResultTruncated: false,
        isBackgrounded: false,
      }),
    ).toEqual([
      { kind: "Activity", provider: "grok", sessionId: "01a00e7d-588a-7de0-88a1-d9c0848594c1", observedAt: NOW },
    ]);
  });

  test("stop settles only on a genuine turn end", () => {
    // fixture: stop-end-turn.json — stopHookActive and the trailing payloads
    // are irrelevant; the filter keys on reason only.
    expect(
      grok({
        hookEventName: "stop",
        sessionId: "01a00e7d-588a-7de0-88a1-d9c0848594c1",
        cwd: "/Users/you/project",
        workspaceRoot: "/Users/you/project",
        timestamp: "2026-08-17T06:52:04.675795+00:00",
        transcriptPath: "/Users/you/project/.grok-sessions/01a00e7d-588a-7de0-88a1-d9c0848594c1/updates.jsonl",
        promptId: "037a891e-f1fa-4bfc-ab07-7c3eab9e9ad7",
        permissionMode: "auto",
        reason: "end_turn",
        stopHookActive: false,
        lastAssistantMessage: "200",
        backgroundTasks: [],
        sessionCrons: [],
      }),
    ).toEqual([{ kind: "Stop", provider: "grok", sessionId: "01a00e7d-588a-7de0-88a1-d9c0848594c1", observedAt: NOW }]);
    // A stop with no reason at all is still a genuine turn end.
    expect(grok({ hookEventName: "stop", sessionId: "g1" })).toEqual([
      { kind: "Stop", provider: "grok", sessionId: "g1", observedAt: NOW },
    ]);
    expect(grok({ hookEventName: "stop", sessionId: "g1", reason: "channel_closed" })).toEqual([]);
    // fixture: stop-session-teardown.json — Session-teardown observe fires are
    // dropped; SessionEnd owns removal.
    expect(
      grok({
        hookEventName: "stop",
        sessionId: "01a00e7d-588a-7de0-88a1-d9c0848594c1",
        cwd: "/Users/you/project",
        workspaceRoot: "/Users/you/project",
        timestamp: "2026-08-17T06:52:04.730204+00:00",
        transcriptPath: "/Users/you/project/.grok-sessions/01a00e7d-588a-7de0-88a1-d9c0848594c1/updates.jsonl",
        permissionMode: "auto",
        reason: "shutdown",
        stopHookActive: false,
      }),
    ).toEqual([]);
  });

  test("stop_cancelled settles idle like Kimi's Interrupt", () => {
    // fixture: stop-cancelled.json — reason is irrelevant here: an interrupted
    // turn settles idle either way.
    expect(
      grok({
        hookEventName: "stop_cancelled",
        sessionId: "01a00e7c-2060-7311-9b04-a890bb62949a",
        cwd: "/Users/you/project",
        workspaceRoot: "/Users/you/project",
        timestamp: "2026-08-17T06:50:18.125731+00:00",
        transcriptPath: "/Users/you/project/.grok-sessions/01a00e7c-2060-7311-9b04-a890bb62949a/updates.jsonl",
        promptId: "df637b2d-e4d1-4f1e-a5c7-fe674957ca09",
        permissionMode: "auto",
        reason: "max_turns",
        cancelledBy: "runtime",
        lastAssistantMessage: "I'll run the two echo commands in order, then summarize what each printed.",
      }),
    ).toEqual([{ kind: "Stop", provider: "grok", sessionId: "01a00e7c-2060-7311-9b04-a890bb62949a", observedAt: NOW }]);
  });

  test("stop_failure maps to StopFailure", () => {
    // fixture: stop-failure.json — the error text is never read.
    expect(
      grok({
        hookEventName: "stop_failure",
        sessionId: "00000000-0000-4000-8000-000000000001",
        cwd: "/Users/you/project",
        workspaceRoot: "/Users/you/project",
        timestamp: "2026-08-17T06:55:00.000000+00:00",
        transcriptPath: "/Users/you/project/.grok-sessions/00000000-0000-4000-8000-000000000001/updates.jsonl",
        promptId: "00000000-0000-4000-8000-000000000002",
        permissionMode: "auto",
        error: "rate_limit",
        errorDetails: "429 Too Many Requests: rate limit exceeded for this API key (retry after 60s)",
        lastAssistantMessage: "API error: rate limit exceeded. The turn could not be completed.",
      }),
    ).toEqual([
      { kind: "StopFailure", provider: "grok", sessionId: "00000000-0000-4000-8000-000000000001", observedAt: NOW },
    ]);
  });

  test("notification maps only permission_prompt to Attention", () => {
    // fixture: notification-permission-prompt.json — the message body is never read.
    expect(
      grok({
        hookEventName: "notification",
        sessionId: "00000000-0000-4000-8000-000000000001",
        cwd: "/Users/you/project",
        workspaceRoot: "/Users/you/project",
        timestamp: "2026-08-17T06:55:10.000000+00:00",
        transcriptPath: "/Users/you/project/.grok-sessions/00000000-0000-4000-8000-000000000001/updates.jsonl",
        promptId: "00000000-0000-4000-8000-000000000003",
        permissionMode: "default",
        notificationType: "permission_prompt",
        message: "Grok needs permission to run: rm -rf build",
      }),
    ).toEqual([
      { kind: "Attention", provider: "grok", sessionId: "00000000-0000-4000-8000-000000000001", observedAt: NOW },
    ]);
    // fixture: notification-idle-prompt.json
    expect(
      grok({
        hookEventName: "notification",
        sessionId: "00000000-0000-4000-8000-000000000001",
        cwd: "/Users/you/project",
        workspaceRoot: "/Users/you/project",
        timestamp: "2026-08-17T06:56:00.000000+00:00",
        transcriptPath: "/Users/you/project/.grok-sessions/00000000-0000-4000-8000-000000000001/updates.jsonl",
        permissionMode: "auto",
        notificationType: "idle_prompt",
        message: "Grok is waiting for your input",
      }),
    ).toEqual([]);
    expect(grok({ hookEventName: "notification", sessionId: "g1", notificationType: "task_complete" })).toEqual([]);
  });

  test("session_end maps to SessionEnd", () => {
    // fixture: session-end.json
    expect(
      grok({
        hookEventName: "session_end",
        sessionId: "01a00e7d-588a-7de0-88a1-d9c0848594c1",
        cwd: "/Users/you/project",
        workspaceRoot: "/Users/you/project",
        timestamp: "2026-08-17T06:52:04.711494+00:00",
        transcriptPath: "/Users/you/project/.grok-sessions/01a00e7d-588a-7de0-88a1-d9c0848594c1/updates.jsonl",
        permissionMode: "auto",
        reason: "shutdown",
      }),
    ).toEqual([
      { kind: "SessionEnd", provider: "grok", sessionId: "01a00e7d-588a-7de0-88a1-d9c0848594c1", observedAt: NOW },
    ]);
  });

  test("any event carrying subagentType is dropped", () => {
    // fixture: subagent-activity.json — the captured subagent_stop carries
    // subagentType; the filter drops it before the unmapped-name path can.
    expect(
      grok({
        hookEventName: "subagent_stop",
        sessionId: "01a00e7c-9ae8-7940-89d3-1cf71edcbe63",
        cwd: "/Users/you/project",
        workspaceRoot: "/Users/you/project",
        timestamp: "2026-08-17T06:50:45.135006+00:00",
        transcriptPath: "/Users/you/project/.grok-sessions/01a00e7c-9ae8-7940-89d3-1cf71edcbe63/updates.jsonl",
        promptId: "01a00e7c-9ce0-7772-aaf8-c07551e07a9c",
        permissionMode: "auto",
        phase: "gate",
        subagentId: "01a00e7c-9ae8-7940-89d3-1cf71edcbe63",
        subagentType: "general-purpose",
        stopHookActive: false,
        lastAssistantMessage: "56\n\n7 times 8 equals 56.",
      }),
    ).toEqual([]);
    for (const hookEventName of ["user_prompt_submit", "pre_tool_use", "stop", "session_end"]) {
      expect(grok({ hookEventName, sessionId: "g1-child", subagentType: "explore" })).toEqual([]);
    }
  });

  test("unregistered grok events and non-grok casings decode to zero events", () => {
    expect(grok({ hookEventName: "pre_compact", sessionId: "g1" })).toEqual([]);
    expect(grok({ hookEventName: "post_tool_use_failure", sessionId: "g1" })).toEqual([]);
    // Cursor-style casing is config-side only
    expect(grok({ hookEventName: "sessionStart", sessionId: "g1" })).toEqual([]);
  });
});
