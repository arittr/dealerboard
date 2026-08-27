import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths } from "../src/core/paths";
import { initializeDatabase, openRegistryDatabase, UnsupportedSchemaVersion } from "../src/core/schema";
import { PROVIDER_KEYS } from "../src/protocol";

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "dealerboard-schema-"));
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

const modeOf = (path: string): number => statSync(path).mode & 0o777;

const INSERT_SESSION = `
  INSERT INTO active_sessions
    (provider, session_id, parent_session_id, status, title, project, logical_slot, opened_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const insertSession = (
  db: Database,
  sessionId: string,
  parentSessionId: string | null,
  logicalSlot: number | null,
): void => {
  db.run(INSERT_SESSION, [
    "claude",
    sessionId,
    parentSessionId,
    "idle",
    null,
    null,
    logicalSlot,
    "2026-08-06T00:00:00.000Z",
    "2026-08-06T00:00:00.000Z",
  ]);
};

const countSessions = (db: Database): number => {
  const row = db.query("SELECT COUNT(*) AS n FROM active_sessions").get() as { n: number } | null;
  if (row === null) {
    throw new Error("COUNT(*) must return one row");
  }
  return row.n;
};

const createVersion1Database = (path: string): void => {
  const legacy = new Database(path, { create: true, readwrite: true });
  try {
    legacy.exec(`
      CREATE TABLE active_sessions (
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'kimi')),
        session_id TEXT NOT NULL,
        parent_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('idle', 'working', 'waiting', 'error')),
        title TEXT,
        project TEXT,
        logical_slot INTEGER,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, session_id),
        FOREIGN KEY (provider, parent_session_id)
          REFERENCES active_sessions(provider, session_id) ON DELETE CASCADE,
        CHECK (
          (parent_session_id IS NULL AND logical_slot IS NOT NULL AND logical_slot > 0)
          OR
          (parent_session_id IS NOT NULL AND logical_slot IS NULL)
        )
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX active_sessions_unique_slot
        ON active_sessions(logical_slot)
        WHERE logical_slot IS NOT NULL;
      PRAGMA user_version = 1;
    `);
    legacy.run(
      `INSERT INTO active_sessions
         (provider, session_id, parent_session_id, status, title, project, logical_slot, opened_at, updated_at)
       VALUES ('claude', 'legacy', NULL, 'waiting', 'Legacy', 'project', 4, 'opened', 'updated')`,
    );
  } finally {
    legacy.close();
  }
};

describe("resolveAppPaths", () => {
  test("returns the exact canonical per-user paths under the given home", () => {
    const root = join(tempHome, "Library/Application Support/com.drewritter.dealerboard");
    const paths = resolveAppPaths(tempHome);
    expect(paths.root).toBe(root);
    expect(paths.binDirectory).toBe(join(root, "bin"));
    expect(paths.executable).toBe(join(root, "bin/dealerboard"));
    expect(paths.database).toBe(join(root, "registry.sqlite3"));
    expect(paths.snapshot).toBe(join(root, "snapshot-v2.json"));
    expect(paths.quotaSnapshot).toBe(join(root, "quota-snapshot.json"));
    expect(paths.tokenUsageSnapshot).toBe(join(root, "token-usage-snapshot.json"));
    expect(paths.logsDirectory).toBe(join(root, "logs"));
    expect(paths.launchAgent).toBe(join(tempHome, "Library/LaunchAgents/com.drewritter.dealerboard.plist"));
  });

  test("defaults to the current user's home directory", () => {
    expect(resolveAppPaths().database).toBe(
      join(homedir(), "Library/Application Support/com.drewritter.dealerboard/registry.sqlite3"),
    );
  });
});

describe("initializeDatabase", () => {
  test("initializes a WAL database at user_version 14 with foreign keys on every connection", () => {
    const paths = resolveAppPaths(tempHome);
    expect(paths.database).toBe(
      join(tempHome, "Library/Application Support/com.drewritter.dealerboard/registry.sqlite3"),
    );

    initializeDatabase(paths);
    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
    }

    const readonlyDb = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(readonlyDb.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(() => readonlyDb.run("DELETE FROM active_sessions")).toThrow();
    } finally {
      readonlyDb.close();
    }
  });

  test("creates the application directory at mode 0700 and the database at mode 0600", () => {
    const paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);
    expect(modeOf(paths.root)).toBe(0o700);
    expect(modeOf(paths.binDirectory)).toBe(0o700);
    expect(modeOf(paths.logsDirectory)).toBe(0o700);
    expect(modeOf(paths.database)).toBe(0o600);
  });

  test("corrects a permissive pre-existing application directory mode", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true, mode: 0o755 });
    chmodSync(paths.root, 0o755);
    initializeDatabase(paths);
    expect(modeOf(paths.root)).toBe(0o700);
  });

  test("init is idempotent and preserves existing rows", () => {
    const paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);
    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      insertSession(db, "kept", null, 1);
    } finally {
      db.close();
    }

    initializeDatabase(paths);

    const verify = openRegistryDatabase(paths.database, "readwrite");
    try {
      expect(countSessions(verify)).toBe(1);
      expect(verify.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      expect(verify.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    } finally {
      verify.close();
    }
  });

  test("migrates v1 rows additively to v9 with null bindings, no outstanding background work, no transcript, and no model", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion1Database(paths.database);

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      expect(
        db
          .query(
            "SELECT session_id, status, logical_slot, ghostty_terminal_id, background_outstanding, transcript_path, model FROM active_sessions",
          )
          .get(),
      ).toEqual({
        session_id: "legacy",
        status: "waiting",
        logical_slot: 4,
        ghostty_terminal_id: null,
        background_outstanding: 0,
        transcript_path: null,
        model: null,
      });
    } finally {
      db.close();
    }
  });

  test("rejects an unsupported user_version without mutating the database", () => {
    const paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);

    const raw = new Database(paths.database);
    try {
      raw.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY)");
      raw.run("INSERT INTO sentinel (id) VALUES (1)");
      raw.exec("PRAGMA user_version = 99");
    } finally {
      raw.close();
    }

    expect(() => initializeDatabase(paths)).toThrow(UnsupportedSchemaVersion);
    expect(() => openRegistryDatabase(paths.database, "readwrite")).toThrow(UnsupportedSchemaVersion);
    expect(() => openRegistryDatabase(paths.database, "readonly")).toThrow(UnsupportedSchemaVersion);

    const verify = new Database(paths.database, { readonly: true });
    try {
      expect(verify.query("SELECT id FROM sentinel").all()).toEqual([{ id: 1 }]);
      expect(verify.query("PRAGMA user_version").get()).toEqual({ user_version: 99 });
    } finally {
      verify.close();
    }
  });
});

describe("openRegistryDatabase", () => {
  test("refuses to implicitly create a missing registry", () => {
    const missing = join(tempHome, "missing.sqlite3");
    expect(() => openRegistryDatabase(missing, "readwrite")).toThrow();
    expect(() => openRegistryDatabase(missing, "readonly")).toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});

describe("active_sessions contract", () => {
  const openInitialized = (): Database => {
    const paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);
    return openRegistryDatabase(paths.database, "readwrite");
  };

  const insertWithTarget = (
    db: Database,
    provider: "claude" | "codex" | "kimi",
    sessionId: string,
    parentSessionId: string | null,
    logicalSlot: number | null,
    ghosttyTerminalId: string | null,
  ): void => {
    db.run(
      `INSERT INTO active_sessions
         (provider, session_id, parent_session_id, status, title, project, logical_slot, opened_at, updated_at, ghostty_terminal_id)
       VALUES (?, ?, ?, 'idle', NULL, NULL, ?, 'opened', 'updated', ?)`,
      [provider, sessionId, parentSessionId, logicalSlot, ghosttyTerminalId],
    );
  };

  test("enforces the parent/slot CHECK", () => {
    const db = openInitialized();
    try {
      // A top-level session must carry a positive logical slot.
      expect(() => insertSession(db, "no-slot", null, null)).toThrow();
      expect(() => insertSession(db, "zero-slot", null, 0)).toThrow();
      insertSession(db, "parent", null, 1);
      // A child session must not carry a logical slot.
      expect(() => insertSession(db, "slotted-child", "parent", 2)).toThrow();
      insertSession(db, "child", "parent", null);
      expect(countSessions(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  test("enforces one top-level session per logical slot through the partial index", () => {
    const db = openInitialized();
    try {
      insertSession(db, "first", null, 1);
      expect(() => insertSession(db, "second", null, 1)).toThrow();
      // Children share the NULL slot without colliding.
      insertSession(db, "child-a", "first", null);
      insertSession(db, "child-b", "first", null);
      expect(countSessions(db)).toBe(3);
    } finally {
      db.close();
    }
  });

  test("rejects a child whose parent does not exist", () => {
    const db = openInitialized();
    try {
      expect(() => insertSession(db, "orphan", "missing", null)).toThrow();
    } finally {
      db.close();
    }
  });

  test("cascades parent deletion to children through the composite foreign key", () => {
    const db = openInitialized();
    try {
      insertSession(db, "parent", null, 1);
      insertSession(db, "child", "parent", null);
      insertSession(db, "grandchild", "child", null);
      db.run("DELETE FROM active_sessions WHERE provider = 'claude' AND session_id = 'parent'");
      expect(countSessions(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("allows a bounded target only on a top-level Claude row", () => {
    const db = openInitialized();
    try {
      insertWithTarget(db, "claude", "parent", null, 1, "terminal-1");
      insertWithTarget(db, "claude", "null-target", null, 2, null);
      expect(() => insertWithTarget(db, "claude", "empty", null, 3, "")).toThrow();
      expect(() => insertWithTarget(db, "claude", "long", null, 3, "x".repeat(257))).toThrow();
      expect(() => insertWithTarget(db, "codex", "codex", null, 3, "terminal-3")).toThrow();
      expect(() => insertWithTarget(db, "kimi", "kimi", null, 3, "terminal-3")).toThrow();
      expect(() => insertWithTarget(db, "claude", "child", "parent", null, "terminal-child")).toThrow();
    } finally {
      db.close();
    }
  });

  test("defaults background_outstanding to zero and confines it to a boolean flag", () => {
    const db = openInitialized();
    try {
      insertSession(db, "s1", null, 1);
      expect(db.query("SELECT background_outstanding FROM active_sessions").get()).toEqual({
        background_outstanding: 0,
      });
      db.run("UPDATE active_sessions SET background_outstanding = 1");
      expect(db.query("SELECT background_outstanding FROM active_sessions").get()).toEqual({
        background_outstanding: 1,
      });
      expect(() => db.run("UPDATE active_sessions SET background_outstanding = 2")).toThrow();
      expect(() => db.run("UPDATE active_sessions SET background_outstanding = NULL")).toThrow();
    } finally {
      db.close();
    }
  });

  test("bounds transcript_path to 1-256 characters on any row", () => {
    const db = openInitialized();
    try {
      insertSession(db, "s1", null, 1);
      expect(db.query("SELECT transcript_path FROM active_sessions").get()).toEqual({ transcript_path: null });
      db.run("UPDATE active_sessions SET transcript_path = '/tmp/t.jsonl'");
      expect(db.query("SELECT transcript_path FROM active_sessions").get()).toEqual({
        transcript_path: "/tmp/t.jsonl",
      });
      expect(() => db.run("UPDATE active_sessions SET transcript_path = ''")).toThrow();
      expect(() => db.run(`UPDATE active_sessions SET transcript_path = '${"x".repeat(257)}'`)).toThrow();
    } finally {
      db.close();
    }
  });

  test("bounds model to 1-256 characters on any row", () => {
    const db = openInitialized();
    try {
      insertSession(db, "s1", null, 1);
      expect(db.query("SELECT model FROM active_sessions").get()).toEqual({ model: null });
      db.run("UPDATE active_sessions SET model = 'claude-fable-5'");
      expect(db.query("SELECT model FROM active_sessions").get()).toEqual({ model: "claude-fable-5" });
      expect(() => db.run("UPDATE active_sessions SET model = ''")).toThrow();
      expect(() => db.run(`UPDATE active_sessions SET model = '${"x".repeat(257)}'`)).toThrow();
    } finally {
      db.close();
    }
  });

  test("accepts every PROVIDER_KEYS provider and rejects any provider outside it", () => {
    // The v5 provider CHECK is a literal SQL list, so it can silently drift
    // from PROVIDER_KEYS when the next provider arrives. This test makes that
    // drift (a new key without a schema bump) a red suite instead.
    const db = openInitialized();
    try {
      let slot = 1;
      for (const provider of PROVIDER_KEYS) {
        db.run(INSERT_SESSION, [
          provider,
          `${provider}-session`,
          null,
          "idle",
          null,
          null,
          slot++,
          "opened",
          "updated",
        ]);
      }
      expect(countSessions(db)).toBe(PROVIDER_KEYS.length);
      expect(() =>
        db.run(INSERT_SESSION, ["vscode", "vscode-session", null, "idle", null, null, slot, "opened", "updated"]),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });
});

const createVersion4Database = (path: string): void => {
  const legacy = new Database(path, { create: true, readwrite: true });
  try {
    legacy.exec("PRAGMA foreign_keys = OFF");
    legacy.exec(`
      CREATE TABLE active_sessions (
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'kimi')),
        session_id TEXT NOT NULL,
        parent_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('idle', 'working', 'waiting', 'error')),
        title TEXT,
        project TEXT,
        logical_slot INTEGER,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, session_id),
        FOREIGN KEY (provider, parent_session_id)
          REFERENCES active_sessions(provider, session_id) ON DELETE CASCADE,
        CHECK (
          (parent_session_id IS NULL AND logical_slot IS NOT NULL AND logical_slot > 0)
          OR
          (parent_session_id IS NOT NULL AND logical_slot IS NULL)
        )
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX active_sessions_unique_slot
        ON active_sessions(logical_slot)
        WHERE logical_slot IS NOT NULL;
      ALTER TABLE active_sessions ADD COLUMN ghostty_terminal_id TEXT
        CHECK (
          ghostty_terminal_id IS NULL
          OR (provider = 'claude' AND parent_session_id IS NULL AND length(ghostty_terminal_id) BETWEEN 1 AND 256)
        );
      ALTER TABLE active_sessions ADD COLUMN background_outstanding INTEGER NOT NULL DEFAULT 0
        CHECK (background_outstanding IN (0, 1));
      ALTER TABLE active_sessions ADD COLUMN transcript_path TEXT
        CHECK (transcript_path IS NULL OR length(transcript_path) BETWEEN 1 AND 256);
      PRAGMA user_version = 4;
    `);
    // A parent/child/grandchild chain plus a second root with a slot gap.
    // Every nullable/defaultable column carries a representative NON-default
    // value somewhere (within the CHECKs: ghostty_terminal_id only on the
    // claude top-level root, background_outstanding = 1 on one row,
    // transcript_path on one row), so a wrong column mapping or a dropped
    // value in the v5 copy cannot pass the post-migration assertions as a
    // default. The rollback test below still seeds its orphan via this file's
    // `insertSession` helper.
    legacy.run(
      `INSERT INTO active_sessions
         (provider, session_id, parent_session_id, status, title, project, logical_slot,
          opened_at, updated_at, ghostty_terminal_id, background_outstanding, transcript_path)
       VALUES
         ('claude', 'root', NULL, 'working', 'Root session', 'proj-root', 1,
          '2026-08-06T01:00:00.000Z', '2026-08-06T02:00:00.000Z', 'ghostty-a1', 1, NULL),
         ('claude', 'child', 'root', 'waiting', 'Child session', 'proj-child', NULL,
          '2026-08-06T03:00:00.000Z', '2026-08-06T04:00:00.000Z', NULL, 0, NULL),
         ('claude', 'grandchild', 'child', 'idle', 'Grandchild session', 'proj-grand', NULL,
          '2026-08-06T05:00:00.000Z', '2026-08-06T06:00:00.000Z', NULL, 0, NULL),
         ('kimi', 'other-root', NULL, 'error', 'Other root session', 'proj-other', 3,
          '2026-08-06T07:00:00.000Z', '2026-08-06T08:00:00.000Z', NULL, 0, '/transcripts/other.jsonl')`,
    );
  } finally {
    legacy.close();
  }
};

const TS = "2026-08-06T00:00:00.000Z";
// Full 9-value insert matching INSERT_SESSION's placeholders.
const insertFull = (
  db: Database,
  provider: string,
  sessionId: string,
  parent: string | null,
  slot: number | null,
): void => {
  db.run(INSERT_SESSION, [provider, sessionId, parent, "idle", null, null, slot, TS, TS]);
};

describe("schema v5", () => {
  test("migrates a v4 database preserving rows, the index, and constraints", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion4Database(paths.database);

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      expect(countSessions(db)).toBe(4);
      // Every seeded NON-default value must survive the rebuild verbatim.
      expect(
        db
          .query(
            `SELECT provider, session_id, parent_session_id, status, title, project, logical_slot,
                    opened_at, updated_at, ghostty_terminal_id, background_outstanding, transcript_path
             FROM active_sessions ORDER BY session_id`,
          )
          .all(),
      ).toEqual([
        {
          provider: "claude",
          session_id: "child",
          parent_session_id: "root",
          status: "waiting",
          title: "Child session",
          project: "proj-child",
          logical_slot: null,
          opened_at: "2026-08-06T03:00:00.000Z",
          updated_at: "2026-08-06T04:00:00.000Z",
          ghostty_terminal_id: null,
          background_outstanding: 0,
          transcript_path: null,
        },
        {
          provider: "claude",
          session_id: "grandchild",
          parent_session_id: "child",
          status: "idle",
          title: "Grandchild session",
          project: "proj-grand",
          logical_slot: null,
          opened_at: "2026-08-06T05:00:00.000Z",
          updated_at: "2026-08-06T06:00:00.000Z",
          ghostty_terminal_id: null,
          background_outstanding: 0,
          transcript_path: null,
        },
        {
          provider: "kimi",
          session_id: "other-root",
          parent_session_id: null,
          status: "error",
          title: "Other root session",
          project: "proj-other",
          logical_slot: 3,
          opened_at: "2026-08-06T07:00:00.000Z",
          updated_at: "2026-08-06T08:00:00.000Z",
          ghostty_terminal_id: null,
          background_outstanding: 0,
          transcript_path: "/transcripts/other.jsonl",
        },
        {
          provider: "claude",
          session_id: "root",
          parent_session_id: null,
          status: "working",
          title: "Root session",
          project: "proj-root",
          logical_slot: 1,
          opened_at: "2026-08-06T01:00:00.000Z",
          updated_at: "2026-08-06T02:00:00.000Z",
          ghostty_terminal_id: "ghostty-a1",
          background_outstanding: 1,
          transcript_path: null,
        },
      ]);
      const index = db
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'active_sessions_unique_slot'")
        .all();
      expect(index).toHaveLength(1);
      // The widened CHECK accepts the new providers.
      insertFull(db, "zcode", "z1", null, 4);
      expect(countSessions(db)).toBe(5);
      // The FK is live again after the rebuild: an orphan child is rejected.
      expect(() => insertFull(db, "zcode", "orphan", "missing-parent", null)).toThrow();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const version = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(version.user_version).toBe(14);
    } finally {
      db.close();
    }
  });

  test("rolls back and leaves the v4 database intact when the FK check fails", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion4Database(paths.database);
    // Inject an orphan with FK enforcement off (impossible under normal operation).
    const legacy = new Database(paths.database, { readwrite: true });
    legacy.exec("PRAGMA foreign_keys = OFF");
    insertSession(legacy, "orphan", "missing-parent", null);
    legacy.close();

    expect(() => initializeDatabase(paths)).toThrow();

    const db = new Database(paths.database, { readonly: true, create: false });
    try {
      const version = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(version.user_version).toBe(4);
      expect(countSessions(db)).toBe(5); // old table, orphan included
    } finally {
      db.close();
    }
  });

  test("fails without mutating when another connection holds the write lock", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion4Database(paths.database);

    const blocker = new Database(paths.database, { readwrite: true });
    blocker.exec("BEGIN IMMEDIATE");
    try {
      // The 250ms busy timeout fires; nothing is mutated.
      expect(() => initializeDatabase(paths)).toThrow();
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }

    const db = new Database(paths.database, { readonly: true, create: false });
    try {
      const version = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(version.user_version).toBe(4);
    } finally {
      db.close();
    }
  });
});

const createVersion5Database = (path: string): void => {
  const legacy = new Database(path, { create: true, readwrite: true });
  try {
    legacy.exec(`
      CREATE TABLE active_sessions (
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'kimi', 'pi', 'omp', 'zcode', 'deepseek')),
        session_id TEXT NOT NULL,
        parent_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('idle', 'working', 'waiting', 'error')),
        title TEXT,
        project TEXT,
        logical_slot INTEGER,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ghostty_terminal_id TEXT
          CHECK (
            ghostty_terminal_id IS NULL
            OR (provider = 'claude' AND parent_session_id IS NULL AND length(ghostty_terminal_id) BETWEEN 1 AND 256)
          ),
        background_outstanding INTEGER NOT NULL DEFAULT 0
          CHECK (background_outstanding IN (0, 1)),
        transcript_path TEXT
          CHECK (transcript_path IS NULL OR length(transcript_path) BETWEEN 1 AND 256),
        PRIMARY KEY (provider, session_id),
        FOREIGN KEY (provider, parent_session_id)
          REFERENCES active_sessions(provider, session_id) ON DELETE CASCADE,
        CHECK (
          (parent_session_id IS NULL AND logical_slot IS NOT NULL AND logical_slot > 0)
          OR
          (parent_session_id IS NOT NULL AND logical_slot IS NULL)
        )
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX active_sessions_unique_slot
        ON active_sessions(logical_slot)
        WHERE logical_slot IS NOT NULL;
      PRAGMA user_version = 5;
    `);
    // Both rows carry a non-default value in every column their CHECKs allow,
    // so a value lost on the migration path could not pass the assertions as
    // a default.
    legacy.run(
      `INSERT INTO active_sessions
         (provider, session_id, parent_session_id, status, title, project, logical_slot,
          opened_at, updated_at, ghostty_terminal_id, background_outstanding, transcript_path)
       VALUES
         ('claude', 'root', NULL, 'working', 'Root session', 'proj-root', 1,
          '2026-08-06T01:00:00.000Z', '2026-08-06T02:00:00.000Z', 'ghostty-a1', 1, '/transcripts/root.jsonl'),
         ('claude', 'child', 'root', 'waiting', 'Child session', 'proj-child', NULL,
          '2026-08-06T03:00:00.000Z', '2026-08-06T04:00:00.000Z', NULL, 1, '/transcripts/child.jsonl')`,
    );
  } finally {
    legacy.close();
  }
};

describe("schema v7/v8", () => {
  test("migrates v5 through v7 to v9, adding origin and unread columns without touching rows", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion5Database(paths.database);

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      expect(countSessions(db)).toBe(2);
      expect(
        db
          .query(
            "SELECT origin_kind, origin_ref, origin_subagent, unread_since FROM active_sessions ORDER BY session_id",
          )
          .all(),
      ).toEqual([
        { origin_kind: null, origin_ref: null, origin_subagent: 0, unread_since: null },
        { origin_kind: null, origin_ref: null, origin_subagent: 0, unread_since: null },
      ]);
      // The pre-existing rows are untouched: non-default v5 values survive.
      expect(
        db
          .query(
            "SELECT session_id, status, title, background_outstanding, transcript_path FROM active_sessions WHERE session_id = 'root'",
          )
          .get(),
      ).toEqual({
        session_id: "root",
        status: "working",
        title: "Root session",
        background_outstanding: 1,
        transcript_path: "/transcripts/root.jsonl",
      });
    } finally {
      db.close();
    }
  });

  test("migrates a v6 model-label database to v9, adding columns beside the model column", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion5Database(paths.database);
    // Reproduce a v6 database the model-label build produced: a nullable
    // `model` column stamped as schema version 6. Init must apply only the
    // v7 migration, the v8 stamp, and the v9 acked_at column, leaving the
    // model column and its data alone.
    const modelBuild = new Database(paths.database);
    try {
      modelBuild.exec("ALTER TABLE active_sessions ADD COLUMN model TEXT");
      modelBuild.run("UPDATE active_sessions SET model = 'claude-sonnet-4-6' WHERE session_id = 'root'");
      modelBuild.exec("PRAGMA user_version = 6");
    } finally {
      modelBuild.close();
    }

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      expect(countSessions(db)).toBe(2);
      expect(
        db
          .query(
            "SELECT origin_kind, origin_subagent, unread_since, model FROM active_sessions WHERE session_id = 'root'",
          )
          .get(),
      ).toEqual({
        origin_kind: null,
        origin_subagent: 0,
        unread_since: null,
        model: "claude-sonnet-4-6",
      });
    } finally {
      db.close();
    }
  });

  test("repairs a v7 database missing the model column (pre-merge branch shape) on the way to v9", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion5Database(paths.database);
    // Reproduce the divergent shape pre-merge branch builds created: the v7
    // origin/unread ALTERs applied straight onto v5 — no model column —
    // stamped as schema version 7. Init must detect the missing column,
    // apply the v6 model ALTER, and stamp v8 without touching the rows.
    const branchBuild = new Database(paths.database);
    try {
      branchBuild.exec(`
        ALTER TABLE active_sessions
          ADD COLUMN origin_kind TEXT
          CHECK (origin_kind IS NULL OR origin_kind IN ('paseo', 'terminal'));
        ALTER TABLE active_sessions
          ADD COLUMN origin_ref TEXT
          CHECK (origin_ref IS NULL OR length(origin_ref) BETWEEN 1 AND 256);
        ALTER TABLE active_sessions
          ADD COLUMN origin_subagent INTEGER NOT NULL DEFAULT 0
          CHECK (origin_subagent IN (0, 1));
        ALTER TABLE active_sessions
          ADD COLUMN unread_since TEXT;
        PRAGMA user_version = 7;
      `);
      branchBuild.run("UPDATE active_sessions SET origin_kind = 'paseo', origin_ref = 'a1' WHERE session_id = 'root'");
    } finally {
      branchBuild.close();
    }

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      const columns = db.query("SELECT name FROM pragma_table_info('active_sessions')").all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toContain("model");
      // Existing rows are intact: seeded v5 values and the stamped origin
      // survive, and the repaired column reads back null.
      expect(countSessions(db)).toBe(2);
      expect(
        db
          .query(
            "SELECT status, title, transcript_path, origin_kind, origin_ref, model FROM active_sessions WHERE session_id = 'root'",
          )
          .get(),
      ).toEqual({
        status: "working",
        title: "Root session",
        transcript_path: "/transcripts/root.jsonl",
        origin_kind: "paseo",
        origin_ref: "a1",
        model: null,
      });
    } finally {
      db.close();
    }
  });

  test("stamps v8 without re-altering when the model column already exists at v7", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion5Database(paths.database);
    // A database main's v6 lineage brought to v7 (the deployed shape):
    // model already present, version 7. The repair must only stamp.
    const migrated = new Database(paths.database);
    try {
      migrated.exec("ALTER TABLE active_sessions ADD COLUMN model TEXT");
      migrated.exec("ALTER TABLE active_sessions ADD COLUMN origin_kind TEXT");
      migrated.exec("ALTER TABLE active_sessions ADD COLUMN origin_ref TEXT");
      migrated.exec("ALTER TABLE active_sessions ADD COLUMN origin_subagent INTEGER NOT NULL DEFAULT 0");
      migrated.exec("ALTER TABLE active_sessions ADD COLUMN unread_since TEXT");
      migrated.run("UPDATE active_sessions SET model = 'k3' WHERE session_id = 'root'");
      migrated.exec("PRAGMA user_version = 7");
    } finally {
      migrated.close();
    }

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      expect(db.query("SELECT model FROM active_sessions WHERE session_id = 'root'").get()).toEqual({ model: "k3" });
    } finally {
      db.close();
    }
  });

  test("fresh init runs the full chain to v9 with the model, origin/unread, and acked_at columns", () => {
    const paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      // A fresh database must not skip the v6 model migration on its way to
      // v9: every feature's columns exist on every migration path.
      const columns = db.query("SELECT name FROM pragma_table_info('active_sessions')").all() as Array<{
        name: string;
      }>;
      const names = columns.map((column) => column.name);
      expect(names).toContain("model");
      expect(names).toContain("origin_kind");
      expect(names).toContain("origin_ref");
      expect(names).toContain("origin_subagent");
      expect(names).toContain("unread_since");
      expect(names).toContain("acked_at");
      expect(names).toContain("status_since");
      expect(names).toContain("origin_parent_ref");
      expect(names).toContain("activity_line");
      insertSession(db, "s1", null, 1);
      expect(
        db.query("SELECT origin_kind, origin_ref, origin_subagent, unread_since, model FROM active_sessions").get(),
      ).toEqual({ origin_kind: null, origin_ref: null, origin_subagent: 0, unread_since: null, model: null });
    } finally {
      db.close();
    }
  });

  test("rejects CHECK violations on the new columns", () => {
    const paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      insertSession(db, "parent", null, 1);
      // A valid origin row passes first, so the rejections below are about
      // the CHECKs rather than a missing column.
      db.run(
        `INSERT INTO active_sessions
           (provider, session_id, parent_session_id, status, title, project, logical_slot,
            opened_at, updated_at, origin_kind, origin_ref, origin_subagent, unread_since)
         VALUES ('claude', 'origin-child', 'parent', 'idle', NULL, NULL, NULL,
                 'opened', 'updated', 'paseo', 'ws-1', 1, '2026-08-06T00:00:00.000Z')`,
      );
      expect(() =>
        db.run(
          `INSERT INTO active_sessions
             (provider, session_id, parent_session_id, status, title, project, logical_slot,
              opened_at, updated_at, origin_kind)
           VALUES ('claude', 'bad-kind', 'parent', 'idle', NULL, NULL, NULL, 'opened', 'updated', 'bogus')`,
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        db.run(
          `INSERT INTO active_sessions
             (provider, session_id, parent_session_id, status, title, project, logical_slot,
              opened_at, updated_at, origin_subagent)
           VALUES ('claude', 'bad-flag', 'parent', 'idle', NULL, NULL, NULL, 'opened', 'updated', 2)`,
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        db.run(
          `INSERT INTO active_sessions
             (provider, session_id, parent_session_id, status, title, project, logical_slot,
              opened_at, updated_at, origin_ref)
           VALUES ('claude', 'empty-ref', 'parent', 'idle', NULL, NULL, NULL, 'opened', 'updated', '')`,
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        db.run(
          `INSERT INTO active_sessions
             (provider, session_id, parent_session_id, status, title, project, logical_slot,
              opened_at, updated_at, origin_ref)
           VALUES ('claude', 'long-ref', 'parent', 'idle', NULL, NULL, NULL, 'opened', 'updated', '${"x".repeat(257)}')`,
        ),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });
});

describe("schema v6", () => {
  test("migrates v5 through v6, preserving rows and adding a nullable model column", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion5Database(paths.database);

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      // Every seeded pre-v6 value must survive verbatim; model is NULL on both.
      expect(
        db
          .query(
            `SELECT provider, session_id, parent_session_id, status, title, project, logical_slot,
                    opened_at, updated_at, ghostty_terminal_id, background_outstanding, transcript_path, model
             FROM active_sessions ORDER BY session_id`,
          )
          .all(),
      ).toEqual([
        {
          provider: "claude",
          session_id: "child",
          parent_session_id: "root",
          status: "waiting",
          title: "Child session",
          project: "proj-child",
          logical_slot: null,
          opened_at: "2026-08-06T03:00:00.000Z",
          updated_at: "2026-08-06T04:00:00.000Z",
          ghostty_terminal_id: null,
          background_outstanding: 1,
          transcript_path: "/transcripts/child.jsonl",
          model: null,
        },
        {
          provider: "claude",
          session_id: "root",
          parent_session_id: null,
          status: "working",
          title: "Root session",
          project: "proj-root",
          logical_slot: 1,
          opened_at: "2026-08-06T01:00:00.000Z",
          updated_at: "2026-08-06T02:00:00.000Z",
          ghostty_terminal_id: "ghostty-a1",
          background_outstanding: 1,
          transcript_path: "/transcripts/root.jsonl",
          model: null,
        },
      ]);
      const columns = db.query("PRAGMA table_info(active_sessions)").all() as Array<{ name: string; type: string }>;
      const modelColumn = columns.find((column) => column.name === "model");
      expect(modelColumn?.type).toBe("TEXT");
    } finally {
      db.close();
    }
  });

  test("re-running init on a migrated database is an idempotent no-op", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion5Database(paths.database);
    initializeDatabase(paths);

    // A retried init must never re-attempt the v6/v7 ALTERs (duplicate column).
    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      expect(countSessions(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  test("openRegistryDatabase accepts a fully migrated database and rejects v5", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion5Database(paths.database);
    initializeDatabase(paths);
    const db = openRegistryDatabase(paths.database, "readonly");
    db.close();

    const stale = join(tempHome, "stale-v5.sqlite3");
    createVersion5Database(stale);
    expect(() => openRegistryDatabase(stale, "readonly")).toThrow(UnsupportedSchemaVersion);
    expect(() => openRegistryDatabase(stale, "readwrite")).toThrow(UnsupportedSchemaVersion);
  });
});

describe("schema v9", () => {
  test("migrates a v8 database to v9, adding a nullable acked_at without touching rows", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion5Database(paths.database);
    // Reproduce a deployed v8 database: the v6 model and v7 origin/unread
    // columns present, stamped 8. Init must add only acked_at and stamp 9.
    const v8Build = new Database(paths.database);
    try {
      v8Build.exec("ALTER TABLE active_sessions ADD COLUMN model TEXT");
      v8Build.exec("ALTER TABLE active_sessions ADD COLUMN origin_kind TEXT");
      v8Build.exec("ALTER TABLE active_sessions ADD COLUMN origin_ref TEXT");
      v8Build.exec("ALTER TABLE active_sessions ADD COLUMN origin_subagent INTEGER NOT NULL DEFAULT 0");
      v8Build.exec("ALTER TABLE active_sessions ADD COLUMN unread_since TEXT");
      v8Build.run("UPDATE active_sessions SET unread_since = '2026-08-06T05:00:00.000Z' WHERE session_id = 'root'");
      v8Build.exec("PRAGMA user_version = 8");
    } finally {
      v8Build.close();
    }

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      expect(countSessions(db)).toBe(2);
      // acked_at lands null on existing rows; everything else is untouched.
      expect(db.query("SELECT acked_at FROM active_sessions ORDER BY session_id").all()).toEqual([
        { acked_at: null },
        { acked_at: null },
      ]);
      expect(db.query("SELECT unread_since FROM active_sessions WHERE session_id = 'root'").get()).toEqual({
        unread_since: "2026-08-06T05:00:00.000Z",
      });
    } finally {
      db.close();
    }
  });
});

describe("schema v11", () => {
  test("migrates a v10 database through the v11 backfill to v12", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion9Database(paths.database);
    initializeDatabase(paths); // v9 → v10 rebuild → v11 in one chain

    // Revert to a true v10 shape so the pure v10 → v11 step is exercised:
    // drop the three columns and re-stamp 10.
    const revert = new Database(paths.database, { readwrite: true });
    try {
      revert.exec(`
        ALTER TABLE active_sessions DROP COLUMN status_since;
        ALTER TABLE active_sessions DROP COLUMN origin_parent_ref;
        ALTER TABLE active_sessions DROP COLUMN activity_line;
        PRAGMA user_version = 10;
      `);
    } finally {
      revert.close();
    }

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      expect(
        db
          .query(
            `SELECT session_id, updated_at, status_since, origin_parent_ref, activity_line
             FROM active_sessions ORDER BY session_id`,
          )
          .all(),
      ).toEqual([
        {
          session_id: "child",
          updated_at: "2026-08-06T04:00:00.000Z",
          status_since: "2026-08-06T04:00:00.000Z",
          origin_parent_ref: null,
          activity_line: null,
        },
        {
          session_id: "root",
          updated_at: "2026-08-06T02:00:00.000Z",
          status_since: "2026-08-06T02:00:00.000Z",
          origin_parent_ref: null,
          activity_line: null,
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("enforces the new columns' CHECKs and accepts nulls", () => {
    const paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      insertSession(db, "s1", null, 1);
      // Rows inserted after the migration carry nulls (the backfill only
      // covers pre-existing rows; registry stamping lands in Task 2). The new
      // columns accept ordinary values:
      db.run(
        "UPDATE active_sessions SET origin_parent_ref = 'agent-0', activity_line = 'Bash git status', status_since = '2026-08-19T00:00:00.000Z'",
      );
      expect(db.query("SELECT origin_parent_ref, activity_line, status_since FROM active_sessions").get()).toEqual({
        origin_parent_ref: "agent-0",
        activity_line: "Bash git status",
        status_since: "2026-08-19T00:00:00.000Z",
      });
      expect(() => db.run("UPDATE active_sessions SET origin_parent_ref = ''")).toThrow(/CHECK constraint failed/);
      expect(() => db.run(`UPDATE active_sessions SET origin_parent_ref = '${"x".repeat(257)}'`)).toThrow(
        /CHECK constraint failed/,
      );
      expect(() => db.run("UPDATE active_sessions SET activity_line = ''")).toThrow(/CHECK constraint failed/);
      expect(() => db.run(`UPDATE active_sessions SET activity_line = '${"x".repeat(65)}'`)).toThrow(
        /CHECK constraint failed/,
      );
      // status_since is an unconstrained timestamp column like unread_since.
      db.run("UPDATE active_sessions SET status_since = NULL");
      expect(db.query("SELECT status_since FROM active_sessions").get()).toEqual({ status_since: null });
    } finally {
      db.close();
    }
  });

  test("fresh init lands at v11 with the three columns and repeated init is idempotent", () => {
    const paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);
    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      const names = (
        db.query("SELECT name FROM pragma_table_info('active_sessions')").all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(names).toContain("status_since");
      expect(names).toContain("origin_parent_ref");
      expect(names).toContain("activity_line");
    } finally {
      db.close();
    }
  });
});

const createVersion9Database = (path: string, options?: { orphan?: boolean }): void => {
  const legacy = new Database(path, { create: true, readwrite: true });
  try {
    legacy.exec("PRAGMA foreign_keys = OFF");
    legacy.exec(`
      CREATE TABLE active_sessions (
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'kimi', 'pi', 'omp', 'zcode', 'deepseek')),
        session_id TEXT NOT NULL,
        parent_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('idle', 'working', 'waiting', 'error')),
        title TEXT,
        project TEXT,
        logical_slot INTEGER,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ghostty_terminal_id TEXT
          CHECK (
            ghostty_terminal_id IS NULL
            OR (provider = 'claude' AND parent_session_id IS NULL AND length(ghostty_terminal_id) BETWEEN 1 AND 256)
          ),
        background_outstanding INTEGER NOT NULL DEFAULT 0
          CHECK (background_outstanding IN (0, 1)),
        transcript_path TEXT
          CHECK (transcript_path IS NULL OR length(transcript_path) BETWEEN 1 AND 256),
        model TEXT
          CHECK (model IS NULL OR length(model) BETWEEN 1 AND 256),
        origin_kind TEXT
          CHECK (origin_kind IS NULL OR origin_kind IN ('paseo', 'terminal')),
        origin_ref TEXT
          CHECK (origin_ref IS NULL OR length(origin_ref) BETWEEN 1 AND 256),
        origin_subagent INTEGER NOT NULL DEFAULT 0
          CHECK (origin_subagent IN (0, 1)),
        unread_since TEXT,
        acked_at TEXT,
        PRIMARY KEY (provider, session_id),
        FOREIGN KEY (provider, parent_session_id)
          REFERENCES active_sessions(provider, session_id) ON DELETE CASCADE,
        CHECK (
          (parent_session_id IS NULL AND logical_slot IS NOT NULL AND logical_slot > 0)
          OR
          (parent_session_id IS NOT NULL AND logical_slot IS NULL)
        )
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX active_sessions_unique_slot
        ON active_sessions(logical_slot)
        WHERE logical_slot IS NOT NULL;
      PRAGMA user_version = 9;
    `);
    // Every nullable/defaulted column carries a non-default value so a value
    // lost on the rebuild path cannot pass as a default.
    legacy.run(
      `INSERT INTO active_sessions
         (provider, session_id, parent_session_id, status, title, project, logical_slot,
          opened_at, updated_at, ghostty_terminal_id, background_outstanding, transcript_path,
          model, origin_kind, origin_ref, origin_subagent, unread_since, acked_at)
       VALUES
         ('claude', 'root', NULL, 'working', 'Root session', 'proj-root', 1,
          '2026-08-06T01:00:00.000Z', '2026-08-06T02:00:00.000Z', 'ghostty-a1', 1, '/transcripts/root.jsonl',
          'claude-fable-5', 'paseo', 'agent-1', 0,
          '2026-08-06T02:30:00.000Z', '2026-08-06T02:45:00.000Z'),
         ('claude', 'child', 'root', 'waiting', 'Child session', 'proj-child', NULL,
          '2026-08-06T03:00:00.000Z', '2026-08-06T04:00:00.000Z', NULL, 1, '/transcripts/child.jsonl',
          'claude-fable-5', 'terminal', 'ghostty', 1,
          '2026-08-06T04:30:00.000Z', '2026-08-06T04:45:00.000Z')`,
    );
    if (options?.orphan === true) {
      legacy.run(
        `INSERT INTO active_sessions
           (provider, session_id, parent_session_id, status, opened_at, updated_at)
         VALUES ('claude', 'orphan', 'gone', 'idle', '2026-08-06T05:00:00.000Z', '2026-08-06T05:00:00.000Z')`,
      );
    }
    legacy.exec("PRAGMA foreign_keys = ON");
  } finally {
    legacy.close();
  }
};

describe("schema v10 rebuild", () => {
  test("migrates a v9 database, preserving every row value", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion9Database(paths.database);

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      const version = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(version.user_version).toBe(14);
      const rows = db.query("SELECT * FROM active_sessions ORDER BY session_id ASC").all() as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(2);
      const child = rows[0];
      const root = rows[1];
      expect(root).toMatchObject({
        provider: "claude",
        session_id: "root",
        status: "working",
        title: "Root session",
        logical_slot: 1,
        ghostty_terminal_id: "ghostty-a1",
        background_outstanding: 1,
        transcript_path: "/transcripts/root.jsonl",
        model: "claude-fable-5",
        origin_kind: "paseo",
        origin_ref: "agent-1",
        origin_subagent: 0,
        unread_since: "2026-08-06T02:30:00.000Z",
        acked_at: "2026-08-06T02:45:00.000Z",
      });
      expect(child).toMatchObject({
        parent_session_id: "root",
        logical_slot: null,
        origin_subagent: 1,
        acked_at: "2026-08-06T04:45:00.000Z",
      });
      // The widened CHECK accepts grok, qwen, and evener and still rejects non-providers.
    } finally {
      db.close();
    }

    const writer = openRegistryDatabase(paths.database, "readwrite");
    try {
      writer.run(
        `INSERT INTO active_sessions (provider, session_id, status, logical_slot, opened_at, updated_at)
         VALUES ('grok', 'g1', 'idle', 2, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
      );
      writer.run(
        `INSERT INTO active_sessions (provider, session_id, status, logical_slot, opened_at, updated_at)
         VALUES ('qwen', 'q1', 'idle', 3, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')`,
      );
      writer.run(
        `INSERT INTO active_sessions (provider, session_id, status, logical_slot, opened_at, updated_at)
         VALUES ('evener', 'e1', 'idle', 4, '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
      );
      expect(() =>
        writer.run(
          `INSERT INTO active_sessions (provider, session_id, status, logical_slot, opened_at, updated_at)
           VALUES ('vscode', 'v1', 'idle', 5, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
        ),
      ).toThrow(/CHECK constraint failed/);
      // Partial unique index: duplicate live slot rejected, sibling slots for
      // children (NULL) unaffected.
      expect(() =>
        writer.run(
          `INSERT INTO active_sessions (provider, session_id, status, logical_slot, opened_at, updated_at)
           VALUES ('grok', 'g2', 'idle', 2, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
        ),
      ).toThrow();
      // Self-FK cascade survives the rebuild.
      writer.run(
        `INSERT INTO active_sessions (provider, session_id, parent_session_id, status, opened_at, updated_at)
         VALUES ('grok', 'g1-child', 'g1', 'idle', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
      );
      writer.run("DELETE FROM active_sessions WHERE provider = 'grok' AND session_id = 'g1'");
      expect(
        (writer.query("SELECT COUNT(*) AS n FROM active_sessions WHERE provider = 'grok'").get() as { n: number }).n,
      ).toBe(0);
      // Storage contract preserved, and the archive table is gone.
      const ddl = writer.query("SELECT sql FROM sqlite_master WHERE name = 'active_sessions'").get() as {
        sql: string;
      };
      expect(ddl.sql).toContain("WITHOUT ROWID");
      expect(ddl.sql).toContain("'grok'");
      expect(ddl.sql).toContain("'qwen'");
      expect(ddl.sql).toContain("'evener'");
      expect(
        writer.query("SELECT name FROM sqlite_master WHERE name = 'active_sessions_v9_archived'").all(),
      ).toHaveLength(0);
    } finally {
      writer.close();
    }
  });

  test("a failed v10 rebuild keeps user_version = 9 and the original table; a retry converges", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion9Database(paths.database, { orphan: true });

    // The orphan trips the rebuild's foreign_key_check; the attempt rolls back.
    expect(() => initializeDatabase(paths)).toThrow();
    const peek = new Database(paths.database, { readonly: true, create: false });
    try {
      expect((peek.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(9);
      // The original table is intact, orphan included.
      expect((peek.query("SELECT COUNT(*) AS n FROM active_sessions").get() as { n: number }).n).toBe(3);
    } finally {
      peek.close();
    }

    // Without the version < 8 gate, the failed attempt would have committed
    // user_version = 8 (migrateToV8) and this retry would die re-adding
    // acked_at. With the gate the retry from 9 runs the rebuild alone.
    const fix = new Database(paths.database, { readwrite: true });
    try {
      fix.run("DELETE FROM active_sessions WHERE session_id = 'orphan'");
    } finally {
      fix.close();
    }
    initializeDatabase(paths);
    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(14);
    } finally {
      db.close();
    }
  });

  test("fresh init lands at v14 and repeated init is idempotent", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    initializeDatabase(paths);
    initializeDatabase(paths);
    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(14);
      const ddl = db.query("SELECT sql FROM sqlite_master WHERE name = 'active_sessions'").get() as { sql: string };
      expect(ddl.sql).toContain("'grok'");
      expect(ddl.sql).toContain("'qwen'");
      expect(ddl.sql).toContain("'evener'");
    } finally {
      db.close();
    }
  });

  test("the v12 rebuild migrates a v11-stamped database, preserving rows", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion9Database(paths.database);
    initializeDatabase(paths);
    // The v12 table shape equals the v11 shape, so re-stamping 11 yields a
    // database the v12 rebuild must still converge.
    const stamp = new Database(paths.database, { readwrite: true });
    try {
      stamp.exec("PRAGMA user_version = 11");
    } finally {
      stamp.close();
    }

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(14);
      expect(countSessions(db)).toBe(2);
      const ddl = db.query("SELECT sql FROM sqlite_master WHERE name = 'active_sessions'").get() as { sql: string };
      expect(ddl.sql).toContain("'qwen'");
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'active_sessions_v11_archived'").all()).toHaveLength(
        0,
      );
    } finally {
      db.close();
    }
  });

  test("the v13 rebuild migrates a v12-stamped database without losing rows", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    initializeDatabase(paths);
    const stamp = new Database(paths.database, { readwrite: true });
    try {
      insertFull(stamp, "qwen", "kept-v12", null, 7);
      stamp.exec("PRAGMA user_version = 12");
    } finally {
      stamp.close();
    }

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(14);
      expect(
        db.query("SELECT provider, logical_slot FROM active_sessions WHERE session_id = 'kept-v12'").get(),
      ).toEqual({
        provider: "qwen",
        logical_slot: 7,
      });
      const ddl = db.query("SELECT sql FROM sqlite_master WHERE name = 'active_sessions'").get() as { sql: string };
      expect(ddl.sql).toContain("'evener'");
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'active_sessions_v12_archived'").all()).toHaveLength(
        0,
      );
    } finally {
      db.close();
    }
  });

  test("the v14 migration clears legacy raw activity without losing the session", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    initializeDatabase(paths);
    const stamp = new Database(paths.database, { readwrite: true });
    try {
      insertFull(stamp, "claude", "legacy-activity", null, 9);
      stamp.run("UPDATE active_sessions SET activity_line = ? WHERE session_id = ?", [
        "Bash API_TOKEN=top-secret",
        "legacy-activity",
      ]);
      stamp.exec("PRAGMA user_version = 13");
    } finally {
      stamp.close();
    }

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      expect(
        db.query("SELECT provider, activity_line FROM active_sessions WHERE session_id = ?").get("legacy-activity"),
      ).toEqual({ provider: "claude", activity_line: null });
    } finally {
      db.close();
    }
  });
});
