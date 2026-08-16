import { describe, expect, test } from "bun:test";
import { createExtension, type PiContext, type PiHost } from "../extensions/pi/stream-deck-agents";

type WirePayload = Record<string, unknown>;
type Handler = (event: unknown, ctx: PiContext) => void;

const TUI_CTX: PiContext = {
  mode: "tui",
  sessionManager: {
    getSessionId: () => "pi-s1",
    getSessionFile: () => "/sessions/pi-s1.jsonl",
  },
};

const GHOST_CTX: PiContext = {
  mode: "print",
  sessionManager: {
    getSessionId: () => "pi-ghost",
    getSessionFile: () => undefined,
  },
};

// Ghost-matrix contexts: each fails exactly one liveSession predicate.
const NON_TUI_WITH_FILE: PiContext = {
  mode: "print",
  sessionManager: {
    getSessionId: () => "pi-ghost",
    getSessionFile: () => "/sessions/pi-ghost.jsonl",
  },
};

const TUI_WITHOUT_FILE: PiContext = {
  mode: "tui",
  sessionManager: {
    getSessionId: () => "pi-ghost",
    getSessionFile: () => undefined,
  },
};

// Real agent_end shape (pi 0.84.2): no top-level stop reason — the terminal
// outcome rides the final AssistantMessage's stopReason ("stop" clean,
// "error" failed). The loop may append tool-result messages after it.
const agentEnd = (stopReason: string) => ({ messages: [{ role: "assistant", stopReason }] });

// Every event the shim registers, with a representative live payload.
const ALL_EVENTS: Array<[string, Record<string, unknown>]> = [
  ["session_start", {}],
  ["input", { source: "interactive" }],
  ["tool_execution_start", { toolName: "Bash" }],
  ["tool_execution_end", { toolName: "Bash" }],
  ["agent_end", agentEnd("error")],
  ["agent_settled", {}],
  ["session_info_changed", {}],
  ["session_shutdown", {}],
];

const makeHarness = (options: { sessionName?: string | undefined } = {}) => {
  const handlers = new Map<string, Handler[]>();
  const sent: WirePayload[] = [];
  const host: PiHost = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getSessionName: () => options.sessionName,
  };
  createExtension(host, (json) => sent.push(JSON.parse(json) as WirePayload));
  const fire = (event: string, payload: Record<string, unknown> = {}, ctx: PiContext = TUI_CTX): void => {
    for (const handler of handlers.get(event) ?? []) {
      handler(payload, ctx);
    }
  };
  return { sent, fire };
};

