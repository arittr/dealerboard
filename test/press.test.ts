import { describe, expect, test } from "bun:test";
import type { GestureWatermark } from "../app/src/bridge";
import { type PressDeps, pressBoardCard, pressSessionTile } from "../app/src/press";
import { FOCUS_GHOSTTY_TERMINAL_SCRIPT } from "../src/plugin/ghostty-focus";
import type { ProjectedSession } from "../src/protocol";

const session = (overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: "session-1",
  status: "idle",
  title: "A session",
  project: "dealerboard",
  descendantCount: 0,
  logicalSlot: 1,
  ghosttyTerminalId: null,
  model: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  unreadSince: null,
  doneSince: null,
  pendingResults: 0,
  endedAt: null,
  statusSince: null,
  activityLine: null,
  transcriptPath: null,
  originParentRef: null,
  lastEventAt: null,
  ...overrides,
});

type RecordedCall = { fn: string; args: unknown[] };

type DepsOptions = { failView?: boolean; failOpenUrl?: boolean; failActivation?: boolean };

/** Fake bridge deps: every call is recorded (flashes included) in order. */
const makeDeps = (options: DepsOptions = {}) => {
  const calls: RecordedCall[] = [];
  const deps: PressDeps = {
    view: (provider, sessionId, watermark) => {
      calls.push({ fn: "view", args: [provider, sessionId, watermark] });
      return options.failView === true ? Promise.reject(new Error("view down")) : Promise.resolve();
    },
    openUrl: (url) => {
      calls.push({ fn: "openUrl", args: [url] });
      return options.failOpenUrl === true ? Promise.reject(new Error("open_url failed")) : Promise.resolve();
    },
    activateEvenerSession: (sessionId) => {
      calls.push({ fn: "activateEvenerSession", args: [sessionId] });
      return options.failActivation === true ? Promise.reject(new Error("activation failed")) : Promise.resolve();
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

const callRows = (calls: RecordedCall[]): unknown[][] => calls.map((call) => [call.fn, ...call.args]);

const flashCount = (calls: RecordedCall[]): number => calls.filter((call) => call.fn === "flash").length;

/** The watermark a tap captures at pointer-down: the stamp the card showed. */
const seen = (unreadSince: string | null = null): GestureWatermark => ({ unreadSince });

describe("pressSessionTile", () => {
  test("a rejected view is fire-and-forget: routing still runs and nothing flashes", async () => {
    const { deps, calls } = makeDeps({ failView: true });
    await pressSessionTile(session({ provider: "codex" }), seen(), deps);
    expect(callNames(calls)).toEqual(["view", "openUrl"]);
    expect(flashCount(calls)).toBe(0);
  });

  test("views the session with its unread watermark before any routing call", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(
      session({ provider: "claude", ghosttyTerminalId: "term-9", unreadSince: "2026-08-26T05:00:00.000Z" }),
      seen("2026-08-26T05:00:00.000Z"),
      deps,
    );
    expect(calls[0]).toEqual({
      fn: "view",
      args: ["claude", "session-1", { unreadSince: "2026-08-26T05:00:00.000Z" }],
    });
    expect(callNames(calls)).toEqual(["view", "focusGhostty"]);
  });

  test("a read session views with a causal null-stamp watermark — never the unconditional shape", async () => {
    // The tap is always a causal gesture issued from the rendered snapshot;
    // a snapshot with no unread is { unreadSince: null }, NOT a bare null
    // (which would be unconditional and could consume a result in transit).
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ provider: "kimi" }), seen(), deps);
    expect(calls[0]).toEqual({ fn: "view", args: ["kimi", "session-1", { unreadSince: null }] });
  });

  test("views with the pointer-down watermark, never the session's current stamp", async () => {
    // A snapshot ingested mid-stroke moved the card's badge to at(9); the
    // press captured at(5). The view consumes only what the user saw.
    const { deps, calls } = makeDeps();
    await pressSessionTile(
      session({ provider: "codex", unreadSince: "2026-08-26T05:09:00.000Z" }),
      seen("2026-08-26T05:00:00.000Z"),
      deps,
    );
    expect(calls[0]).toEqual({
      fn: "view",
      args: ["codex", "session-1", { unreadSince: "2026-08-26T05:00:00.000Z" }],
    });
  });

  test("viewing does not dismiss: the tap never calls ack", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ doneSince: "2026-08-26T05:00:00.000Z" }), seen(), deps);
    expect(callNames(calls)).not.toContain("ack");
  });

  test("paseo route resolves the server id and opens the url-encoded agent deep link", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ originKind: "paseo", originRef: "agent 42/x" }), seen(), deps);
    expect(callNames(calls)).toEqual(["view", "readPaseoServerId", "openUrl"]);
    expect(calls[2]?.args).toEqual(["paseo://h/server%2Fone%20two/agent/agent%2042%2Fx"]);
  });

  test("ghostty route focuses the exact shared AppleScript on the terminal id", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ provider: "claude", ghosttyTerminalId: "term-9" }), seen(), deps);
    expect(calls[1]?.args).toEqual([FOCUS_GHOSTTY_TERMINAL_SCRIPT, "term-9"]);
  });

  test("url route opens the routed url", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ provider: "kimi" }), seen(), deps);
    expect(calls[1]?.args).toEqual(["http://127.0.0.1:58627/sessions/session-1"]);
  });

  test("a routing failure flashes exactly once", async () => {
    const { deps, calls } = makeDeps({ failOpenUrl: true });
    await pressSessionTile(session({ provider: "codex" }), seen(), deps);
    expect(callNames(calls)).toEqual(["view", "openUrl", "flash"]);
    expect(flashCount(calls)).toBe(1);
  });

  test("an unroutable session flashes without any activation call", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ provider: "grok" }), seen(), deps);
    expect(callNames(calls)).toEqual(["view", "flash"]);
    expect(flashCount(calls)).toBe(1);
  });

  test("an evener root views first, then activates the exact session id", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(
      session({ provider: "evener", sessionId: "evener-a", unreadSince: "2026-08-31T12:00:00.000Z" }),
      seen("2026-08-31T12:00:00.000Z"),
      deps,
    );
    expect(callRows(calls)).toEqual([
      ["view", "evener", "evener-a", { unreadSince: "2026-08-31T12:00:00.000Z" }],
      ["activateEvenerSession", "evener-a"],
    ]);
  });

  test("a rejected evener activation flashes exactly once", async () => {
    const { deps, calls } = makeDeps({ failActivation: true });
    await pressSessionTile(session({ provider: "evener", sessionId: "evener-a" }), seen(), deps);
    expect(callNames(calls)).toEqual(["view", "activateEvenerSession", "flash"]);
    expect(flashCount(calls)).toBe(1);
  });

  test("a rejected view does not block evener activation and never flashes", async () => {
    const { deps, calls } = makeDeps({ failView: true });
    await pressSessionTile(session({ provider: "evener", sessionId: "evener-a" }), seen(), deps);
    expect(callNames(calls)).toEqual(["view", "activateEvenerSession"]);
    expect(flashCount(calls)).toBe(0);
  });

  test("an ended card views but never routes (and does not flash)", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(
      session({ endedAt: "2026-08-26T05:00:00.000Z", unreadSince: "2026-08-26T04:00:00.000Z" }),
      seen("2026-08-26T04:00:00.000Z"),
      deps,
    );
    expect(callNames(calls)).toEqual(["view"]);
    expect(calls[0]).toEqual({
      fn: "view",
      args: ["claude", "session-1", { unreadSince: "2026-08-26T04:00:00.000Z" }],
    });
  });

  test("an ended evener card views but never activates", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(
      session({ provider: "evener", sessionId: "evener-a", endedAt: "2026-08-26T05:00:00.000Z" }),
      seen(),
      deps,
    );
    expect(callNames(calls)).toEqual(["view"]);
    expect(callNames(calls)).not.toContain("activateEvenerSession");
    expect(flashCount(calls)).toBe(0);
  });
});

describe("pressBoardCard", () => {
  test("a display-only card schedules no view, route, or flash", async () => {
    const { deps, calls } = makeDeps();
    await pressBoardCard({ session: session({ provider: "evener" }), displayOnly: true }, seen(), deps);
    expect(calls).toEqual([]);
  });
});
