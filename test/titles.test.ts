import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionFactsResolver, type FileStat, type TitleTarget } from "../src/core/titles";

const CODEX_INDEX = "/home/test/.codex/session_index.jsonl";

type FakeFs = {
  stats: Map<string, FileStat>;
  tails: Map<string, string>;
  wholes: Map<string, string>;
  tailReads: () => number;
  wholeReads: () => number;
};

const makeResolver = (seed?: {
  stats?: Record<string, FileStat>;
  tails?: Record<string, string>;
  wholes?: Record<string, string>;
  zcodeDatabasePath?: string;
}): { resolver: ReturnType<typeof createSessionFactsResolver>; fs: FakeFs } => {
  const stats = new Map(Object.entries(seed?.stats ?? {}));
  const tails = new Map(Object.entries(seed?.tails ?? {}));
  const wholes = new Map(Object.entries(seed?.wholes ?? {}));
  let tailReads = 0;
  let wholeReads = 0;
  const resolver = createSessionFactsResolver({
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
  });
  return {
    resolver,
    fs: { stats, tails, wholes, tailReads: () => tailReads, wholeReads: () => wholeReads },
  };
};

const claudeTarget = (overrides: Partial<TitleTarget> = {}): TitleTarget => ({
  provider: "claude",
  sessionId: "s1",
  title: null,
  model: null,
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
    expect(resolver.resolve([claudeTarget()]).titles).toEqual([
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
    expect(resolver.resolve([claudeTarget()]).titles).toEqual([
      { provider: "claude", sessionId: "s1", title: "Valid title" },
    ]);
  });

  test("proposes nothing when the transcript has no ai-title, is missing, or is unchanged", () => {
    const noTitle = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": '{"type":"user","text":"hello"}\n' },
    });
    expect(noTitle.resolver.resolve([claudeTarget()]).titles).toEqual([]);

    const missing = makeResolver();
    expect(missing.resolver.resolve([claudeTarget()]).titles).toEqual([]);

    // An already-matching stored title produces no update.
    const same = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": aiTitle("Same") },
    });
    expect(same.resolver.resolve([claudeTarget({ title: "Same" })]).titles).toEqual([]);
  });

  test("bounds a resolved title to 256 code points", () => {
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": aiTitle("🙂".repeat(300)) },
    });
    const updates = resolver.resolve([claudeTarget()]).titles;
    expect(updates).toHaveLength(1);
    expect(Array.from(updates[0]?.title ?? "")).toHaveLength(256);
  });

  test("caches per path on mtime and size, re-reading only after a change", () => {
    const { resolver, fs } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": aiTitle("First") },
    });
    const target = claudeTarget();
    expect(resolver.resolve([target]).titles).toHaveLength(1);
    expect(fs.tailReads()).toBe(1);

    // Identical identity: stat only, no second read, and the session's stored
    // title now matches so no update is proposed.
    const titled = claudeTarget({ title: "First" });
    expect(resolver.resolve([titled]).titles).toEqual([]);
    expect(fs.tailReads()).toBe(1);

    // A grown transcript re-reads and yields the new title.
    fs.stats.set("/transcripts/s1.jsonl", { mtimeMs: 200, size: 900 });
    fs.tails.set("/transcripts/s1.jsonl", aiTitle("Second"));
    expect(resolver.resolve([titled]).titles).toEqual([{ provider: "claude", sessionId: "s1", title: "Second" }]);
    expect(fs.tailReads()).toBe(2);
  });

  test("skips Claude rows without a transcript path", () => {
    const { resolver, fs } = makeResolver();
    expect(resolver.resolve([claudeTarget({ transcriptPath: null })]).titles).toEqual([]);
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
    expect(
      resolver.resolve([{ provider: "codex", sessionId: "c1", title: null, model: null, transcriptPath: null }]).titles,
    ).toEqual([{ provider: "codex", sessionId: "c1", title: "Add AIS points to radar display" }]);
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
        { provider: "codex", sessionId: "c2", title: null, model: null, transcriptPath: null },
        { provider: "codex", sessionId: "unknown", title: null, model: null, transcriptPath: null },
      ]).titles,
    ).toEqual([{ provider: "codex", sessionId: "c2", title: "Real name" }]);
  });

  test("reparses the index only when its identity changes", () => {
    const { resolver, fs } = makeResolver({
      stats: { [CODEX_INDEX]: { mtimeMs: 100, size: 300 } },
      wholes: { [CODEX_INDEX]: `${indexLine("c1", "First")}\n` },
    });
    const target: TitleTarget = { provider: "codex", sessionId: "c1", title: null, model: null, transcriptPath: null };
    expect(resolver.resolve([target]).titles).toHaveLength(1);
    expect(fs.wholeReads()).toBe(1);

    resolver.resolve([target, { provider: "codex", sessionId: "c2", title: null, model: null, transcriptPath: null }]);
    expect(fs.wholeReads()).toBe(1);

    fs.stats.set(CODEX_INDEX, { mtimeMs: 200, size: 350 });
    fs.wholes.set(CODEX_INDEX, `${indexLine("c1", "Second")}\n`);
    expect(resolver.resolve([target]).titles).toEqual([{ provider: "codex", sessionId: "c1", title: "Second" }]);
    expect(fs.wholeReads()).toBe(2);
  });

  test("a missing or unreadable index resolves nothing", () => {
    const missing = makeResolver();
    expect(
      missing.resolver.resolve([{ provider: "codex", sessionId: "c1", title: null, model: null, transcriptPath: null }])
        .titles,
    ).toEqual([]);

    const unreadable = makeResolver({ stats: { [CODEX_INDEX]: { mtimeMs: 100, size: 300 } } });
    expect(
      unreadable.resolver.resolve([
        { provider: "codex", sessionId: "c1", title: null, model: null, transcriptPath: null },
      ]).titles,
    ).toEqual([]);
  });
});

