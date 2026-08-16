import { describe, expect, test } from "bun:test";
import {
  createExtension,
  type OmpContext,
  type OmpHost,
  type SpawnPort,
  TOOL_EVENTS,
} from "../extensions/omp/stream-deck-agents";

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

const makeHarness = (port?: SpawnPort) => {
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
  createExtension(
    host,
    port ??
      ((json) => {
        sent.push(JSON.parse(json) as WirePayload);
      }),
  );
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

// Bus payload literals use the installed omp's field spellings (verified
// against @oh-my-pi/pi-coding-agent 17.3.4, src/task/types.ts
// SubagentLifecyclePayload): `agent` and `status` — not agent_name/phase.
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

  test("tool events emit Pre/PostToolUse, normalizing ask to AskUserQuestion (exact wire JSON, host fields not forwarded)", () => {
    const { sent, fire } = makeHarness();
    fire(TOOL_EVENTS.start, { toolCallId: "tc-1", toolName: "read", args: { path: "/etc/passwd" }, intent: "inspect" });
    fire(TOOL_EVENTS.start, { toolCallId: "tc-2", toolName: "ask", args: { question: "Proceed?" } });
    fire(TOOL_EVENTS.end, { toolCallId: "tc-2", toolName: "ask", result: "yes", isError: false });
    expect(sent).toEqual([
      { hook_event_name: "PreToolUse", session_id: "omp-s1", tool_name: "read" },
      { hook_event_name: "PreToolUse", session_id: "omp-s1", tool_name: "AskUserQuestion" },
      { hook_event_name: "PostToolUse", session_id: "omp-s1", tool_name: "AskUserQuestion" },
    ]);
  });

  test("omit-don't-null: absent host fields produce absent wire keys", () => {
    const { sent, fire, fireBus } = makeHarness();
    fire("session_start");
    fire(TOOL_EVENTS.start, {});
    fireBus("task:subagent:lifecycle", { id: "agent-9", status: "started" });
    expect("tool_name" in (sent[1] ?? {})).toBe(false);
    expect("agent_type" in (sent[2] ?? {})).toBe(false);
  });

  test("tool_approval_requested emits PermissionRequest and the handler returns undefined", () => {
    const { sent, fire } = makeHarness();
    const results = fire("tool_approval_requested", { toolName: "bash" });
    expect(sent).toEqual([{ hook_event_name: "PermissionRequest", session_id: "omp-s1" }]);
    for (const result of results) {
      expect(result).toBeUndefined();
    }
  });

  test("session_stop emits Stop; session_shutdown emits SessionEnd (exact wire JSON)", () => {
    const { sent, fire } = makeHarness();
    fire("session_stop", { reason: "finished", durationMs: 42 });
    fire("session_shutdown", { reason: "quit" });
    expect(sent).toEqual([
      { hook_event_name: "Stop", session_id: "omp-s1" },
      { hook_event_name: "SessionEnd", session_id: "omp-s1" },
    ]);
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

  test("session_switch re-parents: bus subagent rows follow the visible session (exact wire JSON)", () => {
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
    expect(sent).toEqual([
      {
        hook_event_name: "SessionStart",
        session_id: "omp-s1",
        cwd: process.cwd(),
        transcript_path: "/sessions/omp-s1.jsonl",
      },
      {
        hook_event_name: "SubagentStart",
        session_id: "omp-s2",
        agent_id: "agent-1",
        agent_type: "explore",
        cwd: process.cwd(),
      },
    ]);
  });

  test("a headless child's lifecycle event with no visible session emits nothing", () => {
    const { sent, fireBus } = makeHarness();
    fireBus("task:subagent:lifecycle", { id: "agent-1", status: "started" });
    expect(sent).toEqual([]);
  });

  test("every event is filtered by each ghost predicate independently", () => {
    const events = [
      "session_start",
      "input",
      TOOL_EVENTS.start,
      TOOL_EVENTS.end,
      "tool_approval_requested",
      "session_stop",
      "session_shutdown",
      "session_switch",
    ];
    const ghostNoUI: OmpContext = {
      hasUI: false,
      sessionManager: { getSessionId: () => "g1", getSessionFile: () => "/sessions/g1.jsonl" },
    };
    const ghostNoFile: OmpContext = {
      hasUI: true,
      sessionManager: { getSessionId: () => undefined, getSessionFile: () => undefined },
    };
    for (const ghost of [ghostNoUI, ghostNoFile]) {
      const { sent, fire, fireBus } = makeHarness();
      for (const event of events) {
        fire(event, { source: "interactive", toolName: "read" }, ghost);
      }
      fireBus("task:subagent:lifecycle", { id: "a1", agent: "explore", status: "started" });
      expect(sent).toEqual([]);
    }
  });

  test("a ghost refresh disarms a previously armed identity: the bus can no longer use it", () => {
    const { sent, fire, fireBus } = makeHarness();
    fire("session_start"); // arms omp-s1
    fire("session_stop", {}, GHOST_CTX); // any event with a ghost ctx clears it
    fireBus("task:subagent:lifecycle", { id: "agent-1", agent: "explore", status: "started" });
    expect(sent).toEqual([
      {
        hook_event_name: "SessionStart",
        session_id: "omp-s1",
        cwd: process.cwd(),
        transcript_path: "/sessions/omp-s1.jsonl",
      },
    ]);
  });

  test("a failing identity refresh disarms rather than keeping the stale session", () => {
    const { sent, fire, fireBus } = makeHarness();
    fire("session_start"); // arms omp-s1
    const throwingCtx: OmpContext = {
      hasUI: true,
      sessionManager: {
        getSessionId: () => "omp-s2",
        getSessionFile: () => {
          throw new Error("boom");
        },
      },
    };
    fire("session_switch", {}, throwingCtx);
    // The bus must NOT see the stale omp-s1 identity: the refresh cleared it
    // before the throwing getter, and the catch left it cleared.
    fireBus("task:subagent:lifecycle", { id: "agent-1", agent: "explore", status: "started" });
    expect(sent).toEqual([
      {
        hook_event_name: "SessionStart",
        session_id: "omp-s1",
        cwd: process.cwd(),
        transcript_path: "/sessions/omp-s1.jsonl",
      },
    ]);
  });
});

describe("omp shim subagent lifecycle", () => {
  test("started emits SubagentStart; completed/failed/aborted emit SubagentStop (exact wire JSON)", () => {
    const { sent, fire, fireBus } = makeHarness();
    fire("session_start");
    fireBus("task:subagent:lifecycle", {
      id: "agent-1",
      agent: "explore",
      agentSource: "user",
      index: 2,
      status: "started",
    });
    fireBus("task:subagent:lifecycle", { id: "agent-1", status: "completed" });
    fireBus("task:subagent:lifecycle", { id: "agent-2", status: "failed" });
    fireBus("task:subagent:lifecycle", { id: "agent-3", status: "aborted" });
    expect(sent).toEqual([
      {
        hook_event_name: "SessionStart",
        session_id: "omp-s1",
        cwd: process.cwd(),
        transcript_path: "/sessions/omp-s1.jsonl",
      },
      {
        hook_event_name: "SubagentStart",
        session_id: "omp-s1",
        agent_id: "agent-1",
        agent_type: "explore",
        cwd: process.cwd(),
      },
      { hook_event_name: "SubagentStop", session_id: "omp-s1", agent_id: "agent-1" },
      { hook_event_name: "SubagentStop", session_id: "omp-s1", agent_id: "agent-2" },
      { hook_event_name: "SubagentStop", session_id: "omp-s1", agent_id: "agent-3" },
    ]);
  });

  test("lifecycle payloads with an empty id are skipped", () => {
    const { sent, fire, fireBus } = makeHarness();
    fire("session_start");
    fireBus("task:subagent:lifecycle", { id: "", status: "started" });
    expect(sent).toHaveLength(1); // the SessionStart only
  });
});

describe("omp shim spawn ordering", () => {
  // Same rationale as the pi ordering tests: helpers are independent
  // detached processes, and unserialized spawns milliseconds apart can reach
  // the registry out of order, letting a non-terminal write clobber a
  // terminal one.
  const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  test("the next helper is not spawned until the previous one completes; wire order matches emission order", async () => {
    const written: string[] = [];
    const completions: Array<() => void> = [];
    const port: SpawnPort = (json) => {
      written.push((JSON.parse(json) as WirePayload)["hook_event_name"] as string);
      return new Promise<void>((resolve) => completions.push(resolve));
    };
    const { fire } = makeHarness(port);
    fire(TOOL_EVENTS.end, { toolName: "bash" });
    fire("session_stop");
    // The terminal spawn must wait for the PostToolUse helper.
    expect(written).toEqual(["PostToolUse"]);
    completions[0]?.();
    await drain();
    expect(written).toEqual(["PostToolUse", "Stop"]);
    completions[1]?.();
    await drain();
  });

  test("a dead helper never wedges the queue: later payloads still spawn, in order", async () => {
    const written: string[] = [];
    let rejectFirst: ((reason: Error) => void) | undefined;
    const port: SpawnPort = (json) => {
      written.push((JSON.parse(json) as WirePayload)["hook_event_name"] as string);
      if (written.length === 1) {
        return new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return undefined;
    };
    const { fire } = makeHarness(port);
    fire(TOOL_EVENTS.end, { toolName: "bash" });
    fire("session_stop");
    expect(written).toEqual(["PostToolUse"]);
    rejectFirst?.(new Error("helper died"));
    await drain();
    expect(written).toEqual(["PostToolUse", "Stop"]);
  });
});
