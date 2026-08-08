import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths } from "../src/core/paths";
import { initializeDatabase, openRegistryDatabase, UnsupportedSchemaVersion } from "../src/core/schema";

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "stream-deck-agents-schema-"));
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
    const root = join(tempHome, "Library/Application Support/com.drewritter.stream-deck-agents");
    const paths = resolveAppPaths(tempHome);
    expect(paths.root).toBe(root);
    expect(paths.binDirectory).toBe(join(root, "bin"));
    expect(paths.executable).toBe(join(root, "bin/stream-deck-agents"));
    expect(paths.database).toBe(join(root, "registry.sqlite3"));
    expect(paths.snapshot).toBe(join(root, "snapshot-v2.json"));
    expect(paths.logsDirectory).toBe(join(root, "logs"));
    expect(paths.launchAgent).toBe(join(tempHome, "Library/LaunchAgents/com.drewritter.stream-deck-agents.plist"));
  });

  test("defaults to the current user's home directory", () => {
    expect(resolveAppPaths().database).toBe(
      join(homedir(), "Library/Application Support/com.drewritter.stream-deck-agents/registry.sqlite3"),
    );
  });
});

describe("initializeDatabase", () => {
  test("initializes a WAL database at user_version 3 with foreign keys on every connection", () => {
    const paths = resolveAppPaths(tempHome);
    expect(paths.database).toBe(
      join(tempHome, "Library/Application Support/com.drewritter.stream-deck-agents/registry.sqlite3"),
    );

    initializeDatabase(paths);
    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
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
      expect(verify.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      expect(verify.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    } finally {
      verify.close();
    }
  });

  test("migrates v1 rows additively to v3 with null bindings and no outstanding background work", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion1Database(paths.database);

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      expect(
        db
          .query(
            "SELECT session_id, status, logical_slot, ghostty_terminal_id, background_outstanding FROM active_sessions",
          )
          .get(),
      ).toEqual({
        session_id: "legacy",
        status: "waiting",
        logical_slot: 4,
        ghostty_terminal_id: null,
        background_outstanding: 0,
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
});
