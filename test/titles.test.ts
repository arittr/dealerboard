import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTitleResolver, type FileStat, OMP_SLOT_BYTES, type TitleTarget } from "../src/core/titles";

const CODEX_INDEX = "/home/test/.codex/session_index.jsonl";

type FakeFs = {
  stats: Map<string, FileStat>;
  tails: Map<string, string>;
  wholes: Map<string, string>;
  heads: Map<string, string>;
  tailReads: () => number;
  wholeReads: () => number;
  headReads: () => number;
};

const makeResolver = (seed?: {
  stats?: Record<string, FileStat>;
  tails?: Record<string, string>;
  wholes?: Record<string, string>;
  heads?: Record<string, string>;
  zcodeDatabasePath?: string;
}): { resolver: ReturnType<typeof createTitleResolver>; fs: FakeFs } => {
  const stats = new Map(Object.entries(seed?.stats ?? {}));
  const tails = new Map(Object.entries(seed?.tails ?? {}));
  const wholes = new Map(Object.entries(seed?.wholes ?? {}));
  const heads = new Map(Object.entries(seed?.heads ?? {}));
  let tailReads = 0;
  let wholeReads = 0;
  let headReads = 0;
  const resolver = createTitleResolver({
    codexIndexPath: CODEX_INDEX,
    zcodeDatabasePath: seed?.zcodeDatabasePath ?? "/nonexistent/zcode/db.sqlite",
    statPath: (path) => stats.get(path) ?? null,
    readTail: (path) => {
      tailReads += 1;
      return tails.get(path) ?? null;
    },
    readWhole: (path) => {
      wholeReads += 1;
      return wholes.get(path) ?? null;
    },
    readHead: (path) => {
      headReads += 1;
      return heads.get(path) ?? null;
    },
  });
  return {
    resolver,
    fs: {
      stats,
      tails,
      wholes,
      heads,
      tailReads: () => tailReads,
      wholeReads: () => wholeReads,
      headReads: () => headReads,
    },
  };
};

const claudeTarget = (overrides: Partial<TitleTarget> = {}): TitleTarget => ({
  provider: "claude",
  sessionId: "s1",
  title: null,
  transcriptPath: "/transcripts/s1.jsonl",
  ...overrides,
});

const aiTitle = (title: string): string =>
  `${JSON.stringify({ type: "user" })}\n${JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: "s1" })}\n`;

describe("Claude transcript titles", () => {
  test("extracts the last ai-title line from the transcript tail", () => {
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": `${aiTitle("Old title")}${aiTitle("Test PR 2085 with Cursor")}` },
    });
    expect(resolver.resolve([claudeTarget()])).toEqual([
      { provider: "claude", sessionId: "s1", title: "Test PR 2085 with Cursor" },
    ]);
  });

  test("skips malformed ai-title lines and falls back to an older valid one", () => {
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: {
        "/transcripts/s1.jsonl": `${aiTitle("Valid title")}{"type":"ai-title","aiTitle":"truncated\n`,
      },
    });
    expect(resolver.resolve([claudeTarget()])).toEqual([{ provider: "claude", sessionId: "s1", title: "Valid title" }]);
  });

  test("proposes nothing when the transcript has no ai-title, is missing, or is unchanged", () => {
    const noTitle = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": '{"type":"user","text":"hello"}\n' },
    });
    expect(noTitle.resolver.resolve([claudeTarget()])).toEqual([]);

    const missing = makeResolver();
    expect(missing.resolver.resolve([claudeTarget()])).toEqual([]);

    // An already-matching stored title produces no update.
    const same = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": aiTitle("Same") },
    });
    expect(same.resolver.resolve([claudeTarget({ title: "Same" })])).toEqual([]);
  });

  test("bounds a resolved title to 256 code points", () => {
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": aiTitle("🙂".repeat(300)) },
    });
    const updates = resolver.resolve([claudeTarget()]);
    expect(updates).toHaveLength(1);
    expect(Array.from(updates[0]?.title ?? "")).toHaveLength(256);
  });

  test("caches per path on mtime and size, re-reading only after a change", () => {
    const { resolver, fs } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": aiTitle("First") },
    });
    const target = claudeTarget();
    expect(resolver.resolve([target])).toHaveLength(1);
    expect(fs.tailReads()).toBe(1);

    // Identical identity: stat only, no second read, and the session's stored
    // title now matches so no update is proposed.
    const titled = claudeTarget({ title: "First" });
    expect(resolver.resolve([titled])).toEqual([]);
    expect(fs.tailReads()).toBe(1);

    // A grown transcript re-reads and yields the new title.
    fs.stats.set("/transcripts/s1.jsonl", { mtimeMs: 200, size: 900 });
    fs.tails.set("/transcripts/s1.jsonl", aiTitle("Second"));
    expect(resolver.resolve([titled])).toEqual([{ provider: "claude", sessionId: "s1", title: "Second" }]);
    expect(fs.tailReads()).toBe(2);
  });

  test("skips Claude rows without a transcript path", () => {
    const { resolver, fs } = makeResolver();
    expect(resolver.resolve([claudeTarget({ transcriptPath: null })])).toEqual([]);
    expect(fs.tailReads()).toBe(0);
  });
});

