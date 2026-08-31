# Board OFFLINE Flapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board shows OFFLINE only when the daemon has actually stopped publishing: stalls and publish failures leave log evidence, waking the Mac no longer flashes OFFLINE, and the one foreign file read on the daemon's event loop can no longer stop the heartbeat.

**Architecture:** Four independent, additive changes. The daemon's poll loop gains two diagnostics (a 10–30s gap band, and a publish-failure latch evaluated after each tick's write attempt). The webview app gains a pure wake-grace module driven by its existing 1s interval, consulted by `ingestNow` before applying a degraded view. The quota collector's injectable `readFile` goes async, and the foreign widget-snapshot read races a 2s timeout with at most one read in flight.

**Tech Stack:** Bun (runtime + `bun test`), TypeScript, Tauri webview app, biome + tsc gates via lefthook pre-commit.

**Spec:** `docs/superpowers/specs/2026-08-31-board-offline-flapping-design.md` — read it before starting any task; every threshold and behavior below is argued there.

## Global Constraints

- Branch: `wip/dealerboard-board-offline-flapping` (worktree `.worktrees/board-offline-flapping`; the shared checkout is on another branch — never work there).
- Diagnostics contract (`src/core/diagnostics.ts`): codes are a closed union; records carry only timestamp / component / code (/ provider / sessionId). The three new codes add **no** record fields.
- Spec constants, verbatim: `TICK_STALL_MS = 10_000`, `RESUME_GAP_MS = 5_000`, `WAKE_GRACE_MS = 6_000`, `WIDGET_READ_TIMEOUT_MS = 2_000`.
- TDD: write the failing test first, watch it fail, implement, watch it pass. Commands: `bun test test/<file>.test.ts` per file, `bun test` full, `bun run typecheck`, `bun run lint`.
- No real sleeps in tests: daemon tests use the in-file `fakeClock`; the widget-race tests inject `widgetReadTimeoutMs` (~10ms) so a timing-out pass costs milliseconds.
- Commits per task, conventional prefixes (`feat(daemon):`, `fix(app):`, `fix(quota):`), lefthook pre-commit (biome + typecheck) must pass — never bypass it. End every commit message with `Co-Authored-By:` per the repo's convention visible in `git log`.
- 2-space indent; match surrounding comment density and voice (sentence-style comments stating WHAT/WHY).

---

### Task 1: `tick_stall` diagnostic (spec R1)

**Files:**
- Modify: `src/core/diagnostics.ts:27` (union member)
- Modify: `src/core/daemon.ts:71` (new constant), `src/core/daemon.ts:197-208` (`poll()`)
- Test: `test/daemon.test.ts` (inside the `describe` that defines `fakeClock` at line 417, after the existing clock_jump test at lines 841-856)

**Interfaces:**
- Consumes: existing `CLOCK_JUMP_MS = 30_000`, `ProjectionDaemon.report()`, test harness `makeHarness` / `fakeClock` (both already in `test/daemon.test.ts`).
- Produces: exported `TICK_STALL_MS = 10_000` (Task 2 reuses it), `DiagnosticCode` member `"tick_stall"`.

- [ ] **Step 1: Write the failing tests**

Extend the import block at `test/daemon.test.ts:6-12` with `TICK_STALL_MS` (alphabetical position, after `ProjectionDaemon`). Then add, immediately after the `records clock_jump…` test (line 856):

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/daemon.test.ts`
Expected: both new tests FAIL (`"tick_stall"` is not assignable / no diagnostic recorded); every pre-existing test PASSES.

- [ ] **Step 3: Implement**

`src/core/diagnostics.ts` — extend the union (after `"clock_jump"`, line 27):

```ts
  | "clock_jump"
  | "tick_stall"
```

`src/core/daemon.ts` — after `CLOCK_JUMP_MS` (line 71):

```ts
/**
 * A poll gap in [TICK_STALL_MS, CLOCK_JUMP_MS) is an awake event-loop stall
 * long enough to blank the board (the app treats a 10s-old file as a dead
 * daemon); at CLOCK_JUMP_MS and beyond the gap reads as sleep instead.
 */
