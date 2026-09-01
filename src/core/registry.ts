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
 * The database holds active state only: SubagentStop deletes child rows,
 * and the daemon's age-based prune plus the manual
 * `clearSession`/`clearAllSessions`/`pruneStaleSessions` repairs delete
 * trees — prune skipping any tree that still holds an unviewed result or
 * a live view clock (a viewed finished result awaiting its expiry). A
 * Stop or StopFailure always retains its row; SessionEnd always deletes
 * the top-level row and its native descendants. Slots are never compacted;
 * a new top-level row receives the
 * lowest free positive slot found from the sorted non-null slot list.
 *
 * The unread ledger records results the user has not viewed: a turn ending
 * (Stop settling to idle, StopFailure, or the Paseo missed-completion
 * repair) stamps `unread_since`, and the complete in-place clearing list is:
 * a dealerboard view (`viewSession`), a dismissal (`acknowledgeSession`), a
 * reused SessionStart, and the viewed-expiry sweep. Session close, Paseo
 * archive, and manual clear delete the row instead.
 * A passive Paseo view never touches it. Prompts and status events never
 * mark a session read. Unread drives the badge/styling channel: reading a
 * result never removes the card at view time, but the view starts the
 * expiry clock — a viewed done/errored card auto-dismisses 24h later —
 * while an unviewed result is exempt from the stale prune.
 *
 * The done ledger records finished results still owed a board slot: a Stop
 * settling to idle stamps `done_since` (so do the Paseo missed-completion
 * repair and a landing Paseo attention flag), and only an explicit dismissal
 * (`acknowledgeSession`), a reused SessionStart, or the viewed-expiry sweep
 * clears it in place. Session close, Paseo archive, and manual clear delete
 * the row. `done_since` (or an `error` status) is what holds a finished card.
 *
 * The viewed ledger starts the expiry clock: only a dealerboard view
 * gesture (`viewSession`) stamps `viewed_since`, and every view restamps
 * it. Any event stamping a fresh result clears it — the card is unviewed
 * again. Done/errored rows auto-dismiss 24h after the most recent view;
 * unviewed rows never expire.
 *
 * `status_since` records the row's own last status change: status events
 * restamp it only when the status value changes, BackgroundWork events never
 * do, and starts initialize it.
 */

import type { Database } from "bun:sqlite";
import type { Provider, RegistryEvent, SessionOriginKind, SessionStatus } from "../protocol";
import type { EvenerCollectorUpdate } from "./evener";
import type { PaseoAgentStatus } from "./paseo";
import { resolvePaseoParentLinks } from "./projection";

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
  originKind: SessionOriginKind | null;
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
  origin_kind: SessionOriginKind | null;
  origin_ref: string | null;
  origin_subagent: number;
  origin_parent_ref: string | null;
  unread_since: string | null;
  ended_at: string | null;
  opened_at: string;
  updated_at: string;
};

const COLUMNS =
  "provider, session_id, parent_session_id, status, title, project, logical_slot, opened_at, updated_at, ghostty_terminal_id, background_outstanding, transcript_path, model, origin_kind, origin_ref, origin_subagent, unread_since";

const getRow = (db: Database, provider: Provider, sessionId: string): SessionRow | null =>
  db
    // origin_parent_ref and ended_at postdate COLUMNS (schema v7 and v17)
    // and the INSERT column lists stay frozen — select them here so callers
    // can see the stored values.
    .query(`SELECT ${COLUMNS}, origin_parent_ref, ended_at FROM active_sessions WHERE provider = ? AND session_id = ?`)
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
    // The reuse is also a view and a new life: unread, done, the end mark,
    // and the view clock clear, and a fresh non-null origin replaces the
    // stored one (null new evidence keeps it) while resetting the subagent
    // bit and clearing the parent ref.
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
           background_outstanding = 0, unread_since = NULL, done_since = NULL,
           ended_at = NULL, viewed_since = NULL,
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
 * and only that transition lands a result, so it alone stamps `unread_since`
 * (the user has not viewed it) and `done_since` (the board still owes it a
 * card). The landed result is unviewed news: it also cancels `viewed_since`,
 * putting a viewed card back in the unviewed state.
 */
