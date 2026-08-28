# Board Paging, Peek & Pips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make board paging touch-native and legible: the swipe becomes a board-scoped drag-follow that visibly commits or snaps back, the pages you are not on announce themselves (return sliver, next-page peek, pip column — all live-status), groups split so every page except the last is full, and the rail narrows 760 → 638 native px — all gated by an on-device pointer diagnostic that localizes the original swipe failure first.

**Architecture:** Four layers, pure-to-driver. The gesture recognizer (`app/src/gestures.ts`) gains per-stroke axis lock and emits a drag intent stream (`drag-start`/`drag-move`/`drag-end`/`drag-cancel`) instead of a release-time `swipe`; a new pure module `app/src/paging.ts` owns the commit-or-snap-back settle rule, rubber-band offsets, and the drag-session phases that gate snapshot deferral. The board reducer (`app/src/board.ts`) replaces group-atomic page breaks with fill-and-continue packing (`continuation` bit on `PlacedCard`); a new pure module `app/src/indicators.ts` derives sliver and pip view models from the packed pages (aggregates are the OR of the cards' existing view-model bits — no new state) and renders the three bands. The driver (`app/src/main.ts`) wires the drag onto a translating `#board-track` inside a clipping `#board-viewport`, mounting transient adjacent-page grids only for the drag's lifetime, so steady-state rendering, reconciliation, tickers, and pulses are untouched. All indicator geometry is fixed CSS tracks that exist on every page (constant geometry); content visibility rides `data-present`.

**Tech Stack:** TypeScript on Bun (`bun test`), no new dependencies. Strip webview is plain DOM (tests use `test/support/fake-dom`). Gates: `bun run typecheck` (root + app tsconfigs), biome, `bun run build:app`, and CI's `bun run check`.

**Working directory:** all commands run from the worktree root `/Users/drewritter/projects/dealerboard/.worktrees/board-paging-peek` (branch `wip/board-paging-peek`). Pre-commit hooks (lefthook) run `biome check --write` on staged files plus `bun run typecheck` — let them run; never bypass.

**Spec authority:** `docs/superpowers/specs/2026-08-27-board-paging-peek/spec.md` (ratified). Decisions log: `decisions.md` in the same directory. When in doubt, the spec wins over this plan.

**Sequencing:** Task 1 (the pointer diagnostic) is first and carries a hard decision gate: its on-strip receipt must confirm the pointer-move stream is usable before Tasks 4–10 proceed (Tasks 2–3, the packing work, are gesture-independent and may proceed while the receipt is pending). If move delivery is broken on the Xeneon, STOP and report to Drew — the spec says drag-follow degrades and the gesture design must be revisited; do not build Tasks 4–10 on a broken stream. Every gesture/settle constant is a named export tuned on device in Task 9, and threshold-dependent tests hold a **symbolic-constant contract**: displacements that exercise `COMMIT_FRACTION`/`DRAG_LOCK_MIN_PX` derive from those exports against the test's named board width, sample timings derive from `VELOCITY_WINDOW_MS`, and resistance assertions use `RUBBER_BAND_FACTOR` — a literal that encodes a tunable value is a plan defect. That contract, not hope, is what makes tuning unable to break the suite.

**Cross-spec note:** the sibling notebook `2026-08-27-board-card-retention` (status: ready, NOT ratified) touches dismiss gestures and board population. This plan bases on current main only. The axis-lock arbitration built here is the compatibility mechanism between the two specs (decisions.md 2026-08-27 21:41): the vertical dismiss flick's tests stay green unchanged through every task, and the axis-race tests pin that vertical-dominant strokes fall through to today's behavior.

## Global Constraints

Copied from the spec — every task implicitly obeys these:

- Fixed card geometry is inviolable: 886×102 native cards, 12px gaps, 6 rows; cards never flex-resize.
- No reserved vertical space: nothing informational above the 44px menu-bar clearance or below row six.
- Indicator vocabulary reuses the board's existing status hues (working #20b8ff, idle #4ade80, waiting/unread #ffb020, error #ff4d67) — no new colors, no text labels in the bands.
- The rail is outside the gesture system entirely — no handlers, no translation, no visual response to board drags.
- Page identity is the numeric index, clamped when repacking shrinks the page count; no per-page persistent state exists — "seen"/unread state lives per-session, exactly as today.
- Peek visibility is not viewing: a page's cards showing as slivers never clears unread; acknowledgment semantics are unchanged.
- WKWebView touch delivery on the Xeneon is unverified for sustained drags; the on-device pointer-event diagnostic (Task 1) gates gesture threshold tuning (Task 9).
- Non-goals honored: no vertical paging, no card-anatomy or liveness changes, no rail redesign beyond the width absorption, no keypad changes, no repacking beyond what splitting requires.

## Interpretations (implementation decisions resolved from spec + code)

1. **Split threshold = 0: a group that fits no single column always pours into the page's remaining slots.** The spec's open question offers a minimum-remaining-slots threshold but names the trade: any threshold above zero weakens the measurable invariant "every page except the last is full" by up to that many slots. The invariant is the requirement's stated acceptance, so zero is the only value that satisfies it exactly; the continuation marker plus the peek (the continuation is visibly pullable into view — decisions.md, reflow entry) answer the split-readability concern the threshold would have served.
2. **Continuation marker = an "↩ cont." pill** (the spec's stated default from the mockups), rendered in the card head directly after the chip, styled in the group-spine violet (`#a78bfa` family) so it reads as group identity, matching the sub-pill's construction. It appears on the first card a split group places on each page after its first — never at column breaks (spec edge case: column-break spine behavior is unchanged).
3. **Axis-lock constants (bring-up placeholders, tuned in Task 9):** `DRAG_LOCK_MIN_PX = 16`, dominance = strictly `|dx| > |dy|` (a diagonal tie locks vertical, so paging never steals the dismiss axis). A horizontal lock kills the stroke's hold outcomes structurally — the tick and context cases explicitly reject `dragging` strokes — so no ordering between `DRAG_LOCK_MIN_PX` and `MOVE_SLOP_PX` is load-bearing and Task 9 may tune either freely. Vertical dominance locks the stroke out of paging for its lifetime; its release classifies exactly as today (flick thresholds unchanged).
4. **Commit constants (bring-up placeholders, tuned in Task 9):** `COMMIT_FRACTION = 0.25` (the spec's ~25% of board width), `COMMIT_VELOCITY_PX_PER_MS = 0.6` measured over a trailing `VELOCITY_WINDOW_MS = 100` sample window, `RUBBER_BAND_FACTOR = 0.3`. A release with no samples inside the window (sparse WKWebView delivery) settles by distance alone (velocity 0) — the same robustness posture as today's release-position reclassification.
5. **The active gesture surface is `#pager`; the suppression boundary is `#paging-region`; the rail is a sibling outside both.** `#paging-region` wraps `#pager` and `#pips` but not `#rail`. The recognizer feed (pointerdown/move/up/cancel and the recognizer-routed contextmenu), `touch-action: none`, and `-webkit-touch-callout: none` live only on `#pager`. The region owns only stroke bookkeeping (`clickSuppression.beginStroke()`) and the capture-phase trailing-click swallow, so pip taps clear stale suppression without becoming paging drags and a captured board stroke's trailing click is swallowed even if the finger crossed the rail; no rail event traverses either listener. The `#pager` surface takes pointer capture at pointerdown, so a board stroke that wanders toward the rail or window edge keeps reporting to the surface until it ends; the rail still hosts no handlers and cannot receive a suppressed click. `#strip` hosts no gesture-system listener or touch-action. Window-leave snap-back rides `window` blur plus `lostpointercapture` → cancel; on the physical touchscreen a finger exiting the glass ends as up/cancel through the capture. The peek band is in-zone as the incoming page's own drag affordance ("the drag affordance is the same object as the indicator" — decisions.md); pips remain click-only secondary navigation. Before Task 7 creates the wrapper, `#board` is both the active surface and the suppression boundary, and `#strip` is already inert; Task 7 replaces those roles with `#pager` and `#paging-region`. The document-level contextmenu `preventDefault` stays global — it is native-menu (cursor-warp) suppression, not gesture routing.
6. **Sheet-open suppression is structural.** The action-sheet overlay is a fixed full-window element appended to `document.body`, outside `#paging-region`, so no pointer event during a sheet reaches the paging region — no paging gesture can begin (requirement satisfied by construction). The same-touch path is covered in the recognizer: a locked drag suppresses the platform hold verdict (`context`) and the long-press tick, pinned by tests.
7. **Drag rendering mounts transient adjacent grids on a translating track; the static board pipeline is untouched.** `#board` keeps its id, reconciliation, tickers, and pulse plumbing; adjacent pages are throwaway `renderBoard` outputs that live only for the drag. Adjacent pages sit at gutter-overlap spacing (`calc(100% − 1.5625vw)`), so the incoming page's first column rises exactly where the peek slivers sit — that is the "sliver grows into the real card" continuity. Both neighbors mount at drag-start (a finger can cross zero mid-drag). The ~18px→14px step where the outgoing page's edge hands off to the static return sliver at commit-settle is accepted; Task 9 polishes on glass if it reads badly.
8. **Snapshot deferral spans drag-start through settle-animation end** (`PagingSession.defersSnapshots()`, phase ≠ idle): the newest payload is stashed and applied once at settle, so the board, peek, and pips never repack under the finger. The stash-and-flush is itself a tested unit — `createDeferredLatest` in `paging.ts` (latest wins, applies exactly once, never while deferral holds) — and every ingest path in the driver routes through it, so the ordering contract is red-first tested, not driver folklore. Local re-reductions (the dismissal flick's settle re-applying board state) go through the latch's `resubmitLatest()` — which re-submits the newest payload ever submitted, applied or stashed — never through a driver-held copy of an older payload, so a stale local re-ingest can never overwrite a newer deferred snapshot. The settle order is fixed: `settled()` → commit jump to the settle's captured target → flush, so the deferred snapshot reduces against the page the user actually landed on. The 1s status/liveness tickers keep running — they mutate text and decay colors in place, which is not a repack, and the alternative (frozen timers mid-drag) would misreport time.
9. **Pip hit area = 54×56 native px** (the 22px band plus 16px invisible slop each side via overflow margins, 56px tall rows); the horizontal slop overlapping the peek band's edge is accepted — pips paint later in DOM order so they win the 16px strip, and the peek band remains a huge page-level target. **The return tap target is the whole 40px gutter** (the 14px sliver alone is below any touch size); the sliver is the visual inside it.
10. **`RailModel` loses `page`/`pageCount` and `RailActions` is deleted.** The spec deletes `.rail-pager` and `.page-dot`; nothing else in the rail consumes paging state, so carrying it would be dead weight in the render signature. `jumpToPage` survives in the driver, now fed by pips and bands.
11. **Test surface:** extend `test/strip-gestures.test.ts`, `test/strip-board.test.ts`, `test/strip-cards.test.ts`, `test/strip-rail.test.ts` where they already cover the surface; new files only where none exists — `test/strip-paging.test.ts`, `test/strip-indicators.test.ts`, and `test/strip-diagnostic.test.ts` (the last is bring-up instrumentation, removed with its module in Task 10 under the spec's "removable, no permanent logging" contract — an explicitly ratified removal, not a silent test deletion).
12. **Rail fit at 638px is verified on glass (Task 9), not in tests** — fake-dom cannot measure text. If the longest realistic quota note clips, the spec's named fallback is note abbreviation; that decision goes back to Drew rather than being made silently.
13. **The shared unread rule is one function.** `cardShowsUnread` (exported from `app/src/cards.ts`) is the single source of the per-card unread bit — `cardViewModel` and every indicator aggregate consume it, so "the unread bit each card itself renders (display-only cards contribute none)" cannot drift between surfaces.

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `app/src/diagnostic.ts` | Bring-up pointer diagnostic: per-layer counters + overlay summary (REMOVABLE) | 1 (create), 10 (delete) |
| `test/strip-diagnostic.test.ts` | Diagnostic summary tests (removed with the module) | 1 (create), 10 (delete) |
| `app/src/board.ts` | Packing: fill-and-continue, `continuation` bit on `PlacedCard` | 2 |
| `test/strip-board.test.ts` | Packing contract tests (invariant, kickoff scenario, markers) | 2 |
| `app/src/cards.ts` | Continuation-tag rendering; `cardShowsUnread` export | 3, 6 |
| `test/strip-cards.test.ts` | Card render tests | 3 |
| `app/src/paging.ts` | Pure drag decisions: offsets, settle rule, session phases | 4 (create) |
| `test/strip-paging.test.ts` | Paging decision tests | 4 (create) |
| `app/src/gestures.ts` | Axis lock, drag intent stream, velocity window | 5 |
| `test/strip-gestures.test.ts` | Recognizer tests (drag lock, axis race, fall-throughs) | 5 |
| `app/src/indicators.ts` | Sliver/pip view models + band renderers + render-skip signature | 6 (create) |
| `test/strip-indicators.test.ts` | Indicator model/renderer tests | 6 (create) |
| `app/src/rail.ts` | Pager removal; `RailModel` slims | 7 |
| `test/strip-rail.test.ts` | Rail tests (pager gone) | 7 |
| `app/index.html` | Strip shell: paging-region/pager/viewport/track/bands/pips/rail | 7 |
| `app/styles.css` | Gesture boundary (5), geometry (40px gutter, bands, pips, 638px rail), `.cont-tag`, track/adjacent, diag overlay | 1, 3, 5, 7, 8, 10 |
| `app/src/main.ts` | Driver: diagnostic wiring (1), drag pipeline + deferral (5), indicators + taps (7), drag visuals (8), diagnostic removal (10) | 1, 5, 7, 8, 10 |
| `docs/design.md` | Packing paragraph (2); strip layout/rail/interaction contract (7) | 2, 7 |
| `app/src/dismissals.ts`, `app/src/liveness.ts`, `app/src/press.ts`, `src/plugin/layout.ts` | Untouched (verified sufficient) | — |

---

### Task 1: Bring-up pointer diagnostic — which layer eats the swipe?

**Goal:** removable on-device instrumentation that localizes the reported swipe failure to exactly one of four layers — event delivery (raw pointer events reaching the paging surface), recognition (recognizer intents), navigation (page jumps), render (board re-renders) — with an on-strip verification receipt that gates the rest of the gesture work. The spec forbids permanent logging; this module and its test are deleted in Task 10.

**Files:**
- Create: `app/src/diagnostic.ts`
- Create: `test/strip-diagnostic.test.ts`
- Modify: `app/src/main.ts` (pointer handlers at lines 708–741, `feedPointer` at 703, `jumpToPage` at 126, `applyBoard` at 235, `start` at 381)
- Modify: `app/styles.css` (append the `#pointer-diag` block)

**Interfaces:**
- Consumes: `GestureIntent` from `app/src/gestures.ts` (read-only; formatted generically via `JSON.stringify` so the Task 5 intent redesign needs no diagnostic change).
- Produces: `POINTER_DIAGNOSTIC_ENABLED: boolean`, `createPointerDiagnostic(now: () => number): PointerDiagnostic` with `recordPointer(kind, coalesced)`, `recordIntents(intents)`, `recordNavigation(from, to)`, `recordRender()`, `summary(): string[]` (four lines, one per layer), and `mountPointerDiagnostic(parent, diagnostic)` — consumed by `main.ts` wiring and deleted together in Task 10.

- [ ] **Step 1: Write the failing tests**

Create `test/strip-diagnostic.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createPointerDiagnostic } from "../app/src/diagnostic";

describe("createPointerDiagnostic", () => {
  test("attributes each layer separately: delivery counts, recognition, navigation, render", () => {
    const diag = createPointerDiagnostic(() => 1000);
    diag.recordPointer("down", 1);
    diag.recordPointer("move", 3);
    diag.recordPointer("up", 1);
    diag.recordIntents([{ kind: "swipe", direction: "next" }, { kind: "suppress-click" }]);
    diag.recordNavigation(0, 1);
    diag.recordRender();
    const lines = diag.summary();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("d1 m1 u1");
    expect(lines[0]).toContain("x3");
    // The WHOLE batch is visible: today's swipe emits swipe + suppress-click
    // in one feed, and showing only the tail would misreport recognition.
    expect(lines[1]).toContain('"swipe"');
    expect(lines[1]).toContain('"suppress-click"');
    expect(lines[2]).toContain("0→1");
    expect(lines[3]).toContain("1");
  });

  test("an empty feed is not a recognition event: the last real batch stays visible", () => {
    const diag = createPointerDiagnostic(() => 0);
    diag.recordIntents([{ kind: "swipe", direction: "next" }, { kind: "suppress-click" }]);
    diag.recordIntents([]);
    expect(diag.summary()[1]).toContain('"swipe"');
  });

  test("the move rate window forgets samples older than a second", () => {
    let now = 0;
    const diag = createPointerDiagnostic(() => now);
    for (let i = 0; i < 30; i += 1) {
      now += 10;
      diag.recordPointer("move", 1);
    }
    expect(diag.summary()[0]).toContain("30/s");
    now += 2000;
    diag.recordPointer("move", 1);
    expect(diag.summary()[0]).toContain("1/s");
  });

  test("a silent recognizer is visible: moves counted, no intents", () => {
    const diag = createPointerDiagnostic(() => 0);
    diag.recordPointer("move", 2);
    expect(diag.summary()[1]).toContain("none");
  });
});
```

- [ ] **Step 2: Run tests to verify the red phase**

Run: `bun test test/strip-diagnostic.test.ts`
Expected: FAIL — `app/src/diagnostic.ts` does not exist.

- [ ] **Step 3: Implement the diagnostic module**

Create `app/src/diagnostic.ts`:

```ts
/**
 * Bring-up pointer diagnostic — REMOVABLE (spec: on-device diagnostic during
 * bring-up, no permanent logging; deleted after threshold tuning). Localizes
 * a failed swipe to one of four layers, each on its own summary line:
 * delivery (raw pointer events reaching the paging-facing handlers, with a 1s move
 * rate and the last coalesced-batch size), recognition (intents the
 * recognizer emitted), navigation (page jumps), render (board re-renders).
 * Pure counters here; main.ts feeds records and mounts the overlay.
 */

import type { GestureIntent } from "./gestures";

export const POINTER_DIAGNOSTIC_ENABLED = true;

export type PointerDiagnostic = {
  recordPointer: (kind: "down" | "move" | "up" | "cancel" | "context", coalesced: number) => void;
  recordIntents: (intents: readonly GestureIntent[]) => void;
  recordNavigation: (from: number, to: number) => void;
  recordRender: () => void;
  /** Four lines, one per layer: delivery / recognition / navigation / render. */
  summary: () => string[];
};

export const createPointerDiagnostic = (now: () => number): PointerDiagnostic => {
  const counts = { down: 0, move: 0, up: 0, cancel: 0, context: 0 };
  let moveStamps: number[] = [];
  let lastCoalesced = 0;
  let intentCount = 0;
  let lastIntents = "none";
  let navigationCount = 0;
  let lastNavigation = "none";
  let renderCount = 0;
  return {
    recordPointer: (kind, coalesced) => {
      counts[kind] += 1;
      if (kind === "move") {
        lastCoalesced = coalesced;
        const at = now();
        moveStamps = [...moveStamps.filter((stamp) => at - stamp <= 1000), at];
      }
    },
    recordIntents: (intents) => {
      if (intents.length === 0) {
        return; // an empty feed is not a recognition event; keep the last real batch visible
      }
      intentCount += intents.length;
      // The whole batch, not its tail: a swipe is swipe + suppress-click.
      lastIntents = intents.map((intent) => JSON.stringify(intent)).join(" ");
    },
    recordNavigation: (from, to) => {
      navigationCount += 1;
      lastNavigation = `${from}→${to}`;
    },
    recordRender: () => {
      renderCount += 1;
    },
    summary: () => [
      `delivery d${counts.down} m${counts.move} u${counts.up} c${counts.cancel} ctx${counts.context} | ${moveStamps.length}/s x${lastCoalesced}`,
      `recognize ${intentCount} | ${lastIntents}`,
      `navigate ${navigationCount} | ${lastNavigation}`,
      `render ${renderCount}`,
    ],
  };
};

/** The on-glass readout: a corner overlay refreshed at 250ms, never interactive. */
export const mountPointerDiagnostic = (parent: HTMLElement, diagnostic: PointerDiagnostic): void => {
  const overlay = document.createElement("div");
  overlay.id = "pointer-diag";
  parent.append(overlay);
  setInterval(() => {
    const text = diagnostic.summary().join("\n");
    if (overlay.textContent !== text) {
      overlay.textContent = text;
    }
  }, 250);
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/strip-diagnostic.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the driver and the overlay style**

In `app/src/main.ts`:

**(a)** Add the import and the instance beside the other module-level gesture state (after the `gestures`/`clickSuppression` block at line 93):

```ts
import { createPointerDiagnostic, mountPointerDiagnostic, POINTER_DIAGNOSTIC_ENABLED } from "./diagnostic";
```

```ts
// Bring-up pointer diagnostic (removed with app/src/diagnostic.ts).
const diagnostic = POINTER_DIAGNOSTIC_ENABLED ? createPointerDiagnostic(Date.now) : null;
```

**(b)** Delivery layer — first line of each paging-surface pointer handler's body after its `isPrimary` guard, and in the contextmenu handler:

```ts
  diagnostic?.recordPointer("down", 1);      // onSurfacePointerDown
  diagnostic?.recordPointer("move", event.getCoalescedEvents?.().length ?? 0); // onSurfacePointerMove
  diagnostic?.recordPointer("up", 1);        // onSurfacePointerUp
  diagnostic?.recordPointer("cancel", 1);    // onSurfacePointerCancel
  diagnostic?.recordPointer("context", 1);   // onSurfaceContextMenu
```

**(c)** Recognition layer — restructure `feedPointer` so the intents pass through the recorder:

```ts
const feedPointer = (input: GestureInput): void => {
  const intents = gestures.feed(input);
  diagnostic?.recordIntents(intents);
  handleGestureIntents(intents);
  scheduleLongPressTimer();
};
```

**(d)** Navigation layer — in `jumpToPage`, capture the page before the jump and record after:

```ts
const jumpToPage = (page: number): void => {
  if (currentView === null) {
    return;
  }
  const from = currentPage;
  // jumpBoard reports a page change as dirty, so applyBoard persists it and
  // later ingests (which reduce from the persisted settings) keep the page.
  applyBoard(jumpBoard(currentView, loadStoredSettings(), page));
  diagnostic?.recordNavigation(from, currentPage);
  // renderRailNow is declared below; referenced here at click time.
  renderRailNow();
};
```

**(e)** Render layer — inside `applyBoard`'s `if (root !== null && signature !== renderedSignature)` block, first line:

```ts
    diagnostic?.recordRender();
```

**(f)** Mount — in `start`, after `wireInteraction()`:

```ts
  if (diagnostic !== null) {
    mountPointerDiagnostic(document.body, diagnostic);
  }
```

In `app/styles.css`, append:

```css
/* Bring-up pointer diagnostic overlay (removable with app/src/diagnostic.ts). */
#pointer-diag {
  position: fixed;
  top: 6.5vh;
  right: 26%;
  z-index: 20;
  padding: 0.5vh 0.4vw;
  background: rgb(0 0 0 / 0.55);
  color: #4ade80;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 0.7vw;
  white-space: pre;
  pointer-events: none;
}
```

- [ ] **Step 6: Full gates**

Run: `bun test && bun run typecheck && bun run build:app && bunx biome check app/src/diagnostic.ts app/src/main.ts app/styles.css test/strip-diagnostic.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/diagnostic.ts test/strip-diagnostic.test.ts app/src/main.ts app/styles.css
git commit -m "feat(app): add removable bring-up pointer diagnostic overlay"
```

- [ ] **Step 8: On-strip verification — REQUIRED, and a decision gate**

This step needs Drew at the physical strip. Install the real artifacts (`bun run check`, then `bun run install:app`, then `open -a Dealerboard`) and, with at least two pages of sessions on the board, perform on glass: single taps, a touch-and-hold, vertical dismiss flicks, and several sustained horizontal drags of varying speed. Read the overlay after each and record, per gesture, one line per layer:

1. **Delivery:** do sustained drags produce a continuous move stream (`m` count climbing, a steady `/s` rate — tens per second, not single digits — and coalesced batches `x≥1`)? Does the stream survive the whole drag, or die mid-gesture (counts freeze while the finger still moves)? Do holds arrive as `ctx` (the known macOS synthesis) — and, critically, do *moving* touches ever get converted to `ctx`/`cancel` mid-drag?
2. **Recognition:** on a drag release, does today's recognizer emit its `swipe` + `suppress-click` batch (both visible on the recognize line — the overlay shows the whole last non-empty batch), or nothing?
3. **Navigation:** when `swipe` fires, does `navigate` advance (`0→1`)?
4. **Render:** does `render` tick after navigation?

Record the receipt (pass/fail + one-line observation per layer) in the execution report. **Decision gate:** the failing layer localizes the original bug and the delivery verdict gates the plan — if the move stream is fundamentally broken for sustained drags (frozen counts, touch converted away mid-gesture), STOP after Tasks 2–3 and report to Drew with the receipt: the spec says drag-follow degrades and the gesture design must be revisited. A usable stream (even a sparse one — the velocity window degrades gracefully) clears Tasks 4–10. If the strip hardware is unavailable, say so explicitly, leave the receipt incomplete, and pause Tasks 4–10 — do not mark this step done.

No commit for this step.

---

### Task 2: Packing — groups fill and continue

**Goal:** replace group-atomic page breaks with the ratified fill-and-continue contract: first-fit for groups that fit a single column is unchanged, but a group that fits no column pours into the current page's remaining slots in column order and continues across pages, its first card on each later page carrying a `continuation` bit. Measurable invariant: every page except the last is full. The kickoff scenario (five singles + a nine-card group) leaves no empty column.

**Files:**
- Modify: `app/src/board.ts` (module docstring lines 1–6, `PlacedCard` at 190–198, `packBoard` at 216–268)
- Modify: `test/strip-board.test.ts` (packBoard describe, lines 242–292)
- Modify: `test/strip-cards.test.ts` (the `placed()` fixture at 48–67 — `PlacedCard` gains a required field, so typecheck forces this here)
- Modify: `test/strip-tile-identity.test.ts` (the `placedCard()` fixture at 49–61 — the suite's other complete `PlacedCard` literal)
- Modify: `docs/design.md` (the packing sentence in "Strip layout", line 83)

**Interfaces:**
- Consumes: `BoardGroup`/`withSpines`/`MutablePage` (unchanged).
- Produces: `PlacedCard` gains `continuation: boolean` (`/** First continued card of a split group on this page (page-break marker). */`). Task 3 renders it; Task 6's fixtures construct it. `cardContentSignature` picks it up automatically (it spreads the card), so a marker flip re-renders the card with no further change.

- [ ] **Step 1: Write the failing tests**

In `test/strip-board.test.ts`, add to the imports `BOARD_COLUMNS, BOARD_ROWS` from `../app/src/board`. Inside `describe("packBoard", …)`, REPLACE these four tests — their premises are the old atomic contract this task removes: `"a group that fits no column starts the next page (4+4+4 → pages of 8 and 4)"`, `"a 7-12 group needs an empty page: wraps col 0 into col 1, else opens the next page"`, `"a >12 group fills whole pages from a fresh page and continues across the seam"`, and `"backfill never crosses back to an earlier page"` — with:

```ts
  const sequence = (...sizes: number[]): BoardGroup[] => sizes.map((size, index) => groupOf(index * 100 + 1, size));

  test("a group that fits no single column pours into the page's remaining slots", () => {
    const pages = packBoard([groupOf(1, 4), groupOf(11, 4), groupOf(21, 4)], false);
    expect(pages).toHaveLength(1);
    expect(cell(pages[0]!, "s21")).toEqual([0, 4]);
    expect(cell(pages[0]!, "s22")).toEqual([0, 5]);
    expect(cell(pages[0]!, "s23")).toEqual([1, 4]);
    expect(cell(pages[0]!, "s24")).toEqual([1, 5]);
    // A column break within a page carries no marker — page breaks only.
    expect(pages[0]!.cards.every((card) => !card.continuation)).toBe(true);
  });

  test("a 7-12 group no longer demands an empty page: it fills the current one and continues", () => {
    const pages = packBoard([groupOf(90, 1), groupOf(1, 8)], false);
    expect(pages).toHaveLength(1);
    expect(cell(pages[0]!, "s1")).toEqual([0, 1]);
    expect(cell(pages[0]!, "s6")).toEqual([1, 0]);
    expect(cell(pages[0]!, "s8")).toEqual([1, 2]);
  });

  test("a >12 group spans as many pages as it needs, marker on each continued page", () => {
    const pages = packBoard([groupOf(90, 1), groupOf(1, 26)], false);
    expect(pages).toHaveLength(3);
    expect(pages[0]!.cards).toHaveLength(12);
    expect(pages[1]!.cards).toHaveLength(12);
    const markers = pages.map((page) => page.cards.filter((card) => card.continuation).map((c) => c.session.sessionId));
    expect(markers).toEqual([[], ["s12"], ["s24"]]);
  });

  test("a later small group backfills the last page's gaps, never an earlier page", () => {
    // 14-group: page 1 full, page 2 holds two cards; the 2-group backfills page 2.
    const pages = packBoard([groupOf(1, 14), groupOf(101, 2)], false);
    expect(pages).toHaveLength(2);
    expect(cell(pages[1]!, "s101")).toEqual([0, 2]);
  });

  test("the kickoff scenario fills page 1: five singles + a nine-card group leave no empty column", () => {
    const singles = Array.from({ length: 5 }, (_, index) => groupOf(index * 10 + 61, 1));
    const pages = packBoard([...singles, groupOf(1, 9)], false);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.cards).toHaveLength(12);
    expect(cell(pages[0]!, "s1")).toEqual([0, 5]); // the group's first card takes the last col-0 slot
    expect(cell(pages[0]!, "s2")).toEqual([1, 0]);
    expect(pages[1]!.cards.map((card) => [card.session.sessionId, card.continuation])).toEqual([
      ["s8", true],
      ["s9", false],
    ]);
    expect(pages[0]!.cards.every((card) => !card.continuation)).toBe(true);
  });

  test("fill-and-continue is sequence-general: every page except the last is full", () => {
    for (const sizes of [[6, 7], [4, 9], [1, 12], [14, 14], [5, 9, 4, 8]]) {
      const pages = packBoard(sequence(...sizes), false);
      for (const page of pages.slice(0, -1)) {
        expect(page.cards).toHaveLength(BOARD_COLUMNS * BOARD_ROWS);
      }
    }
  });

  test("a split whose parent lands in the page's last slot marks the next page's first sub", () => {
    const singles = Array.from({ length: 11 }, (_, index) => groupOf(200 + index * 10, 1));
    const pages = packBoard([...singles, groupOf(1, 3)], false);
    expect(cell(pages[0]!, "s1")).toEqual([1, 5]);
    // The marker carries the group identity onto the next page: the first
    // continued card is a grouped sub (indent + spine as today).
    expect(pages[1]!.cards.map((card) => [card.session.sessionId, card.continuation, card.subagent])).toEqual([
      ["s2", true, true],
      ["s3", false, true],
    ]);
  });
```

The tests `"small groups first-fit columns top-down and backfill same-page gaps"` and `"grouped subs get indent + spine (mid/end); primaries and orphans get none"` stay verbatim — they pin the unchanged first-fit and spine semantics.

In `test/strip-cards.test.ts`, add `continuation: false,` to the `placed()` fixture object (between `spine: "none",` and `column: 0,`), and in `test/strip-tile-identity.test.ts` add the same `continuation: false,` line to the `placedCard()` fixture (between `spine: "none",` and `column: 0,`) — both files construct complete `PlacedCard` literals and typecheck fails without the new required field.

- [ ] **Step 2: Run tests to verify the red phase**

Run: `bun test test/strip-board.test.ts`
Expected, exactly:
- FAIL: the pours test (old code opens a second page for the third 4-group), the 7-12 test (old code demands the empty columns, 2 pages), the >12-marker test (old whole-page-from-fresh split yields 4 pages and no `continuation` field), the kickoff test (the 9-group lands whole on page 2, stranding page 1 part-empty), the invariant loop (the [6,7]/[1,12]/… sequences leave part-filled pages), and the last-slot test (old code never splits the 3-group).
- PASS pre-change and must STAY PASS: the backfill test — both old and new packing place a later small group on the last page's gaps; it pins that fill-and-continue does not regress backfill — and the two kept tests (`"small groups first-fit…"`, `"grouped subs get indent + spine…"`).

TypeScript-level failures (the missing `continuation` field in fixtures) surface in step 4's typecheck, not here — bun test does not typecheck.

- [ ] **Step 3: Implement fill-and-continue**

In `app/src/board.ts`:

**(a)** `PlacedCard` gains the marker field:

```ts
export type PlacedCard = BoardCardSeed & {
  degraded: boolean;
  indent: boolean;
  spine: SpineSegment;
  /** First continued card of a split group on this page (page-break marker). */
  continuation: boolean;
  /** 0-based column within the page. */
  column: number;
  /** 0-based row within the column. */
  row: number;
};
```

**(b)** Replace `packBoard` (keep `MutablePage` as is):

```ts
/**
 * First-fit with fill-and-continue (spec "General packing contract"): a group
 * that fits a single column takes the first column with room on the current
 * page (later groups may backfill an earlier gap on that page, never an
 * earlier page — every earlier page is full by construction); any other group
 * pours into the page's remaining slots in column order and continues across
 * pages, its first card on each later page carrying the continuation marker.
 * A new page only opens once the current one is completely full, so every
 * page except the last is full.
 */
export const packBoard = (groups: readonly BoardGroup[], degraded: boolean): BoardPage[] => {
  const pages: MutablePage[] = [];
  const openPage = (): MutablePage => {
    const page: MutablePage = { used: Array.from({ length: BOARD_COLUMNS }, () => 0), cards: [] };
    pages.push(page);
    return page;
  };
  const current = (): MutablePage => pages[pages.length - 1] ?? openPage();
  const place = (page: MutablePage, column: number, seed: SpinedSeed, continuation: boolean): void => {
    page.cards.push({ ...seed, degraded, continuation, column, row: page.used[column] ?? 0 });
    page.used[column] = (page.used[column] ?? 0) + 1;
  };

  for (const group of groups) {
    const seeds = withSpines(group);
    if (seeds.length === 0) {
      continue;
    }
    let page = current();
    const fit = page.used.findIndex((used) => used + seeds.length <= BOARD_ROWS);
    if (fit !== -1) {
      for (const seed of seeds) {
        place(page, fit, seed, false);
      }
      continue;
    }
    let placedAny = false;
    let column = 0;
    for (const seed of seeds) {
      while ((page.used[column] ?? 0) >= BOARD_ROWS) {
        column += 1;
        if (column >= BOARD_COLUMNS) {
          page = openPage();
          column = 0;
        }
      }
      // A fresh page reached mid-group is a page break: its first card
      // carries the marker. A group that merely STARTS on a fresh page
      // (placedAny still false) is not continued from anywhere.
      place(page, column, seed, placedAny && page.cards.length === 0);
      placedAny = true;
    }
  }
  return pages.map((page) => ({ cards: page.cards }));
};
```

**(c)** Update the module docstring (line 4): replace `group-atomic page packing` with `fill-and-continue page packing (every page except the last is full)`.

- [ ] **Step 4: Run tests and gates**

Run: `bun test test/strip-board.test.ts test/strip-cards.test.ts test/strip-tile-identity.test.ts && bun test`
Expected: PASS — including the untouched `groupedAgentOrder` tests that call `packBoard` (their groups fit single columns) and the reduceBoard boundary test (13 sessions still make 2 pages: twelve singles fill page 1, the thirteenth opens page 2).
Then: `bun run typecheck && bunx biome check app/src/board.ts test/strip-board.test.ts test/strip-cards.test.ts test/strip-tile-identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Update docs/design.md**

Replace the sentence at line 83 (`Primary groups sort by logical slot. … larger groups fill full pages.`) — keep the first two sentences of the paragraph, replace the packing sentence:

```
Groups that fit a single column never split; any other group fills the
current page's remaining slots and continues across pages, its first card
on each continued page carrying a continuation marker, so every page
except the last is full.
```

- [ ] **Step 6: Commit**

```bash
git add app/src/board.ts test/strip-board.test.ts test/strip-cards.test.ts test/strip-tile-identity.test.ts docs/design.md
git commit -m "feat(app): groups fill and continue across pages instead of page-breaking"
```

---

### Task 3: The continuation marker on the card

**Goal:** a split group's first continued card renders the "↩ cont." tag in its head, after the chip — the mockup's default form, in the group-spine violet.

**Files:**
- Modify: `app/src/cards.ts` (`CardViewModel` at 41–70, `cardViewModel` at 82–118, `cardElement` head assembly at 151–171)
- Modify: `app/styles.css` (append `.cont-tag` beside the `.sub-pill` block at 388–408)
- Test: `test/strip-cards.test.ts`

**Interfaces:**
- Consumes: `PlacedCard.continuation` from Task 2.
- Produces: `CardViewModel.continuation: boolean`; the `.cont-tag` DOM element (textContent `"↩ cont."`). No band or routing surface touches this — it is card anatomy only.

- [ ] **Step 1: Write the failing tests**

In `test/strip-cards.test.ts`, inside `describe("cardViewModel", …)`:

```ts
  test("carries the continuation marker through the view model", () => {
    expect(cardViewModel(placed({ continuation: true }), NOW_MS).continuation).toBe(true);
    expect(cardViewModel(placed(), NOW_MS).continuation).toBe(false);
  });
```

And with the render tests (beside the origin-ring tests that use `renderBoard`):

```ts
  test("a continued card renders the ↩ cont. tag after the chip; ordinary cards do not", () => {
    withFakeDocument((root) => {
      renderBoard(root as unknown as HTMLElement, { cards: [placed({ continuation: true })] }, false);
      const head = descendants(root).find((node) => hasClass(node, "card-head"));
      expect(head?.children.map((node) => node.className.split(" ")[0])).toEqual(["chip", "cont-tag", "card-title"]);
      const tag = descendants(root).find((node) => hasClass(node, "cont-tag"));
      expect(tag?.textContent).toBe("↩ cont.");
    });
    withFakeDocument((root) => {
      renderBoard(root as unknown as HTMLElement, { cards: [placed()] }, false);
      expect(descendants(root).some((node) => hasClass(node, "cont-tag"))).toBe(false);
    });
  });
```

- [ ] **Step 2: Run tests to verify the red phase**

Run: `bun test test/strip-cards.test.ts`
Expected: both FAIL — `CardViewModel` has no `continuation` (view model test reads `undefined`), and no `.cont-tag` node renders.

- [ ] **Step 3: Implement**

In `app/src/cards.ts`:

**(a)** `CardViewModel` gains, after `spine: SpineSegment;`:

```ts
  /** First continued card of a split group on this page — renders the ↩ cont. tag. */
  continuation: boolean;
```

**(b)** `cardViewModel`'s returned object gains, after `spine: card.spine,`:

```ts
    continuation: card.continuation,
```

**(c)** In `cardElement`, directly after the chip block (after the `if (model.unread) { … }` closing brace, before the sub-pill comment):

```ts
  // The page-break marker: this card continues a group split from the page
  // behind — spine-violet, so it reads as group identity, not status.
  if (model.continuation) {
    appendText(head, "cont-tag", "↩ cont.");
  }
```

In `app/styles.css`, after the `.sub-pill::before` block:

```css
/* The split-group continuation marker ("↩ cont."): the first card a group
   places on a continued page says where it came from, in the spine violet. */
.cont-tag {
  flex: none;
  padding: 0.417vh 0.391vw; /* 3px 10px native */
  border: max(1px, 0.0586vw) solid rgb(167 139 250 / 0.45); /* 1.5px native */
  border-radius: 0.313vw; /* 8px native */
  color: #a78bfa;
  font-size: 0.781vw; /* 20px native */
  white-space: nowrap;
}
```

- [ ] **Step 4: Run tests and gates**

Run: `bun test test/strip-cards.test.ts && bun test && bun run typecheck && bunx biome check app/src/cards.ts app/styles.css test/strip-cards.test.ts`
Expected: PASS (the content-signature reconciliation tests keep passing — `continuation` rides the existing spread).

- [ ] **Step 5: Commit**

```bash
git add app/src/cards.ts app/styles.css test/strip-cards.test.ts
git commit -m "feat(app): render the continuation marker on split-group page breaks"
```

---

### Task 4: Paging decisions — rubber-band offsets, the settle rule, the single-flight session, the deferral latch

**Goal:** a pure, DOM-free module owning every drag decision: the display offset (1:1 toward a real page, rubber-banded where none exists, clamped to one page of travel), the commit-or-snap-back settle rule (distance fraction OR direction-matched velocity fling, never toward a nonexistent page — a commit carries its captured origin and target pages, so a later repack cannot retarget it), the single-flight drag-session machine (a settling board refuses new drags, stray releases are nobody's to animate, navigation is gated while a gesture or settle owns the board, non-idle phases defer snapshots), and the latest-wins deferral latch the driver routes every snapshot ingest through. This is the controller layer the review demanded red-first coverage for — the DOM glue in Tasks 5/8 only animates verdicts minted here.

**Files:**
- Create: `app/src/paging.ts`
- Create: `test/strip-paging.test.ts`

**Interfaces:**
- Consumes: nothing from the app (pure).
- Produces (Task 5 wires these; Task 8 animates from them): `COMMIT_FRACTION`, `COMMIT_VELOCITY_PX_PER_MS`, `RUBBER_BAND_FACTOR`; `type PageDirection = "previous" | "next"`; `type DragBounds = { page: number; pageCount: number; boardWidth: number }` (the 0-based page under the finger at drag start); `type DragSettle = { kind: "commit"; direction: PageDirection; from: number; target: number } | { kind: "snap-back" }`; `dragOffset(dx, bounds): number`; `settleDrag(dx, velocity, bounds): DragSettle`; `createPagingSession(): PagingSession` with `phase(): "idle" | "dragging" | "settling"`, `defersSnapshots(): boolean`, `allowsNavigation(): boolean` (false while a gesture or settle owns the board — the driver gates `jumpToPage` on it), `start(bounds): boolean` (refused unless idle), `move(dx): number | null` (null unless dragging — a refused stroke must not touch the track), `release(dx, velocity): DragSettle | null` and `cancel(): DragSettle | null` (null unless a live drag exists — the driver animates only non-null verdicts, which makes settling single-flight by construction), `settled()`; and `createDeferredLatest<T>(shouldDefer, apply)` with `submit(value)` / `flush()` / `resubmitLatest()` (re-submits the newest value ever submitted, applied or stashed — the driver's local re-reduction path, e.g. the dismissal flick's settle; a no-op before any submit) — the latch `main.ts` routes every ingest through.

- [ ] **Step 1: Write the failing tests**

Create `test/strip-paging.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  COMMIT_FRACTION,
  COMMIT_VELOCITY_PX_PER_MS,
  createDeferredLatest,
  createPagingSession,
  type DragBounds,
  dragOffset,
  RUBBER_BAND_FACTOR,
  settleDrag,
} from "../app/src/paging";

const BOARD_WIDTH = 1000;

const bounds = (overrides: Partial<DragBounds> = {}): DragBounds => ({
  page: 1,
  pageCount: 3,
  boardWidth: BOARD_WIDTH,
  ...overrides,
});

// Symbolic-constant contract (see the plan header): displacements derive from
// COMMIT_FRACTION against the named test board so Task 9 tuning cannot break
// the suite. BELOW is also the fling test's below-distance displacement.
const PAST = BOARD_WIDTH * COMMIT_FRACTION + 60; // commits by distance at any tuning
const BELOW = (BOARD_WIDTH * COMMIT_FRACTION) / 2; // never commits by distance

describe("dragOffset", () => {
  test("tracks the finger 1:1 toward an existing page", () => {
    expect(dragOffset(-320, bounds())).toBe(-320);
    expect(dragOffset(240, bounds())).toBe(240);
  });

  test("rubber-bands where no page exists — the give itself says nowhere to go", () => {
    expect(dragOffset(-320, bounds({ page: 2 }))).toBe(-320 * RUBBER_BAND_FACTOR);
    expect(dragOffset(240, bounds({ page: 0 }))).toBe(240 * RUBBER_BAND_FACTOR);
    // Resistance is per-direction: page 0 still pulls next freely.
    expect(dragOffset(-320, bounds({ page: 0 }))).toBe(-320);
    // A single page resists both ways.
    expect(dragOffset(-320, bounds({ page: 0, pageCount: 1 }))).toBe(-320 * RUBBER_BAND_FACTOR);
  });

  test("clamps to one page of travel", () => {
    expect(dragOffset(-BOARD_WIDTH * 1.4, bounds())).toBe(-BOARD_WIDTH);
    expect(dragOffset(BOARD_WIDTH * 1.4, bounds())).toBe(BOARD_WIDTH);
  });
});

describe("settleDrag", () => {
  test("commits past the distance threshold, carrying its origin and target pages", () => {
    expect(settleDrag(-COMMIT_FRACTION * BOARD_WIDTH, 0, bounds())).toEqual({
      kind: "commit",
      direction: "next",
      from: 1,
      target: 2,
    });
    expect(settleDrag(COMMIT_FRACTION * BOARD_WIDTH, 0, bounds())).toEqual({
      kind: "commit",
      direction: "previous",
      from: 1,
      target: 0,
    });
  });

  test("snaps back below the threshold without a fling", () => {
    expect(settleDrag(-COMMIT_FRACTION * BOARD_WIDTH + 1, 0, bounds())).toEqual({ kind: "snap-back" });
  });

  test("a direction-matched fling commits below the distance threshold", () => {
    expect(settleDrag(-BELOW, -COMMIT_VELOCITY_PX_PER_MS, bounds())).toMatchObject({ kind: "commit", direction: "next" });
    expect(settleDrag(BELOW, COMMIT_VELOCITY_PX_PER_MS, bounds())).toMatchObject({
      kind: "commit",
      direction: "previous",
    });
  });

  test("a fling opposing the displacement does not commit", () => {
    expect(settleDrag(-BELOW, COMMIT_VELOCITY_PX_PER_MS * 2, bounds())).toEqual({ kind: "snap-back" });
  });

  test("never commits toward a page that does not exist, however hard the fling", () => {
    expect(settleDrag(-2 * PAST, -9, bounds({ page: 2 }))).toEqual({ kind: "snap-back" });
    expect(settleDrag(2 * PAST, 9, bounds({ page: 0 }))).toEqual({ kind: "snap-back" });
  });

  test("a zero-displacement release snaps back", () => {
    expect(settleDrag(0, -9, bounds())).toEqual({ kind: "snap-back" });
  });
});

describe("createPagingSession", () => {
  test("phases gate snapshot deferral: idle applies, dragging and settling defer", () => {
    const session = createPagingSession();
    expect(session.phase()).toBe("idle");
    expect(session.defersSnapshots()).toBe(false);
    expect(session.start(bounds())).toBe(true);
    expect(session.phase()).toBe("dragging");
    expect(session.defersSnapshots()).toBe(true);
    expect(session.release(-PAST, 0)).toEqual({ kind: "commit", direction: "next", from: 1, target: 2 });
    expect(session.phase()).toBe("settling");
    expect(session.defersSnapshots()).toBe(true);
    session.settled();
    expect(session.phase()).toBe("idle");
    expect(session.defersSnapshots()).toBe(false);
  });

  test("settle re-entry: a settling board is not grabbable, and stray verdicts are nobody's", () => {
    const session = createPagingSession();
    expect(session.release(-BELOW, 0)).toBeNull(); // no drag ever started
    expect(session.start(bounds({ page: 0 }))).toBe(true);
    expect(session.release(-PAST, 0)).toEqual({ kind: "commit", direction: "next", from: 0, target: 1 });
    expect(session.start(bounds({ page: 0 }))).toBe(false); // refused mid-settle
    expect(session.phase()).toBe("settling");
    expect(session.release(-BELOW, 0)).toBeNull(); // the refused stroke settles nothing
    expect(session.cancel()).toBeNull(); // and cannot cancel the live settle either
    session.settled();
    expect(session.start(bounds({ page: 1 }))).toBe(true);
  });

  test("navigation is gated while a gesture or settle owns the board", () => {
    const session = createPagingSession();
    expect(session.allowsNavigation()).toBe(true);
    session.start(bounds());
    expect(session.allowsNavigation()).toBe(false);
    session.release(-PAST, 0);
    expect(session.allowsNavigation()).toBe(false);
    session.settled();
    expect(session.allowsNavigation()).toBe(true);
  });

  test("move answers offsets only while dragging — a refused stroke must not touch the track", () => {
    const session = createPagingSession();
    expect(session.move(-BELOW)).toBeNull();
    session.start(bounds({ page: 2 }));
    expect(session.move(-BELOW)).toBe(-BELOW * RUBBER_BAND_FACTOR);
    session.release(-BELOW, 0);
    expect(session.move(-BELOW)).toBeNull();
  });

  test("cancel settles a live drag as snap-back", () => {
    const session = createPagingSession();
    session.start(bounds());
    expect(session.cancel()).toEqual({ kind: "snap-back" });
    expect(session.phase()).toBe("settling");
  });
});

describe("createDeferredLatest", () => {
  test("defers during a gesture and applies the newest exactly once at settle", () => {
    const session = createPagingSession();
    const applied: number[] = [];
    const deferral = createDeferredLatest<number>(session.defersSnapshots, (value) => applied.push(value));
    deferral.submit(1); // idle: applies immediately
    session.start(bounds());
    deferral.submit(2);
    deferral.submit(3); // latest wins
    session.release(-PAST, 0);
    deferral.flush(); // still settling: nothing applies
    expect(applied).toEqual([1]);
    session.settled();
    deferral.flush();
    expect(applied).toEqual([1, 3]);
    deferral.flush(); // exactly once
    expect(applied).toEqual([1, 3]);
  });

  test("a direct apply supersedes any stale stash", () => {
    const session = createPagingSession();
    const applied: number[] = [];
    const deferral = createDeferredLatest<number>(session.defersSnapshots, (value) => applied.push(value));
    session.start(bounds());
    deferral.submit(2);
    session.release(-PAST, 0);
    session.settled();
    deferral.submit(4); // idle again: applies directly and drops the stashed 2
    deferral.flush();
    expect(applied).toEqual([4]);
  });

  test("a local re-submission never resurrects an older payload over a deferred one", () => {
    // The dismissal-flick composition the review flagged: A applied, a drag
    // defers B, the flick's settle re-reduces locally — it must re-submit the
    // NEWEST payload (B), not a driver-held copy of A.
    const session = createPagingSession();
    const applied: number[] = [];
    const deferral = createDeferredLatest<number>(session.defersSnapshots, (value) => applied.push(value));
    deferral.submit(1); // A: idle, applies
    session.start(bounds());
    deferral.submit(2); // B: deferred
    deferral.resubmitLatest(); // the flick settles mid-drag: latest is B, stash stays B
    session.release(-PAST, 0);
    session.settled();
    deferral.flush();
    expect(applied).toEqual([1, 2]); // B once — A never came back
  });

  test("resubmitLatest with no deferral re-applies the newest immediately; before any submit it is a no-op", () => {
    const session = createPagingSession();
    const applied: number[] = [];
    const deferral = createDeferredLatest<number>(session.defersSnapshots, (value) => applied.push(value));
    deferral.resubmitLatest(); // nothing ever submitted
    expect(applied).toEqual([]);
    deferral.submit(7);
    deferral.resubmitLatest(); // idle: the local re-reduction applies now
    expect(applied).toEqual([7, 7]);
  });
});
```

- [ ] **Step 2: Run tests to verify the red phase**

Run: `bun test test/strip-paging.test.ts`
Expected: FAIL — `app/src/paging.ts` does not exist.

- [ ] **Step 3: Implement the module**

Create `app/src/paging.ts`:

```ts
/**
 * Pure drag-follow paging decisions for the strip board: rubber-banded
 * display offsets, the commit-or-snap-back settle rule (a commit carries its
 * captured origin and target pages), the single-flight drag-session phases
 * the driver keys rendering, navigation gating, and snapshot deferral off,
 * and the latest-wins deferral latch itself. No DOM, no timers — main.ts
 * feeds recognizer intents and animation completion in and animates only
 * the non-null verdicts minted here.
 */

export type PageDirection = "previous" | "next";

/** Bring-up placeholders — Task 9 tunes all three on the physical strip. */
export const COMMIT_FRACTION = 0.25;
export const COMMIT_VELOCITY_PX_PER_MS = 0.6;
export const RUBBER_BAND_FACTOR = 0.3;

export type DragBounds = {
  /** 0-based page under the finger at drag start. */
  page: number;
  pageCount: number;
  /** The board viewport's width in CSS px — the commit fraction's base. */
  boardWidth: number;
};

export const dragDirection = (dx: number): PageDirection => (dx < 0 ? "next" : "previous");

const pageExists = (bounds: DragBounds, direction: PageDirection): boolean =>
  direction === "next" ? bounds.page < bounds.pageCount - 1 : bounds.page > 0;

/** 1:1 toward an existing page; rubber-banded where none exists; clamped to one page of travel. */
export const dragOffset = (dx: number, bounds: DragBounds): number => {
  const offset = pageExists(bounds, dragDirection(dx)) ? dx : dx * RUBBER_BAND_FACTOR;
  return Math.max(-bounds.boardWidth, Math.min(bounds.boardWidth, offset));
};

export type DragSettle =
  | { kind: "commit"; direction: PageDirection; from: number; target: number }
  | { kind: "snap-back" };

export const settleDrag = (dx: number, velocity: number, bounds: DragBounds): DragSettle => {
  if (dx === 0) {
    return { kind: "snap-back" };
  }
  const direction = dragDirection(dx);
  if (!pageExists(bounds, direction)) {
    return { kind: "snap-back" };
  }
  const past = Math.abs(dx) >= bounds.boardWidth * COMMIT_FRACTION;
  const flung = Math.sign(velocity) === Math.sign(dx) && Math.abs(velocity) >= COMMIT_VELOCITY_PX_PER_MS;
  return past || flung
    ? { kind: "commit", direction, from: bounds.page, target: bounds.page + (direction === "next" ? 1 : -1) }
    : { kind: "snap-back" };
};

export type PagingPhase = "idle" | "dragging" | "settling";

export type PagingSession = {
  phase: () => PagingPhase;
  /** Snapshots defer while a gesture or its settle animation owns the board. */
  defersSnapshots: () => boolean;
  /** Pip/band navigation is gated while a gesture or settle owns the board. */
  allowsNavigation: () => boolean;
  /** Begin a drag; refused (false) unless idle — a settling board is not grabbable. */
  start: (bounds: DragBounds) => boolean;
  /** Display offset while dragging; null otherwise — a refused stroke must not touch the track. */
  move: (dx: number) => number | null;
  /** The settle verdict for this session's live drag; null when none exists (stray release). */
  release: (dx: number, velocity: number) => DragSettle | null;
  /** Pointer cancellation or leaving the window: snap-back for a live drag, null otherwise. */
  cancel: () => DragSettle | null;
  /** The settle animation finished: back to rest. */
  settled: () => void;
};

export const createPagingSession = (): PagingSession => {
  let phase: PagingPhase = "idle";
  let bounds: DragBounds = { page: 0, pageCount: 1, boardWidth: 0 };
  return {
    phase: () => phase,
    defersSnapshots: () => phase !== "idle",
    allowsNavigation: () => phase === "idle",
    start: (next) => {
      if (phase !== "idle") {
        return false;
      }
      phase = "dragging";
      bounds = next;
      return true;
    },
    move: (dx) => (phase === "dragging" ? dragOffset(dx, bounds) : null),
    release: (dx, velocity) => {
      if (phase !== "dragging") {
        return null;
      }
      phase = "settling";
      return settleDrag(dx, velocity, bounds);
    },
    cancel: () => {
      if (phase !== "dragging") {
        return null;
      }
      phase = "settling";
      return { kind: "snap-back" };
    },
    settled: () => {
      phase = "idle";
    },
  };
};

/**
 * Latest-wins deferral: while shouldDefer() holds, submitted values stash
 * (newest replaces older); flush() applies the pending value exactly once,
 * and only after deferral has lifted. A direct apply supersedes any stash.
 * resubmitLatest() re-submits the newest value ever submitted — applied or
 * stashed — so a local re-reduction (the dismissal flick's settle) can never
 * resurrect an older payload over a newer deferred one.
 */
export const createDeferredLatest = <T>(
  shouldDefer: () => boolean,
  apply: (value: T) => void,
): { submit: (value: T) => void; flush: () => void; resubmitLatest: () => void } => {
  let pending: { value: T } | null = null;
  let latest: { value: T } | null = null;
  const submit = (value: T): void => {
    latest = { value };
    if (shouldDefer()) {
      pending = { value };
      return;
    }
    pending = null;
    apply(value);
  };
  return {
    submit,
    flush: () => {
      if (pending !== null && !shouldDefer()) {
        const { value } = pending;
        pending = null;
        apply(value);
      }
    },
    resubmitLatest: () => {
      if (latest !== null) {
        submit(latest.value);
      }
    },
  };
};
```

- [ ] **Step 4: Run tests and gates**

Run: `bun test test/strip-paging.test.ts && bun run typecheck && bunx biome check app/src/paging.ts test/strip-paging.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/paging.ts test/strip-paging.test.ts
git commit -m "feat(app): paging decisions - offsets, settle rule, single-flight session, deferral latch"
```

---

### Task 5: Recognizer axis lock and the drag intent stream; the driver rewires paging

**Goal:** the recognizer classifies by axis lock during the stroke instead of at release: horizontal dominance past a small threshold starts a paging drag (streamed `drag-move` dx, `drag-end` with a trailing-window velocity, `drag-cancel` on cancellation), and once locked, tap, long-press, and vertical outcomes are suppressed for that touch; vertical-dominant strokes fall through to today's behavior unchanged. Every `drag-end` is preceded by a `drag-start` within its stroke — a sample-starved stroke that locks only at release emits both in one batch, so the driver's session always has bounds before it settles. The old release-time `swipe` intent and its constants are deleted. The recognizer-feeding handlers move onto `#pager` with pointer capture; `#paging-region` owns only suppression bookkeeping and trailing-click swallowing, and the rail is outside both (spec constraint; Interpretation 5). The driver feeds the single-flight paging session, routes every ingest through the deferral latch, and (interim, until Task 8's visuals) applies commits as instant jumps to the settle's own captured target.

**Files:**
- Modify: `app/src/gestures.ts` (module docstring 1–8, `GestureIntent`/constants 20–31, `Stroke`/recognizer 33–127; `GestureInput` is unchanged)
- Modify: `app/src/main.ts` (imports; module state near line 93; `ingest` at 313; `onSwipe`/`handleGestureIntents` at 648–684; the pointer handlers at 708–741; `jumpToPage` at 126; `wireInteraction` at 783)
- Modify: `app/styles.css` (move the temporary `touch-action`/callout boundary from `#strip` to `#board`; Task 7 moves it again to `#pager`)
- Test: `test/strip-gestures.test.ts`
- Test: `test/strip-paging.test.ts` (the recognizer-to-session integration test)
- Test: `test/strip-diagnostic.test.ts` (intent-batch fixture swap — the `swipe` literal dies with the union member)

**Interfaces:**
- Consumes: `createPagingSession`/`createDeferredLatest`/`DragBounds` from Task 4.
- Produces: `GestureInput` is unchanged — the paging zone is enforced by where the handlers live (Interpretation 5), never by a flag. `GestureIntent` gains `{ kind: "drag-start" }`, `{ kind: "drag-move"; dx }`, `{ kind: "drag-end"; dx; velocity }` (velocity in px/ms, signed like dx), `{ kind: "drag-cancel" }`; `{ kind: "swipe" }` is deleted, as are `SWIPE_MIN_HORIZONTAL_PX`/`SWIPE_MAX_VERTICAL_PX`. New constants `DRAG_LOCK_MIN_PX = 16`, `VELOCITY_WINDOW_MS = 100`. Intent-stream contract Task 8 also relies on: `drag-start` always precedes `drag-end` within a stroke. Tests derive positions, times, and expected velocities from the exported constants — never from literals that assume them — so Task 9 tuning cannot break the suite.

- [ ] **Step 1: Write the failing tests (and update the broken premises)**

In `test/strip-gestures.test.ts`:

**(a)** Update the imports — swap `SWIPE_MIN_HORIZONTAL_PX` for `DRAG_LOCK_MIN_PX` and `VELOCITY_WINDOW_MS` (the `down`/`move`/`up`/`tick`/`context` helpers stay exactly as they are — `GestureInput` is unchanged):

```ts
import {
  createClickSuppression,
  createGestureRecognizer,
  DRAG_LOCK_MIN_PX,
  FLICK_MIN_VERTICAL_PX,
  type GestureInput,
  LONG_PRESS_MS,
  MOVE_SLOP_PX,
  swallowSuppressedClick,
  VELOCITY_WINDOW_MS,
} from "../app/src/gestures";
```

**(b)** REPLACE the whole `describe("swipe classification", …)` block with:

```ts
describe("drag axis lock", () => {
  // A locked drag for tests that need one: displacement derived from the
  // exported constant, so Task 9 tuning can never un-lock it.
  const lockX = 400 - DRAG_LOCK_MIN_PX - 24;

  test("horizontal dominance past the lock threshold starts a drag and streams dx", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    expect(recognizer.feed(move(400 - DRAG_LOCK_MIN_PX - 4, 302, 40))).toEqual([
      { kind: "drag-start" },
      { kind: "drag-move", dx: -(DRAG_LOCK_MIN_PX + 4) },
    ]);
    expect(recognizer.feed(move(300, 305, 80))).toEqual([{ kind: "drag-move", dx: -100 }]);
  });

  test("a locked drag's release is a drag-end with a trailing-window velocity, click suppressed", () => {
    // Sample geometry derives from VELOCITY_WINDOW_MS: one sample lands just
    // outside the window (never the anchor), one at half a window before the
    // release (always the anchor) — the expectation holds for any tuning.
    const recognizer = createGestureRecognizer();
    const release = VELOCITY_WINDOW_MS * 10;
    const outside = release - VELOCITY_WINDOW_MS - 10;
    const inside = release - VELOCITY_WINDOW_MS / 2;
    const anchorX = lockX - 60;
    const releaseX = anchorX - 100;
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(lockX, 300, outside));
    recognizer.feed(move(anchorX, 300, inside));
    expect(recognizer.feed(up(releaseX, 300, release))).toEqual([
      { kind: "drag-end", dx: releaseX - 400, velocity: (releaseX - anchorX) / (release - inside) },
      { kind: "suppress-click" },
    ]);
  });

  test("release-position fallback: a sample-free horizontal release is a full drag batch", () => {
    // Pointermove delivery is not guaranteed (coalesced or dropped): the
    // final position alone must still produce a drag — drag-start FIRST (so
    // the driver's session has bounds), then drag-move carrying the release
    // displacement (so even this path paints a visible offset before the
    // settle returns — a failed swipe is never a silent no-op), then the
    // distance-decided end (no samples inside the window means velocity 0;
    // the release instant sits beyond any tuned window).
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    expect(recognizer.feed(up(400 - DRAG_LOCK_MIN_PX - 10, 302, VELOCITY_WINDOW_MS * 2))).toEqual([
      { kind: "drag-start" },
      { kind: "drag-move", dx: -(DRAG_LOCK_MIN_PX + 10) },
      { kind: "drag-end", dx: -(DRAG_LOCK_MIN_PX + 10), velocity: 0 },
      { kind: "suppress-click" },
    ]);
  });

  test("vertical wins the axis race and blocks a later horizontal lock; the release still flicks", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(402, 300 + DRAG_LOCK_MIN_PX + 4, 40));
    expect(recognizer.feed(move(430, 370, 100))).toEqual([]);
    expect(recognizer.feed(up(430, 370, 160))).toEqual([
      { kind: "flick", direction: "down" },
      { kind: "suppress-click" },
    ]);
  });

  test("a diagonal tie locks vertical: paging never steals the dismiss axis", () => {
    const recognizer = createGestureRecognizer();
    const tie = DRAG_LOCK_MIN_PX + 4;
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(400 + tie, 300 + tie, 40));
    expect(recognizer.feed(move(300, 300 + tie, 80))).toEqual([]);
    expect(recognizer.feed(up(280, 300 + tie, 120))).toEqual([{ kind: "suppress-click" }]);
  });

  test("a jitter below the lock threshold never drags", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(400 + DRAG_LOCK_MIN_PX - 2, 305, 150));
    expect(recognizer.feed(up(400 + DRAG_LOCK_MIN_PX - 2, 305, 200))).toEqual([{ kind: "suppress-click" }]);
  });

  test("once locked, the platform hold verdict and the deadline tick are dead for the stroke", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(lockX, 300, 40));
    expect(recognizer.feed(context(lockX, 300, 50))).toEqual([]);
    expect(recognizer.feed(tick(LONG_PRESS_MS))).toEqual([]);
    expect(recognizer.feed(up(lockX, 300, LONG_PRESS_MS + 40))[0]?.kind).toBe("drag-end");
  });

  test("cancel mid-drag emits drag-cancel; cancel without a lock stays silent", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(lockX, 300, 40));
    expect(recognizer.feed({ kind: "cancel", now: 80 })).toEqual([{ kind: "drag-cancel" }]);
    recognizer.feed(down(400, 300, 200));
    expect(recognizer.feed({ kind: "cancel", now: 240 })).toEqual([]);
  });

  test("a drag returning to its origin still ends as a drag — visible snap-back, not a tap", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(lockX, 300, 40));
    recognizer.feed(move(398, 300, 90));
    const intents = recognizer.feed(up(400, 300, 130));
    expect(intents[0]).toMatchObject({ kind: "drag-end", dx: 0 });
    expect(intents[1]).toEqual({ kind: "suppress-click" });
    expect(intents).toHaveLength(2);
  });

  test("a stroke that long-pressed never becomes a drag", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(tick(LONG_PRESS_MS));
    recognizer.feed(move(100, 300, LONG_PRESS_MS + 100));
    expect(recognizer.feed(up(100, 300, LONG_PRESS_MS + 200))).toEqual([{ kind: "suppress-click" }]);
  });
});
```

**(c)** Three existing tests use *horizontal* movement to exercise slop/suppression and would now lock a drag — retarget them to the vertical axis (same behavior under test, axis chosen to stay out of the paging lock):

- `"moving past the slop kills the long-press and the release suppresses the click"`: change the move to `move(100, 100 + MOVE_SLOP_PX + 10, 200)` and the release to `up(100, 122, 300)`.
- `"a release past the slop suppresses the click even without a move sample"`: change the release to `up(100, 100 + MOVE_SLOP_PX + 10, 300)`.
- `"a moved stroke's suppression does not bleed into the next clean tap"`: change the move to `move(100, 140, 200)` and the release to `up(100, 140, 300)`.
- In the context describe, `"a context signal overrides the slop: a wiggled stroke still long-presses"`: change the move to `move(100, 100 + MOVE_SLOP_PX + 10, 50)` (a vertical wiggle — the override still applies to non-drag strokes; the drag case is pinned above).

The flick describe and the remaining long-press/context/suppression tests stay verbatim — they pin the fall-through the spec requires. (There is no "rail stroke" recognizer test: the zone is structural — rail strokes never reach the recognizer at all (Step 4) — and its acceptance is Task 9's on-glass check.)

**(d)** The recognizer-to-session integration test — in `test/strip-paging.test.ts` (created in Task 4), add the recognizer import and a new describe. It pins the end-to-end contract the review demanded: a sample-starved horizontal release still pages, because `drag-start` gives the session bounds before `drag-end` asks for the verdict:

```ts
import { createGestureRecognizer, VELOCITY_WINDOW_MS } from "../app/src/gestures";
```

```ts
describe("recognizer to session", () => {
  // A tiny mirror of the driver's intent loop: start feeds bounds, moves
  // become track offsets, the end asks for the verdict. Displacements derive
  // from COMMIT_FRACTION (symbolic-constant contract).
  const runStroke = (releaseDx: number): { offsets: number[]; settle: DragSettle | null } => {
    const recognizer = createGestureRecognizer();
    const session = createPagingSession();
    const offsets: number[] = [];
    let settle: DragSettle | null = null;
    recognizer.feed({ kind: "down", point: { x: 400, y: 300 }, now: 0 });
    for (const intent of recognizer.feed({
      kind: "up",
      point: { x: 400 + releaseDx, y: 300 },
      now: VELOCITY_WINDOW_MS * 2,
    })) {
      if (intent.kind === "drag-start") {
        session.start({ page: 0, pageCount: 2, boardWidth: BOARD_WIDTH });
      }
      if (intent.kind === "drag-move") {
        const offset = session.move(intent.dx);
        if (offset !== null) {
          offsets.push(offset);
        }
      }
      if (intent.kind === "drag-end") {
        settle = session.release(intent.dx, intent.velocity);
      }
    }
    return { offsets, settle };
  };

  test("a sample-free horizontal release still pages: drag-start precedes drag-end", () => {
    const { settle } = runStroke(-PAST);
    expect(settle).toEqual({ kind: "commit", direction: "next", from: 0, target: 1 });
  });

  test("a sample-free below-commit release is a visible failed swipe: nonzero offset, then snap-back", () => {
    const { offsets, settle } = runStroke(-BELOW);
    expect(offsets).toEqual([-BELOW]); // the track moved before the settle returned
    expect(settle).toEqual({ kind: "snap-back" });
  });
});
```

(add `type DragSettle` to the file's `../app/src/paging` import).

**(e)** The diagnostic test's intent fixture — `GestureIntent` loses `swipe`, so in `test/strip-diagnostic.test.ts` replace both `{ kind: "swipe", direction: "next" }` literals with `{ kind: "drag-end", dx: -200, velocity: 0 }` and every `toContain('"swipe"')` with `toContain('"drag-end"')`. (Runtime behavior is identical before and after — this swap exists for `bun run typecheck`, which does check test files.)

- [ ] **Step 2: Run tests to verify the red phase**

Run: `bun test test/strip-gestures.test.ts test/strip-paging.test.ts`
Expected: every test in `"drag axis lock"` FAILS (no `DRAG_LOCK_MIN_PX`/`VELOCITY_WINDOW_MS` exports — the import itself errors; after stub exports, the drag intents don't exist), and the new `"recognizer to session"` integration test FAILS (today's recognizer emits `swipe`, never `drag-start`/`drag-end`, so `settle` stays null). The retargeted tests, the diagnostic fixture swap, and all kept tests must pass once the implementation lands; they are listed here so the executor updates them in the same change.

- [ ] **Step 3: Implement the recognizer**

In `app/src/gestures.ts`:

**(a)** Docstring (lines 1–8): replace `emitting intents. Tap routing stays with the existing click handler; the recognizer only decides when a stroke was something else (long-press or swipe) and when the trailing click must be swallowed.` with `emitting intents. Tap routing stays with the existing click handler; the recognizer decides when a stroke locks into a paging drag (streaming drag intents), when it was something else (long-press or flick), and when the trailing click must be swallowed.`

**(b)** Types and constants (`GestureInput` and `GesturePoint` stay exactly as they are — the paging zone is the caller's handler placement, not recognizer state):

```ts
export type GestureIntent =
  | { readonly kind: "longpress"; readonly point: GesturePoint }
  | { readonly kind: "drag-start" }
  | { readonly kind: "drag-move"; readonly dx: number }
  | { readonly kind: "drag-end"; readonly dx: number; readonly velocity: number }
  | { readonly kind: "drag-cancel" }
  | { readonly kind: "flick"; readonly direction: "up" | "down" }
  | { readonly kind: "suppress-click" };

export const LONG_PRESS_MS = 500;
export const MOVE_SLOP_PX = 12;
/** Axis-lock threshold. Freely tunable: the lock itself kills the stroke's
 *  hold outcomes (the tick and context cases reject dragging strokes), so no
 *  ordering with MOVE_SLOP_PX is load-bearing. Tuned on device. */
export const DRAG_LOCK_MIN_PX = 16;
/** Trailing sample window for the release velocity. Tuned on device. */
export const VELOCITY_WINDOW_MS = 100;
export const FLICK_MIN_VERTICAL_PX = 56;
export const FLICK_MAX_HORIZONTAL_PX = 48;
```

**(c)** Stroke state and helpers (replacing the `Stroke` type):

```ts
type Sample = { readonly x: number; readonly now: number };

type Stroke = {
  readonly start: GesturePoint;
  readonly deadline: number;
  moved: boolean;
  longPressed: boolean;
  /** Horizontal axis lock: the stroke is a paging drag until it ends. */
  dragging: boolean;
  /** Vertical won the axis race: this touch can never become a paging drag. */
  verticalLocked: boolean;
  samples: Sample[];
};

const pushSample = (stroke: Stroke, x: number, now: number): void => {
  stroke.samples.push({ x, now });
  while (stroke.samples.length > 0 && now - (stroke.samples[0]?.now ?? now) > VELOCITY_WINDOW_MS) {
    stroke.samples.shift();
  }
};

/** px/ms over the trailing window; 0 with no earlier sample there (sparse delivery settles by distance alone). */
const releaseVelocity = (samples: readonly Sample[], x: number, now: number): number => {
  const anchor = samples.find((sample) => now - sample.now <= VELOCITY_WINDOW_MS);
  if (anchor === undefined || now === anchor.now) {
    return 0;
  }
  return (x - anchor.x) / (now - anchor.now);
};
```

**(d)** The `feed` cases (a locked stroke's hold deadline is dead by explicit check — the tick case rejects `dragging` — never by an assumed `DRAG_LOCK_MIN_PX`/`MOVE_SLOP_PX` ordering, so tuning either constant cannot resurrect a mid-drag long-press):

```ts
      case "down": {
        if (stroke !== null) {
          return []; // a second finger's down is ignored mid-stroke
        }
        stroke = {
          start: input.point,
          deadline: input.now + LONG_PRESS_MS,
          moved: false,
          longPressed: false,
          dragging: false,
          verticalLocked: false,
          samples: [{ x: input.point.x, now: input.now }],
        };
        return [];
      }
      case "move": {
        if (stroke === null || stroke.longPressed) {
          return [];
        }
        const dx = input.point.x - stroke.start.x;
        const dy = input.point.y - stroke.start.y;
        if (Math.hypot(dx, dy) > MOVE_SLOP_PX) {
          stroke.moved = true;
        }
        pushSample(stroke, input.point.x, input.now);
        if (
          !stroke.dragging &&
          !stroke.verticalLocked &&
          Math.max(Math.abs(dx), Math.abs(dy)) >= DRAG_LOCK_MIN_PX
        ) {
          // The axis race: whichever displacement dominates first owns the
          // touch. A tie goes vertical — paging never steals the dismiss axis.
          if (Math.abs(dx) > Math.abs(dy)) {
            stroke.dragging = true;
            return [{ kind: "drag-start" }, { kind: "drag-move", dx }];
          }
          stroke.verticalLocked = true;
        }
        return stroke.dragging ? [{ kind: "drag-move", dx }] : [];
      }
      case "tick": {
        if (
          stroke !== null &&
          !stroke.moved &&
          !stroke.longPressed &&
          !stroke.dragging && // a locked drag's hold deadline is dead at any tuning
          input.now >= stroke.deadline
        ) {
          stroke.longPressed = true;
          return [{ kind: "longpress", point: stroke.start }];
        }
        return [];
      }
      case "up": {
        if (stroke === null) {
          return [];
        }
        const finished = stroke;
        stroke = null;
        if (finished.longPressed) {
          return [{ kind: "suppress-click" }];
        }
        const dx = input.point.x - finished.start.x;
        const dy = input.point.y - finished.start.y;
        // Recompute from the release position: pointermove delivery is not
        // guaranteed (samples can be coalesced or dropped), so the final
        // position alone must still lock a drag or dirty a tap.
        const moved = finished.moved || Math.hypot(dx, dy) > MOVE_SLOP_PX;
        const horizontal =
          finished.dragging ||
          (!finished.verticalLocked && Math.abs(dx) >= DRAG_LOCK_MIN_PX && Math.abs(dx) > Math.abs(dy));
        if (horizontal) {
          const end = {
            kind: "drag-end" as const,
            dx,
            velocity: releaseVelocity(finished.samples, input.point.x, input.now),
          };
          // A sample-starved stroke may lock only here: the driver learns of
          // the drag, its displacement, and its settle in one batch —
          // drag-start always precedes drag-end within a stroke (the session
          // has bounds), and the interposed drag-move carries the release
          // displacement so even this path paints a visible offset before
          // the settle returns.
          return finished.dragging
            ? [end, { kind: "suppress-click" }]
            : [{ kind: "drag-start" }, { kind: "drag-move", dx }, end, { kind: "suppress-click" }];
        }
        // Vertical is the dismiss axis: horizontal is taken by paging, so a
        // vertical-dominant release flicks the pressed card away instead.
        if (Math.abs(dy) >= FLICK_MIN_VERTICAL_PX && Math.abs(dx) <= FLICK_MAX_HORIZONTAL_PX) {
          return [{ kind: "flick", direction: dy < 0 ? "up" : "down" }, { kind: "suppress-click" }];
        }
        return moved ? [{ kind: "suppress-click" }] : [];
      }
      case "cancel": {
        const wasDragging = stroke?.dragging === true;
        stroke = null;
        return wasDragging ? [{ kind: "drag-cancel" }] : [];
      }
      case "context": {
        if (stroke === null) {
          return [{ kind: "longpress", point: input.point }];
        }
        // Once the touch locked into a drag, the platform's hold verdict is
        // dead for it — locked drags suppress tap and long-press outcomes.
        if (stroke.longPressed || stroke.dragging) {
          return [];
        }
        stroke.longPressed = true;
        return [{ kind: "longpress", point: stroke.start }];
      }
```

The `context` case's existing comment block above it stays; delete `SWIPE_MIN_HORIZONTAL_PX`, `SWIPE_MAX_VERTICAL_PX`, and the old swipe branch.

- [ ] **Step 4: Rewire the driver**

In `app/src/main.ts`:

**(a)** Imports: add `createDeferredLatest, createPagingSession` from `./paging`; the gestures import list is unchanged (the `swipe` intent was a type member, not an import).

**(b)** Module state, beside `const gestures = createGestureRecognizer();`:

```ts
const pagingSession = createPagingSession();
// Every snapshot ingest routes through this latch: mid-gesture payloads
// stash (latest wins) and apply once at settle. ingestNow is defined below;
// the closure only runs at call time.
const snapshotDeferral = createDeferredLatest<SnapshotPayload | null>(
  () => pagingSession.defersSnapshots(),
  (payload) => ingestNow(payload),
);
```

**(c)** Snapshot deferral — rename the existing `ingest` function to `ingestNow` (preserve its `lastPayload = payload` assignment as the last-applied payload) and add the latch wrapper in its old place, so the source-snapshot call sites (`ingestPush`, `readAndIngest`) stay untouched:

```ts
/** All snapshot application goes through the deferral latch: nothing
 *  repacks or re-renders the board, peek, or pips mid-gesture; the newest
 *  payload applies at settle. */
const ingest = (payload: SnapshotPayload | null): void => {
  snapshotDeferral.submit(payload);
};
```

`createDeferredLatest.submit` records its latest submitted value before it checks `shouldDefer`. Therefore a source push B remains the authoritative latest value even while `ingestNow` has not applied it and `lastPayload` still names applied payload A; `resubmitLatest()` can re-reduce B without pretending that local dismissal is a new source snapshot.

One call site DOES change: `flickAway`'s settle closure re-reduces the board after a local dismissal, and today it does that by re-ingesting the driver's own `lastPayload` copy. Mid-drag that copy is stale — a newer payload may be sitting deferred in the latch, and re-submitting the old one would overwrite it (the review's concrete failure: A applied → drag defers B → flick settles A over B). The settle closure becomes:

```ts
  const settle = (): void => {
    dismissals.dismiss(provider, sessionId, Date.now());
    // Local re-reduction through the latch's own latest — never a driver-held
    // copy, which can be older than a deferred payload.
    snapshotDeferral.resubmitLatest();
  };
```

(`lastPayload` keeps its other duties as the last-applied payload; `resubmitLatest` is pinned red-first by the Task 4 latch tests, including the exact A/B overwrite sequence.)

**(d)** The rail leaves the gesture system: the recognizer-feeding handlers move from `#strip` to `#pager`, which captures the pointer so a board stroke that wanders toward the rail or the window edge keeps reporting until it ends. Rename `onStripPointerDown/Move/Up/Cancel` and `onStripContextMenu` to `onSurfacePointerDown/Move/Up/Cancel` and `onSurfaceContextMenu` — the move/up/cancel/context bodies are unchanged (diagnostic lines included); the down handler becomes:

```ts
const onSurfacePointerDown = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  diagnostic?.recordPointer("down", 1);
  pendingPress = cardFromPointerEvent(event);
  // Capture the pointer: the stroke's continuation belongs to this surface
  // even when the finger crosses the rail — which itself hosts no handlers.
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  feedPointer({ kind: "down", point: { x: event.clientX, y: event.clientY }, now: Date.now() });
};
```

(the `clickSuppression.beginStroke()` line moves OUT of this handler, into the paging-region bookkeeping listener below). Add the region-level stroke hygiene and the window-leave cancel:

```ts
/**
 * Stroke bookkeeping on the pager+pips wrapper: suppression belongs to one
 * stroke, and a touch drag fires no trailing click at all — any unconsumed
 * suppression from the last stroke dies at the next stroke's birth, wherever
 * it lands inside the paging region (a pip tap must never be eaten by a stale
 * arm). This listener feeds no recognizer, and the wrapper excludes the rail.
 */
const onGestureRegionStrokeBookkeeping = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  clickSuppression.beginStroke();
};

/** Leaving the window mid-gesture snaps back; with no live stroke the feed is a no-op. */
const onWindowBlur = (): void => {
  feedPointer({ kind: "cancel", now: Date.now() });
  pendingPress = null;
};
```

**(e)** `wireInteraction` becomes:

```ts
const onGestureRegionClickCapture = (event: MouseEvent): void => {
  swallowSuppressedClick(clickSuppression, event);
};

const wireInteraction = (): void => {
  document.querySelector<HTMLElement>("#board")?.addEventListener("click", onBoardClick);
  // Before Task 7's shell exists, #board is both surfaces. It is already a
  // sibling of #rail, so the rail never traverses either listener.
  const region = document.querySelector<HTMLElement>("#board");
  region?.addEventListener("pointerdown", onGestureRegionStrokeBookkeeping, true);
  region?.addEventListener("click", onGestureRegionClickCapture, true);
  // The paging surface owns every recognizer-feeding handler; Task 7 retargets
  // this selector to #pager while keeping the rail outside the boundary.
  const surface = region;
  surface?.addEventListener("pointerdown", onSurfacePointerDown);
  surface?.addEventListener("pointermove", onSurfacePointerMove);
  surface?.addEventListener("pointerup", onSurfacePointerUp);
  surface?.addEventListener("pointercancel", onSurfacePointerCancel);
  // Losing the capture (element teardown, capture theft) cancels the stroke.
  surface?.addEventListener("lostpointercapture", onSurfacePointerCancel);
  surface?.addEventListener("contextmenu", onSurfaceContextMenu);
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      dismissActionSheet();
    }
  });
};
```

In `app/styles.css`, move `touch-action: none` and `-webkit-touch-callout: none` off `#strip` and onto `#board` for this interim shell; Task 7 moves them to `#pager` when the peek band becomes part of the active surface.

(`lostpointercapture` also fires after every ordinary `pointerup` — the recognizer's stroke is already closed then, so the extra cancel feed is a no-op, pinned by the recognizer's cancel-without-lock test. The sheet-open case needs no wiring: the fixed overlay lives outside `#paging-region` (and outside the interim `#board` boundary), so no pointer event during a sheet reaches these handlers at all. Strokes that BEGIN on the rail never enter either boundary listener; strokes that begin on a pip after Task 7 enter only the region bookkeeping and never the recognizer — the zone is structural.)

**(f)** Replace `onSwipe` (delete it) with the width helper, gate `jumpToPage`, and replace the `case "swipe"` with the four drag cases. The driver acts only on non-null session verdicts — a stroke whose `start` was refused (mid-settle) settles nothing:

```ts
/** The commit fraction's base. Task 7 retargets this to #board-viewport. */
const boardRegionWidth = (): number => document.querySelector<HTMLElement>("#board")?.clientWidth ?? 0;
```

`jumpToPage` gains the navigation gate as its first guard (pip/band taps must not fight a live gesture or settle animation; `finishSettle`'s own commit jump in Task 8 runs after `settled()`, so it passes):

```ts
  if (currentView === null || !pagingSession.allowsNavigation()) {
    return;
  }
```

```ts
      case "drag-start":
        pagingSession.start({
          page: currentPage,
          pageCount: currentPageCount,
          boardWidth: boardRegionWidth(),
        });
        break;
      case "drag-move":
        pagingSession.move(intent.dx); // the offset drives the track from Task 8
        break;
      case "drag-end": {
        const settle = pagingSession.release(intent.dx, intent.velocity);
        if (settle === null) {
          break; // no live drag (refused start): nothing to settle
        }
        // Interim until the drag-follow track lands (Task 8): a commit jumps
        // immediately to the settle's own captured target, a snap-back is a
        // no-op — the drag pipeline already replaces release-time swipe
        // classification end to end.
        pagingSession.settled();
        if (settle.kind === "commit") {
          jumpToPage(settle.target);
        }
        snapshotDeferral.flush();
        break;
      }
      case "drag-cancel": {
        if (pagingSession.cancel() === null) {
          break;
        }
        pagingSession.settled();
        snapshotDeferral.flush();
        break;
      }
```

- [ ] **Step 5: Run tests and gates**

Run: `bun test test/strip-gestures.test.ts test/strip-paging.test.ts test/strip-diagnostic.test.ts && bun test && bun run typecheck && bun run build:app && bunx biome check app/src/gestures.ts app/src/main.ts app/styles.css test/strip-gestures.test.ts test/strip-paging.test.ts test/strip-diagnostic.test.ts`
Expected: PASS — the full suite, both tsconfigs (the `swipe` removal must leave no dead references, including the diagnostic test's fixture), and the app bundle.

- [ ] **Step 6: Commit**

```bash
git add app/src/gestures.ts app/src/main.ts app/styles.css test/strip-gestures.test.ts test/strip-paging.test.ts test/strip-diagnostic.test.ts
git commit -m "feat(app): axis-locked drag intents replace release-time swipe classification"
```

---

### Task 6: Indicator models and renderers — slivers and pips

**Goal:** pure view models for the three indicator surfaces, derived from the packed pages only — the return sliver (previous page's rightmost occupied column), the peek (next page's leftmost column, with per-row unread dots), and the pip column (one pip per page; aggregates are the OR of the page's cards' existing view-model bits) — plus fake-dom renderers and a render-skip signature. Sliver rows carry no card index and no text; the current pip is clean.

**Files:**
- Create: `app/src/indicators.ts`
- Create: `test/strip-indicators.test.ts`
- Modify: `app/src/cards.ts` (extract `cardShowsUnread` beside `cardViewModel`)

**Interfaces:**
- Consumes: `BoardPage`/`PlacedCard` from Task 2's board shape; `cardShowsUnread` (new export, extracted from `cardViewModel`'s unread expression).
- Produces (Task 7 wires these): `SliverModel { row, status, sub, unread }`; `PipModel { current, dot: "unread" | "working" | null }`; `returnSliverModel(pages, currentPage)`, `peekModel(pages, currentPage)`, `pipColumnModel(pages, currentPage)`; `renderReturnBand(root, model)`, `renderPeekBand(root, model)`, `renderPips(root, model, { onJumpToPage })`; `indicatorsRenderSignature(returnBand, peek, pips): string`. Renderers set `root.dataset["present"]` (`"true"`/`"false"`) — CSS hides absent bands by visibility, never by collapsing the track (constant geometry).

- [ ] **Step 1: Extract the shared unread rule (behavior-preserving)**

In `app/src/cards.ts`, above `cardViewModel`:

```ts
/** The unread bit the card itself renders — display-only cards contribute none.
 *  Single source for the card corner dot, the peek sliver dots, and pip aggregates. */
export const cardShowsUnread = (card: Pick<PlacedCard, "displayOnly" | "session">): boolean =>
  !card.displayOnly && card.session.unreadSince !== null;
```

and in `cardViewModel` replace `unread: !card.displayOnly && session.unreadSince !== null,` with `unread: cardShowsUnread(card),`.

Run: `bun test test/strip-cards.test.ts` — PASS unchanged (pure extraction; the existing unread tests pin it).

- [ ] **Step 2: Write the failing tests**

Create `test/strip-indicators.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { BoardPage, PlacedCard } from "../app/src/board";
import {
  indicatorsRenderSignature,
  peekModel,
  type PipModel,
  pipColumnModel,
  renderPeekBand,
  renderPips,
  renderReturnBand,
  returnSliverModel,
  type SliverModel,
} from "../app/src/indicators";
import type { ProjectedSession } from "../src/protocol";
import { descendants, hasClass, renderedText, withFakeDocument } from "./support/fake-dom";

const UNREAD = "2026-08-27T00:00:00.000Z";

const session = (id: string, overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: id,
  project: null,
  title: id,
  model: null,
  status: "working",
  originKind: null,
  originRef: null,
  originSubagent: false,
  unreadSince: null,
  doneSince: null,
  statusSince: null,
  activityLine: null,
  transcriptPath: null,
  originParentRef: null,
  ghosttyTerminalId: null,
  descendantCount: 0,
  logicalSlot: 1,
  lastEventAt: null,
  ...overrides,
});

const card = (
  column: number,
  row: number,
  overrides: Partial<PlacedCard> = {},
  sessionOverrides: Partial<ProjectedSession> = {},
): PlacedCard => ({
  session: session(`s${column}-${row}`, sessionOverrides),
  label: "t",
  subagent: false,
  parentProject: null,
  displayOnly: false,
  descendantBadge: 0,
  degraded: false,
  indent: false,
  spine: "none",
  continuation: false,
  column,
  row,
  ...overrides,
});

const page = (...cards: PlacedCard[]): BoardPage => ({ cards });

describe("returnSliverModel", () => {
  test("shows the previous page's rightmost occupied column, row-aligned; absent on page 1", () => {
    const pages = [
      page(card(0, 0), card(1, 0, {}, { status: "waiting" }), card(1, 2, { subagent: true })),
      page(card(0, 0)),
    ];
    expect(returnSliverModel(pages, 1)).toEqual([
      { row: 0, status: "waiting", sub: false, unread: false },
      { row: 2, status: "working", sub: true, unread: false },
    ]);
    expect(returnSliverModel(pages, 0)).toEqual([]);
  });
});

describe("peekModel", () => {
  test("shows the next page's leftmost column with the cards' own unread bits; absent on the last page", () => {
    const pages = [
      page(card(0, 0)),
      page(
        card(0, 0, {}, { unreadSince: UNREAD }),
        card(0, 1, { displayOnly: true }, { unreadSince: UNREAD }),
        card(1, 0, {}, { status: "error" }),
      ),
    ];
    expect(peekModel(pages, 0)).toEqual([
      { row: 0, status: "working", sub: false, unread: true },
      { row: 1, status: "working", sub: false, unread: false },
    ]);
    expect(peekModel(pages, 1)).toEqual([]);
  });
});

describe("pipColumnModel", () => {
  test("one pip per page, current clean, amber beats blue, hidden with one page", () => {
    const pages = [
      page(card(0, 0, {}, { unreadSince: UNREAD })),
      page(card(0, 0, {}, { unreadSince: UNREAD, status: "working" })),
      page(card(0, 0, {}, { status: "working" })),
      page(card(0, 0, {}, { status: "idle" })),
    ];
    expect(pipColumnModel(pages, 0)).toEqual([
      { current: true, dot: null },
      { current: false, dot: "unread" },
      { current: false, dot: "working" },
      { current: false, dot: null },
    ]);
    expect(pipColumnModel([page(card(0, 0))], 0)).toEqual([]);
  });

  test("display-only cards contribute no unread to a pip", () => {
    const pages = [page(card(0, 0)), page(card(0, 0, { displayOnly: true }, { unreadSince: UNREAD, status: "idle" }))];
    expect(pipColumnModel(pages, 0)[1]).toEqual({ current: false, dot: null });
  });
});

describe("band renderers", () => {
  const model: SliverModel[] = [
    { row: 1, status: "waiting", sub: false, unread: true },
    { row: 4, status: "working", sub: true, unread: false },
  ];

  test("row-aligned sliver blocks: status attr, sub class, dot only in the peek, no text, no card routing", () => {
    withFakeDocument((root) => {
      renderPeekBand(root as unknown as HTMLElement, model);
      expect(root.dataset["present"]).toBe("true");
      expect(root.children.map((s) => [s.dataset["status"], s.style["gridRow"], hasClass(s, "sub")])).toEqual([
        ["waiting", "2", false],
        ["working", "5", true],
      ]);
      expect(root.children[0]?.children.map((node) => node.className)).toEqual(["sliver-dot"]);
      expect(root.children[1]?.children).toHaveLength(0);
      expect(descendants(root).every((node) => node.dataset["cardIndex"] === undefined)).toBe(true);
      expect(renderedText(root).trim()).toBe("");
    });
    withFakeDocument((root) => {
      renderReturnBand(root as unknown as HTMLElement, model);
      expect(descendants(root).some((node) => hasClass(node, "sliver-dot"))).toBe(false);
    });
    withFakeDocument((root) => {
      renderPeekBand(root as unknown as HTMLElement, []);
      expect(root.dataset["present"]).toBe("false");
      expect(root.children).toHaveLength(0);
    });
  });

  test("pips are tap targets: current enlarged pip clean, minis by kind, taps jump by index", () => {
    const jumps: number[] = [];
    const pips: PipModel[] = [
      { current: false, dot: "unread" },
      { current: true, dot: null },
      { current: false, dot: "working" },
    ];
    withFakeDocument((root) => {
      renderPips(root as unknown as HTMLElement, pips, { onJumpToPage: (target) => jumps.push(target) });
      expect(root.dataset["present"]).toBe("true");
      expect(root.children.map((pip) => hasClass(pip, "current"))).toEqual([false, true, false]);
      expect(root.children.map((pip) => pip.type)).toEqual(["button", "button", "button"]);
      const minis = root.children.map(
        (pip) => descendants(pip).find((node) => hasClass(node, "pip-mini"))?.dataset["kind"] ?? null,
      );
      expect(minis).toEqual(["unread", null, "working"]);
      for (const pip of root.children) {
        for (const listener of pip.listeners["click"] ?? []) {
          listener();
        }
      }
      expect(jumps).toEqual([0, 1, 2]);
    });
    withFakeDocument((root) => {
      renderPips(root as unknown as HTMLElement, [], { onJumpToPage: () => {} });
      expect(root.dataset["present"]).toBe("false");
    });
  });
});

describe("indicatorsRenderSignature", () => {
  test("stable for equal models, distinct when any surface moves", () => {
    const pips: PipModel[] = [{ current: true, dot: null }];
    const base = indicatorsRenderSignature([], [], pips);
    expect(indicatorsRenderSignature([], [], [{ current: true, dot: null }])).toBe(base);
    expect(indicatorsRenderSignature([], [], [{ current: true, dot: null }, { current: false, dot: "unread" }])).not.toBe(base);
    expect(indicatorsRenderSignature([], [{ row: 0, status: "idle", sub: false, unread: false }], pips)).not.toBe(base);
  });
});
```

- [ ] **Step 3: Run tests to verify the red phase**

Run: `bun test test/strip-indicators.test.ts`
Expected: FAIL — `app/src/indicators.ts` does not exist.

- [ ] **Step 4: Implement the module**

Create `app/src/indicators.ts`:

```ts
/**
 * Page indicators for the strip: the return sliver (left gutter), the
 * next-page peek (board's right edge), and the pip column. Pure view models
 * derived from the packed pages — every aggregate is the OR of the page's
 * cards' existing view-model bits from the current snapshot; no page state
 * of its own, no freshness claim the cards don't make. Renderers put no
 * text in any band and no card index on any sliver (bands are page-level
 * tap targets only). The driver is app/src/main.ts; geometry is CSS.
 */

import type { SessionStatus } from "../../src/protocol";
import type { BoardPage } from "./board";
import { cardShowsUnread } from "./cards";

export type SliverModel = {
  /** 0-based board row the sliver aligns to. */
  row: number;
  status: SessionStatus;
  sub: boolean;
  unread: boolean;
};

const sliverColumn = (page: BoardPage, column: number): SliverModel[] =>
  page.cards
    .filter((card) => card.column === column)
    .sort((a, b) => a.row - b.row)
    .map((card) => ({ row: card.row, status: card.session.status, sub: card.subagent, unread: cardShowsUnread(card) }));

/** The page behind's cards nearest the shared edge — its rightmost occupied column; [] on page 1. */
export const returnSliverModel = (pages: readonly BoardPage[], currentPage: number): SliverModel[] => {
  const behind = currentPage > 0 ? pages[currentPage - 1] : undefined;
  if (behind === undefined || behind.cards.length === 0) {
    return [];
  }
  return sliverColumn(behind, Math.max(...behind.cards.map((card) => card.column)));
};

/** The next page's leftmost column; [] on the last page. */
export const peekModel = (pages: readonly BoardPage[], currentPage: number): SliverModel[] => {
  const ahead = pages[currentPage + 1];
  if (ahead === undefined || ahead.cards.length === 0) {
    return [];
  }
  return sliverColumn(ahead, 0);
};

export type PipModel = {
  current: boolean;
  /** At most one corner mini-dot: amber unread beats blue working; the current pip is always clean. */
  dot: "unread" | "working" | null;
};

/** One pip per page, top = page 1; [] (hidden) when only one page exists. */
export const pipColumnModel = (pages: readonly BoardPage[], currentPage: number): PipModel[] => {
  if (pages.length <= 1) {
    return [];
  }
  return pages.map((page, index) => {
    if (index === currentPage) {
      return { current: true, dot: null };
    }
    const unread = page.cards.some(cardShowsUnread);
    const working = page.cards.some((card) => card.session.status === "working");
    return { current: false, dot: unread ? "unread" : working ? "working" : null };
  });
};

const sliverElement = (model: SliverModel, withDot: boolean): HTMLElement => {
  const sliver = document.createElement("div");
  sliver.className = model.sub ? "sliver sub" : "sliver";
  sliver.dataset["status"] = model.status;
  sliver.style.gridRow = String(model.row + 1);
  if (withDot && model.unread) {
    const dot = document.createElement("span");
    dot.className = "sliver-dot";
    sliver.append(dot);
  }
  return sliver;
};

/** The return band: surface plus faint status edge only — no unread dots. */
export const renderReturnBand = (root: HTMLElement, model: readonly SliverModel[]): void => {
  root.dataset["present"] = model.length > 0 ? "true" : "false";
  root.replaceChildren(...model.map((sliver) => sliverElement(sliver, false)));
};

/** The peek band: dimmed surfaces, status edges, unread corner dots per row. */
export const renderPeekBand = (root: HTMLElement, model: readonly SliverModel[]): void => {
  root.dataset["present"] = model.length > 0 ? "true" : "false";
  root.replaceChildren(...model.map((sliver) => sliverElement(sliver, true)));
};

export type PipActions = {
  /** Jump to a 0-based page; the layout reducer validates and clamps it. */
  onJumpToPage: (page: number) => void;
};

export const renderPips = (root: HTMLElement, model: readonly PipModel[], actions: PipActions): void => {
  root.dataset["present"] = model.length > 0 ? "true" : "false";
  root.replaceChildren(
    ...model.map((pip, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = pip.current ? "pip current" : "pip";
      const dot = document.createElement("span");
      dot.className = "pip-dot";
      if (pip.dot !== null) {
        const mini = document.createElement("span");
        mini.className = "pip-mini";
        mini.dataset["kind"] = pip.dot;
        dot.append(mini);
      }
      button.append(dot);
      button.addEventListener("click", () => actions.onJumpToPage(index));
      return button;
    }),
  );
};

/** The render-skip signature: rebuilding every ingest would detach a pip mid-press. */
export const indicatorsRenderSignature = (
  returnBand: readonly SliverModel[],
  peek: readonly SliverModel[],
  pips: readonly PipModel[],
): string => JSON.stringify({ returnBand, peek, pips });
```

- [ ] **Step 5: Run tests and gates**

Run: `bun test test/strip-indicators.test.ts && bun test && bun run typecheck && bunx biome check app/src/indicators.ts app/src/cards.ts test/strip-indicators.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/indicators.ts test/strip-indicators.test.ts app/src/cards.ts
git commit -m "feat(app): sliver and pip indicator models and band renderers"
```

---

### Task 7: The strip re-layout — 40px gutter, bands, pips, 638px rail

**Goal:** the strip becomes `paging-region (pager (viewport+peek) | pips) | rail` on fixed tracks: the board gutter grows 16 → 40 native px, the 54px peek band and 22px pip column exist on every page (constant geometry — content visibility rides `data-present`), the rail narrows 760 → 638 native px and loses its pager (`.rail-pager`/`.page-dot` deleted, `RailModel` slims), and the driver renders the indicators and wires the three tap surfaces (peek → forward, gutter band → back, pips → jump). The wrapper is also the structural event boundary that keeps the rail outside gesture-system listeners.

**Files:**
- Modify: `app/index.html` (the `#strip` shell)
- Modify: `app/styles.css` (`#strip` at 15–21, `#board` at 31–44, the `.rail-pager`/`.page-dot` block at 663–679; new band/pip/sliver blocks)
- Modify: `app/src/rail.ts` (docstring 1–8, `RailModel` 33–42, `RailActions` 44–47, `pagerSection` 172–185, `railRenderSignature` 321–343, `renderRail` 345–358)
- Modify: `app/src/main.ts` (`jumpToPage`/`renderRailNow` at 126–160, `applyBoard` at 235, the gesture-surface selector in `wireInteraction`, `boardRegionWidth`)
- Modify: `docs/design.md` ("Strip layout" line 80, "Rail contract" line 122, "Interaction" line 141)
- Test: `test/strip-rail.test.ts`

**Interfaces:**
- Consumes: Task 6's renderers and `indicatorsRenderSignature`; the existing `jumpToPage` (clamped by `jumpBoard`).
- Produces: static shell ids `#paging-region`, `#pager`, `#board-viewport`, `#board-track`, `#return-band`, `#peek-band`, `#pips`; `#board` gains class `board-grid` (the grid rules move to the class so Task 8's adjacent pages reuse them). `renderRail(root, model)` — two parameters, `RailActions` gone, `RailModel` without `page`/`pageCount`. Task 8 relies on `#board-viewport` (clip) and `#board-track` (transform).

- [ ] **Step 1: Write the failing test**

In `test/strip-rail.test.ts`, add beside the token-block layout tests:

```ts
test("the rail carries no pager: tokens, unread, quota only", () => {
  withFakeDocument((root) => {
    renderRail(root as unknown as HTMLElement, model({ tokens: visibleTokens() }));
    expect(root.children.map((node) => node.className.split(" ")[0])).toEqual([
      "rail-tokens",
      "rail-unread",
      "rail-quota-zone",
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify the red phase**

Run: `bun test test/strip-rail.test.ts`
Expected: the new test FAILS because the rendered child list still ends with `"rail-pager"`. (Passing no `actions` does NOT throw during render: `pagerSection` dereferences `actions.onJumpToPage` only inside each dot's click closure, which nothing invokes here — the failure is the assertion, not an exception.)

- [ ] **Step 3: Slim the rail**

In `app/src/rail.ts`:
- Docstring: drop `, and page dots` from the feature list (line 5) — the pip column (app/src/indicators.ts) replaced them.
- `RailModel`: delete the `page` and `pageCount` members (and the `/** 1-based current page. */` comment).
- Delete the `RailActions` type and the whole `pagerSection` function.
- `railRenderSignature`: delete `page: model.page,` and `pageCount: model.pageCount,` from the JSON object, and in its doc comment replace `would detach the page-dot buttons mid-press and churn layout` with `would churn layout under an in-flight tap`.
- `renderRail` becomes:

```ts
export const renderRail = (root: HTMLElement, model: RailModel): void => {
  const tokens = tokensSection(model.tokens);
  const nowMs = model.now.getTime();
  const zone = document.createElement("div");
  zone.className = "rail-quota-zone";
  zone.append(...model.quota.map((quota) => quotaSection(quota, nowMs)));

  const sections: HTMLElement[] = [];
  if (tokens !== null) {
    sections.push(tokens);
  }
  sections.push(unreadSection(model), zone);
  root.replaceChildren(...sections);
};
```

Update the rest of `test/strip-rail.test.ts` to the slimmed surface (mechanical, same task):
- `model()` fixture: delete `page: 1,` and `pageCount: 2,`.
- Every `renderRail(root …, { onJumpToPage: … })` call: drop the third argument.
- `"changes on unread count, page, and degraded flips"` → rename to `"changes on unread count and degraded flips"` and delete the `page: 2` assertion line.
- `"stacks the two rates in a column beside the sparkline, no separator"`: the expected child list loses `"rail-pager"`.
- `"quota sections sit inside one flex zone between unread and pager"` → rename to `"quota sections sit inside one flex zone after unread"`; the expected root child list becomes `["rail-unread", "rail-quota-zone"]`.

In `app/src/main.ts`, `renderRailNow`'s model loses `page`/`pageCount` and the call loses its actions:

```ts
  const model = {
    degraded: currentView.degraded,
    unreadCount: countUnreadSessions(currentView.snapshot),
    quota: currentQuota,
    tokens: currentTokenUsage,
    now: new Date(),
  };
  const signature = railRenderSignature(model);
  if (signature === railRenderedSignature) {
    return;
  }
  railRenderedSignature = signature;
  renderRail(root, model);
```

and `jumpToPage` drops its trailing `renderRailNow();` call plus the `// renderRailNow is declared below…` comment — the rail no longer displays the page; the indicators re-render through `applyBoard`. Update `renderRailNow`'s skip comment: `page-dot buttons` → `quota layout` (the mid-press-detach concern now lives in renderPips's signature skip).

- [ ] **Step 4: Run tests to verify the rail is green**

Run: `bun test test/strip-rail.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: The shell and the geometry**

Replace `app/index.html`'s `<main>`:

```html
    <main id="strip">
      <div id="paging-region">
        <div id="pager">
          <div id="board-viewport">
            <div id="board-track">
              <div id="board" class="board-grid"></div>
            </div>
            <button id="return-band" type="button" aria-label="Previous page" data-present="false"></button>
          </div>
          <button id="peek-band" type="button" aria-label="Next page" data-present="false"></button>
        </div>
        <nav id="pips" data-present="false"></nav>
      </div>
      <aside id="rail"></aside>
    </main>
```

In `app/styles.css` (native px converted at 2560×720: px / 25.6 = vw, px / 7.2 = vh):

**(a)** `#strip` columns become paging-region | rail, and the wrapper contains pager | pips:

```css
#strip {
  display: grid;
  grid-template-columns: 1fr 24.9219%; /* paging-region | 638px rail */
  height: 100vh;
}
#paging-region {
  display: grid;
  grid-template-columns: 1fr 0.859vw; /* pager | 22px pip band */
  min-width: 0;
}
#pager {
  display: grid;
  grid-template-columns: 1fr 2.109vw; /* viewport | 54px peek band */
  min-width: 0;
  /* The gesture boundary: native touch handling dies here, not on the rail
     (the rail is outside the gesture system entirely). */
  touch-action: none;
  -webkit-touch-callout: none;
}
#board-viewport {
  position: relative;
  overflow: hidden;
  min-width: 0;
}
#board-track {
  height: 100%;
}
```

**(b)** The board grid rules move to the shared class (Task 8's adjacent pages reuse them) and the gutter grows to 40px — change the `#board` selector to `.board-grid`, the fullscreen variant to `body[data-fullscreen] .board-grid`, the `#board > .offline` selector to `.board-grid > .offline`, and the padding line to:

```css
  padding: 6.111vh 0 0 1.5625vw; /* 44px top clears the menu bar overlay; constant 40px gutter hosts the return sliver */
```

Update the block comment above it: `16px left` → `40px left`.

**(c)** The bands, slivers, and pips (new blocks, after the board section). Bands are fixed tracks that exist on every page — content visibility rides `data-present`, so cards never shift when an indicator appears or disappears; no text ever renders in a band:

```css
/* Indicator bands: row-aligned with the board's six rows. */
#peek-band,
#return-band {
  appearance: none;
  margin: 0;
  border: none;
  background: none;
  display: grid;
  grid-template-rows: repeat(6, 14.167vh); /* 102px rows */
  gap: 1.667vh 0; /* 12px */
  padding: 6.111vh 0 0;
  cursor: pointer;
}
body[data-fullscreen] #peek-band,
body[data-fullscreen] #return-band {
  padding-top: 3.333vh;
}
#peek-band[data-present="false"],
#return-band[data-present="false"],
#pips[data-present="false"] {
  visibility: hidden; /* the track stays reserved: constant geometry */
}
/* The return band owns the whole 40px gutter as its tap target (a 14px
   sliver alone is below touch size); it sits above the track so the sliver
   stays put while pages slide beneath it. */
#return-band {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 1;
  width: 1.5625vw;
  justify-items: start;
}
#return-band .sliver {
  width: 0.547vw; /* 14px visual inside the 40px target */
}

/* Slivers: a card's edge poking in from the adjacent page — dimmed surface,
   the board's status hues on the leading edge, sub vs primary distinguished. */
.sliver {
  position: relative;
  min-width: 0;
  background: rgb(28 36 48 / 0.55);
  border-left: 0.3125vw solid transparent; /* the 8px status-edge slot, card anatomy */
}
.sliver.sub {
  background: rgb(17 21 29 / 0.7);
}
#peek-band .sliver {
  border-radius: 0.469vw 0 0 0.469vw; /* the card's left corners */
}
#return-band .sliver {
  border-radius: 0 0.469vw 0.469vw 0;
}
.sliver[data-status="working"] {
  border-left-color: rgb(32 184 255 / 0.8);
}
.sliver[data-status="idle"] {
  border-left-color: rgb(74 222 128 / 0.8);
}
.sliver[data-status="waiting"] {
  border-left-color: rgb(255 176 32 / 0.8);
}
.sliver[data-status="error"] {
  border-left-color: rgb(255 77 103 / 0.8);
}
/* The page behind whispers: same hues, fainter. */
#return-band .sliver[data-status="working"] {
  border-left-color: rgb(32 184 255 / 0.45);
}
#return-band .sliver[data-status="idle"] {
  border-left-color: rgb(74 222 128 / 0.45);
}
#return-band .sliver[data-status="waiting"] {
  border-left-color: rgb(255 176 32 / 0.45);
}
#return-band .sliver[data-status="error"] {
  border-left-color: rgb(255 77 103 / 0.45);
}
.sliver-dot {
  position: absolute;
  top: 0.833vh; /* 6px */
  right: 0.234vw; /* 6px */
  width: 0.469vw; /* 12px unread corner dot; on-glass tunable */
  height: 0.469vw;
  border-radius: 50%;
  background: #ffb020;
}

/* The pip column: one pip per page, top = page 1, vertically centered.
   Pips are the secondary navigation — the swipe is primary. */
#pips {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2.5vh; /* 18px */
  min-width: 0;
}
.pip {
  appearance: none;
  border: none;
  background: none;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.109vw; /* 54px hit: the 22px band plus invisible 16px slop each side */
  height: 7.778vh; /* 56px vertical hit */
  margin: 0 -0.625vw; /* the slop overflows the band track symmetrically */
  padding: 0;
  cursor: pointer;
}
.pip-dot {
  position: relative;
  width: 0.469vw; /* 12px */
  height: 0.469vw;
  border-radius: 50%;
  background: #2a3342;
}
.pip.current .pip-dot {
  width: 0.703vw; /* 18px: the current page's pip is enlarged and lit */
  height: 0.703vw;
  background: #e8eef7;
}
.pip-mini {
  position: absolute;
  top: -0.417vh; /* riding the pip's corner */
  right: -0.117vw;
  width: 0.352vw; /* 9px mini-dot; on-glass tunable (grow to 12-14px if illegible) */
  height: 0.352vw;
  border-radius: 50%;
}
.pip-mini[data-kind="unread"] {
  background: #ffb020;
}
.pip-mini[data-kind="working"] {
  background: #20b8ff;
}
```

**(d)** Delete the `.rail-pager` and `.page-dot`/`.page-dot.current` blocks (lines 663–679).

- [ ] **Step 6: Wire the driver**

In `app/src/main.ts`:

**(a)** Imports:

```ts
import {
  indicatorsRenderSignature,
  peekModel,
  pipColumnModel,
  renderPeekBand,
  renderPips,
  renderReturnBand,
  returnSliverModel,
} from "./indicators";
```

**(b)** Indicator rendering, beside `renderRailNow` (state var beside `railRenderedSignature`):

```ts
let indicatorsRenderedSignature = "";

/** The three indicator surfaces re-render together, signature-skipped so a
 *  heartbeat ingest never detaches a pip mid-press. */
const renderIndicatorsNow = (): void => {
  const returnRoot = document.querySelector<HTMLElement>("#return-band");
  const peekRoot = document.querySelector<HTMLElement>("#peek-band");
  const pipsRoot = document.querySelector<HTMLElement>("#pips");
  if (returnRoot === null || peekRoot === null || pipsRoot === null) {
    return;
  }
  const returnBand = returnSliverModel(currentPages, currentPage);
  const peek = peekModel(currentPages, currentPage);
  const pips = pipColumnModel(currentPages, currentPage);
  const signature = indicatorsRenderSignature(returnBand, peek, pips);
  if (signature === indicatorsRenderedSignature) {
    return;
  }
  indicatorsRenderedSignature = signature;
  renderReturnBand(returnRoot, returnBand);
  renderPeekBand(peekRoot, peek);
  renderPips(pipsRoot, pips, { onJumpToPage: jumpToPage });
};
```

Call it as the last line of `applyBoard` (outside the board's signature skip — a page appended elsewhere changes the indicators without changing the current page's cards).

**(c)** The gesture surface widens to the pager and the suppression boundary moves to the new wrapper: in `wireInteraction`, change the interim `const region = document.querySelector<HTMLElement>("#board")` to `"#paging-region"` and `const surface = region` to `document.querySelector<HTMLElement>("#pager")`. The peek band is now inside the active surface (it is the incoming page's drag affordance), while `#pips` is inside `#paging-region` but remains click-only and the rail is outside the region entirely. All six recognizer listeners (down/move/up/cancel/lostpointercapture/contextmenu) ride the `surface` variable; the two suppression listeners ride `#paging-region`.

**(d)** `boardRegionWidth` retargets to the viewport:

```ts
const boardRegionWidth = (): number =>
  document.querySelector<HTMLElement>("#board-viewport")?.clientWidth ?? 0;
```

**(e)** Band taps in `wireInteraction` (page-level targets; `jumpBoard` clamps, and a drag released here is already swallowed by the capture-phase suppression):

```ts
  document.querySelector<HTMLElement>("#peek-band")?.addEventListener("click", () => jumpToPage(currentPage + 1));
  document.querySelector<HTMLElement>("#return-band")?.addEventListener("click", () => jumpToPage(currentPage - 1));
```

- [ ] **Step 7: Update docs/design.md**

- "Strip layout" (line 80): `It uses a fixed 760px rail and a two-column board…` → `It uses a fixed 638px rail, a 22px page-pip column, a 54px next-page peek band, and a two-column board of six 886×102 cards per page behind a constant 40px gutter that hosts the return sliver.`
- "Rail contract" (line 122): delete the `- Page dots.` bullet.
- "Interaction" (line 141): `Horizontal flings and rail dots change pages.` → `A horizontal drag on the board follows the finger and commits or visibly snaps back; the peek band, return gutter, and page pips jump pages. The rail takes no gestures.`

- [ ] **Step 8: Run the full gates**

Run: `bun test && bun run typecheck && bun run build:app && bunx biome check app/index.html app/styles.css app/src/rail.ts app/src/main.ts test/strip-rail.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add app/index.html app/styles.css app/src/rail.ts app/src/main.ts test/strip-rail.test.ts docs/design.md
git commit -m "feat(app): strip re-layout - peek band, pip column, 40px gutter, 638px rail"
```

---

### Task 8: Drag-follow visuals — the track, adjacent pages, commit and snap-back

**Goal:** the board physically follows the finger: `#board-track` translates by the session's offset, both existing neighbor pages mount as transient grids at gutter-overlap spacing (the incoming column rises exactly under the peek slivers), release animates to commit or snap-back (including a sample-starved below-threshold release whose preceding `drag-move` makes failure visible), and settle applies any deferred snapshot. Rubber-band drags render no adjacent page — the resisted give itself is the "nowhere to go" signal. Re-entrancy is owned by the session (Task 4): a settling board refuses new drags, stray releases return null (the driver animates only non-null verdicts, so settling is single-flight), a commit jumps to the settle's own captured target (a mid-settle repack or navigation cannot retarget it), and `jumpToPage`'s navigation gate keeps pip/band taps out of a live settle.

**Files:**
- Modify: `app/src/main.ts` (the drag cases in `handleGestureIntents`; new track/adjacent helpers)
- Modify: `app/styles.css` (track transform, `.board-adjacent` placement)

**Interfaces:**
- Consumes: `PagingSession` and `DragSettle` from Task 4; `renderBoard` (already generic over its root — adjacent grids are throwaway renders with no keys shared with `#board`, no tickers, no pulses); `.board-grid` from Task 7.
- Produces: driver-only behavior. No new exports. The controller decisions this task animates — single-flight settling, captured commit targets, navigation gating, deferral ordering — are red-first tested in Tasks 4–5; what remains here is DOM glue (a transform, two transient mounts, a transitionend) in the repo's untested-driver layer, receipted on glass in Task 9.

- [ ] **Step 1: Implement the drag visuals**

In `app/src/main.ts`:

**(a)** Constants and helpers beside `boardRegionWidth`:

```ts
const SETTLE_MS = 160;
/** Mirrors .board-grid's 1.5625vw gutter (styles.css): adjacent pages sit one
 *  board-width-minus-gutter apart, so the incoming first column starts exactly
 *  under the peek slivers and the sliver grows into the real card. */
const BOARD_GUTTER_NATIVE_PX = 40;
const NATIVE_STRIP_WIDTH_PX = 2560;
const gutterPx = (): number => (window.innerWidth * BOARD_GUTTER_NATIVE_PX) / NATIVE_STRIP_WIDTH_PX;

const boardTrack = (): HTMLElement | null => document.querySelector<HTMLElement>("#board-track");
let adjacentPages: HTMLElement[] = [];
let settleFallback: ReturnType<typeof setTimeout> | null = null;

const setTrackOffset = (offset: number, animate: boolean): void => {
  const track = boardTrack();
  if (track === null) {
    return;
  }
  track.style.transition = animate ? `transform ${SETTLE_MS}ms ease-out` : "none";
  track.style.transform = `translateX(${offset}px)`;
};

const mountAdjacentPages = (): void => {
  const track = boardTrack();
  const degraded = currentView?.degraded ?? false;
  if (track === null) {
    return;
  }
  const mount = (page: BoardPage | undefined, side: "previous" | "next"): void => {
    if (page === undefined || page.cards.length === 0) {
      return;
    }
    const grid = document.createElement("div");
    grid.className = `board-grid board-adjacent ${side}`;
    renderBoard(grid, page, degraded);
    track.append(grid);
    adjacentPages.push(grid);
  };
  mount(currentPages[currentPage - 1], "previous");
  mount(currentPages[currentPage + 1], "next");
};

const unmountAdjacentPages = (): void => {
  for (const grid of adjacentPages) {
    grid.remove();
  }
  adjacentPages = [];
};

/**
 * Animate to the settle target, then commit-and-reset in one synchronous
 * handler so the swap never flashes: the page jump re-renders #board while
 * the track snaps back to rest and the transient neighbors unmount. The
 * commit navigates to the settle's own captured target — never to whatever
 * currentPage mutated to during the animation. Single-flight is the
 * session's guarantee: finishSettle only ever runs on a non-null verdict,
 * and no second verdict can exist until settled() runs here. The fallback
 * timer covers a transitionend that never fires (an already-at-rest
 * snap-back transitions nothing).
 */
const finishSettle = (settle: DragSettle): void => {
  const track = boardTrack();
  const done = (): void => {
    track?.removeEventListener("transitionend", done);
    if (settleFallback !== null) {
      clearTimeout(settleFallback);
      settleFallback = null;
    }
    pagingSession.settled(); // before the jump: the navigation gate opens here
    if (settle.kind === "commit") {
      jumpToPage(settle.target);
    }
    setTrackOffset(0, false);
    unmountAdjacentPages();
    snapshotDeferral.flush();
  };
  const target =
    settle.kind === "commit"
      ? (settle.direction === "next" ? -1 : 1) * (boardRegionWidth() - gutterPx())
      : 0;
  track?.addEventListener("transitionend", done);
  settleFallback = setTimeout(done, SETTLE_MS + 80);
  setTrackOffset(target, true);
};
```

Add `DragSettle` to the `./paging` import and `BoardPage` is already imported.

**(b)** The drag cases in `handleGestureIntents` become (replacing Task 5's interim bodies):

```ts
      case "drag-start": {
        const accepted = pagingSession.start({
          page: currentPage,
          pageCount: currentPageCount,
          boardWidth: boardRegionWidth(),
        });
        if (!accepted) {
          break; // a settling board is not grabbable; this stroke owns nothing
        }
        mountAdjacentPages();
        setTrackOffset(0, false);
        break;
      }
      case "drag-move": {
        const offset = pagingSession.move(intent.dx);
        if (offset !== null) {
          setTrackOffset(offset, false); // a refused stroke never touches the track
        }
        break;
      }
      case "drag-end": {
        const settle = pagingSession.release(intent.dx, intent.velocity);
        if (settle !== null) {
          finishSettle(settle);
        }
        break;
      }
      case "drag-cancel": {
        const settle = pagingSession.cancel();
        if (settle !== null) {
          finishSettle(settle);
        }
        break;
      }
```

(The Task 5 interim path called `settled()`/`snapshotDeferral.flush()` inline in the drag-end/cancel cases; both now live inside `finishSettle`'s `done`, in the tested order: settled → commit jump to the captured target → flush. Do not optimize away the snap-back transition when `target === 0`: Task 5's sample-starved below-commit controller test proves the preceding `drag-move` painted a nonzero offset, so this transition is the required visible failure feedback.)

In `app/styles.css`, after the `#board-track` rule:

```css
#board-track {
  height: 100%;
  will-change: transform;
}
/* Transient neighbor pages, mounted only for a drag's lifetime, one
   board-width-minus-gutter away so adjacent pages tile gutter-under-sliver. */
.board-adjacent {
  position: absolute;
  top: 0;
  width: 100%;
  height: 100%;
}
.board-adjacent.next {
  left: calc(100% - 1.5625vw);
}
.board-adjacent.previous {
  left: calc(-100% + 1.5625vw);
}
```

- [ ] **Step 2: Run the full gates**

Run: `bun test && bun run typecheck && bun run build:app && bunx biome check app/src/main.ts app/styles.css`
Expected: PASS. This task has no unit red phase of its own by design: the controller behaviors the review flagged — settle re-entry refusal, captured commit targets, navigation gating, deferred-snapshot ordering — are red-first tested in Task 4 (session + latch tests) and Task 5 (recognizer-to-session integration); what this task adds is DOM glue (a transform, two transient mounts, a transitionend listener) whose acceptance is Task 9's on-glass receipt.

- [ ] **Step 3: Commit**

```bash
git add app/src/main.ts app/styles.css
git commit -m "feat(app): drag-follow board track with commit and snap-back animation"
```

---

### Task 9: On-glass bring-up — thresholds tuned, legibility receipt (REQUIRED)

**Goal:** tune every gesture/settle constant on the physical strip (the diagnostic gates this — spec constraint) and run the spec's on-glass acceptance pass: the user-decides legibility checks (return sliver, pip mini-dots) and the 638px rail fit are explicit verification items here, never silent assumptions. This is an acceptance receipt, not a suggestion.

**Files:**
- Modify (tuning only): `app/src/gestures.ts` (`DRAG_LOCK_MIN_PX`, `VELOCITY_WINDOW_MS`), `app/src/paging.ts` (`COMMIT_FRACTION`, `COMMIT_VELOCITY_PX_PER_MS`, `RUBBER_BAND_FACTOR`), `app/styles.css` (sliver/mini-dot sizes if the legibility checks demand growth)

**Step 0 precondition:** Task 1's receipt confirmed a usable move stream. If that receipt is still pending, stop here.

- [ ] **Step 1: Install the real artifacts**

```bash
bun run check
bun run install:app
open -a Dealerboard
```

Confirm the running strip shows the Task 7 layout (peek band, pips, no rail dots) before recording anything — a receipt against stale artifacts is void. The diagnostic overlay from Task 1 is still installed; use its delivery/recognition lines while tuning.

- [ ] **Step 2: Tune the gesture constants on device**

With two-plus pages of sessions, iterate on glass (edit constant → `bun run install:app` → retry; tests reference the constants symbolically, so tuning never breaks the suite):

1. `DRAG_LOCK_MIN_PX`: taps and holds must never twitch the board; a deliberate horizontal pull must lock within the first centimeter.
2. `COMMIT_FRACTION` / `COMMIT_VELOCITY_PX_PER_MS` / `VELOCITY_WINDOW_MS`: a lazy half-width pull commits; a slow small pull returns; a quick flick commits from a short distance. If the diagnostic shows sparse move delivery, bias toward the distance term and note it.
3. `RUBBER_BAND_FACTOR`: dragging past the first/last page (and anywhere on a single-page board) gives visible, springy resistance and returns.

- [ ] **Step 3: Walk the on-glass acceptance checklist**

Record **pass/fail plus a one-line observation per item**; include the completed receipt in the completion report. If the strip hardware is unavailable, say so explicitly and leave this task open — do not mark it done. Items 11 and 12 are the spec's `user-decides` checks: **they are Drew's decisions, recorded verbatim — the executor never settles them alone.**

1. **Original complaint dead:** with the kickoff shape (five singles + a nine-card orchestrator group), page 1 has no empty column, the group visibly continues (peek slivers + "↩ cont." on page 2), and swiping to page 2 works with the board following the finger.
2. **Failed swipe visible:** a below-threshold drag moves and snaps back — motion-and-return, never a silent no-op.
3. **Zone scoping:** a drag starting on the rail never pages and never moves the rail (the rail carries no handlers — nothing on it reacts at all); a drag starting on any card, blank board space, or the peek band pages.
4. **Axis coexistence:** vertical dismiss flicks still work on cards; a locked horizontal drag never opens the action sheet (hold mid-drag) and never flicks.
5. **Sheet-open suppression:** touch-and-hold a card to open the action sheet; with it open, attempt a horizontal drag across the board — nothing pages, nothing translates, the sheet stays until dismissed; after dismissal the next drag pages normally.
6. **Cancellation and window-leave snap back:** start a drag and abort it without a clean release — slide the finger off the display edge, and separately steal focus mid-drag (window blur, e.g. app switch) — the board visibly snaps back both times; no half-translated rest state survives either.
7. **Mid-drag stability:** hold a drag through a snapshot heartbeat (~5s) — cards do not repack or shift under the finger; the pending state applies at settle.
8. **Constant geometry:** cards sit at identical positions on page 1 (no return sliver) and page 2 (sliver present); no card shifts when peek/pips appear or disappear.
9. **Peek continuity:** during a next-drag the incoming column rises out of the peek slivers' position; live status colors and unread dots match the cards that arrive.
10. **Band taps:** a tap on the peek band advances one page; a tap anywhere in the left gutter returns one page; a drag released over either band does not also fire a jump (its trailing click is swallowed).
11. **[user-decides — Drew] Return sliver legibility:** do the 14px slivers register at arm's length as "a page lives this way"? **Drew decides**: keep, or grow to a size Drew names (adjusting the faint-edge alpha with it). Record Drew's verbatim decision in the receipt, apply it, re-check, and record the re-check. If Drew is unavailable, the item stays open — the executor never resizes on their own judgment.
12. **[user-decides — Drew] Pip mini-dot legibility:** do the 9px amber/blue corner dots read at arm's length? **Drew decides**: keep, or grow (the spec offers 12–14px native as the fallback range — Drew picks the value). Same protocol as item 11: verbatim decision, apply, re-check, record.
13. **Pip behavior:** current pip enlarged/lit and clean; unread page shows amber over blue; taps (including slightly-off taps — the invisible slop) jump correctly; pips absent with one page.
14. **Rail fit at 638px:** tokens, sparkline, unread line, and every quota meter render without wrapping or clipping — including the longest realistic quota note beside its percent (force one by checking during a stale/unavailable window, e.g. `1h+ old · 55%`). If anything clips, STOP and take the note-abbreviation question to Drew (the spec's named fallback) rather than deciding silently.
15. **Degraded honesty:** stop the daemon; after OFFLINE the indicators render from the same last-good snapshot as the cards and paging stays available; an empty board hides all indicator content.
16. **Peek is not viewing:** a page with unread sitting visible in the peek keeps its unread state until actually visited.

- [ ] **Step 4: Commit the tuned constants**

```bash
git add app/src/gestures.ts app/src/paging.ts app/styles.css
git commit -m "feat(app): tune paging gesture and indicator constants on the strip"
```

(Drew-decided sliver/mini-dot sizes from items 11–12 ride this commit. Skip the commit only if every placeholder survived tuning unchanged and no CSS moved; say so in the report either way.)

---

### Task 10: Remove the diagnostic; final gates and a final-artifact smoke

**Goal:** the spec's observability contract — the bring-up diagnostic is removable and no permanent logging lands. Delete the module, its test (part of the ratified removable instrumentation, not a silent test deletion), its wiring, and its CSS; then run the full CI gate AND a condensed physical smoke — the removal touches wiring on every pointer layer after Task 9's verification, so the receipt must apply to the artifact that actually ships.

**Precondition:** Task 9's receipt is complete — the diagnostic gates threshold tuning, so it outlives every tuning pass and dies here.

**Files:**
- Delete: `app/src/diagnostic.ts`, `test/strip-diagnostic.test.ts`
- Modify: `app/src/main.ts` (remove the import, the `diagnostic` const, the five `recordPointer` lines, `recordIntents` in `feedPointer`, `recordNavigation` in `jumpToPage` (and its now-unused `from`), `recordRender` in `applyBoard`, the mount block in `start`)
- Modify: `app/styles.css` (delete the `#pointer-diag` block)

- [ ] **Step 1: Remove**

Delete the two files, strip the seven wiring points, delete the CSS block. Then verify nothing dangles:

Run: `grep -rn "diagnostic\|pointer-diag" app/src app/styles.css app/index.html test/`
Expected: no matches.

- [ ] **Step 2: Full CI gate**

Run: `bun run check && bun run build:app`
Expected: PASS (biome ci, both tsconfigs via the build, the entire `bun test` suite, and the app bundle).

- [ ] **Step 3: Reinstall and run the condensed final-artifact smoke — REQUIRED**

The diagnostic's removal edited every pointer layer's wiring after the Task 9 receipt; verify the shipped artifact, not its instrumented ancestor:

```bash
bun run install:app
open -a Dealerboard
```

On the physical strip, one line per check in the completion report: a drag commits in both directions; a short drag visibly moves then snaps back; a single-page board rubber-bands; a drag beginning on the rail is inert and the rail never moves; a drag while the action sheet is open is inert; a pointer-cancel and a window-blur both snap back; a snapshot arriving mid-drag stays stable until settle; pip, peek-band, and gutter taps jump; a vertical flick still dismisses; touch-and-hold still opens the action sheet; no diagnostic overlay renders anywhere. If the strip is unavailable, say so, leave this step and the task open, and do not proceed to the commit — the removal ships only verified.

- [ ] **Step 4: Commit**

```bash
git add -u app/src/diagnostic.ts test/strip-diagnostic.test.ts app/src/main.ts app/styles.css
git commit -m "chore(app): remove bring-up pointer diagnostic"
```

---

## Spec coverage map

| Spec requirement | Task(s) |
| --- | --- |
| Diagnostic-first: localize the swipe failure to delivery / recognition / navigation / render; gates threshold tuning | 1 (module — whole-batch recognition line — + receipt + decision gate), 9 (tuning precondition), 10 (removal + final-artifact smoke — "no permanent logging") |
| Swipe zone is the board region only; rail takes no handlers, never moves | 5 (recognizer handlers on `#pager`; suppression bookkeeping/swallowing on `#paging-region`, which excludes the rail), 7 (`#paging-region` shell and `#pager` boundary; `touch-action` moves with it), 9 (#3) |
| Drag-follow with snap-back; ~25% / velocity commit; failure is motion-and-return | 4 (settle/offset tests), 5 (drag intent stream), 8 (track + animations), 9 (#1, #2 + tuning) |
| Gesture arbitration by axis lock; locked touch suppresses tap/long-press/vertical; vertical falls through unchanged | 5 (axis-race, context/tick suppression, fall-through tests; flick tests kept verbatim) |
| Settle integrity: single-flight settling, captured commit targets, gated navigation; a sample-starved release still pages | 4 (re-entry, `allowsNavigation`, from/target tests), 5 (drag-start-precedes-drag-end recognizer test + recognizer-to-session integration test), 8 (driver animates only non-null verdicts; `finishSettle` jumps to `settle.target` after `settled()`) |
| No paging gesture while the action sheet is open; cancel / window-leave snaps back | Interpretation 6 (structural overlay) + 5 (`drag-cancel` test; `window` blur + `lostpointercapture` wiring), 8 (cancel settles as snap-back), 9 (#5, #6 explicit on-glass checks) |
| Snapshots defer during a drag; latest pending applies at settle | 4 (phase tests + `createDeferredLatest` ordering tests), 5 (every ingest routes through the latch), 8 (flush in `finishSettle`), 9 (#7) |
| Constant geometry: 40px gutter on every page; cards never shift with indicators | 7 (fixed tracks, visibility-not-collapse, gutter padding), 9 (#8) |
| Return sliver: 14px row-aligned, surface + faint status edge, absent on page 1; jump-back tap target | 6 (`returnSliverModel`, dot-free renderer), 7 (CSS + gutter-wide tap), 9 (#10 tap, #11 legibility — Drew decides) |
| Next-page peek: 54px row-aligned slivers, dimmed sub/primary surfaces, status edges, unread dots, absent on last page; drag continuity; page-level tap; sliver rows never interactive, never in card-index routing | 6 (`peekModel`, renderer + no-card-index/no-text tests), 7 (CSS + tap), 8 (gutter-overlap continuity), 9 (#9, #10) |
| Pip column: one per page, current enlarged/lit and clean, amber-over-blue minis from the cards' own view-model bits, current-snapshot-only, tap-to-jump with slop, hidden at one page | 6 (`pipColumnModel` + renderer tests, `cardShowsUnread` single source), 7 (CSS incl. 54×56 hit), 9 (#12 legibility — Drew decides, #13) |
| Rail narrows to 638px; content fits; `.rail-pager`/`.page-dot` deleted | 7 (grid + CSS deletion + rail slimming), 9 (#14 fit check, abbreviation fallback escalates to Drew) |
| Packing: fill-and-continue, first-fit unchanged, sequence-general, every page but the last full, kickoff renders with no empty column | 2 (invariant + kickoff + sequence tests) |
| Continuation marker on each page break; column breaks unmarked; marker carries group identity (last-slot parent case) | 2 (`continuation` bit + tests), 3 ("↩ cont." tag) |
| Page identity = clamped index; no per-page persisted state | Unchanged `reduceBoard`/`jumpBoard` (existing clamp tests stay green); indicators derive from `(pages, currentPage)` only |
| Peek visibility is not viewing; unread/ack semantics unchanged | 6 (renderers wire only `onJumpToPage` — no ack path exists), 9 (#16) |
| Degraded renders indicators from last-good; OFFLINE/empty hides them | 6 (models ignore `degraded`, empty pages → `data-present="false"`), 9 (#15) |
| Single page: no indicators, gutter remains, rubber-band both directions | 4 (per-direction resistance tests), 6 (hidden models), 9 (#3 of Step 2) |
| On-glass acceptance (golden question): sliver + mini-dot legibility, rail fit — physical-strip receipt | 9 (REQUIRED receipt; user-decides items are explicit checks #11, #12, rail-fit check #14) |
| Cross-spec: retention coexistence via axis lock | 5 (vertical fall-through pinned; flick tests untouched), header cross-spec note |
