import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_HEARTBEAT_MS,
  DAEMON_PASEO_INTERVAL_MS,
  DAEMON_POLL_INTERVAL_MS,
  type DaemonDependencies,
  ProjectionDaemon,
  TICK_STALL_MS,
  VIEWED_EXPIRY_TTL_MS,
} from "../src/core/daemon";
import type { DiagnosticRecord } from "../src/core/diagnostics";
import { type AppPaths, resolveAppPaths } from "../src/core/paths";
import { ProjectionError, readProjection } from "../src/core/projection";
import { applyRegistryEvents, syncPaseoStates, viewSession } from "../src/core/registry";
import { initializeDatabase, openRegistryDatabase } from "../src/core/schema";
import { writeSnapshotAtomically } from "../src/core/snapshot";
import type { SessionFacts } from "../src/core/titles";
import { parseSessionSnapshot, type RegistryEvent, type SessionSnapshotV2 } from "../src/protocol";

const NOW = "2026-08-06T00:00:00.000Z";

let tempHome: string;
let paths: AppPaths;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "dealerboard-daemon-"));
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
      transcriptPath: null,
      model: null,
      observedAt,
    },
    // The projection hides read-and-idle sessions, so the fixture session
    // ends its turn with an unread result to stay visible.
    { kind: "Stop", provider: "claude", sessionId, observedAt },
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
    // The fixture clock matches the fixture timestamps (2026-08-06), so the
    // real wall clock can never make seeded rows look stale.
    nowMs: () => Date.parse(NOW),
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
      model: null,
      originKind: null,
      originRef: null,
      originSubagent: false,
      unreadSince: NOW,
      doneSince: NOW,
      pendingResults: 0,
      endedAt: null,
      statusSince: NOW,
      activityLine: null,
      transcriptPath: null,
      originParentRef: null,
      lastEventAt: NOW,
    },
  ],
  agents: [
    {
      provider: "claude",
      sessionId: "s1",
      role: "primary",
      lineage: null,
      parent: null,
      status: "idle",
      title: "Title for s1",
      project: null,
      model: null,
      openedAt: NOW,
      statusSince: NOW,
      activityLine: null,
      unreadSince: NOW,
      doneSince: NOW,
      pendingResults: 0,
      endedAt: null,
      logicalSlot: 1,
      ghosttyTerminalId: null,
      transcriptPath: null,
      originKind: null,
      originRef: null,
      originSubagent: false,
      originParentRef: null,
      lastEventAt: NOW,
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
      // Every hook event restamps updated_at, which the projection now
      // publishes as lastEventAt — so the unchanged-projection probe writes
      // the (unprojected) background flag directly: the separate-connection
      // commit bumps data_version without changing any projected column.
      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        writer.run(
          "UPDATE active_sessions SET background_outstanding = 1 WHERE provider = 'claude' AND session_id = 's1'",
        );
      } finally {
        writer.close();
      }
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
          agents: [],
        },
      ]);
      expect(readSnapshotFile()).toEqual(unsupported.writes[0]!);
      expect(unsupported.diagnostics).toEqual([{ timestamp: NOW, component: "daemon", code: "unsupported_schema" }]);
    } finally {
      unsupported.daemon.stop();
    }

    // Projection error: a child row with a missing parent (inserted with
    // foreign-key enforcement off) fails the defensive topology checks.
    setUserVersion(17);
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
        { schemaVersion: 2, health: { status: "error", message: "internal_error" }, sessions: [], agents: [] },
      ]);
      expect(readSnapshotFile()).toEqual(corrupt.writes[0]!);
      expect(corrupt.diagnostics).toEqual([{ timestamp: NOW, component: "daemon", code: "internal_error" }]);
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
        { schemaVersion: 2, health: { status: "error", message: "internal_error" }, sessions: [], agents: [] },
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

  test("holds one long-lived read-write connection and never issues DDL", () => {
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

      // One connection, opened read-write for maintenance, reused across
      // every poll.
      expect(openModes).toEqual(["readwrite"]);
      expect(connections).toHaveLength(1);

      // The schema policy's connection-local pragma is in effect.
      const connection = connections[0]!;
      expect(connection.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

      // Nothing issued through the daemon's handle is DDL, and the only
      // pragma it ever runs is data_version. Writes stay inside the registry
      // maintenance statements (title UPDATE, prune DELETE, transaction
      // control); projection reads are plain SELECTs.
      const forbidden = /\b(CREATE|DROP|ALTER|VACUUM|REINDEX|ATTACH|DETACH)\b/i;
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

describe("ProjectionDaemon maintenance", () => {
  /** A controllable wall clock for heartbeat, cadence, and clock-jump tests. */
  const fakeClock = (startMs: number): { nowMs: () => number; advance: (ms: number) => void } => {
    let current = startMs;
    return {
      nowMs: () => current,
      advance: (ms) => {
        current += ms;
      },
    };
  };

  /** Drain settled async maintenance passes so their results reach the next poll. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  test("heartbeat rewrites an unchanged snapshot once the file went quiet", () => {
    startSession("s1");
    const clock = fakeClock(Date.parse(NOW));
    const harness = makeHarness({ nowMs: clock.nowMs });
    harness.daemon.start();
    try {
      expect(harness.writes).toHaveLength(1);
      const before = statSync(paths.snapshot).ino;

      // Ticks inside the heartbeat window change nothing.
      clock.advance(1_000);
      harness.tick();
      expect(harness.writes).toHaveLength(1);
      expect(statSync(paths.snapshot).ino).toBe(before);

      // Past the heartbeat interval the identical snapshot is rewritten under
      // a new file identity, refreshing the mtime the plugin watches.
      clock.advance(5_000);
      harness.tick();
      expect(harness.writes).toHaveLength(2);
      expect(harness.writes[1]).toEqual(harness.writes[0]);
      expect(statSync(paths.snapshot).ino).not.toBe(before);
      expect(harness.readCount()).toBe(1);
    } finally {
      harness.daemon.stop();
    }
  });

  test("prunes sessions whose last hook is older than the TTL and republishes", () => {
    // Active rows carry no ledgers, so only the TTL decides.
    const activeSession = (sessionId: string, observedAt: string): void => {
      apply([
        {
          kind: "SessionStart",
          provider: "claude",
          sessionId,
          title: `Title for ${sessionId}`,
          project: null,
          ghosttyTerminalId: null,
          transcriptPath: null,
          model: null,
          observedAt,
        },
        { kind: "Activity", provider: "claude", sessionId, observedAt },
      ]);
    };
    activeSession("stale", "2026-08-01T00:00:00.000Z");
    activeSession("fresh", NOW);
    const harness = makeHarness();
    harness.daemon.start();
    try {
      expect(readSnapshotFile().sessions.map((session) => session.sessionId)).toEqual(["fresh"]);
      const rows = (() => {
        const db = openRegistryDatabase(paths.database, "readonly");
        try {
          return db.query("SELECT session_id FROM active_sessions").all() as { session_id: string }[];
        } finally {
          db.close();
        }
      })();
      expect(rows).toEqual([{ session_id: "fresh" }]);
    } finally {
      harness.daemon.stop();
    }
  });

  test("sweeps a done card 24h after its view — across a daemon restart, wall-clock — and republishes", () => {
    startSession("viewed");
    const viewedAt = "2026-08-06T01:00:00.000Z";
    const view = openRegistryDatabase(paths.database, "readwrite");
    try {
      viewSession(view, "claude", "viewed", viewedAt);
    } finally {
      view.close();
    }
    startSession("unviewed", "2026-08-01T00:00:00.000Z"); // five days old, never viewed

    // The first daemon runs at view time: inside the window, both cards.
    const clock = fakeClock(Date.parse(viewedAt));
    const first = makeHarness({ nowMs: clock.nowMs });
    first.daemon.start();
    expect(
      readSnapshotFile()
        .sessions.map((session) => session.sessionId)
        .sort(),
    ).toEqual(["unviewed", "viewed"]);
    first.daemon.stop();

    // The machine sleeps / the daemon is down past the 24h mark. A FRESH
    // daemon instance reopens the database; its first maintenance pass
    // sweeps the viewed card (wall-clock expiry needs no running daemon)
    // while the unviewed one survives at any age.
    const laterMs = Date.parse(viewedAt) + VIEWED_EXPIRY_TTL_MS + 60_000;
    const laterIso = new Date(laterMs).toISOString();
    const second = makeHarness({ nowMs: () => laterMs, now: () => laterIso });
    second.daemon.start();
    try {
      expect(readSnapshotFile().sessions.map((session) => session.sessionId)).toEqual(["unviewed"]);
    } finally {
      second.daemon.stop();
    }
  });

  test("prune spares a stale result whose view clock is live, and removes it once the sweep has dismissed it", () => {
    // The result is five days old (lease long expired) and viewed recently.
    startSession("viewed", "2026-08-01T00:00:00.000Z");
    const viewedAt = "2026-08-06T01:00:00.000Z";
    const view = openRegistryDatabase(paths.database, "readwrite");
    try {
      viewSession(view, "claude", "viewed", viewedAt);
    } finally {
      view.close();
    }
    const rowCount = (): number => {
      const db = openRegistryDatabase(paths.database, "readonly");
      try {
        return (db.query("SELECT COUNT(*) AS n FROM active_sessions").get() as { n: number }).n;
      } finally {
        db.close();
      }
    };

    // 23:59 after the view: inside the window, the card is published and its row kept.
    const nearlyExpiredMs = Date.parse(viewedAt) + VIEWED_EXPIRY_TTL_MS - 60_000;
    const first = makeHarness({ nowMs: () => nearlyExpiredMs, now: () => new Date(nearlyExpiredMs).toISOString() });
    first.daemon.start();
    try {
      expect(readSnapshotFile().sessions.map((session) => session.sessionId)).toEqual(["viewed"]);
      expect(rowCount()).toBe(1);
    } finally {
      first.daemon.stop();
    }

    // Past the window: the same tick sweeps (dismisses) and then prunes the stale row.
    const expiredMs = Date.parse(viewedAt) + VIEWED_EXPIRY_TTL_MS + 60_000;
    const second = makeHarness({ nowMs: () => expiredMs, now: () => new Date(expiredMs).toISOString() });
    second.daemon.start();
    try {
      expect(readSnapshotFile().sessions).toEqual([]);
      expect(rowCount()).toBe(0);
    } finally {
      second.daemon.stop();
    }
  });

  test("the zcode 1h lease does not prune a viewed zcode result before view + 24h", () => {
    const resultAt = "2026-08-06T00:00:00.000Z";
    apply([
      {
        kind: "SessionStart",
        provider: "zcode",
        sessionId: "z1",
        title: "Title for z1",
        project: null,
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        observedAt: resultAt,
      },
      { kind: "Stop", provider: "zcode", sessionId: "z1", observedAt: resultAt },
    ]);
    const view = openRegistryDatabase(paths.database, "readwrite");
    try {
      viewSession(view, "zcode", "z1", "2026-08-06T00:30:00.000Z");
    } finally {
      view.close();
    }
    // Two hours after the result: past the zcode lease, inside the view window.
    const laterMs = Date.parse(resultAt) + 2 * 60 * 60 * 1000;
    const harness = makeHarness({ nowMs: () => laterMs, now: () => new Date(laterMs).toISOString() });
    harness.daemon.start();
    try {
      expect(readSnapshotFile().sessions.map((session) => session.sessionId)).toEqual(["z1"]);
    } finally {
      harness.daemon.stop();
    }
  });

  test("daemon restart with unviewed results: everything is still present", () => {
    startSession("kept", "2026-08-01T00:00:00.000Z"); // old AND unviewed
    const first = makeHarness();
    first.daemon.start();
    first.daemon.stop();

    // A fresh daemon instance reopens the database from disk.
    const second = makeHarness();
    second.daemon.start();
    try {
      expect(readSnapshotFile().sessions.map((session) => session.sessionId)).toEqual(["kept"]);
      const db = openRegistryDatabase(paths.database, "readonly");
      try {
        expect(db.query("SELECT COUNT(*) AS n FROM active_sessions").get()).toEqual({ n: 1 });
      } finally {
        db.close();
      }
    } finally {
      second.daemon.stop();
    }
  });

  test("resolves titles through the injected resolver and republishes with them", async () => {
    startSession("s1");
    const targets: unknown[] = [];
    const harness = makeHarness({
      resolveFacts: async (seen) => {
        targets.push(...seen);
        return {
          titles: [{ provider: "claude" as const, sessionId: "s1", title: "Resolved from disk" }],
          models: [],
          activities: [],
        };
      },
    });
    harness.daemon.start();
    try {
      expect(targets).toEqual([
        {
          provider: "claude",
          sessionId: "s1",
          title: "Title for s1",
          transcriptPath: null,
          model: null,
          activityLine: null,
        },
      ]);
      // The async pass settles off the loop; its facts apply on the next poll.
      await settle();
      harness.tick();
      expect(readSnapshotFile().sessions[0]?.title).toBe("Resolved from disk");
      const row = (() => {
        const db = openRegistryDatabase(paths.database, "readonly");
        try {
          return db.query("SELECT title, updated_at FROM active_sessions").get() as {
            title: string;
            updated_at: string;
          } | null;
        } finally {
          db.close();
        }
      })();
      // The title write leaves updated_at — the prune's aging signal — alone.
      expect(row).toEqual({ title: "Resolved from disk", updated_at: NOW });
    } finally {
      harness.daemon.stop();
    }
  });

  test("applies resolved models through updateSessionModels and republishes with them", async () => {
    startSession("s1");
    const harness = makeHarness({
      resolveFacts: async () => ({
        titles: [],
        models: [{ provider: "claude" as const, sessionId: "s1", model: "claude-fable-5" }],
        activities: [],
      }),
    });
    harness.daemon.start();
    try {
      await settle();
      harness.tick();
      expect(readSnapshotFile().sessions[0]?.model).toBe("claude-fable-5");
      const row = (() => {
        const db = openRegistryDatabase(paths.database, "readonly");
        try {
          return db.query("SELECT model, updated_at FROM active_sessions").get() as {
            model: string;
            updated_at: string;
          } | null;
        } finally {
          db.close();
        }
      })();
      // The model write leaves updated_at — the prune's aging signal — alone.
      expect(row).toEqual({ model: "claude-fable-5", updated_at: NOW });
    } finally {
      harness.daemon.stop();
    }
  });

  test("applies resolved activity lines through updateSessionActivityLines and republishes with them", async () => {
    startSession("s1");
    const harness = makeHarness({
      resolveFacts: async () => ({
        titles: [],
        models: [],
        activities: [{ provider: "claude" as const, sessionId: "s1", activityLine: "Bash git status" }],
      }),
    });
    harness.daemon.start();
    try {
      await settle();
      harness.tick();
      expect(readSnapshotFile().sessions[0]?.activityLine).toBe("Bash git status");
      const row = (() => {
        const db = openRegistryDatabase(paths.database, "readonly");
        try {
          return db.query("SELECT activity_line, updated_at FROM active_sessions").get() as {
            activity_line: string;
            updated_at: string;
          } | null;
        } finally {
          db.close();
        }
      })();
      // The activity write leaves updated_at — the prune's aging signal — alone.
      expect(row).toEqual({ activity_line: "Bash git status", updated_at: NOW });
    } finally {
      harness.daemon.stop();
    }
  });

  test("runs the titles pass on its cadence, not on every poll", async () => {
    startSession("s1");
    const clock = fakeClock(Date.parse(NOW));
    let resolveCalls = 0;
    const harness = makeHarness({
      nowMs: clock.nowMs,
      resolveFacts: async () => {
        resolveCalls += 1;
        return { titles: [], models: [], activities: [] };
      },
    });
    harness.daemon.start();
    try {
      expect(resolveCalls).toBe(1);
      await settle();
      harness.tick();
      expect(resolveCalls).toBe(1);
      clock.advance(2_000);
      harness.tick();
      expect(resolveCalls).toBe(2);
    } finally {
      harness.daemon.stop();
    }
  });

  test("paseo pass syncs states and republishes when rows changed", async () => {
    startSession("s1");
    const clock = fakeClock(Date.parse(NOW));
    let stampOrigin = false;
    const harness = makeHarness({
      nowMs: clock.nowMs,
      loadPaseo: async () =>
        stampOrigin
          ? [
              {
                provider: "claude" as const,
                sessionId: "s1",
                agentId: "agent-1",
                requiresAttention: true,
                isSubagent: false,
                parentAgentId: null,
                attentionTimestamp: NOW,
                updatedAt: null,
                archivedAt: null,
                title: null,
                lastStatus: null,
              },
            ]
          : [],
      applyPaseo: (db, states) => syncPaseoStates(db, states),
    });
    harness.daemon.start();
    try {
      // The first poll kicked off the async paseo load and published the plain
      // snapshot; its write predates the scheduler arming.
      expect(harness.writes).toHaveLength(1);
      expect(readSnapshotFile().sessions[0]?.originKind).toBeNull();

      // The settled empty load applies on the next poll; nothing changed, so
      // the data-version fast path holds.
      await settle();
      harness.tick();
      expect(harness.readCount()).toBe(1);
      expect(harness.writes).toHaveLength(1);

      // Past the paseo cadence the next load stamps origin and unread; the
      // join applies on the daemon's own connection at the following poll,
      // and the maintenance-changed signal alone forces the reprojection
      // (own commits never bump data_version).
      clock.advance(DAEMON_PASEO_INTERVAL_MS);
      stampOrigin = true;
      harness.tick();
      await settle();
      harness.tick();
      expect(harness.readCount()).toBe(2);
      expect(harness.writes).toHaveLength(2);
      expect(readSnapshotFile().sessions[0]).toMatchObject({ originKind: "paseo", originRef: "agent-1" });

      // The next cadence load finds nothing different — the difference guard
      // keeps the fast path quiet instead of republishing every 2 seconds.
      clock.advance(DAEMON_PASEO_INTERVAL_MS);
      stampOrigin = false;
      harness.tick();
      await settle();
      harness.tick();
      expect(harness.readCount()).toBe(2);
      expect(harness.writes).toHaveLength(2);
    } finally {
      harness.daemon.stop();
    }
  });

  test("runs the paseo pass on its cadence, not on every poll", async () => {
    startSession("s1");
    const clock = fakeClock(Date.parse(NOW));
    let loadCalls = 0;
    const harness = makeHarness({
      nowMs: clock.nowMs,
      loadPaseo: async () => {
        loadCalls += 1;
        return [];
      },
    });
    harness.daemon.start();
    try {
      expect(DAEMON_PASEO_INTERVAL_MS).toBe(2_000);
      expect(loadCalls).toBe(1);
      await settle();
      harness.tick();
      clock.advance(1_999);
      harness.tick();
      expect(loadCalls).toBe(1);
      clock.advance(1);
      harness.tick();
      expect(loadCalls).toBe(2);
    } finally {
      harness.daemon.stop();
    }
  });

  test("a never-settling facts pass never blocks the poll loop: heartbeats keep landing", () => {
    startSession("s1");
    const clock = fakeClock(Date.parse(NOW));
    const harness = makeHarness({
      nowMs: clock.nowMs,
      // The provider-file sweep runs off the loop; a slow disk holds the
      // pass in flight, it must never hold the tick.
      resolveFacts: () => new Promise<never>(() => {}),
      loadPaseo: () => new Promise<never>(() => {}),
    });
    harness.daemon.start();
    try {
      expect(harness.writes).toHaveLength(1);
      // With the passes in flight, polls still run and the heartbeat keeps
      // the snapshot fresh — the board's liveness signal survives a hung
      // filesystem sweep.
      for (let elapsed = 0; elapsed < 3 * DAEMON_HEARTBEAT_MS; elapsed += DAEMON_HEARTBEAT_MS) {
        clock.advance(DAEMON_HEARTBEAT_MS);
        harness.tick();
      }
      expect(harness.writes.length).toBeGreaterThan(1);
      expect(harness.diagnostics).toEqual([]);
    } finally {
      harness.daemon.stop();
    }
  });

  test("a due facts pass waits for the in-flight one instead of stacking passes", async () => {
    startSession("s1");
    const clock = fakeClock(Date.parse(NOW));
    let resolveCalls = 0;
    let settleFacts: (facts: SessionFacts) => void = () => {
      throw new Error("no facts pass in flight");
    };
    const harness = makeHarness({
      nowMs: clock.nowMs,
      resolveFacts: () => {
        resolveCalls += 1;
        return new Promise<SessionFacts>((resolve) => {
          settleFacts = resolve;
        });
      },
    });
    harness.daemon.start();
    try {
      expect(resolveCalls).toBe(1);
      clock.advance(2_000);
      harness.tick();
      // Still in flight: the due cadence does not stack a second sweep.
      expect(resolveCalls).toBe(1);
      settleFacts({ titles: [], models: [], activities: [] });
      await settle();
      clock.advance(2_000);
      harness.tick();
      // Settled: the next due pass starts.
      expect(resolveCalls).toBe(2);
    } finally {
      harness.daemon.stop();
    }
  });

  test("a rejected paseo load records one maintenance_failed and never harms publication", async () => {
    startSession("s1");
    const harness = makeHarness({
      loadPaseo: async () => {
        throw new Error("paseo sweep exploded");
      },
    });
    harness.daemon.start();
    try {
      await settle();
      harness.tick();
      expect(harness.diagnostics).toEqual([{ timestamp: NOW, component: "daemon", code: "maintenance_failed" }]);
      expect(harness.writes.at(-1)?.health.status).toBe("ok");
    } finally {
      harness.daemon.stop();
    }
  });

  test("records clock_jump when the poll gap exceeds the threshold", () => {
    const clock = fakeClock(Date.parse(NOW));
    const harness = makeHarness({ nowMs: clock.nowMs });
    harness.daemon.start();
    try {
      harness.tick();
      expect(harness.diagnostics).toEqual([]);
      clock.advance(31_000);
      harness.tick();
      expect(harness.diagnostics).toEqual([{ timestamp: NOW, component: "daemon", code: "clock_jump" }]);
      // The wake itself is not an error: publication stays healthy.
      expect(harness.writes.at(-1)?.health.status).toBe("ok");
    } finally {
      harness.daemon.stop();
    }
  });

  test("records tick_stall for a poll gap in the stall band, once per stall", () => {
    const clock = fakeClock(Date.parse(NOW));
    const harness = makeHarness({ nowMs: clock.nowMs });
    harness.daemon.start();
    try {
      harness.tick();
      expect(harness.diagnostics).toEqual([]);
      clock.advance(12_000);
      harness.tick();
      expect(harness.diagnostics).toEqual([{ timestamp: NOW, component: "daemon", code: "tick_stall" }]);
      // Only the first post-stall tick observes the gap: one stall, one record.
      clock.advance(DAEMON_POLL_INTERVAL_MS);
      harness.tick();
      expect(harness.diagnostics).toHaveLength(1);
      // A stall is evidence, not an error state: publication stays healthy.
      expect(harness.writes.at(-1)?.health.status).toBe("ok");
    } finally {
      harness.daemon.stop();
    }
  });

  test("the stall and clock-jump bands are exclusive, with a quiet floor", () => {
    const clock = fakeClock(Date.parse(NOW));
    const harness = makeHarness({ nowMs: clock.nowMs });
    harness.daemon.start();
    try {
      harness.tick();
      clock.advance(35_000);
      harness.tick();
      expect(harness.diagnostics).toEqual([{ timestamp: NOW, component: "daemon", code: "clock_jump" }]);
      clock.advance(5_000);
      harness.tick();
      expect(harness.diagnostics).toHaveLength(1); // sub-band gaps log nothing
      clock.advance(TICK_STALL_MS); // exactly 10s: the band is inclusive
      harness.tick();
      expect(harness.diagnostics).toEqual([
        { timestamp: NOW, component: "daemon", code: "clock_jump" },
        { timestamp: NOW, component: "daemon", code: "tick_stall" },
      ]);
    } finally {
      harness.daemon.stop();
    }
  });
  test("failing heartbeat writes past the staleness threshold record one snapshot_publish_overdue", () => {
    const clock = fakeClock(Date.parse(NOW));
    let failWrites = false;
    const harness = makeHarness({
      nowMs: clock.nowMs,
      writeSnapshot: (path, snapshot) => {
        if (failWrites) {
          throw new Error("disk full");
        }
        writeSnapshotAtomically(path, snapshot);
      },
    });
    harness.daemon.start();
    try {
      failWrites = true;
      for (let elapsed = 0; elapsed < 15_000; elapsed += DAEMON_HEARTBEAT_MS) {
        clock.advance(DAEMON_HEARTBEAT_MS);
        harness.tick();
      }
      // Latched: 10s and 15s of failed writes are one failure window.
      expect(harness.diagnostics).toEqual([{ timestamp: NOW, component: "daemon", code: "snapshot_publish_overdue" }]);
      // A successful publish re-arms the latch; a second window logs again.
      failWrites = false;
      clock.advance(DAEMON_HEARTBEAT_MS);
      harness.tick();
      failWrites = true;
      for (let elapsed = 0; elapsed < 15_000; elapsed += DAEMON_HEARTBEAT_MS) {
        clock.advance(DAEMON_HEARTBEAT_MS);
        harness.tick();
      }
      expect(harness.diagnostics).toHaveLength(2);
    } finally {
      harness.daemon.stop();
    }
  });

  test("writes failing from the very first attempt record one snapshot_publish_overdue", () => {
    const clock = fakeClock(Date.parse(NOW));
    let failWrites = true;
    const harness = makeHarness({
      nowMs: clock.nowMs,
      writeSnapshot: (path, snapshot) => {
        if (failWrites) {
          throw new Error("disk full");
        }
        writeSnapshotAtomically(path, snapshot);
      },
    });
    harness.daemon.start();
    try {
      // The daemon has never published: the startup write threw before any
      // timestamp or code report existed, so the only reference point is the
      // daemon's own start.
      expect(harness.writes).toEqual([]);
      expect(harness.diagnostics).toEqual([]);
      for (let elapsed = 0; elapsed < 15_000; elapsed += DAEMON_HEARTBEAT_MS) {
        clock.advance(DAEMON_HEARTBEAT_MS);
        harness.tick();
      }
      // 10s and 15s of never-published silence are one failure window.
      expect(harness.diagnostics).toEqual([{ timestamp: NOW, component: "daemon", code: "snapshot_publish_overdue" }]);
      // The first successful publish re-arms the latch.
      failWrites = false;
      clock.advance(DAEMON_HEARTBEAT_MS);
      harness.tick();
      expect(readSnapshotFile().health.status).toBe("ok");
      failWrites = true;
      for (let elapsed = 0; elapsed < 15_000; elapsed += DAEMON_HEARTBEAT_MS) {
        clock.advance(DAEMON_HEARTBEAT_MS);
        harness.tick();
      }
      expect(harness.diagnostics).toHaveLength(2);
    } finally {
      harness.daemon.stop();
    }
  });

  test("a loop stall with healthy writes records tick_stall only, never snapshot_publish_overdue", () => {
    const clock = fakeClock(Date.parse(NOW));
    const harness = makeHarness({ nowMs: clock.nowMs });
    harness.daemon.start();
    try {
      harness.tick();
      clock.advance(12_000);
      // The post-stall tick heartbeats before the overdue check runs, so the
      // 12s-old lastPublishAtMs is refreshed and only the gap band logs.
      harness.tick();
      expect(harness.diagnostics).toEqual([{ timestamp: NOW, component: "daemon", code: "tick_stall" }]);
    } finally {
      harness.daemon.stop();
    }
  });

  test("a maintenance failure records one diagnostic and never harms publication", async () => {
    startSession("s1");
    const harness = makeHarness({
      resolveFacts: async () => {
        throw new Error("resolver exploded");
      },
    });
    harness.daemon.start();
    try {
      await settle();
      harness.tick();
      expect(harness.writes).toEqual([HEALTHY_S1]);
      expect(harness.diagnostics).toEqual([{ timestamp: NOW, component: "daemon", code: "maintenance_failed" }]);
      harness.tick();
      expect(harness.writes).toHaveLength(1);
    } finally {
      harness.daemon.stop();
    }
  });

  test("a committed title write republishes even when the model write then fails", async () => {
    startSession("s1");
    const clock = fakeClock(Date.parse(NOW));
    let proposals = 0;
    const harness = makeHarness({
      nowMs: clock.nowMs,
      resolveFacts: async () => {
        proposals += 1;
        if (proposals === 1) {
          return { titles: [], models: [], activities: [] };
        }
        return {
          titles: [{ provider: "claude" as const, sessionId: "s1", title: "Resolved from disk" }],
          // 300 code points violates the v6 CHECK (length BETWEEN 1 AND 256),
          // so updateSessionModels throws AFTER the title write committed —
          // the two writes are separate transactions.
          models: [{ provider: "claude" as const, sessionId: "s1", model: "m".repeat(300) }],
          activities: [],
        };
      },
    });
    harness.daemon.start();
    try {
      // First poll: clean baseline, arming the data_version fast path.
      expect(harness.writes).toEqual([HEALTHY_S1]);

      await settle();
      clock.advance(2_000);
      harness.tick();
      await settle();
      harness.tick();

      // The title write committed even though the model write threw...
      const row = (() => {
        const db = openRegistryDatabase(paths.database, "readonly");
        try {
          return db.query("SELECT title FROM active_sessions").get() as { title: string } | null;
        } finally {
          db.close();
        }
      })();
      expect(row).toEqual({ title: "Resolved from disk" });
      // ...and the failure was reported without harming publication health.
      expect(harness.diagnostics).toEqual([{ timestamp: NOW, component: "daemon", code: "maintenance_failed" }]);
      expect(harness.writes.at(-1)?.health.status).toBe("ok");
      // The committed title must reach the snapshot: own-connection commits
      // never bump data_version, so only maintain's changed flag forces the
      // reprojection.
      expect(readSnapshotFile().sessions[0]?.title).toBe("Resolved from disk");
    } finally {
      harness.daemon.stop();
    }
  });

  test("daemon prune keeps the whole Paseo tree of an unviewed row until it is viewed", () => {
    apply([
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "orchestrator",
        title: null,
        project: null,
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        origin: { kind: "paseo", ref: "agent-0" },
        observedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "worker",
        title: null,
        project: null,
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        origin: { kind: "paseo", ref: "agent-1" },
        observedAt: "2026-08-01T00:00:01.000Z",
      },
      { kind: "Stop", provider: "claude", sessionId: "worker", observedAt: "2026-08-01T00:00:02.000Z" },
    ]);
    const link = openRegistryDatabase(paths.database, "readwrite");
    try {
      link.run(
        "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'worker'",
      );
    } finally {
      link.close();
    }

    const sessionIds = (): string[] => {
      const db = openRegistryDatabase(paths.database, "readonly");
      try {
        return (
          db.query("SELECT session_id FROM active_sessions ORDER BY session_id").all() as { session_id: string }[]
        ).map((row) => row.session_id);
      } finally {
        db.close();
      }
    };

    // The first daemon's startup tick ran the prune pass: the stale tree
    // survives because one member is unviewed.
    const first = makeHarness();
    first.daemon.start();
    first.daemon.stop();
    expect(sessionIds()).toEqual(["orchestrator", "worker"]);

    // View the result; a later daemon (clock past the TTL) prunes the
    // now-fully-viewed tree — both root rows.
    const view = openRegistryDatabase(paths.database, "readwrite");
    try {
      viewSession(view, "claude", "worker", NOW);
    } finally {
      view.close();
    }
    const second = makeHarness({
      nowMs: () => Date.parse("2026-08-27T00:00:00.000Z"),
      now: () => "2026-08-27T00:00:00.000Z",
    });
    second.daemon.start();
    try {
      expect(sessionIds()).toEqual([]);
    } finally {
      second.daemon.stop();
    }
  });
});
