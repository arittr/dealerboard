/**
 * Read-only projection daemon — the only publisher of the session snapshot.
 *
 * The daemon holds one long-lived read-only SQLite connection, publishes one
 * snapshot before arming its timer, then polls `PRAGMA data_version` every
 * 250 milliseconds. It recomputes the projection only when another connection
 * has committed (the data version changed) or when the previous poll was
 * unhealthy, and it replaces the snapshot file atomically only when the
 * canonical JSON actually differs. `PRAGMA user_version` is validated when
 * the connection opens; on an open, read, or projection failure the daemon
 * publishes the schema-valid unhealthy shape with a bounded fixed code —
 * never caught error text — and keeps retrying on later polls. The daemon
 * never mutates the registry: its only statements are the data-version
 * pragma and transaction-bounded selects.
 */

import type { Database } from "bun:sqlite";
import type { DiagnosticCode, DiagnosticRecord } from "./diagnostics";
import type { AppPaths } from "./paths";
import { readProjection } from "./projection";
import { openRegistryDatabase, UnsupportedSchemaVersion } from "./schema";
import { writeSnapshotAtomically } from "./snapshot";
import type { SessionSnapshotV2 } from "../protocol";

export const DAEMON_POLL_INTERVAL_MS = 250;

const DIAGNOSTIC_COMPONENT = "daemon";

export type DaemonState = {
  lastDataVersion: number | null;
  lastPublishedJson: string | null;
  healthy: boolean;
};

/** Arms the poll loop; the returned callback disarms it. */
export type DaemonScheduler = (poll: () => void, intervalMs: number) => () => void;

export type DaemonDependencies = {
  openDatabase?: typeof openRegistryDatabase;
  readProjection?: typeof readProjection;
  writeSnapshot?: typeof writeSnapshotAtomically;
  schedule?: DaemonScheduler;
  now?: () => string;
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
    healthy: false,
  };

  constructor(
    paths: Pick<AppPaths, "database" | "snapshot">,
    dependencies: DaemonDependencies = {},
  ) {
    this.paths = paths;
    this.deps = {
      openDatabase: openRegistryDatabase,
      readProjection,
      writeSnapshot: writeSnapshotAtomically,
      schedule: defaultSchedule,
      now: () => new Date().toISOString(),
      diagnostics: () => {},
      ...dependencies,
    };
  }

  /** Publish once, then arm the poll timer. */
  start(): void {
    this.tick();
    this.cancelSchedule = this.deps.schedule(this.tick, DAEMON_POLL_INTERVAL_MS);
  }

  /** Disarm the timer and release the read-only connection. */
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
    if (this.connection === null) {
      try {
        this.connection = this.deps.openDatabase(this.paths.database, "readonly");
      } catch (error) {
        this.publishUnhealthy(healthCode(error));
        return;
      }
    }
    let dataVersion: number;
    try {
      dataVersion = readDataVersion(this.connection);
    } catch (error) {
      // A connection that cannot answer the version pragma is dropped so the
      // next poll reopens.
      this.connection.close();
      this.connection = null;
      this.publishUnhealthy(healthCode(error));
      return;
    }
    if (
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
      this.publishUnhealthy(healthCode(error));
      return;
    }
    this.publishHealthy(snapshot, dataVersion);
  }

  private publishHealthy(snapshot: SessionSnapshotV2, dataVersion: number): void {
    const json = JSON.stringify(snapshot);
    if (json !== this.state.lastPublishedJson) {
      this.deps.writeSnapshot(this.paths.snapshot, snapshot);
      this.state.lastPublishedJson = json;
    }
    this.state.lastDataVersion = dataVersion;
    this.state.healthy = true;
  }

  private publishUnhealthy(code: DiagnosticCode): void {
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
