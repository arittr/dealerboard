import { describe, expect, test } from "bun:test";
import { createExtension, type OmpContext, type OmpHost, TOOL_EVENTS } from "../extensions/omp/stream-deck-agents";

type WirePayload = Record<string, unknown>;

const TUI_CTX: OmpContext = {
  hasUI: true,
  sessionManager: {
    getSessionId: () => "omp-s1",
    getSessionFile: () => "/sessions/omp-s1.jsonl",
  },
};

const GHOST_CTX: OmpContext = {
  hasUI: false,
  sessionManager: {
    getSessionId: () => "omp-ghost",
    getSessionFile: () => undefined,
  },
};

const makeHarness = () => {
  const handlers = new Map<string, ((event: unknown, ctx: OmpContext) => unknown)[]>();
  const busHandlers = new Map<string, ((payload: unknown) => void)[]>();
  const sent: WirePayload[] = [];
  const host: OmpHost = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: {
      on(event, handler) {
        busHandlers.set(event, [...(busHandlers.get(event) ?? []), handler]);
      },
    },
  };
  createExtension(host, (json) => sent.push(JSON.parse(json) as WirePayload));
  const fire = (event: string, payload: unknown = {}, ctx: OmpContext = TUI_CTX): unknown[] => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(handler(payload, ctx));
    }
    return results;
  };
  const fireBus = (event: string, payload: unknown): void => {
    for (const handler of busHandlers.get(event) ?? []) {
      handler(payload);
    }
  };
  return { sent, fire, fireBus };
};

describe("omp shim event mapping", () => {
  test("session_start emits SessionStart with cwd and transcript path", () => {
    const { sent, fire } = makeHarness();
    fire("session_start");
    expect(sent).toEqual([
      {
        hook_event_name: "SessionStart",
        session_id: "omp-s1",
        cwd: process.cwd(),
        transcript_path: "/sessions/omp-s1.jsonl",
      },
    ]);
  });

  test("interactive input emits UserPromptSubmit", () => {
    const { sent, fire } = makeHarness();
    fire("input", { source: "interactive" });
    expect(sent).toEqual([{ hook_event_name: "UserPromptSubmit", session_id: "omp-s1" }]);
  });

  test("tool events emit Pre/PostToolUse, normalizing ask to AskUserQuestion", () => {
    const { sent, fire } = makeHarness();
    fire(TOOL_EVENTS.start, { toolName: "read" });
    fire(TOOL_EVENTS.start, { toolName: "ask" });
    fire(TOOL_EVENTS.end, { toolName: "ask" });
    expect(sent.map((payload) => [payload["hook_event_name"], payload["tool_name"] ?? null])).toEqual([
      ["PreToolUse", "read"],
      ["PreToolUse", "AskUserQuestion"],
      ["PostToolUse", "AskUserQuestion"],
    ]);
  });

  test("tool_approval_requested emits PermissionRequest and the handler returns undefined", () => {
    const { sent, fire } = makeHarness();
    const results = fire("tool_approval_requested", { toolName: "bash" });
    expect(sent).toEqual([{ hook_event_name: "PermissionRequest", session_id: "omp-s1" }]);
    for (const result of results) {
      expect(result).toBeUndefined();
    }
  });

  test("session_stop emits Stop; session_shutdown emits SessionEnd", () => {
    const { sent, fire } = makeHarness();
    fire("session_stop");
    fire("session_shutdown", { reason: "quit" });
    expect(sent.map((payload) => payload["hook_event_name"])).toEqual(["Stop", "SessionEnd"]);
  });
});

describe("omp shim ghost filter and identity refresh", () => {
  test("a headless session (no UI, no session file) emits nothing", () => {
    const { sent, fire } = makeHarness();
    fire("session_start", {}, GHOST_CTX);
    fire("input", { source: "interactive" }, GHOST_CTX);
    fire(TOOL_EVENTS.start, { toolName: "read" }, GHOST_CTX);
    fire("session_stop", {}, GHOST_CTX);
    expect(sent).toEqual([]);
  });

  test("session_switch re-parents: bus subagent rows follow the visible session", () => {
    const { sent, fire, fireBus } = makeHarness();
    fire("session_start");
    const otherCtx: OmpContext = {
      hasUI: true,
      sessionManager: {
        getSessionId: () => "omp-s2",
        getSessionFile: () => "/sessions/omp-s2.jsonl",
      },
    };
    fire("session_switch", {}, otherCtx);
    fireBus("task:subagent:lifecycle", { id: "agent-1", agent: "explore", status: "started" });
    expect(sent[sent.length - 1]).toEqual({
      hook_event_name: "SubagentStart",
      session_id: "omp-s2",
      agent_id: "agent-1",
      agent_type: "explore",
      cwd: process.cwd(),
    });
  });

  test("a headless child's lifecycle event with no visible session emits nothing", () => {
    const { sent, fireBus } = makeHarness();
    fireBus("task:subagent:lifecycle", { id: "agent-1", status: "started" });
    expect(sent).toEqual([]);
  });
});

describe("omp shim subagent lifecycle", () => {
  test("started emits SubagentStart; completed/failed/aborted emit SubagentStop", () => {
    const { sent, fire, fireBus } = makeHarness();
    fire("session_start");
    fireBus("task:subagent:lifecycle", { id: "agent-1", agent: "explore", status: "started" });
    fireBus("task:subagent:lifecycle", { id: "agent-1", status: "completed" });
    fireBus("task:subagent:lifecycle", { id: "agent-2", status: "failed" });
    fireBus("task:subagent:lifecycle", { id: "agent-3", status: "aborted" });
    expect(
      sent
        .slice(1) // [0] is the SessionStart emitted by fire("session_start")
        .map((payload) => [payload["hook_event_name"], payload["agent_id"]]),
    ).toEqual([
      ["SubagentStart", "agent-1"],
      ["SubagentStop", "agent-1"],
      ["SubagentStop", "agent-2"],
      ["SubagentStop", "agent-3"],
    ]);
  });

  test("lifecycle payloads with an empty id are skipped", () => {
    const { sent, fire, fireBus } = makeHarness();
    fire("session_start");
    fireBus("task:subagent:lifecycle", { id: "", status: "started" });
    expect(sent).toHaveLength(1); // the SessionStart only
  });
});
