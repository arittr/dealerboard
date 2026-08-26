/**
 * Defensive projection from `active_sessions` rows to the published snapshot.
 *
 * `projectSnapshotRows` validates native topology once, computes native subtree
 * status bottom-up, then materializes both the legacy root list and unified
 * agent graph from those shared results. Paseo lineage only links unique root
 * refs; invalid Paseo lineage is represented as an orphan rather than making a
 * valid native projection fail. `readProjection` owns the SQLite read
 * transaction and rolls it back if mapping or projection throws.
 */

import type { Database } from "bun:sqlite";
import {
  PROVIDER_KEYS,
  type ProjectedAgentNode,
  type ProjectedSession,
  type Provider,
  type SessionOriginKind,
  type SessionSnapshotV2,
  type SessionStatus,
} from "../protocol";

/** One `active_sessions` row mapped to the camelCase projection input. */
export type ProjectionRow = {
  provider: Provider;
  sessionId: string;
  parentSessionId: string | null;
  status: SessionStatus;
  title: string | null;
  project: string | null;
  logicalSlot: number | null;
  ghosttyTerminalId: string | null;
  model: string | null;
  openedAt: string;
  originKind: SessionOriginKind | null;
  originRef: string | null;
  originSubagent: number;
  unreadSince: string | null;
  statusSince: string | null;
  activityLine: string | null;
  transcriptPath: string | null;
  originParentRef: string | null;
  /** ISO-8601 UTC of the row's last hook event (`updated_at`); null tolerated defensively. */
  lastEventAt: string | null;
};

export type ProjectionErrorCode =
  | "corrupt-row"
  | "duplicate-identity"
  | "missing-parent"
  | "cross-provider-parent"
  | "child-with-slot"
  | "child-with-terminal-binding"
  | "non-claude-terminal-binding"
  | "top-level-without-positive-slot"
  | "cycle"
  | "traversal-bound-exceeded";

export class ProjectionError extends Error {
  readonly code: ProjectionErrorCode;

  constructor(code: ProjectionErrorCode) {
    super(`invalid session projection: ${code}`);
    this.name = "ProjectionError";
    this.code = code;
  }
}

export type ProjectedRows = {
  sessions: ProjectedSession[];
  agents: ProjectedAgentNode[];
};

type NodeResult = {
  row: ProjectionRow;
  effectiveStatus: SessionStatus;
  descendantCount: number;
};

type RootResult = NodeResult & { slot: number };

const STATUS_PRIORITY: Record<SessionStatus, number> = {
  idle: 0,
  working: 1,
  waiting: 2,
  error: 3,
};

const PROVIDERS: ReadonlySet<string> = new Set(PROVIDER_KEYS);
const SESSION_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "waiting", "error"]);
const ORIGIN_KINDS: ReadonlySet<string> = new Set(["paseo", "terminal"]);

const identityKey = (provider: Provider, sessionId: string): string => `${provider}\u0000${sessionId}`;

const isPaseoSubagent = (row: ProjectionRow): boolean => row.originKind === "paseo" && row.originSubagent === 1;

const childStatus = (row: ProjectionRow): SessionStatus => (row.status === "idle" ? "working" : row.status);

/** The higher-priority of two statuses (error > waiting > working > idle). */
const maxStatus = (a: SessionStatus, b: SessionStatus): SessionStatus =>
  STATUS_PRIORITY[a] > STATUS_PRIORITY[b] ? a : b;

const compareAgents = (a: ProjectedAgentNode, b: ProjectedAgentNode): number => {
  if (a.openedAt !== b.openedAt) {
    return a.openedAt < b.openedAt ? -1 : 1;
  }
  if (a.provider !== b.provider) {
    return a.provider < b.provider ? -1 : 1;
  }
  if (a.sessionId === b.sessionId) {
    return 0;
  }
  return a.sessionId < b.sessionId ? -1 : 1;
};

/**
 * Project validated registry rows to both the legacy top-level session list and
 * a unified native/Paseo hierarchy. Pure; throws `ProjectionError` on invalid
 * native topology rather than emitting partial output.
 */
