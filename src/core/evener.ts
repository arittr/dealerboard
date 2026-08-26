import { readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { RegistryEvent, SessionStatus } from "../protocol";
import type { DiagnosticRecord } from "./diagnostics";

/** Evener's current exact AppWire handshake version. */
export const EVENER_APPWIRE_PROTOCOL_VERSION = "evener-appwire-v3";
export const EVENER_DEFAULT_HUB_ADDRESS = "127.0.0.1:9180";
export const EVENER_REFRESH_INTERVAL_MS = 2_000;
export const EVENER_RECONNECT_INTERVAL_MS = 5_000;
export const EVENER_REQUEST_TIMEOUT_MS = 5_000;
export const EVENER_MAX_FRAME_CODE_UNITS = 4 * 1024 * 1024;

const MAX_WIRE_STRING_CODE_POINTS = 256;
const MAX_TOKEN_CODE_UNITS = 4_096;
const LOCAL_SOURCE_ID = "local";

const HIGH_VOLUME_NOTIFICATIONS = [
  "item/agentMessage/delta",
  "item/agentMessage/reset",
  "item/reasoning/summaryTextDelta",
  "item/toolOutput/delta",
] as const;

const THREAD_STATUSES = ["idle", "active", "awaiting", "warning", "systemError"] as const;
const KNOWN_THREAD_STATUSES = new Set<string>([...THREAD_STATUSES, "closed", "notLoaded"]);

export type EvenerHubConnection = {
  url: string;
  token: string;
};

export type EvenerHubConfigDependencies = {
  home: string;
  environment: Readonly<Record<string, string | undefined>>;
  readText?: (path: string) => string | null;
  parseToml?: (text: string) => object;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const defaultReadText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const boundedString = (value: unknown): string | null => {
  const text = nonEmptyString(value);
  return text === null ? null : Array.from(text).slice(0, MAX_WIRE_STRING_CODE_POINTS).join("");
};

const safeToken = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }
  const token = value.trim();
  if (token.length === 0 || token.length > MAX_TOKEN_CODE_UNITS || token.includes("\r") || token.includes("\n")) {
    return null;
  }
  return token;
};

const xdgRoot = (environment: Readonly<Record<string, string | undefined>>, key: string, fallback: string): string => {
  const candidate = environment[key];
  return candidate !== undefined && candidate.length > 0 && isAbsolute(candidate) ? candidate : fallback;
};

/**
 * Turn Evener's bind/client address forms into a loopback WebSocket endpoint.
 * The capability token is never sent to a non-loopback host.
 */