describe("Session model resolution", () => {
  const assistantLine = (model: string): string => `${JSON.stringify({ type: "assistant", message: { model } })}\n`;
  const turnContextLine = (model: string): string =>
    `${JSON.stringify({ type: "turn_context", payload: { model } })}\n`;

  test("resolves a claude model from the same transcript tail as the title", () => {
    const { resolver, fs } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": `${aiTitle("Fix the widget")}${assistantLine("claude-fable-5")}` },
    });
    const result = resolver.resolve([claudeTarget()]);
    expect(result.titles).toEqual([{ provider: "claude", sessionId: "s1", title: "Fix the widget" }]);
    expect(result.models).toEqual([{ provider: "claude", sessionId: "s1", model: "claude-fable-5" }]);
    // One tail read serves both facts.
    expect(fs.tailReads()).toBe(1);
  });

  test("the last authoritative record wins after a mid-session model switch", () => {
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": `${assistantLine("claude-fable-5")}${assistantLine("claude-k2")}` },
    });
    expect(resolver.resolve([claudeTarget()]).models).toEqual([
      { provider: "claude", sessionId: "s1", model: "claude-k2" },
    ]);
  });

  test("an assistant record's nested tool-call model argument never beats message.model", () => {
    // The decoy: a subagent dispatch whose tool input names a different model.
    // Only message.model is the session's model; an unstructured scan of the
    // tail would resolve the nested argument because it occurs later.
    const dispatch = `${JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-fable-5",
        content: [{ type: "tool_use", name: "Task", input: { model: "claude-k2", prompt: "review this" } }],
      },
    })}\n`;
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": `${assistantLine("claude-fable-5")}${dispatch}` },
    });
    expect(resolver.resolve([claudeTarget()]).models).toEqual([
      { provider: "claude", sessionId: "s1", model: "claude-fable-5" },
    ]);
  });

  test("a truncated final model record is skipped without throwing", () => {
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: {
        "/transcripts/s1.jsonl": `${assistantLine("claude-fable-5")}{"type":"assistant","message":{"model":"claude-tr`,
      },
    });
    expect(resolver.resolve([claudeTarget()]).models).toEqual([
      { provider: "claude", sessionId: "s1", model: "claude-fable-5" },
    ]);
  });

  test("a transcript with no model record proposes no model update", () => {
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": aiTitle("Only a title") },
    });
    const result = resolver.resolve([claudeTarget()]);
    expect(result.titles).toHaveLength(1);
    // Nothing proposed, so a stored model is never cleared — the registry
    // only applies proposed updates.
    expect(result.models).toEqual([]);
  });

  test("resolves a codex model from the rollout at transcript_path", () => {
    const { resolver, fs } = makeResolver({
      stats: {
        [CODEX_INDEX]: { mtimeMs: 100, size: 300 },
        "/rollouts/c1.jsonl": { mtimeMs: 100, size: 400 },
      },
      wholes: { [CODEX_INDEX]: `${JSON.stringify({ id: "c1", thread_name: "Index name" })}\n` },
      tails: { "/rollouts/c1.jsonl": turnContextLine("gpt-5.6-luna") },
    });
    const result = resolver.resolve([
      { provider: "codex", sessionId: "c1", title: null, model: null, transcriptPath: "/rollouts/c1.jsonl" },
    ]);
    expect(result.titles).toEqual([{ provider: "codex", sessionId: "c1", title: "Index name" }]);
    expect(result.models).toEqual([{ provider: "codex", sessionId: "c1", model: "gpt-5.6-luna" }]);
    // The rollout is tail-read for the model; the whole-file session index
    // is not asked for models (its single read serves the title).
    expect(fs.tailReads()).toBe(1);
    expect(fs.wholeReads()).toBe(1);
  });

  test("a rollout response item's model field never beats turn_context", () => {
    const responseItem = `${JSON.stringify({
      type: "response_item",
      payload: { type: "message", model: "gpt-5.6-sol" },
    })}\n`;
    const { resolver } = makeResolver({
      stats: {
        [CODEX_INDEX]: { mtimeMs: 100, size: 300 },
        "/rollouts/c1.jsonl": { mtimeMs: 100, size: 400 },
      },
      wholes: { [CODEX_INDEX]: "" },
      tails: { "/rollouts/c1.jsonl": `${turnContextLine("gpt-5.6-luna")}${responseItem}` },
    });
    expect(
      resolver.resolve([
        { provider: "codex", sessionId: "c1", title: null, model: null, transcriptPath: "/rollouts/c1.jsonl" },
      ]).models,
    ).toEqual([{ provider: "codex", sessionId: "c1", model: "gpt-5.6-luna" }]);
  });

  test("a stored-equal model proposes no update", () => {
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": assistantLine("claude-fable-5") },
    });
    expect(resolver.resolve([claudeTarget({ model: "claude-fable-5" })]).models).toEqual([]);
  });

  test("zcode and kimi targets are never model-resolved", () => {
    const { resolver, fs } = makeResolver({
      stats: {
        "/transcripts/k1.jsonl": { mtimeMs: 100, size: 500 },
        "/transcripts/z1.jsonl": { mtimeMs: 100, size: 500 },
      },
      tails: {
        "/transcripts/k1.jsonl": assistantLine("k3"),
        "/transcripts/z1.jsonl": assistantLine("glm-5.3"),
      },
    });
    const result = resolver.resolve([
      { provider: "kimi", sessionId: "k1", title: null, model: null, transcriptPath: "/transcripts/k1.jsonl" },
      { provider: "zcode", sessionId: "z1", title: null, model: null, transcriptPath: "/transcripts/z1.jsonl" },
    ]);
    expect(result.models).toEqual([]);
    expect(fs.tailReads()).toBe(0);
    expect(fs.wholeReads()).toBe(0);
  });
});