describe("Codex session-index titles", () => {
  const indexLine = (id: string, threadName: string): string =>
    JSON.stringify({ id, thread_name: threadName, updated_at: "2026-08-10T05:41:28.455703Z" });

  test("maps thread_name by session id, last occurrence winning", () => {
    const { resolver } = makeResolver({
      stats: { [CODEX_INDEX]: { mtimeMs: 100, size: 300 } },
      wholes: {
        [CODEX_INDEX]: `${indexLine("c1", "Old name")}\n${indexLine("c1", "Add AIS points to radar display")}\n`,
      },
    });
    expect(resolver.resolve([{ provider: "codex", sessionId: "c1", title: null, transcriptPath: null }])).toEqual([
      { provider: "codex", sessionId: "c1", title: "Add AIS points to radar display" },
    ]);
  });

  test("skips malformed lines and ids without a live session", () => {
    const { resolver } = makeResolver({
      stats: { [CODEX_INDEX]: { mtimeMs: 100, size: 300 } },
      wholes: {
        [CODEX_INDEX]: `not-json\n${indexLine("other", "Other")}\n${JSON.stringify({ id: "c2", thread_name: "" })}\n${indexLine("c2", "Real name")}`,
      },
    });
    expect(
      resolver.resolve([
        { provider: "codex", sessionId: "c2", title: null, transcriptPath: null },
        { provider: "codex", sessionId: "unknown", title: null, transcriptPath: null },
      ]),
    ).toEqual([{ provider: "codex", sessionId: "c2", title: "Real name" }]);
  });

  test("reparses the index only when its identity changes", () => {
    const { resolver, fs } = makeResolver({
      stats: { [CODEX_INDEX]: { mtimeMs: 100, size: 300 } },
      wholes: { [CODEX_INDEX]: `${indexLine("c1", "First")}\n` },
    });
    const target: TitleTarget = { provider: "codex", sessionId: "c1", title: null, transcriptPath: null };
    expect(resolver.resolve([target])).toHaveLength(1);
    expect(fs.wholeReads()).toBe(1);

    resolver.resolve([target, { provider: "codex", sessionId: "c2", title: null, transcriptPath: null }]);
    expect(fs.wholeReads()).toBe(1);

    fs.stats.set(CODEX_INDEX, { mtimeMs: 200, size: 350 });
    fs.wholes.set(CODEX_INDEX, `${indexLine("c1", "Second")}\n`);
    expect(resolver.resolve([target])).toEqual([{ provider: "codex", sessionId: "c1", title: "Second" }]);
    expect(fs.wholeReads()).toBe(2);
  });

  test("a missing or unreadable index resolves nothing", () => {
    const missing = makeResolver();
    expect(
      missing.resolver.resolve([{ provider: "codex", sessionId: "c1", title: null, transcriptPath: null }]),
    ).toEqual([]);

    const unreadable = makeResolver({ stats: { [CODEX_INDEX]: { mtimeMs: 100, size: 300 } } });
    expect(
      unreadable.resolver.resolve([{ provider: "codex", sessionId: "c1", title: null, transcriptPath: null }]),
    ).toEqual([]);
  });
});

describe("other providers", () => {
  test("never resolves Kimi rows, whose hooks already push titles", () => {
    const { resolver, fs } = makeResolver({
      stats: { "/transcripts/k1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/k1.jsonl": aiTitle("Should not be read") },
    });
    expect(
      resolver.resolve([{ provider: "kimi", sessionId: "k1", title: null, transcriptPath: "/transcripts/k1.jsonl" }]),
    ).toEqual([]);
    expect(fs.tailReads()).toBe(0);
  });
});

