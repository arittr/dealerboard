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
 * The database holds active state only: end and stop events delete rows; a
 * missed end event leaves a stale row until the daemon's age-based prune or a
 * manual `clearSession`/`clearAllSessions`/`pruneStaleSessions` repairs it.
 * Slots are never compacted; a new top-level row receives the
 * lowest free positive slot found from the sorted non-null slot list.
 *
 * The unread ledger records results the user has not viewed: a turn ending
 * (Stop settling to idle, or StopFailure) stamps `unread_since`, and only an
 * explicit view clears it — `acknowledgeSession` or a reused SessionStart.
 * Prompts and status events never mark a session read.
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
  backgroundOutstanding: number;
  transcriptPath: string | null;
  model: string | null;
  originKind: "paseo" | "terminal" | null;
  originRef: string | null;
  originSubagent: number;
  unreadSince: string | null;
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
  background_outstanding: number;
  transcript_path: string | null;
  model: string | null;
  origin_kind: "paseo" | "terminal" | null;
  origin_ref: string | null;
  origin_subagent: number;
  unread_since: string | null;
  opened_at: string;
  updated_at: string;
};

const COLUMNS =
  "provider, session_id, parent_session_id, status, title, project, logical_slot, opened_at, updated_at, ghostty_terminal_id, background_outstanding, transcript_path, model, origin_kind, origin_ref, origin_subagent, unread_since";

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
  backgroundOutstanding: row.background_outstanding,
  transcriptPath: row.transcript_path,
  model: row.model,
  originKind: row.origin_kind,
  originRef: row.origin_ref,
  originSubagent: row.origin_subagent,
  unreadSince: row.unread_since,
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
    .query("SELECT logical_slot FROM active_sessions WHERE logical_slot IS NOT NULL ORDER BY logical_slot ASC")
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

const applySessionStart = (db: Database, event: Extract<RegistryEvent, { kind: "SessionStart" }>): MutationResult => {
  const ghosttyTerminalId = event.provider === "claude" ? event.ghosttyTerminalId : null;
  const existing = getRow(db, event.provider, event.sessionId);
  if (existing !== null) {
    // An identity currently stored as a child keeps its role.
    if (existing.parent_session_id !== null) {
      return "ignored";
    }
    // Reset to idle and refresh metadata; slot and opened_at stay put. Any
    // stale background flag drops too: shells a previous life left running
    // are no longer tracked, and their late completions clear a zero flag.
    // The reuse is also a view: unread clears, and a fresh non-null origin
    // replaces the stored one (null new evidence keeps it) while resetting
    // the subagent bit.
    // A null event model never clears the stored one (COALESCE): providers
    // that omit the field on resume must not erase what an earlier start
    // stored.
    db.run(
      `UPDATE active_sessions
       SET status = 'idle', title = ?, project = ?, ghostty_terminal_id = ?, transcript_path = ?,
           background_outstanding = 0, unread_since = NULL,
           origin_kind = COALESCE(?, origin_kind),
           origin_ref = CASE WHEN ? IS NOT NULL THEN ? ELSE origin_ref END,
           origin_subagent = CASE WHEN ? IS NOT NULL THEN 0 ELSE origin_subagent END,
           updated_at = ?, model = COALESCE(?, model)
       WHERE provider = ? AND session_id = ?`,
      [
        event.title,
        event.project,
        ghosttyTerminalId,
        event.transcriptPath,
        event.origin?.kind ?? null,
        event.origin?.kind ?? null,
        event.origin?.ref ?? null,
        event.origin?.kind ?? null,
        event.observedAt,
        event.model,
        event.provider,
        event.sessionId,
      ],
    );
    return "applied";
  }
  db.run(
    `INSERT INTO active_sessions
       (${COLUMNS})
     VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, NULL)`,
    [
      event.provider,
      event.sessionId,
      event.title,
      event.project,
      allocateLowestFreeSlot(db),
      event.observedAt,
      event.observedAt,
      ghosttyTerminalId,
      event.transcriptPath,
      event.model,
      event.origin?.kind ?? null,
      event.origin?.ref ?? null,
    ],
  );
  return "applied";
};

