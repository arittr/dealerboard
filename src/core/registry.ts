/**
 * The only active-state mutation layer for the session registry.
 *
 * Every write to `active_sessions` — hook events and repair commands alike —
 * goes through this module. One decoded hook's event sequence runs inside a
 * single `BEGIN IMMEDIATE` transaction with rollback in `finally`. Events that
 * would violate role, parent, provider, or cycle invariants are reported as
 * "ignored" rather than throwing into a hook caller; the foreign key and the
 * partial unique index remain the final backstop for genuinely unexpected
 * writes.
 *
 * The database holds active state only: end and stop events delete rows, and a
 * missed end event leaves a stale row until `clearSession`/`clearAllSessions`
 * repair it. Slots are never compacted; a new top-level row receives the
 * lowest free positive slot found from the sorted non-null slot list.
 */

import type { Database } from "bun:sqlite";
import type { Provider, RegistryEvent, SessionStatus } from "../protocol";

export type MutationResult = "applied" | "ignored";

/** One `active_sessions` row in the camelCase diagnostic shape. */
export type ActiveSession = {
  provider: Provider;
  sessionId: string;
  parentSessionId: string | null;
  status: SessionStatus;
  title: string | null;
  project: string | null;
  logicalSlot: number | null;
  ghosttyTerminalId: string | null;
  openedAt: string;
  updatedAt: string;
};

type SessionRow = {
  provider: Provider;
  session_id: string;
  parent_session_id: string | null;
  status: SessionStatus;
  title: string | null;
  project: string | null;
  logical_slot: number | null;
  ghostty_terminal_id: string | null;
  opened_at: string;
  updated_at: string;
};

const COLUMNS =
  "provider, session_id, parent_session_id, status, title, project, logical_slot, opened_at, updated_at, ghostty_terminal_id";

const getRow = (db: Database, provider: Provider, sessionId: string): SessionRow | null =>
  db
    .query(`SELECT ${COLUMNS} FROM active_sessions WHERE provider = ? AND session_id = ?`)
    .get(provider, sessionId) as SessionRow | null;

const toActiveSession = (row: SessionRow): ActiveSession => ({
  provider: row.provider,
  sessionId: row.session_id,
  parentSessionId: row.parent_session_id,
  status: row.status,
  title: row.title,
  project: row.project,
  logicalSlot: row.logical_slot,
  ghosttyTerminalId: row.ghostty_terminal_id,
  openedAt: row.opened_at,
  updatedAt: row.updated_at,
});

/** Run `body` inside one immediate write transaction; any throw rolls back. */
const inWriteTransaction = <T>(db: Database, body: () => T): T => {
  db.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    const result = body();
    db.exec("COMMIT");
    committed = true;
    return result;
  } finally {
    if (!committed) {
      db.exec("ROLLBACK");
    }
  }
};

/** First hole in the sorted non-null slot list; no allocator table. */
const allocateLowestFreeSlot = (db: Database): number => {
  const rows = db
    .query(
      "SELECT logical_slot FROM active_sessions WHERE logical_slot IS NOT NULL ORDER BY logical_slot ASC",
    )
    .all() as { logical_slot: number }[];
  let slot = 1;
  for (const row of rows) {
    if (row.logical_slot > slot) {
      break;
    }
    slot = row.logical_slot + 1;
  }
  return slot;
};

/**
 * Walk the prospective parent's ancestor chain. Reject when the candidate
 * child appears in it (self-parenting or a prospective cycle), when any
 * referenced parent is absent under the child's provider (missing or
 * cross-provider parentage), or when traversal revisits an identity or
 * outlives the row-count bound (defensive: already-corrupt data).
 */
const isValidProspectiveParent = (
  db: Database,
  provider: Provider,
  childSessionId: string,
  parentSessionId: string,
): boolean => {
  const countRow = db.query("SELECT COUNT(*) AS n FROM active_sessions").get() as {
    n: number;
  } | null;
  if (countRow === null) {
    return false;
  }
  const bound = countRow.n + 1;
  const visited = new Set<string>();
  let current: string | null = parentSessionId;
  while (current !== null) {
    if (current === childSessionId || !visited.add(current) || visited.size > bound) {
      return false;
    }
    const row = db
      .query("SELECT parent_session_id FROM active_sessions WHERE provider = ? AND session_id = ?")
      .get(provider, current) as { parent_session_id: string | null } | null;
    if (row === null) {
      return false;
    }
    current = row.parent_session_id;
  }
  return true;
};

const applySessionStart = (
  db: Database,
  event: Extract<RegistryEvent, { kind: "SessionStart" }>,
): MutationResult => {
  const ghosttyTerminalId = event.provider === "claude" ? event.ghosttyTerminalId : null;
  const existing = getRow(db, event.provider, event.sessionId);
  if (existing !== null) {
    // An identity currently stored as a child keeps its role.
    if (existing.parent_session_id !== null) {
      return "ignored";
    }
    // Reset to idle and refresh metadata; slot and opened_at stay put.
    db.run(
      `UPDATE active_sessions
       SET status = 'idle', title = ?, project = ?, ghostty_terminal_id = ?, updated_at = ?
       WHERE provider = ? AND session_id = ?`,
      [
        event.title,
        event.project,
        ghosttyTerminalId,
        event.observedAt,
        event.provider,
        event.sessionId,
      ],
    );
    return "applied";
  }
  db.run(
    `INSERT INTO active_sessions
       (${COLUMNS})
     VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?, ?, ?)`,
    [
      event.provider,
      event.sessionId,
      event.title,
      event.project,
      allocateLowestFreeSlot(db),
      event.observedAt,
      event.observedAt,
      ghosttyTerminalId,
    ],
  );
  return "applied";
};