describe("zcode SQLite titles", () => {
  const ZCODE_TABLE_DDL = "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)";

  const withFixtureDb = (
    rows: readonly { id: string; title: string | null }[],
    run: (dbPath: string) => void,
  ): void => {
    const dir = mkdtempSync(join(tmpdir(), "stream-deck-agents-zcode-titles-"));
    try {
      const dbPath = join(dir, "db.sqlite");
      const setup = new Database(dbPath, { create: true, readwrite: true });
      try {
        setup.exec(ZCODE_TABLE_DDL);
        for (const row of rows) {
          setup.run("INSERT INTO session (id, title) VALUES (?, ?)", [row.id, row.title]);
        }
      } finally {
        setup.close();
      }
      run(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const zcodeTarget = (sessionId: string, title: string | null = null): TitleTarget => ({
    provider: "zcode",
    sessionId,
    title,
    transcriptPath: null,
  });

  test("resolves titles per live zcode row", () => {
    withFixtureDb(
      [
        { id: "z1", title: "Fix the widget renderer" },
        { id: "z2", title: null },
      ],
      (dbPath) => {
        const { resolver } = makeResolver({ zcodeDatabasePath: dbPath });
        expect(resolver.resolve([zcodeTarget("z1"), zcodeTarget("z2"), zcodeTarget("ghost")])).toEqual([
          { provider: "zcode", sessionId: "z1", title: "Fix the widget renderer" },
        ]);
      },
    );
  });

  test("bounds a stored title to exactly 256 code points, cutting at an astral boundary", () => {
    // 265 code points with astral emoji straddling the 256th: a UTF-16
    // unit slice would split the surrogate pair there, so only code-point
    // truncation can satisfy both the length and the content assertion.
    const longTitle = `${"🔧".repeat(120)}${"y".repeat(125)}${"🛠".repeat(20)}`;
    const expected = Array.from(longTitle).slice(0, 256).join("");
    expect(Array.from(longTitle).length).toBeGreaterThan(256);
    withFixtureDb([{ id: "z1", title: longTitle }], (dbPath) => {
      const { resolver } = makeResolver({ zcodeDatabasePath: dbPath });
      const updates = resolver.resolve([zcodeTarget("z1")]);
      expect(updates).toHaveLength(1);
      const title = updates[0]?.title ?? "";
      expect(Array.from(title)).toHaveLength(256);
      expect(title).toBe(expected);
    });
  });

  test("proposes nothing when the stored title already matches", () => {
    withFixtureDb([{ id: "z1", title: "Same" }], (dbPath) => {
      const { resolver } = makeResolver({ zcodeDatabasePath: dbPath });
      expect(resolver.resolve([zcodeTarget("z1", "Same")])).toEqual([]);
    });
  });

  test("sees a WAL commit that has not checkpointed (no stat cache)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stream-deck-agents-zcode-titles-"));
    try {
      const dbPath = join(dir, "db.sqlite");
      const writer = new Database(dbPath, { create: true, readwrite: true });
      try {
        writer.exec("PRAGMA journal_mode = WAL");
        writer.exec(ZCODE_TABLE_DDL);
        writer.run("INSERT INTO session (id, title) VALUES ('z1', 'Initial')");
      } catch (error) {
        writer.close();
        throw error;
      }
      // The writer stays OPEN and nothing checkpoints: the title lives only
      // in db.sqlite-wal, and the main file's stat is unchanged. A resolver
      // caching on (mtime, size) would never see this write.
      const { resolver } = makeResolver({ zcodeDatabasePath: dbPath });
      try {
        expect(resolver.resolve([zcodeTarget("z1")])).toEqual([
          { provider: "zcode", sessionId: "z1", title: "Initial" },
        ]);
        writer.run("UPDATE session SET title = 'Renamed mid-stream' WHERE id = 'z1'");
        expect(resolver.resolve([zcodeTarget("z1")])).toEqual([
          { provider: "zcode", sessionId: "z1", title: "Renamed mid-stream" },
        ]);
      } finally {
        writer.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing database or an unexpected schema resolves nothing and never throws", () => {
    const missing = makeResolver();
    expect(missing.resolver.resolve([zcodeTarget("z1")])).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), "stream-deck-agents-zcode-titles-"));
    try {
      const dbPath = join(dir, "db.sqlite");
      const wrong = new Database(dbPath, { create: true, readwrite: true });
      wrong.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
      wrong.close();
      const { resolver } = makeResolver({ zcodeDatabasePath: dbPath });
      expect(resolver.resolve([zcodeTarget("z1")])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("omp session-file titles", () => {
  const FIXTURE_PATH = join(import.meta.dir, "fixtures", "omp-session.jsonl");
  // The title stored in the captured fixture's head slot, pinned as a literal.
  const FIXTURE_TITLE = "Write haiku about binary search trees";

  // Mirrors omp's slot writer: one JSON record whose "pad" field absorbs the
  // slack so the line is exactly OMP_SLOT_BYTES UTF-8 bytes, newline included.
  const slotRecord = (title: string): string => {
    const record = (pad: string): string =>
      `${JSON.stringify({ type: "title", v: 1, title, source: "auto", updatedAt: "2026-08-16T07:01:52.082Z", pad })}\n`;
    return record(" ".repeat(OMP_SLOT_BYTES - Buffer.byteLength(record(""), "utf8")));
  };

  const ompTarget = (overrides: Partial<TitleTarget> = {}): TitleTarget => ({
    provider: "omp",
    sessionId: "o1",
    title: null,
    transcriptPath: "/sessions/o1.jsonl",
    ...overrides,
  });

  test("reads the title slot from a real captured omp session file", () => {
    // Real defaults, real fixture file — no fs fakes.
    const resolver = createTitleResolver({
      codexIndexPath: "/nonexistent/.codex/session_index.jsonl",
      zcodeDatabasePath: "/nonexistent/.zcode/cli/db/db.sqlite",
    });
    const updates = resolver.resolve([{ provider: "omp", sessionId: "o1", title: null, transcriptPath: FIXTURE_PATH }]);
    expect(updates).toEqual([{ provider: "omp", sessionId: "o1", title: FIXTURE_TITLE }]);
  });

  test("caches per path on mtime and size", () => {
    const { resolver, fs } = makeResolver({
      zcodeDatabasePath: "/nonexistent/.zcode/cli/db/db.sqlite",
      stats: { "/sessions/o1.jsonl": { mtimeMs: 100, size: 900 } },
      heads: { "/sessions/o1.jsonl": `${slotRecord("Auto-titled session")}{"type":"session","version":3}\n` },
    });
    expect(resolver.resolve([ompTarget()])).toEqual([
      { provider: "omp", sessionId: "o1", title: "Auto-titled session" },
    ]);
    expect(fs.headReads()).toBe(1);

    expect(resolver.resolve([ompTarget({ title: "Auto-titled session" })])).toEqual([]);
    expect(fs.headReads()).toBe(1);

    fs.stats.set("/sessions/o1.jsonl", { mtimeMs: 200, size: 1200 });
    fs.heads.set("/sessions/o1.jsonl", slotRecord("Retitled"));
    expect(resolver.resolve([ompTarget({ title: "Auto-titled session" })])).toEqual([
      { provider: "omp", sessionId: "o1", title: "Retitled" },
    ]);
    expect(fs.headReads()).toBe(2);
  });

  test("falls back to the first parseable JSONL title line after the slot", () => {
    const { resolver } = makeResolver({
      stats: { "/sessions/o1.jsonl": { mtimeMs: 100, size: 900 } },
      heads: {
        "/sessions/o1.jsonl": `{"type":"session","version":3,"id":"o1"}\n{"type":"message"}\n{"type":"title_change","id":"x","title":"Fallback title"}\n`,
      },
    });
    expect(resolver.resolve([ompTarget()])).toEqual([{ provider: "omp", sessionId: "o1", title: "Fallback title" }]);
  });

  test("no slot and no fallback line resolves nothing; a missing file never throws", () => {
    const { resolver } = makeResolver({
      stats: { "/sessions/o1.jsonl": { mtimeMs: 100, size: 900 } },
      heads: { "/sessions/o1.jsonl": `{"type":"session","version":3,"id":"o1"}\nnot-json\n{"type":"message"}\n` },
    });
    expect(resolver.resolve([ompTarget()])).toEqual([]);

    const missing = makeResolver();
    expect(missing.resolver.resolve([ompTarget()])).toEqual([]);
  });

  test("skips omp rows without a transcript path", () => {
    const { resolver, fs } = makeResolver();
    expect(resolver.resolve([ompTarget({ transcriptPath: null })])).toEqual([]);
    expect(fs.headReads()).toBe(0);
  });
});
