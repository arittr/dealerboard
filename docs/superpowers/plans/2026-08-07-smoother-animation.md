# Smoother Tile Animation (125 ms Tick) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Double the Stream Deck tile animation rate from 4 fps to 8 fps so the working-spinner segment glides instead of stepping, keeping every visual tempo unchanged in wall-clock time.

**Architecture:** One shared `FrameScheduler` interval drives an integer `phase`; `renderKey(model, phase)` is a pure function of that phase. The change is a retune only: halve the scheduler `TICK_MS` (250 → 125) and halve the per-phase motion rates in `render.ts` (segment step 34 → 17, waiting sine divisor 8 → 16, error sine divisor 4 → 8) so lap/breath/pulse durations are preserved at 4 s / 4 s / 2 s.

**Tech Stack:** Bun, TypeScript, `bun:test` with injected fake clocks. No SDK or runtime imports in the touched modules.

**Spec:** `docs/superpowers/specs/2026-08-06-smoother-animation-design.md` (committed in `6b54281`).

## Global Constraints

- Elgato SDK guidance cited in `src/plugin/scheduler.ts`: max 10 image updates/sec per key. New per-key ceiling must be 8 starts/sec, never above.
- Wall-clock tempos MUST NOT change: working lap 4 s, waiting breath 4 s, error pulse 2 s.
- Do NOT touch: `src/core/` (daemon poller `DAEMON_POLL_INTERVAL_MS = 250`, `BUSY_TIMEOUT_MS`), `src/plugin/controller.ts`'s `POLL_MS = 250`, protocol, layout, `docs/design.md`.
- Dated files under `docs/superpowers/` are historical records — never edit them (this plan and the spec are new files).
- Every task ends green: `bun test` passes before committing.
- Commit messages follow the repo's existing style (see `git log --oneline`).

---

### Task 1: Scheduler tick 250 → 125 ms

