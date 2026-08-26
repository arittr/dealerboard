import { describe, expect, test } from "bun:test";
import {
  type ChildSpawn,
  createExtension,
  createSpawnPort,
  type PiContext,
  type PiHost,
  type SettleTimerFactory,
  type SpawnPort,
} from "../extensions/pi/dealerboard";

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

const makeHarness = (
  options: { sessionName?: string | undefined; port?: SpawnPort; settleTimeoutMs?: number } = {},
) => {
  const handlers = new Map<string, Handler[]>();
  const sent: WirePayload[] = [];
  const host: PiHost = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getSessionName: () => options.sessionName,
  };
  createExtension(
    host,
    options.port ??
      ((json) => {
        sent.push(JSON.parse(json) as WirePayload);
      }),
    options.settleTimeoutMs,
  );
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

  test("session_start includes the current model id when pi exposes one", () => {
    const { sent, fire } = makeHarness({ sessionName: "Fix the widget" });
    fire("session_start", {}, { ...TUI_CTX, model: { id: "glm-5.3" } });
    expect(sent).toEqual([
      {
        hook_event_name: "SessionStart",
        session_id: "pi-s1",
        cwd: process.cwd(),
        transcript_path: "/sessions/pi-s1.jsonl",
        title: "Fix the widget",
        model: "glm-5.3",
      },
    ]);
  });

  test("session_start omits the model key when pi exposes no model", () => {
    const { sent, fire } = makeHarness({ sessionName: undefined });
    fire("session_start"); // TUI_CTX declares no model
    expect("model" in (sent[0] ?? {})).toBe(false);
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

  test("a retried turn that recovers settles to Stop (last agent_end wins)", () => {
    const { sent, fire } = makeHarness();
    fire("input", { source: "interactive" });
    fire("agent_end", agentEnd("error"));
    fire("agent_end", agentEnd("stop")); // the auto-retry attempt succeeded
    fire("agent_settled");
    expect(sent).toEqual([
      { hook_event_name: "UserPromptSubmit", session_id: "pi-s1" },
      { hook_event_name: "Stop", session_id: "pi-s1" },
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

describe("pi shim spawn ordering", () => {
  // Helpers are independent detached processes; without serialization two
  // spawned milliseconds apart can reach the registry out of order (live-
  // observed: an Escape'd tool call's PostToolUse write landed after the
  // terminal StopFailure and stuck the tile on working).
  const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  test("the next helper is not spawned until the previous one completes; wire order matches emission order", async () => {
    const written: string[] = [];
    const completions: Array<() => void> = [];
    const port: SpawnPort = (json) => {
      written.push((JSON.parse(json) as WirePayload)["hook_event_name"] as string);
      return new Promise<void>((resolve) => completions.push(resolve));
    };
    const { fire } = makeHarness({ port });
    // The live race pair: the aborted tool's end, then the terminal event.
    fire("tool_execution_end", { toolName: "Bash" });
    fire("agent_end", agentEnd("error"));
    fire("agent_settled");
    // The terminal spawn must wait for the PostToolUse helper.
    expect(written).toEqual(["PostToolUse"]);
    completions[0]?.();
    await drain();
    expect(written).toEqual(["PostToolUse", "StopFailure"]);
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
    const { fire } = makeHarness({ port });
    fire("tool_execution_end", { toolName: "Bash" });
    fire("agent_settled");
    expect(written).toEqual(["PostToolUse"]);
    rejectFirst?.(new Error("helper died"));
    await drain();
    expect(written).toEqual(["PostToolUse", "Stop"]);
  });

  test("a hung helper releases the queue at the settle timeout: later payloads still spawn, in order", async () => {
    const written: string[] = [];
    const port: SpawnPort = (json) => {
      written.push((JSON.parse(json) as WirePayload)["hook_event_name"] as string);
      // The first helper hangs forever — neither resolves nor rejects.
      return written.length === 1 ? new Promise<void>(() => {}) : undefined;
    };
    const { fire } = makeHarness({ port, settleTimeoutMs: 20 });
    fire("tool_execution_end", { toolName: "Bash" });
    fire("agent_settled");
    // The terminal payload waits behind the hung helper...
    expect(written).toEqual(["PostToolUse"]);
    // ...until the settle timeout releases the queue link.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(written).toEqual(["PostToolUse", "Stop"]);
  });
});

describe("pi shim spawn adapter lifecycle", () => {
  // The ordering tests above drive an injected promise port; these drive the
  // PRODUCTION adapter (createSpawnPort, defaultSpawn's extracted body) with
  // a fake child process and a fake settle-timer factory — kill spy,
  // controllable exit/error events — so the adapter's own lifecycle is
  // pinned: deleting the SIGKILL, the unref, or the timer clearing from the
  // adapter fails here, not just in production.
  const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  type FakeTimer = { cleared: boolean; unrefs: number; clear(): void; unref(): void; fire(): void };

  const makeTimerFactory = (): { factory: SettleTimerFactory; timers: FakeTimer[] } => {
    const timers: FakeTimer[] = [];
    const factory: SettleTimerFactory = (callback) => {
      const timer: FakeTimer = {
        cleared: false,
        unrefs: 0,
        clear: () => {
          timer.cleared = true;
        },
        unref: () => {
          timer.unrefs += 1;
        },
        fire: () => {
          // A cleared timer must never fire — that is the timer-clearing pin.
          if (!timer.cleared) {
            callback();
          }
        },
      };
      timers.push(timer);
      return timer;
    };
    return { factory, timers };
  };

  type FakeChild = {
    json: string;
    killSignals: Array<string | number | undefined>;
    unrefs: number;
    emitExit(): void;
    emitError(): void;
  };

  const makeFakeSpawn = (): { children: FakeChild[]; spawnCalls: string[][]; spawnFn: ChildSpawn } => {
    const children: FakeChild[] = [];
    const spawnCalls: string[][] = [];
    const spawnFn: ChildSpawn = (_command, args) => {
      spawnCalls.push(args);
      const exitHandlers: Array<() => void> = [];
      const errorHandlers: Array<() => void> = [];
      const child: FakeChild = {
        json: "",
        killSignals: [],
        unrefs: 0,
        emitExit: () => {
          for (const handler of exitHandlers) {
            handler();
          }
        },
        emitError: () => {
          for (const handler of errorHandlers) {
            handler();
          }
        },
      };
      children.push(child);
      return {
        on: (event: string, listener: () => void) => {
          if (event === "exit") {
            exitHandlers.push(listener);
          } else if (event === "error") {
            errorHandlers.push(listener);
          }
        },
        kill: (signal?: string | number) => {
          child.killSignals.push(signal);
          return true;
        },
        unref: () => {
          child.unrefs += 1;
        },
        stdin: {
          on: () => undefined,
          end: (data: string) => {
            child.json = data;
          },
        },
      };
    };
    return { children, spawnCalls, spawnFn };
  };

  test("a child exit clears the settle timer, settles the link, and the next payload spawns", async () => {
    const fake = makeFakeSpawn();
    const timer = makeTimerFactory();
    const { fire } = makeHarness({ port: createSpawnPort(fake.spawnFn, timer.factory) });
    fire("tool_execution_end", { toolName: "Bash" });
    fire("agent_settled");
    // The second payload waits on the first link — only one child so far.
    expect(fake.children).toHaveLength(1);
    expect(fake.children[0]?.json).toBe(
      JSON.stringify({ hook_event_name: "PostToolUse", session_id: "pi-s1", tool_name: "Bash" }),
    );
    // Armed timer is unref'd, and the child itself is detached (unref'd).
    expect(timer.timers[0]?.unrefs).toBe(1);
    expect(fake.children[0]?.unrefs).toBe(1);
    fake.children[0]?.emitExit();
    await drain();
    // The link settled on exit, so the queued terminal payload spawned.
    expect(fake.children).toHaveLength(2);
    expect(fake.children[1]?.json).toBe(JSON.stringify({ hook_event_name: "Stop", session_id: "pi-s1" }));
    // The timer was cleared on settle: firing it after the exit kills nothing.
    expect(timer.timers[0]?.cleared).toBe(true);
    timer.timers[0]?.fire();
    expect(fake.children[0]?.killSignals).toEqual([]);
    // Release the second link so the queue drains before the test ends.
    fake.children[1]?.emitExit();
    await drain();
  });

  test("a child error (unspawnable helper) settles the link and the queue continues", async () => {
    const fake = makeFakeSpawn();
    const timer = makeTimerFactory();
    const { fire } = makeHarness({ port: createSpawnPort(fake.spawnFn, timer.factory) });
    fire("tool_execution_end", { toolName: "Bash" });
    fire("agent_settled");
    expect(fake.children).toHaveLength(1);
    fake.children[0]?.emitError();
    await drain();
    expect(fake.children).toHaveLength(2);
    expect(timer.timers[0]?.cleared).toBe(true);
    fake.children[1]?.emitExit();
    await drain();
  });

  test("a synchronously throwing spawn settles the link fail-soft and the queue continues", async () => {
    let calls = 0;
    const spawnFn: ChildSpawn = () => {
      calls += 1;
      throw new Error("spawn unavailable");
    };
    const { fire } = makeHarness({ port: createSpawnPort(spawnFn, makeTimerFactory().factory) });
    fire("agent_settled");
    fire("input", { source: "interactive" });
    expect(calls).toBe(1);
    await drain();
    // The throw was swallowed and the link released: the next payload spawns.
    expect(calls).toBe(2);
  });

  test("a hung helper is SIGKILLed by the settle timeout and the queue releases", async () => {
    const fake = makeFakeSpawn();
    const timer = makeTimerFactory();
    // The queue backstop sits far beyond the adapter's timer, so the release
    // is provably the adapter's own SIGKILL path, not the queue's fallback.
    const { fire } = makeHarness({ port: createSpawnPort(fake.spawnFn, timer.factory), settleTimeoutMs: 10_000 });
    fire("tool_execution_end", { toolName: "Bash" });
    fire("agent_settled");
    expect(fake.children).toHaveLength(1);
    // Neither exit nor error ever fires — the helper is hung.
    timer.timers[0]?.fire();
    expect(fake.children[0]?.killSignals).toEqual(["SIGKILL"]);
    await drain();
    expect(fake.children).toHaveLength(2);
    fake.children[1]?.emitExit();
    await drain();
  });
});
