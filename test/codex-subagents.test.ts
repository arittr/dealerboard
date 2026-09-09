import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectionDaemon } from "../src/core/daemon";
import { resolveAppPaths } from "../src/core/paths";
import { readProjection } from "../src/core/projection";
import { decodeNativeHook } from "../src/core/providers";
import { applyRegistryEvents, listTitleTargets } from "../src/core/registry";
import { initializeDatabase, openRegistryDatabase } from "../src/core/schema";
import { createSessionFactsResolver } from "../src/core/titles";

const at = (second: number): string => new Date(Date.UTC(2026, 8, 9, 3, 0, second)).toISOString();
let home: string;
let db: Database;
let codex: Database;
let databasePath: string;
let rolloutPath: string;
let resolver: ReturnType<typeof createSessionFactsResolver>;

const event = (type: string, turnId: string, second: number): string =>
  `${JSON.stringify({ timestamp: at(second), type: "event_msg", payload: { type, turn_id: turnId } })}\n`;

const hook = (name: string, second: number): void => {
  applyRegistryEvents(
    db,
    decodeNativeHook(
      "codex",
      {
        hook_event_name: name,
        session_id: "root",
        agent_id: "child",
        agent_type: "default",
        transcript_path: "/root.jsonl",
        cwd: "/repo",
      },
      at(second),
    ),
  );
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dealerboard-codex-children-"));
  const paths = resolveAppPaths(home);
  initializeDatabase(paths);
  db = openRegistryDatabase(paths.database, "readwrite");
  databasePath = join(home, "state_5.sqlite");
  rolloutPath = join(home, "child.jsonl");
  codex = new Database(databasePath);
  codex.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, source TEXT, agent_path TEXT, agent_nickname TEXT,
    model TEXT, rollout_path TEXT, archived INTEGER
  ); CREATE INDEX idx_threads_source ON threads(source);`);
  codex.run("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, 0)", [
    "child",
    JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "root" } } }),
    "/root/artifact_image_builds",
    "Lovelace",
    "gpt-5.6-sol",
    rolloutPath,
  ]);
  writeFileSync(
    rolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: "child" } })}\n${event("task_started", "turn-1", 2)}`,
  );
  resolver = createSessionFactsResolver({
    codexDatabasePath: databasePath,
    codexIndexPath: join(home, "session_index.jsonl"),
    kimiIndexPath: join(home, "kimi.jsonl"),
    zcodeDatabasePath: join(home, "missing.sqlite"),
    grokSessionsRoot: join(home, "grok"),
  });
  hook("SessionStart", 0);
  hook("SubagentStart", 3);
});

afterEach(() => {
  db.close();
  codex.close();
  rmSync(home, { recursive: true, force: true });
});

const row = () =>
  db.query("SELECT title, model, status, transcript_path FROM active_sessions WHERE session_id = 'child'").get();

const runPass = async (): Promise<void> => {
  let tick: () => void = () => {};
  let ready: () => void = () => {};
  const loaded = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const daemon = new ProjectionDaemon(resolveAppPaths(home), {
    now: () => at(10),
    nowMs: () => Date.parse(at(10)),
    schedule: (poll) => {
      tick = poll;
      return () => {};
    },
    resolveFacts: async (targets) => {
      const facts = await resolver.resolve(targets);
      ready();
      return facts;
    },
  });
  daemon.start();
  try {
    await loaded;
    await new Promise<void>((resolve) => setImmediate(resolve));
    tick();
  } finally {
    daemon.stop();
  }
};

test("enriches a native Codex child with its task name, model and rollout", async () => {
  await runPass();
  expect(row()).toEqual({
    title: "artifact_image_builds",
    model: "gpt-5.6-sol",
    status: "working",
    transcript_path: rolloutPath,
  });
  expect(listTitleTargets(db).some((target) => target.sessionId === "child")).toBe(true);
});

for (const terminal of ["task_complete", "turn_aborted"]) {
  test(`removes a child after recorded ${terminal} even without a stop hook`, async () => {
    appendFileSync(rolloutPath, event(terminal, "turn-1", 4));
    await runPass();
    expect(row()).toBeNull();
    expect(db.query("SELECT session_id FROM active_sessions").all()).toEqual([{ session_id: "root" }]);
  });
}