describe("pi shim event mapping", () => {
  test("session_start emits SessionStart with cwd, transcript path, and title", () => {
    const { sent, fire } = makeHarness({ sessionName: "Fix the widget" });
    fire("session_start");
    expect(sent).toEqual([
      {
        hook_event_name: "SessionStart",
        session_id: "pi-s1",
        cwd: process.cwd(),
        transcript_path: "/sessions/pi-s1.jsonl",
        title: "Fix the widget",
      },
    ]);
  });

  test("an unnamed session_start omits the title key entirely", () => {
    const { sent, fire } = makeHarness({ sessionName: undefined });
    fire("session_start");
    expect(sent).toEqual([
      {
        hook_event_name: "SessionStart",
        session_id: "pi-s1",
        cwd: process.cwd(),
        transcript_path: "/sessions/pi-s1.jsonl",
      },
    ]);
    expect("title" in (sent[0] ?? {})).toBe(false);
  });

  test("interactive input emits UserPromptSubmit; scripted input emits nothing", () => {
    const { sent, fire } = makeHarness();
    fire("input", { source: "interactive" });
    fire("input", { source: "queued" });
    expect(sent).toEqual([{ hook_event_name: "UserPromptSubmit", session_id: "pi-s1" }]);
  });

  test("tool execution emits Pre/PostToolUse with the tool name and nothing else", () => {
    const { sent, fire } = makeHarness();
    fire("tool_execution_start", { toolName: "Bash", input: { command: "rm -rf /" }, durationMs: 42 });
    fire("tool_execution_end", { toolName: "Bash", result: "0", isError: false, durationMs: 42 });
    expect(sent).toEqual([
      { hook_event_name: "PreToolUse", session_id: "pi-s1", tool_name: "Bash" },
      { hook_event_name: "PostToolUse", session_id: "pi-s1", tool_name: "Bash" },
    ]);
  });

  test("tool execution without a tool name omits the tool_name key entirely", () => {
    const { sent, fire } = makeHarness();
    fire("tool_execution_start", { toolCallId: "tc_1" });
    fire("tool_execution_end", { toolCallId: "tc_1", result: "0", isError: false });
    expect(sent).toEqual([
      { hook_event_name: "PreToolUse", session_id: "pi-s1" },
      { hook_event_name: "PostToolUse", session_id: "pi-s1" },
    ]);
    expect("tool_name" in (sent[0] ?? {})).toBe(false);
    expect("tool_name" in (sent[1] ?? {})).toBe(false);
  });

  test("session_info_changed pushes SessionTitleChanged only when a name exists", () => {
    const named = makeHarness({ sessionName: "Renamed" });
    named.fire("session_info_changed");
    expect(named.sent).toEqual([{ hook_event_name: "SessionTitleChanged", session_id: "pi-s1", title: "Renamed" }]);

    const unnamed = makeHarness({ sessionName: undefined });
    unnamed.fire("session_info_changed");
    expect(unnamed.sent).toEqual([]);
  });

  test("session_shutdown emits a bare SessionEnd for every reason", () => {
    const { sent, fire } = makeHarness();
    fire("session_shutdown", { reason: "quit" });
    fire("session_shutdown", { reason: "new", targetSessionFile: "/sessions/next.jsonl" });
    expect(sent).toEqual([
      { hook_event_name: "SessionEnd", session_id: "pi-s1" },
      { hook_event_name: "SessionEnd", session_id: "pi-s1" },
    ]);
  });
});

describe("pi shim terminal latch", () => {
  // pi's ordering is structural (verified against 0.84.2 sources): the agent
  // loop emits agent_end on every termination path before returning, prompt()
  // awaits the loop, and agent_settled fires only afterwards, in
  // _runAgentPrompt's finally. These tests use the real order.

  test("upstream order: a clean turn settles to Stop", () => {
    const { sent, fire } = makeHarness();
    fire("input", { source: "interactive" });
    fire("agent_end", agentEnd("stop"));
    fire("agent_settled");
    expect(sent).toEqual([
      { hook_event_name: "UserPromptSubmit", session_id: "pi-s1" },
      { hook_event_name: "Stop", session_id: "pi-s1" },
    ]);
  });

  test("upstream order: an errored turn settles to StopFailure exactly once", () => {
    const { sent, fire } = makeHarness();
    fire("input", { source: "interactive" });
    fire("agent_end", agentEnd("error"));
    fire("agent_settled");
    expect(sent).toEqual([
      { hook_event_name: "UserPromptSubmit", session_id: "pi-s1" },
      { hook_event_name: "StopFailure", session_id: "pi-s1" },
    ]);
  });

  test("the stop reason is read from the last assistant message even when tool results follow it", () => {
    const { sent, fire } = makeHarness();
    fire("input", { source: "interactive" });
    fire("agent_end", {
      messages: [
        { role: "toolResult", toolCallId: "tc_1", content: [], isError: false },
        { role: "assistant", stopReason: "error", errorMessage: "provider 500" },
        { role: "toolResult", toolCallId: "tc_2", content: [], isError: true },
      ],
    });
    fire("agent_settled");
    expect(sent.map((payload) => payload["hook_event_name"])).toEqual(["UserPromptSubmit", "StopFailure"]);
  });

  test("the latch clears: the next clean turn emits Stop", () => {
    const { sent, fire } = makeHarness();
    fire("input", { source: "interactive" });
    fire("agent_end", agentEnd("error"));
    fire("agent_settled");
    fire("input", { source: "interactive" });
    fire("agent_end", agentEnd("stop"));
    fire("agent_settled");
    expect(sent.map((payload) => payload["hook_event_name"])).toEqual([
      "UserPromptSubmit",
      "StopFailure",
      "UserPromptSubmit",
      "Stop",
    ]);
  });

  test("turn-start hygiene: a straggler errored end after a settled turn is cleared by the next turn's input", () => {
    const { sent, fire } = makeHarness();
    fire("agent_settled");
    fire("agent_end", agentEnd("error"));
    fire("input", { source: "interactive" });
    fire("agent_end", agentEnd("stop"));
    fire("agent_settled");
    // The stale latch was cleared at the input; the second turn settles clean.
    expect(sent).toEqual([
      { hook_event_name: "Stop", session_id: "pi-s1" },
      { hook_event_name: "UserPromptSubmit", session_id: "pi-s1" },
      { hook_event_name: "Stop", session_id: "pi-s1" },
    ]);
  });

  test("turn-start hygiene also holds when the next turn begins with tool activity, not a prompt", () => {
    const { sent, fire } = makeHarness();
    fire("agent_settled");
    fire("agent_end", agentEnd("error"));
    fire("tool_execution_start", { toolName: "Bash" });
    fire("agent_end", agentEnd("stop"));
    fire("agent_settled");
    expect(sent).toEqual([
      { hook_event_name: "Stop", session_id: "pi-s1" },
      { hook_event_name: "PreToolUse", session_id: "pi-s1", tool_name: "Bash" },
      { hook_event_name: "Stop", session_id: "pi-s1" },
    ]);
  });

  test("a bare settled with no end still settles to Stop (settled also fires when the prompt throws)", () => {
    const { sent, fire } = makeHarness();
    fire("agent_settled");
    expect(sent).toEqual([{ hook_event_name: "Stop", session_id: "pi-s1" }]);
  });
});

