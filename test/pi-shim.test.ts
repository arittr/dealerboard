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

  test("interactive input emits UserPromptSubmit; scripted input emits nothing", () => {
    const { sent, fire } = makeHarness();
    fire("input", { source: "interactive" });
    fire("input", { source: "queued" });
    expect(sent).toEqual([{ hook_event_name: "UserPromptSubmit", session_id: "pi-s1" }]);
  });

  test("tool execution emits Pre/PostToolUse with the tool name", () => {
    const { sent, fire } = makeHarness();
    fire("tool_execution_start", { toolName: "Bash" });
    fire("tool_execution_end", { toolName: "Bash" });
    expect(sent.map((payload) => payload["hook_event_name"])).toEqual(["PreToolUse", "PostToolUse"]);
    expect(sent[0]?.["tool_name"]).toBe("Bash");
  });

  test("session_info_changed pushes SessionTitleChanged only when a name exists", () => {
    const named = makeHarness({ sessionName: "Renamed" });
    named.fire("session_info_changed");
    expect(named.sent).toEqual([{ hook_event_name: "SessionTitleChanged", session_id: "pi-s1", title: "Renamed" }]);

    const unnamed = makeHarness({ sessionName: undefined });
    unnamed.fire("session_info_changed");
    expect(unnamed.sent).toEqual([]);
  });

  test("session_shutdown emits SessionEnd for every reason", () => {
    const { sent, fire } = makeHarness();
    fire("session_shutdown", { reason: "quit" });
    fire("session_shutdown", { reason: "new" });
    expect(sent.map((payload) => payload["hook_event_name"])).toEqual(["SessionEnd", "SessionEnd"]);
  });
});

describe("pi shim terminal-outcome latch", () => {
  // Real agent_end shape (pi 0.84.2): the terminal outcome is the final
  // AssistantMessage's stopReason — "stop" clean, "error" failed.
  const agentEnd = (stopReason: string) => ({ messages: [{ role: "assistant", stopReason }] });

  test("a clean turn settles to Stop", () => {
    const { sent, fire } = makeHarness();
    fire("agent_end", agentEnd("stop"));
    fire("agent_settled");
    expect(sent).toEqual([{ hook_event_name: "Stop", session_id: "pi-s1" }]);
  });

  test("an errored turn settles to StopFailure exactly once (upstream order: agent_end then agent_settled)", () => {
    const { sent, fire } = makeHarness();
    fire("agent_end", agentEnd("error"));
    fire("agent_settled");
    expect(sent).toEqual([{ hook_event_name: "StopFailure", session_id: "pi-s1" }]);
  });

  test("the latch clears: the next clean turn emits Stop", () => {
    const { sent, fire } = makeHarness();
    fire("agent_end", agentEnd("error"));
    fire("agent_settled");
    fire("agent_end", agentEnd("stop"));
    fire("agent_settled");
    expect(sent.map((payload) => payload["hook_event_name"])).toEqual(["StopFailure", "Stop"]);
  });
});

describe("pi shim ghost filter", () => {
  test("a non-TUI process without a session file emits nothing for any event", () => {
    const { sent, fire } = makeHarness({ sessionName: "Ghost" });
    fire("session_start", {}, GHOST_CTX);
    fire("input", { source: "interactive" }, GHOST_CTX);
    fire("tool_execution_start", { toolName: "Bash" }, GHOST_CTX);
    fire("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }, GHOST_CTX);
    fire("agent_settled", {}, GHOST_CTX);
    fire("session_info_changed", {}, GHOST_CTX);
    fire("session_shutdown", {}, GHOST_CTX);
    expect(sent).toEqual([]);
  });

  test("a ghost agent_end never latches the visible session", () => {
    const { sent, fire } = makeHarness();
    fire("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }, GHOST_CTX);
    fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
    fire("agent_settled");
    expect(sent).toEqual([{ hook_event_name: "Stop", session_id: "pi-s1" }]);
  });
});
