import { describe, expect, test } from "bun:test";
import { STALE_SNAPSHOT_AGE_MS } from "../app/src/snapshot-view";
import { createWakeGrace, RESUME_GAP_MS, WAKE_GRACE_MS } from "../app/src/wake";

const T0 = 1_000_000;
const staleRead = (now: number) => ({ mtimeMs: now - 60_000, contents: "{}" });
const freshRead = (now: number) => ({ mtimeMs: now - 1_000, contents: "{}" });

describe("createWakeGrace", () => {
  test("exposes the spec constants", () => {
    expect(RESUME_GAP_MS).toBe(5_000);
    expect(WAKE_GRACE_MS).toBe(6_000);
  });

  test("steady 1s ticks never hold anything", () => {
    const grace = createWakeGrace();
    for (let t = T0; t <= T0 + 5_000; t += 1_000) {
      grace.noteTick(t);
    }
    expect(grace.shouldHold(staleRead(T0 + 5_000), T0 + 5_000)).toBe(false);
    expect(grace.shouldHold(null, T0 + 5_000)).toBe(false);
  });

  test("a late watchdog fire opens grace: stale evidence holds until the window closes", () => {
    const grace = createWakeGrace();
    grace.noteTick(T0);
    grace.noteTick(T0 + 30_000); // the webview slept through 30s of ticks
    expect(grace.shouldHold(staleRead(T0 + 30_500), T0 + 30_500)).toBe(true);
    // Ticks resume on cadence; the window holds through its inclusive end…
    for (let t = T0 + 31_000; t <= T0 + 36_000; t += 1_000) {
      grace.noteTick(t);
      expect(grace.shouldHold(staleRead(t), t)).toBe(true);
    }
    // …and is closed one tick later.
    grace.noteTick(T0 + 37_000);
    expect(grace.shouldHold(staleRead(T0 + 37_000), T0 + 37_000)).toBe(false);
  });

  test("holds only sleep-stale evidence: fresh reads pass through, missing reads hold", () => {
    const grace = createWakeGrace();
    grace.noteTick(T0);
    grace.noteTick(T0 + 30_000);
    const now = T0 + 30_500;
    expect(grace.shouldHold(freshRead(now), now)).toBe(false);
    // At exactly the staleness threshold the reducer still treats the read
    // as healthy (strictly-greater test); the hold mirrors that boundary.
    expect(grace.shouldHold({ mtimeMs: now - STALE_SNAPSHOT_AGE_MS, contents: "{}" }, now)).toBe(false);
    // A fresh payload that explicitly reports unhealthy is fresh evidence:
    // never held — the reducer renders it degraded, honestly (spec R2).
    const unhealthy = JSON.stringify({
      schemaVersion: 2,
      health: { status: "error", message: "internal_error" },
      sessions: [],
      agents: null,
    });
    expect(grace.shouldHold({ mtimeMs: now - 1_000, contents: unhealthy }, now)).toBe(false);
    expect(grace.shouldHold(null, now)).toBe(true);
  });

  test("suspension the watchdog has not ticked through yet already holds (resume race)", () => {
    const grace = createWakeGrace();
    grace.noteTick(T0);
    // No tick since T0: a read settling right after resume, before the 1s
    // interval's first post-wake fire, must still be held.
    expect(grace.shouldHold(staleRead(T0 + 30_000), T0 + 30_000)).toBe(true);
  });

  test("with no tick history there is never a hold", () => {
    const grace = createWakeGrace();
    expect(grace.shouldHold(staleRead(T0), T0)).toBe(false);
  });

  test("a second suspension re-opens grace after the first window expired", () => {
    const grace = createWakeGrace();
    grace.noteTick(T0);
    grace.noteTick(T0 + 30_000);
    grace.noteTick(T0 + 37_000); // past the first window (7s gap also re-opens)
    expect(grace.shouldHold(staleRead(T0 + 37_100), T0 + 37_100)).toBe(true);
    grace.noteTick(T0 + 38_000);
    grace.noteTick(T0 + 39_000);
    grace.noteTick(T0 + 80_000); // a clean second suspension much later
    expect(grace.shouldHold(staleRead(T0 + 80_100), T0 + 80_100)).toBe(true);
  });
});