export const TICK_STALL_MS = 10_000;
```

Replace the gap check in `poll()` (lines 197-202):

```ts
  private poll(): void {
    const nowMs = this.deps.nowMs();
    if (this.state.lastTickAtMs !== null) {
      const gap = nowMs - this.state.lastTickAtMs;
      if (gap >= CLOCK_JUMP_MS) {
        this.report("clock_jump");
      } else if (gap >= TICK_STALL_MS) {
        this.report("tick_stall");
      }
    }
    this.state.lastTickAtMs = nowMs;
```

(The `clock_jump` comparison moves from `>` to `>=` — that is the spec's band definition; the only behavior change is at the exact 30,000ms boundary.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/daemon.test.ts`
Expected: PASS, including the pre-existing clock_jump test (it advances 31s, inside the ≥30s band either way).

- [ ] **Step 5: Full gates**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/daemon.ts src/core/diagnostics.ts test/daemon.test.ts
git commit -m "feat(daemon): log tick_stall for poll gaps in the 10-30s band"
```

---

### Task 2: `snapshot_publish_overdue` diagnostic (spec R4)

**Files:**
- Modify: `src/core/diagnostics.ts` (union member, after `"tick_stall"`)
- Modify: `src/core/daemon.ts` (`DaemonState`, `poll()`'s `finally`, new private method after `maybeHeartbeat`)
- Test: `test/daemon.test.ts` (same `describe` as Task 1's tests, after them)

**Interfaces:**
- Consumes: `TICK_STALL_MS` from Task 1; existing `state.lastPublishAtMs`, `maybeHeartbeat`, `report()`.
- Produces: `DiagnosticCode` member `"snapshot_publish_overdue"`; `DaemonState` field `publishOverdueReported: boolean`.

- [ ] **Step 1: Write the failing tests**

Extend the import block with `DAEMON_HEARTBEAT_MS` (alphabetically first among the `DAEMON_*` names); `writeSnapshotAtomically` is already imported at line 18. Add after Task 1's tests:

```ts
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
      expect(harness.diagnostics).toEqual([
        { timestamp: NOW, component: "daemon", code: "snapshot_publish_overdue" },
      ]);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/daemon.test.ts`
Expected: both FAIL (`"snapshot_publish_overdue"` not assignable / extra diagnostic missing).

- [ ] **Step 3: Implement**

`src/core/diagnostics.ts` — extend the union:

```ts
  | "tick_stall"
  | "snapshot_publish_overdue"
```

`src/core/daemon.ts`:

1. `DaemonState` (lines 82-92) gains a final field, and the initializer (lines 146-156) sets it:

```ts
  publishOverdueReported: boolean;
```

```ts
    publishOverdueReported: false,
```

2. `poll()`'s `finally` (line 206) evaluates the overdue check **after** the heartbeat attempt:

```ts
    } finally {
      this.maybeHeartbeat(nowMs);
      this.checkPublishOverdue(nowMs);
    }
