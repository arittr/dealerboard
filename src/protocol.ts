/**
 * Shared contracts for the hook-driven session registry.
 *
 * This module is imported by both the Bun core and the Node.js Stream Deck
 * plugin bundle, so it must stay free of runtime-specific and SDK imports.
 */

export const PROVIDER_KEYS = [
  "claude",
  "codex",
  "kimi",
  "pi",
  "omp",
  "zcode",
  "deepseek",
  "grok",
  "qwen",
  "evener",
] as const;

export type Provider = (typeof PROVIDER_KEYS)[number];

export type SessionStatus = "idle" | "working" | "waiting" | "error";

/** Who spawned a session: a paseo agent, an interactive terminal, or the roborev review daemon. */
export type SessionOriginKind = "paseo" | "terminal" | "roborev";

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
      /** Raw provider-reported model id; null when the provider did not report one. */
      model: string | null;
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
      /** Raw provider-reported model id; null when the provider did not report one. */
      model: string | null;
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
      kind: "SessionModelChanged";
      provider: Provider;
      sessionId: string;
      model: string;
      observedAt: string;
    }
  | {
      /** Authoritative hydration/reconnect status; unlike a terminal event, this never changes unread state. */
      kind: "SessionStatusObserved";
      provider: Provider;
      sessionId: string;
      status: SessionStatus;
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
      model: string | null;
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
  model: string | null;
  originKind: SessionOriginKind | null;
  originRef: string | null;
  originSubagent: boolean;
  /** ISO-8601 UTC when the latest unviewed result landed; null when nothing is unread. */
  unreadSince: string | null;
  /** ISO-8601 UTC when the latest undismissed result landed; null once dismissed or while none. */
  doneSince: string | null;
  /** ISO-8601 UTC of the row's own last status change (subtree lifts never restamp); null when never stamped. */
  statusSince: string | null;
  /** The last tool call as "Tool target" (≤64 code points; claude/codex only); null otherwise. */
  activityLine: string | null;
  /** The provider transcript path when the registry knows it; null otherwise. */
  transcriptPath: string | null;
  /** The dispatching Paseo agent's id for a paseo subagent; null otherwise. */
  originParentRef: string | null;
  /** ISO-8601 UTC of the row's last hook event; null when the registry has no stamp. */
  lastEventAt: string | null;
};

export type AgentIdentity = {
  provider: Provider;
  sessionId: string;
};

export type ProjectedAgentNode = {
  provider: Provider;
  sessionId: string;
  role: "primary" | "subagent";
  lineage: "native" | "paseo" | null;
  parent: AgentIdentity | null;
  status: SessionStatus;
  title: string | null;
  project: string | null;
  model: string | null;
  openedAt: string;
  statusSince: string | null;
  activityLine: string | null;
  unreadSince: string | null;
  /** ISO-8601 UTC when the latest undismissed result landed; null once dismissed or while none. */
  doneSince: string | null;
  logicalSlot: number | null;
  ghosttyTerminalId: string | null;
  transcriptPath: string | null;
  originKind: SessionOriginKind | null;
  originRef: string | null;
  originSubagent: boolean;
  originParentRef: string | null;
  /** ISO-8601 UTC of the row's last hook event; null when the registry has no stamp. */
  lastEventAt: string | null;
};

export type SnapshotHealth = {
  status: "ok" | "error";
  message?: string;
};

export type SessionSnapshotV2 = {
  schemaVersion: 2;
  health: SnapshotHealth;
  sessions: ProjectedSession[];
  /** Null for snapshots written before the additive agent graph existed. */
  agents: ProjectedAgentNode[] | null;
};

export type SnapshotView = {
  snapshot: SessionSnapshotV2;
  degraded: boolean;
};

const MAX_STRING_CODE_POINTS = 256;

const PROVIDERS: ReadonlySet<string> = new Set(PROVIDER_KEYS);
const SESSION_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "waiting", "error"]);
const ORIGIN_KINDS: ReadonlySet<string> = new Set(["paseo", "terminal", "roborev"]);

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

const isCanonicalUtcInstant = (value: unknown): value is string => {
  if (!isBoundedString(value) || value.length === 0) {
    return false;
  }
  const epoch = Date.parse(value);
  return !Number.isNaN(epoch) && new Date(epoch).toISOString() === value;
};

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

const parseAgentIdentity = (value: unknown, field: string): AgentIdentity => {
  if (!isRecord(value)) {
    return invalid(`${field} must be an object`);
  }
  if (typeof value["provider"] !== "string" || !PROVIDERS.has(value["provider"])) {
    return invalid(`${field}.provider is not a known provider`);
  }
  if (!isBoundedString(value["sessionId"]) || value["sessionId"].length === 0) {
    return invalid(`${field}.sessionId must be a non-empty bounded string`);
  }
  return { provider: value["provider"] as Provider, sessionId: value["sessionId"] };
};