describe("other providers", () => {
  test("never resolves Kimi rows, whose hooks already push titles", () => {
    const { resolver, fs } = makeResolver({
      stats: { "/transcripts/k1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/k1.jsonl": aiTitle("Should not be read") },
    });
    expect(
      resolver.resolve([
        { provider: "kimi", sessionId: "k1", title: null, model: null, transcriptPath: "/transcripts/k1.jsonl" },
      ]).titles,
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
    model: null,
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
        expect(resolver.resolve([zcodeTarget("z1"), zcodeTarget("z2"), zcodeTarget("ghost")]).titles).toEqual([
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
      const updates = resolver.resolve([zcodeTarget("z1")]).titles;
      expect(updates).toHaveLength(1);
      const title = updates[0]?.title ?? "";
      expect(Array.from(title)).toHaveLength(256);
      expect(title).toBe(expected);
    });
  });

  test("proposes nothing when the stored title already matches", () => {
    withFixtureDb([{ id: "z1", title: "Same" }], (dbPath) => {
      const { resolver } = makeResolver({ zcodeDatabasePath: dbPath });
      expect(resolver.resolve([zcodeTarget("z1", "Same")]).titles).toEqual([]);
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
        expect(resolver.resolve([zcodeTarget("z1")]).titles).toEqual([
          { provider: "zcode", sessionId: "z1", title: "Initial" },
        ]);
        writer.run("UPDATE session SET title = 'Renamed mid-stream' WHERE id = 'z1'");
        expect(resolver.resolve([zcodeTarget("z1")]).titles).toEqual([
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
    expect(missing.resolver.resolve([zcodeTarget("z1")]).titles).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), "stream-deck-agents-zcode-titles-"));
    try {
      const dbPath = join(dir, "db.sqlite");
      const wrong = new Database(dbPath, { create: true, readwrite: true });
      wrong.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
      wrong.close();
      const { resolver } = makeResolver({ zcodeDatabasePath: dbPath });
      expect(resolver.resolve([zcodeTarget("z1")]).titles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