describe("pi shim ghost filter", () => {
  test("a non-TUI process without a session file emits nothing for any event", () => {
    const { sent, fire } = makeHarness({ sessionName: "Ghost" });
    for (const [event, payload] of ALL_EVENTS) {
      fire(event, payload, GHOST_CTX);
    }
    expect(sent).toEqual([]);
  });

  test("a non-TUI context with a valid session file emits nothing for any event", () => {
    const { sent, fire } = makeHarness({ sessionName: "Ghost" });
    for (const [event, payload] of ALL_EVENTS) {
      fire(event, payload, NON_TUI_WITH_FILE);
    }
    expect(sent).toEqual([]);
  });

  test("a TUI context without a session file emits nothing for any event", () => {
    const { sent, fire } = makeHarness({ sessionName: "Ghost" });
    for (const [event, payload] of ALL_EVENTS) {
      fire(event, payload, TUI_WITHOUT_FILE);
    }
    expect(sent).toEqual([]);
  });

  test("ghost events never latch the visible session: the next turn settles cleanly", () => {
    const { sent, fire } = makeHarness();
    for (const [event, payload] of ALL_EVENTS) {
      fire(event, payload, NON_TUI_WITH_FILE);
      fire(event, payload, TUI_WITHOUT_FILE);
    }
    fire("input", { source: "interactive" });
    fire("agent_end", agentEnd("stop"));
    fire("agent_settled");
    expect(sent).toEqual([
      { hook_event_name: "UserPromptSubmit", session_id: "pi-s1" },
      { hook_event_name: "Stop", session_id: "pi-s1" },
    ]);
  });

  test("a ghost agent_end never latches the visible session", () => {
    const { sent, fire } = makeHarness();
    fire("input", { source: "interactive" });
    fire("agent_end", agentEnd("error"), GHOST_CTX);
    fire("agent_end", agentEnd("stop"));
    fire("agent_settled");
    expect(sent).toEqual([
      { hook_event_name: "UserPromptSubmit", session_id: "pi-s1" },
      { hook_event_name: "Stop", session_id: "pi-s1" },
    ]);
  });
});
