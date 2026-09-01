import { describe, expect, test } from "bun:test";
import {
  createEvenerCollector,
  type EvenerCollectorUpdate,
  type EvenerSchedule,
  type EvenerSocket,
  type EvenerTimer,
  evenerAppWireUrl,
  evenerHubEndpoints,
  evenerSessionUrl,
  resolveEvenerHubConnection,
  resolveEvenerHubEndpoints,
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
  options: {
    ref?: string;
    parentRef?: string;
    kind?: string;
    diagnostics?: unknown;
    name?: string;
    model?: string;
    askPending?: boolean;
    pendingEscalations?: number;
  } = {},
): Record<string, unknown> => ({
  id: sessionId,
  sessionId,
  source: "local",
  name: options.name ?? `Title ${sessionId}`,
  modelProvider: options.model ?? "gpt-5.6-sol",
  cwd: `/work/${sessionId}`,
  path: sessionId,
  status: { type: status },
  evener: {
    ref: options.ref ?? `local:${sessionId}`,
    ...(options.parentRef === undefined ? {} : { parentRef: options.parentRef }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.askPending === undefined ? {} : { askPending: options.askPending }),
    ...(options.pendingEscalations === undefined
      ? {}
      : {
          pendingEscalations: Array.from({ length: options.pendingEscalations }, (_, index) => ({
            threadId: sessionId,
            ref: `local:${sessionId}`,
            escalationId: `escalation-${String(index + 1)}`,
            mode: "workspace-write",
            tool: "write_file",
            kind: "path",
            deniedPath: "/work/denied",
          })),
        }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  },
});

const requestByMethod = (socket: FakeSocket, method: string): Record<string, unknown> => {
  const frame = socket.sent.find((candidate) => candidate["method"] === method && "id" in candidate);
  if (frame === undefined) {
    throw new Error(`missing ${method} request`);
  }
  return frame;
};

const requestsByMethod = (socket: FakeSocket, method: string): Array<Record<string, unknown>> =>
  socket.sent.filter((candidate) => candidate["method"] === method && "id" in candidate);

const latestRequestByMethod = (socket: FakeSocket, method: string): Record<string, unknown> => {
  const request = requestsByMethod(socket, method).at(-1);
  if (request === undefined) {
    throw new Error(`missing ${method} request`);
  }
  return request;
};

const respondToReads = async (socket: FakeSocket, fixtures: ReadonlyMap<string, Record<string, unknown>>): Promise<void> => {
  let handled = 0;
  for (;;) {
    const reads = requestsByMethod(socket, "thread/read");
    const request = reads[handled];
    if (request === undefined) {
      return;
    }
    const params = request["params"] as Record<string, unknown>;
    const sessionId = params["threadId"];
    if (typeof sessionId !== "string") {
      throw new Error("targeted read omitted threadId");
    }
    const fixture = fixtures.get(sessionId);
    if (fixture === undefined) {
      throw new Error(`missing read fixture for ${sessionId}`);
    }
    respond(socket, request, { thread: fixture });
    handled += 1;
    await flush();
  }
};

const threadFixtures = (...values: Record<string, unknown>[]): ReadonlyMap<string, Record<string, unknown>> =>
  new Map(values.map((value) => [value["sessionId"] as string, value]));

const respond = (socket: FakeSocket, request: Record<string, unknown>, result: unknown): void => {
  socket.message({ id: request["id"], result });
};

const acceptBaseline = async (
  socket: FakeSocket,
  updates: EvenerCollectorUpdate[],
  values: Record<string, unknown>[] = [thread("baseline", "active")],
): Promise<void> => {
  socket.open();
  respond(socket, requestByMethod(socket, "initialize"), { protocolVersion: "evener-appwire-v3" });
  await flush();
  respond(socket, requestByMethod(socket, "thread/list"), { data: values });
  await flush();
  await respondToReads(socket, threadFixtures(...values));
  expect(updates.at(-1)?.activeChildSessionIds).toEqual(expect.any(Array));
};

const authoritativeUpdateHarness = (): {
  updates: EvenerCollectorUpdate[];
  onUpdate: (update: EvenerCollectorUpdate) => void;
} => {
  const updates: EvenerCollectorUpdate[] = [];
  return { updates, onUpdate: (update) => updates.push(update) };
};

const collectIncrementalEvents = (
  events: EvenerCollectorUpdate["events"],
): ((update: EvenerCollectorUpdate) => void) => {
  let firstUpdate = true;
  return (update) => {
    if (firstUpdate) {
      firstUpdate = false;
    } else {
      expect(update.activeChildSessionIds).toBeNull();
    }
    events.push(...update.events);
  };
};

describe("Evener hub connection discovery", () => {
  test("normalizes only loopback hub addresses", () => {
    expect(evenerAppWireUrl("127.0.0.1:9180")).toBe("ws://127.0.0.1:9180/rpc");
    expect(evenerAppWireUrl("http://localhost:9180/anything")).toBe("ws://localhost:9180/rpc");
    expect(evenerAppWireUrl("0.0.0.0:9180")).toBe("ws://127.0.0.1:9180/rpc");
    expect(evenerAppWireUrl("127.example.com:9180")).toBeNull();
    expect(evenerAppWireUrl("https://example.com:9180")).toBeNull();
  });

  test("resolves token-free AppWire and browser endpoints", () => {
    expect(evenerHubEndpoints("127.0.0.1:9180")).toEqual({
      appWireUrl: "ws://127.0.0.1:9180/rpc",
      browserOrigin: "http://127.0.0.1:9180",
    });
    expect(evenerHubEndpoints("wss://localhost:9443/rpc?token=leak#fragment")).toEqual({
      appWireUrl: "wss://localhost:9443/rpc",
      browserOrigin: "https://localhost:9443",
    });
    expect(evenerHubEndpoints("http://0.0.0.0:9180/custom?x=1#y")).toEqual({
      appWireUrl: "ws://127.0.0.1:9180/rpc",
      browserOrigin: "http://127.0.0.1:9180",
    });
    expect(evenerHubEndpoints("https://example.com:9180")).toBeNull();
    expect(evenerHubEndpoints("http://user:password@localhost:9180")).toBeNull();
  });

  test("builds the canonical token-free session route", () => {
    const endpoints = {
      appWireUrl: "ws://127.0.0.1:9180/rpc",
      browserOrigin: "http://127.0.0.1:9180",
    };
    const sessionUrl = evenerSessionUrl(endpoints, "session/a b");
    expect(sessionUrl).toBe("http://127.0.0.1:9180/s/local%3Asession%2Fa%20b");
    expect(sessionUrl).not.toContain("/rpc/s/");
    expect(sessionUrl).not.toContain("?");
    expect(sessionUrl).not.toContain("#");
    expect(sessionUrl).not.toContain("sentinel-token");
    expect(evenerSessionUrl(endpoints, "")).toBeNull();
    expect(evenerSessionUrl(endpoints, "\nunsafe")).toBeNull();
    expect(evenerSessionUrl(endpoints, "\uD800")).toBeNull();
    expect(evenerSessionUrl(endpoints, "\uDC00")).toBeNull();
    expect(evenerSessionUrl(endpoints, "x".repeat(257))).toBeNull();
    expect(evenerSessionUrl(endpoints, "x".repeat(256))).not.toBeNull();
  });

  test("resolves endpoints without reading token paths", () => {
    const reads: string[] = [];
    const endpoints = resolveEvenerHubEndpoints({
      home: "/Users/test",
      environment: {},
      readText: (path) => {
        reads.push(path);
        return path.endsWith("hub.toml")
          ? 'addr = "127.0.0.1:9777"\nhub_state_root = "/state/evener"\n'
          : "must-not-be-read";
      },
      parseToml: Bun.TOML.parse,
    });
    expect(endpoints?.browserOrigin).toBe("http://127.0.0.1:9777");
    expect(reads).toEqual(["/Users/test/.config/evener/hub.toml"]);
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
  test("delivers an authoritative update with no events to the update harness", () => {
    const harness = authoritativeUpdateHarness();
    harness.onUpdate({ events: [], activeChildSessionIds: [] });
    expect(harness.updates.at(-1)).toEqual({
      events: [],
      activeChildSessionIds: [],
    });
  });

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
      onUpdate: (update) => {
        updates.push(update);
      },
    });

    collector.start();
    expect(factoryCalls).toEqual([{ url: "ws://127.0.0.1:9180/rpc", token: "capability" }]);
    socket.open();
    const initialize = requestByMethod(socket, "initialize");
    expect(initialize["params"]).toEqual({
      protocolVersion: "evener-appwire-v3",
      clientInfo: { name: "dealerboard", version: "1" },
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
        thread("terra-child", "active", {
          parentRef: "local:root",
          kind: "subagent",
          model: "gpt-5.6-terra",
        }),
        thread("opus-child", "active", {
          parentRef: "local:root",
          kind: "subagent",
          model: "claude-opus-4.1",
        }),
        thread("root", "active", { name: "Root title", model: "gpt-5.6-sol" }),
        { ...thread("foreign", "active"), source: "codex-local", evener: { ref: "codex-local:foreign" } },
      ],
    });
    await flush();

    const firstRead = requestByMethod(socket, "thread/read");
    expect(firstRead["params"]).toMatchObject({
      ref: "local:terra-child",
      threadId: "terra-child",
      includeTurns: false,
      subscribe: true,
      replaceSubscription: true,
    });
    respond(socket, firstRead, {
      thread: thread("terra-child", "active", {
        parentRef: "local:root",
        kind: "subagent",
        model: "gpt-5.6-terra",
      }),
    });
    await flush();
    let reads = socket.sent.filter((frame) => frame["method"] === "thread/read" && "id" in frame);
    expect(reads).toHaveLength(2);
    expect(reads[1]?.["params"]).toMatchObject({ ref: "local:opus-child", threadId: "opus-child", replaceSubscription: false });
    respond(socket, reads[1]!, {
      thread: thread("opus-child", "active", {
        parentRef: "local:root",
        kind: "subagent",
        model: "claude-opus-4.1",
      }),
    });
    await flush();
    reads = socket.sent.filter((frame) => frame["method"] === "thread/read" && "id" in frame);
    expect(reads).toHaveLength(3);
    expect(reads[2]?.["params"]).toMatchObject({ ref: "local:root", threadId: "root", replaceSubscription: false });
    respond(socket, reads[2]!, {
      thread: thread("root", "active", { name: "Root title", model: "gpt-5.6-sol" }),
    });
    await flush();
    reads = socket.sent.filter((frame) => frame["method"] === "thread/read" && "id" in frame);
    expect(reads).toHaveLength(3);

    const initialEvents = updates.flatMap((update) => update.events);
    expect(initialEvents.map((event) => [event.kind, event.sessionId])).toEqual([
      ["SessionObserved", "root"],
      ["SessionTitleChanged", "root"],
      ["SessionStatusObserved", "root"],
      ["SubagentStart", "opus-child"],
      ["SessionModelChanged", "opus-child"],
      ["SessionTitleChanged", "opus-child"],
      ["SessionStatusObserved", "opus-child"],
      ["SubagentStart", "terra-child"],
      ["SessionModelChanged", "terra-child"],
      ["SessionTitleChanged", "terra-child"],
      ["SessionStatusObserved", "terra-child"],
    ]);
    expect(initialEvents[2]).toMatchObject({ status: "working" });
    expect(initialEvents[3]).toMatchObject({ parentSessionId: "root" });
    expect(
      initialEvents.filter((event) => event.kind === "SubagentStart").map((event) => [event.sessionId, event.model]),
    ).toEqual([
      ["opus-child", "claude-opus-4.1"],
      ["terra-child", "gpt-5.6-terra"],
    ]);
    expect(
      initialEvents
        .filter((event) => event.kind === "SessionModelChanged")
        .map((event) => [event.sessionId, event.model]),
    ).toEqual([
      ["opus-child", "claude-opus-4.1"],
      ["terra-child", "gpt-5.6-terra"],
    ]);

    socket.message({
      method: "thread/model/changed",
      params: { ref: "local:terra-child", model: "gemini-3-pro" },
    });
    expect(updates.at(-1)).toEqual({
      events: [
        {
          kind: "SessionModelChanged",
          provider: "evener",
          sessionId: "terra-child",
          model: "gemini-3-pro",
          observedAt: "2026-08-26T05:00:00.000Z",
        },
      ],
      activeChildSessionIds: null,
    });
    expect(timers.timers.some((timer) => timer.active && timer.delayMs === 2_000)).toBe(true);

    collector.stop();
    expect(socket.closed).toBe(true);
  });

  test("targets every shared-ref session in either list order and rejects ambiguous compatibility parents", async () => {
    const orders = [
      ["root", "child", "grandchild"],
      ["child", "grandchild", "root"],
    ];
    for (const order of orders) {
      const socket = new FakeSocket();
      const timers = timerHarness();
      const updates: EvenerCollectorUpdate[] = [];
      const diagnostics: string[] = [];
      const fixtureBySession = new Map<string, Record<string, unknown>>([
        ["root", thread("root", "active", { ref: "local:root" })],
        [
          "child",
          thread("child", "active", { ref: "local:root", parentRef: "local:root", kind: "subagent" }),
        ],
        [
          "grandchild",
          thread("grandchild", "active", { ref: "local:root", parentRef: "local:root", kind: "subagent" }),
        ],
      ]);
      const collector = createEvenerCollector({
        connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
        socketFactory: () => socket,
        schedule: timers.schedule,
        diagnostics: (record) => diagnostics.push(JSON.stringify(record)),
        onUpdate: (update) => updates.push(update),
      });
      collector.start();
      socket.open();
      respond(socket, requestByMethod(socket, "initialize"), { protocolVersion: "evener-appwire-v3" });
      await flush();
      const list = requestByMethod(socket, "thread/list");
      respond(socket, list, { data: order.map((sessionId) => fixtureBySession.get(sessionId)!) });
      await flush();
      await respondToReads(socket, fixtureBySession);

      const reads = requestsByMethod(socket, "thread/read");
      expect(reads.map((request) => (request["params"] as Record<string, unknown>)["threadId"]).sort()).toEqual([
        "child",
        "grandchild",
        "root",
      ]);
      expect(reads.every((request) => (request["params"] as Record<string, unknown>)["ref"] === "local:root")).toBe(true);
      expect((reads[0]?.["params"] as Record<string, unknown>)["replaceSubscription"]).toBe(true);
      expect(
        reads.slice(1).every((request) => (request["params"] as Record<string, unknown>)["replaceSubscription"] === false),
      ).toBe(true);
      expect(updates).toEqual([]);
      expect(socket.closed).toBe(false);
      expect(diagnostics).toHaveLength(1);
      collector.stop();
    }
  });

  test("rejects a partial refresh that would orphan an active child", async () => {
    const socket = new FakeSocket();
    const timers = timerHarness();
    const updates: EvenerCollectorUpdate[] = [];
    const diagnostics: string[] = [];
    const root = thread("root", "active", { ref: "local:root" });
    const child = thread("child", "active", { parentRef: "local:root", kind: "subagent" });
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: () => socket,
      schedule: timers.schedule,
      diagnostics: (record) => diagnostics.push(JSON.stringify(record)),
      onUpdate: (update) => updates.push(update),
    });

    collector.start();
    await acceptBaseline(socket, updates, [root, child]);
    expect(updates.at(-1)?.activeChildSessionIds).toEqual(["child"]);
    updates.length = 0;

    timers.run(2_000);
    respond(socket, latestRequestByMethod(socket, "thread/list"), { data: [child] });
    await flush();
    const childRead = latestRequestByMethod(socket, "thread/read");
    respond(socket, childRead, { thread: child });
    await flush();

    expect(updates).toEqual([]);
    expect(socket.closed).toBe(false);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).not.toContain("child");
    expect(diagnostics[0]).not.toContain("local:root");

    socket.message({
      method: "thread/status/changed",
      params: { ref: "local:root", threadId: "root", status: { type: "active" } },
    });
    expect(updates.at(-1)).toMatchObject({
      activeChildSessionIds: null,
      events: [{ kind: "Activity", provider: "evener", sessionId: "root" }],
    });
    expect(updates.every((update) => update.activeChildSessionIds === null)).toBe(true);
    collector.stop();
  });

  test("publishes an empty authoritative update after an empty complete candidate", async () => {
    const socket = new FakeSocket();
    const updates: EvenerCollectorUpdate[] = [];
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: () => socket,
      onUpdate: (update) => updates.push(update),
    });
    collector.start();
    socket.open();
    respond(socket, requestByMethod(socket, "initialize"), { protocolVersion: "evener-appwire-v3" });
    await flush();
    respond(socket, requestByMethod(socket, "thread/list"), { data: [] });
    await flush();
    expect(updates).toEqual([{ events: [], activeChildSessionIds: [] }]);
    collector.stop();
  });

  test("keeps the accepted session state when a duplicate candidate is rejected", async () => {
    const socket = new FakeSocket();
    const timers = timerHarness();
    const updates: EvenerCollectorUpdate[] = [];
    const diagnostics: string[] = [];
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: () => socket,
      schedule: timers.schedule,
      diagnostics: (record) => diagnostics.push(JSON.stringify(record)),
      onUpdate: (update) => updates.push(update),
    });
    collector.start();
    socket.open();
    respond(socket, requestByMethod(socket, "initialize"), { protocolVersion: "evener-appwire-v3" });
    await flush();
    const baseline = thread("baseline", "active");
    respond(socket, requestByMethod(socket, "thread/list"), { data: [baseline] });
    await flush();
    await respondToReads(socket, threadFixtures(baseline));
    expect(updates.at(-1)?.activeChildSessionIds).toEqual([]);
    updates.length = 0;

    timers.run(2_000);
    await flush();
    respond(socket, latestRequestByMethod(socket, "thread/list"), { data: [baseline, baseline] });
    await flush();
    expect(updates).toEqual([]);
    expect(socket.closed).toBe(false);
    expect(diagnostics).toHaveLength(1);

    socket.message({
      method: "turn/started",
      params: { ref: "local:baseline", threadId: "baseline", turn: { status: "inProgress" } },
    });
    expect(updates.at(-1)).toMatchObject({
      activeChildSessionIds: null,
      events: [{ kind: "Activity", sessionId: "baseline" }],
    });
    collector.stop();
  });

  test("rejects malformed identity and status candidates without swapping the baseline", async () => {
    const candidates = [
      { label: "identity", value: thread("\u0000malformed", "active") },
      { label: "status", value: thread("baseline", "not-a-status") },
    ];
    for (const candidate of candidates) {
      const socket = new FakeSocket();
      const timers = timerHarness();
      const updates: EvenerCollectorUpdate[] = [];
      const diagnostics: string[] = [];
      const collector = createEvenerCollector({
        connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
        socketFactory: () => socket,
        schedule: timers.schedule,
        now: () => "2026-08-26T05:00:00.000Z",
        diagnostics: (record) => diagnostics.push(JSON.stringify(record)),
        onUpdate: (update) => updates.push(update),
      });

      collector.start();
      await acceptBaseline(socket, updates);
      updates.length = 0;

      timers.run(2_000);
      respond(socket, latestRequestByMethod(socket, "thread/list"), { data: [candidate.value] });
      await flush();

      expect(updates).toEqual([]);
      expect(socket.closed).toBe(false);
      expect(diagnostics).toEqual([
        JSON.stringify({
          timestamp: "2026-08-26T05:00:00.000Z",
          component: "evener",
          code: "evener_collector_failed",
          provider: "evener",
        }),
      ]);
      expect(diagnostics[0]).not.toContain(candidate.label);
      expect(diagnostics[0]).not.toContain("malformed");

      socket.message({
        method: "thread/status/changed",
        params: { ref: "local:baseline", threadId: "baseline", status: { type: "active" } },
      });
      expect(updates.at(-1)).toMatchObject({
        activeChildSessionIds: null,
        events: [{ kind: "Activity", provider: "evener", sessionId: "baseline" }],
      });
      expect(updates.every((update) => update.activeChildSessionIds === null)).toBe(true);
      expect(diagnostics).toHaveLength(1);
      collector.stop();
    }
  });

  test("rejects malformed and mismatched thread reads without swapping the baseline", async () => {
    const readFailures = [
      { label: "malformed", result: { thread: {} } },
      { label: "mismatch", result: { thread: thread("different-session", "active") } },
    ];
    for (const failure of readFailures) {
      const socket = new FakeSocket();
      const timers = timerHarness();
      const updates: EvenerCollectorUpdate[] = [];
      const diagnostics: string[] = [];
      const collector = createEvenerCollector({
        connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
        socketFactory: () => socket,
        schedule: timers.schedule,
        now: () => "2026-08-26T05:00:00.000Z",
        diagnostics: (record) => diagnostics.push(JSON.stringify(record)),
        onUpdate: (update) => updates.push(update),
      });

      collector.start();
      await acceptBaseline(socket, updates);
      updates.length = 0;

      timers.run(2_000);
      respond(socket, latestRequestByMethod(socket, "thread/list"), { data: [thread("baseline", "active")] });
      await flush();
      respond(socket, latestRequestByMethod(socket, "thread/read"), failure.result);
      await flush();

      expect(updates).toEqual([]);
      expect(socket.closed).toBe(false);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).not.toContain(failure.label);
      expect(diagnostics[0]).not.toContain("different-session");

      socket.message({
        method: "thread/status/changed",
        params: { ref: "local:baseline", threadId: "baseline", status: { type: "active" } },
      });
      expect(updates.at(-1)).toMatchObject({
        activeChildSessionIds: null,
        events: [{ kind: "Activity", provider: "evener", sessionId: "baseline" }],
      });
      expect(updates.every((update) => update.activeChildSessionIds === null)).toBe(true);
      expect(diagnostics).toHaveLength(1);
      collector.stop();
    }
  });

  test("retains the baseline through a rejected thread read and reconnect", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const timers = timerHarness();
    const updates: EvenerCollectorUpdate[] = [];
    const diagnostics: string[] = [];
    let socketIndex = 0;
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: () => sockets[socketIndex++]!,
      schedule: timers.schedule,
      now: () => "2026-08-26T05:00:00.000Z",
      diagnostics: (record) => diagnostics.push(JSON.stringify(record)),
      onUpdate: (update) => updates.push(update),
    });

    collector.start();
    await acceptBaseline(sockets[0]!, updates);
    updates.length = 0;

    timers.run(2_000);
    respond(sockets[0]!, latestRequestByMethod(sockets[0]!, "thread/list"), {
      data: [thread("baseline", "active")],
    });
    await flush();
    const rejectedRead = latestRequestByMethod(sockets[0]!, "thread/read");
    sockets[0]!.message({ id: rejectedRead["id"], error: { code: -1 } });
    await flush();

    expect(updates).toEqual([]);
    expect(sockets[0]!.closed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).not.toContain("baseline");

    timers.run(5_000);
    expect(socketIndex).toBe(2);
    sockets[1]!.open();
    respond(sockets[1]!, requestByMethod(sockets[1]!, "initialize"), { protocolVersion: "evener-appwire-v3" });
    await flush();
    sockets[1]!.message({
      method: "thread/status/changed",
      params: { ref: "local:baseline", threadId: "baseline", status: { type: "active" } },
    });
    expect(updates.at(-1)).toMatchObject({
      activeChildSessionIds: null,
      events: [{ kind: "Activity", provider: "evener", sessionId: "baseline" }],
    });
    expect(updates.every((update) => update.activeChildSessionIds === null)).toBe(true);
    expect(diagnostics).toHaveLength(1);
    collector.stop();
  });

  test("rejects a refresh when a listed child closes before its targeted read", async () => {
    const socket = new FakeSocket();
    const timers = timerHarness();
    const updates: EvenerCollectorUpdate[] = [];
    const diagnostics: string[] = [];
    const root = thread("root", "active", { ref: "local:root" });
    const child = thread("child", "active", { parentRef: "local:root", kind: "subagent" });
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: () => socket,
      schedule: timers.schedule,
      now: () => "2026-08-26T05:00:00.000Z",
      diagnostics: (record) => diagnostics.push(JSON.stringify(record)),
      onUpdate: (update) => updates.push(update),
    });

    collector.start();
    await acceptBaseline(socket, updates, [root, child]);
    updates.length = 0;

    timers.run(2_000);
    respond(socket, latestRequestByMethod(socket, "thread/list"), { data: [root, child] });
    await flush();
    const refreshRootRead = latestRequestByMethod(socket, "thread/read");
    expect((refreshRootRead["params"] as Record<string, unknown>)["threadId"]).toBe("root");
    respond(socket, refreshRootRead, { thread: root });
    await flush();
    const childRead = latestRequestByMethod(socket, "thread/read");
    expect((childRead["params"] as Record<string, unknown>)["threadId"]).toBe("child");

    socket.message({ method: "thread/closed", params: { ref: "local:root", threadId: "child" } });
    expect(updates.at(-1)).toMatchObject({
      activeChildSessionIds: null,
      events: [{ kind: "SubagentStop", provider: "evener", sessionId: "child" }],
    });
    respond(socket, childRead, { thread: child });
    await flush();

    expect(updates.every((update) => update.activeChildSessionIds === null)).toBe(true);
    expect(updates).toHaveLength(1);
    expect(socket.closed).toBe(false);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).not.toContain("child");

    socket.message({
      method: "thread/status/changed",
      params: { ref: "local:root", threadId: "root", status: { type: "active" } },
    });
    expect(updates.at(-1)).toMatchObject({
      activeChildSessionIds: null,
      events: [{ kind: "Activity", provider: "evener", sessionId: "root" }],
    });
    expect(diagnostics).toHaveLength(1);
    collector.stop();
  });

  test("disconnects without partial hydration when thread/list exceeds the page cap", async () => {
    const socket = new FakeSocket();
    const timers = timerHarness();
    const updates: EvenerCollectorUpdate[] = [];
    const diagnostics: string[] = [];
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: () => socket,
      schedule: timers.schedule,
      maxListPages: 2,
      maxListItems: 10,
      diagnostics: (record) => diagnostics.push(JSON.stringify(record)),
      onUpdate: (update) => updates.push(update),
    });

    collector.start();
    socket.open();
    respond(socket, requestByMethod(socket, "initialize"), { protocolVersion: "evener-appwire-v3" });
    await flush();

    let lists = socket.sent.filter((frame) => frame["method"] === "thread/list" && "id" in frame);
    respond(socket, lists[0]!, { data: [thread("page-one", "active")], nextCursor: "cursor-1" });
    await flush();
    lists = socket.sent.filter((frame) => frame["method"] === "thread/list" && "id" in frame);
    expect(lists).toHaveLength(2);
    respond(socket, lists[1]!, { data: [thread("page-two", "active")], nextCursor: "cursor-2" });
    await flush();

    expect(socket.closed).toBe(true);
    expect(updates).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(timers.timers.some((timer) => timer.active && timer.delayMs === 5_000)).toBe(true);
    collector.stop();
  });

  test("disconnects without partial hydration when thread/list exceeds the item cap", async () => {
    const socket = new FakeSocket();
    const timers = timerHarness();
    const updates: EvenerCollectorUpdate[] = [];
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: () => socket,
      schedule: timers.schedule,
      maxListPages: 2,
      maxListItems: 1,
      onUpdate: (update) => updates.push(update),
    });

    collector.start();
    socket.open();
    respond(socket, requestByMethod(socket, "initialize"), { protocolVersion: "evener-appwire-v3" });
    await flush();
    respond(socket, requestByMethod(socket, "thread/list"), {
      data: [thread("first", "active"), thread("second", "active")],
    });
    await flush();

    expect(socket.closed).toBe(true);
    expect(updates).toEqual([]);
    expect(timers.timers.some((timer) => timer.active && timer.delayMs === 5_000)).toBe(true);
    collector.stop();
  });

  test("treats ordinary awaiting as a settled turn during hydration and live updates", async () => {
    const socket = new FakeSocket();
    const events: EvenerCollectorUpdate["events"] = [];
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: () => socket,
      now: () => "2026-08-26T05:00:30.000Z",
      onUpdate: collectIncrementalEvents(events),
    });
    collector.start();
    socket.open();
    respond(socket, requestByMethod(socket, "initialize"), { protocolVersion: "evener-appwire-v3" });
    await flush();
    respond(socket, requestByMethod(socket, "thread/list"), { data: [thread("root", "awaiting")] });
    await flush();
    await respondToReads(socket, threadFixtures(thread("root", "awaiting")));

    expect(events.find((event) => event.kind === "SessionStatusObserved")).toMatchObject({ status: "idle" });

    events.length = 0;
    socket.message({
      method: "turn/completed",
      params: { ref: "local:root", threadId: "root", turnId: "turn_1", turn: { status: "completed" } },
    });
    socket.message({
      method: "thread/status/changed",
      params: { ref: "local:root", threadId: "root", status: { type: "awaiting" } },
    });
    expect(events).toEqual([
      { kind: "Stop", provider: "evener", sessionId: "root", observedAt: "2026-08-26T05:00:30.000Z" },
      {
        kind: "SessionStatusObserved",
        provider: "evener",
        sessionId: "root",
        status: "idle",
        observedAt: "2026-08-26T05:00:30.000Z",
      },
    ]);
    collector.stop();
  });

  test("hydrates concrete Evener questions and sandbox escalations as waiting", async () => {
    const socket = new FakeSocket();
    const events: EvenerCollectorUpdate["events"] = [];
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: () => socket,
      onUpdate: collectIncrementalEvents(events),
    });
    collector.start();
    socket.open();
    respond(socket, requestByMethod(socket, "initialize"), { protocolVersion: "evener-appwire-v3" });
    await flush();
    respond(socket, requestByMethod(socket, "thread/list"), {
      data: [
        thread("question", "awaiting", { askPending: true }),
        thread("escalation", "active", { pendingEscalations: 1 }),
      ],
    });
    await flush();
    await respondToReads(
      socket,
      threadFixtures(thread("question", "awaiting", { askPending: true }), thread("escalation", "active", { pendingEscalations: 1 })),
    );

    expect(
      events.filter((event) => event.kind === "SessionStatusObserved").map((event) => [event.sessionId, event.status]),
    ).toEqual([
      ["question", "waiting"],
      ["escalation", "waiting"],
    ]);
    collector.stop();
  });

  test("emits idempotent cleanup for settled awaiting subagents", async () => {
    const socket = new FakeSocket();
    const events: EvenerCollectorUpdate["events"] = [];
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: () => socket,
      onUpdate: collectIncrementalEvents(events),
    });
    collector.start();
    socket.open();
    respond(socket, requestByMethod(socket, "initialize"), { protocolVersion: "evener-appwire-v3" });
    await flush();
    respond(socket, requestByMethod(socket, "thread/list"), {
      data: [thread("root", "active"), thread("child", "awaiting", { parentRef: "local:root", kind: "subagent" })],
    });
    await flush();

    const rootRead = requestByMethod(socket, "thread/read");
    respond(socket, rootRead, { thread: thread("root", "active") });
    await flush();
    const reads = socket.sent.filter((frame) => frame["method"] === "thread/read" && "id" in frame);
    expect(reads).toHaveLength(2);
    respond(socket, reads[1]!, {
      thread: thread("child", "awaiting", { parentRef: "local:root", kind: "subagent" }),
    });
    await flush();

    expect(events.filter((event) => event.sessionId === "child")).toEqual([
      {
        kind: "SubagentStop",
        provider: "evener",
        sessionId: "child",
        observedAt: expect.any(String),
      },
    ]);
    collector.stop();
  });

  test("re-registers settled subagents when live events resume them", async () => {
    const socket = new FakeSocket();
    const events: EvenerCollectorUpdate["events"] = [];
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: () => socket,
      onUpdate: collectIncrementalEvents(events),
    });
    collector.start();
    socket.open();
    respond(socket, requestByMethod(socket, "initialize"), { protocolVersion: "evener-appwire-v3" });
    await flush();
    respond(socket, requestByMethod(socket, "thread/list"), {
      data: [
        thread("root", "active"),
        thread("status-child", "awaiting", { parentRef: "local:root", kind: "subagent" }),
        thread("turn-child", "awaiting", { parentRef: "local:root", kind: "subagent" }),
      ],
    });
    await flush();
    await respondToReads(
      socket,
      threadFixtures(
        thread("root", "active"),
        thread("status-child", "awaiting", { parentRef: "local:root", kind: "subagent" }),
        thread("turn-child", "awaiting", { parentRef: "local:root", kind: "subagent" }),
      ),
    );
    events.length = 0;

    socket.message({
      method: "thread/status/changed",
      params: { ref: "local:status-child", threadId: "status-child", status: { type: "active" } },
    });
    socket.message({
      method: "turn/started",
      params: { ref: "local:turn-child", threadId: "turn-child", turn: { status: "inProgress" } },
    });

    for (const sessionId of ["status-child", "turn-child"]) {
      expect(events.filter((event) => event.sessionId === sessionId).map((event) => event.kind)).toEqual([
        "SubagentStart",
        "SessionModelChanged",
        "SessionTitleChanged",
        "SessionStatusObserved",
      ]);
      expect(
        events.find((event) => event.sessionId === sessionId && event.kind === "SessionStatusObserved"),
      ).toMatchObject({ status: "working" });
    }
    collector.stop();
  });

  test("keeps waiting until every Evener blocker resolves", async () => {
    const socket = new FakeSocket();
    const timers = timerHarness();
    const events: EvenerCollectorUpdate["events"] = [];
    const collector = createEvenerCollector({
      connection: () => ({ url: "ws://127.0.0.1:9180/rpc", token: "capability" }),
      socketFactory: () => socket,
      schedule: timers.schedule,
      onUpdate: collectIncrementalEvents(events),
    });
    collector.start();
    socket.open();
    respond(socket, requestByMethod(socket, "initialize"), { protocolVersion: "evener-appwire-v3" });
    await flush();
    respond(socket, requestByMethod(socket, "thread/list"), {
      data: [
        thread("question", "awaiting", { askPending: true, pendingEscalations: 1 }),
        thread("escalations", "active", { pendingEscalations: 2 }),
      ],
    });
    await flush();
    await respondToReads(
      socket,
      threadFixtures(
        thread("question", "awaiting", { askPending: true, pendingEscalations: 1 }),
        thread("escalations", "active", { pendingEscalations: 2 }),
      ),
    );
    events.length = 0;

    socket.message({
      method: "evener/sandbox/escalation/resolved",
      params: { ref: "local:question", threadId: "question", escalationId: "escalation-1" },
    });
    socket.message({
      method: "evener/sandbox/escalation/resolved",
      params: { ref: "local:escalations", threadId: "escalations", escalationId: "escalation-1" },
    });
    socket.message({
      method: "thread/status/changed",
      params: { ref: "local:question", threadId: "question", status: { type: "awaiting" } },
    });
    socket.message({
      method: "thread/status/changed",
      params: { ref: "local:escalations", threadId: "escalations", status: { type: "active" } },
    });

    expect(events.map((event) => [event.sessionId, event.kind])).toEqual([
      ["question", "Attention"],
      ["escalations", "Attention"],
    ]);
    collector.stop();
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
      onUpdate: collectIncrementalEvents(events),
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
    await respondToReads(
      socket,
      threadFixtures(thread("root", "active"), thread("child", "active", { parentRef: "local:root", kind: "subagent" })),
    );
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
      ["SessionStatusObserved", "root"],
      ["SessionTitleChanged", "root"],
      ["SessionModelChanged", "root"],
      ["Activity", "root"],
      ["StopFailure", "root"],
      ["SessionStatusObserved", "root"],
      ["SubagentStop", "child"],
      ["SessionEnd", "root"],
    ]);
    expect(events[1]).toMatchObject({ status: "idle" });
    expect(events[3]).toMatchObject({ model: "gpt-5.6-terra" });
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
