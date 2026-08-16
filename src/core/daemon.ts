/**
 * Projection and maintenance daemon — the only publisher of the session
 * snapshot, and the owner of time-based registry upkeep.
 *
 * The daemon holds one long-lived read-write SQLite connection, publishes one
 * snapshot before arming its timer, then polls `PRAGMA data_version` every
 * 250 milliseconds. It recomputes the projection when another connection has
 * committed (the data version changed), when its own maintenance changed
 * rows (own-connection commits never bump the data version), or when the
 * previous poll was unhealthy, and it replaces the snapshot file atomically
 * only when the canonical JSON actually differs. Independent of data changes,
 * it rewrites the current snapshot every heartbeat interval so the file's
 * mtime doubles as the daemon-liveness signal the plugin watches.
 *
 * Maintenance runs inside the same poll loop: a titles pass (resolve session
 * titles from provider files, update rows that changed) every two seconds
 * and a prune pass (delete sessions whose last hook is older than the stale
 * TTL — one hour for zcode, which has no SessionEnd hook, a day for everyone
 * else) every minute. A poll gap beyond the clock-jump threshold — the sleep
 * signature of the host machine — records a diagnostic. Maintenance failures
 * record their own diagnostic and never affect publication health.
 *
 * `PRAGMA user_version` is validated when the connection opens; on an open,
 * read, or projection failure the daemon publishes the schema-valid unhealthy
 * shape with a bounded fixed code — never caught error text — and keeps
 * retrying on later polls.
 */

import type { Database } from "bun:sqlite";
import type { SessionSnapshotV2 } from "../protocol";
import type { DiagnosticCode, DiagnosticRecord } from "./diagnostics";
import type { AppPaths } from "./paths";
import { readProjection } from "./projection";
import { listTitleTargets, pruneStaleSessions, type SessionTitleUpdate, updateSessionTitles } from "./registry";
import { openRegistryDatabase, UnsupportedSchemaVersion } from "./schema";
import { writeSnapshotAtomically } from "./snapshot";
import type { TitleTarget } from "./titles";

export const DAEMON_POLL_INTERVAL_MS = 250;
/** How often the snapshot file is rewritten even when nothing changed. */
export const DAEMON_HEARTBEAT_MS = 5_000;
/** How often titles are resolved from provider files. */
export const DAEMON_TITLE_INTERVAL_MS = 2_000;
/** How often stale sessions are pruned. */
export const DAEMON_PRUNE_INTERVAL_MS = 60_000;
/** A non-zcode session with no hook event for this long is presumed dead and pruned. */
export const STALE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** A zcode session with no hook event for this long is presumed dead (zcode has no SessionEnd hook). */
export const ZCODE_STALE_SESSION_TTL_MS = 60 * 60 * 1000;
/** A poll gap this large means the host slept or the clock jumped. */
export const CLOCK_JUMP_MS = 30_000;

const DIAGNOSTIC_COMPONENT = "daemon";

export type DaemonState = {
  lastDataVersion: number | null;
  lastPublishedJson: string | null;
  lastSnapshot: SessionSnapshotV2 | null;
  lastPublishAtMs: number | null;
  lastTitlePassAtMs: number | null;
  lastPrunePassAtMs: number | null;
  lastTickAtMs: number | null;
  healthy: boolean;
};

/** Arms the poll loop; the returned callback disarms it. */
export type DaemonScheduler = (poll: () => void, intervalMs: number) => () => void;

export type ResolveTitles = (targets: readonly TitleTarget[]) => SessionTitleUpdate[];

export type DaemonDependencies = {
  openDatabase?: typeof openRegistryDatabase;
  readProjection?: typeof readProjection;
  writeSnapshot?: typeof writeSnapshotAtomically;
  schedule?: DaemonScheduler;
  now?: () => string;
  nowMs?: () => number;
  resolveTitles?: ResolveTitles;
  diagnostics?: (record: DiagnosticRecord) => void;
};

