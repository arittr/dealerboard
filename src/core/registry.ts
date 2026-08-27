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
 * The database holds active state only: SessionEnd and SubagentStop delete
 * rows, as do the daemon's age-based prune and the manual
 * `clearSession`/`clearAllSessions`/`pruneStaleSessions` repairs; a Stop or
 * StopFailure retains the row — it stamps `unread_since` instead — so a
 * missed end event leaves a stale row until one of those repairs it.
 * Slots are never compacted; a new top-level row receives the
 * lowest free positive slot found from the sorted non-null slot list.
 *
 * The unread ledger records results the user has not viewed: a turn ending
 * (Stop settling to idle, or StopFailure) stamps `unread_since`, and only an
 * explicit view clears it — `acknowledgeSession` or a reused SessionStart.
 * Prompts and status events never mark a session read.
 *
 * `status_since` records the row's own last status change: status events
 * restamp it only when the status value changes, BackgroundWork events never
 * do, and starts initialize it.
 */

import type { Database } from "bun:sqlite";
import type { Provider, RegistryEvent, SessionStatus } from "../protocol";
import type { PaseoAgentStatus } from "./paseo";

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
  origin_parent_ref: string | null;
  unread_since: string | null;
  opened_at: string;
  updated_at: string;
};

const COLUMNS =
  "provider, session_id, parent_session_id, status, title, project, logical_slot, opened_at, updated_at, ghostty_terminal_id, background_outstanding, transcript_path, model, origin_kind, origin_ref, origin_subagent, unread_since";

