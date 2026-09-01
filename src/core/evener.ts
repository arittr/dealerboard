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
export const EVENER_MAX_LIST_PAGES = 16;
export const EVENER_MAX_LIST_ITEMS = 4_096;

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

export type EvenerHubEndpoints = Readonly<{
  appWireUrl: string;
  browserOrigin: string;
}>;

type EvenerHubSettings = Readonly<{
  endpoints: EvenerHubEndpoints;
  stateRoot: string;
}>;

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

const wireIdentity = (value: unknown): string | null => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  if (Array.from(value).length > MAX_WIRE_STRING_CODE_POINTS || /[\u0000-\u001f\u007f]/u.test(value)) {
    return null;
  }
  return value;
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

/** Turn an Evener hub address into token-free AppWire and browser endpoints. */
export const evenerHubEndpoints = (rawAddress: string): EvenerHubEndpoints | null => {
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
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return null;
  }
  if (parsed.hostname === "0.0.0.0" || parsed.hostname === "::" || parsed.hostname === "[::]") {
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
  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "ws:" &&
    parsed.protocol !== "wss:"
  ) {
    return null;
  }
  const browser = new URL(parsed.toString());
  if (browser.protocol === "ws:") {
    browser.protocol = "http:";
  } else if (browser.protocol === "wss:") {
    browser.protocol = "https:";
  }
  browser.pathname = "/";
  browser.search = "";
  browser.hash = "";
  const appWire = new URL(browser.toString());
  appWire.protocol = browser.protocol === "https:" ? "wss:" : "ws:";
  appWire.pathname = "/rpc";
  return { appWireUrl: appWire.toString(), browserOrigin: browser.origin };
};

export const evenerAppWireUrl = (rawAddress: string): string | null =>
  evenerHubEndpoints(rawAddress)?.appWireUrl ?? null;

const resolveEvenerHubSettings = (dependencies: EvenerHubConfigDependencies): EvenerHubSettings | null => {
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
  const endpoints = evenerHubEndpoints(address);
  return endpoints === null ? null : { endpoints, stateRoot };
};

export const resolveEvenerHubEndpoints = (dependencies: EvenerHubConfigDependencies): EvenerHubEndpoints | null =>
  resolveEvenerHubSettings(dependencies)?.endpoints ?? null;

const hasUnpairedSurrogate = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = text.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
};

const validSessionId = (sessionId: string): boolean =>
  sessionId.length > 0 &&
  sessionId === sessionId.trim() &&
  Array.from(sessionId).length <= MAX_WIRE_STRING_CODE_POINTS &&
  !hasUnpairedSurrogate(sessionId) &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Control characters are explicitly rejected by the wire contract.
  !/[\u0000-\u001f\u007f]/u.test(sessionId);