const parseAgent = (value: unknown): ProjectedAgentNode => {
  if (!isRecord(value)) {
    return invalid("agent must be an object");
  }
  const identity = parseAgentIdentity(value, "agent");
  const role = value["role"];
  if (role !== "primary" && role !== "subagent") {
    return invalid("agent.role must be primary or subagent");
  }
  const lineage = value["lineage"];
  if (lineage !== null && lineage !== "native" && lineage !== "paseo") {
    return invalid("agent.lineage must be native, paseo, or null");
  }
  const parent = value["parent"] === null ? null : parseAgentIdentity(value["parent"], "agent.parent");
  const status = value["status"];
  if (typeof status !== "string" || !SESSION_STATUSES.has(status)) {
    return invalid("agent.status is not a known status");
  }
  const title = value["title"];
  if (!isNullableBoundedString(title)) {
    return invalid("agent.title must be null or a bounded string");
  }
  const project = value["project"];
  if (!isNullableBoundedString(project)) {
    return invalid("agent.project must be null or a bounded string");
  }
  const model = value["model"];
  if (!isNullableBoundedString(model)) {
    return invalid("agent.model must be null or a bounded string");
  }
  const openedAt = value["openedAt"];
  if (!isCanonicalUtcInstant(openedAt)) {
    return invalid("agent.openedAt must be a canonical UTC instant");
  }
  const statusSince = value["statusSince"];
  if (!isNullableBoundedString(statusSince)) {
    return invalid("agent.statusSince must be null or a bounded string");
  }
  const activityLine = value["activityLine"];
  if (!isNullableBoundedString(activityLine)) {
    return invalid("agent.activityLine must be null or a bounded string");
  }
  const unreadSince = value["unreadSince"];
  if (!isNullableBoundedString(unreadSince)) {
    return invalid("agent.unreadSince must be null or a bounded string");
  }
  const doneSince = "doneSince" in value ? value["doneSince"] : null;
  if (!isNullableBoundedString(doneSince)) {
    return invalid("agent.doneSince must be null or a bounded string");
  }
  const logicalSlot = value["logicalSlot"];
  if (logicalSlot !== null && (typeof logicalSlot !== "number" || !Number.isInteger(logicalSlot))) {
    return invalid("agent.logicalSlot must be null or an integer");
  }
  const ghosttyTerminalId = value["ghosttyTerminalId"];
  if (!isNullableNonEmptyBoundedString(ghosttyTerminalId)) {
    return invalid("agent.ghosttyTerminalId must be null or a non-empty bounded string");
  }
  const transcriptPath = value["transcriptPath"];
  if (!isNullableBoundedString(transcriptPath)) {
    return invalid("agent.transcriptPath must be null or a bounded string");
  }
  const originKind = value["originKind"];
  if (originKind !== null && (typeof originKind !== "string" || !ORIGIN_KINDS.has(originKind))) {
    return invalid("agent.originKind must be paseo, terminal, roborev, or null");
  }
  const originRef = value["originRef"];
  if (!isNullableBoundedString(originRef)) {
    return invalid("agent.originRef must be null or a bounded string");
  }
  const originSubagent = value["originSubagent"];
  if (typeof originSubagent !== "boolean") {
    return invalid("agent.originSubagent must be a boolean");
  }
  const originParentRef = value["originParentRef"];
  if (!isNullableBoundedString(originParentRef)) {
    return invalid("agent.originParentRef must be null or a bounded string");
  }
  const lastEventAt = "lastEventAt" in value ? value["lastEventAt"] : null;
  if (!isNullableBoundedString(lastEventAt)) {
    return invalid("agent.lastEventAt must be null or a bounded string");
  }

  if (role === "primary") {
    if (lineage !== null || parent !== null || !isPositiveInteger(logicalSlot) || originSubagent) {
      return invalid("agent primary role invariants are invalid");
    }
  } else if (lineage === "native") {
    if (
      parent === null ||
      parent.provider !== identity.provider ||
      logicalSlot !== null ||
      ghosttyTerminalId !== null ||
      transcriptPath !== null ||
      originKind !== null ||
      originRef !== null ||
      originSubagent ||
      originParentRef !== null ||
      unreadSince !== null ||
      doneSince !== null
    ) {
      return invalid("agent native role invariants are invalid");
    }
  } else if (lineage === "paseo") {
    if (!isPositiveInteger(logicalSlot) || originKind !== "paseo" || !originSubagent) {
      return invalid("agent Paseo role invariants are invalid");
    }
  } else {
    return invalid("agent subagent lineage is invalid");
  }
  if (ghosttyTerminalId !== null && identity.provider !== "claude") {
    return invalid("agent.ghosttyTerminalId is only valid for Claude");
  }

  return {
    provider: identity.provider,
    sessionId: identity.sessionId,
    role,
    lineage,
    parent,
    status: status as SessionStatus,
    title,
    project,
    model,
    openedAt,
    statusSince,
    activityLine,
    unreadSince,
    doneSince,
    logicalSlot,
    ghosttyTerminalId,
    transcriptPath,
    originKind: originKind as SessionOriginKind | null,
    originRef,
    originSubagent,
    originParentRef,
    lastEventAt,
  };
};

const agentIdentityKey = (identity: AgentIdentity): string => `${identity.provider}\u0000${identity.sessionId}`;