const applyStop = (db: Database, event: StatusEvent): MutationResult => {
  const result = db.run(
    `UPDATE active_sessions
     SET status = CASE WHEN background_outstanding = 1 THEN 'working' ELSE 'idle' END,
         unread_since = CASE WHEN background_outstanding = 1 THEN unread_since ELSE ? END,
         done_since = CASE WHEN background_outstanding = 1 THEN done_since ELSE ? END,
         viewed_since = CASE WHEN background_outstanding = 1 THEN viewed_since ELSE NULL END,
         status_since = CASE
           WHEN (background_outstanding = 1 AND status IS NOT 'working')
             OR (background_outstanding = 0 AND status IS NOT 'idle')
           THEN ? ELSE status_since END,
         updated_at = ?
     WHERE provider = ? AND session_id = ?`,
    [event.observedAt, event.observedAt, event.observedAt, event.observedAt, event.provider, event.sessionId],
  );
  return result.changes > 0 ? "applied" : "ignored";
};

/** A turn ended in failure: the error is itself an unread result, and it cancels the view clock with it. */
const applyStopFailure = (db: Database, event: StatusEvent): MutationResult => {
  const result = db.run(
    `UPDATE active_sessions
     SET status = 'error', unread_since = ?, viewed_since = NULL,
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

/** Apply Evener events and reconcile accepted archive and active-child snapshots atomically. */
export const applyEvenerCollectorUpdate = (db: Database, update: EvenerCollectorUpdate): MutationResult[] =>
  inWriteTransaction(db, () => {
    const results = update.events.map((event) => applyEvent(db, event));
    if (update.archivedRootSessionIds !== null) {
      const removeArchivedRoot = db.query(
        "DELETE FROM active_sessions WHERE provider = 'evener' AND parent_session_id IS NULL AND session_id = ?",
      );
      for (const sessionId of new Set(update.archivedRootSessionIds)) {
        removeArchivedRoot.run(sessionId);
      }
    }
    if (update.activeChildSessionIds === null) {
      return results;
    }

    const active = new Set(update.activeChildSessionIds);
    const existing = db
      .query("SELECT session_id FROM active_sessions WHERE provider = 'evener' AND parent_session_id IS NOT NULL")
      .all() as Array<{ session_id: string }>;
    const remove = db.query(
      "DELETE FROM active_sessions WHERE provider = 'evener' AND parent_session_id IS NOT NULL AND session_id = ?",
    );
    for (const row of existing) {
      if (!active.has(row.session_id)) {
        remove.run(row.session_id);
      }
    }
    return results;
  });

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
 * Repair one selected session: delete that composite identity — cascading
 * to its native descendants by foreign key AND to its resolved Paseo-linked
 * descendants (clearing an orchestrator clears its whole logical tree) —
 * inside one write transaction. Ambiguous refs are never followed
 * (projection-equivalent resolution). Never touches schema or recreates
 * the database.
 */
export const clearSession = (db: Database, provider: Provider, sessionId: string): MutationResult =>
  inWriteTransaction(db, () => {
    if (getRow(db, provider, sessionId) === null) {
      return "ignored";
    }
    deletePaseoSubtree(db, provider, sessionId);
    return "applied";
  });

/**
 * The causal content of a view/dismiss gesture: the unread stamp visible in
 * the snapshot the gesture was issued from. `null` (no watermark) is an
 * unconditional operator/deck gesture; `{ unreadSince: null }` is a causal
 * gesture issued from a snapshot with no unread — it consumes nothing and
 * protects anything that lands in transit.
 */
export type GestureWatermark = { unreadSince: string | null };

/**
 * The Paseo-lineage subtree seeded at one identity, walked with the exact
 * resolution the projection publishes (unique refs only, cycle members
 * excluded — see resolvePaseoParentLinks): a row the projection fail-safes
 * into its own root card is never mutated through an alleged parent. The
 * seed itself is always included (even when unknown or non-Paseo — the
 * caller's UPDATE then simply matches nothing). Native children are never
 * members (they publish null ledgers).
 */
const paseoSubtreeIdentities = (
  db: Database,
  provider: Provider,
  sessionId: string,
): Array<{ provider: Provider; sessionId: string }> => {
  const rows = db
    .query(
      `SELECT provider, session_id, origin_ref, origin_subagent, origin_parent_ref
         FROM active_sessions
        WHERE origin_kind = 'paseo' AND parent_session_id IS NULL`,
    )
    .all() as Array<{
    provider: Provider;
    session_id: string;
    origin_ref: string | null;
    origin_subagent: number;
    origin_parent_ref: string | null;
  }>;
  const links = resolvePaseoParentLinks(
    rows.map((row) => ({
      provider: row.provider,
      sessionId: row.session_id,
      originRef: row.origin_ref,
      originSubagent: row.origin_subagent,
      originParentRef: row.origin_parent_ref,
    })),
  );
  const childrenOf = new Map<string, string[]>();
  for (const [childKey, parentKey] of links) {
    const siblings = childrenOf.get(parentKey);
    if (siblings === undefined) {
      childrenOf.set(parentKey, [childKey]);
    } else {
      siblings.push(childKey);
    }
  }
  const identityOf = (key: string): { provider: Provider; sessionId: string } => {
    const separator = key.indexOf("\u0000");
    return { provider: key.slice(0, separator) as Provider, sessionId: key.slice(separator + 1) };
  };
  const seedKey = `${provider}\u0000${sessionId}`;
  const identities: Array<{ provider: Provider; sessionId: string }> = [];
  const visited = new Set<string>([seedKey]);
  const stack = [seedKey];
  for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
    identities.push(identityOf(key));
    for (const childKey of childrenOf.get(key) ?? []) {
      if (!visited.has(childKey)) {
        visited.add(childKey);
        stack.push(childKey);
      }
    }
  }
  return identities;
};

/** Delete one resolved Paseo subtree; native descendants cascade with each top-level row. */
const deletePaseoSubtree = (db: Database, provider: Provider, sessionId: string): number => {
  let changed = 0;
  // Resolve the lineage before deleting anything: the walk reads the Paseo
  // rows the deletes are about to remove.
  for (const identity of paseoSubtreeIdentities(db, provider, sessionId)) {
    const result = db.run("DELETE FROM active_sessions WHERE provider = ? AND session_id = ?", [
      identity.provider,
      identity.sessionId,
    ]);
    changed += result.changes;
  }
  return changed;
};

/**
 * View one session's result: the user's read gesture. Clears `unread_since`
 * (the badge) and stamps `viewed_since` (the expiry clock's only input);
 * `done_since` and status stay put, so the card remains on the board. Every
 * view restamps — repeated views restart the clock. Cascades to every
 * resolved Paseo-lineage descendant holding a ledger, all stamped at the
 * same instant so the subtree's clocks run together. A causal watermark
 * protects any result newer than the stamp the gesture's snapshot showed;
 * a null-stamp watermark (the snapshot showed no unread) consumes nothing.
 * A view that consumes a result (clears an unread stamp) advances
 * `acked_at` to the gesture instant; one that consumes nothing leaves it
 * alone. The gesture time — not the consumed stamp — is the right
 * watermark: Paseo stamps its attention flag for a turn-end slightly after
 * the local Stop, so a flag trailing the consumed stamp would otherwise
 * resurrect a card the user just viewed. It is safe because suppression
 * through `acked_at` never clears local state (the causal watermark is what
 * protects a result in transit), and the gesture instant can only postdate
 * what the user saw. Never touches `updated_at`.
 */
export const viewSession = (
  db: Database,
  provider: Provider,
  sessionId: string,
  viewedAt: string,
  watermark: GestureWatermark | null = null,
): MutationResult =>
  inWriteTransaction(db, () => {
    const causal = watermark === null ? 0 : 1;
    const wm = watermark?.unreadSince ?? null;
    let changed = 0;
    for (const identity of paseoSubtreeIdentities(db, provider, sessionId)) {
      const isTarget = identity.provider === provider && identity.sessionId === sessionId;
      // A row is consumable when the gesture is unconditional, when it has
      // no unread (it matches the snapshot the user saw), or when its unread
      // stamp is at or before the watermark. A causal null-stamp watermark
      // therefore consumes nothing: only unread-free rows match it. The
      // acked_at CASE reads unread_since before this statement clears it:
      // only a view that actually consumes a stamp advances the watermark.
      const result = isTarget
        ? db.run(
            `UPDATE active_sessions
             SET unread_since = NULL,
                 viewed_since = ?,
                 acked_at = CASE WHEN unread_since IS NOT NULL THEN ? ELSE acked_at END
             WHERE provider = ? AND session_id = ?
               AND (? = 0 OR unread_since IS NULL OR (? IS NOT NULL AND unread_since <= ?))`,
            [viewedAt, viewedAt, identity.provider, identity.sessionId, causal, wm, wm],
          )
        : db.run(
            `UPDATE active_sessions
             SET unread_since = NULL,
                 viewed_since = ?,
                 acked_at = CASE WHEN unread_since IS NOT NULL THEN ? ELSE acked_at END
             WHERE provider = ? AND session_id = ?
               AND (done_since IS NOT NULL OR unread_since IS NOT NULL)
               AND (? = 0 OR unread_since IS NULL OR (? IS NOT NULL AND unread_since <= ?))`,
            [viewedAt, viewedAt, identity.provider, identity.sessionId, causal, wm, wm],
          );
      changed += result.changes;
    }
    return changed > 0 ? "applied" : "ignored";
  });

/**
 * Dismiss one session's result: the user's explicit gesture that takes a
 * card off the board. Clears `unread_since`, `done_since`, and any residual
 * `viewed_since`; an error is itself a result, so dismissal retires it to
 * idle — with the background flag disarmed, like every other retirement.
 * Cascades the same semantics to every resolved Paseo-lineage descendant
 * (clears their ledgers, retires their errors; rows are never deleted).
 * Every row the dismissal reaches consumed something (a stamp cleared or an
 * error retired — the guard admits nothing else), so each advances
 * `acked_at` to the gesture instant; a dismiss that reaches nothing leaves
 * it alone. The gesture time — not the consumed stamp — is the right
 * watermark for the same reason as in `viewSession`: Paseo's attention
 * flag trails the local Stop by a beat, and a flag between the consumed
 * stamp and the gesture would otherwise resurrect the card the user just
 * flicked away. Suppression through `acked_at` never clears local state
 * (the causal watermark below protects a result in transit), and the
 * gesture instant can only postdate what the user saw.
 *
 * The causal watermark identifies the newest result the gesture's snapshot
 * showed: a row is consumable iff its current `unread_since` is null or at
 * or before the watermark. Consumption then clears the row's ledgers
 * together — the auxiliary `done_since` hold follows the result and never
 * gates it (an ended card's hold postdates its unread; a viewed done card
 * has no unread at all). A fresh result re-stamps `unread_since` newer than
 * the watermark and protects the whole row. No watermark is unconditional
 * (operator CLI, deck press). The retirement's `status_since` is the
 * gesture time. Never touches updated_at.
 */
export const acknowledgeSession = (
  db: Database,
  provider: Provider,
  sessionId: string,
  ackedAt: string,
  watermark: GestureWatermark | null = null,
): MutationResult =>
  inWriteTransaction(db, () => {
    const causal = watermark === null ? 0 : 1;
    const wm = watermark?.unreadSince ?? null;
    let changed = 0;
    for (const identity of paseoSubtreeIdentities(db, provider, sessionId)) {
      const result = db.run(
        `UPDATE active_sessions
         SET unread_since = NULL,
             done_since = NULL,
             viewed_since = NULL,
             acked_at = ?,
             status = CASE WHEN status = 'error' THEN 'idle' ELSE status END,
             status_since = CASE WHEN status = 'error' THEN ? ELSE status_since END,
             background_outstanding = CASE WHEN status = 'error' THEN 0 ELSE background_outstanding END
         WHERE provider = ? AND session_id = ?
           AND (unread_since IS NOT NULL OR done_since IS NOT NULL OR status = 'error')
           AND (? = 0 OR unread_since IS NULL OR (? IS NOT NULL AND unread_since <= ?))`,
        [
          ackedAt, // acked_at: the gesture instant (every matched row consumed something)
          ackedAt, // error retirement's status_since (gesture time)
          identity.provider,
          identity.sessionId,
          causal,
          wm,
          wm, // causal guard on the result identity (unread_since)
        ],
      );
      changed += result.changes;
    }
    return changed > 0 ? "applied" : "ignored";
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
 *   already viewed a newer state — and never resurrects unread. A flag
 *   that lands is a result the user must process: the row also takes a
 *   done hold at the flag time (`COALESCE(done_since, flagTime)`) so the
 *   card outlives its own badge until dismissed or expired.
 * - A cleared or absent-flag record is a passive view and is inert: it
 *   stamps origin but never touches board ledgers — only dealerboard
 *   gestures, session restart, or expiry clear them. An archived record
 *   (`archivedAt` set) is authoritative lifecycle termination: it deletes
 *   the exact row and its resolved Paseo and native descendants without
 *   timestamp gating.
 * - A settled record (`lastStatus` idle or closed — no turn can be in
 *   flight) whose `updatedAt` is strictly newer than the row's last hook
 *   retires a stuck working or waiting row to idle: its turn-end hook was
 *   missed (interrupt, host sleep, daemon swap) and Paseo's record is the
 *   newer witness. Error rows keep their failure visible. `status_since`
 *   adopts the record's settle time; the repaired turn's result stamps unread
 *   alongside done unless the record is older than the row's ack or either
 *   existing ledger stamp, so the settlement badges the card without
 *   regressing newer news.
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
 * Origin stamping (kind/ref/subagent) and `origin_parent_ref` stays
 * unconditional for matched live top-level rows. A difference-guard in the
 * WHERE — its terms mirror the guarded writes exactly — keeps unchanged rows from
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
      if (state.archivedAt !== null) {
        changed += deletePaseoSubtree(db, state.provider, state.sessionId);
        continue;
      }
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
      if (state.requiresAttention) {
        // Flagged: set unread only when currently null, to the flag time —
        // and only when the flag postdates the last ack, so a stale flag can
        // never resurrect a session the user already marked read. A flag
        // that actually lands (the same condition that cancels the view
        // clock) is a result the user must process: it also takes a done
        // hold at the flag time (an existing hold is kept), so the card
        // stays on the board after its badge is viewed away, until it is
        // dismissed or expires — an idle row whose only hold was the flag
        // would otherwise vanish the moment it was viewed.
        const flagTime = state.attentionTimestamp ?? state.updatedAt;
        const result = db.run(
          `UPDATE active_sessions
           SET origin_kind = 'paseo', origin_ref = ?, origin_subagent = ?, origin_parent_ref = ?,
               unread_since = CASE
                 WHEN ? IS NOT NULL AND (acked_at IS NULL OR ? > acked_at) THEN COALESCE(unread_since, ?)
                 ELSE unread_since
               END,
               done_since = CASE
                 WHEN ? IS NOT NULL AND (acked_at IS NULL OR ? > acked_at) AND unread_since IS NULL
                 THEN COALESCE(done_since, ?)
                 ELSE done_since
               END,
               viewed_since = CASE
                 WHEN ? IS NOT NULL AND (acked_at IS NULL OR ? > acked_at) AND unread_since IS NULL THEN NULL
                 ELSE viewed_since
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
            state.parentAgentId, // origin stamp
            flagTime,
            flagTime,
            flagTime, // unread CASE (guard ×2 + value)
            flagTime,
            flagTime,
            flagTime, // done CASE (guard ×2 + value): the same landing condition as the view-clock cancel
            flagTime,
            flagTime, // viewed CASE (guard ×2)
            state.provider,
            state.sessionId, // identity
            state.agentId,
            state.isSubagent ? 1 : 0,
            state.parentAgentId, // origin difference-guard
            flagTime,
            flagTime, // landing difference-guard
          ],
        );
        changed += result.changes;
      } else {
        // Cleared or absent flag: a passive Paseo view — whether by the
        // user or by a parent agent consuming its children — is inert.
        // Origin stamping stays unconditional for matched top-level rows;
        // board ledgers are untouched.
        const origin = db.run(
          `UPDATE active_sessions
           SET origin_kind = 'paseo', origin_ref = ?, origin_subagent = ?, origin_parent_ref = ?
           WHERE provider = ? AND session_id = ? AND parent_session_id IS NULL
             AND (
               origin_kind IS NOT 'paseo' OR origin_ref IS NOT ? OR origin_subagent IS NOT ?
               OR origin_parent_ref IS NOT ?
             )`,
          [
            state.agentId,
            state.isSubagent ? 1 : 0,
            state.parentAgentId,
            state.provider,
            state.sessionId,
            state.agentId,
            state.isSubagent ? 1 : 0,
            state.parentAgentId,
          ],
        );
        changed += origin.changes;
      }
      // A settled record strictly newer than the row's last hook repairs a
      // missed turn-end: retire working/waiting to idle with the record's
      // settle time as status_since. updated_at (the prune lease) stays put
      // like every other maintenance write, and the strict comparison keeps
      // a record written before the row's newest hook from undoing a turn
      // that genuinely started since. A background-armed row holds out until
      // its last hook predates the caller's cutoff — then the lost TaskStop
      // is presumed and the flag disarms with the retirement.
      // The repaired turn still landed a result, so the retirement stamps
      // done_since and unread_since like the Stop it stands in for — the
      // settlement badges the card instead of holding it silently — and
      // clears any stale viewed clock. Unless the stamp predates the row's
      // acked_at (the user already dismissed what the record reports), or
      // either existing ledger stamp is newer (a stale settle never regresses
      // news that landed after it).
      if (state.lastStatus !== null && SETTLED_PASEO_STATUSES.has(state.lastStatus) && state.updatedAt !== null) {
        const doneStamp = state.updatedAt;
        const settled = db.run(
          `UPDATE active_sessions
           SET status = 'idle', status_since = ?, background_outstanding = 0,
               done_since = CASE
                 WHEN ? IS NOT NULL AND (acked_at IS NULL OR ? > acked_at)
                   AND (unread_since IS NULL OR ? > unread_since)
                   AND (done_since IS NULL OR ? > done_since)
                 THEN ? ELSE done_since END,
               unread_since = CASE
                 WHEN ? IS NOT NULL AND (acked_at IS NULL OR ? > acked_at)
                   AND (unread_since IS NULL OR ? > unread_since)
                   AND (done_since IS NULL OR ? > done_since)
                 THEN ? ELSE unread_since END,
               viewed_since = CASE
                 WHEN ? IS NOT NULL AND (acked_at IS NULL OR ? > acked_at)
                   AND (unread_since IS NULL OR ? > unread_since)
                   AND (done_since IS NULL OR ? > done_since)
                 THEN NULL ELSE viewed_since END
           WHERE provider = ? AND session_id = ? AND parent_session_id IS NULL
             AND status IN ('working', 'waiting')
             AND ? > updated_at
             AND (background_outstanding = 0 OR (? IS NOT NULL AND updated_at < ?))`,
          [
            state.updatedAt, // status_since: the record's settle time
            // One shared stamp condition per CASE: the settle stamp
            // postdates the ack AND both existing ledger stamps, so a
            // stale settlement never regresses newer news and the view
            // clock clears only when a stamp actually lands.
            doneStamp,
            doneStamp,
            doneStamp,
            doneStamp,
            doneStamp, // done CASE (guard ×4 + value)
            doneStamp,
            doneStamp,
            doneStamp,
            doneStamp,
            doneStamp, // unread CASE (guard ×4 + value)
            doneStamp,
            doneStamp,
            doneStamp,
            doneStamp, // viewed clear (guard ×4)
            state.provider,
            state.sessionId, // identity
            state.updatedAt, // freshness: strictly newer than the last hook
            backgroundSettleCutoffIso,
            backgroundSettleCutoffIso, // background grace
          ],
        );
        changed += settled.changes;
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
 * Remove every top-level row whose whole tree is stale, cascading to children.
 * zcode has no SessionEnd hook, so its rows lease out on a shorter cutoff
 * supplied by the caller; `zcodeCutoffIso` defaults to `cutoffIso` so
 * operator-driven single-cutoff prunes (`sessions prune`) apply one age to
 * every provider. A row inside its lease keeps its whole connected component
 * alive, and so does any row holding an unviewed result (`unread_since`
 * non-null) or a live view clock (`viewed_since` non-null on a row still
 * holding a finished result — `done_since` or an `error` status) — the
 * native tree joined with the resolved Paseo tree. Legacy ended rows are
 * removed because a closed session no longer belongs on the board. Otherwise
 * prune is liveness cleanup, never a purge of results the user has not seen,
 * and never a shortcut past the 24h post-view expiry that owns a viewed
 * result's removal. The clock's age is not compared here: the daemon runs
 * `sweepExpiredResults` before prune on the same tick, so an overdue clock
 * is already dismissed by the time prune looks; a standalone operator
 * `sessions prune` may therefore leave an overdue clocked row in place
 * until the next daemon sweep. The operator's intentional purges are
 * clear/clear-all and dismiss/archive. `updated_at` holds an ISO-8601 UTC
 * timestamp, so the lexical comparison is chronological. Returns the number
 * of stale top-level rows (SQLite's own change count would also include
 * cascade-deleted children).
 */
export const pruneStaleSessions = (db: Database, cutoffIso: string, zcodeCutoffIso: string = cutoffIso): number =>
  inWriteTransaction(db, () => {
    // A connected component — the native tree joined with the resolved
    // Paseo tree — is kept or pruned as one unit: a row inside its lease,
    // holding an unviewed result, or running a live view clock keeps its
    // whole component (ancestors, descendants, and Paseo siblings alike).
    // Prune is liveness cleanup, never a purge of results the user has not
    // seen or has not yet had the post-view window to act on.
    const rows = db
      .query(
        `SELECT provider, session_id, parent_session_id, updated_at, unread_since,
                done_since, viewed_since, ended_at, status,
                origin_kind, origin_ref, origin_subagent, origin_parent_ref
           FROM active_sessions`,
      )
      .all() as Array<{
      provider: Provider;
      session_id: string;
      parent_session_id: string | null;
      updated_at: string;
      unread_since: string | null;
      done_since: string | null;
      viewed_since: string | null;
      ended_at: string | null;
      status: SessionStatus;
      origin_kind: string | null;
      origin_ref: string | null;
      origin_subagent: number;
      origin_parent_ref: string | null;
    }>;
    const keyOf = (provider: string, sessionId: string): string => `${provider}\u0000${sessionId}`;
    // Undirected adjacency: native parent_session_id edges (both ways) plus
    // the resolved Paseo links (both ways — a live child keeps its quiet
    // parent, and an unviewed child keeps its siblings).
    const neighbors = new Map<string, string[]>();
    const link = (a: string, b: string): void => {
      const aList = neighbors.get(a);
      if (aList === undefined) {
        neighbors.set(a, [b]);
      } else {
        aList.push(b);
      }
      const bList = neighbors.get(b);
      if (bList === undefined) {
        neighbors.set(b, [a]);
      } else {
        bList.push(a);
      }
    };
    for (const row of rows) {
      if (row.parent_session_id !== null) {
        link(keyOf(row.provider, row.session_id), keyOf(row.provider, row.parent_session_id));
      }
    }
    const paseoLinks = resolvePaseoParentLinks(
      rows
        .filter((row) => row.origin_kind === "paseo" && row.parent_session_id === null)
        .map((row) => ({
          provider: row.provider,
          sessionId: row.session_id,
          originRef: row.origin_ref,
          originSubagent: row.origin_subagent,
          originParentRef: row.origin_parent_ref,
        })),
    );
    for (const [childKey, parentKey] of paseoLinks) {
      link(childKey, parentKey);
    }
    // Seeds: rows inside their lease, rows holding unviewed results, and
    // rows whose view clock is live — a viewed finished result (done, or an
    // error) that the expiry sweep, not the prune, will release.
    const keep = new Set<string>();
    const stack: string[] = [];
    for (const row of rows) {
      const inLease = row.provider === "zcode" ? row.updated_at >= zcodeCutoffIso : row.updated_at >= cutoffIso;
      const liveViewClock = row.viewed_since !== null && (row.done_since !== null || row.status === "error");
      if (inLease || row.unread_since !== null || liveViewClock) {
        const key = keyOf(row.provider, row.session_id);
        if (!keep.has(key)) {
          keep.add(key);
          stack.push(key);
        }
      }
    }
    for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
      for (const next of neighbors.get(key) ?? []) {
        if (!keep.has(next)) {
          keep.add(next);
          stack.push(next);
        }
      }
    }
    // Only top-level rows are deleted; their native children cascade. Legacy
    // ended rows predate the always-delete SessionEnd contract, so maintenance
    // removes them even if their ledgers seeded `keep`.
    let count = 0;
    for (const row of rows) {
      if (row.parent_session_id === null && (row.ended_at !== null || !keep.has(keyOf(row.provider, row.session_id)))) {
        db.run("DELETE FROM active_sessions WHERE provider = ? AND session_id = ?", [row.provider, row.session_id]);
        count += 1;
      }
    }
    return count;
  });

