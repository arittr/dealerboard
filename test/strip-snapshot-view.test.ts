import { describe, expect, test } from "bun:test";
import { reduceSnapshotRead, type SnapshotRead } from "../app/src/snapshot-view";
import type { SessionSnapshotV2 } from "../src/protocol";

const healthy = (sessions: SessionSnapshotV2["sessions"] = []): SessionSnapshotV2 => ({
  schemaVersion: 2,
  health: { status: "ok" },
  sessions,
});

const readOf = (mtimeMs: number, value: unknown): SnapshotRead => ({ mtimeMs, contents: JSON.stringify(value) });

const NOW = 100_000;
const FRESH = NOW - 5_000;

describe("reduceSnapshotRead", () => {
  test("a fresh healthy read renders live and becomes last-good", () => {
    const result = reduceSnapshotRead(readOf(FRESH, healthy()), null, NOW);
    expect(result.view.degraded).toBe(false);
    expect(result.lastGood).not.toBeNull();
  });

  test("a stale read degrades and keeps the last-good snapshot", () => {
    const primed = reduceSnapshotRead(readOf(FRESH, healthy()), null, NOW);
    const lastGood = primed.lastGood;
    if (lastGood === null) {
      throw new Error("expected a fresh healthy read to become last-good");
    }
    const stale = reduceSnapshotRead(readOf(NOW - 5_000, healthy()), lastGood, NOW + 20_000);
    expect(stale.view.degraded).toBe(true);
    expect(stale.view.snapshot).toBe(lastGood);
    expect(stale.lastGood).toBe(lastGood);
  });

  test("a staleness boundary at exactly the threshold is not stale", () => {
    const result = reduceSnapshotRead(readOf(FRESH, healthy()), null, FRESH + 10_000);
    expect(result.view.degraded).toBe(false);
  });

  test("a missing read with no last-good degrades to the empty snapshot", () => {
    const result = reduceSnapshotRead(null, null, NOW);
    expect(result.view.degraded).toBe(true);
    expect(result.view.snapshot.sessions).toHaveLength(0);
    expect(result.view.snapshot.health.status).toBe("error");
  });

  test("an unparseable read degrades and keeps last-good", () => {
    const primed = reduceSnapshotRead(readOf(FRESH, healthy()), null, NOW);
    const result = reduceSnapshotRead({ mtimeMs: FRESH, contents: "{not json" }, primed.lastGood, NOW);
    expect(result.view.degraded).toBe(true);
    expect(result.lastGood).not.toBeNull();
  });

  test("an explicitly unhealthy snapshot never becomes last-good", () => {
    const primed = reduceSnapshotRead(readOf(FRESH, healthy()), null, NOW);
    const lastGood = primed.lastGood;
    if (lastGood === null) {
      throw new Error("expected a fresh healthy read to become last-good");
    }
    const unhealthy = { schemaVersion: 2, health: { status: "error", message: "boom" }, sessions: [] };
    const result = reduceSnapshotRead(readOf(FRESH, unhealthy), lastGood, NOW);
    expect(result.view.degraded).toBe(true);
    expect(result.view.snapshot).toBe(lastGood);
  });
});