export const evenerSessionUrl = (endpoints: EvenerHubEndpoints, sessionId: string): string | null => {
  if (!validSessionId(sessionId)) {
    return null;
  }
  const url = new URL(endpoints.browserOrigin);
  url.pathname = `/s/${encodeURIComponent(`local:${sessionId}`)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

/** Resolve the same address, state root, and bearer-token precedence Evener's TUI uses. */
export const resolveEvenerHubConnection = (dependencies: EvenerHubConfigDependencies): EvenerHubConnection | null => {
  const settings = resolveEvenerHubSettings(dependencies);
  if (settings === null) {
    return null;
  }
  const readText = dependencies.readText ?? defaultReadText;
  const environmentToken = safeToken(dependencies.environment["EVENER_HUB_AUTH_TOKEN"] ?? null);
  const token = environmentToken ?? safeToken(readText(join(settings.stateRoot, "auth-token")));
  return token === null ? null : { url: settings.endpoints.appWireUrl, token };
};

export type EvenerCollectorUpdate = {
  events: RegistryEvent[];
  activeChildSessionIds: readonly string[] | null;
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
  maxListPages?: number;
  maxListItems?: number;
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
  delegateId: string | null;
  parentSessionId: string | null;
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

type EvenerDelegateInfo = Readonly<{
  delegateId: string;
  ownerSessionId: string;
  rootSessionId: string;
  childSessionId: string;
  parentDelegateId: string | null;
  lifecycle: string;
  phase: string;
  status: string;
  terminal: boolean;
  resumable: boolean;
  needsAttention: boolean;
  model: string | null;
  projectionRevision: number;
}>;

type EvenerCollectorIndices = {
  statesBySessionId: Map<string, EvenerThreadState>;
  sessionIdsByRef: Map<string, Set<string>>;
  delegatesById: Map<string, EvenerDelegateInfo>;
  delegateByChildSession: Map<string, string>;
  subscribedSessionIds: Set<string>;
};

const emptyIndices = (): EvenerCollectorIndices => ({
  statesBySessionId: new Map(),
  sessionIdsByRef: new Map(),
  delegatesById: new Map(),
  delegateByChildSession: new Map(),
  subscribedSessionIds: new Set(),
});

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: EvenerTimer;
};

class EvenerCandidateRejected extends Error {}

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

const optionalWireIdentity = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return wireIdentity(value);
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
  const ref = wireIdentity(evener["ref"]);
  const sessionId = wireIdentity(value["sessionId"]);
  const source = nonEmptyString(value["source"]);
  if (source !== LOCAL_SOURCE_ID || ref === null || !ref.startsWith(`${LOCAL_SOURCE_ID}:`) || sessionId === null) {
    return null;
  }
  const rawStatus = parseStatus(value["status"]);
  if (rawStatus === null) {
    throw new EvenerCandidateRejected("invalid Evener thread status");
  }
  const kindValue = optionalWireIdentity(evener["kind"]);
  const parentRefValue = optionalWireIdentity(evener["parentRef"]);
  if (
    (evener["kind"] !== undefined && evener["kind"] !== null && kindValue === null) ||
    (evener["parentRef"] !== undefined && evener["parentRef"] !== null && parentRefValue === null)
  ) {
    return null;
  }
  if (parentRefValue !== null && !parentRefValue.startsWith(`${LOCAL_SOURCE_ID}:`)) {
    return null;
  }
  return {
    ref,
    sessionId,
    parentRef: parentRefValue,
    delegateId: previous?.delegateId ?? null,
    parentSessionId: null,
    kind: kindValue,
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

const isChild = (state: EvenerThreadState): boolean =>
  state.delegateId !== null || state.kind === "subagent" || state.parentRef !== null;

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

const delegateImmutableFields = ["ownerSessionId", "rootSessionId", "parentDelegateId"] as const;
const delegateTrackedFields = [
  "childSessionId",
  "lifecycle",
  "phase",
  "status",
  "terminal",
  "resumable",
  "needsAttention",
  "model",
] as const;

const delegateProjectionEqual = (left: EvenerDelegateInfo, right: EvenerDelegateInfo): boolean =>
  delegateImmutableFields.every((field) => left[field] === right[field]) &&
  delegateTrackedFields.every((field) => left[field] === right[field]) &&
  left.projectionRevision === right.projectionRevision;

const parseRequiredDelegateIdentity = (value: unknown, field: string): string => {
  const identity = wireIdentity(value);
  if (identity === null) {
    throw new EvenerCandidateRejected(`invalid Evener delegate ${field}`);
  }
  return identity;
};

const parseDelegateProjection = (value: unknown): EvenerDelegateInfo => {
  if (!isRecord(value)) {
    throw new EvenerCandidateRejected("invalid Evener delegate projection");
  }
  const parentDelegateValue = value["parentDelegateId"];
  const parentDelegateId =
    parentDelegateValue === null || parentDelegateValue === undefined
      ? null
      : parseRequiredDelegateIdentity(parentDelegateValue, "parentDelegateId");
  const lifecycle = parseRequiredDelegateIdentity(value["lifecycle"], "lifecycle");
  const phase = parseRequiredDelegateIdentity(value["phase"], "phase");
  const status = parseRequiredDelegateIdentity(value["status"], "status");
  const modelValue = value["model"];
  const model = modelValue === null ? null : parseRequiredDelegateIdentity(modelValue, "model");
  const projectionRevision = value["projectionRevision"];
  if (
    typeof projectionRevision !== "number" ||
    !Number.isSafeInteger(projectionRevision) ||
    projectionRevision < 0
  ) {
    throw new EvenerCandidateRejected("invalid Evener delegate projection revision");
  }
  const booleanFields = ["terminal", "resumable", "needsAttention"] as const;
  for (const field of booleanFields) {
    if (typeof value[field] !== "boolean") {
      throw new EvenerCandidateRejected(`invalid Evener delegate ${field}`);
    }
  }
  return {
    delegateId: parseRequiredDelegateIdentity(value["delegateId"], "delegateId"),
    ownerSessionId: parseRequiredDelegateIdentity(value["ownerSessionId"], "ownerSessionId"),
    rootSessionId: parseRequiredDelegateIdentity(value["rootSessionId"], "rootSessionId"),
    childSessionId: parseRequiredDelegateIdentity(value["childSessionId"], "childSessionId"),
    parentDelegateId,
    lifecycle,
    phase,
    status,
    terminal: value["terminal"] as boolean,
    resumable: value["resumable"] as boolean,
    needsAttention: value["needsAttention"] as boolean,
    model,
    projectionRevision,
  };
};

const delegateProjectionsFromThread = (value: unknown): EvenerDelegateInfo[] => {
  if (!isRecord(value) || !isRecord(value["evener"])) {
    return [];
  }
  const evener = value["evener"];
  if (!isRecord(evener["diagnostics"])) {
    return [];
  }
  const diagnostics = evener["diagnostics"];
  const delegates = diagnostics["delegates"];
  if (delegates === undefined) {
    return [];
  }
  if (!Array.isArray(delegates)) {
    throw new EvenerCandidateRejected("invalid Evener delegate diagnostics");
  }
  return delegates.map(parseDelegateProjection);
};

const mergeDelegateProjections = (
  candidate: EvenerCollectorIndices,
  projections: readonly EvenerDelegateInfo[],
): void => {
  const byId = new Map<string, EvenerDelegateInfo[]>();
  for (const projection of projections) {
    const entries = byId.get(projection.delegateId) ?? [];
    entries.push(projection);
    byId.set(projection.delegateId, entries);
  }

  for (const delegateId of Array.from(byId.keys()).sort()) {
    const entries = byId.get(delegateId)!;
    const first = entries[0]!;
    for (const entry of entries.slice(1)) {
      if (!delegateImmutableFields.every((field) => entry[field] === first[field])) {
        throw new EvenerCandidateRejected("contradictory Evener delegate identity");
      }
    }
    const highestRevision = Math.max(...entries.map((entry) => entry.projectionRevision));
    const highest = entries.filter((entry) => entry.projectionRevision === highestRevision);
    const selected = highest[0]!;
    if (!highest.every((entry) => delegateProjectionEqual(entry, selected))) {
      throw new EvenerCandidateRejected("contradictory Evener delegate projection");
    }
    candidate.delegatesById.set(delegateId, selected);
  }

  for (const delegate of candidate.delegatesById.values()) {
    const existing = candidate.delegateByChildSession.get(delegate.childSessionId);
    if (existing !== undefined && existing !== delegate.delegateId) {
      throw new EvenerCandidateRejected("duplicate Evener delegate child session");
    }
    candidate.delegateByChildSession.set(delegate.childSessionId, delegate.delegateId);
  }
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
  const maxListPages = dependencies.maxListPages ?? EVENER_MAX_LIST_PAGES;
  const maxListItems = dependencies.maxListItems ?? EVENER_MAX_LIST_ITEMS;

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
  let indices = emptyIndices();
  let refreshInvalidatedSessionIds: Set<string> | null = null;

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

  const emitUpdate = (update: EvenerCollectorUpdate): void => {
    if (update.events.length === 0 && update.activeChildSessionIds === null) {
      return;
    }
    try {
      dependencies.onUpdate(update);
    } catch {
      reportFailure();
    }
  };

  const emitIncremental = (events: RegistryEvent[]): void =>
    emitUpdate({ events, activeChildSessionIds: null });

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
    indices.subscribedSessionIds.clear();
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

  const rootParent = (candidate: EvenerCollectorIndices, state: EvenerThreadState): EvenerThreadState | null => {
    if (state.parentSessionId === null) {
      return null;
    }
    return candidate.statesBySessionId.get(state.parentSessionId) ?? null;
  };

  const hydrateState = (
    candidate: EvenerCollectorIndices,
    state: EvenerThreadState,
    liveStart: boolean,
    observedAt: string,
  ): RegistryEvent[] => {
    if (state.rawStatus === "closed" || state.rawStatus === "notLoaded") {
      state.registered = false;
      return [endEvent(state, observedAt)];
    }
    if (isChild(state)) {
      const parent = rootParent(candidate, state);
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

  const addSessionToRef = (candidate: EvenerCollectorIndices, state: EvenerThreadState): void => {
    const sessionIds = candidate.sessionIdsByRef.get(state.ref) ?? new Set<string>();
    sessionIds.add(state.sessionId);
    candidate.sessionIdsByRef.set(state.ref, sessionIds);
  };

  const removeSessionFromRef = (candidate: EvenerCollectorIndices, state: EvenerThreadState): void => {
    const sessionIds = candidate.sessionIdsByRef.get(state.ref);
    if (sessionIds === undefined) {
      return;
    }
    sessionIds.delete(state.sessionId);
    if (sessionIds.size === 0) {
      candidate.sessionIdsByRef.delete(state.ref);
    }
  };

  const resolveParentRefs = (candidate: EvenerCollectorIndices, rejectUnresolved = false): void => {
    for (const state of candidate.statesBySessionId.values()) {
      state.delegateId = null;
      state.parentSessionId = null;
    }
    for (const delegate of candidate.delegatesById.values()) {
      if (
        !candidate.statesBySessionId.has(delegate.ownerSessionId) ||
        !candidate.statesBySessionId.has(delegate.rootSessionId) ||
        !candidate.statesBySessionId.has(delegate.childSessionId)
      ) {
        throw new EvenerCandidateRejected("Evener delegate refers to a missing session");
      }
      if (delegate.parentDelegateId !== null && !candidate.delegatesById.has(delegate.parentDelegateId)) {
        throw new EvenerCandidateRejected("Evener delegate refers to a missing parent delegate");
      }
      const state = candidate.statesBySessionId.get(delegate.childSessionId)!;
      state.delegateId = delegate.delegateId;
      state.parentSessionId =
        delegate.parentDelegateId === null
          ? delegate.ownerSessionId
          : candidate.delegatesById.get(delegate.parentDelegateId)!.childSessionId;
    }
    for (const state of candidate.statesBySessionId.values()) {
      if (state.delegateId !== null) {
        continue;
      }
      if (state.parentRef === null) {
        if (rejectUnresolved && isChild(state)) {
          throw new EvenerCandidateRejected("unresolved Evener parent");
        }
        continue;
      }
      const parentIds = candidate.sessionIdsByRef.get(state.parentRef);
      if (parentIds !== undefined && parentIds.size > 1) {
        throw new EvenerCandidateRejected("ambiguous Evener parent ref");
      }
      const parentId = parentIds?.values().next().value;
      if (typeof parentId !== "string") {
        if (rejectUnresolved) {
          throw new EvenerCandidateRejected("unresolved Evener parent ref");
        }
        continue;
      }
      state.parentSessionId = parentId;
    }
    for (const state of candidate.statesBySessionId.values()) {
      if (state.parentSessionId === null) {
        continue;
      }
      const visited = new Set<string>();
      let parentSessionId: string | null = state.parentSessionId;
      while (parentSessionId !== null) {
        if (parentSessionId === state.sessionId || !visited.add(parentSessionId)) {
          throw new EvenerCandidateRejected("cyclic Evener delegate lineage");
        }
        parentSessionId = candidate.statesBySessionId.get(parentSessionId)?.parentSessionId ?? null;
      }
    }
  };

  const deriveCandidateEvents = (candidate: EvenerCollectorIndices, liveStart: boolean): RegistryEvent[] => {
    resolveParentRefs(candidate, true);
    const observedAt = now();
    const parsed: EvenerThreadState[] = [];
    const events: RegistryEvent[] = [];
    for (const state of candidate.statesBySessionId.values()) {
      if (isChild(state)) {
        parsed.push(state);
      } else {
        events.push(...hydrateState(candidate, state, liveStart, observedAt));
      }
    }
    const pendingChildren = parsed;
    let progressed = true;
    while (pendingChildren.length > 0 && progressed) {
      progressed = false;
      for (let index = pendingChildren.length - 1; index >= 0; index -= 1) {
        const state = pendingChildren[index];
        if (state === undefined) {
          continue;
        }
        const parent = rootParent(candidate, state);
        if (parent === null || !parent.registered) {
          continue;
        }
        events.push(...hydrateState(candidate, state, liveStart, observedAt));
        pendingChildren.splice(index, 1);
        progressed = true;
      }
    }
    return events;
  };

  const hydrateLiveThread = (value: unknown, liveStart: boolean): EvenerThreadState | null => {
    if (!isRecord(value)) {
      throw new Error("invalid Evener thread/list item");
    }
    const source = nonEmptyString(value["source"]);
    if (source !== LOCAL_SOURCE_ID) {
      return null;
    }
    const previous = wireIdentity(value["sessionId"]) === null
      ? undefined
      : indices.statesBySessionId.get(wireIdentity(value["sessionId"])!);
    const state = parseThread(value, previous);
    if (state === null) {
      throw new EvenerCandidateRejected("invalid local Evener thread");
    }
    const old = indices.statesBySessionId.get(state.sessionId);
    if (old !== undefined) {
      removeSessionFromRef(indices, old);
    }
    indices.statesBySessionId.set(state.sessionId, state);
    addSessionToRef(indices, state);
    resolveParentRefs(indices);
    const events = hydrateState(indices, state, liveStart, now());
    emitIncremental(events);
    return state;
  };

  const subscribeLive = async (target: EvenerSocket, state: EvenerThreadState): Promise<void> => {
    if (indices.subscribedSessionIds.has(state.sessionId) || state.rawStatus === "closed" || state.rawStatus === "notLoaded") {
      return;
    }
    const replaceSubscription = indices.subscribedSessionIds.size === 0;
    const result = await request(target, "thread/read", {
      ref: state.ref,
      threadId: state.sessionId,
      includeTurns: false,
      subscribe: true,
      replaceSubscription,
    });
    if (!isRecord(result) || !("thread" in result)) {
      throw new Error("invalid Evener thread/read response");
    }
    const readState = parseThread(result["thread"], state);
    if (readState === null || readState.sessionId !== state.sessionId || readState.ref !== state.ref) {
      throw new Error("invalid Evener thread/read identity");
    }
    removeSessionFromRef(indices, state);
    indices.statesBySessionId.set(state.sessionId, readState);
    addSessionToRef(indices, readState);
    resolveParentRefs(indices);
    indices.subscribedSessionIds.add(state.sessionId);
    emitIncremental(hydrateState(indices, readState, false, now()));
  };

  const listThreads = async (target: EvenerSocket): Promise<unknown[]> => {
    const values: unknown[] = [];
    let cursor: string | null = null;
    let pageCount = 0;
    const seenCursors = new Set<string>();
    for (;;) {
      if (pageCount >= maxListPages) {
        throw new Error("Evener thread/list exceeded its page limit");
      }
      const result = await request(target, "thread/list", {
        statuses: [...THREAD_STATUSES],
        sourceIds: [LOCAL_SOURCE_ID],
        includeSubagents: true,
        ...(cursor === null ? {} : { cursor }),
      });
      if (!isRecord(result) || !Array.isArray(result["data"])) {
        throw new Error("invalid Evener thread/list response");
      }
      pageCount += 1;
      if (values.length + result["data"].length > maxListItems) {
        throw new Error("Evener thread/list exceeded its item limit");
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
    return values;
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
    refreshInvalidatedSessionIds = new Set<string>();
    try {
      const candidate = emptyIndices();
      const delegateProjections: EvenerDelegateInfo[] = [];
      const values = await listThreads(target);
      for (const value of values) {
        if (!isRecord(value)) {
          throw new Error("invalid Evener thread/list item");
        }
        const source = nonEmptyString(value["source"]);
        if (source !== LOCAL_SOURCE_ID) {
          continue;
        }
        const sessionId = wireIdentity(value["sessionId"]);
        const previous = sessionId === null ? undefined : indices.statesBySessionId.get(sessionId);
        const state = parseThread(value, previous);
        if (state === null) {
          throw new EvenerCandidateRejected("invalid local Evener thread");
        }
        if (candidate.statesBySessionId.has(state.sessionId)) {
          throw new EvenerCandidateRejected("duplicate Evener thread session ID");
        }
        candidate.statesBySessionId.set(state.sessionId, state);
        addSessionToRef(candidate, state);
      }

      for (const listed of candidate.statesBySessionId.values()) {
        if (listed.rawStatus === "closed" || listed.rawStatus === "notLoaded") {
          continue;
        }
        const result = await request(target, "thread/read", {
          ref: listed.ref,
          threadId: listed.sessionId,
          includeTurns: false,
          subscribe: true,
          replaceSubscription: candidate.subscribedSessionIds.size === 0,
        });
        if (!isRecord(result) || !("thread" in result)) {
          throw new Error("invalid Evener thread/read response");
        }
        const state = parseThread(result["thread"], listed);
        if (state === null || state.sessionId !== listed.sessionId || state.ref !== listed.ref) {
          throw new EvenerCandidateRejected("invalid Evener thread/read identity");
        }
        delegateProjections.push(...delegateProjectionsFromThread(result["thread"]));
        candidate.statesBySessionId.set(listed.sessionId, state);
        candidate.subscribedSessionIds.add(listed.sessionId);
        if (refreshInvalidatedSessionIds.has(listed.sessionId)) {
          throw new EvenerCandidateRejected("Evener refresh candidate was invalidated");
        }
      }
      mergeDelegateProjections(candidate, delegateProjections);
      const events = deriveCandidateEvents(candidate, false);
      const activeChildSessionIds = Array.from(candidate.statesBySessionId.values())
        .filter(
          (state) =>
            isChild(state) &&
            state.registered &&
            state.rawStatus !== "closed" &&
            state.rawStatus !== "notLoaded" &&
            effectiveStatus(state) !== "idle",
        )
        .map((state) => state.sessionId)
        .sort();
      if (refreshInvalidatedSessionIds.size > 0) {
        throw new EvenerCandidateRejected("Evener refresh candidate was invalidated");
      }
      indices = candidate;
      emitUpdate({ events, activeChildSessionIds });
      failureReported = false;
    } catch (error) {
      if (error instanceof EvenerCandidateRejected) {
        reportFailure();
        scheduleRefresh(0);
        return;
      }
      disconnect(target, "Evener AppWire refresh failed");
      return;
    } finally {
      refreshInvalidatedSessionIds = null;
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
    if ("threadId" in params) {
      const sessionId = wireIdentity(params["threadId"]);
      return sessionId === null ? null : (indices.statesBySessionId.get(sessionId) ?? null);
    }
    const ref = wireIdentity(params["ref"]);
    if (ref === null) {
      return null;
    }
    const sessionIds = indices.sessionIdsByRef.get(ref);
    if (sessionIds?.size !== 1) {
      return null;
    }
    const sessionId = sessionIds.values().next().value;
    return sessionId === undefined ? null : (indices.statesBySessionId.get(sessionId) ?? null);
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
        emitIncremental(events);
        return;
      }
      if (!state.registered) {
        emitIncremental(hydrateState(indices, state, true, observedAt));
        return;
      }
    }
    if (rawStatus === "closed" || rawStatus === "notLoaded") {
      emitIncremental([endEvent(state, observedAt)]);
      removeSessionFromRef(indices, state);
      indices.statesBySessionId.delete(state.sessionId);
      indices.subscribedSessionIds.delete(state.sessionId);
      return;
    }
    emitIncremental([liveStatusEvent(state, previousStatus, observedAt)]);
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
      emitIncremental(hydrateState(indices, state, true, observedAt));
      return;
    }
    emitIncremental([{ kind: "Activity", provider: "evener", sessionId: state.sessionId, observedAt }]);
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
      emitIncremental(events);
      return;
    }
    if (turnStatus === "failed") {
      state.failedTurn = true;
      state.rawStatus = "idle";
      emitIncremental([{ kind: "StopFailure", provider: "evener", sessionId: state.sessionId, observedAt }]);
    } else if (turnStatus === "completed" || turnStatus === "interrupted") {
      state.failedTurn = false;
      const events: RegistryEvent[] = [{ kind: "Stop", provider: "evener", sessionId: state.sessionId, observedAt }];
      if (turnStatus === "completed" && requiresAttention(state)) {
        events.push({ kind: "Attention", provider: "evener", sessionId: state.sessionId, observedAt });
      }
      emitIncremental(events);
    }
  };

  const handleStarted = (params: Record<string, unknown>): void => {
    if (!("thread" in params)) {
      scheduleRefresh(0);
      return;
    }
    hydrateLiveThread(params["thread"], true);
    const state = stateForParams(params);
    if (state !== null && socket !== null) {
      void subscribeLive(socket, state).catch(() => scheduleRefresh(0));
    } else {
      scheduleRefresh(0);
    }
  };

  const handleClosed = (params: Record<string, unknown>): void => {
    const notifiedSessionId = wireIdentity(params["threadId"]);
    if (notifiedSessionId !== null) {
      refreshInvalidatedSessionIds?.add(notifiedSessionId);
    }
    const state = stateForParams(params);
    if (state === null) {
      return;
    }
    const sessionId = state.sessionId;
    refreshInvalidatedSessionIds?.add(sessionId);
    const observedAt = now();
    emitIncremental([endEvent(state, observedAt)]);
    const closing = new Set<string>([sessionId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of indices.statesBySessionId.values()) {
        if (
          candidate.parentSessionId !== null &&
          closing.has(candidate.parentSessionId) &&
          !closing.has(candidate.sessionId)
        ) {
          closing.add(candidate.sessionId);
          changed = true;
        }
      }
    }
    for (const closingSessionId of closing) {
      const closingState = indices.statesBySessionId.get(closingSessionId);
      if (closingState !== undefined) {
        removeSessionFromRef(indices, closingState);
        indices.statesBySessionId.delete(closingSessionId);
        indices.subscribedSessionIds.delete(closingSessionId);
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
      emitIncremental([event]);
    }
  };

  const handleModelChanged = (params: Record<string, unknown>): void => {
    const state = stateForParams(params);
    const model = boundedString(params["model"]);
    if (state === null || model === null) {
      return;
    }
    state.model = model;
    emitIncremental([
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
          emitIncremental([{ kind: "Attention", provider: "evener", sessionId: state.sessionId, observedAt: now() }]);
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
      clientInfo: { name: "dealerboard", version: "1" },
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
      indices.subscribedSessionIds.clear();
      rejectPending("Evener collector stopped");
      try {
        target?.close();
      } catch {
        target?.terminate?.();
      }
    },
  };
};