type ResolvedDaemonDependencies = Required<DaemonDependencies>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Map any failure to a bounded fixed code; caught error text never leaks. */
const healthCode = (error: unknown): DiagnosticCode => {
  if (error instanceof UnsupportedSchemaVersion) {
    return "unsupported_schema";
  }
  if (isRecord(error) && error["code"] === "SQLITE_CANTOPEN") {
    return "missing_database";
  }
  return "internal_error";
};

const readDataVersion = (db: Database): number => {
  const row = db.query("PRAGMA data_version").get() as { data_version: number } | null;
  if (row === null || typeof row.data_version !== "number") {
    throw new Error("failed to read PRAGMA data_version");
  }
  return row.data_version;
};

const defaultSchedule: DaemonScheduler = (poll, intervalMs) => {
  const timer = setInterval(poll, intervalMs);
  return () => clearInterval(timer);
};

export class ProjectionDaemon {
  private readonly deps: ResolvedDaemonDependencies;
  private readonly paths: Pick<AppPaths, "database" | "snapshot">;
  private connection: Database | null = null;
  private cancelSchedule: (() => void) | null = null;
  private readonly state: DaemonState = {
    lastDataVersion: null,
    lastPublishedJson: null,
    lastSnapshot: null,
    lastPublishAtMs: null,
    lastTitlePassAtMs: null,
    lastPrunePassAtMs: null,
    lastTickAtMs: null,
    healthy: false,
  };

  constructor(paths: Pick<AppPaths, "database" | "snapshot">, dependencies: DaemonDependencies = {}) {
    this.paths = paths;
    this.deps = {
      openDatabase: openRegistryDatabase,
      readProjection,
      writeSnapshot: writeSnapshotAtomically,
      schedule: defaultSchedule,
      now: () => new Date().toISOString(),
      nowMs: () => Date.now(),
      resolveTitles: () => [],
      diagnostics: () => {},
      ...dependencies,
    };
  }

  /** Publish once, then arm the poll timer. */
  start(): void {
    this.tick();
    this.cancelSchedule = this.deps.schedule(this.tick, DAEMON_POLL_INTERVAL_MS);
  }

  /** Disarm the timer and release the connection. */
  stop(): void {
    this.cancelSchedule?.();
    this.cancelSchedule = null;
    this.connection?.close();
    this.connection = null;
  }

  private readonly tick = (): void => {
    try {
      this.poll();
    } catch {
      // A snapshot-publication I/O failure records no new state, so the next
      // poll retries instead of crashing the loop.
    }
  };

  private poll(): void {
    const nowMs = this.deps.nowMs();
    if (this.state.lastTickAtMs !== null && nowMs - this.state.lastTickAtMs > CLOCK_JUMP_MS) {
      this.report("clock_jump");
    }
    this.state.lastTickAtMs = nowMs;
    try {
      this.pollOnce(nowMs);
    } finally {
      this.maybeHeartbeat(nowMs);
    }
  }

  private pollOnce(nowMs: number): void {
    if (this.connection === null) {
      try {
        this.connection = this.deps.openDatabase(this.paths.database, "readwrite");
      } catch (error) {
        this.publishUnhealthy(healthCode(error), nowMs);
        return;
      }
    }
    // Maintenance precedes the version fast-path: commits on this connection
    // never bump the data version it is about to be compared against.
    const maintenanceChanged = this.maintain(nowMs);
    let dataVersion: number;
    try {
      dataVersion = readDataVersion(this.connection);
    } catch (error) {
      // A connection that cannot answer the version pragma is dropped so the
      // next poll reopens.
      this.connection.close();
      this.connection = null;
      this.publishUnhealthy(healthCode(error), nowMs);
      return;
    }
    if (
      !maintenanceChanged &&
      this.state.healthy &&
      this.state.lastDataVersion !== null &&
      dataVersion === this.state.lastDataVersion
    ) {
      return;
    }
    let snapshot: SessionSnapshotV2;
    try {
      snapshot = this.deps.readProjection(this.connection);
    } catch (error) {
      this.publishUnhealthy(healthCode(error), nowMs);
      return;
    }
    this.publishHealthy(snapshot, dataVersion, nowMs);
  }

