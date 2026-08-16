/**
 * Resolves human-readable session titles from provider state on disk.
 *
 * Only Kimi pushes titles through hooks; Claude and Codex keep theirs in
 * files near the session transcripts. The daemon owns this resolver and calls
 * `resolve` on a cadence with the live top-level sessions:
 *
 * - Claude: the transcript JSONL (path stored on the registry row) carries
 *   `{"type":"ai-title","aiTitle":...}` records. The file can grow to
 *   megabytes, so only the last 64 KiB are read and the final ai-title line
 *   wins. Results are cached per path on the (mtime, size) identity, so a
 *   pass over an unchanged transcript costs one stat.
 * - Codex: `~/.codex/session_index.jsonl` maps session ids to `thread_name`.
 *   The whole index is reparsed only when its (mtime, size) changes.
 * - zcode: `db.sqlite` under the zcode home, re-queried per pass — WAL makes
 *   stat caching unsafe.
 * - omp: the fixed 256-byte title slot at the head of the session JSONL at the
 *   row's transcript_path, (mtime, size)-cached — every change to the file
 *   (appended records or the in-place slot rewrite) bumps its stat identity.
 * - Kimi rows are never resolved here — hooks already deliver their titles.
 *
 * Resolution is additive: a found title is proposed only when it differs from
 * the stored one, and a missing title never clears an existing value.
 * Claude and Codex filesystem access flows through injected dependencies so
 * their tests use fakes; zcode opens its SQLite database directly (read-only,
 * one connection per pass) and its tests deliberately use real fixture
 * databases.
 */

import { Database } from "bun:sqlite";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { SessionTitleUpdate, TitleTarget } from "./registry";

export const CLAUDE_TAIL_BYTES = 64 * 1024;

const MAX_TITLE_CODE_POINTS = 256;

export type { SessionTitleUpdate, TitleTarget } from "./registry";

export type FileStat = { mtimeMs: number; size: number };

export type TitleResolverDependencies = {
  codexIndexPath: string;
  /** zcode's SQLite store; resolved by the caller (ZCODE_HOME override lives in cli.ts). */
  zcodeDatabasePath: string;
  statPath?: (path: string) => FileStat | null;
  readTail?: (path: string, maxBytes: number) => string | null;
  readWhole?: (path: string) => string | null;
  readHead?: (path: string, maxBytes: number) => string | null;
};

export type TitleResolver = {
  resolve: (targets: readonly TitleTarget[]) => SessionTitleUpdate[];
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundTitle = (value: string): string => Array.from(value).slice(0, MAX_TITLE_CODE_POINTS).join("");

/** The last parseable ai-title line in the window wins; earlier lines may be truncated. */
const claudeTitleFromTail = (tail: string): string | null => {
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || !line.includes('"type":"ai-title"')) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed["aiTitle"] === "string" && parsed["aiTitle"].length > 0) {
        return boundTitle(parsed["aiTitle"]);
      }
    } catch {
      // A truncated or malformed line falls through to the next older one.
    }
  }
  return null;
};

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

export const createTitleResolver = (dependencies: TitleResolverDependencies): TitleResolver => {
  const statPath = dependencies.statPath ?? defaultStatPath;
  const readTail = dependencies.readTail ?? defaultReadTail;
  const readWhole = dependencies.readWhole ?? defaultReadWhole;
  const readHead = dependencies.readHead ?? defaultReadHead;

  const claudeCache = new Map<string, FileStat & { title: string | null }>();
  const ompCache = new Map<string, FileStat & { title: string | null }>();
  let codexCache: (FileStat & { byId: Map<string, string> }) | null = null;

  const claudeTitle = (path: string): string | null => {
    const stat = statPath(path);
    if (stat === null) {
      // A missing transcript is re-statted every pass; the failure is cheap
      // and there is no identity to cache against.
      return null;
    }
    const cached = claudeCache.get(path);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.title;
    }
    const tail = readTail(path, CLAUDE_TAIL_BYTES);
    const title = tail === null ? null : claudeTitleFromTail(tail);
    claudeCache.set(path, { ...stat, title });
    return title;
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
      const updates: SessionTitleUpdate[] = [];
      let codexById: Map<string, string> | null = null;
      let zcodeById: Map<string, string> | null = null;
      for (const target of targets) {
        let resolved: string | null = null;
        if (target.provider === "claude" && target.transcriptPath !== null) {
          resolved = claudeTitle(target.transcriptPath);
        } else if (target.provider === "omp" && target.transcriptPath !== null) {
          resolved = ompTitle(target.transcriptPath);
        } else if (target.provider === "codex") {
          codexById ??= codexTitles();
          resolved = codexById.get(target.sessionId) ?? null;
        } else if (target.provider === "zcode") {
          zcodeById ??= readZcodeTitles(
            dependencies.zcodeDatabasePath,
            targets.filter((candidate) => candidate.provider === "zcode").map((candidate) => candidate.sessionId),
          );
          resolved = zcodeById.get(target.sessionId) ?? null;
        }
        if (resolved !== null && resolved !== target.title) {
          updates.push({ provider: target.provider, sessionId: target.sessionId, title: resolved });
        }
      }
      return updates;
    },
  };
};