const applySessionObserved = (
  db: Database,
  event: Extract<RegistryEvent, { kind: "SessionObserved" }>,
): MutationResult => {
  // A prompt proves missing membership, but it must not replay SessionStart's
  // metadata refresh over a session whose lifecycle is already registered.
  // The exception is transcript_path and model: a non-null event value that
  // differs from the stored one overwrites it — the transcript path unlocks
  // title resolution, and a provider whose prompt event carries a model fills
  // the label on a row that started without one. Null event values never
  // clear what is already stored.
  const existing = getRow(db, event.provider, event.sessionId);
  if (existing !== null) {
    const backfillModel = event.model !== null && existing.model !== event.model;
    const backfillTranscript = event.transcriptPath !== null && existing.transcript_path !== event.transcriptPath;
    if (backfillModel || backfillTranscript) {
      db.run(
        `UPDATE active_sessions
         SET transcript_path = COALESCE(?, transcript_path), model = COALESCE(?, model)
         WHERE provider = ? AND session_id = ?`,
        [event.transcriptPath, event.model, event.provider, event.sessionId],
      );
      return "applied";
    }
    return "ignored";
  }
  return applySessionStart(db, {
    kind: "SessionStart",
    provider: event.provider,
    sessionId: event.sessionId,
    title: event.title,
    project: event.project,
    ghosttyTerminalId: null,
    transcriptPath: event.transcriptPath,
    model: event.model,
    observedAt: event.observedAt,
    ...(event.origin !== undefined ? { origin: event.origin } : {}),
  });
};

/**
 * A pushed title (pi `/name`, dsh `session/title`) refreshes the row's title
 * only. `updated_at` deliberately stays put — it is the prune lease, and a
 * title push must not extend a dead session's life, matching
 * `updateSessionTitles`. Unknown identities are ignored: membership is
 * proven by prompts, not titles.
 */
const applySessionTitleChanged = (
  db: Database,
  event: Extract<RegistryEvent, { kind: "SessionTitleChanged" }>,
): MutationResult => {
  const result = db.run(
    "UPDATE active_sessions SET title = ? WHERE provider = ? AND session_id = ? AND title IS NOT ?",
    [event.title, event.provider, event.sessionId, event.title],
  );
  return result.changes > 0 ? "applied" : "ignored";
};