test("rediscovers a resumed child and ignores a delayed terminal from its prior turn", async () => {
  appendFileSync(rolloutPath, event("turn_aborted", "turn-1", 4));
  await runPass();
  expect(row()).toBeNull();
  appendFileSync(rolloutPath, event("task_started", "turn-2", 5) + event("task_complete", "turn-1", 6));
  await runPass();
  expect(row()).toMatchObject({ title: "artifact_image_builds", status: "working" });
});

test("does not infer completion from missing or incomplete rollout evidence", async () => {
  rmSync(rolloutPath);
  await runPass();
  expect(row()).not.toBeNull();
  writeFileSync(
    rolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: "child" } })}\n${event("task_complete", "unknown-turn", 4)}`,
  );
  await runPass();
  expect(row()).not.toBeNull();
});

test("rejects a rollout whose session identity belongs to another thread", async () => {
  writeFileSync(
    rolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: "other" } })}\n${event("task_started", "turn-1", 2)}${event("turn_aborted", "turn-1", 4)}`,
  );
  await runPass();
  expect(row()).not.toBeNull();
});

test("a hook arriving while a sweep runs prevents its stale lifecycle result from applying", async () => {
  appendFileSync(rolloutPath, event("turn_aborted", "turn-1", 4));
  let tick: () => void = () => {};
  let finish: (() => void) | undefined;
  let ready: (() => void) | undefined;
  const loaded = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const daemon = new ProjectionDaemon(resolveAppPaths(home), {
    now: () => at(10),
    nowMs: () => Date.parse(at(10)),
    schedule: (poll) => {
      tick = poll;
      return () => {};
    },
    resolveFacts: async (targets) => {
      const facts = await resolver.resolve(targets);
      ready?.();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return facts;
    },
  });
  daemon.start();
  try {
    await loaded;
    hook("SubagentStart", 5);
    finish?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    tick();
    expect(row()).not.toBeNull();
  } finally {
    daemon.stop();
  }
});

test("does not recreate a child whose parent was removed during the sweep", async () => {
  hook("SubagentStop", 4);
  hook("SessionEnd", 5);
  await runPass();
  expect(readProjection(db).agents).toEqual([]);
});

test("generic Codex profile is not presented as a task name", () => {
  const events = decodeNativeHook(
    "codex",
    { hook_event_name: "SubagentStart", session_id: "root", agent_id: "child", agent_type: "default" },
    at(0),
  );
  expect(events[0]).toMatchObject({ title: null });
});

test("recorded activity keeps a long-running child live without refreshing it from the polling clock", async () => {
  appendFileSync(
    rolloutPath,
    `${JSON.stringify({ timestamp: at(8), type: "response_item", payload: { type: "function_call", name: "exec", arguments: "{}" } })}\n`,
  );
  await runPass();
  expect(db.query("SELECT status, updated_at FROM active_sessions WHERE session_id = 'child'").get()).toEqual({
    status: "working",
    updated_at: at(8),
  });
});

test("a partial terminal line preserves the child until its newline arrives", async () => {
  await runPass();
  const terminal = event("turn_aborted", "turn-1", 4);
  appendFileSync(rolloutPath, terminal.slice(0, -1));
  await runPass();
  expect(row()).not.toBeNull();
  appendFileSync(rolloutPath, "\n");
  await runPass();
  expect(row()).toBeNull();
});

test("a replaced rollout cannot reuse the cached terminal state", async () => {
  appendFileSync(rolloutPath, event("turn_aborted", "turn-1", 4));
  await runPass();
  expect(row()).toBeNull();
  rmSync(rolloutPath);
  writeFileSync(
    rolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: "child" } })}\n${event("task_started", "turn-2", 5)}`,
  );
  await runPass();
  expect(row()).toMatchObject({ status: "working" });
});

test("unreadable Codex state preserves registered children and other provider facts", async () => {
  codex.exec("DROP TABLE threads");
  const facts = await resolver.resolve(listTitleTargets(db));
  expect(facts.codexSubagents).toEqual([]);
  await runPass();
  expect(row()).not.toBeNull();
});

test("rollout scanning progresses past a message larger than its per-pass budget", async () => {
  appendFileSync(
    rolloutPath,
    `${JSON.stringify({ type: "response_item", payload: { type: "message", content: "x".repeat(5 * 1024 * 1024) } })}\n${event("turn_aborted", "turn-1", 4)}`,
  );
  await runPass();
  expect(row()).not.toBeNull();
  await runPass();
  expect(row()).toBeNull();
});