export const projectSnapshotRows = (rows: readonly ProjectionRow[]): ProjectedRows => {
  const byIdentity = new Map<string, ProjectionRow>();
  for (const row of rows) {
    const key = identityKey(row.provider, row.sessionId);
    if (byIdentity.has(key)) {
      throw new ProjectionError("duplicate-identity");
    }
    byIdentity.set(key, row);
  }

  const rootRows: { row: ProjectionRow; slot: number }[] = [];
  const childrenOf = new Map<string, ProjectionRow[]>();
  for (const row of rows) {
    if (row.parentSessionId === null) {
      if (row.ghosttyTerminalId !== null && row.provider !== "claude") {
        throw new ProjectionError("non-claude-terminal-binding");
      }
      if (row.logicalSlot === null || !Number.isInteger(row.logicalSlot) || row.logicalSlot < 1) {
        throw new ProjectionError("top-level-without-positive-slot");
      }
      rootRows.push({ row, slot: row.logicalSlot });
      continue;
    }
    if (row.ghosttyTerminalId !== null) {
      throw new ProjectionError("child-with-terminal-binding");
    }
    if (row.logicalSlot !== null) {
      throw new ProjectionError("child-with-slot");
    }
    const parentKey = identityKey(row.provider, row.parentSessionId);
    if (!byIdentity.has(parentKey)) {
      const underAnotherProvider = rows.some(
        (candidate) => candidate.provider !== row.provider && candidate.sessionId === row.parentSessionId,
      );
      throw new ProjectionError(underAnotherProvider ? "cross-provider-parent" : "missing-parent");
    }
    const siblings = childrenOf.get(parentKey);
    if (siblings === undefined) {
      childrenOf.set(parentKey, [row]);
    } else {
      siblings.push(row);
    }
  }

  rootRows.sort((a, b) => a.slot - b.slot);
  const nativeOrder: ProjectionRow[] = [];
  const nativeRootByIdentity = new Map<string, string>();
  let totalVisited = 0;
  for (const { row: root } of rootRows) {
    const rootKey = identityKey(root.provider, root.sessionId);
    const visited = new Set<string>();
    const stack: ProjectionRow[] = [root];
    let steps = 0;
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      steps += 1;
      if (steps > rows.length + 1) {
        throw new ProjectionError("traversal-bound-exceeded");
      }
      const key = identityKey(current.provider, current.sessionId);
      if (visited.has(key)) {
        throw new ProjectionError("cycle");
      }
      visited.add(key);
      nativeOrder.push(current);
      nativeRootByIdentity.set(key, rootKey);
      for (const child of childrenOf.get(key) ?? []) {
        stack.push(child);
      }
    }
    totalVisited += visited.size;
  }

  if (totalVisited !== rows.length) {
    throw new ProjectionError("cycle");
  }

  const results = new Map<string, NodeResult>();
  for (const current of [...nativeOrder].reverse()) {
    const key = identityKey(current.provider, current.sessionId);
    let effectiveStatus = current.parentSessionId === null ? current.status : childStatus(current);
    let descendantCount = 0;
    for (const child of childrenOf.get(key) ?? []) {
      const childResult = results.get(identityKey(child.provider, child.sessionId));
      if (childResult === undefined) {
        throw new ProjectionError("corrupt-row");
      }
      effectiveStatus = maxStatus(effectiveStatus, childResult.effectiveStatus);
      descendantCount += childResult.descendantCount + 1;
    }
    results.set(key, { row: current, effectiveStatus, descendantCount });
  }

  const rootResults: RootResult[] = [];
  const rootResultsByIdentity = new Map<string, RootResult>();
  for (const { row, slot } of rootRows) {
    const key = identityKey(row.provider, row.sessionId);
    const result = results.get(key);
    if (result === undefined) {
      throw new ProjectionError("corrupt-row");
    }
    const rootResult: RootResult = { ...result, slot };
    rootResults.push(rootResult);
    rootResultsByIdentity.set(key, rootResult);
  }

  const rootByOriginRef = new Map<string, string>();
  const ambiguousOriginRefs = new Set<string>();
  for (const root of rootResults) {
    if (root.row.originKind !== "paseo" || root.row.originRef === null) {
      continue;
    }
    const ref = root.row.originRef;
    if (ambiguousOriginRefs.has(ref)) {
      continue;
    }
    if (rootByOriginRef.has(ref)) {
      rootByOriginRef.delete(ref);
      ambiguousOriginRefs.add(ref);
    } else {
      rootByOriginRef.set(ref, identityKey(root.row.provider, root.row.sessionId));
    }
  }

  const paseoParent = new Map<string, string>();
  for (const root of rootResults) {
    if (!isPaseoSubagent(root.row) || root.row.originParentRef === null) {
      continue;
    }
    const parentKey = rootByOriginRef.get(root.row.originParentRef);
    if (parentKey !== undefined) {
      paseoParent.set(identityKey(root.row.provider, root.row.sessionId), parentKey);
    }
  }

  const done = new Set<string>();
  const cycleMembers = new Set<string>();
  for (const start of paseoParent.keys()) {
    const path: string[] = [];
    const indexInPath = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && !done.has(current)) {
      const cycleStart = indexInPath.get(current);
      if (cycleStart !== undefined) {
        for (const member of path.slice(cycleStart)) {
          cycleMembers.add(member);
        }
        break;
      }
      indexInPath.set(current, path.length);
      path.push(current);
      current = paseoParent.get(current);
    }
    for (const member of path) {
      done.add(member);
    }
  }
  for (const member of cycleMembers) {
    paseoParent.delete(member);
  }

  for (const result of rootResults) {
    let carried = result.effectiveStatus;
    let parentKey = paseoParent.get(identityKey(result.row.provider, result.row.sessionId));
    const visited = new Set<string>();
    while (parentKey !== undefined && !visited.has(parentKey)) {
      visited.add(parentKey);
      const ancestor = rootResultsByIdentity.get(parentKey);
      if (ancestor === undefined) {
        throw new ProjectionError("corrupt-row");
      }
      const combined = maxStatus(carried, ancestor.effectiveStatus);
      ancestor.effectiveStatus = combined;
      carried = combined;
      parentKey = paseoParent.get(parentKey);
    }
  }

  const rootVisible = (result: RootResult): boolean =>
    result.effectiveStatus !== "idle" || (result.row.unreadSince !== null && !isPaseoSubagent(result.row));
  const visibleRoots = rootResults.filter(rootVisible);
  const visibleRootKeys = new Set(visibleRoots.map((result) => identityKey(result.row.provider, result.row.sessionId)));

  const rootFacts = (result: RootResult) => ({
    provider: result.row.provider,
    sessionId: result.row.sessionId,
    status: result.effectiveStatus,
    title: result.row.title,
    project: result.row.project,
    model: result.row.model,
    statusSince: result.row.statusSince,
    activityLine: result.row.activityLine,
    unreadSince: result.row.unreadSince,
    logicalSlot: result.slot,
    ghosttyTerminalId: result.row.ghosttyTerminalId,
    transcriptPath: result.row.transcriptPath,
    originKind: result.row.originKind,
    originRef: result.row.originRef,
    originSubagent: isPaseoSubagent(result.row),
    originParentRef: result.row.originParentRef,
  });

  const projectedSessions = visibleRoots.map(
    (result): ProjectedSession => ({
      ...rootFacts(result),
      descendantCount: result.descendantCount,
      lastEventAt: result.row.lastEventAt,
    }),
  );

  const rootNode = (result: RootResult): ProjectedAgentNode => {
    const key = identityKey(result.row.provider, result.row.sessionId);
    const parentKey = paseoParent.get(key);
    const parentResult = parentKey === undefined ? undefined : rootResultsByIdentity.get(parentKey);
    const paseoSubagent = isPaseoSubagent(result.row);
    return {
      ...rootFacts(result),
      role: paseoSubagent ? "subagent" : "primary",
      lineage: paseoSubagent ? "paseo" : null,
      parent:
        paseoSubagent && parentResult !== undefined
          ? { provider: parentResult.row.provider, sessionId: parentResult.row.sessionId }
          : null,
      openedAt: result.row.openedAt,
    };
  };

  const nativeNode = (result: NodeResult, parentSessionId: string): ProjectedAgentNode => ({
    provider: result.row.provider,
    sessionId: result.row.sessionId,
    role: "subagent",
    lineage: "native",
    parent: { provider: result.row.provider, sessionId: parentSessionId },
    status: result.effectiveStatus,
    title: result.row.title,
    project: result.row.project,
    model: result.row.model,
    openedAt: result.row.openedAt,
    statusSince: result.row.statusSince,
    activityLine: result.row.activityLine,
    unreadSince: null,
    logicalSlot: null,
    ghosttyTerminalId: null,
    transcriptPath: null,
    originKind: null,
    originRef: null,
    originSubagent: false,
    originParentRef: null,
  });

  const nodesByIdentity = new Map<string, ProjectedAgentNode>();
  for (const result of visibleRoots) {
    nodesByIdentity.set(identityKey(result.row.provider, result.row.sessionId), rootNode(result));
  }
  for (const current of nativeOrder) {
    if (current.parentSessionId === null) {
      continue;
    }
    const key = identityKey(current.provider, current.sessionId);
    const rootKey = nativeRootByIdentity.get(key);
    if (rootKey === undefined) {
      throw new ProjectionError("corrupt-row");
    }
    if (!visibleRootKeys.has(rootKey)) {
      continue;
    }
    const result = results.get(key);
    if (result === undefined) {
      throw new ProjectionError("corrupt-row");
    }
    nodesByIdentity.set(key, nativeNode(result, current.parentSessionId));
  }

  const graphChildren = new Map<string, ProjectedAgentNode[]>();
  for (const node of nodesByIdentity.values()) {
    if (node.parent === null) {
      continue;
    }
    const parentKey = identityKey(node.parent.provider, node.parent.sessionId);
    if (!nodesByIdentity.has(parentKey)) {
      throw new ProjectionError("corrupt-row");
    }
    const children = graphChildren.get(parentKey);
    if (children === undefined) {
      graphChildren.set(parentKey, [node]);
    } else {
      children.push(node);
    }
  }

  const orderedAgents: ProjectedAgentNode[] = [];
  const orderedKeys = new Set<string>();
  const appendSubtree = (key: string): void => {
    if (orderedKeys.has(key)) {
      throw new ProjectionError("corrupt-row");
    }
    const node = nodesByIdentity.get(key);
    if (node === undefined) {
      throw new ProjectionError("corrupt-row");
    }
    orderedKeys.add(key);
    orderedAgents.push(node);
    for (const child of [...(graphChildren.get(key) ?? [])].sort(compareAgents)) {
      appendSubtree(identityKey(child.provider, child.sessionId));
    }
  };

  for (const result of visibleRoots) {
    if (!isPaseoSubagent(result.row)) {
      appendSubtree(identityKey(result.row.provider, result.row.sessionId));
    }
  }
  const orphanPaseoRoots = visibleRoots
    .filter(
      (result) =>
        isPaseoSubagent(result.row) &&
        paseoParent.get(identityKey(result.row.provider, result.row.sessionId)) === undefined,
    )
    .map((result) => rootNode(result))
    .sort(compareAgents);
  for (const node of orphanPaseoRoots) {
    appendSubtree(identityKey(node.provider, node.sessionId));
  }

  if (orderedAgents.length !== nodesByIdentity.size) {
    throw new ProjectionError("corrupt-row");
  }
  return { sessions: projectedSessions, agents: orderedAgents };
};

