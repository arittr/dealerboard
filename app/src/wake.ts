/**
 * Wake grace: after the webview resumes from system sleep (or heavy
 * throttling), sleep-stale snapshot evidence must not flip the board
 * OFFLINE before the daemon's first post-wake heartbeat can land.
 *
 * Detection is in-process — a 1s watchdog notices its own late firing;
 * the same sleep that staled the file made the watchdog late, so no
 * native wake event is needed. False positives (occlusion throttling)
 * are harmless: they only grant grace, and grace holds nothing unless
 * the read evidence is actually stale.
 */

import { type SnapshotRead, STALE_SNAPSHOT_AGE_MS } from "./snapshot-view";

/** Two consecutive watchdog fires this far apart mean the webview was suspended. */
export const RESUME_GAP_MS = 5_000;
/** How long after resume detection sleep-stale evidence is held instead of applied. */
export const WAKE_GRACE_MS = 6_000;

export type WakeGrace = {
  /** Feed from a ~1s interval; a late fire opens the grace window. */
  noteTick: (nowMs: number) => void;
  /**
   * True when a degraded read should be held: the window is open — or the
   * watchdog has not yet fired since suspension — AND the evidence is
   * sleep-stale (a missing read or a stale mtime). Fresh evidence, healthy
   * or not, is never held.
   */
  shouldHold: (read: SnapshotRead | null, nowMs: number) => boolean;
};

export const createWakeGrace = (
  options: { resumeGapMs?: number; graceMs?: number; staleMs?: number } = {},
): WakeGrace => {
  const resumeGapMs = options.resumeGapMs ?? RESUME_GAP_MS;
  const graceMs = options.graceMs ?? WAKE_GRACE_MS;
  const staleMs = options.staleMs ?? STALE_SNAPSHOT_AGE_MS;
  let lastTickAtMs: number | null = null;
  let graceUntilMs: number | null = null;
  return {
    noteTick: (nowMs) => {
      if (lastTickAtMs !== null && nowMs - lastTickAtMs >= resumeGapMs) {
        graceUntilMs = nowMs + graceMs;
      }
      lastTickAtMs = nowMs;
    },
    shouldHold: (read, nowMs) => {
      const inGrace = graceUntilMs !== null && nowMs <= graceUntilMs;
      // A resumed read can settle before the resumed interval's first fire;
      // an unticked-through suspension counts as grace so that race cannot
      // flash OFFLINE.
      const suspendedNow = lastTickAtMs !== null && nowMs - lastTickAtMs >= resumeGapMs;
      if (!inGrace && !suspendedNow) {
        return false;
      }
      return read === null || nowMs - read.mtimeMs > staleMs;
    },
  };
};