/**
 * The viewed-expiry sweep: auto-dismiss every idle or error row whose most
 * recent view is at or before the caller's cutoff and that still holds a
 * finished result — `done_since` or an `error` status. Clears the ledgers
 * (including any residual unread) and retires errors like a dismissal,
 * stamping the retirement's `status_since` with `sweptAt` — the sweep's own
 * instant, never the cutoff. The clock runs from the most recent view;
 * wall-clock time counts — sleep and daemon downtime included — because
 * expiry evaluates on the next tick using the cutoff the caller computes
 * from now. Rows never viewed (`viewed_since` null) are never swept, and
 * neither are rows holding unread news (unviewed by definition — a
 * defensive guard: every fresh-result path already clears the clock) or
 * working/waiting rows: a resumed turn can retain a stale done ledger, and
 * expiry must not delete an active card's result. Returns the rows swept.
 */
export const sweepExpiredResults = (db: Database, cutoffIso: string, sweptAt: string): number =>
  inWriteTransaction(db, () => {
    const result = db.run(
      `UPDATE active_sessions
       SET done_since = NULL, unread_since = NULL, viewed_since = NULL,
           status = CASE WHEN status = 'error' THEN 'idle' ELSE status END,
           status_since = CASE WHEN status = 'error' THEN ? ELSE status_since END,
           background_outstanding = CASE WHEN status = 'error' THEN 0 ELSE background_outstanding END
       WHERE viewed_since IS NOT NULL AND viewed_since <= ?
         AND unread_since IS NULL
         AND status IN ('idle', 'error')
         AND (done_since IS NOT NULL OR status = 'error')`,
      [sweptAt, cutoffIso],
    );
    return result.changes;
  });