/** Compatibility wrapper that preserves the legacy sessions-only projection. */
export const projectRows = (rows: readonly ProjectionRow[]): ProjectedSession[] => projectSnapshotRows(rows).sessions;

type StoredRow = {
  provider: unknown;
  session_id: unknown;
  parent_session_id: unknown;
  status: unknown;
  title: unknown;
  project: unknown;
  logical_slot: unknown;
  ghostty_terminal_id: unknown;
  model: unknown;
  opened_at: unknown;
  origin_kind: unknown;
  origin_ref: unknown;
  origin_subagent: unknown;
  unread_since: unknown;
  status_since: unknown;
  activity_line: unknown;
  transcript_path: unknown;
  origin_parent_ref: unknown;
  updated_at: unknown;
};

const isStringOrNull = (value: unknown): value is string | null => typeof value === "string" || value === null;

const isProvider = (value: unknown): value is Provider => typeof value === "string" && PROVIDERS.has(value);

const isSessionStatus = (value: unknown): value is SessionStatus =>
  typeof value === "string" && SESSION_STATUSES.has(value);

const isOriginKindOrNull = (value: unknown): value is SessionOriginKind | null =>
  value === null || (typeof value === "string" && ORIGIN_KINDS.has(value));

const isBinary = (value: unknown): value is 0 | 1 => value === 0 || value === 1;