const parseAgents = (values: unknown[]): ProjectedAgentNode[] => {
  const agents = values.map(parseAgent);
  const byIdentity = new Map<string, ProjectedAgentNode>();
  const seenSlots = new Set<number>();
  for (const agent of agents) {
    const key = agentIdentityKey(agent);
    if (byIdentity.has(key)) {
      return invalid(`duplicate agent identity ${key}`);
    }
    byIdentity.set(key, agent);
    if (agent.logicalSlot !== null) {
      if (seenSlots.has(agent.logicalSlot)) {
        return invalid(`duplicate agent logicalSlot ${agent.logicalSlot}`);
      }
      seenSlots.add(agent.logicalSlot);
    }
  }
  for (const agent of agents) {
    if (agent.parent === null) {
      continue;
    }
    const parent = byIdentity.get(agentIdentityKey(agent.parent));
    if (parent === undefined) {
      return invalid("agent parent does not exist");
    }
    if (agent.lineage === "native" && agent.parent.provider !== agent.provider) {
      return invalid("native agent parent must use the same provider");
    }
    if (agent.lineage === "paseo" && parent.logicalSlot === null) {
      return invalid("Paseo agent parent must be a registry root");
    }
  }
  const done = new Set<string>();
  for (const agent of agents) {
    const path = new Set<string>();
    let current: ProjectedAgentNode | undefined = agent;
    while (current !== undefined) {
      const key = agentIdentityKey(current);
      if (done.has(key)) {
        break;
      }
      if (path.has(key)) {
        return invalid("agent graph must be acyclic");
      }
      path.add(key);
      current = current.parent === null ? undefined : byIdentity.get(agentIdentityKey(current.parent));
    }
    for (const key of path) {
      done.add(key);
    }
  }
  return agents;
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
  // A missing model key is tolerated as null: snapshots written before the
  // field existed stay parseable. A present undefined is an invalid value,
  // not a missing key.
  const model = "model" in value ? value["model"] : null;
  if (!isNullableBoundedString(model)) {
    return invalid("session.model must be null or a bounded string");
  }
  // Origin fields are validated when present and defaulted when absent, so
  // an older daemon's snapshot (which predates them) still parses.
  if (value["originKind"] !== undefined && value["originKind"] !== null) {
    if (typeof value["originKind"] !== "string" || !ORIGIN_KINDS.has(value["originKind"])) {
      return invalid("session.originKind must be paseo, terminal, roborev, or null");
    }
  }
  if (value["originRef"] !== undefined && !isNullableBoundedString(value["originRef"])) {
    return invalid("session.originRef must be null or a bounded string");
  }
  if (value["originSubagent"] !== undefined && typeof value["originSubagent"] !== "boolean") {
    return invalid("session.originSubagent must be a boolean");
  }
  // The data-surface fields follow the model precedent exactly: a missing key
  // is tolerated as null (snapshots written before they existed stay
  // parseable); a present undefined is an invalid value, not a missing key.
  const unreadSince = "unreadSince" in value ? value["unreadSince"] : null;
  if (!isNullableBoundedString(unreadSince)) {
    return invalid("session.unreadSince must be null or a bounded string");
  }
  const statusSince = "statusSince" in value ? value["statusSince"] : null;
  if (!isNullableBoundedString(statusSince)) {
    return invalid("session.statusSince must be null or a bounded string");
  }
  const activityLine = "activityLine" in value ? value["activityLine"] : null;
  if (!isNullableBoundedString(activityLine)) {
    return invalid("session.activityLine must be null or a bounded string");
  }
  const transcriptPath = "transcriptPath" in value ? value["transcriptPath"] : null;
  if (!isNullableBoundedString(transcriptPath)) {
    return invalid("session.transcriptPath must be null or a bounded string");
  }
  const originParentRef = "originParentRef" in value ? value["originParentRef"] : null;
  if (!isNullableBoundedString(originParentRef)) {
    return invalid("session.originParentRef must be null or a bounded string");
  }
  const lastEventAt = "lastEventAt" in value ? value["lastEventAt"] : null;
  if (!isNullableBoundedString(lastEventAt)) {
    return invalid("session.lastEventAt must be null or a bounded string");
  }
  const doneSince = "doneSince" in value ? value["doneSince"] : null;
  if (!isNullableBoundedString(doneSince)) {
    return invalid("session.doneSince must be null or a bounded string");
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
    model,
    originKind: value["originKind"] === undefined ? null : (value["originKind"] as SessionOriginKind | null),
    originRef: value["originRef"] === undefined ? null : (value["originRef"] as string | null),
    originSubagent: value["originSubagent"] === undefined ? false : (value["originSubagent"] as boolean),
    unreadSince,
    doneSince,
    statusSince,
    activityLine,
    transcriptPath,
    originParentRef,
    lastEventAt,
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
  let agents: ProjectedAgentNode[] | null = null;
  if ("agents" in value) {
    if (!Array.isArray(value["agents"])) {
      return invalid("agents must be an array when present");
    }
    agents = parseAgents(value["agents"]);
  }
  return {
    schemaVersion: 2,
    health: parseHealth(value["health"]),
    sessions,
    agents,
  };
};