  /**
   * Time-based upkeep: titles on the fast cadence, stale pruning on the slow
   * one. Returns true when any row changed, forcing reprojection. Failures
   * record one diagnostic and never mark the daemon unhealthy.
   */
  private maintain(nowMs: number): boolean {
    if (this.connection === null) {
      return false;
    }
    let changed = false;
    try {
      if (this.state.lastTitlePassAtMs === null || nowMs - this.state.lastTitlePassAtMs >= DAEMON_TITLE_INTERVAL_MS) {
        this.state.lastTitlePassAtMs = nowMs;
        const updates = this.deps.resolveTitles(listTitleTargets(this.connection));
        if (updates.length > 0 && updateSessionTitles(this.connection, updates) > 0) {
          changed = true;
        }
      }
      if (this.state.lastPrunePassAtMs === null || nowMs - this.state.lastPrunePassAtMs >= DAEMON_PRUNE_INTERVAL_MS) {
        this.state.lastPrunePassAtMs = nowMs;
        const cutoff = new Date(nowMs - STALE_SESSION_TTL_MS).toISOString();
        const zcodeCutoff = new Date(nowMs - ZCODE_STALE_SESSION_TTL_MS).toISOString();
        if (pruneStaleSessions(this.connection, cutoff, zcodeCutoff) > 0) {
          changed = true;
        }
      }
    } catch {
      this.report("maintenance_failed");
    }
    return changed;
  }

  /**
   * Rewrite the current snapshot when the file's mtime would otherwise go
   * stale. The plugin treats an old file as a dead daemon; identical content
   * still arrives under a new file identity thanks to the atomic rename.
   */
  private maybeHeartbeat(nowMs: number): void {
    if (this.state.lastSnapshot === null || this.state.lastPublishAtMs === null) {
      return;
    }
    if (nowMs - this.state.lastPublishAtMs < DAEMON_HEARTBEAT_MS) {
      return;
    }
    try {
      this.deps.writeSnapshot(this.paths.snapshot, this.state.lastSnapshot);
      this.state.lastPublishAtMs = nowMs;
    } catch {
      // A heartbeat I/O failure retries on the next poll.
    }
  }

  private publishHealthy(snapshot: SessionSnapshotV2, dataVersion: number, nowMs: number): void {
    const json = JSON.stringify(snapshot);
    if (json !== this.state.lastPublishedJson) {
      this.deps.writeSnapshot(this.paths.snapshot, snapshot);
      this.state.lastPublishedJson = json;
      this.state.lastSnapshot = snapshot;
      this.state.lastPublishAtMs = nowMs;
    }
    this.state.lastDataVersion = dataVersion;
    this.state.healthy = true;
  }

  private publishUnhealthy(code: DiagnosticCode, nowMs: number): void {
    this.state.healthy = false;
    const snapshot: SessionSnapshotV2 = {
      schemaVersion: 2,
      health: { status: "error", message: code },
      sessions: [],
    };
    const json = JSON.stringify(snapshot);
    if (json === this.state.lastPublishedJson) {
      return;
    }
    this.deps.writeSnapshot(this.paths.snapshot, snapshot);
    this.state.lastPublishedJson = json;
    this.state.lastSnapshot = snapshot;
    this.state.lastPublishAtMs = nowMs;
    this.report(code);
  }

  private report(code: DiagnosticCode): void {
    try {
      this.deps.diagnostics({ timestamp: this.deps.now(), component: DIAGNOSTIC_COMPONENT, code });
    } catch {
      // Diagnostics must never break the poll loop.
    }
  }
}