const getRow = (db: Database, provider: Provider, sessionId: string): SessionRow | null =>
  db
    // origin_parent_ref postdates COLUMNS (schema v7) and the INSERT column
    // lists stay frozen — select it here so the SessionObserved difference
    // guard can see the stored value.
    .query(`SELECT ${COLUMNS}, origin_parent_ref FROM active_sessions WHERE provider = ? AND session_id = ?`)
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
    // the subagent bit and clearing the parent ref.
    // A null event model never clears the stored one (COALESCE): providers
    // that omit the field on resume must not erase what an earlier start
    // stored. A paseo-origin row keeps its stored title — the overlay owns
    // it (see applySessionTitleChanged), and a restarted provider process
    // would re-push its own title over a user's Paseo rename.
    db.run(
      `UPDATE active_sessions
       SET status = 'idle',
           title = CASE WHEN origin_kind IS 'paseo' THEN title ELSE ? END,
           project = ?, ghostty_terminal_id = ?, transcript_path = ?,
           background_outstanding = 0, unread_since = NULL,
           status_since = CASE WHEN status IS NOT 'idle' THEN ? ELSE status_since END,
           origin_kind = COALESCE(?, origin_kind),
           origin_ref = CASE WHEN ? IS NOT NULL THEN ? ELSE origin_ref END,
           origin_subagent = CASE WHEN ? IS NOT NULL THEN 0 ELSE origin_subagent END,
           origin_parent_ref = CASE WHEN ? IS NOT NULL THEN NULL ELSE origin_parent_ref END,
           updated_at = ?, model = COALESCE(?, model)
       WHERE provider = ? AND session_id = ?`,
      [
        event.title,
        event.project,
        ghosttyTerminalId,
        event.transcriptPath,
        event.observedAt,
        event.origin?.kind ?? null,
        event.origin?.kind ?? null,
        event.origin?.ref ?? null,
        event.origin?.kind ?? null,
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
       (${COLUMNS}, status_since)
     VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, NULL, ?)`,
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
      event.observedAt,
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
  // The exceptions are transcript_path, model, and origin: a non-null event
  // value that differs from the stored one overwrites it — the transcript
  // path unlocks title resolution, a provider whose prompt event carries a
  // model fills the label on a row that started without one, and a fresh
  // non-null origin replaces the stored one (resetting the subagent bit and
  // clearing a stale parent ref) with SessionStart's semantics, refreshing
  // routing on a late join.
  // Null event values never clear what is already stored, and a row whose
  // observed event would change nothing reports "ignored".
  const existing = getRow(db, event.provider, event.sessionId);
  if (existing !== null) {
    const origin = event.origin ?? null;
    // A same-kind/ref origin with no subagent bit still carries fresh
    // evidence: the reset it applies (subagent 0, parent ref null) differs
    // from the stored row while origin_parent_ref is set, so the stale
    // parent must count toward the refresh decision.
    const refreshOrigin =
      origin !== null &&
      (existing.origin_kind !== origin.kind ||
        existing.origin_ref !== origin.ref ||
        existing.origin_subagent !== 0 ||
        existing.origin_parent_ref !== null);
    const backfillModel = event.model !== null && existing.model !== event.model;
    const backfillTranscript = event.transcriptPath !== null && existing.transcript_path !== event.transcriptPath;
    if (refreshOrigin || backfillModel || backfillTranscript) {
      db.run(
        `UPDATE active_sessions
         SET transcript_path = COALESCE(?, transcript_path), model = COALESCE(?, model),
             origin_kind = COALESCE(?, origin_kind), origin_ref = COALESCE(?, origin_ref),
             origin_subagent = CASE WHEN ? IS NOT NULL THEN 0 ELSE origin_subagent END,
             origin_parent_ref = CASE WHEN ? IS NOT NULL THEN NULL ELSE origin_parent_ref END
         WHERE provider = ? AND session_id = ?`,
        [
          event.transcriptPath,
          event.model,
          origin?.kind ?? null,
          origin?.ref ?? null,
          origin?.kind ?? null,
          origin?.kind ?? null,
          event.provider,
          event.sessionId,
        ],
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
  // Paseo-origin rows take titles from the overlay alone: its record title
  // (which carries user renames) rewrites every pass, so a provider-side
  // title would only flash for one pass and then lose — oscillating forever
  // against a provider that keeps re-pushing its own title.
  const result = db.run(
    "UPDATE active_sessions SET title = ? WHERE provider = ? AND session_id = ? AND title IS NOT ? AND origin_kind IS NOT 'paseo'",
    [event.title, event.provider, event.sessionId, event.title],
  );
  return result.changes > 0 ? "applied" : "ignored";
};

const isNonEmptyBoundedModel = (model: string): boolean => model.length > 0 && Array.from(model).length <= 256;

const applySessionModelChanged = (
  db: Database,
  event: Extract<RegistryEvent, { kind: "SessionModelChanged" }>,
): MutationResult => {
  if (!isNonEmptyBoundedModel(event.model)) {
    return "ignored";
  }
  const result = db.run(
    "UPDATE active_sessions SET model = ? WHERE provider = ? AND session_id = ? AND model IS NOT ?",
    [event.model, event.provider, event.sessionId, event.model],
  );
  return result.changes > 0 ? "applied" : "ignored";
};

/**
 * Reconcile an authoritative external snapshot without manufacturing a new
 * result. Live terminal events own unread_since; hydration and reconnect only
 * repair the current status while preserving that ledger.
 */
const applySessionStatusObserved = (
  db: Database,
  event: Extract<RegistryEvent, { kind: "SessionStatusObserved" }>,
): MutationResult => {
  const result = db.run(
    `UPDATE active_sessions
     SET status = ?, status_since = ?, updated_at = ?
     WHERE provider = ? AND session_id = ? AND status IS NOT ?`,
    [event.status, event.observedAt, event.observedAt, event.provider, event.sessionId, event.status],
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
       SET parent_session_id = ?, status = 'idle', title = ?, project = ?,
           model = COALESCE(?, model),
           status_since = CASE WHEN status IS NOT 'idle' THEN ? ELSE status_since END,
           updated_at = ?
       WHERE provider = ? AND session_id = ?`,
      [
        event.parentSessionId,
        event.title,
        event.project,
        event.model,
        event.observedAt,
        event.observedAt,
        event.provider,
        event.sessionId,
      ],
    );
    return "applied";
  }
  db.run(
    `INSERT INTO active_sessions
       (${COLUMNS}, status_since)
     VALUES (?, ?, ?, 'idle', ?, ?, NULL, ?, ?, NULL, 0, NULL, ?, NULL, NULL, 0, NULL, ?)`,
    [
      event.provider,
      event.sessionId,
      event.parentSessionId,
      event.title,
      event.project,
      event.observedAt,
      event.observedAt,
      event.model,
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
  const result = db.run(
    `UPDATE active_sessions
     SET status = ?, updated_at = ?,
         status_since = CASE WHEN status IS NOT ? THEN ? ELSE status_since END
     WHERE provider = ? AND session_id = ?`,
    [status, event.observedAt, status, event.observedAt, event.provider, event.sessionId],
  );
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
         status_since = CASE
           WHEN (background_outstanding = 1 AND status IS NOT 'working')
             OR (background_outstanding = 0 AND status IS NOT 'idle')
           THEN ? ELSE status_since END,
         updated_at = ?
     WHERE provider = ? AND session_id = ?`,
    [event.observedAt, event.observedAt, event.observedAt, event.provider, event.sessionId],
  );
  return result.changes > 0 ? "applied" : "ignored";
};

/** A turn ended in failure: the error is itself an unread result. */
const applyStopFailure = (db: Database, event: StatusEvent): MutationResult => {
  const result = db.run(
    `UPDATE active_sessions
     SET status = 'error', unread_since = ?,
         status_since = CASE WHEN status IS NOT 'error' THEN ? ELSE status_since END,
         updated_at = ?
     WHERE provider = ? AND session_id = ?`,
    [event.observedAt, event.observedAt, event.observedAt, event.provider, event.sessionId],
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
    case "SessionModelChanged":
      return applySessionModelChanged(db, event);
    case "SubagentStart":
      return applySubagentStart(db, event);
    case "SessionStatusObserved":
      return applySessionStatusObserved(db, event);
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
  return "ignored";
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
 * title, model, activity line, and transcript path. Children never carry
 * resolvable titles. Read-only.
 */
export const listTitleTargets = (db: Database): TitleTarget[] =>
  db
    .query(
      `SELECT provider, session_id, title, model, activity_line, transcript_path FROM active_sessions
       WHERE parent_session_id IS NULL
       ORDER BY logical_slot ASC`,
    )
    .all()
    .map((row) => {
      const { provider, session_id, title, model, activity_line, transcript_path } = row as {
        provider: Provider;
        session_id: string;
        title: string | null;
        model: string | null;
        activity_line: string | null;
        transcript_path: string | null;
      };
      return {
        provider,
        sessionId: session_id,
        title,
        model,
        activityLine: activity_line,
        transcriptPath: transcript_path,
      };
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

/**
 * Mark one session read: the user has viewed the latest result. The ack time
 * is recorded in `acked_at` so the Paseo overlay can never resurrect unread
 * from an attention flag raised before the view. An error is itself a result
 * (applyStopFailure), so viewing settles it: an error row retires to idle —
 * with the background flag disarmed, like every other retirement — instead of
 * shouting until the stale prune. A source still in error re-raises it through
 * its own status events. Never touches updated_at.
 */
export const acknowledgeSession = (
  db: Database,
  provider: Provider,
  sessionId: string,
  ackedAt: string,
): MutationResult =>
  inWriteTransaction(db, () => {
    const result = db.run(
      `UPDATE active_sessions
       SET unread_since = NULL, acked_at = ?,
           status = CASE WHEN status = 'error' THEN 'idle' ELSE status END,
           status_since = CASE WHEN status = 'error' THEN ? ELSE status_since END,
           background_outstanding = CASE WHEN status = 'error' THEN 0 ELSE background_outstanding END
       WHERE provider = ? AND session_id = ? AND (unread_since IS NOT NULL OR status = 'error')`,
      [ackedAt, ackedAt, provider, sessionId],
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

export type SessionActivityLineUpdate = {
  provider: Provider;
  sessionId: string;
  activityLine: string;
};

/** The registry fields the daemon's session-facts resolver needs per top-level row. */
export type TitleTarget = {
  provider: Provider;
  sessionId: string;
  title: string | null;
  /** Stored model id, for the differs-check that skips no-op write-backs. */
  model: string | null;
  /** Stored activity line, for the differs-check that skips no-op write-backs. */
  activityLine: string | null;
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
      // Paseo-origin rows are the overlay's to title (see
      // applySessionTitleChanged); a resolved provider title would only
      // oscillate against the overlay's per-pass rewrite.
      const result = db.run(
        "UPDATE active_sessions SET title = ? WHERE provider = ? AND session_id = ? AND title IS NOT ? AND origin_kind IS NOT 'paseo'",
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
  /** The dispatching Paseo agent's id, or null for a top-level agent. */
  parentAgentId: string | null;
  /** When Paseo raised attention (ISO-8601 UTC), or null when unreported. */
  attentionTimestamp: string | null;
  /** When Paseo last wrote the record (ISO-8601 UTC), or null when unreported. */
  updatedAt: string | null;
  /** When the user archived the agent in Paseo (ISO-8601 UTC), or null while live. */
  archivedAt: string | null;
  /** Title from Paseo's agent record, or null when absent. */
  title: string | null;
  /** Paseo's persisted lifecycle (`lastStatus`), or null when unreported or unrecognized. */
  lastStatus: PaseoAgentStatus | null;
};

/**
 * Mirror Paseo's per-agent attention state onto matching top-level rows and
 * (back)fill their origin, under a watermark that keeps Paseo-side and local
 * news causally ordered (both sides stamp ISO-8601 UTC, so the string
 * comparison in the guards is chronological):
 *
 * - A flagged record (`requiresAttention` true) uses
 *   `attentionTimestamp ?? updatedAt` as its flag time. With neither
 *   timestamp the unread write is skipped entirely (origin stamping still
 *   happens — a timestamp-less flag is not dated news). With a flag time, a
 *   null `unread_since` adopts it and a non-null one is always kept: local
 *   news at least as new as the flag is never regressed or churned. A flag
 *   raised at or before the row's `acked_at` is stale news — the user
 *   already viewed a newer state — and never resurrects unread.
 * - A cleared or absent-flag record clears `unread_since` only when its
 *   `updatedAt` is present and strictly newer than the stored unread stamp:
 *   a stale or timestamp-less record is not proof of viewing, so an older
 *   clear can never undo a newer Stop and a missing flag never clears.
 * - An archived record (`archivedAt` set) takes the cleared path even while
 *   its attention flag is still up — archiving is the user's terminal
 *   gesture on an agent — with the later of `archivedAt` and `updatedAt` as
 *   the proof-of-viewing time under the same freshness guard.
 * - A settled record (`lastStatus` idle or closed — no turn can be in
 *   flight) whose `updatedAt` is strictly newer than the row's last hook
 *   retires a stuck working or waiting row to idle: its turn-end hook was
 *   missed (interrupt, host sleep, daemon swap) and Paseo's record is the
 *   newer witness. Error rows keep their failure visible — except when the
 *   record is archived: the terminal gesture settles an error row to idle
 *   too, under the same freshness guard with the later of `archivedAt` and
 *   `updatedAt` as the settle time. `status_since` adopts the record's
 *   settle time; unread stays the attention mirror's business.
 * - A background-armed row normally outlives its Stop on purpose — the
 *   shell still acts on the session's behalf, exactly as in applyStop. But
 *   the disarming edge (TaskStop) can be lost the same way the turn-end
 *   can, so a settled record may override the claim once the row's last
 *   hook is older than `backgroundSettleCutoffIso`: the completion is
 *   presumed lost, the row retires, and the flag disarms so a later Stop
 *   cannot re-stick it. Real background work that completes after the
 *   retirement still wakes a turn whose hooks re-raise working. Callers
 *   that pass no cutoff never settle background-armed rows.
 *
 * Origin stamping (kind/ref/subagent) (and now `origin_parent_ref`) stays
 * unconditional for matched top-level rows. A difference-guard in the WHERE
 * — its terms mirror the guarded writes exactly — keeps unchanged rows from
 * counting (the daemon's maintenance-changed signal feeds the reprojection
 * fast-path). Never creates rows and never touches updated_at.
 *
 * The agent's joined provider session is its ref's sole legitimate carrier:
 * any other top-level row still holding the ref was abandoned by
 * provider-session rotation (its SessionEnd was missed), and the duplicate
 * would make the projection roll-up drop the ref as ambiguous. Each pass
 * retires such rows to idle and clears any stale background-work marker while
 * preserving their ledger, titles, models, slots, and prune lease. A known
 * `updatedAt` restamps `status_since` for the retirement; `updated_at` remains
 * untouched. The cleanup runs only for a ref whose pass carries exactly one
 * joined provider session: records contradicting each other about an agent's
 * current session are ambiguous evidence, and picking a winner could strip a
 * still-valid row's routing.
 */
/** The later of two canonical ISO-8601 UTC instants (lexical order is chronological); null when both are absent. */
const laterInstant = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : a > b ? a : b;

/** Paseo lifecycle values with no turn in flight: proof a working row's turn-end was missed. */
const SETTLED_PASEO_STATUSES: ReadonlySet<PaseoAgentStatus> = new Set(["idle", "closed"]);

export const syncPaseoStates = (
  db: Database,
  states: readonly PaseoSyncState[],
  backgroundSettleCutoffIso: string | null = null,
): number =>
  inWriteTransaction(db, () => {
    let changed = 0;
    // The joined provider sessions each ref claims in this pass: rotation
    // cleanup runs only for refs with exactly one (see the contract above).
    const joinedByRef = new Map<string, Set<string>>();
    for (const state of states) {
      const joined = joinedByRef.get(state.agentId) ?? new Set<string>();
      joined.add(`${state.provider}\u0000${state.sessionId}`);
      joinedByRef.set(state.agentId, joined);
    }
    for (const state of states) {
      // Update title when Paseo provides one and it differs from the stored value.
      // This runs unconditionally before the attention sync so a title change
      // counts even when attention state is unchanged.
      if (state.title !== null) {
        const titleResult = db.run(
          "UPDATE active_sessions SET title = ? WHERE provider = ? AND session_id = ? AND title IS NOT ?",
          [state.title, state.provider, state.sessionId, state.title],
        );
        changed += titleResult.changes;
      }
      if (state.requiresAttention && state.archivedAt === null) {
        // Flagged: set unread only when currently null, to the flag time —
        // and only when the flag postdates the last ack, so a stale flag can
        // never resurrect a session the user already marked read.
        const flagTime = state.attentionTimestamp ?? state.updatedAt;
        const result = db.run(
          `UPDATE active_sessions
           SET origin_kind = 'paseo', origin_ref = ?, origin_subagent = ?, origin_parent_ref = ?,
               unread_since = CASE
                 WHEN ? IS NOT NULL AND (acked_at IS NULL OR ? > acked_at) THEN COALESCE(unread_since, ?)
                 ELSE unread_since
               END
           WHERE provider = ? AND session_id = ? AND parent_session_id IS NULL
             AND (
               origin_kind IS NOT 'paseo' OR origin_ref IS NOT ? OR origin_subagent IS NOT ?
               OR origin_parent_ref IS NOT ?
               OR (? IS NOT NULL AND (acked_at IS NULL OR ? > acked_at) AND unread_since IS NULL)
             )`,
          [
            state.agentId,
            state.isSubagent ? 1 : 0,
            state.parentAgentId,
            flagTime,
            flagTime,
            flagTime,
            state.provider,
            state.sessionId,
            state.agentId,
            state.isSubagent ? 1 : 0,
            state.parentAgentId,
            flagTime,
            flagTime,
          ],
        );
        changed += result.changes;
      } else {
        // Cleared, absent flag, or archived: only a record written (or
        // archived) after the local news is fresh proof that the user viewed
        // the session in Paseo.
        const clearTime = laterInstant(state.updatedAt, state.archivedAt);
        const result = db.run(
          `UPDATE active_sessions
           SET origin_kind = 'paseo', origin_ref = ?, origin_subagent = ?, origin_parent_ref = ?,
               unread_since = CASE WHEN ? IS NOT NULL AND ? > unread_since THEN NULL ELSE unread_since END
           WHERE provider = ? AND session_id = ? AND parent_session_id IS NULL
             AND (
               origin_kind IS NOT 'paseo' OR origin_ref IS NOT ? OR origin_subagent IS NOT ?
               OR origin_parent_ref IS NOT ?
               OR (unread_since IS NOT NULL AND ? IS NOT NULL AND ? > unread_since)
             )`,
          [
            state.agentId,
            state.isSubagent ? 1 : 0,
            state.parentAgentId,
            clearTime,
            clearTime,
            state.provider,
            state.sessionId,
            state.agentId,
            state.isSubagent ? 1 : 0,
            state.parentAgentId,
            clearTime,
            clearTime,
          ],
        );
        changed += result.changes;
      }
      // A settled record strictly newer than the row's last hook repairs a
      // missed turn-end: retire working/waiting to idle with the record's
      // settle time as status_since. updated_at (the prune lease) stays put
      // like every other maintenance write, and the strict comparison keeps
      // a record written before the row's newest hook from undoing a turn
      // that genuinely started since. A background-armed row holds out until
      // its last hook predates the caller's cutoff — then the lost TaskStop
      // is presumed and the flag disarms with the retirement.
      if (state.lastStatus !== null && SETTLED_PASEO_STATUSES.has(state.lastStatus) && state.updatedAt !== null) {
        const settled = db.run(
          `UPDATE active_sessions
           SET status = 'idle', status_since = ?, background_outstanding = 0
           WHERE provider = ? AND session_id = ? AND parent_session_id IS NULL
             AND status IN ('working', 'waiting')
             AND ? > updated_at
             AND (background_outstanding = 0 OR (? IS NOT NULL AND updated_at < ?))`,
          [
            state.updatedAt,
            state.provider,
            state.sessionId,
            state.updatedAt,
            backgroundSettleCutoffIso,
            backgroundSettleCutoffIso,
          ],
        );
        changed += settled.changes;
      }
      // An archived record settles an error row too: archiving is the user's
      // terminal gesture on the agent, so the failure has been seen and the
      // row retires like a settled working row — under the same strict
      // freshness guard, with the later of archivedAt/updatedAt as proof.
      if (state.archivedAt !== null) {
        const archiveTime = laterInstant(state.archivedAt, state.updatedAt);
        const archivedError = db.run(
          `UPDATE active_sessions
           SET status = 'idle', status_since = ?, background_outstanding = 0
           WHERE provider = ? AND session_id = ? AND parent_session_id IS NULL
             AND status = 'error' AND ? > updated_at`,
          [archiveTime, state.provider, state.sessionId, archiveTime],
        );
        changed += archivedError.changes;
      }
      // Un-stamp rows abandoned by provider-session rotation: every match
      // carries the stamp being cleared, so the WHERE is its own difference
      // guard, and updated_at (the prune lease) stays put.
      if (joinedByRef.get(state.agentId)?.size === 1) {
        const abandoned = db.run(
          `UPDATE active_sessions
           SET origin_kind = NULL, origin_ref = NULL, origin_subagent = 0, origin_parent_ref = NULL,
               status = 'idle', background_outstanding = 0,
               status_since = CASE WHEN status IS NOT 'idle' AND ? IS NOT NULL THEN ? ELSE status_since END
           WHERE origin_kind = 'paseo' AND origin_ref = ? AND parent_session_id IS NULL
             AND NOT (provider = ? AND session_id = ?)`,
          [state.updatedAt, state.updatedAt, state.agentId, state.provider, state.sessionId],
        );
        changed += abandoned.changes;
      }
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
 * Refresh resolved activity lines in one transaction, skipping rows that
 * already hold the value. `updated_at` deliberately stays put, matching
 * `updateSessionTitles`/`updateSessionModels`: a daemon-side maintenance
 * write must not extend a dead session's lease. Returns the number of rows
 * actually changed.
 */
export const updateSessionActivityLines = (db: Database, updates: readonly SessionActivityLineUpdate[]): number =>
  inWriteTransaction(db, () => {
    let changed = 0;
    for (const update of updates) {
      const result = db.run(
        "UPDATE active_sessions SET activity_line = ? WHERE provider = ? AND session_id = ? AND activity_line IS NOT ?",
        [update.activityLine, update.provider, update.sessionId, update.activityLine],
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
