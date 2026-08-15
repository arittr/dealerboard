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
 * - Kimi rows are never resolved here — hooks already deliver their titles.
 *
 * Resolution is additive: a found title is proposed only when it differs from
 * the stored one, and a missing title never clears an existing value. All
 * filesystem access flows through injected dependencies so tests use fakes.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { SessionTitleUpdate, TitleTarget } from "./registry";

export const CLAUDE_TAIL_BYTES = 64 * 1024;

const MAX_TITLE_CODE_POINTS = 256;

export type { SessionTitleUpdate, TitleTarget } from "./registry";

export type FileStat = { mtimeMs: number; size: number };

export type TitleResolverDependencies = {
  codexIndexPath: string;
  statPath?: (path: string) => FileStat | null;
  readTail?: (path: string, maxBytes: number) => string | null;
  readWhole?: (path: string) => string | null;
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

export const createTitleResolver = (dependencies: TitleResolverDependencies): TitleResolver => {
  const statPath = dependencies.statPath ?? defaultStatPath;
  const readTail = dependencies.readTail ?? defaultReadTail;
  const readWhole = dependencies.readWhole ?? defaultReadWhole;

  const claudeCache = new Map<string, FileStat & { title: string | null }>();
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
      for (const target of targets) {
        let resolved: string | null = null;
        if (target.provider === "claude" && target.transcriptPath !== null) {
          resolved = claudeTitle(target.transcriptPath);
        } else if (target.provider === "codex") {
          codexById ??= codexTitles();
          resolved = codexById.get(target.sessionId) ?? null;
        }
        if (resolved !== null && resolved !== target.title) {
          updates.push({ provider: target.provider, sessionId: target.sessionId, title: resolved });
        }
      }
      return updates;
    },
  };
};
