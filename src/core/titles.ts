/**
 * Resolves session facts — titles and model ids — from provider state on
 * disk.
 *
 * Only Kimi pushes titles through hooks; Claude and Codex keep theirs in
 * files near the session transcripts. The daemon owns this resolver and calls
 * `resolve` on a cadence with the live top-level sessions:
 *
 * - Claude: the transcript JSONL (path stored on the registry row) carries
 *   `{"type":"ai-title","aiTitle":...}` records and assistant records with a
 *   `"model":"..."` field. The file can grow to megabytes, so only the last
 *   64 KiB (TAIL_BYTES) are read — one read serves both facts — and the final
 *   ai-title line and the last model occurrence win. Results are cached per
 *   path on the (mtime, size) identity, so a pass over an unchanged
 *   transcript costs one stat.
 * - Codex: `~/.codex/session_index.jsonl` maps session ids to `thread_name`.
 *   The whole index is reparsed only when its (mtime, size) changes. Models
 *   come from a tail read of the rollout JSONL at the row's `transcript_path`,
 *   cached per path on (mtime, size) the same way the Claude facts are.
 * - zcode: `db.sqlite` under the zcode home, re-queried per pass — WAL makes
 *   stat caching unsafe. zcode has no model source at all, so its rows never
 *   resolve one.
 * - Kimi rows are never resolved here — hooks already deliver their titles
 *   and models.
 *
 * Resolution is additive: a found title or model is proposed only when it
 * differs from the stored one, and a missing value never clears an existing
 * one. Claude and Codex filesystem access flows through injected dependencies
 * so their tests use fakes; zcode opens its SQLite database directly
 * (read-only, one connection per pass) and its tests deliberately use real
 * fixture databases.
 */

import { Database } from "bun:sqlite";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { SessionModelUpdate, SessionTitleUpdate, TitleTarget } from "./registry";

export const TAIL_BYTES = 64 * 1024;

const MAX_TITLE_CODE_POINTS = 256;

export type { SessionModelUpdate, SessionTitleUpdate, TitleTarget } from "./registry";

export type FileStat = { mtimeMs: number; size: number };

export type SessionFactsResolverDependencies = {
  codexIndexPath: string;
  /** zcode's SQLite store; resolved by the caller (ZCODE_HOME override lives in cli.ts). */
  zcodeDatabasePath: string;
  statPath?: (path: string) => FileStat | null;
  readTail?: (path: string, maxBytes: number) => string | null;
  readWhole?: (path: string) => string | null;
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

const MODEL_PATTERN = /"model":"([^"]{1,300})"/g;

/**
 * Last raw model id in the window wins — a mid-session model switch changes
 * the last occurrence. A regex over the tail string, not a per-line parse,
 * because the tail's first line is usually truncated mid-JSON.
 */
const modelFromTail = (tail: string): string | null => {
  let found: string | null = null;
  for (const match of tail.matchAll(MODEL_PATTERN)) {
    const value = match[1];
    if (value !== undefined && value.length > 0) {
      found = value;
    }
  }
  return found === null ? null : boundTitle(found);
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

  const claudeCache = new Map<string, FileStat & { title: string | null; model: string | null }>();
  let codexCache: (FileStat & { byId: Map<string, string> }) | null = null;
  const codexModelCache = new Map<string, FileStat & { model: string | null }>();

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
    const model = tail === null ? null : modelFromTail(tail);
    claudeCache.set(path, { ...stat, title, model });
    return { title, model };
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
    const model = tail === null ? null : modelFromTail(tail);
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
