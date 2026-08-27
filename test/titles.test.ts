import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionFactsResolver, type FileStat, OMP_SLOT_BYTES, type TitleTarget } from "../src/core/titles";

const CODEX_INDEX = "/home/test/.codex/session_index.jsonl";

type FakeFs = {
  stats: Map<string, FileStat>;
  tails: Map<string, string>;
  wholes: Map<string, string>;
  heads: Map<string, string>;
  lists: Map<string, string[]>;
  tailReads: () => number;
  wholeReads: () => number;
  headReads: () => number;
};

const makeResolver = (seed?: {
  stats?: Record<string, FileStat>;
  tails?: Record<string, string>;
  wholes?: Record<string, string>;
  heads?: Record<string, string>;
  lists?: Record<string, string[]>;
  zcodeDatabasePath?: string;
  grokSessionsRoot?: string;
}): { resolver: ReturnType<typeof createSessionFactsResolver>; fs: FakeFs } => {
  const stats = new Map(Object.entries(seed?.stats ?? {}));
  const tails = new Map(Object.entries(seed?.tails ?? {}));
  const wholes = new Map(Object.entries(seed?.wholes ?? {}));
  const heads = new Map(Object.entries(seed?.heads ?? {}));
  const lists = new Map(Object.entries(seed?.lists ?? {}));
  let tailReads = 0;
  let wholeReads = 0;
  let headReads = 0;
  const resolver = createSessionFactsResolver({
    codexIndexPath: CODEX_INDEX,
    zcodeDatabasePath: seed?.zcodeDatabasePath ?? "/nonexistent/zcode/db.sqlite",
    grokSessionsRoot: seed?.grokSessionsRoot ?? "/nonexistent/grok/sessions",
    statPath: (path) => stats.get(path) ?? null,
    listDirectories: (path) => lists.get(path) ?? [],
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
      lists,
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
  model: null,
  activityLine: null,
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
      resolver.resolve([
        { provider: "codex", sessionId: "c1", title: null, model: null, activityLine: null, transcriptPath: null },
      ]).titles,
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
        { provider: "codex", sessionId: "c2", title: null, model: null, activityLine: null, transcriptPath: null },
        { provider: "codex", sessionId: "unknown", title: null, model: null, activityLine: null, transcriptPath: null },
      ]).titles,
    ).toEqual([{ provider: "codex", sessionId: "c2", title: "Real name" }]);
  });

  test("reparses the index only when its identity changes", () => {
    const { resolver, fs } = makeResolver({
      stats: { [CODEX_INDEX]: { mtimeMs: 100, size: 300 } },
      wholes: { [CODEX_INDEX]: `${indexLine("c1", "First")}\n` },
    });
    const target: TitleTarget = {
      provider: "codex",
      sessionId: "c1",
      title: null,
      model: null,
      activityLine: null,
      transcriptPath: null,
    };
    expect(resolver.resolve([target]).titles).toHaveLength(1);
    expect(fs.wholeReads()).toBe(1);

    resolver.resolve([
      target,
      { provider: "codex", sessionId: "c2", title: null, model: null, activityLine: null, transcriptPath: null },
    ]);
    expect(fs.wholeReads()).toBe(1);

    fs.stats.set(CODEX_INDEX, { mtimeMs: 200, size: 350 });
    fs.wholes.set(CODEX_INDEX, `${indexLine("c1", "Second")}\n`);
    expect(resolver.resolve([target]).titles).toEqual([{ provider: "codex", sessionId: "c1", title: "Second" }]);
    expect(fs.wholeReads()).toBe(2);
  });

  test("a missing or unreadable index resolves nothing", () => {
    const missing = makeResolver();
    expect(
      missing.resolver.resolve([
        { provider: "codex", sessionId: "c1", title: null, model: null, activityLine: null, transcriptPath: null },
      ]).titles,
    ).toEqual([]);

    const unreadable = makeResolver({ stats: { [CODEX_INDEX]: { mtimeMs: 100, size: 300 } } });
    expect(
      unreadable.resolver.resolve([
        { provider: "codex", sessionId: "c1", title: null, model: null, activityLine: null, transcriptPath: null },
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
      {
        provider: "codex",
        sessionId: "c1",
        title: null,
        model: null,
        activityLine: null,
        transcriptPath: "/rollouts/c1.jsonl",
      },
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
        {
          provider: "codex",
          sessionId: "c1",
          title: null,
          model: null,
          activityLine: null,
          transcriptPath: "/rollouts/c1.jsonl",
        },
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
      {
        provider: "kimi",
        sessionId: "k1",
        title: null,
        model: null,
        activityLine: null,
        transcriptPath: "/transcripts/k1.jsonl",
      },
      {
        provider: "zcode",
        sessionId: "z1",
        title: null,
        model: null,
        activityLine: null,
        transcriptPath: "/transcripts/z1.jsonl",
      },
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
        {
          provider: "kimi",
          sessionId: "k1",
          title: null,
          model: null,
          activityLine: null,
          transcriptPath: "/transcripts/k1.jsonl",
        },
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
    const dir = mkdtempSync(join(tmpdir(), "dealerboard-zcode-titles-"));
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
    activityLine: null,
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
    const dir = mkdtempSync(join(tmpdir(), "dealerboard-zcode-titles-"));
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

    const dir = mkdtempSync(join(tmpdir(), "dealerboard-zcode-titles-"));
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

describe("omp session-file titles", () => {
  const FIXTURE_PATH = join(import.meta.dir, "fixtures", "omp-session.jsonl");
  // The title stored in the synthetic fixture's head slot, pinned as a literal.
  const FIXTURE_TITLE = "Synthetic OMP title slot for testing.";
  // The model on the fixture's assistant message record, pinned as a literal.
  const FIXTURE_MODEL = "glm-5.3";

  // Mirrors omp's slot writer: one JSON record whose "pad" field absorbs the
  // slack so the line is exactly OMP_SLOT_BYTES UTF-8 bytes, newline included.
  // "source" appears only once a title is set, matching the provider format.
  const slotRecord = (title: string): string => {
    const record = (pad: string): string =>
      `${JSON.stringify(
        title === ""
          ? { type: "title", v: 1, title, updatedAt: "2024-01-02T03:04:05.000Z", pad }
          : { type: "title", v: 1, title, source: "auto", updatedAt: "2024-01-02T03:04:05.000Z", pad },
      )}\n`;
    return record(" ".repeat(OMP_SLOT_BYTES - Buffer.byteLength(record(""), "utf8")));
  };

  const ompTarget = (overrides: Partial<TitleTarget> = {}): TitleTarget => ({
    provider: "omp",
    sessionId: "o1",
    title: null,
    model: null,
    activityLine: null,
    transcriptPath: "/sessions/o1.jsonl",
    ...overrides,
  });

  // Mirrors omp's assistant message records: the session model rides on the
  // nested message object; user and toolResult records carry no model.
  const assistantMessage = (model: string): string =>
    `${JSON.stringify({
      type: "message",
      id: "m1",
      timestamp: "2024-01-02T03:04:06.000Z",
      message: { role: "assistant", model, provider: "zai", content: [{ type: "text", text: "reply" }] },
    })}\n`;

  test("reads the title slot and assistant-message model from a synthetic omp session file", () => {
    // Real filesystem access against synthetic fixture data — no fs fakes.
    const resolver = createSessionFactsResolver({
      codexIndexPath: "/nonexistent/.codex/session_index.jsonl",
      zcodeDatabasePath: "/nonexistent/.zcode/cli/db/db.sqlite",
      grokSessionsRoot: "/nonexistent/grok/sessions",
    });
    const updates = resolver.resolve([
      { provider: "omp", sessionId: "o1", title: null, model: null, activityLine: null, transcriptPath: FIXTURE_PATH },
    ]);
    expect(updates.titles).toEqual([{ provider: "omp", sessionId: "o1", title: FIXTURE_TITLE }]);
    expect(updates.models).toEqual([{ provider: "omp", sessionId: "o1", model: FIXTURE_MODEL }]);
  });

  test("caches per path on mtime and size", () => {
    const { resolver, fs } = makeResolver({
      zcodeDatabasePath: "/nonexistent/.zcode/cli/db/db.sqlite",
      stats: { "/sessions/o1.jsonl": { mtimeMs: 100, size: 900 } },
      heads: { "/sessions/o1.jsonl": `${slotRecord("Auto-titled session")}{"type":"session","version":3}\n` },
    });
    expect(resolver.resolve([ompTarget()]).titles).toEqual([
      { provider: "omp", sessionId: "o1", title: "Auto-titled session" },
    ]);
    expect(fs.headReads()).toBe(1);

    expect(resolver.resolve([ompTarget({ title: "Auto-titled session" })]).titles).toEqual([]);
    expect(fs.headReads()).toBe(1);

    fs.stats.set("/sessions/o1.jsonl", { mtimeMs: 200, size: 1200 });
    fs.heads.set("/sessions/o1.jsonl", slotRecord("Retitled"));
    expect(resolver.resolve([ompTarget({ title: "Auto-titled session" })]).titles).toEqual([
      { provider: "omp", sessionId: "o1", title: "Retitled" },
    ]);
    expect(fs.headReads()).toBe(2);
  });

  test("falls back to the first parseable JSONL title line after the untitled 256-byte slot", () => {
    // Wire-exact boundary: the untitled slot occupies exactly the first
    // OMP_SLOT_BYTES bytes, and the title_change record lives beyond them.
    expect(Buffer.byteLength(slotRecord(""), "utf8")).toBe(OMP_SLOT_BYTES);
    const { resolver } = makeResolver({
      stats: { "/sessions/o1.jsonl": { mtimeMs: 100, size: 900 } },
      heads: {
        "/sessions/o1.jsonl": `${slotRecord("")}{"type":"message"}\n{"type":"title_change","id":"x","title":"Fallback title"}\n`,
      },
    });
    expect(resolver.resolve([ompTarget()]).titles).toEqual([
      { provider: "omp", sessionId: "o1", title: "Fallback title" },
    ]);
  });

  test("resolves the model from the last assistant message record in the tail", () => {
    const { resolver } = makeResolver({
      stats: { "/sessions/o1.jsonl": { mtimeMs: 100, size: 900 } },
      heads: { "/sessions/o1.jsonl": slotRecord("Auto-titled session") },
      tails: {
        "/sessions/o1.jsonl":
          assistantMessage("glm-4.9") +
          assistantMessage("glm-5.3") +
          `${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "read", content: [] } })}\n`,
      },
    });
    expect(resolver.resolve([ompTarget()]).models).toEqual([{ provider: "omp", sessionId: "o1", model: "glm-5.3" }]);
  });

  test("caches the tail read on mtime and size and skips a matching stored model", () => {
    const { resolver, fs } = makeResolver({
      stats: { "/sessions/o1.jsonl": { mtimeMs: 100, size: 900 } },
      heads: { "/sessions/o1.jsonl": slotRecord("Auto-titled session") },
      tails: { "/sessions/o1.jsonl": assistantMessage("glm-5.3") },
    });
    expect(resolver.resolve([ompTarget()]).models).toEqual([{ provider: "omp", sessionId: "o1", model: "glm-5.3" }]);
    expect(fs.tailReads()).toBe(1);

    expect(resolver.resolve([ompTarget({ title: "Auto-titled session", model: "glm-5.3" })]).models).toEqual([]);
    expect(fs.tailReads()).toBe(1);
  });

  test("proposes no model when the tail has no assistant message record", () => {
    // model_change records are deliberately not a source: a tail window may
    // predate the last one, so only assistant messages are authoritative.
    const { resolver } = makeResolver({
      stats: { "/sessions/o1.jsonl": { mtimeMs: 100, size: 900 } },
      heads: { "/sessions/o1.jsonl": slotRecord("Auto-titled session") },
      tails: { "/sessions/o1.jsonl": `${JSON.stringify({ type: "model_change", model: "zai/glm-5.3" })}\n` },
    });
    expect(resolver.resolve([ompTarget()]).models).toEqual([]);
  });

  test("an untitled slot with no fallback line resolves nothing; a missing file never throws", () => {
    const { resolver } = makeResolver({
      stats: { "/sessions/o1.jsonl": { mtimeMs: 100, size: 900 } },
      heads: { "/sessions/o1.jsonl": `${slotRecord("")}not-json\n{"type":"message"}\n` },
    });
    expect(resolver.resolve([ompTarget()]).titles).toEqual([]);

    const missing = makeResolver();
    expect(missing.resolver.resolve([ompTarget()]).titles).toEqual([]);
  });

  test("skips omp rows without a transcript path", () => {
    const { resolver, fs } = makeResolver();
    expect(resolver.resolve([ompTarget({ transcriptPath: null })]).titles).toEqual([]);
    expect(fs.headReads()).toBe(0);
    expect(fs.tailReads()).toBe(0);
  });
});

describe("grok summary.json facts", () => {
  const GROK_ROOT = "/fake/grok/sessions";
  const GROK_ID = "01a00c8e-d275-75b1-bc98-6bf70e28fcdb";
  const GROK_SUMMARY = `${GROK_ROOT}/%2FUsers%2Fyou%2Fproject/${GROK_ID}/summary.json`;

  const grokTarget = (overrides: Partial<TitleTarget> = {}): TitleTarget => ({
    provider: "grok",
    sessionId: GROK_ID,
    title: null,
    model: null,
    activityLine: null,
    transcriptPath: null,
    ...overrides,
  });

  const grokSeed = (summary: string) => ({
    grokSessionsRoot: GROK_ROOT,
    lists: { [GROK_ROOT]: ["%2FUsers%2Fyou%2Fproject"] },
    stats: { [GROK_SUMMARY]: { mtimeMs: 100, size: summary.length } },
    wholes: { [GROK_SUMMARY]: summary },
  });

  test("resolves title and model from summary.json found by group glob", () => {
    const { resolver } = makeResolver(
      grokSeed(
        JSON.stringify({
          info: { id: GROK_ID, cwd: "/Users/you/project" },
          session_summary: "Fallback title",
          generated_title: "Pi/OMP Ghostty Activation Spec Review",
          current_model_id: "grok-4.6",
        }),
      ),
    );
    expect(resolver.resolve([grokTarget()])).toEqual({
      titles: [{ provider: "grok", sessionId: GROK_ID, title: "Pi/OMP Ghostty Activation Spec Review" }],
      models: [{ provider: "grok", sessionId: GROK_ID, model: "grok-4.6" }],
      activities: [],
    });
  });

  test("falls back to session_summary when generated_title is absent or empty", () => {
    const { resolver } = makeResolver(
      grokSeed(
        JSON.stringify({ session_summary: "Fallback title", generated_title: "", current_model_id: "grok-4.6" }),
      ),
    );
    expect(resolver.resolve([grokTarget()]).titles).toEqual([
      { provider: "grok", sessionId: GROK_ID, title: "Fallback title" },
    ]);
  });

  test("bounds an oversized current_model_id to the registry model column cap", () => {
    const { resolver } = makeResolver(
      grokSeed(JSON.stringify({ generated_title: "T", current_model_id: "x".repeat(300) })),
    );
    expect(resolver.resolve([grokTarget()]).models).toEqual([
      { provider: "grok", sessionId: GROK_ID, model: "x".repeat(256) },
    ]);
  });

  test("proposes nothing when the stored values already match", () => {
    const { resolver } = makeResolver(
      grokSeed(JSON.stringify({ generated_title: "Same", current_model_id: "grok-4.6" })),
    );
    expect(resolver.resolve([grokTarget({ title: "Same", model: "grok-4.6" })])).toEqual({
      titles: [],
      models: [],
      activities: [],
    });
  });

  test("caches on (mtime, size): an unchanged summary costs one stat, no re-read", () => {
    const { resolver, fs } = makeResolver(
      grokSeed(JSON.stringify({ generated_title: "T", current_model_id: "grok-4.6" })),
    );
    resolver.resolve([grokTarget()]);
    const readsAfterFirst = fs.wholeReads();
    resolver.resolve([grokTarget()]);
    expect(fs.wholeReads()).toBe(readsAfterFirst);
  });

  test("re-reads when the stat identity changes", () => {
    const seed = grokSeed(JSON.stringify({ generated_title: "Before", current_model_id: "grok-4.6" }));
    const { resolver, fs } = makeResolver(seed);
    expect(resolver.resolve([grokTarget()]).titles[0]?.title).toBe("Before");
    fs.wholes.set(GROK_SUMMARY, JSON.stringify({ generated_title: "After", current_model_id: "grok-4.7" }));
    fs.stats.set(GROK_SUMMARY, { mtimeMs: 200, size: 60 });
    expect(resolver.resolve([grokTarget()])).toEqual({
      titles: [{ provider: "grok", sessionId: GROK_ID, title: "After" }],
      models: [{ provider: "grok", sessionId: GROK_ID, model: "grok-4.7" }],
      activities: [],
    });
  });

  test("a missing session, missing summary, or malformed JSON resolves nothing and never throws", () => {
    expect(makeResolver().resolver.resolve([grokTarget()])).toEqual({ titles: [], models: [], activities: [] });
    const emptyGroup = makeResolver({ grokSessionsRoot: GROK_ROOT, lists: { [GROK_ROOT]: [] } });
    expect(emptyGroup.resolver.resolve([grokTarget()])).toEqual({ titles: [], models: [], activities: [] });
    const malformed = makeResolver({
      ...grokSeed("not json"),
      wholes: { [GROK_SUMMARY]: "not json" },
    });
    expect(malformed.resolver.resolve([grokTarget()])).toEqual({ titles: [], models: [], activities: [] });
  });

  test("a summary without facts proposes nothing (never clears)", () => {
    const { resolver } = makeResolver(grokSeed(JSON.stringify({ info: { id: GROK_ID } })));
    expect(resolver.resolve([grokTarget()])).toEqual({ titles: [], models: [], activities: [] });
  });

  test("bounds a stored title to exactly 256 code points, cutting at an astral boundary", () => {
    const longTitle = `${"🔧".repeat(120)}${"y".repeat(125)}${"🛠".repeat(20)}`;
    const expected = Array.from(longTitle).slice(0, 256).join("");
    const { resolver } = makeResolver(grokSeed(JSON.stringify({ generated_title: longTitle })));
    const title = resolver.resolve([grokTarget()]).titles[0]?.title ?? "";
    expect(Array.from(title)).toHaveLength(256);
    expect(title).toBe(expected);
  });
});

describe("activity line resolution", () => {
  const toolUseLine = (name: string, input: Record<string, unknown>): string =>
    `${JSON.stringify({ type: "assistant", message: { model: "claude-fable-5", content: [{ type: "tool_use", name, input }] } })}\n`;

  const responseItemLine = (payload: Record<string, unknown>): string =>
    `${JSON.stringify({ type: "response_item", payload })}\n`;

  test("resolves a claude title, model, and activity line from ONE tail read", () => {
    const { resolver, fs } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: {
        "/transcripts/s1.jsonl": `${aiTitle("Fix the widget")}${toolUseLine("Read", { file_path: "/src/core/registry.ts" })}${toolUseLine("Bash", { command: "git status --short" })}`,
      },
    });
    const result = resolver.resolve([claudeTarget()]);
    expect(result.titles).toEqual([{ provider: "claude", sessionId: "s1", title: "Fix the widget" }]);
    expect(result.models).toEqual([{ provider: "claude", sessionId: "s1", model: "claude-fable-5" }]);
    // The newest assistant record's tool call wins.
    expect(result.activities).toEqual([{ provider: "claude", sessionId: "s1", activityLine: "Command" }]);
    expect(fs.tailReads()).toBe(1);
  });

  test("prefers the last tool_use item within the newest assistant record", () => {
    const both = `${JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-fable-5",
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", name: "Edit", input: { file_path: "/b.ts" } },
        ],
      },
    })}\n`;
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": both },
    });
    expect(resolver.resolve([claudeTarget()]).activities).toEqual([
      { provider: "claude", sessionId: "s1", activityLine: "File" },
    ]);
  });

  test("falls back to an older assistant record when the newest carries no tool call", () => {
    const textOnly = `${JSON.stringify({
      type: "assistant",
      message: { model: "claude-fable-5", content: [{ type: "text", text: "Done." }] },
    })}\n`;
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": `${toolUseLine("Grep", { pattern: "TODO" })}${textOnly}` },
    });
    expect(resolver.resolve([claudeTarget()]).activities).toEqual([
      { provider: "claude", sessionId: "s1", activityLine: "Search" },
    ]);
  });

  test("classifies command input without retaining any argument content", () => {
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: {
        "/transcripts/s1.jsonl": toolUseLine("Bash", {
          command: "API_TOKEN=top-secret curl https://user:password@example.invalid/private\necho second",
        }),
      },
    });
    const updates = resolver.resolve([claudeTarget()]).activities;
    expect(updates).toEqual([{ provider: "claude", sessionId: "s1", activityLine: "Command" }]);
    expect(JSON.stringify(updates)).not.toContain("top-secret");
    expect(JSON.stringify(updates)).not.toContain("password");
  });

  test("classifies every selected input shape without retaining paths, searches, URLs, or unknown tool names", () => {
    const cases = [
      { name: "Read", input: { file_path: "/private/customer-secret.txt" }, expected: "File" },
      { name: "Grep", input: { pattern: "CONFIDENTIAL_PATTERN" }, expected: "Search" },
      { name: "Search", input: { query: "private acquisition terms" }, expected: "Search" },
      {
        name: "WebFetch",
        input: { url: "https://user:password@example.invalid/private?q=secret" },
        expected: "Request",
      },
      { name: "SECRET_TOOL_NAME", input: {}, expected: "Tool" },
    ] as const;
    for (const [index, entry] of cases.entries()) {
      const path = `/transcripts/${String(index)}.jsonl`;
      const { resolver } = makeResolver({
        stats: { [path]: { mtimeMs: 100, size: 500 } },
        tails: { [path]: toolUseLine(entry.name, entry.input) },
      });
      expect(resolver.resolve([claudeTarget({ transcriptPath: path })]).activities).toEqual([
        { provider: "claude", sessionId: "s1", activityLine: entry.expected },
      ]);
    }
  });

  test("a tool-less transcript proposes no activity; other providers are never read", () => {
    const { resolver, fs } = makeResolver({
      stats: {
        "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 },
        "/transcripts/k1.jsonl": { mtimeMs: 100, size: 500 },
      },
      tails: {
        "/transcripts/s1.jsonl": aiTitle("Only a title"),
        "/transcripts/k1.jsonl": toolUseLine("Bash", { command: "should not be read" }),
      },
    });
    const result = resolver.resolve([
      claudeTarget(),
      {
        provider: "kimi",
        sessionId: "k1",
        title: null,
        model: null,
        transcriptPath: "/transcripts/k1.jsonl",
        activityLine: null,
      },
    ]);
    expect(result.activities).toEqual([]);
    // The kimi transcript is never even read.
    expect(fs.tailReads()).toBe(1);
  });

  test("a stored-equal activity line proposes no update", () => {
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": toolUseLine("Read", { file_path: "/src/core/registry.ts" }) },
    });
    expect(resolver.resolve([claudeTarget({ activityLine: "File" })]).activities).toEqual([]);
  });

  test("resolves a codex function_call's name and cmd head from the rollout tail", () => {
    // Provider-compatible shape: exec_command's arguments are
    // stringified JSON carrying the command under `cmd` (a plain string).
    const call = responseItemLine({
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "git status --short", workdir: "/repo", max_output_tokens: 4000 }),
    });
    const { resolver, fs } = makeResolver({
      stats: {
        [CODEX_INDEX]: { mtimeMs: 100, size: 300 },
        "/rollouts/c1.jsonl": { mtimeMs: 100, size: 400 },
      },
      wholes: { [CODEX_INDEX]: `${JSON.stringify({ id: "c1", thread_name: "Index name" })}\n` },
      tails: { "/rollouts/c1.jsonl": call },
    });
    const result = resolver.resolve([
      {
        provider: "codex",
        sessionId: "c1",
        title: null,
        model: null,
        transcriptPath: "/rollouts/c1.jsonl",
        activityLine: null,
      },
    ]);
    expect(result.activities).toEqual([{ provider: "codex", sessionId: "c1", activityLine: "Command" }]);
    expect(fs.tailReads()).toBe(1);
  });

  test("an exec_command emits only the safe command category", () => {
    // Representative argument keys: cmd (string), workdir, max_output_tokens,
    // yield_time_ms — only cmd's first line may cross the wire.
    const call = responseItemLine({
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: "sed -n '1,220p' /repo/CLAUDE.md\necho should-not-appear",
        workdir: "/Users/you/.codex/worktrees/6e1f/brainstorm",
        max_output_tokens: 4000,
        yield_time_ms: 3000,
      }),
    });
    const { resolver } = makeResolver({
      stats: {
        [CODEX_INDEX]: { mtimeMs: 100, size: 300 },
        "/rollouts/c1.jsonl": { mtimeMs: 100, size: 400 },
      },
      wholes: { [CODEX_INDEX]: "" },
      tails: { "/rollouts/c1.jsonl": call },
    });
    const updates = resolver.resolve([
      {
        provider: "codex",
        sessionId: "c1",
        title: null,
        model: null,
        transcriptPath: "/rollouts/c1.jsonl",
        activityLine: null,
      },
    ]).activities;
    expect(updates).toHaveLength(1);
    const line = updates[0]?.activityLine ?? "";
    expect(line).toBe("Command");
    // The command and every sibling argument stay out.
    expect(line.includes("CLAUDE.md")).toBe(false);
    expect(line.includes("should-not-appear")).toBe(false);
    expect(line.includes("worktrees")).toBe(false);
    expect(line.includes("4000")).toBe(false);
    expect(line.includes("3000")).toBe(false);
  });

  test("resolves a codex local_shell_call as the safe command category", () => {
    const call = responseItemLine({
      type: "local_shell_call",
      action: { type: "exec", command: ["git", "diff", "--stat"] },
    });
    const { resolver } = makeResolver({
      stats: {
        [CODEX_INDEX]: { mtimeMs: 100, size: 300 },
        "/rollouts/c1.jsonl": { mtimeMs: 100, size: 400 },
      },
      wholes: { [CODEX_INDEX]: "" },
      tails: { "/rollouts/c1.jsonl": call },
    });
    expect(
      resolver.resolve([
        {
          provider: "codex",
          sessionId: "c1",
          title: null,
          model: null,
          transcriptPath: "/rollouts/c1.jsonl",
          activityLine: null,
        },
      ]).activities,
    ).toEqual([{ provider: "codex", sessionId: "c1", activityLine: "Command" }]);
  });

  test("a codex function_call with unparseable arguments still names the tool, and non-call items are skipped", () => {
    const truncated = responseItemLine({ type: "function_call", name: "apply_patch", arguments: '{"patch":"***' });
    const message = responseItemLine({ type: "message", role: "assistant" });
    const older = responseItemLine({
      type: "function_call",
      name: "shell",
      arguments: JSON.stringify({ cmd: "ls" }),
    });
    const { resolver } = makeResolver({
      stats: {
        [CODEX_INDEX]: { mtimeMs: 100, size: 300 },
        "/rollouts/c1.jsonl": { mtimeMs: 100, size: 400 },
      },
      wholes: { [CODEX_INDEX]: "" },
      tails: { "/rollouts/c1.jsonl": `${older}${truncated}` },
    });
    // The newest call wins even with unparseable arguments (name only).
    expect(
      resolver.resolve([
        {
          provider: "codex",
          sessionId: "c1",
          title: null,
          model: null,
          transcriptPath: "/rollouts/c1.jsonl",
          activityLine: null,
        },
      ]).activities,
    ).toEqual([{ provider: "codex", sessionId: "c1", activityLine: "Tool" }]);

    const { resolver: second } = makeResolver({
      stats: {
        [CODEX_INDEX]: { mtimeMs: 100, size: 300 },
        "/rollouts/c2.jsonl": { mtimeMs: 100, size: 400 },
      },
      wholes: { [CODEX_INDEX]: "" },
      tails: { "/rollouts/c2.jsonl": `${older}${message}` },
    });
    // A non-call newest record falls through to the older function_call.
    expect(
      second.resolve([
        {
          provider: "codex",
          sessionId: "c2",
          title: null,
          model: null,
          transcriptPath: "/rollouts/c2.jsonl",
          activityLine: null,
        },
      ]).activities,
    ).toEqual([{ provider: "codex", sessionId: "c2", activityLine: "Command" }]);
  });
});
