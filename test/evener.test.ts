import { describe, expect, test } from "bun:test";
import {
  createEvenerCollector,
  type EvenerCollectorUpdate,
  type EvenerSchedule,
  type EvenerSocket,
  type EvenerTimer,
  evenerAppWireUrl,
  resolveEvenerHubConnection,
} from "../src/core/evener";

class FakeSocket implements EvenerSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.({});
  }

  message(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  fail(): void {
    this.onerror?.({});
  }
}

type Scheduled = EvenerTimer & { callback: () => void; delayMs: number; active: boolean };

const timerHarness = (): { schedule: EvenerSchedule; timers: Scheduled[]; run: (delayMs: number) => void } => {
  const timers: Scheduled[] = [];
  const schedule: EvenerSchedule = (callback, delayMs) => {
    const timer: Scheduled = {
      callback,
      delayMs,
      active: true,
      clear: () => {
        timer.active = false;
      },
      unref: () => {},
    };
    timers.push(timer);
    return timer;
  };
  return {
    schedule,
    timers,
    run: (delayMs) => {
      const timer = timers.find((candidate) => candidate.active && candidate.delayMs === delayMs);
      if (timer === undefined) {
        throw new Error(`no active ${String(delayMs)}ms timer`);
      }
      timer.active = false;
      timer.callback();
    },
  };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const thread = (
  sessionId: string,
  status: string,
  options: { parentRef?: string; kind?: string; name?: string } = {},
): Record<string, unknown> => ({
  id: sessionId,
  sessionId,
  source: "local",
  name: options.name ?? `Title ${sessionId}`,
  modelProvider: "gpt-5.6-sol",
  cwd: `/work/${sessionId}`,
  path: sessionId,
  status: { type: status },
  evener: {
    ref: `local:${sessionId}`,
    ...(options.parentRef === undefined ? {} : { parentRef: options.parentRef }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
  },
});

const requestByMethod = (socket: FakeSocket, method: string): Record<string, unknown> => {
  const frame = socket.sent.find((candidate) => candidate["method"] === method && "id" in candidate);
  if (frame === undefined) {
    throw new Error(`missing ${method} request`);
  }
  return frame;
};

const respond = (socket: FakeSocket, request: Record<string, unknown>, result: unknown): void => {
  socket.message({ id: request["id"], result });
};

describe("Evener hub connection discovery", () => {
  test("normalizes only loopback hub addresses", () => {
    expect(evenerAppWireUrl("127.0.0.1:9180")).toBe("ws://127.0.0.1:9180/rpc");
    expect(evenerAppWireUrl("http://localhost:9180/anything")).toBe("ws://localhost:9180/rpc");
    expect(evenerAppWireUrl("0.0.0.0:9180")).toBe("ws://127.0.0.1:9180/rpc");
    expect(evenerAppWireUrl("127.example.com:9180")).toBeNull();
    expect(evenerAppWireUrl("https://example.com:9180")).toBeNull();
  });

  test("uses documented defaults and reads the capability without exposing it", () => {
    const reads: string[] = [];
    const connection = resolveEvenerHubConnection({
      home: "/Users/test",
      environment: {},
      readText: (path) => {
        reads.push(path);
        return path.endsWith("auth-token") ? "secret-token\n" : null;
      },
    });
    expect(connection).toEqual({ url: "ws://127.0.0.1:9180/rpc", token: "secret-token" });
    expect(reads).toEqual(["/Users/test/.config/evener/hub.toml", "/Users/test/.local/state/evener/auth-token"]);
  });

  test("honors env precedence and custom hub state without reading a token file when env supplies one", () => {
    const reads: string[] = [];
    const connection = resolveEvenerHubConnection({
      home: "/Users/test",
      environment: {
        EVENER_HUB_ADDR: "http://localhost:9190",
        EVENER_HUB_AUTH_TOKEN: "env-token",
        XDG_CONFIG_HOME: "/cfg",
        XDG_STATE_HOME: "/state",
      },
      readText: (path) => {
        reads.push(path);
        return path.endsWith("hub.toml") ? 'addr = "127.0.0.1:9999"\nhub_state_root = "/custom-state"' : null;
      },
    });
    expect(connection).toEqual({ url: "ws://localhost:9190/rpc", token: "env-token" });
    expect(reads).toEqual(["/cfg/evener/hub.toml"]);
  });

  test("returns null for absent, multiline, or remotely-targeted credentials", () => {
    const base = { home: "/Users/test", readText: () => null };
    expect(resolveEvenerHubConnection({ ...base, environment: {} })).toBeNull();
    expect(
      resolveEvenerHubConnection({
        ...base,
        environment: { EVENER_HUB_ADDR: "example.com:9180", EVENER_HUB_AUTH_TOKEN: "token" },
      }),
    ).toBeNull();
    expect(resolveEvenerHubConnection({ ...base, environment: { EVENER_HUB_AUTH_TOKEN: "bad\ntoken" } })).toBeNull();
  });
});

describe("Evener AppWire collector", () => {
  test("handshakes, hydrates roots before subagents, and subscribes with one replacement", async () => {
    const socket = new FakeSocket();
    const timers = timerHarness();
    const updates: EvenerCollectorUpdate[] = [];
    const factoryCalls: Array<{ url: string; token: string }> = [];
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: (url, token) => {
        factoryCalls.push({ url, token });
        return socket;
      },
      schedule: timers.schedule,
      now: () => "2026-08-26T05:00:00.000Z",
      onUpdate: (update) => updates.push(update),
    });

    collector.start();
    expect(factoryCalls).toEqual([{ url: "ws://127.0.0.1:9180/rpc", token: "capability" }]);
    socket.open();
    const initialize = requestByMethod(socket, "initialize");
    expect(initialize["params"]).toEqual({
      protocolVersion: "evener-appwire-v3",
      clientInfo: { name: "stream-deck-agents", version: "1" },
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/agentMessage/reset",
          "item/reasoning/summaryTextDelta",
          "item/toolOutput/delta",
        ],
      },
    });
    respond(socket, initialize, { protocolVersion: "evener-appwire-v3" });
    await flush();
    expect(socket.sent).toContainEqual({ method: "initialized", params: {} });

    const list = requestByMethod(socket, "thread/list");
    expect(list["params"]).toEqual({
      statuses: ["idle", "active", "awaiting", "warning", "systemError"],
      sourceIds: ["local"],
      includeSubagents: true,
    });
    respond(socket, list, {
      data: [
        thread("child", "active", { parentRef: "local:root", kind: "subagent" }),
        thread("root", "active", { name: "Root title" }),
        { ...thread("foreign", "active"), source: "codex-local", evener: { ref: "codex-local:foreign" } },
      ],
    });
    await flush();

    const initialEvents = updates.flatMap((update) => update.events);
    expect(initialEvents.map((event) => [event.kind, event.sessionId])).toEqual([
      ["SessionObserved", "root"],
      ["SessionTitleChanged", "root"],
      ["SessionStatusObserved", "root"],
      ["SubagentStart", "child"],
      ["SessionTitleChanged", "child"],
      ["SessionStatusObserved", "child"],
    ]);
    expect(initialEvents[2]).toMatchObject({ status: "working" });
    expect(initialEvents[3]).toMatchObject({ parentSessionId: "root" });

    const firstRead = requestByMethod(socket, "thread/read");
    expect(firstRead["params"]).toMatchObject({
      ref: "local:root",
      includeTurns: false,
      subscribe: true,
      replaceSubscription: true,
    });
    respond(socket, firstRead, { thread: thread("root", "active", { name: "Root title" }) });
    await flush();
    const reads = socket.sent.filter((frame) => frame["method"] === "thread/read" && "id" in frame);
    expect(reads).toHaveLength(2);
    expect(reads[1]?.["params"]).toMatchObject({ ref: "local:child", replaceSubscription: false });
    respond(socket, reads[1]!, {
      thread: thread("child", "active", { parentRef: "local:root", kind: "subagent" }),
    });
    await flush();
    expect(timers.timers.some((timer) => timer.active && timer.delayMs === 2_000)).toBe(true);

    collector.stop();
    expect(socket.closed).toBe(true);
  });

  test("maps ordered live lifecycle, title, model, failure, and child completion events", async () => {
    const socket = new FakeSocket();
    const timers = timerHarness();
    const events: EvenerCollectorUpdate["events"] = [];
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: () => socket,
      schedule: timers.schedule,
      now: () => "2026-08-26T05:01:00.000Z",
      onUpdate: (update) => events.push(...update.events),
    });
    collector.start();
    socket.open();
    const initialize = requestByMethod(socket, "initialize");
    respond(socket, initialize, { protocolVersion: "evener-appwire-v3" });
    await flush();
    const list = requestByMethod(socket, "thread/list");
    respond(socket, list, {
      data: [thread("root", "active"), thread("child", "active", { parentRef: "local:root", kind: "subagent" })],
    });
    await flush();
    events.length = 0;

    socket.message({
      method: "turn/completed",
      params: { ref: "local:root", threadId: "root", turnId: "turn_1", turn: { status: "completed" } },
    });
    socket.message({
      method: "thread/status/changed",
      params: { ref: "local:root", threadId: "root", status: { type: "awaiting" } },
    });
    socket.message({
      method: "evener/thread/name/changed",
      params: { ref: "local:root", threadId: "root", name: "Renamed" },
    });
    socket.message({
      method: "thread/model/changed",
      params: { ref: "local:root", threadId: "root", modelProvider: "openai", model: "gpt-5.6-terra" },
    });
    socket.message({
      method: "turn/started",
      params: { ref: "local:root", threadId: "root", turn: { status: "inProgress" } },
    });
    socket.message({
      method: "turn/completed",
      params: { ref: "local:root", threadId: "root", turnId: "turn_2", turn: { status: "failed" } },
    });
    socket.message({
      method: "thread/status/changed",
      params: { ref: "local:root", threadId: "root", status: { type: "idle" } },
    });
    socket.message({
      method: "turn/completed",
      params: { ref: "local:child", threadId: "child", turnId: "turn_1", turn: { status: "completed" } },
    });
    socket.message({ method: "thread/closed", params: { ref: "local:root", threadId: "root" } });

    expect(events.map((event) => [event.kind, event.sessionId])).toEqual([
      ["Stop", "root"],
      ["Attention", "root"],
      ["SessionTitleChanged", "root"],
      ["SessionObserved", "root"],
      ["Activity", "root"],
      ["StopFailure", "root"],
      ["SessionStatusObserved", "root"],
      ["SubagentStop", "child"],
      ["SessionEnd", "root"],
    ]);
    expect(events[3]).toMatchObject({ model: "gpt-5.6-terra", title: "Renamed" });
    expect(events[6]).toMatchObject({ status: "error" });
    collector.stop();
  });

  test("reconnects after a socket failure without logging or exposing the token", () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const timers = timerHarness();
    const diagnostics: string[] = [];
    let calls = 0;
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "never-log-this" }),
      socketFactory: () => sockets[calls++]!,
      schedule: timers.schedule,
      diagnostics: (record) => diagnostics.push(JSON.stringify(record)),
      onUpdate: () => {},
    });
    collector.start();
    sockets[0]!.fail();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).not.toContain("never-log-this");
    timers.run(5_000);
    expect(calls).toBe(2);
    collector.stop();
  });

  test("abandons a socket that never opens and reconnects", () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const timers = timerHarness();
    const diagnostics: string[] = [];
    let calls = 0;
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "never-log-this" }),
      socketFactory: () => sockets[calls++]!,
      schedule: timers.schedule,
      diagnostics: (record) => diagnostics.push(JSON.stringify(record)),
      onUpdate: () => {},
    });

    collector.start();
    expect(timers.timers.some((timer) => timer.active && timer.delayMs === 5_000)).toBe(true);
    timers.run(5_000);
    expect(sockets[0]!.closed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).not.toContain("never-log-this");
    timers.run(5_000);
    expect(calls).toBe(2);
    collector.stop();
  });
});
