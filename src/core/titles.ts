/**
 * Resolves session facts — titles and model ids — from provider state on
 * disk.
 *
 * Only Kimi and pi push titles through hooks; the other providers keep theirs
 * in files on disk. The daemon owns this resolver and
 * calls `resolve` on a cadence with the live top-level sessions:
 *
 * - Claude: the transcript JSONL (path stored on the registry row) carries
 *   `{"type":"ai-title","aiTitle":...}` records and assistant records whose
 *   `message.model` names the session's model. The file can grow to
 *   megabytes, so only the last 64 KiB (TAIL_BYTES) are read — one read
 *   serves both facts — and the last parseable ai-title and assistant
 *   records win. Results are cached per path on the (mtime, size) identity,
 *   so a pass over an unchanged transcript costs one stat.
 * - Codex: `~/.codex/session_index.jsonl` maps session ids to `thread_name`.
 *   The whole index is reparsed only when its (mtime, size) changes. Models
 *   come from `turn_context` records' `payload.model` in a tail read of the
 *   rollout JSONL at the row's `transcript_path`, cached per path on
 *   (mtime, size) the same way the Claude facts are.
 * - zcode: `db.sqlite` under the zcode home, re-queried per pass — WAL makes
 *   stat caching unsafe. zcode has no model source at all, so its rows never
 *   resolve one.
 * - omp: the fixed 256-byte title slot at the head of the session JSONL at the
 *   row's transcript_path, (mtime, size)-cached — every change to the file
 *   (appended records or the in-place slot rewrite) bumps its stat identity.
 *   No model source; omp rows never resolve one.
 * - grok: `summary.json` under the session's directory (found by globbing the
 *   sessions root), carrying `generated_title` (fallback `session_summary`)
 *   and `current_model_id`, (mtime, size)-cached like the other file readers.
 * - Kimi rows are never resolved here — hooks already deliver their titles
 *   and models.
 *
 * Resolution is additive: a found title or model is proposed only when it
 * differs from the stored one, and a missing value never clears an existing
 * one. Claude, Codex, and grok filesystem access flows through injected
 * dependencies so their tests use fakes; zcode opens its SQLite database
 * directly (read-only, one connection per pass) and its tests deliberately
 * use real fixture databases.
 */

import { Database } from "bun:sqlite";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionModelUpdate, SessionTitleUpdate, TitleTarget } from "./registry";

export const TAIL_BYTES = 64 * 1024;

const MAX_TITLE_CODE_POINTS = 256;

export type { SessionModelUpdate, SessionTitleUpdate, TitleTarget } from "./registry";

export type FileStat = { mtimeMs: number; size: number };

export type SessionFactsResolverDependencies = {
  codexIndexPath: string;
  /** zcode's SQLite store; resolved by the caller (ZCODE_HOME override lives in cli.ts). */
  zcodeDatabasePath: string;
  /** grok's sessions directory; resolved by the caller (GROK_HOME override lives in cli.ts). */
  grokSessionsRoot: string;
  statPath?: (path: string) => FileStat | null;
  readTail?: (path: string, maxBytes: number) => string | null;
  readWhole?: (path: string) => string | null;
  readHead?: (path: string, maxBytes: number) => string | null;
  listDirectories?: (path: string) => string[];
};

/** The facts one pass proposes: title and model updates, applied additively. */
export type SessionFacts = {
  titles: SessionTitleUpdate[];
  models: SessionModelUpdate[];
};

export type SessionFactsResolver = {
  resolve: (targets: readonly TitleTarget[]) => SessionFacts;
};

const defaultStatPath = (path: string): FileStat | null => {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
};

const defaultReadTail = (path: string, maxBytes: number): string | null => {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // A close failure has no bearing on the read result.
      }
    }
  }
};

const defaultReadHead = (path: string, maxBytes: number): string | null => {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // A close failure has no bearing on the read result.
      }
    }
  }
};

const defaultReadWhole = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const defaultListDirectories = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundTitle = (value: string): string => Array.from(value).slice(0, MAX_TITLE_CODE_POINTS).join("");

