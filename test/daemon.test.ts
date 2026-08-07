import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_POLL_INTERVAL_MS,
  ProjectionDaemon,
  type DaemonDependencies,
} from "../src/core/daemon";
import type { DiagnosticRecord } from "../src/core/diagnostics";
import { resolveAppPaths, type AppPaths } from "../src/core/paths";
import { ProjectionError, readProjection } from "../src/core/projection";
import { applyRegistryEvents } from "../src/core/registry";
import { initializeDatabase, openRegistryDatabase } from "../src/core/schema";
import { writeSnapshotAtomically } from "../src/core/snapshot";
import {
  parseSessionSnapshot,
  type RegistryEvent,
  type SessionSnapshotV2,
} from "../src/protocol";

const NOW = "2026-08-06T00:00:00.000Z";
const LATER = "2026-08-06T00:00:01.000Z";

let tempHome: string;
let paths: AppPaths;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "stream-deck-agents-daemon-"));
  paths = resolveAppPaths(tempHome);
  initializeDatabase(paths);
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

/** Writer-side mutation through the real registry path on its own connection. */
const apply = (events: RegistryEvent[]): void => {
  const db = openRegistryDatabase(paths.database, "readwrite");
  try {
    applyRegistryEvents(db, events);
  } finally {
    db.close();
  }
};

const startSession = (sessionId: string, observedAt: string = NOW): void => {
  apply([
    {
      kind: "SessionStart",
      provider: "claude",
      sessionId,
      title: `Title for ${sessionId}`,
      project: null,
      ghosttyTerminalId: null,
      observedAt,
    },
  ]);
};

const setUserVersion = (version: number): void => {
  const raw = new Database(paths.database);
  try {
    raw.exec(`PRAGMA user_version = ${version}`);
  } finally {
    raw.close();
  }
};

const readSnapshotFile = (): SessionSnapshotV2 =>
  parseSessionSnapshot(JSON.parse(readFileSync(paths.snapshot, "utf8")));

type Harness = {
  daemon: ProjectionDaemon;
  tick: () => void;
  intervalMs: () => number | null;
  writeCountAtSchedule: () => number | null;
  isCancelled: () => boolean;
  writes: SessionSnapshotV2[];
  readCount: () => number;
  diagnostics: DiagnosticRecord[];
};

/**
 * The daemon with a fake scheduler (no real sleeping) and counting wrappers
 * around the real projection read and the real atomic snapshot write.
 */
const makeHarness = (overrides: Partial<DaemonDependencies> = {}): Harness => {
  const writes: SessionSnapshotV2[] = [];
  const diagnostics: DiagnosticRecord[] = [];
  let reads = 0;
  let poll: (() => void) | null = null;
  let intervalMs: number | null = null;
  let writeCountAtSchedule: number | null = null;
  let cancelled = false;
  const deps: DaemonDependencies = {
    readProjection: (db) => {
      reads += 1;
      return readProjection(db);
    },
    writeSnapshot: (path, snapshot) => {
      writes.push(snapshot);
      writeSnapshotAtomically(path, snapshot);
    },
    schedule: (pollFn, ms) => {
      poll = pollFn;
      intervalMs = ms;
      writeCountAtSchedule = writes.length;
      return () => {
        cancelled = true;
        poll = null;
      };
    },
    now: () => NOW,
    diagnostics: (record) => {
      diagnostics.push(record);
    },
    ...overrides,
  };
  return {
    daemon: new ProjectionDaemon(paths, deps),
    tick: () => poll?.(),
    intervalMs: () => intervalMs,
    writeCountAtSchedule: () => writeCountAtSchedule,
    isCancelled: () => cancelled,
    writes,
    readCount: () => reads,
    diagnostics,
  };
};

const HEALTHY_S1: SessionSnapshotV2 = {
  schemaVersion: 2,
  health: { status: "ok" },
  sessions: [
    {
      provider: "claude",
      sessionId: "s1",
      status: "idle",
      title: "Title for s1",
      project: null,
      descendantCount: 0,
      logicalSlot: 1,
      ghosttyTerminalId: null,
    },
  ],
};