const applySubagentStart = (db: Database, event: Extract<RegistryEvent, { kind: "SubagentStart" }>): MutationResult => {
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
      [event.parentSessionId, event.title, event.project, event.observedAt, event.provider, event.sessionId],
    );
    return "applied";
  }
  db.run(
    `INSERT INTO active_sessions
       (${COLUMNS})
     VALUES (?, ?, ?, 'idle', ?, ?, NULL, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, 0, NULL)`,
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

/** The single union member covering every plain per-session status/flag event. */
type StatusEvent = Extract<
  RegistryEvent,
  {
    kind: "Activity" | "Attention" | "Stop" | "StopFailure" | "BackgroundWorkStarted" | "BackgroundWorkCleared";
  }
>;

const applyStatusUpdate = (db: Database, event: StatusEvent, status: SessionStatus): MutationResult => {
  const result = db.run("UPDATE active_sessions SET status = ?, updated_at = ? WHERE provider = ? AND session_id = ?", [
    status,
    event.observedAt,
    event.provider,
    event.sessionId,
  ]);
  return result.changes > 0 ? "applied" : "ignored";
};

/**
 * A turn ended. A session with a live background shell stays at working: the
 * shell still acts on the session's behalf and its completion will wake a new
 * turn. Only a Stop with no background work outstanding returns to idle —
 * and only that transition lands a result the user has not viewed, so it
 * alone stamps `unread_since`.
 */
const applyStop = (db: Database, event: StatusEvent): MutationResult => {
  const result = db.run(
    `UPDATE active_sessions
     SET status = CASE WHEN background_outstanding = 1 THEN 'working' ELSE 'idle' END,
         unread_since = CASE WHEN background_outstanding = 1 THEN unread_since ELSE ? END,
         updated_at = ?
     WHERE provider = ? AND session_id = ?`,
    [event.observedAt, event.observedAt, event.provider, event.sessionId],
  );
  return result.changes > 0 ? "applied" : "ignored";
};

/** A turn ended in failure: the error is itself an unread result. */
const applyStopFailure = (db: Database, event: StatusEvent): MutationResult => {
  const result = db.run(
    "UPDATE active_sessions SET status = 'error', unread_since = ?, updated_at = ? WHERE provider = ? AND session_id = ?",
    [event.observedAt, event.observedAt, event.provider, event.sessionId],
  );
  return result.changes > 0 ? "applied" : "ignored";
};

/**
 * Arm or disarm the background-work flag without touching status: the paired
 * Activity event carries the status change, so a flag event alone can never
 * lift a waiting or error state.
 */
const applyBackgroundWork = (db: Database, event: StatusEvent, outstanding: 0 | 1): MutationResult => {
  const result = db.run(
    "UPDATE active_sessions SET background_outstanding = ?, updated_at = ? WHERE provider = ? AND session_id = ?",
    [outstanding, event.observedAt, event.provider, event.sessionId],
  );
  return result.changes > 0 ? "applied" : "ignored";
};

const applySessionEnd = (db: Database, event: Extract<RegistryEvent, { kind: "SessionEnd" }>): MutationResult => {
  const existing = getRow(db, event.provider, event.sessionId);
  // Only an existing top-level row ends; children stop via SubagentStop.
  if (existing === null || existing.parent_session_id !== null) {
    return "ignored";
  }
  db.run("DELETE FROM active_sessions WHERE provider = ? AND session_id = ?", [event.provider, event.sessionId]);
  return "applied";
};

const applySubagentStop = (db: Database, event: Extract<RegistryEvent, { kind: "SubagentStop" }>): MutationResult => {
  const existing = getRow(db, event.provider, event.sessionId);
  // Only an existing child row stops; top-level rows end via SessionEnd.
  if (existing === null || existing.parent_session_id === null) {
    return "ignored";
  }
  db.run("DELETE FROM active_sessions WHERE provider = ? AND session_id = ?", [event.provider, event.sessionId]);
  return "applied";
};

const applyEvent = (db: Database, event: RegistryEvent): MutationResult => {
  switch (event.kind) {
    case "SessionStart":
      return applySessionStart(db, event);
    case "SessionObserved":
      return applySessionObserved(db, event);
    case "SessionTitleChanged":
      return applySessionTitleChanged(db, event);
    case "SubagentStart":
      return applySubagentStart(db, event);
    case "Activity":
      return applyStatusUpdate(db, event, "working");
    case "Attention":
      return applyStatusUpdate(db, event, "waiting");
    case "Stop":
      return applyStop(db, event);
    case "StopFailure":
      return applyStopFailure(db, event);
    case "BackgroundWorkStarted":
      return applyBackgroundWork(db, event, 1);
    case "BackgroundWorkCleared":
      return applyBackgroundWork(db, event, 0);
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
export const applyRegistryEvents = (db: Database, events: readonly RegistryEvent[]): MutationResult[] =>
  inWriteTransaction(db, () => events.map((event) => applyEvent(db, event)));

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
 * The session-facts-resolver view: every top-level row's identity, stored
 * title, model, and transcript path. Children never carry resolvable
 * titles. Read-only.
 */
export const listTitleTargets = (db: Database): TitleTarget[] =>
  db
    .query(
      `SELECT provider, session_id, title, model, transcript_path FROM active_sessions
       WHERE parent_session_id IS NULL
       ORDER BY logical_slot ASC`,
    )
    .all()
    .map((row) => {
      const { provider, session_id, title, model, transcript_path } = row as {
        provider: Provider;
        session_id: string;
        title: string | null;
        model: string | null;
        transcript_path: string | null;
      };
      return { provider, sessionId: session_id, title, model, transcriptPath: transcript_path };
    });

/**
 * Repair one selected session: select the exact `(provider, sessionId)` row,
 * then delete that composite identity — cascading to its descendants — inside
 * one write transaction. Never touches schema or recreates the database.
 */
export const clearSession = (db: Database, provider: Provider, sessionId: string): MutationResult =>
  inWriteTransaction(db, () => {
    if (getRow(db, provider, sessionId) === null) {
      return "ignored";
    }
    db.run("DELETE FROM active_sessions WHERE provider = ? AND session_id = ?", [provider, sessionId]);
    return "applied";
  });

/** Mark one session read: the user has viewed the latest result. Never touches updated_at. */
export const acknowledgeSession = (db: Database, provider: Provider, sessionId: string): MutationResult =>
  inWriteTransaction(db, () => {
    const result = db.run(
      "UPDATE active_sessions SET unread_since = NULL WHERE provider = ? AND session_id = ? AND unread_since IS NOT NULL",
      [provider, sessionId],
    );
    return result.changes > 0 ? "applied" : "ignored";
  });

/** Repair everything: remove all active registry state in one transaction. */
export const clearAllSessions = (db: Database): MutationResult =>
  inWriteTransaction(db, () => {
    db.run("DELETE FROM active_sessions");
    return "applied";
  });

export type SessionTitleUpdate = {
  provider: Provider;
  sessionId: string;
  title: string;
};

export type SessionModelUpdate = {
  provider: Provider;
  sessionId: string;
  model: string;
};

/** The registry fields the daemon's session-facts resolver needs per top-level row. */
export type TitleTarget = {
  provider: Provider;
  sessionId: string;
  title: string | null;
  /** Stored model id, for the differs-check that skips no-op write-backs. */
  model: string | null;
  transcriptPath: string | null;
};

/**
 * Refresh resolved titles in one transaction, skipping rows that already hold
 * the value. `updated_at` deliberately stays put: it records the last hook a
 * session produced, which is the signal the stale-session prune ages on, and a
 * daemon-side title write must not extend a dead session's lease. Returns the
 * number of rows actually changed.
 */
export const updateSessionTitles = (db: Database, updates: readonly SessionTitleUpdate[]): number =>
  inWriteTransaction(db, () => {
    let changed = 0;
    for (const update of updates) {
      const result = db.run(
        "UPDATE active_sessions SET title = ? WHERE provider = ? AND session_id = ? AND title IS NOT ?",
        [update.title, update.provider, update.sessionId, update.title],
      );
      changed += result.changes;
    }
    return changed;
  });

/** The Paseo overlay's validated input: loader output narrowed to a known provider. */
export type PaseoSyncState = {
  provider: Provider;
  sessionId: string;
  agentId: string;
  requiresAttention: boolean;
  isSubagent: boolean;
};

/**
 * Mirror Paseo's per-agent attention state onto matching top-level rows and
 * (back)fill their origin. requiresAttention=false clears unread (the user
 * viewed the session in Paseo — view marks read); true sets unread only when
 * currently null, preserving the first-news timestamp. A difference-guard in
 * the WHERE keeps unchanged rows from counting (the daemon's
 * maintenance-changed signal feeds the reprojection fast-path). Never
 * creates rows and never touches updated_at.
 */
export const syncPaseoStates = (db: Database, states: readonly PaseoSyncState[], now: string): number =>
  inWriteTransaction(db, () => {
    let changed = 0;
    for (const state of states) {
      const result = db.run(
        `UPDATE active_sessions
         SET origin_kind = 'paseo', origin_ref = ?, origin_subagent = ?,
             unread_since = CASE WHEN ? THEN COALESCE(unread_since, ?) ELSE NULL END
         WHERE provider = ? AND session_id = ? AND parent_session_id IS NULL
           AND (
             origin_kind IS NOT 'paseo' OR origin_ref IS NOT ? OR origin_subagent IS NOT ?
             OR (? AND unread_since IS NULL)
             OR (? AND unread_since IS NOT NULL)
           )`,
        [
          state.agentId,
          state.isSubagent ? 1 : 0,
          state.requiresAttention ? 1 : 0,
          now,
          state.provider,
          state.sessionId,
          state.agentId,
          state.isSubagent ? 1 : 0,
          state.requiresAttention ? 1 : 0,
          state.requiresAttention ? 0 : 1,
        ],
      );
      changed += result.changes;
    }
    return changed;
  });

/**
 * Refresh resolved models in one transaction, skipping rows that already hold
 * the value. `updated_at` deliberately stays put: it records the last hook a
 * session produced, which is the signal the stale-session prune ages on, and a
 * daemon-side model write must not extend a dead session's lease, matching
 * `updateSessionTitles`. Returns the number of rows actually changed.
 */
export const updateSessionModels = (db: Database, updates: readonly SessionModelUpdate[]): number =>
  inWriteTransaction(db, () => {
    let changed = 0;
    for (const update of updates) {
      const result = db.run(
        "UPDATE active_sessions SET model = ? WHERE provider = ? AND session_id = ? AND model IS NOT ?",
        [update.model, update.provider, update.sessionId, update.model],
      );
      changed += result.changes;
    }
    return changed;
  });

/**
 * Remove every top-level row whose last hook predates its provider's cutoff,
 * cascading to children. zcode has no SessionEnd hook, so its rows lease out
 * on a shorter cutoff supplied by the caller; `zcodeCutoffIso` defaults to
 * `cutoffIso` so operator-driven single-cutoff prunes (`sessions prune`)
 * apply one age to every provider. `updated_at` holds an ISO-8601 UTC
 * timestamp, so the lexical comparison is chronological. Returns the number
 * of stale top-level rows (SQLite's own change count would also include
 * cascade-deleted children).
 */
export const pruneStaleSessions = (db: Database, cutoffIso: string, zcodeCutoffIso: string = cutoffIso): number =>
  inWriteTransaction(db, () => {
    const stale = db
      .query(
        `SELECT COUNT(*) AS n FROM active_sessions
         WHERE parent_session_id IS NULL AND (
           (provider = 'zcode' AND updated_at < ?) OR (provider != 'zcode' AND updated_at < ?)
         )`,
      )
      .get(zcodeCutoffIso, cutoffIso) as { n: number } | null;
    const count = stale?.n ?? 0;
    if (count > 0) {
      db.run(
        `DELETE FROM active_sessions
         WHERE parent_session_id IS NULL AND (
           (provider = 'zcode' AND updated_at < ?) OR (provider != 'zcode' AND updated_at < ?)
         )`,
        [zcodeCutoffIso, cutoffIso],
      );
    }
    return count;
  });
