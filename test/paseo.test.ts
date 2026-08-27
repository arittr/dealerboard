import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createPaseoAgentStateLoader, type PaseoAgentState } from "../src/core/paseo";

const AGENTS_DIR = "/home/test/.paseo/agents";

type FileStat = { mtimeMs: number; size: number };

type FakeFs = {
  dirs: Map<string, string[]>;
  stats: Map<string, FileStat>;
  files: Map<string, string>;
  wholeReads: () => number;
  statCalls: () => number;
};

const makeLoader = (seed: {
  dirs?: Record<string, string[]>;
  stats?: Record<string, FileStat>;
  files?: Record<string, string>;
}): { loader: (dir: string) => PaseoAgentState[]; fs: FakeFs } => {
  const dirs = new Map(Object.entries(seed.dirs ?? {}));
  const stats = new Map(Object.entries(seed.stats ?? {}));
  const files = new Map(Object.entries(seed.files ?? {}));
  let wholeReads = 0;
  let statCalls = 0;
  const loader = createPaseoAgentStateLoader({
    listFiles: (dir) => [...(dirs.get(dir) ?? [])],
    statPath: (path) => {
      statCalls += 1;
      return stats.get(path) ?? null;
    },
    readWhole: (path) => {
      wholeReads += 1;
      return files.get(path) ?? null;
    },
  });
  return {
    loader,
    fs: { dirs, stats, files, wholeReads: () => wholeReads, statCalls: () => statCalls },
  };
};

const agentRecord = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "agent-1",
    provider: "kimi",
    requiresAttention: true,
    persistence: { sessionId: "session_abc" },
    runtimeInfo: { sessionId: "session_abc" },
    ...overrides,
  });

const oneRecordFs = (): Record<string, string[]> => ({
  [AGENTS_DIR]: ["work"],
  [join(AGENTS_DIR, "work")]: ["agent-1.json"],
});