const isCanonicalUtcInstant = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 256) {
    return false;
  }
  const epoch = Date.parse(value);
  return !Number.isNaN(epoch) && new Date(epoch).toISOString() === value;
};

/** Map one stored row, validating field shapes defensively. */
const toProjectionRow = (row: StoredRow): ProjectionRow => {
  if (
    !isProvider(row.provider) ||
    typeof row.session_id !== "string" ||
    row.session_id.length === 0 ||
    !isSessionStatus(row.status)
  ) {
    throw new ProjectionError("corrupt-row");
  }
  if (
    !isStringOrNull(row.parent_session_id) ||
    !isStringOrNull(row.title) ||
    !isStringOrNull(row.project) ||
    !isStringOrNull(row.ghostty_terminal_id) ||
    !isStringOrNull(row.model)
  ) {
    throw new ProjectionError("corrupt-row");
  }
  if (row.logical_slot !== null && (typeof row.logical_slot !== "number" || !Number.isInteger(row.logical_slot))) {
    throw new ProjectionError("corrupt-row");
  }
  if (
    typeof row.ghostty_terminal_id === "string" &&
    (row.ghostty_terminal_id.length === 0 || Array.from(row.ghostty_terminal_id).length > 256)
  ) {
    throw new ProjectionError("corrupt-row");
  }
  if (typeof row.model === "string" && (row.model.length === 0 || Array.from(row.model).length > 256)) {
    throw new ProjectionError("corrupt-row");
  }
  if (
    !isCanonicalUtcInstant(row.opened_at) ||
    !isOriginKindOrNull(row.origin_kind) ||
    !isStringOrNull(row.origin_ref)
  ) {
    throw new ProjectionError("corrupt-row");
  }
  if (typeof row.origin_ref === "string" && (row.origin_ref.length === 0 || Array.from(row.origin_ref).length > 256)) {
    throw new ProjectionError("corrupt-row");
  }
  if (!isBinary(row.origin_subagent) || !isStringOrNull(row.unread_since) || !isStringOrNull(row.status_since)) {
    throw new ProjectionError("corrupt-row");
  }
  if (
    !isStringOrNull(row.transcript_path) ||
    !isStringOrNull(row.origin_parent_ref) ||
    !isStringOrNull(row.activity_line) ||
    !isStringOrNull(row.updated_at)
  ) {
    throw new ProjectionError("corrupt-row");
  }
  if (
    typeof row.transcript_path === "string" &&
    (row.transcript_path.length === 0 || Array.from(row.transcript_path).length > 256)
  ) {
    throw new ProjectionError("corrupt-row");
  }
  if (
    typeof row.origin_parent_ref === "string" &&
    (row.origin_parent_ref.length === 0 || Array.from(row.origin_parent_ref).length > 256)
  ) {
    throw new ProjectionError("corrupt-row");
  }
  if (
    typeof row.activity_line === "string" &&
    (row.activity_line.length === 0 || Array.from(row.activity_line).length > 64)
  ) {
    throw new ProjectionError("corrupt-row");
  }
  return {
    provider: row.provider,
    sessionId: row.session_id,
    parentSessionId: row.parent_session_id,
    status: row.status,
    title: row.title,
    project: row.project,
    logicalSlot: row.logical_slot,
    ghosttyTerminalId: row.ghostty_terminal_id,
    model: row.model,
    openedAt: row.opened_at,
    originKind: row.origin_kind,
    originRef: row.origin_ref,
    originSubagent: row.origin_subagent,
    unreadSince: row.unread_since,
    statusSince: row.status_since,
    activityLine: row.activity_line,
    transcriptPath: row.transcript_path,
    originParentRef: row.origin_parent_ref,
    lastEventAt: row.updated_at,
  };
};

const PROJECTION_COLUMNS =
  "provider, session_id, parent_session_id, status, title, project, logical_slot, ghostty_terminal_id, model, opened_at, origin_kind, origin_ref, origin_subagent, unread_since, status_since, activity_line, transcript_path, origin_parent_ref, updated_at";

/**
 * Read one consistent snapshot in a read transaction this function owns:
 * `BEGIN`, select, map, project, `COMMIT`; any throw rolls back. Issues no
 * writes, so it is safe on a strictly read-only connection.
 */
export const readProjection = (db: Database): SessionSnapshotV2 => {
  db.exec("BEGIN");
  let committed = false;
  try {
    const rows = db.query<StoredRow, []>(`SELECT ${PROJECTION_COLUMNS} FROM active_sessions`).all();
    const projected = projectSnapshotRows(rows.map(toProjectionRow));
    const snapshot: SessionSnapshotV2 = {
      schemaVersion: 2,
      health: { status: "ok" },
      sessions: projected.sessions,
      agents: projected.agents,
    };
    db.exec("COMMIT");
    committed = true;
    return snapshot;
  } finally {
    if (!committed) {
      db.exec("ROLLBACK");
    }
  }
};
