/**
 * Webview port of the plugin's SnapshotCache semantics
 * (src/plugin/snapshot-reader.ts) over an async read: a missing, stale,
 * unparseable, or explicitly unhealthy snapshot degrades to the last-good
 * view, or to an empty degraded view before the first healthy read. File age
 * IS the daemon-liveness signal: a live daemon rewrites the snapshot every 5s
 * heartbeat, so anything past the stale threshold is a dead daemon.
 */

import { parseSessionSnapshot, type SessionSnapshotV2, type SnapshotView } from "../../src/protocol";

/** Two missed daemon heartbeats; mirrors STALE_SNAPSHOT_AGE_MS in src/plugin/snapshot-reader.ts. */
export const STALE_SNAPSHOT_AGE_MS = 10_000;

export type SnapshotRead = { mtimeMs: number; contents: string };

export type SnapshotReduction = { view: SnapshotView; lastGood: SessionSnapshotV2 | null };

const EMPTY_DEGRADED_SNAPSHOT: SessionSnapshotV2 = {
  schemaVersion: 2,
  health: { status: "error", message: "snapshot_unavailable" },
  sessions: [],
  agents: null,
};

const degraded = (lastGood: SessionSnapshotV2 | null): SnapshotView => ({
  snapshot: lastGood ?? EMPTY_DEGRADED_SNAPSHOT,
  degraded: true,
});

export const reduceSnapshotRead = (
  read: SnapshotRead | null,
  lastGood: SessionSnapshotV2 | null,
  now: number,
): SnapshotReduction => {
  if (read === null || now - read.mtimeMs > STALE_SNAPSHOT_AGE_MS) {
    return { view: degraded(lastGood), lastGood };
  }
  let snapshot: SessionSnapshotV2;
  try {
    snapshot = parseSessionSnapshot(JSON.parse(read.contents));
  } catch {
    return { view: degraded(lastGood), lastGood };
  }
  if (snapshot.health.status !== "ok") {
    return { view: degraded(lastGood), lastGood };
  }
  return { view: { snapshot, degraded: false }, lastGood: snapshot };
};

/**
 * Milliseconds from `now` until the read crosses the stale threshold — the
 * exact moment a staleness re-check matters. Zero for a payload already at
 * or past expiry (check immediately; the reducer's strictly-greater test
 * makes an at-threshold check healthy, so a zero delay simply re-arms);
 * null when there is no payload to expire. Scheduling the OFFLINE check
 * here rather than on a fixed cadence bounds detection to one threshold
 * after the daemon's last publish instead of up to two.
 */
export const msUntilStale = (read: SnapshotRead | null, now: number): number | null =>
  read === null ? null : Math.max(0, read.mtimeMs + STALE_SNAPSHOT_AGE_MS - now);

/**
 * Exact unread count: sessions carrying an unviewed-result stamp. Replaces
 * the on-grid idle+error approximation — the wire now carries the ledger
 * field, so an acked tile stops counting immediately.
 */
export const countUnreadSessions = (snapshot: SessionSnapshotV2): number =>
  snapshot.sessions.filter((session) => session.unreadSince !== null).length;
