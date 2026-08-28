# Board Paging, Peek & Pips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make board paging touch-native and legible: the swipe becomes a board-scoped drag-follow that visibly commits or snaps back, the pages you are not on announce themselves (return sliver, next-page peek, pip column — all live-status), groups split so every page except the last is full, and the rail narrows 760 → 638 native px — all gated by an on-device pointer diagnostic that localizes the original swipe failure first.

**Architecture:** Four layers, pure-to-driver. The gesture recognizer (`app/src/gestures.ts`) gains per-stroke axis lock and emits a drag intent stream (`drag-start`/`drag-move`/`drag-end`/`drag-cancel`) instead of a release-time `swipe`; a new pure module `app/src/paging.ts` owns the commit-or-snap-back settle rule, rubber-band offsets, and the drag-session phases that gate snapshot deferral. The board reducer (`app/src/board.ts`) replaces group-atomic page breaks with fill-and-continue packing (`continuation` bit on `PlacedCard`); a new pure module `app/src/indicators.ts` derives sliver and pip view models from the packed pages (aggregates are the OR of the cards' existing view-model bits — no new state) and renders the three bands. The driver (`app/src/main.ts`) wires the drag onto a translating `#board-track` inside a clipping `#board-viewport`, mounting transient adjacent-page grids only for the drag's lifetime, so steady-state rendering, reconciliation, tickers, and pulses are untouched. All indicator geometry is fixed CSS tracks that exist on every page (constant geometry); content visibility rides `data-present`.

**Tech Stack:** TypeScript on Bun (`bun test`), no new dependencies. Strip webview is plain DOM (tests use `test/support/fake-dom`). Gates: `bun run typecheck` (root + app tsconfigs), biome, `bun run build:app`, and CI's `bun run check`.

**Working directory:** all commands run from the worktree root `/Users/drewritter/projects/dealerboard/.worktrees/board-paging-peek` (branch `wip/board-paging-peek`). Pre-commit hooks (lefthook) run `biome check --write` on staged files plus `bun run typecheck` — let them run; never bypass.

**Spec authority:** `docs/superpowers/specs/2026-08-27-board-paging-peek/spec.md` (ratified). Decisions log: `decisions.md` in the same directory. When in doubt, the spec wins over this plan.

**Sequencing:** Task 1 (the pointer diagnostic) is first and carries a hard decision gate: its on-strip receipt must confirm the pointer-move stream is usable before Tasks 4–10 proceed (Tasks 2–3, the packing work, are gesture-independent and may proceed while the receipt is pending). If move delivery is broken on the Xeneon, STOP and report to Drew — the spec says drag-follow degrades and the gesture design must be revisited; do not build Tasks 4–10 on a broken stream. Every gesture/settle constant is a named export tuned on device in Task 9; tests reference the constants symbolically, never literals, so tuning never breaks the suite.

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
3. **Axis-lock constants (bring-up placeholders, tuned in Task 9):** `DRAG_LOCK_MIN_PX = 16` (just past the existing 12px `MOVE_SLOP_PX`, so any locked drag has already killed the long-press), dominance = strictly `|dx| > |dy|` (a diagonal tie locks vertical, so paging never steals the dismiss axis). Vertical dominance locks the stroke out of paging for its lifetime; its release classifies exactly as today (flick thresholds unchanged).
4. **Commit constants (bring-up placeholders, tuned in Task 9):** `COMMIT_FRACTION = 0.25` (the spec's ~25% of board width), `COMMIT_VELOCITY_PX_PER_MS = 0.6` measured over a trailing `VELOCITY_WINDOW_MS = 100` sample window, `RUBBER_BAND_FACTOR = 0.3`. A release with no samples inside the window (sparse WKWebView delivery) settles by distance alone (velocity 0) — the same robustness posture as today's release-position reclassification.
5. **The paging surface is `#pager` (board viewport + peek band); the pip column and rail are outside it.** The peek is in-zone because it is the incoming page's own drag affordance ("the drag affordance is the same object as the indicator" — decisions.md). Until the Task 7 re-layout exists, the zone is `#board`, which already excludes the rail — the requirement's acceptance holds from Task 5 onward.
6. **Sheet-open suppression is structural.** The action-sheet overlay is a fixed full-window element appended to `document.body`, outside `#strip`, so no pointer event during a sheet reaches the strip's handlers — no paging gesture can begin (requirement satisfied by construction). The same-touch path is covered in the recognizer: a locked drag suppresses the platform hold verdict (`context`) and the long-press tick, pinned by tests.
7. **Drag rendering mounts transient adjacent grids on a translating track; the static board pipeline is untouched.** `#board` keeps its id, reconciliation, tickers, and pulse plumbing; adjacent pages are throwaway `renderBoard` outputs that live only for the drag. Adjacent pages sit at gutter-overlap spacing (`calc(100% − 1.5625vw)`), so the incoming page's first column rises exactly where the peek slivers sit — that is the "sliver grows into the real card" continuity. Both neighbors mount at drag-start (a finger can cross zero mid-drag). The ~18px→14px step where the outgoing page's edge hands off to the static return sliver at commit-settle is accepted; Task 9 polishes on glass if it reads badly.
8. **Snapshot deferral spans drag-start through settle-animation end** (`PagingSession.defersSnapshots()`, phase ≠ idle): the newest payload is stashed and applied once at settle, so the board, peek, and pips never repack under the finger. The 1s status/liveness tickers keep running — they mutate text and decay colors in place, which is not a repack, and the alternative (frozen timers mid-drag) would misreport time.
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
| `app/index.html` | Strip shell: pager/viewport/track/bands/pips | 7 |
| `app/styles.css` | Geometry (40px gutter, bands, pips, 638px rail), `.cont-tag`, track/adjacent, diag overlay | 1, 3, 7, 8, 10 |
| `app/src/main.ts` | Driver: diagnostic wiring (1), drag pipeline + deferral (5), indicators + taps (7), drag visuals (8), diagnostic removal (10) | 1, 5, 7, 8, 10 |
| `docs/design.md` | Packing paragraph (2); strip layout/rail/interaction contract (7) | 2, 7 |
| `app/src/dismissals.ts`, `app/src/liveness.ts`, `app/src/press.ts`, `src/plugin/layout.ts` | Untouched (verified sufficient) | — |

---

### Task 1: Bring-up pointer diagnostic — which layer eats the swipe?

**Goal:** removable on-device instrumentation that localizes the reported swipe failure to exactly one of four layers — event delivery (raw pointer events reaching the strip handlers), recognition (recognizer intents), navigation (page jumps), render (board re-renders) — with an on-strip verification receipt that gates the rest of the gesture work. The spec forbids permanent logging; this module and its test are deleted in Task 10.

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
    diag.recordIntents([{ kind: "suppress-click" }]);
    diag.recordNavigation(0, 1);
    diag.recordRender();
    const lines = diag.summary();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("d1 m1 u1");
    expect(lines[0]).toContain("x3");
    expect(lines[1]).toContain('"suppress-click"');
    expect(lines[2]).toContain("0→1");
    expect(lines[3]).toContain("1");
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
 * delivery (raw pointer events reaching the strip handlers, with a 1s move
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
  let lastIntent = "none";
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
      for (const intent of intents) {
        intentCount += 1;
        lastIntent = JSON.stringify(intent);
      }
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
      `recognize ${intentCount} | ${lastIntent}`,
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

**(b)** Delivery layer — first line of each strip pointer handler's body after its `isPrimary` guard, and in the contextmenu handler:

```ts
  diagnostic?.recordPointer("down", 1);      // onStripPointerDown
  diagnostic?.recordPointer("move", event.getCoalescedEvents?.().length ?? 0); // onStripPointerMove
  diagnostic?.recordPointer("up", 1);        // onStripPointerUp
  diagnostic?.recordPointer("cancel", 1);    // onStripPointerCancel
  diagnostic?.recordPointer("context", 1);   // onStripContextMenu
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
2. **Recognition:** on a drag release, does today's recognizer emit `swipe` (visible as the last intent), or nothing?
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

In `test/strip-cards.test.ts`, add `continuation: false,` to the `placed()` fixture object (between `spine: "none",` and `column: 0,`) — `PlacedCard` gains the required field and typecheck fails without it.

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

Run: `bun test test/strip-board.test.ts test/strip-cards.test.ts && bun test`
Expected: PASS — including the untouched `groupedAgentOrder` tests that call `packBoard` (their groups fit single columns) and the reduceBoard boundary test (13 sessions still make 2 pages: twelve singles fill page 1, the thirteenth opens page 2).
Then: `bun run typecheck && bunx biome check app/src/board.ts test/strip-board.test.ts test/strip-cards.test.ts`
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
git add app/src/board.ts test/strip-board.test.ts test/strip-cards.test.ts docs/design.md
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

### Task 4: Paging decisions — rubber-band offsets, the settle rule, session phases

**Goal:** a pure, DOM-free module owning every drag decision: the display offset (1:1 toward a real page, rubber-banded where none exists, clamped to one page of travel), the commit-or-snap-back settle rule (distance fraction OR direction-matched velocity fling, never toward a nonexistent page), and the drag-session phase machine whose non-idle phases defer snapshots.

**Files:**
- Create: `app/src/paging.ts`
- Create: `test/strip-paging.test.ts`

**Interfaces:**
- Consumes: nothing from the app (pure).
- Produces (Task 5 wires these; Task 8 animates from them): `COMMIT_FRACTION`, `COMMIT_VELOCITY_PX_PER_MS`, `RUBBER_BAND_FACTOR`; `type PageDirection = "previous" | "next"`; `type DragBounds = { canPrevious: boolean; canNext: boolean; boardWidth: number }`; `type DragSettle = { kind: "commit"; direction: PageDirection } | { kind: "snap-back" }`; `dragOffset(dx, bounds): number`; `settleDrag(dx, velocity, bounds): DragSettle`; `createPagingSession(): PagingSession` with `phase(): "idle" | "dragging" | "settling"`, `defersSnapshots(): boolean`, `start(bounds)`, `move(dx): number`, `release(dx, velocity): DragSettle`, `cancel(): DragSettle`, `settled()`.

- [ ] **Step 1: Write the failing tests**

Create `test/strip-paging.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  COMMIT_FRACTION,
  COMMIT_VELOCITY_PX_PER_MS,
  createPagingSession,
  type DragBounds,
  dragOffset,
  RUBBER_BAND_FACTOR,
  settleDrag,
} from "../app/src/paging";

const bounds = (overrides: Partial<DragBounds> = {}): DragBounds => ({
  canPrevious: true,
  canNext: true,
  boardWidth: 1000,
  ...overrides,
});

describe("dragOffset", () => {
  test("tracks the finger 1:1 toward an existing page", () => {
    expect(dragOffset(-320, bounds())).toBe(-320);
    expect(dragOffset(240, bounds())).toBe(240);
  });

  test("rubber-bands where no page exists — the give itself says nowhere to go", () => {
    expect(dragOffset(-320, bounds({ canNext: false }))).toBe(-320 * RUBBER_BAND_FACTOR);
    expect(dragOffset(240, bounds({ canPrevious: false }))).toBe(240 * RUBBER_BAND_FACTOR);
    // Resistance is per-direction: a missing previous page never stiffens next.
    expect(dragOffset(-320, bounds({ canPrevious: false }))).toBe(-320);
  });

  test("clamps to one page of travel", () => {
    expect(dragOffset(-1400, bounds())).toBe(-1000);
    expect(dragOffset(1400, bounds())).toBe(1000);
  });
});

describe("settleDrag", () => {
  test("commits past the distance threshold, in the displacement's direction", () => {
    expect(settleDrag(-COMMIT_FRACTION * 1000, 0, bounds())).toEqual({ kind: "commit", direction: "next" });
    expect(settleDrag(COMMIT_FRACTION * 1000, 0, bounds())).toEqual({ kind: "commit", direction: "previous" });
  });

  test("snaps back below the threshold without a fling", () => {
    expect(settleDrag(-COMMIT_FRACTION * 1000 + 1, 0, bounds())).toEqual({ kind: "snap-back" });
  });

  test("a direction-matched fling commits below the distance threshold", () => {
    expect(settleDrag(-40, -COMMIT_VELOCITY_PX_PER_MS, bounds())).toEqual({ kind: "commit", direction: "next" });
    expect(settleDrag(40, COMMIT_VELOCITY_PX_PER_MS, bounds())).toEqual({ kind: "commit", direction: "previous" });
  });

  test("a fling opposing the displacement does not commit", () => {
    expect(settleDrag(-200, COMMIT_VELOCITY_PX_PER_MS * 2, bounds())).toEqual({ kind: "snap-back" });
  });

  test("never commits toward a page that does not exist, however hard the fling", () => {
    expect(settleDrag(-900, -9, bounds({ canNext: false }))).toEqual({ kind: "snap-back" });
    expect(settleDrag(900, 9, bounds({ canPrevious: false }))).toEqual({ kind: "snap-back" });
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
    session.start(bounds());
    expect(session.phase()).toBe("dragging");
    expect(session.defersSnapshots()).toBe(true);
    expect(session.release(-400, 0)).toEqual({ kind: "commit", direction: "next" });
    expect(session.phase()).toBe("settling");
    expect(session.defersSnapshots()).toBe(true);
    session.settled();
    expect(session.phase()).toBe("idle");
    expect(session.defersSnapshots()).toBe(false);
  });

  test("move answers offsets only while dragging, under the session's bounds", () => {
    const session = createPagingSession();
    expect(session.move(-300)).toBe(0);
    session.start(bounds({ canNext: false }));
    expect(session.move(-300)).toBe(-300 * RUBBER_BAND_FACTOR);
  });

  test("cancel always settles as snap-back", () => {
    const session = createPagingSession();
    session.start(bounds());
    expect(session.cancel()).toEqual({ kind: "snap-back" });
    expect(session.phase()).toBe("settling");
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
 * display offsets, the commit-or-snap-back settle rule, and the drag-session
 * phases the driver keys rendering and snapshot deferral off. No DOM, no
 * timers — main.ts feeds recognizer intents and animation completion in.
 */

export type PageDirection = "previous" | "next";

/** Bring-up placeholders — Task 9 tunes all three on the physical strip. */
export const COMMIT_FRACTION = 0.25;
export const COMMIT_VELOCITY_PX_PER_MS = 0.6;
export const RUBBER_BAND_FACTOR = 0.3;

export type DragBounds = {
  canPrevious: boolean;
  canNext: boolean;
  /** The board viewport's width in CSS px — the commit fraction's base. */
  boardWidth: number;
};

export const dragDirection = (dx: number): PageDirection => (dx < 0 ? "next" : "previous");

/** 1:1 toward an existing page; rubber-banded where none exists; clamped to one page of travel. */
export const dragOffset = (dx: number, bounds: DragBounds): number => {
  const resisted = (dx < 0 && !bounds.canNext) || (dx > 0 && !bounds.canPrevious);
  const offset = resisted ? dx * RUBBER_BAND_FACTOR : dx;
  return Math.max(-bounds.boardWidth, Math.min(bounds.boardWidth, offset));
};

export type DragSettle = { kind: "commit"; direction: PageDirection } | { kind: "snap-back" };

export const settleDrag = (dx: number, velocity: number, bounds: DragBounds): DragSettle => {
  if (dx === 0) {
    return { kind: "snap-back" };
  }
  const direction = dragDirection(dx);
  if (direction === "next" ? !bounds.canNext : !bounds.canPrevious) {
    return { kind: "snap-back" };
  }
  const past = Math.abs(dx) >= bounds.boardWidth * COMMIT_FRACTION;
  const flung = Math.sign(velocity) === Math.sign(dx) && Math.abs(velocity) >= COMMIT_VELOCITY_PX_PER_MS;
  return past || flung ? { kind: "commit", direction } : { kind: "snap-back" };
};

export type PagingPhase = "idle" | "dragging" | "settling";

export type PagingSession = {
  phase: () => PagingPhase;
  /** Snapshots defer while a gesture or its settle animation owns the board. */
  defersSnapshots: () => boolean;
  start: (bounds: DragBounds) => void;
  /** Display offset for the finger displacement; 0 when not dragging. */
  move: (dx: number) => number;
  release: (dx: number, velocity: number) => DragSettle;
  /** Pointer cancellation or leaving the window: always snaps back. */
  cancel: () => DragSettle;
  /** The settle animation finished (or was skipped): back to rest. */
  settled: () => void;
};

export const createPagingSession = (): PagingSession => {
  let phase: PagingPhase = "idle";
  let bounds: DragBounds = { canPrevious: false, canNext: false, boardWidth: 0 };
  return {
    phase: () => phase,
    defersSnapshots: () => phase !== "idle",
    start: (next) => {
      phase = "dragging";
      bounds = next;
    },
    move: (dx) => (phase === "dragging" ? dragOffset(dx, bounds) : 0),
    release: (dx, velocity) => {
      if (phase !== "dragging") {
        return { kind: "snap-back" };
      }
      phase = "settling";
      return settleDrag(dx, velocity, bounds);
    },
    cancel: () => {
      if (phase === "dragging") {
        phase = "settling";
      }
      return { kind: "snap-back" };
    },
    settled: () => {
      phase = "idle";
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
git commit -m "feat(app): pure paging drag decisions - offsets, settle rule, session phases"
```

---

### Task 5: Recognizer axis lock and the drag intent stream; the driver rewires paging

**Goal:** the recognizer classifies by axis lock during the stroke instead of at release: horizontal dominance past a small threshold on a board-born stroke starts a paging drag (streamed `drag-move` dx, `drag-end` with a trailing-window velocity, `drag-cancel` on cancellation), and once locked, tap, long-press, and vertical outcomes are suppressed for that touch; vertical-dominant strokes fall through to today's behavior unchanged. The old release-time `swipe` intent and its constants are deleted. The driver feeds the paging session, defers snapshots during a gesture, and (interim, until Task 8's visuals) applies commits as instant jumps.

**Files:**
- Modify: `app/src/gestures.ts` (module docstring 1–8, `GestureInput`/`GestureIntent` 12–31, `Stroke`/recognizer 33–127)
- Modify: `app/src/main.ts` (imports; module state near line 93; `ingest` at 313; `onSwipe`/`handleGestureIntents` at 648–684; `onStripPointerDown` at 708; `wireInteraction` at 783)
- Test: `test/strip-gestures.test.ts`

**Interfaces:**
- Consumes: `createPagingSession`/`DragBounds` from Task 4.
- Produces: `GestureInput`'s `down` gains `readonly pageable: boolean` (the caller judges the zone; the recognizer stays DOM-free). `GestureIntent` gains `{ kind: "drag-start" }`, `{ kind: "drag-move"; dx }`, `{ kind: "drag-end"; dx; velocity }` (velocity in px/ms, signed like dx), `{ kind: "drag-cancel" }`; `{ kind: "swipe" }` is deleted, as are `SWIPE_MIN_HORIZONTAL_PX`/`SWIPE_MAX_VERTICAL_PX`. New constants `DRAG_LOCK_MIN_PX = 16`, `VELOCITY_WINDOW_MS = 100`. Task 8 consumes the same intents for visuals; tests reference constants symbolically so Task 9 tuning stays green.

- [ ] **Step 1: Write the failing tests (and update the broken premises)**

In `test/strip-gestures.test.ts`:

**(a)** Update the helper and imports — `down` gains `pageable` (default true), the import list swaps `SWIPE_MIN_HORIZONTAL_PX` for `DRAG_LOCK_MIN_PX`:

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
} from "../app/src/gestures";

const down = (x: number, y: number, now: number, pageable = true): GestureInput => ({
  kind: "down",
  point: { x, y },
  now,
  pageable,
});
```

**(b)** REPLACE the whole `describe("swipe classification", …)` block with:

```ts
describe("drag axis lock", () => {
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
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(360, 300, 40));
    recognizer.feed(move(300, 300, 100));
    // The 100ms window anchors at the t=100 sample: (200-300)/(160-100).
    expect(recognizer.feed(up(200, 300, 160))).toEqual([
      { kind: "drag-end", dx: -200, velocity: (200 - 300) / (160 - 100) },
      { kind: "suppress-click" },
    ]);
  });

  test("release-position fallback: a horizontal release locks even without move samples", () => {
    // Pointermove delivery is not guaranteed (coalesced or dropped): the
    // final position alone must still produce a drag, settled by distance
    // (no samples in the window means velocity 0).
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    expect(recognizer.feed(up(400 - DRAG_LOCK_MIN_PX - 10, 302, 200))).toEqual([
      { kind: "drag-end", dx: -(DRAG_LOCK_MIN_PX + 10), velocity: 0 },
      { kind: "suppress-click" },
    ]);
  });

  test("a stroke born off the board never drags, moving or at release", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0, false));
    expect(recognizer.feed(move(200, 300, 60))).toEqual([]);
    expect(recognizer.feed(up(180, 300, 120))).toEqual([{ kind: "suppress-click" }]);
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
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(420, 320, 40));
    expect(recognizer.feed(move(300, 320, 80))).toEqual([]);
    expect(recognizer.feed(up(280, 320, 120))).toEqual([{ kind: "suppress-click" }]);
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
    recognizer.feed(move(340, 300, 40));
    expect(recognizer.feed(context(340, 300, 50))).toEqual([]);
    expect(recognizer.feed(tick(LONG_PRESS_MS))).toEqual([]);
    expect(recognizer.feed(up(340, 300, LONG_PRESS_MS + 40))[0]?.kind).toBe("drag-end");
  });

  test("cancel mid-drag emits drag-cancel; cancel without a lock stays silent", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(340, 300, 40));
    expect(recognizer.feed({ kind: "cancel", now: 80 })).toEqual([{ kind: "drag-cancel" }]);
    recognizer.feed(down(400, 300, 200));
    expect(recognizer.feed({ kind: "cancel", now: 240 })).toEqual([]);
  });

  test("a drag returning to its origin still ends as a drag — visible snap-back, not a tap", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(340, 300, 40));
    recognizer.feed(move(398, 300, 90));
    expect(recognizer.feed(up(400, 300, 130))).toEqual([
      { kind: "drag-end", dx: 0, velocity: (400 - 340) / (130 - 40) },
      { kind: "suppress-click" },
    ]);
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

The flick describe and the remaining long-press/context/suppression tests stay verbatim — they pin the fall-through the spec requires.

- [ ] **Step 2: Run tests to verify the red phase**

Run: `bun test test/strip-gestures.test.ts`
Expected: every test in `"drag axis lock"` FAILS (no `DRAG_LOCK_MIN_PX` export — the file fails to import; after a stub export, the drag intents don't exist). The retargeted tests and all kept tests must pass once the implementation lands; they are listed here so the executor updates them in the same change.

- [ ] **Step 3: Implement the recognizer**

In `app/src/gestures.ts`:

**(a)** Docstring (lines 1–8): replace `emitting intents. Tap routing stays with the existing click handler; the recognizer only decides when a stroke was something else (long-press or swipe) and when the trailing click must be swallowed.` with `emitting intents. Tap routing stays with the existing click handler; the recognizer decides when a stroke locks into a paging drag (streaming drag intents), when it was something else (long-press or flick), and when the trailing click must be swallowed.`

**(b)** Types and constants:

```ts
export type GestureInput =
  | { readonly kind: "down"; readonly point: GesturePoint; readonly now: number; readonly pageable: boolean }
  | { readonly kind: "move"; readonly point: GesturePoint; readonly now: number }
  | { readonly kind: "up"; readonly point: GesturePoint; readonly now: number }
  | { readonly kind: "cancel"; readonly now: number }
  | { readonly kind: "tick"; readonly now: number }
  | { readonly kind: "context"; readonly point: GesturePoint; readonly now: number };

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
/** Axis-lock threshold — a locked drag has always already killed the long-press (16 > MOVE_SLOP_PX). Tuned on device. */
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
  /** Board-born strokes may lock into a paging drag; rail-born never do. */
  readonly pageable: boolean;
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

**(d)** The `feed` cases (`longPressDueAt` is unchanged — a locked drag has `moved: true`, so it already answers null):

```ts
      case "down": {
        if (stroke !== null) {
          return []; // a second finger's down is ignored mid-stroke
        }
        stroke = {
          start: input.point,
          deadline: input.now + LONG_PRESS_MS,
          pageable: input.pageable,
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
          if (Math.abs(dx) > Math.abs(dy) && stroke.pageable) {
            stroke.dragging = true;
            return [{ kind: "drag-start" }, { kind: "drag-move", dx }];
          }
          if (Math.abs(dy) >= Math.abs(dx)) {
            stroke.verticalLocked = true;
          }
        }
        return stroke.dragging ? [{ kind: "drag-move", dx }] : [];
      }
      case "tick": {
        if (stroke !== null && !stroke.moved && !stroke.longPressed && input.now >= stroke.deadline) {
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
          (finished.pageable && !finished.verticalLocked && Math.abs(dx) >= DRAG_LOCK_MIN_PX && Math.abs(dx) > Math.abs(dy));
        if (horizontal) {
          return [
            { kind: "drag-end", dx, velocity: releaseVelocity(finished.samples, input.point.x, input.now) },
            { kind: "suppress-click" },
          ];
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

**(a)** Imports: add `createPagingSession` from `./paging`; the gestures import list is unchanged (the `swipe` intent was a type member, not an import).

**(b)** Module state, beside `const gestures = createGestureRecognizer();`:

```ts
const pagingSession = createPagingSession();
let deferredPayload: { payload: SnapshotPayload | null } | null = null;
```

**(c)** Snapshot deferral — `ingest` gains an early return, and a flusher lands after it:

```ts
const ingest = (payload: SnapshotPayload | null): void => {
  if (pagingSession.defersSnapshots()) {
    // The finger owns the board: a snapshot never repacks or re-renders the
    // board, peek, or pips mid-gesture. The newest payload applies at settle.
    deferredPayload = { payload };
    return;
  }
  lastPayload = payload;
  // … existing body unchanged …
};

const flushDeferredIngest = (): void => {
  if (deferredPayload !== null) {
    const { payload } = deferredPayload;
    deferredPayload = null;
    ingest(payload);
  }
};
```

**(d)** The paging zone — above `onStripPointerDown`:

```ts
/** The paging surface: strokes born on the board page. The rail never pages. */
const pageableAt = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && target.closest("#board") !== null;
```

(Task 7 widens the selector to `#pager` when the peek band exists.) `onStripPointerDown`'s feed becomes:

```ts
  feedPointer({
    kind: "down",
    point: { x: event.clientX, y: event.clientY },
    now: Date.now(),
    pageable: pageableAt(event.target),
  });
```

**(e)** Replace `onSwipe` (delete it) with the board-width helper, and replace the `case "swipe"` in `handleGestureIntents` with the four drag cases:

```ts
/** The commit fraction's base. Task 7 retargets this to #board-viewport. */
const boardRegionWidth = (): number => document.querySelector<HTMLElement>("#board")?.clientWidth ?? 0;
```

```ts
      case "drag-start":
        pagingSession.start({
          canPrevious: currentPage > 0,
          canNext: currentPage < currentPageCount - 1,
          boardWidth: boardRegionWidth(),
        });
        break;
      case "drag-move":
        pagingSession.move(intent.dx); // the display offset drives the track from Task 8
        break;
      case "drag-end": {
        // Interim until the drag-follow track lands (Task 8): a commit jumps
        // immediately, a snap-back is a no-op — the drag pipeline already
        // replaces release-time swipe classification end to end.
        const settle = pagingSession.release(intent.dx, intent.velocity);
        pagingSession.settled();
        if (settle.kind === "commit") {
          jumpToPage(currentPage + (settle.direction === "next" ? 1 : -1));
        }
        flushDeferredIngest();
        break;
      }
      case "drag-cancel":
        pagingSession.cancel();
        pagingSession.settled();
        flushDeferredIngest();
        break;
```

**(f)** Leaving the window snaps back — in `wireInteraction`, after the `pointercancel` line:

```ts
  strip?.addEventListener("pointerleave", onStripPointerCancel);
```

(`#strip` spans the whole window, so leaving it is leaving the window; a post-release leave feeds a cancel into an empty recognizer, which is a no-op. The sheet-open case needs no wiring: the fixed overlay lives outside `#strip`, so no pointer event during a sheet reaches these handlers at all.)

- [ ] **Step 5: Run tests and gates**

Run: `bun test test/strip-gestures.test.ts && bun test && bun run typecheck && bun run build:app && bunx biome check app/src/gestures.ts app/src/main.ts test/strip-gestures.test.ts`
Expected: PASS — the full suite, both tsconfigs (the `swipe` case removal must leave no dead references), and the app bundle.

- [ ] **Step 6: Commit**

```bash
git add app/src/gestures.ts app/src/main.ts test/strip-gestures.test.ts
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

**Goal:** the strip becomes `pager (viewport+peek) | pips | rail` on fixed tracks: the board gutter grows 16 → 40 native px, the 54px peek band and 22px pip column exist on every page (constant geometry — content visibility rides `data-present`), the rail narrows 760 → 638 native px and loses its pager (`.rail-pager`/`.page-dot` deleted, `RailModel` slims), and the driver renders the indicators and wires the three tap surfaces (peek → forward, gutter band → back, pips → jump).

**Files:**
- Modify: `app/index.html` (the `#strip` shell)
- Modify: `app/styles.css` (`#strip` at 15–21, `#board` at 31–44, the `.rail-pager`/`.page-dot` block at 663–679; new band/pip/sliver blocks)
- Modify: `app/src/rail.ts` (docstring 1–8, `RailModel` 33–42, `RailActions` 44–47, `pagerSection` 172–185, `railRenderSignature` 321–343, `renderRail` 345–358)
- Modify: `app/src/main.ts` (`jumpToPage`/`renderRailNow` at 126–160, `applyBoard` at 235, `pageableAt`, `wireInteraction`)
- Modify: `docs/design.md` ("Strip layout" line 80, "Rail contract" line 122, "Interaction" line 141)
- Test: `test/strip-rail.test.ts`

**Interfaces:**
- Consumes: Task 6's renderers and `indicatorsRenderSignature`; the existing `jumpToPage` (clamped by `jumpBoard`).
- Produces: static shell ids `#pager`, `#board-viewport`, `#board-track`, `#return-band`, `#peek-band`, `#pips`; `#board` gains class `board-grid` (the grid rules move to the class so Task 8's adjacent pages reuse them). `renderRail(root, model)` — two parameters, `RailActions` gone, `RailModel` without `page`/`pageCount`. Task 8 relies on `#board-viewport` (clip) and `#board-track` (transform).

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
Expected: the new test FAILS — pre-change `renderRail` takes three arguments; the missing `actions` makes `pagerSection` throw (and the child list would still carry `rail-pager`).

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
      <aside id="rail"></aside>
    </main>
```

In `app/styles.css` (native px converted at 2560×720: px / 25.6 = vw, px / 7.2 = vh):

**(a)** `#strip` columns become pager | pips | rail:

```css
#strip {
  display: grid;
  grid-template-columns: 1fr 0.859vw 24.9219%; /* board+peek | 22px pip band | 638px rail */
  height: 100vh;
  touch-action: none;
  -webkit-touch-callout: none;
}
#pager {
  display: grid;
  grid-template-columns: 1fr 2.109vw; /* viewport | 54px peek band */
  min-width: 0;
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

**(c)** `pageableAt` widens to the pager (board + peek — the peek is the incoming page's drag affordance; pips and rail stay out):

```ts
const pageableAt = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && target.closest("#pager") !== null;
```

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

**Goal:** the board physically follows the finger: `#board-track` translates by the session's offset, both existing neighbor pages mount as transient grids at gutter-overlap spacing (the incoming column rises exactly under the peek slivers), release animates to commit or snap-back (a failed swipe is motion-and-return, never a silent no-op), and settle applies any deferred snapshot. Rubber-band drags render no adjacent page — the resisted give itself is the "nowhere to go" signal.

**Files:**
- Modify: `app/src/main.ts` (the drag cases in `handleGestureIntents`; new track/adjacent helpers)
- Modify: `app/styles.css` (track transform, `.board-adjacent` placement)

**Interfaces:**
- Consumes: `PagingSession` and `DragSettle` from Task 4; `renderBoard` (already generic over its root — adjacent grids are throwaway renders with no keys shared with `#board`, no tickers, no pulses); `.board-grid` from Task 7.
- Produces: driver-only behavior. No new exports. The pure decision layer is fully covered by Task 4/5 tests; this task is deliberately thin wiring (matching the repo's untested-driver convention for `main.ts`) and its behavior is receipted on glass in Task 9.

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
 * fallback timer covers a transitionend that never fires (an already-at-rest
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
    pagingSession.settled();
    if (settle.kind === "commit") {
      jumpToPage(currentPage + (settle.direction === "next" ? 1 : -1));
    }
    setTrackOffset(0, false);
    unmountAdjacentPages();
    flushDeferredIngest();
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
      case "drag-start":
        pagingSession.start({
          canPrevious: currentPage > 0,
          canNext: currentPage < currentPageCount - 1,
          boardWidth: boardRegionWidth(),
        });
        mountAdjacentPages();
        setTrackOffset(0, false);
        break;
      case "drag-move":
        setTrackOffset(pagingSession.move(intent.dx), false);
        break;
      case "drag-end":
        finishSettle(pagingSession.release(intent.dx, intent.velocity));
        break;
      case "drag-cancel":
        finishSettle(pagingSession.cancel());
        break;
```

(The Task 5 interim path called `settled()`/`flushDeferredIngest()` inline; both now live inside `finishSettle`'s `done`.)

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
Expected: PASS — no unit red phase exists for this task (driver + CSS only; the decisions it animates are Task 4/5's tested surface), which is why its behavioral acceptance is Task 9's on-glass receipt, not an assertion here.

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

Record **pass/fail plus a one-line observation per item**; include the completed receipt in the completion report. If the strip hardware is unavailable, say so explicitly and leave this task open — do not mark it done.

1. **Original complaint dead:** with the kickoff shape (five singles + a nine-card orchestrator group), page 1 has no empty column, the group visibly continues (peek slivers + "↩ cont." on page 2), and swiping to page 2 works with the board following the finger.
2. **Failed swipe visible:** a below-threshold drag moves and snaps back — motion-and-return, never a silent no-op.
3. **Zone scoping:** a drag starting on the rail never pages and never moves the rail; a drag starting on any card or blank board space pages.
4. **Axis coexistence:** vertical dismiss flicks still work on cards; a locked horizontal drag never opens the action sheet (hold mid-drag) and never flicks.
5. **Mid-drag stability:** hold a drag through a snapshot heartbeat (~5s) — cards do not repack or shift under the finger; the pending state applies at settle.
6. **Constant geometry:** cards sit at identical positions on page 1 (no return sliver) and page 2 (sliver present); no card shifts when peek/pips appear or disappear.
7. **Peek continuity:** during a next-drag the incoming column rises out of the peek slivers' position; live status colors and unread dots match the cards that arrive.
8. **[user-decides] Return sliver legibility:** the 14px slivers register at arm's length as "a page lives this way". If not, grow the sliver width (and the faint-edge alpha) and re-check.
9. **[user-decides] Pip mini-dot legibility:** the 9px amber/blue corner dots read at arm's length. If not, grow `.pip-mini` to 12–14px native and re-check.
10. **Pip behavior:** current pip enlarged/lit and clean; unread page shows amber over blue; taps (including slightly-off taps — the invisible slop) jump correctly; pips absent with one page.
11. **Rail fit at 638px:** tokens, sparkline, unread line, and every quota meter render without wrapping or clipping — including the longest realistic quota note beside its percent (force one by checking during a stale/unavailable window, e.g. `1h+ old · 55%`). If anything clips, STOP and take the note-abbreviation question to Drew (the spec's named fallback) rather than deciding silently.
12. **Degraded honesty:** stop the daemon; after OFFLINE the indicators render from the same last-good snapshot as the cards and paging stays available; an empty board hides all indicator content.
13. **Peek is not viewing:** a page with unread sitting visible in the peek keeps its unread state until actually visited.

- [ ] **Step 4: Commit the tuned constants**

```bash
git add app/src/gestures.ts app/src/paging.ts app/styles.css
git commit -m "feat(app): tune paging gesture and indicator constants on the strip"
```

(Skip the commit only if every placeholder survived tuning unchanged and no CSS moved; say so in the report either way.)

---

### Task 10: Remove the diagnostic; final gates

**Goal:** the spec's observability contract — the bring-up diagnostic is removable and no permanent logging lands. Delete the module, its test (part of the ratified removable instrumentation, not a silent test deletion), its wiring, and its CSS; then run the full CI gate.

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

- [ ] **Step 3: Commit**

```bash
git add -u app/src/diagnostic.ts test/strip-diagnostic.test.ts app/src/main.ts app/styles.css
git commit -m "chore(app): remove bring-up pointer diagnostic"
```

---

## Spec coverage map

| Spec requirement | Task(s) |
| --- | --- |
| Diagnostic-first: localize the swipe failure to delivery / recognition / navigation / render; gates threshold tuning | 1 (module + receipt + decision gate), 9 (tuning precondition), 10 (removal — "no permanent logging") |
| Swipe zone is the board region only; rail takes no handlers, never moves | 5 (`pageable` on down + off-board tests; rail excluded from zone), 7 (`#pager` zone), 9 (#3) |
| Drag-follow with snap-back; ~25% / velocity commit; failure is motion-and-return | 4 (settle/offset tests), 5 (drag intent stream), 8 (track + animations), 9 (#1, #2 + tuning) |
| Gesture arbitration by axis lock; locked touch suppresses tap/long-press/vertical; vertical falls through unchanged | 5 (axis-race, context/tick suppression, fall-through tests; flick tests kept verbatim) |
| No paging gesture while the action sheet is open; cancel / window-leave snaps back | Interpretation 6 (structural overlay) + 5 (`drag-cancel` test, `pointerleave` wiring), 8 (cancel settles as snap-back) |
| Snapshots defer during a drag; latest pending applies at settle | 4 (phase tests), 5 (`ingest` deferral + flush), 8 (flush in `finishSettle`), 9 (#5) |
| Constant geometry: 40px gutter on every page; cards never shift with indicators | 7 (fixed tracks, visibility-not-collapse, gutter padding), 9 (#6) |
| Return sliver: 14px row-aligned, surface + faint status edge, absent on page 1; jump-back tap target | 6 (`returnSliverModel`, dot-free renderer), 7 (CSS + gutter-wide tap), 9 (#8) |
| Next-page peek: 54px row-aligned slivers, dimmed sub/primary surfaces, status edges, unread dots, absent on last page; drag continuity; page-level tap; sliver rows never interactive, never in card-index routing | 6 (`peekModel`, renderer + no-card-index/no-text tests), 7 (CSS + tap), 8 (gutter-overlap continuity), 9 (#7) |
| Pip column: one per page, current enlarged/lit and clean, amber-over-blue minis from the cards' own view-model bits, current-snapshot-only, tap-to-jump with slop, hidden at one page | 6 (`pipColumnModel` + renderer tests, `cardShowsUnread` single source), 7 (CSS incl. 54×56 hit), 9 (#9, #10) |
| Rail narrows to 638px; content fits; `.rail-pager`/`.page-dot` deleted | 7 (grid + CSS deletion + rail slimming), 9 (#11 fit check, abbreviation fallback escalates to Drew) |
| Packing: fill-and-continue, first-fit unchanged, sequence-general, every page but the last full, kickoff renders with no empty column | 2 (invariant + kickoff + sequence tests) |
| Continuation marker on each page break; column breaks unmarked; marker carries group identity (last-slot parent case) | 2 (`continuation` bit + tests), 3 ("↩ cont." tag) |
| Page identity = clamped index; no per-page persisted state | Unchanged `reduceBoard`/`jumpBoard` (existing clamp tests stay green); indicators derive from `(pages, currentPage)` only |
| Peek visibility is not viewing; unread/ack semantics unchanged | 6 (renderers wire only `onJumpToPage` — no ack path exists), 9 (#13) |
| Degraded renders indicators from last-good; OFFLINE/empty hides them | 6 (models ignore `degraded`, empty pages → `data-present="false"`), 9 (#12) |
| Single page: no indicators, gutter remains, rubber-band both directions | 4 (per-direction resistance tests), 6 (hidden models), 9 (#3 of Step 2) |
| On-glass acceptance (golden question): sliver + mini-dot legibility, rail fit — physical-strip receipt | 9 (REQUIRED receipt; user-decides items are explicit checks #8, #9, #11) |
| Cross-spec: retention coexistence via axis lock | 5 (vertical fall-through pinned; flick tests untouched), header cross-spec note |
