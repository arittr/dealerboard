/**
 * Sole owner of the registry SQLite schema and its connection policy.
 *
 * `initializeDatabase` (the `init` path) is the only code that creates or
 * migrates the schema. Every other connection goes through
 * `openRegistryDatabase`, which never creates a missing database, always
 * enforces foreign keys, and validates `PRAGMA user_version`. An unsupported
 * version is a hard error: the database is never mutated, migrated, or
 * recreated to accommodate it.
 */

import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { type AppPaths, ensureAppDirectories } from "./paths";

export const LATEST_SCHEMA_VERSION = 3;

export class UnsupportedSchemaVersion extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number = LATEST_SCHEMA_VERSION) {
    super(`unsupported registry schema version ${found}; this build supports ${supported}`);
    this.name = "UnsupportedSchemaVersion";
    this.found = found;
    this.supported = supported;
  }
}

export type RegistryOpenMode = "readonly" | "readwrite";

const DATABASE_FILE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 250;

const SCHEMA_VERSION_1 = `
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
`;

const SCHEMA_VERSION_2 = `
ALTER TABLE active_sessions
  ADD COLUMN ghostty_terminal_id TEXT
  CHECK (
    ghostty_terminal_id IS NULL
    OR (
      provider = 'claude'
      AND parent_session_id IS NULL
      AND length(ghostty_terminal_id) BETWEEN 1 AND 256
    )
  );
`;

const SCHEMA_VERSION_3 = `
ALTER TABLE active_sessions
  ADD COLUMN background_outstanding INTEGER NOT NULL DEFAULT 0
  CHECK (background_outstanding IN (0, 1));
`;

/**
 * Ordered migrations keyed by the schema version each one produces. All due
 * migrations run inside a single transaction in `initializeDatabase`.
 */
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_VERSION_1 },
  { version: 2, sql: SCHEMA_VERSION_2 },
  { version: 3, sql: SCHEMA_VERSION_3 },
];

const readUserVersion = (db: Database): number => {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
  if (row === null || typeof row.user_version !== "number") {
    throw new Error("failed to read PRAGMA user_version");
  }
  return row.user_version;
};

export const initializeDatabase = (paths: AppPaths): void => {
  ensureAppDirectories(paths);
  const db = new Database(paths.database, { create: true, readwrite: true });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const version = readUserVersion(db);
    if (version > LATEST_SCHEMA_VERSION) {
      // Unknown future schema: leave the database exactly as found.
      throw new UnsupportedSchemaVersion(version);
    }
    // journal_mode persists in the database header, so re-asserting WAL keeps
    // repeated init idempotent.
    db.exec("PRAGMA journal_mode = WAL");
    if (version < LATEST_SCHEMA_VERSION) {
      const migrate = db.transaction(() => {
        for (const migration of MIGRATIONS) {
          if (migration.version > version) {
            db.exec(migration.sql);
            db.exec(`PRAGMA user_version = ${migration.version}`);
          }
        }
      });
      migrate();
    }
    chmodSync(paths.database, DATABASE_FILE_MODE);
  } finally {
    db.close();
  }
};

export const openRegistryDatabase = (path: string, mode: RegistryOpenMode): Database => {
  // create: false — a missing registry is an error, never an implicit empty
  // database.
  const db = new Database(path, {
    create: false,
    readonly: mode === "readonly",
    readwrite: mode === "readwrite",
  });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    if (mode === "readwrite") {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
    const version = readUserVersion(db);
    if (version !== LATEST_SCHEMA_VERSION) {
      throw new UnsupportedSchemaVersion(version);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};
