/**
 * Shared contracts for the hook-driven session registry.
 *
 * This module is imported by both the Bun core and the Node.js Stream Deck
 * plugin bundle, so it must stay free of runtime-specific and SDK imports.
 */

export const PROVIDER_KEYS = ["claude", "codex", "kimi", "pi", "omp", "zcode", "deepseek"] as const;

export type Provider = (typeof PROVIDER_KEYS)[number];

export type SessionStatus = "idle" | "working" | "waiting" | "error";

/** Who spawned a session: a paseo agent or an interactive terminal. */
export type SessionOriginKind = "paseo" | "terminal";

export type SessionOrigin = { kind: SessionOriginKind; ref: string };

export type RegistryEvent =
  | {
      kind: "SessionStart";
      provider: Provider;
      sessionId: string;
      title: string | null;
      project: string | null;
      ghosttyTerminalId: string | null;
      transcriptPath: string | null;
      /** Origin evidence at spawn; absent/null means no new evidence. */
      origin?: SessionOrigin | null;
      observedAt: string;
    }
  | {
      kind: "SessionObserved";
      provider: Provider;
      sessionId: string;
      title: string | null;
      project: string | null;
      transcriptPath: string | null;
      /** Origin evidence carried by a late join; absent/null means no new evidence. */
      origin?: SessionOrigin | null;
      observedAt: string;
    }
  | {
      kind: "SessionTitleChanged";
      provider: Provider;
      sessionId: string;
      /** Non-empty; the decoder bounds it to 256 code points like every string. */
      title: string;
      observedAt: string;
    }
  | {
      kind: "Activity" | "Attention" | "Stop" | "StopFailure" | "BackgroundWorkStarted" | "BackgroundWorkCleared";
      provider: Provider;
      sessionId: string;
      observedAt: string;
    }
  | { kind: "SessionEnd"; provider: Provider; sessionId: string; observedAt: string }
  | {
      kind: "SubagentStart";
      provider: Provider;
      sessionId: string;
      parentSessionId: string;
      title: string | null;
      project: string | null;
      observedAt: string;
    }
  | { kind: "SubagentStop"; provider: Provider; sessionId: string; observedAt: string };

export type ProjectedSession = {
  provider: Provider;
  sessionId: string;
  status: SessionStatus;
  title: string | null;
  project: string | null;
  descendantCount: number;
  logicalSlot: number;
  ghosttyTerminalId: string | null;
  originKind: SessionOriginKind | null;
  originRef: string | null;
  originSubagent: boolean;
};

export type SnapshotHealth = {
  status: "ok" | "error";
  message?: string;
};

export type SessionSnapshotV2 = {
  schemaVersion: 2;
  health: SnapshotHealth;
  sessions: ProjectedSession[];
};

const MAX_STRING_CODE_POINTS = 256;

const PROVIDERS: ReadonlySet<string> = new Set(PROVIDER_KEYS);
const SESSION_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "waiting", "error"]);
const ORIGIN_KINDS: ReadonlySet<string> = new Set(["paseo", "terminal"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBoundedString = (value: unknown): value is string =>
  typeof value === "string" && Array.from(value).length <= MAX_STRING_CODE_POINTS;

const isNullableBoundedString = (value: unknown): value is string | null => value === null || isBoundedString(value);

const isNullableNonEmptyBoundedString = (value: unknown): value is string | null =>
  value === null || (isBoundedString(value) && Array.from(value).length > 0);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const invalid = (reason: string): never => {
  throw new Error(`invalid session snapshot: ${reason}`);
};

const parseHealth = (value: unknown): SnapshotHealth => {
  if (!isRecord(value)) {
    return invalid("health must be an object");
  }
  if (value["status"] !== "ok" && value["status"] !== "error") {
    return invalid("health.status must be ok or error");
  }
  if ("message" in value && !isBoundedString(value["message"])) {
    return invalid("health.message must be a bounded string");
  }
  const health: SnapshotHealth = { status: value["status"] };
  if ("message" in value) {
    health.message = value["message"] as string;
  }
  return health;
};

const parseSession = (value: unknown): ProjectedSession => {
  if (!isRecord(value)) {
    return invalid("session must be an object");
  }
  if (typeof value["provider"] !== "string" || !PROVIDERS.has(value["provider"])) {
    return invalid("session.provider is not a known provider");
  }
  if (!isBoundedString(value["sessionId"])) {
    return invalid("session.sessionId must be a bounded string");
  }
  if (typeof value["status"] !== "string" || !SESSION_STATUSES.has(value["status"])) {
    return invalid("session.status is not a known status");
  }
  if (!isNullableBoundedString(value["title"])) {
    return invalid("session.title must be null or a bounded string");
  }
  if (!isNullableBoundedString(value["project"])) {
    return invalid("session.project must be null or a bounded string");
  }
  if (!isNonNegativeInteger(value["descendantCount"])) {
    return invalid("session.descendantCount must be a non-negative integer");
  }
  if (!isPositiveInteger(value["logicalSlot"])) {
    return invalid("session.logicalSlot must be a positive integer");
  }
  if (!isNullableNonEmptyBoundedString(value["ghosttyTerminalId"])) {
    return invalid("session.ghosttyTerminalId must be null or a non-empty bounded string");
  }
  if (value["ghosttyTerminalId"] !== null && value["provider"] !== "claude") {
    return invalid("session.ghosttyTerminalId is only valid for Claude");
  }
  // Origin fields are validated when present and defaulted when absent, so
  // an older daemon's snapshot (which predates them) still parses.
  if (value["originKind"] !== undefined && value["originKind"] !== null) {
    if (typeof value["originKind"] !== "string" || !ORIGIN_KINDS.has(value["originKind"])) {
      return invalid("session.originKind must be paseo, terminal, or null");
    }
  }
  if (value["originRef"] !== undefined && !isNullableBoundedString(value["originRef"])) {
    return invalid("session.originRef must be null or a bounded string");
  }
  if (value["originSubagent"] !== undefined && typeof value["originSubagent"] !== "boolean") {
    return invalid("session.originSubagent must be a boolean");
  }
  return {
    provider: value["provider"] as Provider,
    sessionId: value["sessionId"],
    status: value["status"] as SessionStatus,
    title: value["title"],
    project: value["project"],
    descendantCount: value["descendantCount"],
    logicalSlot: value["logicalSlot"],
    ghosttyTerminalId: value["ghosttyTerminalId"],
    originKind: value["originKind"] === undefined ? null : (value["originKind"] as SessionOriginKind | null),
    originRef: value["originRef"] === undefined ? null : (value["originRef"] as string | null),
    originSubagent: value["originSubagent"] === undefined ? false : (value["originSubagent"] as boolean),
  };
};

/**
 * Validate an unknown value as a v2 session snapshot, returning a newly
 * constructed snapshot. Throws on any contract violation; no coercion.
 */
export const parseSessionSnapshot = (value: unknown): SessionSnapshotV2 => {
  if (!isRecord(value)) {
    return invalid("snapshot must be an object");
  }
  if (value["schemaVersion"] !== 2) {
    return invalid("schemaVersion must be 2");
  }
  if (!Array.isArray(value["sessions"])) {
    return invalid("sessions must be an array");
  }
  const sessions = value["sessions"].map(parseSession);
  const seenSlots = new Set<number>();
  for (const session of sessions) {
    if (seenSlots.has(session.logicalSlot)) {
      return invalid(`duplicate logicalSlot ${session.logicalSlot}`);
    }
    seenSlots.add(session.logicalSlot);
  }
  return {
    schemaVersion: 2,
    health: parseHealth(value["health"]),
    sessions,
  };
};