describe("ProjectionDaemon", () => {
  test("publishes a healthy snapshot immediately at startup before scheduling 250 ms polls", () => {
    startSession("s1");
    const harness = makeHarness();

    harness.daemon.start();
    try {
      expect(harness.intervalMs()).toBe(DAEMON_POLL_INTERVAL_MS);
      expect(DAEMON_POLL_INTERVAL_MS).toBe(250);
      // The single startup publication happened before the timer was armed.
      expect(harness.writeCountAtSchedule()).toBe(1);
      expect(harness.writes).toHaveLength(1);
      expect(harness.readCount()).toBe(1);
      expect(readSnapshotFile()).toEqual(HEALTHY_S1);
    } finally {
      harness.daemon.stop();
    }
    expect(harness.isCancelled()).toBe(true);
  });

  test("an unchanged data_version neither reselects nor rewrites", () => {
    startSession("s1");
    const harness = makeHarness();
    harness.daemon.start();
    try {
      const before = statSync(paths.snapshot).ino;
      harness.tick();
      harness.tick();
      expect(harness.readCount()).toBe(1);
      expect(harness.writes).toHaveLength(1);
      expect(statSync(paths.snapshot).ino).toBe(before);
    } finally {
      harness.daemon.stop();
    }
  });

  test("a commit from a separate connection changes data_version and publishes exactly once", () => {
    const harness = makeHarness();
    harness.daemon.start();
    try {
      expect(harness.writes).toHaveLength(1);
      startSession("s2");
      harness.tick();
      expect(harness.readCount()).toBe(2);
      expect(harness.writes).toHaveLength(2);
      expect(readSnapshotFile().sessions.map((session) => session.sessionId)).toEqual(["s2"]);
      // The next poll sees the same data_version and stays idle.
      harness.tick();
      expect(harness.readCount()).toBe(2);
      expect(harness.writes).toHaveLength(2);
    } finally {
      harness.daemon.stop();
    }
  });

  test("a commit whose projection is unchanged does not replace the snapshot file", () => {
    startSession("s1");
    const harness = makeHarness();
    harness.daemon.start();
    try {
      const before = statSync(paths.snapshot).ino;
      // Only updated_at changes: the commit bumps data_version without
      // changing any projected column.
      startSession("s1", LATER);
      harness.tick();
      expect(harness.readCount()).toBe(2);
      expect(harness.writes).toHaveLength(1);
      expect(statSync(paths.snapshot).ino).toBe(before);
    } finally {
      harness.daemon.stop();
    }
  });

  test("unsupported schema or projection errors publish only the bounded unhealthy shape", () => {
    // Unsupported schema: the read-only open is rejected before any poll.
    setUserVersion(99);
    const unsupported = makeHarness();
    unsupported.daemon.start();
    try {
      expect(unsupported.writes).toEqual([
        {
          schemaVersion: 2,
          health: { status: "error", message: "unsupported_schema" },
          sessions: [],
        },
      ]);
      expect(readSnapshotFile()).toEqual(unsupported.writes[0]!);
      expect(unsupported.diagnostics).toEqual([
        { timestamp: NOW, component: "daemon", code: "unsupported_schema" },
      ]);
    } finally {
      unsupported.daemon.stop();
    }

    // Projection error: a child row with a missing parent (inserted with
    // foreign-key enforcement off) fails the defensive topology checks.
    setUserVersion(2);
    startSession("parent");
    const raw = new Database(paths.database);
    try {
      raw.run(
        `INSERT INTO active_sessions
           (provider, session_id, parent_session_id, status, title, project, logical_slot, opened_at, updated_at)
         VALUES ('claude', 'orphan', 'missing-parent', 'idle', NULL, NULL, NULL, ?, ?)`,
        [NOW, NOW],
      );
    } finally {
      raw.close();
    }
    const corrupt = makeHarness();
    corrupt.daemon.start();
    try {
      expect(corrupt.writes).toEqual([
        { schemaVersion: 2, health: { status: "error", message: "internal_error" }, sessions: [] },
      ]);
      expect(readSnapshotFile()).toEqual(corrupt.writes[0]!);
      expect(corrupt.diagnostics).toEqual([
        { timestamp: NOW, component: "daemon", code: "internal_error" },
      ]);
    } finally {
      corrupt.daemon.stop();
    }
  });

  test("polls retry after errors even with no prior healthy version and recover", () => {
    startSession("s1");
    let failProjection = true;
    const harness = makeHarness({
      readProjection: (db) => {
        if (failProjection) {
          throw new ProjectionError("cycle");
        }
        return readProjection(db);
      },
    });
    harness.daemon.start();
    try {
      expect(harness.writes).toEqual([
        { schemaVersion: 2, health: { status: "error", message: "internal_error" }, sessions: [] },
      ]);
      // No commit happens between these polls: the retry is driven purely by
      // the previous poll having been unhealthy, and the identical unhealthy
      // snapshot is not rewritten.
      harness.tick();
      expect(harness.writes).toHaveLength(1);
      // Recovery publishes the healthy snapshot.
      failProjection = false;
      harness.tick();
      expect(harness.writes).toHaveLength(2);
      expect(harness.writes[1]).toEqual(HEALTHY_S1);
      expect(readSnapshotFile()).toEqual(HEALTHY_S1);
    } finally {
      harness.daemon.stop();
    }
  });

  test("holds one long-lived read-only connection and never issues writes or DDL", () => {
    const statements: string[] = [];
    const openModes: string[] = [];
    const connections: Database[] = [];
    const harness = makeHarness({
      openDatabase: (path, mode) => {
        openModes.push(mode);
        const db = openRegistryDatabase(path, mode);
        connections.push(db);
        return {
          query: (sql: string) => {
            statements.push(sql);
            return db.query(sql);
          },
          exec: (sql: string) => {
            statements.push(sql);
            db.exec(sql);
          },
          close: () => db.close(),
        } as unknown as Database;
      },
    });
    harness.daemon.start();
    try {
      startSession("k1");
      harness.tick();
      harness.tick();

      // One connection, opened read-only, reused across every poll.
      expect(openModes).toEqual(["readonly"]);
      expect(connections).toHaveLength(1);

      // The schema policy's connection-local pragma is in effect, and the
      // connection genuinely rejects writes.
      const connection = connections[0]!;
      expect(connection.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(() => connection.run("DELETE FROM active_sessions")).toThrow(/readonly/i);

      // Nothing issued through the daemon's handle is a write or DDL, and the
      // only pragma it ever runs is data_version. The allowed
      // `PRAGMA foreign_keys = ON` happens inside openRegistryDatabase on the
      // raw handle, before this recording wrapper sees the connection.
      const forbidden =
        /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX|ATTACH|DETACH)\b/i;
      for (const sql of statements) {
        expect(forbidden.test(sql)).toBe(false);
      }
      const pragmas = statements.filter((sql) => /^\s*PRAGMA/i.test(sql));
      expect(pragmas.length).toBeGreaterThan(0);
      for (const sql of pragmas) {
        expect(sql).toMatch(/^PRAGMA data_version$/i);
      }
    } finally {
      harness.daemon.stop();
    }
  });
});
