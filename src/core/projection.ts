/**
 * Defensive projection from `active_sessions` rows to the published snapshot.
 *
 * `projectRows` is pure: it indexes rows by composite identity, validates
 * every identity, role, slot, and parent edge up front, then walks each
 * top-level tree with a per-root visited set and a total-step bound of
 * `rows.length + 1`. Any invalid topology throws `ProjectionError` — the
 * projection never emits partial output. `readProjection` owns the read
 * transaction boundary around the SQLite select: it commits only a fully
 * mapped and projected snapshot and rolls back if mapping or projection
 * throws. The read side issues no writes.
 */

import type { Database } from "bun:sqlite";
import {
  PROVIDER_KEYS,
  type ProjectedSession,
  type Provider,
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

const STATUS_PRIORITY: Record<SessionStatus, number> = {
  idle: 0,
  working: 1,
  waiting: 2,
  error: 3,
};

const PROVIDERS: ReadonlySet<string> = new Set(PROVIDER_KEYS);
const SESSION_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "waiting", "error"]);

const identityKey = (provider: Provider, sessionId: string): string => `${provider}\u0000${sessionId}`;

/**
 * Project stored rows to the top-level snapshot session list, ordered by
 * stored logical slot with gaps preserved. A root's effective status is the
 * highest-priority status in its subtree, where a live descendant counts as
 * at least "working": child rows exist only while a subagent runs, and a
 * subagent may never emit its own Activity event. Pure; throws
 * `ProjectionError` on any invalid topology rather than emitting partial
 * output.
 */
export const projectRows = (rows: readonly ProjectionRow[]): ProjectedSession[] => {
  // Index every row by composite identity; duplicates are corrupt.
  const byIdentity = new Map<string, ProjectionRow>();
  for (const row of rows) {
    const key = identityKey(row.provider, row.sessionId);
    if (byIdentity.has(key)) {
      throw new ProjectionError("duplicate-identity");
    }
    byIdentity.set(key, row);
  }

  // Validate roles, slots, and parent edges before any traversal.
  const roots: { row: ProjectionRow; slot: number }[] = [];
  const childrenOf = new Map<string, ProjectionRow[]>();
  for (const row of rows) {
    if (row.parentSessionId === null) {
      if (row.ghosttyTerminalId !== null && row.provider !== "claude") {
        throw new ProjectionError("non-claude-terminal-binding");
      }
      if (row.logicalSlot === null || !Number.isInteger(row.logicalSlot) || row.logicalSlot < 1) {
        throw new ProjectionError("top-level-without-positive-slot");
      }
      roots.push({ row, slot: row.logicalSlot });
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

  // Traverse each top-level tree: per-root visited set plus a total-step
  // bound of rows.length + 1, so corrupt data can never loop forever.
  roots.sort((a, b) => a.slot - b.slot);
  const projected: ProjectedSession[] = [];
  let totalVisited = 0;
  for (const { row: root, slot } of roots) {
    const rootKey = identityKey(root.provider, root.sessionId);
    const visited = new Set<string>();
    const stack: ProjectionRow[] = [root];
    let steps = 0;
    let descendantCount = 0;
    let effectiveStatus: SessionStatus = root.status;
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
      if (key !== rootKey) {
        descendantCount += 1;
        // A descendant row exists only while its subagent runs (SubagentStop
        // deletes the row), and a subagent may never emit its own Activity
        // event — so a live descendant lifts the tree to at least "working".
        const descendantStatus = current.status === "idle" ? "working" : current.status;
        if (STATUS_PRIORITY[descendantStatus] > STATUS_PRIORITY[effectiveStatus]) {
          effectiveStatus = descendantStatus;
        }
      }
      for (const child of childrenOf.get(key) ?? []) {
        stack.push(child);
      }
    }
    totalVisited += visited.size;
    projected.push({
      provider: root.provider,
      sessionId: root.sessionId,
      status: effectiveStatus,
      title: root.title,
      project: root.project,
      descendantCount,
      logicalSlot: slot,
      ghosttyTerminalId: root.ghosttyTerminalId,
    });
  }

  // Every valid row is reachable from exactly one root; rows left over form a
  // cycle detached from any root.
  if (totalVisited !== rows.length) {
    throw new ProjectionError("cycle");
  }
  return projected;
};

type StoredRow = {
  provider: unknown;
  session_id: unknown;
  parent_session_id: unknown;
  status: unknown;
  title: unknown;
  project: unknown;
  logical_slot: unknown;
  ghostty_terminal_id: unknown;
};

const isStringOrNull = (value: unknown): value is string | null => typeof value === "string" || value === null;

/** Map one stored row, validating field shapes defensively. */
const toProjectionRow = (row: StoredRow): ProjectionRow => {
  if (typeof row.provider !== "string" || !PROVIDERS.has(row.provider)) {
    throw new ProjectionError("corrupt-row");
  }
  if (typeof row.session_id !== "string" || row.session_id.length === 0) {
    throw new ProjectionError("corrupt-row");
  }
  if (typeof row.status !== "string" || !SESSION_STATUSES.has(row.status)) {
    throw new ProjectionError("corrupt-row");
  }
  if (
    !isStringOrNull(row.parent_session_id) ||
    !isStringOrNull(row.title) ||
    !isStringOrNull(row.project) ||
    !isStringOrNull(row.ghostty_terminal_id)
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
  return {
    provider: row.provider as Provider,
    sessionId: row.session_id,
    parentSessionId: row.parent_session_id,
    status: row.status as SessionStatus,
    title: row.title,
    project: row.project,
    logicalSlot: row.logical_slot,
    ghosttyTerminalId: row.ghostty_terminal_id,
  };
};

const PROJECTION_COLUMNS =
  "provider, session_id, parent_session_id, status, title, project, logical_slot, ghostty_terminal_id";

/**
 * Read one consistent snapshot in a read transaction this function owns:
 * `BEGIN`, select, map, project, `COMMIT`; any throw rolls back. Issues no
 * writes, so it is safe on a strictly read-only connection.
 */
export const readProjection = (db: Database): SessionSnapshotV2 => {
  db.exec("BEGIN");
  let committed = false;
  try {
    const rows = db.query(`SELECT ${PROJECTION_COLUMNS} FROM active_sessions`).all() as StoredRow[];
    const snapshot: SessionSnapshotV2 = {
      schemaVersion: 2,
      health: { status: "ok" },
      sessions: projectRows(rows.map(toProjectionRow)),
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