const applySubagentStart = (
  db: Database,
  event: Extract<RegistryEvent, { kind: "SubagentStart" }>,
): MutationResult => {
  if (!isValidProspectiveParent(db, event.provider, event.sessionId, event.parentSessionId)) {
    return "ignored";
  }
  const existing = getRow(db, event.provider, event.sessionId);
  if (existing !== null) {
    // An identity currently stored as a top-level row keeps its role.
    if (existing.parent_session_id === null) {
      return "ignored";
    }
    // Reset to idle under the validated prospective parent.
    db.run(
      `UPDATE active_sessions
       SET parent_session_id = ?, status = 'idle', title = ?, project = ?, updated_at = ?
       WHERE provider = ? AND session_id = ?`,
      [
        event.parentSessionId,
        event.title,
        event.project,
        event.observedAt,
        event.provider,
        event.sessionId,
      ],
    );
    return "applied";
  }
  db.run(
    `INSERT INTO active_sessions
       (${COLUMNS})
     VALUES (?, ?, ?, 'idle', ?, ?, NULL, ?, ?, NULL)`,
    [
      event.provider,
      event.sessionId,
      event.parentSessionId,
      event.title,
      event.project,
      event.observedAt,
      event.observedAt,
    ],
  );
  return "applied";
};

const applyStatusUpdate = (
  db: Database,
  event: Extract<RegistryEvent, { kind: "Activity" | "Attention" | "Stop" | "StopFailure" }>,
  status: SessionStatus,
): MutationResult => {
  const result = db.run(
    "UPDATE active_sessions SET status = ?, updated_at = ? WHERE provider = ? AND session_id = ?",
    [status, event.observedAt, event.provider, event.sessionId],
  );
  return result.changes > 0 ? "applied" : "ignored";
};

const applySessionEnd = (
  db: Database,
  event: Extract<RegistryEvent, { kind: "SessionEnd" }>,
): MutationResult => {
  const existing = getRow(db, event.provider, event.sessionId);
  // Only an existing top-level row ends; children stop via SubagentStop.
  if (existing === null || existing.parent_session_id !== null) {
    return "ignored";
  }
  db.run("DELETE FROM active_sessions WHERE provider = ? AND session_id = ?", [
    event.provider,
    event.sessionId,
  ]);
  return "applied";
};

const applySubagentStop = (
  db: Database,
  event: Extract<RegistryEvent, { kind: "SubagentStop" }>,
): MutationResult => {
  const existing = getRow(db, event.provider, event.sessionId);
  // Only an existing child row stops; top-level rows end via SessionEnd.
  if (existing === null || existing.parent_session_id === null) {
    return "ignored";
  }
  db.run("DELETE FROM active_sessions WHERE provider = ? AND session_id = ?", [
    event.provider,
    event.sessionId,
  ]);
  return "applied";
};

const applyEvent = (db: Database, event: RegistryEvent): MutationResult => {
  switch (event.kind) {
    case "SessionStart":
      return applySessionStart(db, event);
    case "SubagentStart":
      return applySubagentStart(db, event);
    case "Activity":
      return applyStatusUpdate(db, event, "working");
    case "Attention":
      return applyStatusUpdate(db, event, "waiting");
    case "Stop":
      return applyStatusUpdate(db, event, "idle");
    case "StopFailure":
      return applyStatusUpdate(db, event, "error");
    case "SessionEnd":
      return applySessionEnd(db, event);
    case "SubagentStop":
      return applySubagentStop(db, event);
  }
};

/**
 * Apply one decoded hook's normalized event sequence in a single
 * `BEGIN IMMEDIATE` transaction, returning one result per event in order.
 * Ignored events leave no mutation; an unexpected SQLite failure rolls the
 * whole sequence back and propagates to the caller.
 */
export const applyRegistryEvents = (
  db: Database,
  events: readonly RegistryEvent[],
): MutationResult[] => inWriteTransaction(db, () => events.map((event) => applyEvent(db, event)));

/**
 * Diagnostic listing of every active row: top-level sessions ordered by their
 * non-null slot first, then children by provider/session identity. Read-only.
 */
export const listSessions = (db: Database): ActiveSession[] => {
  const rows = db
    .query(
      `SELECT ${COLUMNS} FROM active_sessions
       ORDER BY (logical_slot IS NULL) ASC, logical_slot ASC, provider ASC, session_id ASC`,
    )
    .all() as SessionRow[];
  return rows.map(toActiveSession);
};

/**
 * Repair one selected session: select the exact `(provider, sessionId)` row,
 * then delete that composite identity — cascading to its descendants — inside
 * one write transaction. Never touches schema or recreates the database.
 */
export const clearSession = (
  db: Database,
  provider: Provider,
  sessionId: string,
): MutationResult =>
  inWriteTransaction(db, () => {
    if (getRow(db, provider, sessionId) === null) {
      return "ignored";
    }
    db.run("DELETE FROM active_sessions WHERE provider = ? AND session_id = ?", [
      provider,
      sessionId,
    ]);
    return "applied";
  });

/** Repair everything: remove all active registry state in one transaction. */
export const clearAllSessions = (db: Database): MutationResult =>
  inWriteTransaction(db, () => {
    db.run("DELETE FROM active_sessions");
    return "applied";
  });