/**
 * Scans tail lines newest-first for records of the given type and returns the
 * latest non-empty string the extractor yields, bounded. Malformed or
 * truncated lines — the tail's first line usually starts mid-JSON — fall
 * through to the next older one.
 */
const lastFromTail = (
  tail: string,
  recordType: string,
  extract: (record: Record<string, unknown>) => unknown,
): string | null => {
  const marker = `"type":"${recordType}"`;
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || !line.includes(marker)) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && parsed["type"] === recordType) {
        const value = extract(parsed);
        if (typeof value === "string" && value.length > 0) {
          return boundTitle(value);
        }
      }
    } catch {
      // A truncated or malformed line falls through to the next older one.
    }
  }
  return null;
};

/** The last parseable ai-title line in the window wins; earlier lines may be truncated. */
const claudeTitleFromTail = (tail: string): string | null =>
  lastFromTail(tail, "ai-title", (record) => record["aiTitle"]);

/**
 * Only an assistant record's `message.model` is authoritative for the
 * session: tool-call inputs nested in the same records can carry their own
 * `model` argument (a subagent dispatch), so an unstructured scan would
 * resolve the decoy. The last parsed record wins — a mid-session model
 * switch changes it.
 */
const claudeModelFromTail = (tail: string): string | null =>
  lastFromTail(tail, "assistant", (record) => (isRecord(record["message"]) ? record["message"]["model"] : null));

/** Codex rollouts carry the turn's actual model on turn_context records' `payload.model`. */
const codexModelFromTail = (tail: string): string | null =>
  lastFromTail(tail, "turn_context", (record) => (isRecord(record["payload"]) ? record["payload"]["model"] : null));

/** omp's session JSONL reserves a fixed-size title slot at the head. */
export const OMP_SLOT_BYTES = 256;
const OMP_HEAD_BYTES = 4 * 1024;

/**
 * Parse the auto-generated title from the head of an omp session file. omp
 * reserves a fixed slot at byte 0: one `{"type":"title","v":1,"title":...,
 * "source":...,"updatedAt":...,"pad":...}` record whose "pad" field absorbs
 * the slack so the line is exactly OMP_SLOT_BYTES UTF-8 bytes including its
 * terminating newline, rewritten in place when the title changes (framing
 * pinned by the captured fixture test/fixtures/omp-session.jsonl). Files
 * without a slot-width first line fall back to the first parseable JSONL
 * line after it carrying a `title` field (e.g. a title_change record).
 */
const ompTitleFromHead = (head: string): string | null => {
  const lines = head.split("\n");
  const slot = lines[0] ?? "";
  if (Buffer.byteLength(slot, "utf8") + 1 === OMP_SLOT_BYTES) {
    try {
      const parsed: unknown = JSON.parse(slot);
      if (
        isRecord(parsed) &&
        parsed["type"] === "title" &&
        typeof parsed["title"] === "string" &&
        parsed["title"].length > 0
      ) {
        return boundTitle(parsed["title"]);
      }
    } catch {
      // Not a parseable slot record — fall through to the JSONL fallback.
    }
  }
  for (const line of lines.slice(1)) {
    if (line.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed["title"] === "string" && parsed["title"].length > 0) {
        return boundTitle(parsed["title"]);
      }
    } catch {
      // Malformed line — keep scanning.
    }
  }
  return null;
};

/**
 * grok keeps per-session metadata at sessions/<group>/<id>/summary.json.
 * The generated title is the user-visible one (also what /resume shows);
 * session_summary is the fallback. current_model_id is the live model.
 */
const grokFactsFromSummary = (content: string): { title: string | null; model: string | null } => {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) {
      return { title: null, model: null };
    }
    const generated = parsed["generated_title"];
    const summary = parsed["session_summary"];
    const model = parsed["current_model_id"];
    const title =
      typeof generated === "string" && generated.length > 0
        ? generated
        : typeof summary === "string" && summary.length > 0
          ? summary
          : null;
    return {
      title: title === null ? null : boundTitle(title),
      // Bounded like the title: the registry caps model at 256 characters, and
      // an abnormal oversized id would otherwise roll back the whole
      // model-update transaction.
      model: typeof model === "string" && model.length > 0 ? boundTitle(model) : null,
    };
  } catch {
    return { title: null, model: null };
  }
};