**Files:**
- Modify: `src/plugin/scheduler.ts:4,9-10,36,73-74`
- Test: `test/scheduler.test.ts`, `test/controller.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `FrameScheduler` ticking at 125 ms. `test/controller.test.ts` gains a `POLL_MS = 250` constant used in Task-independent assertions; Task 2 does not depend on this task's internals, only on the suite being green.

The scheduler tests use a `FakeClock` where `advance(ms)` fires every due interval, so halving the tick doubles how many ticks an unchanged `advance(250)` fires. The edits below either re-derive expectations for the new rate or switch advances to the `TICK_MS` constant so the scenario shape is preserved.

- [ ] **Step 1: Update `test/scheduler.test.ts` to the 125 ms world (failing)**

Change the constant at line 4:

```ts
const TICK_MS = 125;
```

Test 1 (line 100): rename and re-derive counts. 2000 ms / 125 ms = 16 ticks, plus the immediate first render = 17 starts per context:

```ts
  test("starts at most one update per context per 125 ms tick", async () => {
```

```ts
    // Immediate start at t=0 plus ticks at 125..2000: seventeen starts per
    // context.
    expect(startsFor(port, "a")).toHaveLength(17);
    expect(startsFor(port, "b")).toHaveLength(17);
```

Test "replaces the pending frame while in flight instead of queueing" (line 141): switch the four `advance(250)` calls to `advance(TICK_MS)` so the scenario (three ticks in flight, resolve, one more tick) is preserved exactly — expectations `toHaveLength(2)` and image `"a-phase-4"` then hold unchanged:

```ts
    // Three ticks pass while the first send stays in flight: no parallel
    // starts, and each newer desired frame replaces the pending one.
    await clock.advance(TICK_MS);
    await clock.advance(TICK_MS);
    await clock.advance(TICK_MS);
    expect(port.starts).toHaveLength(1);

    port.resolvePending();
    await flushMicrotasks();
    await clock.advance(TICK_MS);
```

Test "shares one timer across 14 animated contexts..." (line 201): rename, re-derive. 4000 ms / 125 ms = 32 ticks, plus immediate = 33 starts; the per-second ceiling is now 8:

```ts
  test("shares one timer across 14 animated contexts, each within eight starts per second", async () => {
```

```ts
    await clock.advance(4000);

    for (const context of contexts) {
      const times = startTimesFor(port, context);
      // Immediate start plus thirty-two ticks of continuous animation.
      expect(times).toHaveLength(33);
      for (const at of times) {
        const inWindow = times.filter((time) => time >= at && time < at + 1000);
        expect(inWindow.length).toBeLessThanOrEqual(8);
      }
    }
```

Test "renders the first frame immediately and the next at the key's own 250 ms boundary" (line 229): replace the whole test. The advance amounts are re-cut so `b` still lands 25 ms short of its own boundary at the first tick (preserving the test's point), and `b`'s waited start still carries phase 2:

```ts
  test("renders the first frame immediately and the next at the key's own 125 ms boundary", async () => {
    const clock = new FakeClock();
    const port = new FakeImagePort(clock, true);
    const scheduler = new FrameScheduler({
      clock,
      sendImage: port.send,
      renderFrame: (context, phase) => `${context}#${phase}`,
    });

    scheduler.addContext("a");
    expect(startTimesFor(port, "a")).toEqual([0]);

    await clock.advance(100); // now = 100, no tick has fired
    scheduler.addContext("b");
    // The first render for b is immediate even mid-interval.
    expect(startTimesFor(port, "b")).toEqual([100]);

    await clock.advance(50); // tick fires at 125
    // a sits exactly on its boundary and starts; b is 25 ms past its last
    // start and must wait for its own per-key boundary.
    expect(startTimesFor(port, "a")).toEqual([0, 125]);
    expect(startTimesFor(port, "b")).toEqual([100]);

    await clock.advance(125); // tick fires at 250
    expect(startTimesFor(port, "a")).toEqual([0, 125, 250]);
    expect(startTimesFor(port, "b")).toEqual([100, 250]);
    // The waited start carries the current frame, not the obsolete one.
    expect(startsFor(port, "b")[1]!.image).toBe("b#2");
  });
```

No changes to: "suppresses repeated identical frames", "removing a context discards pending work...", "stop clears the timer and every context" (their assertions are rate-independent).

- [ ] **Step 2: Update `test/controller.test.ts` interval assertions (failing)**

The controller registers the scheduler's animation interval first (inside `convergeGrid` → `scheduler.addContext` → `ensureTimer`) and the snapshot poller second (`startPolling`), so `intervalCalls` becomes `[125, 250]`. Split the constant at line 7:

```ts
const TICK_MS = 125;
const POLL_MS = 250;
```

Then update the two identical assertions in the first test (lines 230 and 236):

```ts
    // One scheduler animation clock plus exactly one snapshot poller.
    expect(clock.intervalCalls).toEqual([TICK_MS, POLL_MS]);
```

```ts
    // Later contexts share both timers; no per-context pollers appear.
    await controller.willAppear(appear("ctx-b", 0, 1));
    await controller.willAppear(appear("ctx-c", 0, 2));
    expect(clock.intervalCalls).toEqual([TICK_MS, POLL_MS]);
```

Line 312 (`expect(clock.intervalCalls).toEqual([TICK_MS]);` in the not-5x3 test) needs no edit — it now resolves to `[125]`, which is correct. All `advance(250)` calls in this file assert content (`toContain`) or poller reads, not frame counts, and stay green: the poller still fires once per 250 ms, and extra scheduler ticks only re-render deduped or already-expected frames.

- [ ] **Step 3: Run the two test files to verify they fail**

Run: `bun test test/scheduler.test.ts test/controller.test.ts`
Expected: FAIL — e.g. `intervalCalls` shows `[250]`/`[250, 250]` against the new expectations, and start counts come out at the old 4 fps numbers. If nothing fails, the edits above did not land.

- [ ] **Step 4: Flip the scheduler tick**

In `src/plugin/scheduler.ts`, change line 36:

```ts
const TICK_MS = 125;
```

Update the module doc comment (lines 3-11) to match — the ceiling math is the contract this file advertises:

```ts
/**
 * One bounded animation scheduler shared by every action context.
 *
 * A single 125 ms interval drives all keys. Each context tracks the last sent
 * image, the newest desired image, an in-flight flag, an active flag, and the
 * last start time. A tick computes the current desired frame for every active
 * context, suppresses identical frames, replaces (never queues) pending work
 * while a send is in flight, and starts at most one update per context per
 * tick, never sooner than 125 ms after that key's previous start — an
 * eight-starts-per-second ceiling per key, below the SDK's ten-updates-per-
 * second guidance. The first render after registration is immediate.
 *
 * Promise completion only clears the in-flight flag; it never sends outside a
 * tick. Removing a context drops its pending work, and a late completion
 * cannot restart it. The shared timer exists only while at least one context
 * is registered. The clock and image port are injected, so this module stays
 * free of SDK and runtime-specific APIs.
 */
```

And the inline comment at lines 73-74:

```ts
    // The first render is immediate; later renders wait for this key's own
    // 125 ms boundary.
```

- [ ] **Step 5: Run the full suite to verify it passes**

Run: `bun test`
Expected: PASS (all files). `test/render.test.ts` is untouched here and stays green because `renderKey` is a pure function of `(model, phase)` and knows nothing about the tick rate.

- [ ] **Step 6: Commit**

```bash
git add src/plugin/scheduler.ts test/scheduler.test.ts test/controller.test.ts
git commit -m "plugin: double animation scheduler tick to 125 ms (8 fps ceiling)"
```

---

### Task 2: Halve render phase rates to preserve motion tempos

**Files:**
- Modify: `src/plugin/render.ts:33,83-91`
- Test: `test/render.test.ts:193-202`

**Interfaces:**
- Consumes: the 125 ms tick from Task 1 (phases now arrive twice as fast).
- Produces: unchanged visual tempos — working lap 4 s, waiting breath 4 s, error pulse 2 s — sampled at 8 fps.

Most render tests are qualitative (colors present, frames differ across phases) and pass on both sides of this change. The only numeric casualty is the "error pulses faster than waiting" window: with doubled divisors, neither status reaches its dim minimum inside phases 0..8, so the window must widen to 0..16 — where error (16-phase cycle) bottoms out at phase 12 while waiting (32-phase cycle) has only returned to its midpoint.

- [ ] **Step 1: Widen the "error pulses faster than waiting" window (failing)**

Replace the test at `test/render.test.ts:193-202`:

```ts
  test("error pulses faster than waiting", () => {
    const errorModel = sessionModel({ status: "error" });
    const waitingModel = sessionModel({ status: "waiting" });
    const phases = Array.from({ length: 17 }, (_, index) => index);
    const errorOpacities = phases.map((phase) => frameOpacity(errorModel, phase));
    const waitingOpacities = phases.map((phase) => frameOpacity(waitingModel, phase));
    // Error completes a full sine cycle within sixteen phases; waiting needs
    // thirty-two, so only error reaches its dim minimum inside this window.
    expect(Math.min(...errorOpacities)).toBeLessThan(Math.min(...waitingOpacities));
  });
```

- [ ] **Step 2: Run the render tests to verify the failure**

Run: `bun test test/render.test.ts`
Expected: FAIL on "error pulses faster than waiting" — with the old divisors both statuses reach opacity 0.2 within 16 phases, so `toBeLessThan` fails on equal minima.

- [ ] **Step 3: Halve the per-phase motion rates in `src/plugin/render.ts`**

Line 33:

```ts
const WORKING_SEGMENT_STEP = 17;
```

Waiting branch (lines 83-87) — comment and divisor:

```ts
    case "waiting": {
      // Thirty-two phases per cycle: a four-second breath at the 125 ms cadence.
      const opacity = 0.55 + 0.35 * Math.sin((phase * Math.PI) / 16);
      return `${frameOpen(color)} opacity="${opacity.toFixed(3)}"/>`;
    }
```

Error branch (lines 88-92) — comment and divisor:

```ts
    case "error": {
      // Sixteen phases per cycle: a two-second pulse, twice as fast as waiting.
      const opacity = 0.55 + 0.35 * Math.sin((phase * Math.PI) / 8);
      return `${frameOpen(color)} opacity="${opacity.toFixed(3)}"/>`;
    }
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS for both.

- [ ] **Step 5: Commit**

```bash
git add src/plugin/render.ts test/render.test.ts
git commit -m "plugin: halve per-phase motion rates to preserve animation tempos"
```

---

### Task 3: On-device verification (optional, ask first)

**Files:** none (deploy only)

**Interfaces:**
- Consumes: both committed tasks.
- Produces: visual confirmation on the physical Stream Deck.

This restarts the user's local plugin process — confirm with the user before running. Follow the AGENTS.md deploy loop exactly:

- [ ] **Step 1:** Bump `Version` in `com.drewritter.stream-deck-agents.sdPlugin/manifest.json` (patch bump).

- [ ] **Step 2:**

```bash
bun run build:plugin
cp com.drewritter.stream-deck-agents.sdPlugin/manifest.json \
  "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.drewritter.stream-deck-agents.sdPlugin/manifest.json"
cp com.drewritter.stream-deck-agents.sdPlugin/bin/plugin.js{,.map} \
  "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.drewritter.stream-deck-agents.sdPlugin/bin/"
bun node_modules/@elgato/cli/bin/streamdeck.mjs restart com.drewritter.stream-deck-agents
```

- [ ] **Step 3:** Eyeball a working tile: the blue segment should glide at 8 fps with the same 4 s lap; waiting/error breathing tempo unchanged.