export const evenerAppWireUrl = (rawAddress: string): string | null => {
  let address = rawAddress.trim();
  if (address.length === 0) {
    return null;
  }
  if (address.startsWith(":")) {
    address = `127.0.0.1${address}`;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(address)) {
    address = `http://${address}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return null;
  }
  if (parsed.hostname === "0.0.0.0" || parsed.hostname === "::") {
    parsed.hostname = "127.0.0.1";
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  if (!loopback) {
    return null;
  }
  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return null;
  }
  parsed.pathname = "/rpc";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

/** Resolve the same address, state root, and bearer-token precedence Evener's TUI uses. */
export const resolveEvenerHubConnection = (dependencies: EvenerHubConfigDependencies): EvenerHubConnection | null => {
  const readText = dependencies.readText ?? defaultReadText;
  const parseToml = dependencies.parseToml ?? Bun.TOML.parse;
  const configRoot = xdgRoot(dependencies.environment, "XDG_CONFIG_HOME", join(dependencies.home, ".config"));
  const defaultStateRoot = xdgRoot(
    dependencies.environment,
    "XDG_STATE_HOME",
    join(dependencies.home, ".local", "state"),
  );
  const environmentAddress = nonEmptyString(dependencies.environment["EVENER_HUB_ADDR"]);
  let address = environmentAddress ?? EVENER_DEFAULT_HUB_ADDRESS;
  let stateRoot = join(defaultStateRoot, "evener");
  const configText = readText(join(configRoot, "evener", "hub.toml"));
  if (configText !== null) {
    try {
      const parsed = parseToml(configText);
      if (isRecord(parsed)) {
        const configuredAddress = nonEmptyString(parsed["addr"]);
        if (configuredAddress !== null && environmentAddress === null) {
          address = configuredAddress;
        }
        const configuredStateRoot = nonEmptyString(parsed["hub_state_root"]);
        if (configuredStateRoot !== null && isAbsolute(configuredStateRoot)) {
          stateRoot = configuredStateRoot;
        }
      }
    } catch {
      // A malformed optional config falls back to Evener's documented defaults.
    }
  }
  const environmentToken = safeToken(dependencies.environment["EVENER_HUB_AUTH_TOKEN"] ?? null);
  const token = environmentToken ?? safeToken(readText(join(stateRoot, "auth-token")));
  const url = evenerAppWireUrl(address);
  return token === null || url === null ? null : { url, token };
};

export type EvenerCollectorUpdate = {
  events: RegistryEvent[];
};

export type EvenerSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
};

export type EvenerSocketFactory = (url: string, token: string) => EvenerSocket;

export type EvenerTimer = {
  clear(): void;
  unref(): void;
};

export type EvenerSchedule = (callback: () => void, delayMs: number) => EvenerTimer;

export type EvenerCollectorDependencies = {
  connection: () => EvenerHubConnection | null;
  onUpdate: (update: EvenerCollectorUpdate) => void;
  diagnostics?: (record: DiagnosticRecord) => void;
  now?: () => string;
  socketFactory?: EvenerSocketFactory;
  schedule?: EvenerSchedule;
  refreshIntervalMs?: number;
  reconnectIntervalMs?: number;
  requestTimeoutMs?: number;
};

export type EvenerCollector = {
  start(): void;
  stop(): void;
};

type AppWireStatus = (typeof THREAD_STATUSES)[number] | "closed" | "notLoaded";

type EvenerThreadState = {
  ref: string;
  sessionId: string;
  parentRef: string | null;
  kind: string | null;
  title: string | null;
  project: string | null;
  model: string | null;
  rawStatus: AppWireStatus;
  askPending: boolean;
  pendingEscalationCount: number;
  failedTurn: boolean;
  registered: boolean;
  cleanupEmitted: boolean;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: EvenerTimer;
};

const defaultSchedule: EvenerSchedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return {
    clear: () => clearTimeout(timer),
    unref: () => timer.unref(),
  };
};

type BunWebSocketConstructor = new (
  url: string,
  options: { headers: Readonly<Record<string, string>> },
) => EvenerSocket;

const defaultSocketFactory: EvenerSocketFactory = (url, token) => {
  const WebSocketWithHeaders = WebSocket as unknown as BunWebSocketConstructor;
  return new WebSocketWithHeaders(url, { headers: { Authorization: `Bearer ${token}` } });
};

const messageText = (event: unknown): string | null => {
  if (!isRecord(event)) {
    return null;
  }
  return typeof event["data"] === "string" ? event["data"] : null;
};

const parseStatus = (value: unknown): AppWireStatus | null => {
  if (!isRecord(value) || typeof value["type"] !== "string" || !KNOWN_THREAD_STATUSES.has(value["type"])) {
    return null;
  }
  return value["type"] as AppWireStatus;
};

const projectFromThread = (thread: Record<string, unknown>): string | null => {
  const cwd = nonEmptyString(thread["cwd"]);
  const projectPath = nonEmptyString(thread["projectPath"]);
  const path = cwd ?? projectPath;
  if (path !== null) {
    const name = basename(path);
    if (name.length > 0 && name !== ".") {
      return boundedString(name);
    }
  }
  return boundedString(thread["path"]);
};

const parseThread = (value: unknown, previous?: EvenerThreadState): EvenerThreadState | null => {
  if (!isRecord(value)) {
    return null;
  }
  const evener = value["evener"];
  if (!isRecord(evener)) {
    return null;
  }
  const ref = boundedString(evener["ref"]);
  const sessionId = boundedString(value["sessionId"]);
  const source = nonEmptyString(value["source"]);
  if (source !== LOCAL_SOURCE_ID || ref === null || !ref.startsWith(`${LOCAL_SOURCE_ID}:`) || sessionId === null) {
    return null;
  }
  const rawStatus = parseStatus(value["status"]);
  if (rawStatus === null) {
    throw new Error("invalid Evener thread status");
  }
  const kind = boundedString(evener["kind"]);
  const parentRef = boundedString(evener["parentRef"]);
  return {
    ref,
    sessionId,
    parentRef,
    kind,
    title: boundedString(value["name"]),
    project: projectFromThread(value),
    model: boundedString(value["modelProvider"]),
    rawStatus,
    askPending: evener["askPending"] === true,
    pendingEscalationCount: Array.isArray(evener["pendingEscalations"]) ? evener["pendingEscalations"].length : 0,
    failedTurn: rawStatus === "active" || rawStatus === "awaiting" ? false : (previous?.failedTurn ?? false),
    registered: previous?.registered ?? false,
    cleanupEmitted: previous?.cleanupEmitted ?? false,
  };
};

const isChild = (state: EvenerThreadState): boolean => state.kind === "subagent" || state.parentRef !== null;

const requiresAttention = (state: EvenerThreadState): boolean => state.askPending || state.pendingEscalationCount > 0;

const effectiveStatus = (state: EvenerThreadState): SessionStatus => {
  switch (state.rawStatus) {
    case "active":
      return requiresAttention(state) ? "waiting" : "working";
    case "awaiting":
      return requiresAttention(state) ? "waiting" : "idle";
    case "warning":
    case "systemError":
      return "error";
    case "idle":
      return state.failedTurn ? "error" : "idle";
    case "closed":
    case "notLoaded":
      return "idle";
  }
};

const observedEvent = (state: EvenerThreadState, observedAt: string): RegistryEvent => ({
  kind: "SessionObserved",
  provider: "evener",
  sessionId: state.sessionId,
  title: state.title,
  project: state.project,
  transcriptPath: null,
  model: state.model,
  observedAt,
});

const startEvent = (state: EvenerThreadState, observedAt: string): RegistryEvent => ({
  kind: "SessionStart",
  provider: "evener",
  sessionId: state.sessionId,
  title: state.title,
  project: state.project,
  ghosttyTerminalId: null,
  transcriptPath: null,
  model: state.model,
  observedAt,
});

const statusObservedEvent = (state: EvenerThreadState, observedAt: string): RegistryEvent => ({
  kind: "SessionStatusObserved",
  provider: "evener",
  sessionId: state.sessionId,
  status: effectiveStatus(state),
  observedAt,
});

const liveStatusEvent = (
  state: EvenerThreadState,
  previousStatus: SessionStatus,
  observedAt: string,
): RegistryEvent => {
  const status = effectiveStatus(state);
  if (status === "error" && previousStatus !== "error") {
    return { kind: "StopFailure", provider: "evener", sessionId: state.sessionId, observedAt };
  }
  if (status === "working") {
    return { kind: "Activity", provider: "evener", sessionId: state.sessionId, observedAt };
  }
  if (status === "waiting") {
    return { kind: "Attention", provider: "evener", sessionId: state.sessionId, observedAt };
  }
  return statusObservedEvent(state, observedAt);
};

const titleEvent = (state: EvenerThreadState, observedAt: string): RegistryEvent | null =>
  state.title === null
    ? null
    : {
        kind: "SessionTitleChanged",
        provider: "evener",
        sessionId: state.sessionId,
        title: state.title,
        observedAt,
      };

const modelEvent = (state: EvenerThreadState, observedAt: string): RegistryEvent | null =>
  state.model === null
    ? null
    : {
        kind: "SessionModelChanged",
        provider: "evener",
        sessionId: state.sessionId,
        model: state.model,
        observedAt,
      };

const endEvent = (state: EvenerThreadState, observedAt: string): RegistryEvent =>
  isChild(state)
    ? { kind: "SubagentStop", provider: "evener", sessionId: state.sessionId, observedAt }
    : { kind: "SessionEnd", provider: "evener", sessionId: state.sessionId, observedAt };

const parseTurnStatus = (params: Record<string, unknown>): string | null => {
  const turn = params["turn"];
  return isRecord(turn) && typeof turn["status"] === "string" ? turn["status"] : null;
};

/** Authenticated AppWire observer with ordered hydration, subscriptions, and reconnect. */
export const createEvenerCollector = (dependencies: EvenerCollectorDependencies): EvenerCollector => {
  const diagnostics = dependencies.diagnostics ?? (() => {});
  const now = dependencies.now ?? (() => new Date().toISOString());
  const socketFactory = dependencies.socketFactory ?? defaultSocketFactory;
  const schedule = dependencies.schedule ?? defaultSchedule;
  const refreshIntervalMs = dependencies.refreshIntervalMs ?? EVENER_REFRESH_INTERVAL_MS;
  const reconnectIntervalMs = dependencies.reconnectIntervalMs ?? EVENER_RECONNECT_INTERVAL_MS;
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? EVENER_REQUEST_TIMEOUT_MS;

  let stopped = true;
  let socket: EvenerSocket | null = null;
  let connectTimer: EvenerTimer | null = null;
  let reconnectTimer: EvenerTimer | null = null;
  let refreshTimer: EvenerTimer | null = null;
  let nextRequestId = 1;
  let refreshing = false;
  let refreshAgain = false;
  let failureReported = false;
  const pending = new Map<number, PendingRequest>();
  const states = new Map<string, EvenerThreadState>();
  const subscribed = new Set<string>();

  const reportFailure = (): void => {
    if (failureReported) {
      return;
    }
    failureReported = true;
    try {
      diagnostics({ timestamp: now(), component: "evener", code: "evener_collector_failed", provider: "evener" });
    } catch {
      // Diagnostics never break the collector.
    }
  };

  const emit = (events: RegistryEvent[]): void => {
    if (events.length === 0) {
      return;
    }
    try {
      dependencies.onUpdate({ events });
    } catch {
      reportFailure();
    }
  };

  const clearTimer = (timer: EvenerTimer | null): null => {
    timer?.clear();
    return null;
  };

  const rejectPending = (reason: string): void => {
    for (const request of pending.values()) {
      request.timer.clear();
      request.reject(new Error(reason));
    }
    pending.clear();
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      connect();
    }, reconnectIntervalMs);
    reconnectTimer.unref();
  };

  const disconnect = (target: EvenerSocket, reason: string): void => {
    if (socket !== target) {
      return;
    }
    socket = null;
    connectTimer = clearTimer(connectTimer);
    refreshTimer = clearTimer(refreshTimer);
    subscribed.clear();
    refreshing = false;
    refreshAgain = false;
    rejectPending(reason);
    try {
      target.close();
    } catch {
      try {
        target.terminate?.();
      } catch {
        // Best-effort close only.
      }
    }
    reportFailure();
    scheduleReconnect();
  };

  const request = (target: EvenerSocket, method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (socket !== target) {
      return Promise.reject(new Error("Evener AppWire socket is not active"));
    }
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = schedule(() => {
        pending.delete(id);
        reject(new Error(`Evener AppWire request timed out: ${method}`));
      }, requestTimeoutMs);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      try {
        target.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        pending.delete(id);
        timer.clear();
        reject(error instanceof Error ? error : new Error("Evener AppWire send failed"));
      }
    });
  };

  const notify = (target: EvenerSocket, method: string, params: Record<string, unknown>): void => {
    target.send(JSON.stringify({ method, params }));
  };

  const rootParent = (state: EvenerThreadState): EvenerThreadState | null => {
    if (state.parentRef === null) {
      return null;
    }
    return states.get(state.parentRef) ?? null;
  };

  const hydrateState = (state: EvenerThreadState, liveStart: boolean, observedAt: string): RegistryEvent[] => {
    if (state.rawStatus === "closed" || state.rawStatus === "notLoaded") {
      state.registered = false;
      return [endEvent(state, observedAt)];
    }
    if (isChild(state)) {
      const parent = rootParent(state);
      if (parent === null || !parent.registered || effectiveStatus(state) === "idle") {
        const events = state.cleanupEmitted ? [] : [endEvent(state, observedAt)];
        state.registered = false;
        state.cleanupEmitted = true;
        return events;
      }
      const events: RegistryEvent[] = [];
      if (!state.registered) {
        events.push({
          kind: "SubagentStart",
          provider: "evener",
          sessionId: state.sessionId,
          parentSessionId: parent.sessionId,
          title: state.title,
          project: state.project,
          model: state.model,
          observedAt,
        });
        state.registered = true;
        state.cleanupEmitted = false;
      }
      const model = modelEvent(state, observedAt);
      if (model !== null) {
        events.push(model);
      }
      const title = titleEvent(state, observedAt);
      if (title !== null) {
        events.push(title);
      }
      events.push(statusObservedEvent(state, observedAt));
      return events;
    }
    state.registered = true;
    const events: RegistryEvent[] = [liveStart ? startEvent(state, observedAt) : observedEvent(state, observedAt)];
    const title = titleEvent(state, observedAt);
    if (title !== null) {
      events.push(title);
    }
    events.push(statusObservedEvent(state, observedAt));
    return events;
  };

  const hydrateThreads = (values: unknown[], liveStart: boolean): EvenerThreadState[] => {
    const parsed: EvenerThreadState[] = [];
    for (const value of values) {
      if (!isRecord(value)) {
        throw new Error("invalid Evener thread/list item");
      }
      const source = nonEmptyString(value["source"]);
      if (source !== LOCAL_SOURCE_ID) {
        continue;
      }
      const evener = value["evener"];
      const ref = isRecord(evener) ? boundedString(evener["ref"]) : null;
      const previous = ref === null ? undefined : states.get(ref);
      const state = parseThread(value, previous);
      if (state === null) {
        throw new Error("invalid local Evener thread");
      }
      parsed.push(state);
    }
    const observedAt = now();
    const events: RegistryEvent[] = [];
    const ordered: EvenerThreadState[] = [];
    for (const state of parsed) {
      states.set(state.ref, state);
    }
    const pendingChildren: EvenerThreadState[] = [];
    for (const state of parsed) {
      if (isChild(state)) {
        pendingChildren.push(state);
      } else {
        events.push(...hydrateState(state, liveStart, observedAt));
        ordered.push(state);
      }
    }
    let progressed = true;
    while (pendingChildren.length > 0 && progressed) {
      progressed = false;
      for (let index = pendingChildren.length - 1; index >= 0; index -= 1) {
        const state = pendingChildren[index];
        if (state === undefined) {
          continue;
        }
        const parent = rootParent(state);
        if (parent === null || !parent.registered) {
          continue;
        }
        events.push(...hydrateState(state, liveStart, observedAt));
        ordered.push(state);
        pendingChildren.splice(index, 1);
        progressed = true;
      }
    }
    emit(events);
    return ordered;
  };

  const subscribe = async (target: EvenerSocket, state: EvenerThreadState): Promise<void> => {
    if (subscribed.has(state.ref) || state.rawStatus === "closed" || state.rawStatus === "notLoaded") {
      return;
    }
    const replaceSubscription = subscribed.size === 0;
    const result = await request(target, "thread/read", {
      ref: state.ref,
      includeTurns: false,
      subscribe: true,
      replaceSubscription,
    });
    if (!isRecord(result) || !("thread" in result)) {
      throw new Error("invalid Evener thread/read response");
    }
    subscribed.add(state.ref);
    hydrateThreads([result["thread"]], false);
  };

  const listThreads = async (target: EvenerSocket): Promise<EvenerThreadState[]> => {
    const values: unknown[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (;;) {
      const result = await request(target, "thread/list", {
        statuses: [...THREAD_STATUSES],
        sourceIds: [LOCAL_SOURCE_ID],
        includeSubagents: true,
        ...(cursor === null ? {} : { cursor }),
      });
      if (!isRecord(result) || !Array.isArray(result["data"])) {
        throw new Error("invalid Evener thread/list response");
      }
      values.push(...result["data"]);
      const nextCursor = nonEmptyString(result["nextCursor"]);
      if (nextCursor === null) {
        break;
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error("Evener thread/list repeated its cursor");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return hydrateThreads(values, false);
  };

  const scheduleRefresh = (delayMs: number): void => {
    if (stopped || socket === null) {
      return;
    }
    refreshTimer = clearTimer(refreshTimer);
    refreshTimer = schedule(() => {
      refreshTimer = null;
      const target = socket;
      if (target !== null) {
        void refresh(target);
      }
    }, delayMs);
    refreshTimer.unref();
  };

  const refresh = async (target: EvenerSocket): Promise<void> => {
    if (socket !== target || stopped) {
      return;
    }
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      const listed = await listThreads(target);
      for (const state of listed) {
        try {
          await subscribe(target, state);
        } catch {
          // A thread may close between list and read; the next list reconciles it.
        }
      }
      failureReported = false;
    } catch {
      disconnect(target, "Evener AppWire refresh failed");
      return;
    } finally {
      refreshing = false;
    }
    if (socket !== target || stopped) {
      return;
    }
    if (refreshAgain) {
      refreshAgain = false;
      scheduleRefresh(0);
    } else {
      scheduleRefresh(refreshIntervalMs);
    }
  };

  const stateForParams = (params: Record<string, unknown>): EvenerThreadState | null => {
    const ref = boundedString(params["ref"]);
    return ref === null ? null : (states.get(ref) ?? null);
  };

  const handleStatusNotification = (params: Record<string, unknown>): void => {
    const state = stateForParams(params);
    const rawStatus = parseStatus(params["status"]);
    if (state === null || rawStatus === null) {
      scheduleRefresh(0);
      return;
    }
    const previousStatus = effectiveStatus(state);
    state.rawStatus = rawStatus;
    if (rawStatus === "active" || rawStatus === "awaiting") {
      state.failedTurn = false;
    }
    const observedAt = now();
    if (isChild(state)) {
      if (effectiveStatus(state) === "idle") {
        const events = state.cleanupEmitted ? [] : [endEvent(state, observedAt)];
        state.registered = false;
        state.cleanupEmitted = true;
        emit(events);
        return;
      }
      if (!state.registered) {
        emit(hydrateState(state, true, observedAt));
        return;
      }
    }
    if (rawStatus === "closed" || rawStatus === "notLoaded") {
      emit([endEvent(state, observedAt)]);
      states.delete(state.ref);
      return;
    }
    emit([liveStatusEvent(state, previousStatus, observedAt)]);
  };

  const handleTurnStarted = (params: Record<string, unknown>): void => {
    const state = stateForParams(params);
    if (state === null) {
      scheduleRefresh(0);
      return;
    }
    state.rawStatus = "active";
    state.askPending = false;
    state.failedTurn = false;
    const observedAt = now();
    if (isChild(state) && !state.registered) {
      emit(hydrateState(state, true, observedAt));
      return;
    }
    emit([{ kind: "Activity", provider: "evener", sessionId: state.sessionId, observedAt }]);
  };

  const handleTurnCompleted = (params: Record<string, unknown>): void => {
    const state = stateForParams(params);
    const turnStatus = parseTurnStatus(params);
    if (state === null || turnStatus === null) {
      scheduleRefresh(0);
      return;
    }
    const observedAt = now();
    if (isChild(state)) {
      const events = state.cleanupEmitted ? [] : [endEvent(state, observedAt)];
      state.registered = false;
      state.cleanupEmitted = true;
      emit(events);
      return;
    }
    if (turnStatus === "failed") {
      state.failedTurn = true;
      state.rawStatus = "idle";
      emit([{ kind: "StopFailure", provider: "evener", sessionId: state.sessionId, observedAt }]);
    } else if (turnStatus === "completed" || turnStatus === "interrupted") {
      state.failedTurn = false;
      const events: RegistryEvent[] = [{ kind: "Stop", provider: "evener", sessionId: state.sessionId, observedAt }];
      if (turnStatus === "completed" && requiresAttention(state)) {
        events.push({ kind: "Attention", provider: "evener", sessionId: state.sessionId, observedAt });
      }
      emit(events);
    }
  };

  const handleStarted = (params: Record<string, unknown>): void => {
    if (!("thread" in params)) {
      scheduleRefresh(0);
      return;
    }
    hydrateThreads([params["thread"]], true);
    const state = stateForParams(params);
    if (state !== null && socket !== null) {
      void subscribe(socket, state).catch(() => scheduleRefresh(0));
    } else {
      scheduleRefresh(0);
    }
  };

  const handleClosed = (params: Record<string, unknown>): void => {
    const state = stateForParams(params);
    if (state === null) {
      return;
    }
    const observedAt = now();
    emit([endEvent(state, observedAt)]);
    states.delete(state.ref);
    subscribed.delete(state.ref);
    for (const [ref, candidate] of states) {
      if (candidate.parentRef === state.ref) {
        states.delete(ref);
        subscribed.delete(ref);
      }
    }
  };

  const handleNameChanged = (params: Record<string, unknown>): void => {
    const state = stateForParams(params);
    const title = boundedString(params["name"]);
    if (state === null || title === null) {
      return;
    }
    state.title = title;
    const event = titleEvent(state, now());
    if (event !== null) {
      emit([event]);
    }
  };

  const handleModelChanged = (params: Record<string, unknown>): void => {
    const state = stateForParams(params);
    const model = boundedString(params["model"]);
    if (state === null || model === null) {
      return;
    }
    state.model = model;
    emit([
      {
        kind: "SessionModelChanged",
        provider: "evener",
        sessionId: state.sessionId,
        model,
        observedAt: now(),
      },
    ]);
  };

  const handleNotification = (method: string, paramsValue: unknown): void => {
    const params = isRecord(paramsValue) ? paramsValue : {};
    switch (method) {
      case "thread/started":
        handleStarted(params);
        return;
      case "thread/closed":
        handleClosed(params);
        return;
      case "thread/status/changed":
        handleStatusNotification(params);
        return;
      case "evener/thread/name/changed":
        handleNameChanged(params);
        return;
      case "thread/model/changed":
        handleModelChanged(params);
        return;
      case "turn/started":
        handleTurnStarted(params);
        return;
      case "turn/completed":
        handleTurnCompleted(params);
        return;
      case "evener/sandbox/escalation/requested": {
        const state = stateForParams(params);
        if (state !== null) {
          state.pendingEscalationCount += 1;
          state.failedTurn = false;
          emit([{ kind: "Attention", provider: "evener", sessionId: state.sessionId, observedAt: now() }]);
        }
        return;
      }
      case "evener/sandbox/escalation/resolved": {
        const state = stateForParams(params);
        if (state !== null) {
          state.pendingEscalationCount = Math.max(0, state.pendingEscalationCount - 1);
        }
        scheduleRefresh(0);
        return;
      }
      case "evener/thread/resync":
      case "evener/tree/changed":
        scheduleRefresh(0);
        return;
      default:
        return;
    }
  };

  const handleMessage = (target: EvenerSocket, event: unknown): void => {
    if (socket !== target) {
      return;
    }
    const text = messageText(event);
    if (text === null || text.length > EVENER_MAX_FRAME_CODE_UNITS) {
      disconnect(target, "invalid Evener AppWire frame");
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      disconnect(target, "invalid Evener AppWire JSON");
      return;
    }
    if (!isRecord(frame)) {
      disconnect(target, "invalid Evener AppWire envelope");
      return;
    }
    if (typeof frame["id"] === "number") {
      const request = pending.get(frame["id"]);
      if (request === undefined) {
        return;
      }
      pending.delete(frame["id"]);
      request.timer.clear();
      if (isRecord(frame["error"])) {
        request.reject(new Error("Evener AppWire request failed"));
      } else {
        request.resolve(frame["result"]);
      }
      return;
    }
    if (typeof frame["method"] === "string") {
      handleNotification(frame["method"], frame["params"]);
    }
  };

  const initialize = async (target: EvenerSocket): Promise<void> => {
    const result = await request(target, "initialize", {
      protocolVersion: EVENER_APPWIRE_PROTOCOL_VERSION,
      clientInfo: { name: "stream-deck-agents", version: "1" },
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: [...HIGH_VOLUME_NOTIFICATIONS],
      },
    });
    if (!isRecord(result) || result["protocolVersion"] !== EVENER_APPWIRE_PROTOCOL_VERSION) {
      throw new Error("incompatible Evener AppWire protocol");
    }
    notify(target, "initialized", {});
    await refresh(target);
  };

  function connect(): void {
    if (stopped || socket !== null) {
      return;
    }
    const connection = dependencies.connection();
    if (connection === null) {
      scheduleReconnect();
      return;
    }
    let target: EvenerSocket;
    try {
      target = socketFactory(connection.url, connection.token);
    } catch {
      reportFailure();
      scheduleReconnect();
      return;
    }
    socket = target;
    connectTimer = schedule(() => {
      connectTimer = null;
      disconnect(target, "Evener AppWire socket open timed out");
    }, requestTimeoutMs);
    connectTimer.unref();
    target.onmessage = (event) => handleMessage(target, event);
    target.onerror = () => disconnect(target, "Evener AppWire socket error");
    target.onclose = () => disconnect(target, "Evener AppWire socket closed");
    target.onopen = () => {
      connectTimer = clearTimer(connectTimer);
      void initialize(target).catch(() => disconnect(target, "Evener AppWire initialize failed"));
    };
  }

  return {
    start: () => {
      if (!stopped) {
        return;
      }
      stopped = false;
      connect();
    },
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      connectTimer = clearTimer(connectTimer);
      reconnectTimer = clearTimer(reconnectTimer);
      refreshTimer = clearTimer(refreshTimer);
      const target = socket;
      socket = null;
      subscribed.clear();
      rejectPending("Evener collector stopped");
      try {
        target?.close();
      } catch {
        target?.terminate?.();
      }
    },
  };
};
