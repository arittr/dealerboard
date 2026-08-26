import { describe, expect, test } from "bun:test";
import { type PressDeps, pressSessionTile } from "../app/src/press";
import { FOCUS_GHOSTTY_TERMINAL_SCRIPT } from "../src/plugin/ghostty-focus";
import type { ProjectedSession } from "../src/protocol";

const session = (overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: "session-1",
  status: "idle",
  title: "A session",
  project: "stream-deck-agents",
  descendantCount: 0,
  logicalSlot: 1,
  ghosttyTerminalId: null,
  model: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  unreadSince: null,
  statusSince: null,
  activityLine: null,
  transcriptPath: null,
  originParentRef: null,
  lastEventAt: null,
  ...overrides,
});

type RecordedCall = { fn: string; args: unknown[] };

type DepsOptions = { failAck?: boolean; failOpenUrl?: boolean };

/** Fake bridge deps: every call is recorded (flashes included) in order. */
const makeDeps = (options: DepsOptions = {}) => {
  const calls: RecordedCall[] = [];
  const deps: PressDeps = {
    ack: (provider, sessionId) => {
      calls.push({ fn: "ack", args: [provider, sessionId] });
      return options.failAck === true ? Promise.reject(new Error("ack down")) : Promise.resolve();
    },
    openUrl: (url) => {
      calls.push({ fn: "openUrl", args: [url] });
      return options.failOpenUrl === true ? Promise.reject(new Error("open_url failed")) : Promise.resolve();
    },
    focusGhostty: (script, terminalId) => {
      calls.push({ fn: "focusGhostty", args: [script, terminalId] });
      return Promise.resolve();
    },
    readPaseoServerId: () => {
      calls.push({ fn: "readPaseoServerId", args: [] });
      return Promise.resolve("server/one two");
    },
    flash: () => {
      calls.push({ fn: "flash", args: [] });
    },
  };
  return { deps, calls };
};

const callNames = (calls: RecordedCall[]): string[] => calls.map((call) => call.fn);

const flashCount = (calls: RecordedCall[]): number => calls.filter((call) => call.fn === "flash").length;

describe("pressSessionTile", () => {
  test("a rejected ack is fire-and-forget: routing still runs and nothing flashes", async () => {
    const { deps, calls } = makeDeps({ failAck: true });
    await pressSessionTile(session({ provider: "codex" }), deps);
    expect(callNames(calls)).toEqual(["ack", "openUrl"]);
    expect(flashCount(calls)).toBe(0);
  });

  test("acks the session with provider and id before any routing call", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ provider: "claude", ghosttyTerminalId: "term-9" }), deps);
    expect(calls[0]).toEqual({ fn: "ack", args: ["claude", "session-1"] });
    expect(callNames(calls)).toEqual(["ack", "focusGhostty"]);
  });

  test("paseo route resolves the server id and opens the url-encoded agent deep link", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ originKind: "paseo", originRef: "agent 42/x" }), deps);
    expect(callNames(calls)).toEqual(["ack", "readPaseoServerId", "openUrl"]);
    expect(calls[2]?.args).toEqual(["paseo://h/server%2Fone%20two/agent/agent%2042%2Fx"]);
  });

  test("ghostty route focuses the exact shared AppleScript on the terminal id", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ provider: "claude", ghosttyTerminalId: "term-9" }), deps);
    expect(calls[1]?.args).toEqual([FOCUS_GHOSTTY_TERMINAL_SCRIPT, "term-9"]);
  });

  test("url route opens the routed url", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ provider: "kimi" }), deps);
    expect(calls[1]?.args).toEqual(["http://127.0.0.1:58627/sessions/session-1"]);
  });

  test("a routing failure flashes exactly once", async () => {
    const { deps, calls } = makeDeps({ failOpenUrl: true });
    await pressSessionTile(session({ provider: "codex" }), deps);
    expect(callNames(calls)).toEqual(["ack", "openUrl", "flash"]);
    expect(flashCount(calls)).toBe(1);
  });

  test("an unroutable session flashes without any activation call", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ provider: "grok" }), deps);
    expect(callNames(calls)).toEqual(["ack", "flash"]);
    expect(flashCount(calls)).toBe(1);
  });
});