describe("createPaseoAgentStateLoader", () => {
  test("joins on the current session ID and maps attention and parentage", () => {
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: agentRecord() },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-1",
        requiresAttention: true,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: null,
        archivedAt: null,
        title: null,
        lastStatus: null,
      },
    ]);
  });

  test("parses lastStatus for the registry's settle repair, dropping unknown values", () => {
    const path = join(AGENTS_DIR, "work/agent-1.json");
    const { loader, fs } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [path]: { mtimeMs: 100, size: 500 } },
      files: { [path]: agentRecord({ lastStatus: "idle" }) },
    });
    expect(loader(AGENTS_DIR)[0]?.lastStatus).toBe("idle");

    // A value outside Paseo's lifecycle vocabulary is no settle evidence.
    fs.stats.set(path, { mtimeMs: 101, size: 501 });
    fs.files.set(path, agentRecord({ lastStatus: "haywire" }));
    expect(loader(AGENTS_DIR)[0]?.lastStatus).toBeNull();

    // Records predating the field parse as unreported.
    fs.stats.set(path, { mtimeMs: 102, size: 502 });
    fs.files.set(path, agentRecord());
    expect(loader(AGENTS_DIR)[0]?.lastStatus).toBeNull();
  });

  test("prefers the current runtime session when it differs from the persisted session", () => {
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: {
        [join(AGENTS_DIR, "work/agent-1.json")]: agentRecord({
          persistence: { sessionId: "session_old" },
          runtimeInfo: { sessionId: "session_current" },
        }),
      },
    });

    expect(loader(AGENTS_DIR)[0]?.sessionId).toBe("session_current");
  });

  test("parses attentionTimestamp and updatedAt for the registry watermark", () => {
    const content = agentRecord({
      attentionTimestamp: "2026-08-06T00:10:00.000Z",
      updatedAt: "2026-08-06T00:12:00.000Z",
    });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-1",
        requiresAttention: true,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: "2026-08-06T00:10:00.000Z",
        updatedAt: "2026-08-06T00:12:00.000Z",
        archivedAt: null,
        title: null,
        lastStatus: null,
      },
    ]);
  });

  test("parses archivedAt canonically for the sync's viewed-equivalent path", () => {
    const content = agentRecord({ archivedAt: "2026-08-16T11:25:52.816-07:00" });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)[0]?.archivedAt).toBe("2026-08-16T18:25:52.816Z");
  });

  test("non-string timestamps parse as null", () => {
    const content = agentRecord({ attentionTimestamp: 42, updatedAt: false });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-1",
        requiresAttention: true,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: null,
        archivedAt: null,
        title: null,
        lastStatus: null,
      },
    ]);
  });

  test("uses runtimeInfo.sessionId when persistence is absent and flags subagents from parentAgentId", () => {
    const content = agentRecord({
      id: "agent-2",
      persistence: undefined,
      parentAgentId: "agent-1",
    });
    const { loader } = makeLoader({
      dirs: {
        [AGENTS_DIR]: ["work"],
        [join(AGENTS_DIR, "work")]: ["agent-2.json"],
      },
      stats: { [join(AGENTS_DIR, "work/agent-2.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-2.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-2",
        requiresAttention: true,
        isSubagent: true,
        parentAgentId: "agent-1",
        attentionTimestamp: null,
        updatedAt: null,
        archivedAt: null,
        title: null,
        lastStatus: null,
      },
    ]);
  });

  test("flags subagents from the paseo.parent-agent-id label (the persisted shape)", () => {
    const content = agentRecord({
      id: "agent-2",
      labels: {
        "paseo.parent-agent-id": "agent-1",
        "paseo.open-agent-tab.cid123": "true",
      },
    });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-2",
        requiresAttention: true,
        isSubagent: true,
        parentAgentId: "agent-1",
        attentionTimestamp: null,
        updatedAt: null,
        archivedAt: null,
        title: null,
        lastStatus: null,
      },
    ]);
  });

  test("other labels alone do not mark a subagent", () => {
    const content = agentRecord({ labels: { "paseo.open-agent-tab.cid123": "true" } });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-1",
        requiresAttention: true,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: null,
        archivedAt: null,
        title: null,
        lastStatus: null,
      },
    ]);
  });

  test("normalizes offset-form timestamps to canonical UTC", () => {
    const content = agentRecord({
      attentionTimestamp: "2026-08-06T02:10:00+02:00",
      updatedAt: "2026-08-06T00:12:00.000Z",
    });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-1",
        requiresAttention: true,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: "2026-08-06T00:10:00.000Z",
        updatedAt: "2026-08-06T00:12:00.000Z",
        archivedAt: null,
        title: null,
        lastStatus: null,
      },
    ]);
  });

  test("unparseable timestamp strings parse as null", () => {
    const content = agentRecord({ attentionTimestamp: "not a timestamp", updatedAt: "2026-13-40" });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-1",
        requiresAttention: true,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: null,
        archivedAt: null,
        title: null,
        lastStatus: null,
      },
    ]);
  });

  test("evicts cache entries for files missing from a pass", () => {
    const path = join(AGENTS_DIR, "work/agent-1.json");
    const { loader, fs } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [path]: { mtimeMs: 100, size: 500 } },
      files: { [path]: agentRecord() },
    });
    expect(loader(AGENTS_DIR)).toHaveLength(1);
    expect(fs.wholeReads()).toBe(1);

    // The file vanishes for a pass: its cache entry must be evicted.
    fs.dirs.set(join(AGENTS_DIR, "work"), []);
    fs.stats.delete(path);
    expect(loader(AGENTS_DIR)).toHaveLength(0);

    // It returns with the same (mtime, size) identity; without eviction this
    // would be a stale cache hit and skip the read.
    fs.dirs.set(join(AGENTS_DIR, "work"), ["agent-1.json"]);
    fs.stats.set(path, { mtimeMs: 100, size: 500 });
    expect(loader(AGENTS_DIR)).toHaveLength(1);
    expect(fs.wholeReads()).toBe(2);
  });

  test("requiresAttention defaults to false when absent", () => {
    const content = agentRecord({ requiresAttention: undefined });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-1",
        requiresAttention: false,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: null,
        archivedAt: null,
        title: null,
        lastStatus: null,
      },
    ]);
  });

  test("caches unchanged files on (mtime, size): one read per identity", () => {
    const path = join(AGENTS_DIR, "work/agent-1.json");
    const { loader, fs } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [path]: { mtimeMs: 100, size: 500 } },
      files: { [path]: agentRecord() },
    });
    expect(loader(AGENTS_DIR)).toHaveLength(1);
    expect(loader(AGENTS_DIR)).toHaveLength(1);
    expect(fs.wholeReads()).toBe(1);

    // A new (mtime, size) identity re-reads the file.
    fs.stats.set(path, { mtimeMs: 101, size: 500 });
    expect(loader(AGENTS_DIR)).toHaveLength(1);
    expect(fs.wholeReads()).toBe(2);
  });

  test("malformed and incomplete records are skipped, never void the pass", () => {
    const good = join(AGENTS_DIR, "work/agent-1.json");
    const garbage = join(AGENTS_DIR, "work/broken.json");
    const noSession = join(AGENTS_DIR, "work/no-session.json");
    const { loader } = makeLoader({
      dirs: {
        [AGENTS_DIR]: ["work"],
        [join(AGENTS_DIR, "work")]: ["agent-1.json", "broken.json", "no-session.json", "notes.txt"],
      },
      stats: {
        [good]: { mtimeMs: 100, size: 500 },
        [garbage]: { mtimeMs: 100, size: 9 },
        [noSession]: { mtimeMs: 100, size: 40 },
      },
      files: {
        [good]: agentRecord(),
        [garbage]: "{not json",
        [noSession]: agentRecord({ persistence: {}, runtimeInfo: {} }),
      },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-1",
        requiresAttention: true,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: null,
        archivedAt: null,
        title: null,
        lastStatus: null,
      },
    ]);
  });

  test("skips records whose provider is not a known provider", () => {
    const content = agentRecord({ provider: "not-a-provider" });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([]);
  });

  test("maps Paseo's qwen-code provider onto the registry's qwen key", () => {
    const content = agentRecord({ provider: "qwen-code" });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR).map((state) => state.provider)).toEqual(["qwen"]);
  });

  test("maps Paseo's claude-work provider onto the registry's claude key", () => {
    const content = agentRecord({ provider: "claude-work" });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR).map((state) => state.provider)).toEqual(["claude"]);
  });

  test("a missing agents directory or empty workspace yields an empty list", () => {
    const { loader } = makeLoader({ dirs: {} });
    expect(loader(AGENTS_DIR)).toEqual([]);

    const empty = makeLoader({ dirs: { [AGENTS_DIR]: ["work"], [join(AGENTS_DIR, "work")]: [] } });
    expect(empty.loader(AGENTS_DIR)).toEqual([]);
  });

  test("extracts title from runtimeInfo.extra.title", () => {
    const content = agentRecord({
      runtimeInfo: {
        sessionId: "session_abc",
        extra: { title: "my full title from runtimeInfo" },
      },
    });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-1",
        requiresAttention: true,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: null,
        archivedAt: null,
        title: "my full title from runtimeInfo",
        lastStatus: null,
      },
    ]);
  });

  test("extracts title from persistence.metadata.title as fallback", () => {
    const content = agentRecord({
      runtimeInfo: { sessionId: "session_abc" },
      persistence: {
        sessionId: "session_abc",
        metadata: { title: "title from persistence metadata" },
      },
    });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-1",
        requiresAttention: true,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: null,
        archivedAt: null,
        title: "title from persistence metadata",
        lastStatus: null,
      },
    ]);
  });

  test("extracts the top-level title when nested titles are missing", () => {
    const content = agentRecord({
      title: "top-level truncated title",
      runtimeInfo: { sessionId: "session_abc" },
      persistence: { sessionId: "session_abc" },
    });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-1",
        requiresAttention: true,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: null,
        archivedAt: null,
        title: "top-level truncated title",
        lastStatus: null,
      },
    ]);
  });

  test("prefers a Paseo-renamed top-level title over stale nested titles", () => {
    const content = agentRecord({
      title: "renamed in Paseo",
      runtimeInfo: {
        sessionId: "session_abc",
        extra: { title: "original runtime title" },
      },
      persistence: {
        sessionId: "session_abc",
        metadata: { title: "original persistence title" },
      },
    });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)[0]?.title).toBe("renamed in Paseo");
  });

  test("bounds title to 256 code points", () => {
    const longTitle = "a".repeat(300);
    const content = agentRecord({
      runtimeInfo: {
        sessionId: "session_abc",
        extra: { title: longTitle },
      },
    });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-1",
        requiresAttention: true,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: null,
        archivedAt: null,
        title: "a".repeat(256),
        lastStatus: null,
      },
    ]);
  });

  test("prefers runtimeInfo.extra.title over persistence.metadata.title", () => {
    const content = agentRecord({
      runtimeInfo: {
        sessionId: "session_abc",
        extra: { title: "runtime title" },
      },
      persistence: {
        sessionId: "session_abc",
        metadata: { title: "persistence title" },
      },
    });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)).toEqual([
      {
        provider: "kimi",
        sessionId: "session_abc",
        agentId: "agent-1",
        requiresAttention: true,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: null,
        archivedAt: null,
        title: "runtime title",
        lastStatus: null,
      },
    ]);
  });

  test("bounds an oversized parent agent id to 256 code points", () => {
    const content = agentRecord({ parentAgentId: "a".repeat(300) });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)[0]?.parentAgentId).toBe("a".repeat(256));
  });
});