const codexTitlesFromIndex = (content: string): Map<string, string> => {
  const byId = new Map<string, string>();
  for (const line of content.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        isRecord(parsed) &&
        typeof parsed["id"] === "string" &&
        typeof parsed["thread_name"] === "string" &&
        parsed["thread_name"].length > 0
      ) {
        byId.set(parsed["id"], boundTitle(parsed["thread_name"]));
      }
    } catch {
      // Malformed lines are skipped; one bad line never voids the index.
    }
  }
  return byId;
};

/**
 * zcode stores auto-generated titles in its own SQLite database. The schema
 * names are pinned by live verification (Task 4 of the P1 plan); if that
 * probe finds different names, this constant is the only change.
 */
const ZCODE_TITLE_QUERY = "SELECT title FROM session WHERE id = ?";

/**
 * Read zcode titles in one per-pass read-only connection. zcode's database is
 * WAL, so committed titles can live in db.sqlite-wal without touching the main
 * file's stat — the (mtime, size) caching Claude/Codex use would go stale
 * indefinitely here, so every pass re-queries (one indexed lookup per live
 * zcode row on the daemon's 2s cadence). Any failure — missing file,
 * SQLITE_BUSY from zcode's writer, unexpected schema — skips the pass; the
 * next cadence retries.
 */
const readZcodeTitles = (databasePath: string, sessionIds: readonly string[]): Map<string, string> => {
  const titles = new Map<string, string>();
  let db: Database | null = null;
  try {
    db = new Database(databasePath, { readonly: true, create: false });
    const statement = db.query(ZCODE_TITLE_QUERY);
    for (const sessionId of sessionIds) {
      const row = statement.get(sessionId) as { title: unknown } | null;
      if (row !== null && typeof row.title === "string" && row.title.length > 0) {
        titles.set(sessionId, boundTitle(row.title));
      }
    }
  } catch {
    return new Map();
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // A close failure has no bearing on the titles already read; the
        // reader never throws regardless of how the pass ends.
      }
    }
  }
  return titles;
};