```

3. New method directly after `maybeHeartbeat` (line 324):

```ts
  /**
   * A publish-failure watchdog, evaluated after the tick's publish attempt:
   * writes that keep failing let the file age past the board's staleness
   * threshold with no other evidence (maybeHeartbeat swallows the I/O
   * error). One record per failure window; a successful publish re-arms
   * the latch. A loop stall alone never trips this — the first post-stall
   * tick's heartbeat write lands before this check runs.
   */
  private checkPublishOverdue(nowMs: number): void {
    if (this.state.lastPublishAtMs === null) {
      return;
    }
    if (nowMs - this.state.lastPublishAtMs < TICK_STALL_MS) {
      this.state.publishOverdueReported = false;
      return;
    }
    if (!this.state.publishOverdueReported) {
      this.state.publishOverdueReported = true;
      this.report("snapshot_publish_overdue");
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/daemon.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Full gates**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/daemon.ts src/core/diagnostics.ts test/daemon.test.ts
git commit -m "feat(daemon): latch snapshot_publish_overdue when writes fail past staleness"
```

---

### Task 3: wake-grace pure module (spec R2, logic)

**Files:**
- Create: `app/src/wake.ts`
- Test: `test/strip-wake.test.ts` (new file; the `strip-*` prefix is the app-side convention — see `test/strip-liveness.test.ts` for the style)

**Interfaces:**
- Consumes: `STALE_SNAPSHOT_AGE_MS` and `type SnapshotRead` from `app/src/snapshot-view.ts` (`SnapshotRead = { mtimeMs: number; contents: string }`; the bridge's `SnapshotPayload` is structurally identical).
- Produces (Task 4 relies on these exact names): `createWakeGrace(options?: { resumeGapMs?: number; graceMs?: number; staleMs?: number }): WakeGrace`, `type WakeGrace = { noteTick(nowMs: number): void; shouldHold(read: SnapshotRead | null, nowMs: number): boolean }`, `RESUME_GAP_MS = 5_000`, `WAKE_GRACE_MS = 6_000`.

- [ ] **Step 1: Write the failing tests**

Create `test/strip-wake.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createWakeGrace, RESUME_GAP_MS, WAKE_GRACE_MS } from "../app/src/wake";
import { STALE_SNAPSHOT_AGE_MS } from "../app/src/snapshot-view";

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
```

Note the third assertion block of the "late watchdog" test: at `t = T0 + 36_000` the window boundary is inclusive (`nowMs <= graceUntilMs` with `graceUntilMs = T0 + 36_000`), and one tick later it is closed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/strip-wake.test.ts`
Expected: FAIL — module `../app/src/wake` does not exist.

- [ ] **Step 3: Implement**

Create `app/src/wake.ts`:

```ts
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

import { STALE_SNAPSHOT_AGE_MS, type SnapshotRead } from "./snapshot-view";

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/strip-wake.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Full gates**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/wake.ts test/strip-wake.test.ts
git commit -m "fix(app): pure wake-grace module — late-watchdog detection, stale-only hold"
```

---

### Task 4: wake-grace wiring in the app (spec R2, integration)

**Files:**
- Modify: `app/src/main.ts` — import block (~line 82), state block (~line 98), timer helpers (~line 332), `ingestNow` (lines 370-389), the 1s interval (lines 456-460)

**Interfaces:**
- Consumes: `createWakeGrace` from Task 3; existing `clearExpiryCheck`, `scheduleExpiryCheck`, `readAndIngest`, `reduceSnapshotRead`, `lastGood`, `snapshotDeferral`.
- Produces: nothing new for later tasks. The semantics are fully unit-tested in Task 3; this wiring is imperative glue in the same style as the existing staleness wiring (which likewise has no direct unit test). Do NOT invent DOM tests here — the gates are typecheck, the full suite, and Task 6's physical acceptance.

- [ ] **Step 1: Add the import and state**

After the snapshot-view import (line 82 `import { countUnreadSessions, msUntilStale, reduceSnapshotRead } from "./snapshot-view";`):

```ts
import { createWakeGrace } from "./wake";
```

After `let stalenessTimer: ReturnType<typeof setTimeout> | null = null;` (line 98):

```ts
const wakeGrace = createWakeGrace();
let graceRereadTimer: ReturnType<typeof setTimeout> | null = null;
```

- [ ] **Step 2: Add the grace re-read timer helper**

Directly after `clearExpiryCheck` (lines 332-337):

```ts
const clearGraceReread = (): void => {
  if (graceRereadTimer !== null) {
    clearTimeout(graceRereadTimer);
    graceRereadTimer = null;
  }
};
```

- [ ] **Step 3: Add the hold branch to `ingestNow`**

Replace the whole `ingestNow` function (lines 370-389) with:

```ts
const ingestNow = (payload: SnapshotPayload | null): void => {
  lastPayload = payload;
  const nowMs = Date.now();
  const reduction = reduceSnapshotRead(payload, lastGood, nowMs);
  // Wake grace: while the post-resume window is open, sleep-stale evidence
  // (an old mtime or a failed read) does not newly degrade a board that
  // has a lastGood view — the daemon's first post-wake heartbeat gets its
  // chance to land. Fresh evidence (unparseable or explicitly unhealthy
  // payloads) always applies. The held view re-reads at 1s until a fresh
  // payload lands or the window closes and the degraded verdict applies.
  if (reduction.view.degraded && lastGood !== null && wakeGrace.shouldHold(payload, nowMs)) {
    clearExpiryCheck();
    clearGraceReread();
    graceRereadTimer = setTimeout(() => {
      graceRereadTimer = null;
      void readAndIngest();
    }, 1_000);
    return;
  }
  clearGraceReread();
  lastGood = reduction.lastGood;
  // The rendered view hides freshly-flicked slats while their ack's
  // settlement makes the registry → snapshot round-trip; lastGood stays
  // unfiltered so an expired dismissal honestly resurfaces.
  currentView = {
    ...reduction.view,
    snapshot: dismissals.filterSnapshot(reduction.view.snapshot, nowMs),
  };
  applyBoard(reduceBoard(currentView, loadStoredSettings()));
  // A healthy view arms the one-shot expiry check; a degraded one disarms it
  // — the slow pass owns re-reads until a fresh payload re-arms it.
  if (payload !== null && !reduction.view.degraded) {
    scheduleExpiryCheck(payload);
  } else {
    clearExpiryCheck();
  }
};
```

(This is the existing function with three changes: a single `nowMs` per ingest replacing the separate `Date.now()` calls, the hold branch, and `clearGraceReread()` on the normal path. Behavior on the normal path is otherwise identical.)

Why the hold branch works with the surrounding machinery: while held, `currentView` stays non-degraded, so `slowPass`'s guard (`main.ts:422`) skips its re-read — the 1s `graceRereadTimer` owns the cadence, preserving the one-timer discipline. When grace expires, the next re-read's `shouldHold` is false, the degraded view applies exactly as today, and the `else` branch disarms the expiry check.

- [ ] **Step 4: Feed the watchdog from the existing 1s interval**

In `start()` (lines 456-460), add the `noteTick` call as the interval's first line:

```ts
  setInterval(() => {
    wakeGrace.noteTick(Date.now());
    renderRailNow();
    tickStatusLines();
    tickLiveness();
  }, 1000);
```

- [ ] **Step 5: Full gates**

Run: `bun test && bun run typecheck && bun run lint && bun run build:app`
Expected: all clean; the app bundle builds.

- [ ] **Step 6: Commit**

```bash
git add app/src/main.ts
git commit -m "fix(app): hold sleep-stale reads through the wake-grace window"
```

---

### Task 5: hang-proof widget read (spec R3)

**Files:**
- Modify: `src/core/diagnostics.ts` (union member, after `"snapshot_publish_overdue"`)
- Modify: `src/core/quota.ts` — import (line 28), dependency type (lines 333-346), `defaultReadFile` (lines 382-388), collector body (seed lines 462-484, new widget reader, `pollNow` lines 615-625)
- Test: `test/quota.test.ts` — harness line 142, new tests after the widget-rescue block (~line 625)

**Interfaces:**
- Consumes: existing `QuotaCollectorDependencies`, `pollNow`, `parseCodexbarWidgetSnapshot`, `codexbarWidgetSnapshotPath`, `DIAGNOSTIC_COMPONENT = "quota"` (quota.ts:323); quota test harness `makeHarness(options, overrides)` whose `overrides` spread into deps, `harness.writes()` (a function returning the written payload strings), `widgetSnapshot(generatedAt)` fixture builder (qwen weekly entry), `widgetPath(dir)`.
- Produces: `readFile` dependency contract becomes `(path: string) => Promise<string | null>`; exported `WIDGET_READ_TIMEOUT_MS = 2_000`; test-seam dependency `widgetReadTimeoutMs?: number`; `DiagnosticCode` member `"widget_read_timeout"`.

- [ ] **Step 1: Convert the harness and write the failing tests**

`test/quota.test.ts:142` — the harness's reader goes async (this alone red-flags every call site until Step 3 lands, which is the point):

```ts
      readFile: (path) => Promise.resolve(options.files?.[path] ?? null),
```

Add after the widget-rescue test block (after the `a successful CLI probe wins over the widget snapshot` test):

```ts
  test("a hung widget read times out: the pass completes, probes run, one diagnostic", async () => {
    const harness = makeHarness(
      {},
      {
        widgetReadTimeoutMs: 10,
        readFile: (path: string) =>
          path.endsWith("widget-snapshot.json")
            ? new Promise<string | null>(() => {})
            : Promise.resolve(null),
      },
    );
    const collector = createQuotaCollector(harness.deps);
    await collector.pollNow();
    expect(harness.calls.length).toBeGreaterThan(0); // CLI probes still ran
    expect(harness.diagnostics).toContainEqual({
      timestamp: NOW,
      component: "quota",
      code: "widget_read_timeout",
    });
    // The reentrancy guard was released: a second pass runs and probes again.
    const probesAfterFirst = harness.calls.length;
    await collector.pollNow();
    expect(harness.calls.length).toBeGreaterThan(probesAfterFirst);
  });

  test("a stuck read is never doubled, and its late value is discarded — a fresh read rescues", async () => {
    let resolveWidget: ((value: string | null) => void) | null = null;
    let widgetReads = 0;
    let settleImmediately = false;
    const harness = makeHarness(
      {},
      {
        widgetReadTimeoutMs: 10,
        readFile: (path: string) => {
          if (!path.endsWith("widget-snapshot.json")) {
            return Promise.resolve(null);
          }
          widgetReads += 1;
          if (settleImmediately) {
            return Promise.resolve(widgetSnapshot("2026-08-19T17:50:00.000Z"));
          }
          return new Promise<string | null>((resolve) => {
            resolveWidget = resolve;
          });
        },
      },
    );
    harness.fail("qwen"); // only the widget could rescue qwen
    const collector = createQuotaCollector(harness.deps);

    await collector.pollNow(); // times out; qwen stays failed
    expect(widgetReads).toBe(1);
    let snapshot = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? ""));
    expect(snapshot.providers["qwen"]).toMatchObject({ unavailable: true });

    await collector.pollNow(); // still stuck: no second read, no second diagnostic
    expect(widgetReads).toBe(1);
    expect(harness.diagnostics.filter((record) => record.code === "widget_read_timeout")).toHaveLength(1);

    // The abandoned read finally lands — its value must go nowhere.
    resolveWidget?.(widgetSnapshot("2026-08-19T17:50:00.000Z"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    settleImmediately = true;
    await collector.pollNow(); // a NEW read starts and rescues qwen
    expect(widgetReads).toBe(2);
    snapshot = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? ""));
    expect(snapshot.providers["qwen"]).toMatchObject({
      weeklyPercentRemaining: 45,
      unavailable: false,
    });
  });

  test("a stuck widget read yields the event loop while the race runs", async () => {
    const harness = makeHarness(
      {},
      {
        widgetReadTimeoutMs: 20,
        readFile: (path: string) =>
          path.endsWith("widget-snapshot.json")
            ? new Promise<string | null>(() => {})
            : Promise.resolve(null),
      },
    );
    const collector = createQuotaCollector(harness.deps);
    const pass = collector.pollNow();
    let ticked = false;
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        ticked = true;
        resolve();
      }, 0),
    );
    expect(ticked).toBe(true); // the loop was free mid-pass
    await pass;
  });
```

(The hang-simulating readers discriminate on path deliberately: the same injected `readFile` also serves the collector's startup seed of `quotaSnapshotPath`, and a blanket never-resolving reader would deadlock the seed await, not exercise the widget race.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/quota.test.ts`
Expected: the three new tests FAIL (unknown dependency `widgetReadTimeoutMs` / type errors from the async `readFile`); typecheck-level failures across the file are expected until Step 3.

- [ ] **Step 3: Implement**

`src/core/diagnostics.ts` — extend the union:

```ts
  | "snapshot_publish_overdue"
  | "widget_read_timeout"
```

`src/core/quota.ts`:

1. Import (line 28): `readFileSync` is no longer used —

```ts
import { existsSync } from "node:fs";
```

2. Constants, next to the other exported timeouts:

```ts
/** A widget read outlasting this is abandoned for the pass (foreign file; its open() has hung before). */
export const WIDGET_READ_TIMEOUT_MS = 2_000;

const WIDGET_READ_TIMED_OUT = Symbol("widget-read-timed-out");
```

3. Dependency type (lines 341 and after 344):

```ts
  readFile?: (path: string) => Promise<string | null>;
```

```ts
  /** Test seam for the widget-read race; production uses WIDGET_READ_TIMEOUT_MS. */
  widgetReadTimeoutMs?: number;
```

4. `defaultReadFile` (lines 382-388) goes async — `Bun.file` reads on the runtime's I/O pool, off the JS event loop:

```ts
const defaultReadFile = async (path: string): Promise<string | null> => {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
};
```

5. In `createQuotaCollector`, next to the other resolved deps (line 437 area):

```ts
  const widgetReadTimeoutMs = dependencies.widgetReadTimeoutMs ?? WIDGET_READ_TIMEOUT_MS;
```

6. The seed block (lines 462-484) wraps in a once-awaited promise — same body, async read:

```ts
  // Seed last-good state from the previous publication so a daemon restart
  // never blanks the panels. The read is async; the first pass awaits it
  // before computing any state.
  const seeded = (async (): Promise<void> => {
    try {
      const existing = await readFile(dependencies.quotaSnapshotPath);
      if (existing !== null) {
        const parsed = parseQuotaSnapshot(JSON.parse(existing));
        claudeAccounts = {
          accounts: parsed.providers["claude"]?.accounts ?? [],
          failed: false,
        };
        for (const key of QUOTA_PROVIDER_KEYS) {
          const quota = parsed.providers[key];
          if (quota !== undefined) {
            // A seeded unavailable row is already in the failed state — its
            // continuation must not re-log, only a good→failed transition may.
            states.set(key, { quota: { ...quota, accounts: [] }, failed: quota.unavailable });
          }
        }
        lastWrittenJson = `${JSON.stringify(parsed)}\n`;
      }
    } catch {
      // An unreadable or unparseable file is simply rewritten on the first pass.
    }
  })();
```

(The seed body is the existing block verbatim except for the async read and the inner constant renamed `parsed`, which would otherwise shadow the `seeded` promise.)

7. New widget reader, after `reportFailure` (line 460 area):

```ts
  const reportWidgetTimeout = (): void => {
    try {
      diagnostics({ timestamp: now(), component: DIAGNOSTIC_COMPONENT, code: "widget_read_timeout" });
    } catch {
      // Diagnostics must never break the collector.
    }
  };

  let widgetReadPending = false;

  /**
   * The widget file is foreign (CodexBar's group container) and has hung
   * open() on this machine before. The read races a timeout so the pass —
   * and the daemon heartbeat sharing this event loop — can never block on
   * it. At most one underlying read exists: while one is stuck, later
   * passes proceed widget-less immediately, and the stuck read's eventual
   * value is discarded with it.
   */
  const readWidgetSnapshot = async (path: string): Promise<string | null> => {
    if (widgetReadPending) {
      return null;
    }
    widgetReadPending = true;
    const read = readFile(path)
      .catch(() => null)
      .finally(() => {
        widgetReadPending = false;
      });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<typeof WIDGET_READ_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(WIDGET_READ_TIMED_OUT), widgetReadTimeoutMs);
    });
    const winner = await Promise.race([read, timeout]);
    if (winner === WIDGET_READ_TIMED_OUT) {
      reportWidgetTimeout();
      return null;
    }
    if (timer !== null) {
      clearTimeout(timer);
    }
    return winner;
  };
```

8. `pollNow` (lines 615-625): await the seed first, and the widget read goes through the racer —

```ts
  const pollNow = async (): Promise<void> => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      await seeded;
      const exec = resolveExec();
      const widget = parseCodexbarWidgetSnapshot(
        (await readWidgetSnapshot(dependencies.widgetSnapshotPath ?? codexbarWidgetSnapshotPath())) ?? "",
        Date.parse(now()),
      );
```

(Everything from the `readClaudeSwap` call down is untouched; claude's commit-after-last-await invariant is unaffected because both new awaits precede it.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/quota.test.ts`
Expected: PASS — the three new tests and every pre-existing test (the seed, rescue, starvation, and diagnostics suites all ride the converted async harness reader).

- [ ] **Step 5: Full gates**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all clean. `bun test` covers `test/cli.test.ts`, which builds the daemon through `src/core/cli.ts` — the collector there is constructed with defaults, so the async default reader is exercised.

- [ ] **Step 6: Commit**

```bash
git add src/core/quota.ts src/core/diagnostics.ts test/quota.test.ts
git commit -m "fix(quota): race the foreign widget read off the event loop behind a 2s timeout"
```

---

### Task 6: gates, changelog, install, physical acceptance

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]` section)

**Interfaces:**
- Consumes: everything above.
- Produces: the released behavior on the physical strip.

- [ ] **Step 1: Full verification**

Run: `bun run check` (biome ci + typecheck + compile + full suite)
Expected: clean. Fix anything it flags before proceeding.

- [ ] **Step 2: Changelog**

Under `## [Unreleased]` in `CHANGELOG.md`, add to `### Added` (and create a `### Fixed` subsection after `### Changed` if one does not exist yet):

```markdown
### Added

- Daemon stall forensics: a 10–30s poll gap logs `tick_stall`, and heartbeat
  writes failing past the staleness threshold latch one
  `snapshot_publish_overdue` — every board-blanking daemon condition now
  leaves a line in `daemon.log`. An abandoned CodexBar widget read logs
  `widget_read_timeout`.

### Fixed

- Waking the Mac no longer flashes the board OFFLINE: sleep-stale snapshot
  evidence is held for a ~6s wake grace while the daemon's first post-wake
  heartbeat lands; fresh evidence — including an explicit unhealthy
  publication — still applies immediately.
- The quota collector's read of CodexBar's group-container widget snapshot
  moved off the daemon's event loop behind a 2s timeout, so a
  containermanagerd hang can no longer stall the heartbeat that keeps the
  board alive.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for the board OFFLINE flapping fixes"
```

- [ ] **Step 4: Install (human at the machine)**

Install the rebuilt daemon and app with the repo's own scripts, reading their output for the exact restart behavior:

```bash
bun scripts/install-local.ts
bun run install:app
```

- [ ] **Step 5: Physical acceptance (human at the machine — from the spec's golden checklist)**

1. **Wake, no flash:** with the daemon healthy, sleep the Mac (lid close or equivalent) for ≥30s, wake, and watch the strip: the board must not flash OFFLINE (today it always does). A daemon deliberately killed before sleep must still show OFFLINE within ~6s of wake — grace delays, never suppresses, a true verdict.
2. **Stall evidence:** leave the daemon running and confirm the next natural stall window lands a `tick_stall` line in `~/Library/Application Support/com.drewritter.dealerboard/logs/daemon.log` (the 6h sampling trap from the spec's status note correlates). To exercise the code path immediately instead of waiting: `kill -STOP <daemon pid>`, wait ~15s, `kill -CONT <daemon pid>` — the board goes OFFLINE at ~10s and recovers on the next heartbeat, and exactly one `tick_stall` line appears.

Record the outcome of both checks in the final report; the spec's physical-acceptance line is the run's exit criterion.