export const createSessionFactsResolver = (dependencies: SessionFactsResolverDependencies): SessionFactsResolver => {
  const statPath = dependencies.statPath ?? defaultStatPath;
  const readTail = dependencies.readTail ?? defaultReadTail;
  const readWhole = dependencies.readWhole ?? defaultReadWhole;
  const readHead = dependencies.readHead ?? defaultReadHead;
  const listDirectories = dependencies.listDirectories ?? defaultListDirectories;

  const claudeCache = new Map<string, FileStat & { title: string | null; model: string | null }>();
  const ompCache = new Map<string, FileStat & { title: string | null }>();
  let codexCache: (FileStat & { byId: Map<string, string> }) | null = null;
  const codexModelCache = new Map<string, FileStat & { model: string | null }>();
  const grokCache = new Map<string, FileStat & { title: string | null; model: string | null }>();
  const grokSummaryPaths = new Map<string, string>();

  const claudeFacts = (path: string): { title: string | null; model: string | null } => {
    const stat = statPath(path);
    if (stat === null) {
      // A missing transcript is re-statted every pass; the failure is cheap
      // and there is no identity to cache against.
      return { title: null, model: null };
    }
    const cached = claudeCache.get(path);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { title: cached.title, model: cached.model };
    }
    const tail = readTail(path, TAIL_BYTES);
    const title = tail === null ? null : claudeTitleFromTail(tail);
    const model = tail === null ? null : claudeModelFromTail(tail);
    claudeCache.set(path, { ...stat, title, model });
    return { title, model };
  };

  const ompTitle = (path: string): string | null => {
    const stat = statPath(path);
    if (stat === null) {
      return null;
    }
    const cached = ompCache.get(path);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.title;
    }
    // Every change to the session file — appended records or the in-place
    // slot rewrite — bumps its stat identity, so (mtime, size) caching is
    // sound here (unlike zcode's WAL store, which bypasses the main file).
    const head = readHead(path, OMP_HEAD_BYTES);
    const title = head === null ? null : ompTitleFromHead(head);
    ompCache.set(path, { ...stat, title });
    return title;
  };

  /**
   * Locate sessions/<group>/<sessionId>/summary.json by scanning group dirs.
   * The group name is the URL-encoded cwd with a slug+hash fallback past 255
   * bytes, so it is never reconstructed — only globbed. A found path is
   * remembered; an unfound session re-scans next pass (the scan is one
   * readdir plus one stat per group, and grok rows are few).
   */
  const grokSummaryPath = (sessionId: string): string | null => {
    const known = grokSummaryPaths.get(sessionId);
    if (known !== undefined) {
      return known;
    }
    for (const group of listDirectories(dependencies.grokSessionsRoot)) {
      const candidate = join(dependencies.grokSessionsRoot, group, sessionId, "summary.json");
      if (statPath(candidate) !== null) {
        grokSummaryPaths.set(sessionId, candidate);
        return candidate;
      }
    }
    return null;
  };

  const grokFacts = (sessionId: string): { title: string | null; model: string | null } => {
    const path = grokSummaryPath(sessionId);
    if (path === null) {
      return { title: null, model: null };
    }
    const stat = statPath(path);
    if (stat === null) {
      return { title: null, model: null };
    }
    const cached = grokCache.get(path);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { title: cached.title, model: cached.model };
    }
    const content = readWhole(path);
    const facts = content === null ? { title: null, model: null } : grokFactsFromSummary(content);
    grokCache.set(path, { ...stat, ...facts });
    return facts;
  };

  const codexModel = (path: string): string | null => {
    const stat = statPath(path);
    if (stat === null) {
      return null;
    }
    const cached = codexModelCache.get(path);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.model;
    }
    const tail = readTail(path, TAIL_BYTES);
    const model = tail === null ? null : codexModelFromTail(tail);
    codexModelCache.set(path, { ...stat, model });
    return model;
  };

  const codexTitles = (): Map<string, string> => {
    const stat = statPath(dependencies.codexIndexPath);
    if (stat === null) {
      return new Map();
    }
    if (codexCache !== null && codexCache.mtimeMs === stat.mtimeMs && codexCache.size === stat.size) {
      return codexCache.byId;
    }
    const content = readWhole(dependencies.codexIndexPath);
    const byId = content === null ? new Map<string, string>() : codexTitlesFromIndex(content);
    codexCache = { ...stat, byId };
    return byId;
  };

  return {
    resolve: (targets) => {
      const titles: SessionTitleUpdate[] = [];
      const models: SessionModelUpdate[] = [];
      let codexById: Map<string, string> | null = null;
      let zcodeById: Map<string, string> | null = null;
      for (const target of targets) {
        let resolvedTitle: string | null = null;
        let resolvedModel: string | null = null;
        if (target.provider === "claude" && target.transcriptPath !== null) {
          const facts = claudeFacts(target.transcriptPath);
          resolvedTitle = facts.title;
          resolvedModel = facts.model;
        } else if (target.provider === "omp" && target.transcriptPath !== null) {
          resolvedTitle = ompTitle(target.transcriptPath);
        } else if (target.provider === "codex") {
          codexById ??= codexTitles();
          resolvedTitle = codexById.get(target.sessionId) ?? null;
          if (target.transcriptPath !== null) {
            resolvedModel = codexModel(target.transcriptPath);
          }
        } else if (target.provider === "zcode") {
          zcodeById ??= readZcodeTitles(
            dependencies.zcodeDatabasePath,
            targets.filter((candidate) => candidate.provider === "zcode").map((candidate) => candidate.sessionId),
          );
          resolvedTitle = zcodeById.get(target.sessionId) ?? null;
        } else if (target.provider === "grok") {
          const facts = grokFacts(target.sessionId);
          resolvedTitle = facts.title;
          resolvedModel = facts.model;
        }
        if (resolvedTitle !== null && resolvedTitle !== target.title) {
          titles.push({ provider: target.provider, sessionId: target.sessionId, title: resolvedTitle });
        }
        if (resolvedModel !== null && resolvedModel !== target.model) {
          models.push({ provider: target.provider, sessionId: target.sessionId, model: resolvedModel });
        }
      }
      return { titles, models };
    },
  };
};
