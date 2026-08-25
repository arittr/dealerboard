# Strip Board Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the strip's square-tile grid + 32% rail with a parent-grouped board of wide session cards and a 496px rail carrying a day-over-day token sparkline and compact quota rows.

**Architecture:** A new pure board reducer (`app/src/board.ts`) turns the projected sessions into parent-grouped, group-atomically packed pages; a card renderer (`app/src/cards.ts`) replaces the tile renderer; the rail gains a two-line sparkline fed by new `dayCurves` data the daemon's token-usage collector publishes additively (schemaVersion stays 1). The keypad plugin and shared `reduceLayout` are untouched — the strip stops consuming `reduceLayout`'s paging.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` → bracket access), Bun test, Biome, DOM via `document.createElement` only (`textContent`, never `innerHTML`), Tauri webview.

**Spec:** `docs/superpowers/specs/2026-08-25-strip-board-redesign-design.md` — read it first; the committed mockup `docs/superpowers/specs/assets/2026-08-25-strip-board/d6.html` is the visual contract of record for proportions, colors, and CSS treatments (copy values from it rather than inventing).

## Global Constraints

- Style: 2 spaces, double quotes, semicolons, 120 columns; Biome strict (`noExplicitAny`, `noConsole`, `noProcessEnv`, `noDefaultExport`, `noNonNullAssertion` — relaxed in `test/**`, `noFloatingPromises`, bracket access for index signatures).
- Status colors locked: working `#20B8FF`, waiting `#FFB020`, idle `#4ADE80`, error `#FF4D67`, neutral `#94A3B8`; provider chip hues per `PROVIDER_COLORS` in `src/plugin/render.ts`; Paseo violet `#A78BFA`.
- All text via `textContent`; SVG elements via `createElementNS`.
- Native-pixel dimensions in this plan assume 2560×720; CSS uses viewport-relative units (1px native = 0.0390625vw = 0.1389vh). The mockup d6.html already carries correct values — copy them.
- The keypad plugin, `src/protocol.ts`, `quota-snapshot.json`, membership/ack semantics: DO NOT TOUCH.
- agentsview output is never logged or persisted beyond the snapshot.
- TDD every task: failing test → run → minimal code → pass → commit. Run a task's test file with `bun test test/<file>.test.ts`; the full gate is `bun run check`.
- Commit after every task with the shown message; never `git add -A`.

---

### Task 1: Grouped ordering (`groupedOrder`)

**Files:**
- Create: `app/src/board.ts`
- Modify: `src/plugin/layout.ts` (export `labelForSession`)
- Test: `test/strip-board.test.ts`

**Interfaces:**
- Consumes: `ProjectedSession` from `src/protocol.ts` (fields `originKind`, `originSubagent`, `originRef`, `originParentRef`, `logicalSlot`, `project`); `labelForSession` from `src/plugin/layout.ts`.
- Produces: `type BoardCardSeed = { session: ProjectedSession; label: string; subagent: boolean; parentProject: string | null }`, `type BoardGroup = { cards: BoardCardSeed[]; orphanTail: boolean }`, `groupedOrder(sessions: readonly ProjectedSession[]): BoardGroup[]`. Task 2 packs these.

- [ ] **Step 1: Export the shared label chain**

In `src/plugin/layout.ts` change `const labelForSession` to `export const labelForSession` (line 71). No other change.

- [ ] **Step 2: Write the failing tests**

Create `test/strip-board.test.ts`. Build a session factory like `test/tiles.test.ts:13-37` (same `ProjectedSession` shape), plus helpers:

```ts
import { describe, expect, test } from "bun:test";
import { type BoardGroup, groupedOrder } from "../app/src/board";
import type { ProjectedSession } from "../src/protocol";

const session = (slot: number, overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: `s${slot}`,
  project: null,
  title: `t${slot}`,
  model: null,
  status: "working",
  originKind: null,
  originRef: null,
  originSubagent: false,
  unreadSince: null,
  statusSince: null,
  activityLine: null,
  transcriptPath: null,
  originParentRef: null,
  ghosttyTerminalId: null,
  descendantCount: 0,
  logicalSlot: slot,
  ...overrides,
});

const parent = (slot: number, ref: string, overrides: Partial<ProjectedSession> = {}): ProjectedSession =>
  session(slot, { originKind: "paseo", originRef: ref, ...overrides });

const sub = (slot: number, ref: string, parentRef: string | null, overrides: Partial<ProjectedSession> = {}): ProjectedSession =>
  session(slot, { originKind: "paseo", originRef: ref, originSubagent: true, originParentRef: parentRef, ...overrides });

const ids = (group: BoardGroup): string[] => group.cards.map((card) => card.session.sessionId);
```

Tests:

```ts
describe("groupedOrder", () => {
  test("primaries in slot order, each followed by its subs in slot order", () => {
    const groups = groupedOrder([sub(4, "b1", "a2"), parent(2, "a2"), parent(1, "a1"), sub(3, "b2", "a2")]);
    expect(groups.map(ids)).toEqual([["s1"], ["s2", "s3", "s4"]]);
    expect(groups[1]?.cards[1]?.subagent).toBe(true);
    expect(groups[1]?.orphanTail).toBe(false);
  });

  test("nested subs flatten to the primary's group, directly after their own parent", () => {
    // primary a ← sub b ← sub c; sibling sub d of a with a later slot than b
    const groups = groupedOrder([parent(1, "a"), sub(2, "b", "a"), sub(4, "d", "a"), sub(3, "c", "b")]);
    expect(groups.map(ids)).toEqual([["s1", "s2", "s3", "s4"]]);
  });

  test("subs with no on-grid ancestor collect in one orphan tail group, slot order", () => {
    const groups = groupedOrder([sub(3, "x", "gone"), parent(1, "a"), sub(2, "y", null)]);
    expect(groups.map(ids)).toEqual([["s1"], ["s2", "s3"]]);
    expect(groups[1]?.orphanTail).toBe(true);
    expect(groups[1]?.cards.every((card) => card.subagent)).toBe(true);
  });

  test("a parent-ref cycle among subs orphans the cycle instead of looping", () => {
    const groups = groupedOrder([sub(1, "x", "y"), sub(2, "y", "x")]);
    expect(groups.map(ids)).toEqual([["s1", "s2"]]);
    expect(groups[0]?.orphanTail).toBe(true);
  });

  test("grouped subs carry the anchoring primary's project for suppression; orphans carry null", () => {
    const groups = groupedOrder([parent(1, "a", { project: "repo" }), sub(2, "b", "a", { project: "repo" }), sub(3, "x", null)]);
    expect(groups[0]?.cards[1]?.parentProject).toBe("repo");
    expect(groups[1]?.cards[0]?.parentProject).toBeNull();
  });

  test("the early lineage hop: an unstamped Paseo session sits primary, the stamped re-projection regroups it", () => {
    // Before the overlay pass the row has kind/ref only (origin.ts stamps no
    // subagent bit at ingest); the next snapshot carries the stamp.
    const before = groupedOrder([parent(1, "a"), parent(2, "b")]);
    expect(before.map(ids)).toEqual([["s1"], ["s2"]]);
    const after = groupedOrder([parent(1, "a"), sub(2, "b", "a")]);
    expect(after.map(ids)).toEqual([["s1", "s2"]]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/strip-board.test.ts`
Expected: FAIL — cannot resolve `../app/src/board`.

- [ ] **Step 4: Implement `groupedOrder`**

Create `app/src/board.ts`:

```ts
/**
 * Pure grouped-board reducer for the strip: parent-grouped ordering (subagents
 * attach under their nearest on-grid Paseo ancestor, orphans form one tail
 * block), group-atomic page packing, and validated page settings. No DOM, no
 * I/O; the rendering layer is app/src/cards.ts and the driver app/src/main.ts.
 */

import { labelForSession } from "../../src/plugin/layout";
import type { ProjectedSession } from "../../src/protocol";

export type BoardCardSeed = {
  session: ProjectedSession;
  label: string;
  subagent: boolean;
  /** Anchoring primary's project, for meta-line suppression; null for primaries and orphans. */
  parentProject: string | null;
};

export type BoardGroup = { cards: BoardCardSeed[]; orphanTail: boolean };

const isPaseoSubagent = (session: ProjectedSession): boolean =>
  session.originKind === "paseo" && session.originSubagent;

export const groupedOrder = (sessions: readonly ProjectedSession[]): BoardGroup[] => {
  const ordered = [...sessions].sort((a, b) => a.logicalSlot - b.logicalSlot);
  const primaries = ordered.filter((entry) => !isPaseoSubagent(entry));
  const subs = ordered.filter(isPaseoSubagent);

  const byRef = new Map<string, ProjectedSession>();
  for (const entry of ordered) {
    if (entry.originKind === "paseo" && entry.originRef !== null) {
      byRef.set(entry.originRef, entry);
    }
  }

  // A sub anchors to the primary at the top of its on-grid parent chain; a
  // missing link, null ref, or cycle orphans it (the chain cannot be followed
  // through rows the grid does not have).
  const childrenOf = new Map<string, ProjectedSession[]>();
  const orphans: ProjectedSession[] = [];
  for (const entry of subs) {
    let anchored = false;
    const visited = new Set<string>();
    let ref = entry.originParentRef;
    while (ref !== null && !visited.has(ref)) {
      visited.add(ref);
      const link: ProjectedSession | undefined = byRef.get(ref);
      if (link === undefined) {
        break;
      }
      if (!isPaseoSubagent(link)) {
        anchored = true;
        break;
      }
      ref = link.originParentRef;
    }
    if (anchored && entry.originParentRef !== null) {
      const list = childrenOf.get(entry.originParentRef) ?? [];
      list.push(entry);
      childrenOf.set(entry.originParentRef, list);
    } else {
      orphans.push(entry);
    }
  }

  const groups: BoardGroup[] = primaries.map((primary) => {
    const cards: BoardCardSeed[] = [
      { session: primary, label: labelForSession(primary), subagent: false, parentProject: null },
    ];
    const walk = (ref: string | null): void => {
      if (ref === null) {
        return;
      }
      for (const child of childrenOf.get(ref) ?? []) {
        cards.push({ session: child, label: labelForSession(child), subagent: true, parentProject: primary.project });
        walk(child.originRef);
      }
    };
    walk(primary.originRef);
    return { cards, orphanTail: false };
  });

  if (orphans.length > 0) {
    groups.push({
      cards: orphans.map((entry) => ({
        session: entry,
        label: labelForSession(entry),
        subagent: true,
        parentProject: null,
      })),
      orphanTail: true,
    });
  }
  return groups;
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/strip-board.test.ts` — expected: PASS. Also `bun test test/layout.test.ts` (the export change must not break it) and `bun run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add app/src/board.ts src/plugin/layout.ts test/strip-board.test.ts
git commit -m "feat(strip): grouped board ordering with nested flattening and orphan tail"
```

---

### Task 2: Group-atomic packing and `reduceBoard`

**Files:**
- Modify: `app/src/board.ts`, `src/plugin/layout.ts` (export the settings validator)
- Test: `test/strip-board.test.ts`

**Interfaces:**
- Consumes: Task 1's `BoardGroup`; `LayoutSettingsV1`, `DEFAULT_LAYOUT_SETTINGS` from `src/plugin/layout.ts`; `SnapshotView` from `src/protocol.ts`.
- Produces (Tasks 3/9 rely on these exact shapes):

```ts
export const BOARD_COLUMNS = 2;
export const BOARD_ROWS = 6;
export type SpineSegment = "none" | "mid" | "end";
export type PlacedCard = BoardCardSeed & {
  degraded: boolean;
  indent: boolean;
  spine: SpineSegment;
  column: number; // 0-based
  row: number; // 0-based
};
export type BoardPage = { cards: PlacedCard[] };
export type BoardResult = { settings: LayoutSettingsV1; dirty: boolean; pages: BoardPage[]; pageCount: number };
export const packBoard = (groups: readonly BoardGroup[], degraded: boolean): BoardPage[];
export const reduceBoard = (view: SnapshotView, storedState: unknown): BoardResult;
```

- [ ] **Step 1: Export the settings validator**

In `src/plugin/layout.ts`, rename the private `validateStoredSettings` (line 123) to `export const validateLayoutSettings` and export the `ValidatedSettings` type (`export type ValidatedSettings = { settings: LayoutSettingsV1; defaulted: boolean }`). Update its two internal call sites in `reduceInternal`.

- [ ] **Step 2: Write the failing packing tests**

Append to `test/strip-board.test.ts` (reuse the factories; a group helper builds `BoardGroup`s directly):

```ts
import { BOARD_ROWS, type BoardGroup, packBoard, reduceBoard } from "../app/src/board";

const groupOf = (start: number, size: number, orphanTail = false): BoardGroup => ({
  cards: Array.from({ length: size }, (_, i) => ({
    session: session(start + i),
    label: `t${start + i}`,
    subagent: i > 0 && !orphanTail ? true : orphanTail,
    parentProject: null,
  })),
  orphanTail,
});

const cell = (page: { cards: { session: { sessionId: string }; column: number; row: number }[] }, id: string) => {
  const card = page.cards.find((c) => c.session.sessionId === id);
  return card === undefined ? null : [card.column, card.row];
};

describe("packBoard", () => {
  test("small groups first-fit columns top-down and backfill same-page gaps", () => {
    // 4 + 4 + 2: third group backfills column 0 rows 4-5
    const pages = packBoard([groupOf(1, 4), groupOf(11, 4), groupOf(21, 2)], false);
    expect(pages).toHaveLength(1);
    expect(cell(pages[0]!, "s1")).toEqual([0, 0]);
    expect(cell(pages[0]!, "s11")).toEqual([1, 0]);
    expect(cell(pages[0]!, "s21")).toEqual([0, 4]);
  });

  test("a group that fits no column starts the next page (4+4+4 → pages of 8 and 4)", () => {
    const pages = packBoard([groupOf(1, 4), groupOf(11, 4), groupOf(21, 4)], false);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.cards).toHaveLength(8);
    expect(cell(pages[1]!, "s21")).toEqual([0, 0]);
  });

  test("backfill never crosses back to an earlier page", () => {
    // 4+4+4 opens page 2; a later 2-group lands on page 2, not page 1's gaps
    const pages = packBoard([groupOf(1, 4), groupOf(11, 4), groupOf(21, 4), groupOf(31, 2)], false);
    expect(pages).toHaveLength(2);
    expect(cell(pages[1]!, "s31")).toEqual([0, 4]);
  });

  test("a 7-12 group needs an empty page: wraps col 0 into col 1, else opens the next page", () => {
    const fresh = packBoard([groupOf(1, 8)], false);
    expect(cell(fresh[0]!, "s7")).toEqual([1, 0]);
    const after = packBoard([groupOf(90, 1), groupOf(1, 8)], false);
    expect(after).toHaveLength(2);
    expect(cell(after[1]!, "s1")).toEqual([0, 0]);
  });

  test("a >12 group fills whole pages from a fresh page and continues across the seam", () => {
    const pages = packBoard([groupOf(90, 1), groupOf(1, 14)], false);
    expect(pages).toHaveLength(3);
    expect(pages[1]!.cards).toHaveLength(12);
    expect(cell(pages[2]!, "s13")).toEqual([0, 0]);
  });

  test("grouped subs get indent + spine (mid/end); primaries and orphans get none", () => {
    const pages = packBoard([groupOf(1, 3), groupOf(11, 2, true)], false);
    const spines = pages[0]!.cards.map((card) => [card.session.sessionId, card.indent, card.spine]);
    expect(spines).toEqual([
      ["s1", false, "none"],
      ["s2", true, "mid"],
      ["s3", true, "end"],
      ["s11", false, "none"],
      ["s12", false, "none"],
    ]);
  });
});

describe("reduceBoard", () => {
  const view = (sessions: ProjectedSession[], degraded = false) =>
    ({ snapshot: { schemaVersion: 2, health: { status: "ok" }, sessions }, degraded }) as never;

  test("zero sessions produce one empty page (the OFFLINE surface when degraded)", () => {
    const result = reduceBoard(view([], true), null);
    expect(result.pages).toEqual([{ cards: [] }]);
    expect(result.pageCount).toBe(1);
  });

  test("clamps a persisted out-of-range page and reports dirty", () => {
    const result = reduceBoard(view([session(1)]), { schemaVersion: 1, overflowLatched: false, currentPage: 7 });
    expect(result.settings.currentPage).toBe(0);
    expect(result.dirty).toBe(true);
  });

  test("keeps a valid page clean and always persists overflowLatched false", () => {
    const sessions = Array.from({ length: 13 }, (_, i) => session(i + 1));
    const result = reduceBoard(view(sessions), { schemaVersion: 1, overflowLatched: true, currentPage: 1 });
    expect(result.pageCount).toBe(2);
    expect(result.settings).toEqual({ schemaVersion: 1, overflowLatched: false, currentPage: 1 });
    expect(result.dirty).toBe(true); // latched true was persisted → rewrite
  });

  test("session-count boundaries: 1-3 stay one sparse page, exactly 12 one page, 13 two pages", () => {
    const count = (n: number) => reduceBoard(view(Array.from({ length: n }, (_, i) => session(i + 1))), null).pageCount;
    expect(count(1)).toBe(1);
    expect(count(3)).toBe(1);
    expect(count(12)).toBe(1);
    expect(count(13)).toBe(2);
    expect(count(15)).toBe(2);
  });
});
```

(The `!` non-null assertions are fine in `test/**`.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/strip-board.test.ts` — expected: FAIL, `packBoard` not exported.

- [ ] **Step 4: Implement packing and reduction**

Append to `app/src/board.ts`:

```ts
import {
  DEFAULT_LAYOUT_SETTINGS,
  labelForSession,
  type LayoutSettingsV1,
  validateLayoutSettings,
} from "../../src/plugin/layout";
import type { ProjectedSession, SnapshotView } from "../../src/protocol";

export const BOARD_COLUMNS = 2;
export const BOARD_ROWS = 6;

export type SpineSegment = "none" | "mid" | "end";

export type PlacedCard = BoardCardSeed & {
  degraded: boolean;
  indent: boolean;
  spine: SpineSegment;
  column: number;
  row: number;
};

export type BoardPage = { cards: PlacedCard[] };

type SpinedSeed = BoardCardSeed & { indent: boolean; spine: SpineSegment };

const withSpines = (group: BoardGroup): SpinedSeed[] =>
  group.cards.map((seed, index) => {
    const grouped = seed.subagent && !group.orphanTail;
    return {
      ...seed,
      indent: grouped,
      spine: grouped ? (index === group.cards.length - 1 ? "end" : "mid") : "none",
    };
  });

type MutablePage = { used: number[]; cards: PlacedCard[] };

/**
 * Group-atomic first-fit (spec "Packing and paging"): small groups take the
 * first column with room on the current page (later groups may backfill an
 * earlier gap on that page, never an earlier page); a 7-12 group needs two
 * empty columns so it starts on the current page only while it is empty;
 * a larger group fills whole pages from a fresh page.
 */
export const packBoard = (groups: readonly BoardGroup[], degraded: boolean): BoardPage[] => {
  const pages: MutablePage[] = [];
  const openPage = (): MutablePage => {
    const page: MutablePage = { used: Array.from({ length: BOARD_COLUMNS }, () => 0), cards: [] };
    pages.push(page);
    return page;
  };
  const current = (): MutablePage => pages[pages.length - 1] ?? openPage();
  const place = (page: MutablePage, column: number, seed: SpinedSeed): void => {
    page.cards.push({ ...seed, degraded, column, row: page.used[column] ?? 0 });
    page.used[column] = (page.used[column] ?? 0) + 1;
  };

  for (const group of groups) {
    const seeds = withSpines(group);
    if (seeds.length === 0) {
      continue;
    }
    if (seeds.length <= BOARD_ROWS) {
      let page = current();
      let column = page.used.findIndex((used) => used + seeds.length <= BOARD_ROWS);
      if (column === -1) {
        page = openPage();
        column = 0;
      }
      for (const seed of seeds) {
        place(page, column, seed);
      }
    } else {
      const empty = current().cards.length === 0;
      let page = empty ? current() : openPage();
      let column = 0;
      for (const seed of seeds) {
        if ((page.used[column] ?? 0) >= BOARD_ROWS) {
          column += 1;
          if (column >= BOARD_COLUMNS) {
            page = openPage();
            column = 0;
          }
        }
        place(page, column, seed);
      }
    }
  }
  return pages.map((page) => ({ cards: page.cards }));
};

export type BoardResult = {
  settings: LayoutSettingsV1;
  dirty: boolean;
  pages: BoardPage[];
  pageCount: number;
};

export const reduceBoard = (view: SnapshotView, storedState: unknown): BoardResult => {
  const packed = packBoard(groupedOrder(view.snapshot.sessions), view.degraded);
  const pages = packed.length > 0 ? packed : [{ cards: [] }];
  const pageCount = pages.length;
  const { settings: restored, defaulted } = validateLayoutSettings(storedState);
  const currentPage = Math.min(restored.currentPage, pageCount - 1);
  const settings: LayoutSettingsV1 = { ...DEFAULT_LAYOUT_SETTINGS, currentPage };
  const dirty = defaulted || restored.currentPage !== currentPage || restored.overflowLatched;
  return { settings, dirty, pages, pageCount };
};
```

(Merge the imports with Task 1's; one import statement per module.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/strip-board.test.ts test/layout.test.ts` and `bun run typecheck` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/board.ts src/plugin/layout.ts test/strip-board.test.ts
git commit -m "feat(strip): group-atomic board packing and page reduction"
```

---

### Task 3: Card view model (`app/src/cards.ts`, pure part)

**Files:**
- Create: `app/src/cards.ts`
- Test: `test/strip-cards.test.ts` (absorbs the pure-helper tests of `test/tiles.test.ts`)

**Interfaces:**
- Consumes: `PlacedCard`, `SpineSegment` from `app/src/board.ts`; `modelLabel`, `PROVIDER_LETTERS`, `washCycleOffset` from `src/plugin/render.ts`; `SessionStatus` from `src/protocol.ts`.
- Produces:

```ts
export const CARD_MODEL_LABEL_MAX_CODE_POINTS = 24;
export const WASH_CYCLE_MS = 8000;
export const elapsedLabel = (elapsedMs: number): string; // "42s" | "12m" | "3h" | "2d"
export const statusLineText = (status: SessionStatus, statusSince: string | null, nowMs: number): string | null;
export const washAnimationDelay = (sessionId: string, nowMs: number): string;
export type CardViewModel = {
  provider: ProjectedSession["provider"]; letter: string; unread: boolean;
  title: string; fallbackTitle: boolean; modelLabel: string | null; project: string | null;
  activity: string | null; status: SessionStatus; statusSince: string | null; timer: string | null;
  originDisc: boolean; subagent: boolean; indent: boolean; spine: SpineSegment; badge: number; degraded: boolean;
};
export const cardViewModel = (card: PlacedCard, nowMs: number): CardViewModel;
```

- [ ] **Step 1: Move the surviving pure helpers**

Create `app/src/cards.ts`. Copy `elapsedLabel`, `statusLineText`, `WASH_CYCLE_MS`, and `washAnimationDelay` verbatim from `app/src/tiles.ts:28-87`, exporting `elapsedLabel` (the ticker in Task 9 needs it). Do not delete `tiles.ts` yet — Task 9 removes it.

- [ ] **Step 2: Write the failing tests**

Create `test/strip-cards.test.ts`. Copy the `statusLineText` and `washAnimationDelay` describe blocks from `test/tiles.test.ts:87-166` unchanged (imports now from `../app/src/cards`). Add:

```ts
import { CARD_MODEL_LABEL_MAX_CODE_POINTS, cardViewModel } from "../app/src/cards";
import type { PlacedCard } from "../app/src/board";

const placed = (overrides: Partial<PlacedCard> = {}, sessionOverrides: Partial<ProjectedSession> = {}): PlacedCard => ({
  session: session(1, sessionOverrides),
  label: "Label",
  subagent: false,
  parentProject: null,
  degraded: false,
  indent: false,
  spine: "none",
  column: 0,
  row: 0,
  ...overrides,
});

describe("cardViewModel", () => {
  const NOW_MS = Date.parse("2026-08-25T00:10:00.000Z");

  test("real title is not a fallback; project and long model id survive to 24 code points", () => {
    const model = cardViewModel(
      placed({}, { title: "Fix the thing", project: "repo", model: "qwen3.8-max-preview" }),
      NOW_MS,
    );
    expect(model.fallbackTitle).toBe(false);
    expect(model.modelLabel).toBe("qwen3.8-max-preview");
    expect(model.project).toBe("repo");
  });

  test("null title marks the fallback label (project or provider+id chain comes in via label)", () => {
    expect(cardViewModel(placed({ label: "repo" }, { title: null }), NOW_MS).fallbackTitle).toBe(true);
    expect(cardViewModel(placed({}, { title: "" }), NOW_MS).fallbackTitle).toBe(true);
  });

  test("a grouped sub suppresses a project equal to its parent's; a differing one stays", () => {
    const same = cardViewModel(
      placed({ subagent: true, indent: true, parentProject: "repo" }, { project: "repo" }),
      NOW_MS,
    );
    expect(same.project).toBeNull();
    const differs = cardViewModel(
      placed({ subagent: true, indent: true, parentProject: "repo" }, { project: "other" }),
      NOW_MS,
    );
    expect(differs.project).toBe("other");
  });

  test("model label caps at 24 code points with an ellipsis", () => {
    const long = "a".repeat(30);
    const label = cardViewModel(placed({}, { model: long }), NOW_MS).modelLabel;
    expect(label).toHaveLength(CARD_MODEL_LABEL_MAX_CODE_POINTS);
    expect(label?.endsWith("…")).toBe(true);
  });

  test("origin disc only for Paseo parents; badge is the bare descendant count", () => {
    const paseoParent = cardViewModel(placed({}, { originKind: "paseo", descendantCount: 2 }), NOW_MS);
    expect(paseoParent.originDisc).toBe(true);
    expect(paseoParent.badge).toBe(2);
    const paseoSub = cardViewModel(placed({ subagent: true }, { originKind: "paseo", originSubagent: true }), NOW_MS);
    expect(paseoSub.originDisc).toBe(false);
  });

  test("degraded passes through to the model (the card's ! flag)", () => {
    expect(cardViewModel(placed({ degraded: true }), NOW_MS).degraded).toBe(true);
  });

  test("unread tracks the ledger stamp; timer derives from statusSince", () => {
    const model = cardViewModel(
      placed({}, { unreadSince: "2026-08-25T00:05:00.000Z", status: "working", statusSince: "2026-08-25T00:08:00.000Z" }),
      NOW_MS,
    );
    expect(model.unread).toBe(true);
    expect(model.timer).toBe("working 2m");
  });
});
```

(Reuse the same `session` factory as `test/strip-board.test.ts` — copy it in; test files stay standalone.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/strip-cards.test.ts` — expected: FAIL, `cardViewModel` not exported.

- [ ] **Step 4: Implement `cardViewModel`**

Append to `app/src/cards.ts`:

```ts
import type { PlacedCard, SpineSegment } from "./board";
import { modelLabel, PROVIDER_LETTERS } from "../../src/plugin/render";
import type { ProjectedSession, SessionStatus } from "../../src/protocol";

/** The board's meta line has room for full model ids; the tile 10-point cap does not apply. */
export const CARD_MODEL_LABEL_MAX_CODE_POINTS = 24;

export type CardViewModel = {
  provider: ProjectedSession["provider"];
  letter: string;
  unread: boolean;
  title: string;
  /** True when the label is not the session's own title (project or provider+id fallback) — rendered italic. */
  fallbackTitle: boolean;
  modelLabel: string | null;
  project: string | null;
  activity: string | null;
  status: SessionStatus;
  statusSince: string | null;
  timer: string | null;
  originDisc: boolean;
  subagent: boolean;
  indent: boolean;
  spine: SpineSegment;
  badge: number;
  degraded: boolean;
};

export const cardViewModel = (card: PlacedCard, nowMs: number): CardViewModel => {
  const { session } = card;
  return {
    provider: session.provider,
    letter: PROVIDER_LETTERS[session.provider],
    unread: session.unreadSince !== null,
    title: card.label,
    fallbackTitle: !(session.title !== null && session.title.length > 0),
    modelLabel: session.model === null ? null : modelLabel(session.model, CARD_MODEL_LABEL_MAX_CODE_POINTS),
    project:
      card.subagent && card.parentProject !== null && card.parentProject === session.project ? null : session.project,
    activity: session.activityLine,
    status: session.status,
    statusSince: session.statusSince,
    timer: statusLineText(session.status, session.statusSince, nowMs),
    originDisc: session.originKind === "paseo" && !session.originSubagent,
    subagent: card.subagent,
    indent: card.indent,
    spine: card.spine,
    badge: session.descendantCount,
    degraded: card.degraded,
  };
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/strip-cards.test.ts` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/cards.ts test/strip-cards.test.ts
git commit -m "feat(strip): card view model with fallback, suppression, and 24-point model cap"
```

---

### Task 4: Card DOM and board styles

**Files:**
- Modify: `app/src/cards.ts`, `app/styles.css`, `app/index.html`

**Interfaces:**
- Consumes: `BoardPage`, `BOARD_COLUMNS`, `BOARD_ROWS` from `app/src/board.ts`; `cardViewModel`, `washAnimationDelay` from Task 3.
- Produces: `export const renderBoard = (root: HTMLElement, page: BoardPage, degraded: boolean): void` — builds one `div.card` per placed card with `dataset["cardIndex"] = String(index)` (index into `page.cards`), or a single `div.offline` reading `OFFLINE` when the page is empty and degraded. Timer span carries `class="cardtimer"` plus `dataset["since"]` so Task 9's ticker can rewrite it in place.

This is DOM assembly over the tested view model — the repo's established pattern (`renderTiles` was likewise untested DOM over tested helpers). No new unit tests; Task 11 verifies visually.

- [ ] **Step 1: Rename the board mount**

In `app/index.html` change `<div id="tiles"></div>` to `<div id="board"></div>`.

- [ ] **Step 2: Implement `renderBoard`**

Append to `app/src/cards.ts` (all text via `textContent`; structure mirrors the d6 mockup — open `docs/superpowers/specs/assets/2026-08-25-strip-board/d6.html` and match its card DOM: status edge as a left border/pseudo-element, head row with chip + unread dot + sub pill + title, meta row with model/project/activity plus the origin disc and badge at the right end, status row with dot + word + timer):

```ts
import { type BoardPage, type PlacedCard } from "./board";

const appendText = (parent: HTMLElement, className: string, text: string): HTMLSpanElement => {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
};

const cardElement = (card: PlacedCard, index: number, nowMs: number): HTMLElement => {
  const model = cardViewModel(card, nowMs);
  const element = document.createElement("div");
  element.className = [
    "card",
    `status-${model.status}`,
    model.subagent ? "sub" : "primary",
    model.indent ? "indented" : "",
    model.spine !== "none" ? `spine-${model.spine}` : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  element.dataset["cardIndex"] = String(index);
  element.style.gridColumn = String(card.column + 1);
  element.style.gridRow = String(card.row + 1);
  if (model.status === "working") {
    element.style.setProperty("--wash-delay", washAnimationDelay(card.session.sessionId, nowMs));
  }

  const head = document.createElement("div");
  head.className = "card-head";
  const chip = appendText(head, "chip", model.letter);
  chip.dataset["provider"] = model.provider;
  if (model.unread) {
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    head.append(dot);
  }
  if (model.subagent) {
    appendText(head, "sub-pill", "sub");
  }
  const title = appendText(head, model.fallbackTitle ? "card-title fallback" : "card-title", model.title);
  title.classList.add("one-line");
  element.append(head);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  if (model.modelLabel !== null) {
    appendText(meta, "meta-item", model.modelLabel);
  }
  if (model.project !== null) {
    appendText(meta, "meta-item", model.project);
  }
  if (model.activity !== null) {
    appendText(meta, "meta-item activity", model.activity);
  }
  const metaRight = document.createElement("span");
  metaRight.className = "meta-right";
  if (model.badge > 0) {
    appendText(metaRight, "badge", String(model.badge));
  }
  if (model.originDisc) {
    const disc = document.createElement("span");
    disc.className = "origin-disc";
    metaRight.append(disc);
  }
  meta.append(metaRight);
  element.append(meta);

  const statusRow = document.createElement("div");
  statusRow.className = "card-status";
  const statusDot = document.createElement("span");
  statusDot.className = "status-dot";
  statusRow.append(statusDot);
  appendText(statusRow, "status-word", model.status);
  if (model.statusSince !== null && model.timer !== null) {
    const timer = appendText(statusRow, "cardtimer", model.timer.slice(model.status.length + 1));
    timer.dataset["since"] = model.statusSince;
  }
  element.append(statusRow);

  if (model.degraded) {
    appendText(element, "flag", "!");
  }
  return element;
};

export const renderBoard = (root: HTMLElement, page: BoardPage, degraded: boolean): void => {
  if (page.cards.length === 0) {
    const blank = document.createElement("div");
    blank.className = "offline";
    if (degraded) {
      blank.textContent = "OFFLINE";
    }
    root.replaceChildren(blank);
    return;
  }
  const nowMs = Date.now();
  root.replaceChildren(...page.cards.map((card, index) => cardElement(card, index, nowMs)));
};
```

- [ ] **Step 3: Rewrite the board styles**

In `app/styles.css`: replace `#tiles` and the `.tile` family (keep `.chip`/`.unread-dot`/`.flag`/`.offline` and the status/wash/breathe/pulse keyframes — retarget the status classes at `.card`) with the board grid and card styles. Copy every dimension, color, and font size from the `<style>` block of `docs/superpowers/specs/assets/2026-08-25-strip-board/d6.html` (it is the visual contract of record), converting px to vw/vh at 2560×720 (px ÷ 25.6 = vw, px ÷ 7.2 = vh). Structural skeleton:

```css
#strip { display: grid; grid-template-columns: 1fr 19.375%; /* keep existing gap/padding */ }
#board {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  grid-template-rows: repeat(6, 1fr);
  gap: 1.667vh 0.469vw; /* 12px native */
}
.card { position: relative; display: flex; flex-direction: column; border-radius: 0.39vw; background: #1c2430; border-left: 0.3125vw solid transparent; /* 8px status edge */ overflow: hidden; }
.card.sub { background: #11151d; border: 1px solid #232b38; }
.card.indented { margin-left: 1.719vw; /* 44px */ }
.card.spine-mid::before, .card.spine-end::before { /* 2px #A78BFA vertical spine + elbow in the indent gutter, per d6.html */ }
.card-title.fallback { font-style: italic; }
```

Status classes: `.card.status-working` blue edge + the wash `::after` breathing with `--wash-delay` (as `.status-working::before` does today at `app/styles.css:61-72`); `.card.status-waiting` amber edge + full border + tinted wash, breathing; `.card.status-error` red equivalents pulsing at 2s; `.card.status-idle` static green edge. Waiting/error washes are static tints; only the locked opacity animations move. Hairline widths must not round below 1 physical px in the 1280×360 mode — use `max(1px, …)` where d6.html uses hairlines.

- [ ] **Step 4: Verify it builds and renders**

Run: `bun run typecheck && bun run build:app`. Then screenshot-check the bundle locally by loading fixture data — defer the on-device check to Task 11; here it is enough that the build passes and `bun test` still passes (`bun test`).

- [ ] **Step 5: Commit**

```bash
git add app/src/cards.ts app/styles.css app/index.html
git commit -m "feat(strip): card DOM renderer and board styles"
```

---

### Task 5: Rail quota rows (countdown-first, no ticks, wider bar)

**Files:**
- Modify: `app/src/quota.ts`, `app/src/rail.ts`, `app/styles.css`
- Test: `test/strip-quota.test.ts`

**Interfaces:**
- Consumes: existing `QuotaPanelModel`, `bindingWindow`, `formatBindingPercent`, `formatBindingNote`.
- Produces: `formatBindingTag` returns the bare binding-window tag (no ` binds` suffix); `tickPercents` is deleted; `rail.ts` renders the right side as muted note first, bright percent last.

- [ ] **Step 1: Update the failing tests**

In `test/strip-quota.test.ts`: find the `formatBindingTag` tests asserting the ` binds` suffix for multi-window models and change the expectation to the bare tag (e.g. expect `"weekly"` where it expected `"weekly binds"`). Delete the `tickPercents` describe block. Run `bun test test/strip-quota.test.ts` — expected: FAIL (suffix still emitted).

- [ ] **Step 2: Implement**

In `app/src/quota.ts`:
- `formatBindingTag` (line 135): return `binding.tag` unconditionally (keep the null-on-no-data path); update its doc comment ("Pill text: the binding window's name; null when no data.").
- Delete `tickPercents` (lines 168-174).

In `app/src/rail.ts` `quotaSection` (line 115):
- Right side: in the non-unavailable branch build note first, then percent — `right.append(noteSpan, pct)` with the note's text no longer prefixed by `"· "`; instead give the percent a leading separator-free layout and put `` `${note} ·` `` in the note span when note is non-empty (matches spec `2d · 88%`). Unavailable branch unchanged.
- Delete the `tickPercents` import and the tick loop (lines 168-173).

In `app/styles.css`: `.quota-bar { height: 1.111vh; }` (8px native; was 0.8vh) and keep `.quota-pct` `font-variant-numeric: tabular-nums` — the percent is the row's last flex child so all five right edges align. Delete the `.quota-tick` rule.

- [ ] **Step 3: Run tests to verify they pass**

Run: `bun test test/strip-quota.test.ts` and `bun run typecheck` — expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src/quota.ts app/src/rail.ts app/styles.css test/strip-quota.test.ts
git commit -m "feat(strip): quota rows go countdown-first with bare binding tag, no ticks, wider bar"
```

---

### Task 6: `dayCurves` snapshot contract (additive, no bump)

**Files:**
- Modify: `src/token-usage-snapshot.ts`
- Test: `test/token-usage-snapshot.test.ts`

**Interfaces:**
- Produces (Tasks 7/8 rely on these):

```ts
export const TOKEN_USAGE_DAY_CURVE_POINT_LIMIT = 96;
export type TokenUsageDayCurvePoint = { fetchedAt: string; totalTokens: number };
export type TokenUsageDayCurve = { providerDay: string; points: TokenUsageDayCurvePoint[] };
export type TokenUsageDayCurves = { today: TokenUsageDayCurve; yesterday: TokenUsageDayCurve | null };
// TokenUsageSnapshot gains: dayCurves?: TokenUsageDayCurves;
```

`schemaVersion` stays 1. `parseTokenUsageSnapshot` validates `dayCurves` when present (absent stays legal), enforcing: points array ≤ 96, each point a valid ISO instant + token count, `fetchedAt` strictly increasing, `totalTokens` non-decreasing (the collector's running max), `providerDay` valid.

- [ ] **Step 1: Write the failing tests**

Append to `test/token-usage-snapshot.test.ts` (match its existing fixture style):

```ts
const curves = {
  today: {
    providerDay: "2026-08-25",
    points: [
      { fetchedAt: "2026-08-25T15:00:00.000Z", totalTokens: 10 },
      { fetchedAt: "2026-08-25T15:00:30.000Z", totalTokens: 20 },
    ],
  },
  yesterday: { providerDay: "2026-08-24", points: [{ fetchedAt: "2026-08-24T20:00:00.000Z", totalTokens: 5 }] },
};

test("accepts a snapshot with dayCurves and preserves them", () => {
  const parsed = parseTokenUsageSnapshot({ ...validSnapshot, dayCurves: curves });
  expect(parsed.dayCurves).toEqual(curves);
});

test("a snapshot without dayCurves stays legal (old daemon)", () => {
  expect(parseTokenUsageSnapshot(validSnapshot).dayCurves).toBeUndefined();
});

test("an old reader's behavior: unknown top-level keys are still ignored", () => {
  expect(() => parseTokenUsageSnapshot({ ...validSnapshot, someFutureKey: 1 })).not.toThrow();
});

test("rejects malformed dayCurves: out-of-order times, decreasing totals, oversize, bad day", () => {
  const bad = (dayCurves: unknown) => () => parseTokenUsageSnapshot({ ...validSnapshot, dayCurves });
  expect(bad({ today: { providerDay: "2026-08-25", points: [curves.today.points[1], curves.today.points[0]] }, yesterday: null })).toThrow();
  expect(
    bad({
      today: {
        providerDay: "2026-08-25",
        points: [
          { fetchedAt: "2026-08-25T15:00:00.000Z", totalTokens: 20 },
          { fetchedAt: "2026-08-25T15:00:30.000Z", totalTokens: 10 },
        ],
      },
      yesterday: null,
    }),
  ).toThrow();
  const oversized = Array.from({ length: 97 }, (_, i) => ({
    fetchedAt: new Date(Date.UTC(2026, 7, 25, 10, 0, i)).toISOString(),
    totalTokens: i,
  }));
  expect(bad({ today: { providerDay: "2026-08-25", points: oversized }, yesterday: null })).toThrow();
  expect(bad({ today: { providerDay: "2026-13-99", points: [] }, yesterday: null })).toThrow();
});
```

(`validSnapshot` is the file's existing valid fixture — reuse whatever it is named there.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/token-usage-snapshot.test.ts` — expected: FAIL (parser drops/never returns `dayCurves`).

- [ ] **Step 3: Implement**

In `src/token-usage-snapshot.ts`: add the constants/types above, plus:

```ts
const parseDayCurvePoint = (value: unknown): TokenUsageDayCurvePoint => {
  if (!isRecord(value) || !isIsoInstant(value["fetchedAt"]) || !isTokenCount(value["totalTokens"])) {
    return invalid("day-curve point must have an ISO fetchedAt and a token count");
  }
  return { fetchedAt: value["fetchedAt"], totalTokens: value["totalTokens"] };
};

const parseDayCurve = (value: unknown): TokenUsageDayCurve => {
  if (!isRecord(value) || !isProviderDay(value["providerDay"])) {
    return invalid("day curve must carry a YYYY-MM-DD providerDay");
  }
  if (!Array.isArray(value["points"]) || value["points"].length > TOKEN_USAGE_DAY_CURVE_POINT_LIMIT) {
    return invalid(`day curve points must be an array of at most ${TOKEN_USAGE_DAY_CURVE_POINT_LIMIT}`);
  }
  const points = value["points"].map(parseDayCurvePoint);
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (current.fetchedAt <= previous.fetchedAt) {
      return invalid("day curve points must be strictly increasing in time");
    }
    if (current.totalTokens < previous.totalTokens) {
      return invalid("day curve totals must be non-decreasing");
    }
  }
  return { providerDay: value["providerDay"], points };
};

const parseDayCurves = (value: unknown): TokenUsageDayCurves => {
  if (!isRecord(value)) {
    return invalid("dayCurves must be an object");
  }
  return {
    today: parseDayCurve(value["today"]),
    yesterday: value["yesterday"] === null ? null : parseDayCurve(value["yesterday"]),
  };
};
```

In `parseTokenUsageSnapshot`, before the return, and merged into the returned object (`exactOptionalPropertyTypes`: only set the key when present):

```ts
  const rawDayCurves = value["dayCurves"];
  const dayCurves = rawDayCurves === undefined ? undefined : parseDayCurves(rawDayCurves);
  return {
    // ...existing fields...
    ...(dayCurves === undefined ? {} : { dayCurves }),
  };
```

Add `dayCurves?: TokenUsageDayCurves;` to the `TokenUsageSnapshot` type with a comment: additive under schemaVersion 1 — the parser ignores unknown top-level keys, so an old app is untouched by this key.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/token-usage-snapshot.test.ts test/token-usage.test.ts test/strip-token-usage.test.ts` — expected: PASS (existing consumers unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/token-usage-snapshot.ts test/token-usage-snapshot.test.ts
git commit -m "feat: additive dayCurves contract in the token-usage snapshot (no schema bump)"
```

---

### Task 7: Collector day curves (running max, downsample, date-keyed rollover, seeding)

**Files:**
- Modify: `src/core/token-usage.ts`
- Test: `test/token-usage.test.ts`

**Interfaces:**
- Consumes: Task 6's `TokenUsageDayCurves`, `TokenUsageDayCurvePoint`, `TOKEN_USAGE_DAY_CURVE_POINT_LIMIT`.
- Produces (pure, exported for tests; Task 8 only reads the published snapshot):

```ts
export const previousProviderDay = (day: string): string;
export const appendDayCurvePoint = (
  curves: TokenUsageDayCurves | undefined, day: string, point: TokenUsageDayCurvePoint,
): TokenUsageDayCurves;
export const reconcileSeededDayCurves = (
  curves: TokenUsageDayCurves | undefined, currentDay: string,
): TokenUsageDayCurves | undefined;
```

- [ ] **Step 1: Write the failing tests**

Append to `test/token-usage.test.ts`:

```ts
import { appendDayCurvePoint, previousProviderDay, reconcileSeededDayCurves } from "../src/core/token-usage";
import { TOKEN_USAGE_DAY_CURVE_POINT_LIMIT } from "../src/token-usage-snapshot";

const point = (second: number, total: number) => ({
  fetchedAt: new Date(Date.UTC(2026, 7, 25, 10, 0, second)).toISOString(),
  totalTokens: total,
});

describe("previousProviderDay", () => {
  test("steps calendar days including month and year seams", () => {
    expect(previousProviderDay("2026-08-25")).toBe("2026-08-24");
    expect(previousProviderDay("2026-08-01")).toBe("2026-07-31");
    expect(previousProviderDay("2026-01-01")).toBe("2025-12-31");
  });
});

describe("appendDayCurvePoint", () => {
  test("same-day points append with a running max (a helper correction never dips the curve)", () => {
    const first = appendDayCurvePoint(undefined, "2026-08-25", point(0, 100));
    const second = appendDayCurvePoint(first, "2026-08-25", point(30, 90));
    expect(second.today.points.map((p) => p.totalTokens)).toEqual([100, 100]);
    expect(second.yesterday).toBeNull();
  });

  test("a new adjacent day promotes today to yesterday; a gap drops it", () => {
    const monday = appendDayCurvePoint(undefined, "2026-08-24", point(0, 5));
    const tuesday = appendDayCurvePoint(monday, "2026-08-25", point(0, 1));
    expect(tuesday.yesterday?.providerDay).toBe("2026-08-24");
    const thursday = appendDayCurvePoint(monday, "2026-08-27", point(0, 1));
    expect(thursday.yesterday).toBeNull();
  });

  test("downsampling keeps at most the limit and always the first and latest points", () => {
    let curves = appendDayCurvePoint(undefined, "2026-08-25", point(0, 0));
    for (let i = 1; i <= 200; i++) {
      curves = appendDayCurvePoint(curves, "2026-08-25", point(i, i));
    }
    expect(curves.today.points.length).toBeLessThanOrEqual(TOKEN_USAGE_DAY_CURVE_POINT_LIMIT);
    expect(curves.today.points[0]?.totalTokens).toBe(0);
    expect(curves.today.points.at(-1)?.totalTokens).toBe(200);
  });
});

describe("reconcileSeededDayCurves", () => {
  const seeded = appendDayCurvePoint(undefined, "2026-08-24", point(0, 7));

  test("same-day seed passes through; adjacent-day seed rotates; a gap drops everything", () => {
    expect(reconcileSeededDayCurves(seeded, "2026-08-24")).toEqual(seeded);
    const rotated = reconcileSeededDayCurves(seeded, "2026-08-25");
    expect(rotated?.yesterday?.providerDay).toBe("2026-08-24");
    expect(rotated?.today).toEqual({ providerDay: "2026-08-25", points: [] });
    expect(reconcileSeededDayCurves(seeded, "2026-08-27")).toBeUndefined();
    expect(reconcileSeededDayCurves(undefined, "2026-08-25")).toBeUndefined();
  });
});
```

Also add a collector-level test in the file's existing fake-runner style: two successful polls on one day publish a snapshot whose `dayCurves.today` has both points; a seeded snapshot from yesterday followed by a poll today publishes `yesterday` = the seeded curve. Follow the file's existing `createTokenUsageCollector` fixtures (fake `run`, `now`, `nowMs`, `writeFile` capturing JSON).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/token-usage.test.ts` — expected: FAIL, exports missing.

- [ ] **Step 3: Implement**

In `src/core/token-usage.ts` (import the new types plus `TOKEN_USAGE_DAY_CURVE_POINT_LIMIT` from `../token-usage-snapshot`):

```ts
/** Calendar-day arithmetic on the YYYY-MM-DD string is timezone-free. */
export const previousProviderDay = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);

const downsampleDayPoints = (points: readonly TokenUsageDayCurvePoint[]): TokenUsageDayCurvePoint[] => {
  if (points.length <= TOKEN_USAGE_DAY_CURVE_POINT_LIMIT) {
    return [...points];
  }
  const picked: TokenUsageDayCurvePoint[] = [];
  const last = points.length - 1;
  let previousIndex = -1;
  for (let i = 0; i < TOKEN_USAGE_DAY_CURVE_POINT_LIMIT; i++) {
    const index = Math.round((i * last) / (TOKEN_USAGE_DAY_CURVE_POINT_LIMIT - 1));
    if (index === previousIndex) {
      continue;
    }
    previousIndex = index;
    const entry = points[index];
    if (entry !== undefined) {
      picked.push(entry);
    }
  }
  return picked;
};

/** Append a sample to the day curves: same day extends with a running max; a new day rotates date-keyed. */
export const appendDayCurvePoint = (
  curves: TokenUsageDayCurves | undefined,
  day: string,
  point: TokenUsageDayCurvePoint,
): TokenUsageDayCurves => {
  if (curves !== undefined && curves.today.providerDay === day) {
    const floor = curves.today.points.at(-1)?.totalTokens ?? 0;
    const points = downsampleDayPoints([
      ...curves.today.points,
      { fetchedAt: point.fetchedAt, totalTokens: Math.max(point.totalTokens, floor) },
    ]);
    return { today: { providerDay: day, points }, yesterday: curves.yesterday };
  }
  const yesterday =
    curves !== undefined && curves.today.providerDay === previousProviderDay(day) && curves.today.points.length > 0
      ? curves.today
      : null;
  return { today: { providerDay: day, points: [point] }, yesterday };
};

/** Date-key a seeded publication against the current LA day: pass, rotate, or drop — never mislabel. */
export const reconcileSeededDayCurves = (
  curves: TokenUsageDayCurves | undefined,
  currentDay: string,
): TokenUsageDayCurves | undefined => {
  if (curves === undefined) {
    return undefined;
  }
  if (curves.today.providerDay === currentDay) {
    return curves;
  }
  if (curves.today.providerDay === previousProviderDay(currentDay)) {
    return { today: { providerDay: currentDay, points: [] }, yesterday: curves.today };
  }
  return undefined;
};
```

Wire into the collector:
- Seeding block (line 214-225): after `parseTokenUsageSnapshot`, reconcile — `const reconciled = reconcileSeededDayCurves(seeded.dayCurves, laProviderDay(new Date(nowMs())));` then build the state snapshot as `{ ...seeded, ...(reconciled === undefined ? {} : { dayCurves: reconciled }) }`, deleting a stale key by destructuring when `reconciled === undefined && seeded.dayCurves !== undefined` (`const { dayCurves: _dropped, ...rest } = seeded;` and use `rest`).
- Success branch of `pollNow` (line 248-255): `const dayCurves = appendDayCurvePoint(state.snapshot.dayCurves, providerDay, { fetchedAt, totalTokens: total });` and include `dayCurves` in the new snapshot object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/token-usage.test.ts test/token-usage-snapshot.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/token-usage.ts test/token-usage.test.ts
git commit -m "feat: collector publishes date-keyed per-day token curves"
```

---

### Task 8: Day-over-day sparkline (view model + rail render)

**Files:**
- Modify: `app/src/token-usage.ts`, `app/src/rail.ts`, `app/styles.css`
- Test: `test/strip-token-usage.test.ts`

**Interfaces:**
- Consumes: `TokenUsageSnapshot` (with optional `dayCurves`) via the existing `reduceTokenUsageRead` path; `formatTokensCompact`.
- Produces:

```ts
export type SparklinePoint = { x: number; y: number }; // both normalized to [0, 1]
export type SparklineModel = {
  today: { points: SparklinePoint[] };
  yesterday: { points: SparklinePoint[]; label: string } | null; // label e.g. "yda 61.3M"
};
export const laDayBoundsMs = (day: string): { startMs: number; endMs: number };
export const reduceSparkline = (snapshot: TokenUsageSnapshot): SparklineModel | null;
// TokenUsageRailModel's ok/stale arm gains: sparkline: SparklineModel | null
```

- [ ] **Step 1: Write the failing tests**

Append to `test/strip-token-usage.test.ts`:

```ts
import { laDayBoundsMs, reduceSparkline } from "../app/src/token-usage";

describe("laDayBoundsMs", () => {
  test("a standard LA day is 24h (UTC-7 in August)", () => {
    const bounds = laDayBoundsMs("2026-08-25");
    expect(bounds.startMs).toBe(Date.parse("2026-08-25T07:00:00.000Z"));
    expect(bounds.endMs - bounds.startMs).toBe(24 * 3_600_000);
  });

  test("DST days are 23h (spring forward) and 25h (fall back)", () => {
    const spring = laDayBoundsMs("2026-03-08");
    expect(spring.endMs - spring.startMs).toBe(23 * 3_600_000);
    const fall = laDayBoundsMs("2026-11-01");
    expect(fall.endMs - fall.startMs).toBe(25 * 3_600_000);
  });
});

describe("reduceSparkline", () => {
  const snapshotWith = (dayCurves: unknown) => ({ ...validSnapshotFixture, dayCurves }) as never;

  test("no curves → no sparkline; empty today with no yesterday → no sparkline", () => {
    expect(reduceSparkline(validSnapshotFixture as never)).toBeNull();
    expect(reduceSparkline(snapshotWith({ today: { providerDay: "2026-08-25", points: [] }, yesterday: null }))).toBeNull();
  });

  test("today normalizes x by elapsed day fraction and y by the shared max", () => {
    const model = reduceSparkline(
      snapshotWith({
        today: {
          providerDay: "2026-08-25",
          points: [
            { fetchedAt: "2026-08-25T07:00:00.000Z", totalTokens: 0 },
            { fetchedAt: "2026-08-25T19:00:00.000Z", totalTokens: 50 },
          ],
        },
        yesterday: {
          providerDay: "2026-08-24",
          points: [{ fetchedAt: "2026-08-25T06:00:00.000Z", totalTokens: 100 }],
        },
      }),
    );
    expect(model).not.toBeNull();
    expect(model?.today.points.at(-1)?.x).toBeCloseTo(0.5, 5); // noon of a 24h day
    expect(model?.today.points.at(-1)?.y).toBeCloseTo(0.5, 5); // shared max is yesterday's 100
    expect(model?.yesterday?.label).toBe("yda 100");
  });

  test("a non-adjacent yesterday is dropped from the model", () => {
    const model = reduceSparkline(
      snapshotWith({
        today: { providerDay: "2026-08-25", points: [{ fetchedAt: "2026-08-25T07:00:00.000Z", totalTokens: 10 }] },
        yesterday: { providerDay: "2026-08-22", points: [{ fetchedAt: "2026-08-22T08:00:00.000Z", totalTokens: 99 }] },
      }),
    );
    expect(model?.yesterday).toBeNull();
  });
});
```

(`validSnapshotFixture` = the file's existing minimal valid snapshot; reuse its actual name.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/strip-token-usage.test.ts` — expected: FAIL, exports missing.

- [ ] **Step 3: Implement the view model**

In `app/src/token-usage.ts`:

```ts
const LA_TIME_ZONE = "America/Los_Angeles";

const laWallClockFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: LA_TIME_ZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Offset of LA wall clock from UTC at an instant, in ms (negative west of UTC). */
const laOffsetMs = (atMs: number): number => {
  const parts = laWallClockFormat.formatToParts(new Date(atMs));
  const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour") % 24, field("minute"), field("second"));
  return asUtc - Math.floor(atMs / 1000) * 1000;
};

/** Epoch of LA midnight for a YYYY-MM-DD day; the second pass settles DST transitions. */
const laMidnightMs = (day: string): number => {
  const guess = Date.parse(`${day}T00:00:00.000Z`);
  const once = guess - laOffsetMs(guess);
  return guess - laOffsetMs(once);
};

const nextProviderDay = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

const previousProviderDay = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);

export const laDayBoundsMs = (day: string): { startMs: number; endMs: number } => ({
  startMs: laMidnightMs(day),
  endMs: laMidnightMs(nextProviderDay(day)),
});

export type SparklinePoint = { x: number; y: number };
export type SparklineModel = {
  today: { points: SparklinePoint[] };
  yesterday: { points: SparklinePoint[]; label: string } | null;
};

const curveLine = (curve: TokenUsageDayCurve, yMax: number): SparklinePoint[] => {
  const { startMs, endMs } = laDayBoundsMs(curve.providerDay);
  const span = Math.max(1, endMs - startMs);
  return curve.points.map((point) => ({
    x: Math.min(1, Math.max(0, (Date.parse(point.fetchedAt) - startMs) / span)),
    y: Math.min(1, Math.max(0, point.totalTokens / yMax)),
  }));
};

/** Spec "Day-over-day sparkline": adjacent-yesterday only, shared zero-based y-scale, elapsed-fraction x. */
export const reduceSparkline = (snapshot: TokenUsageSnapshot): SparklineModel | null => {
  const curves = snapshot.dayCurves;
  if (curves === undefined) {
    return null;
  }
  const yesterday =
    curves.yesterday !== null &&
    curves.yesterday.providerDay === previousProviderDay(curves.today.providerDay) &&
    curves.yesterday.points.length > 0
      ? curves.yesterday
      : null;
  if (curves.today.points.length === 0 && yesterday === null) {
    return null;
  }
  const yMax = Math.max(
    1,
    curves.today.points.at(-1)?.totalTokens ?? 0,
    yesterday?.points.at(-1)?.totalTokens ?? 0,
  );
  return {
    today: { points: curveLine(curves.today, yMax) },
    yesterday:
      yesterday === null
        ? null
        : {
            points: curveLine(yesterday, yMax),
            label: `yda ${formatTokensCompact(yesterday.points.at(-1)?.totalTokens ?? 0)}`,
          },
  };
};
```

(Import `TokenUsageDayCurve` from `../../src/token-usage-snapshot`; `formatTokensCompact` is already in this module — no self-import.) Extend `TokenUsageRailModel`'s ok/stale arm with `sparkline: SparklineModel | null` and set it in `reduceTokenUsageRead` via `reduceSparkline(snapshot)` (both the anchor-present and zero-sample returns).

- [ ] **Step 4: Render it in the rail**

In `app/src/rail.ts` `tokensSection`: after the rates row, when `model.sparkline !== null` append an SVG block (namespace `http://www.w3.org/2000/svg` via `createElementNS`): `viewBox="0 0 100 28"`, `preserveAspectRatio="none"`, a `polyline` for yesterday (stroke `#94A3B8`, `stroke-width 2`, `vector-effect="non-scaling-stroke"`, opacity per d6.html), a `polyline` for today (stroke `#E8EEF7`), and a `circle` at today's last point; points map as `x*100`, `27 - y*26`. The `yda` label is an HTML span (≥20px native per d6.html) positioned per the mockup. Add the matching `.rail-sparkline` styles to `app/styles.css` from d6.html.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test test/strip-token-usage.test.ts && bun run typecheck` — expected: PASS (fix any `TokenUsageRailModel` consumers the type extension surfaces — `rail.ts` is the only one).

- [ ] **Step 6: Commit**

```bash
git add app/src/token-usage.ts app/src/rail.ts app/styles.css test/strip-token-usage.test.ts
git commit -m "feat(strip): day-over-day token sparkline with DST-safe day axis"
```

---

### Task 9: Wire the board into `main.ts`; retire the tile grid

**Files:**
- Modify: `app/src/main.ts`, `app/src/tile-identity.ts`
- Delete: `app/src/tiles.ts`, `test/tiles.test.ts` (their surviving content moved in Task 3)
- Test: `test/strip-tile-identity.test.ts`

**Interfaces:**
- Consumes: `reduceBoard`, `BoardResult`, `BoardPage`, `PlacedCard` (Task 2); `renderBoard`, `elapsedLabel` (Tasks 3-4).
- Produces: `resolveBoardCard(cards: readonly PlacedCard[], identity: SessionIdentity): { index: number; session: ProjectedSession; label: string } | null` in `tile-identity.ts` (mirror of `resolveSessionTile`, over placed cards).

- [ ] **Step 1: Write the failing identity test**

In `test/strip-tile-identity.test.ts` add a describe for `resolveBoardCard`: resolves the card whose session matches provider+sessionId and returns its index/session/label; returns null when absent (mirror the file's existing `resolveSessionTile` cases with `PlacedCard` fixtures). Run — expected: FAIL.

- [ ] **Step 2: Implement `resolveBoardCard`**

In `app/src/tile-identity.ts`:

```ts
import type { PlacedCard } from "./board";

export const resolveBoardCard = (
  cards: readonly PlacedCard[],
  identity: SessionIdentity,
): { index: number; session: ProjectedSession; label: string } | null => {
  for (const [index, card] of cards.entries()) {
    if (card.session.provider === identity.provider && card.session.sessionId === identity.sessionId) {
      return { index, session: card.session, label: card.label };
    }
  }
  return null;
};
```

Run the test file — expected: PASS.

- [ ] **Step 3: Rewire `main.ts`**

Changes, keeping every behavior not named here identical:

- Imports: drop `reduceLayout`, `STRIP_GEOMETRY`, `KeyModel`, `LayoutResult`, and everything from `./tiles`; add `type BoardResult, reduceBoard` from `./board`, `elapsedLabel, renderBoard` from `./cards`, `resolveBoardCard` from `./tile-identity`.
- State: replace `currentKeys: readonly KeyModel[]` with `currentCards: readonly PlacedCard[]` and add `currentPages: readonly BoardPage[]`.
- `applyLayout(layout: LayoutResult)` becomes `applyBoard(result: BoardResult)`:

```ts
const applyBoard = (result: BoardResult): void => {
  if (result.dirty) {
    persistSettings(result.settings);
  }
  currentPage = result.settings.currentPage;
  currentPageCount = result.pageCount;
  currentPages = result.pages;
  const page = result.pages[currentPage] ?? { cards: [] };
  currentCards = page.cards;
  const signature = JSON.stringify(page.cards);
  const root = document.querySelector<HTMLElement>("#board");
  if (root !== null && signature !== renderedSignature) {
    renderedSignature = signature;
    renderBoard(root, page, currentView?.degraded ?? false);
  }
};
```

- `ingest`: `applyBoard(reduceBoard(reduction.view, loadStoredSettings()));`
- `jumpToPage`: `applyBoard(reduceBoard(currentView, { schemaVersion: 1, overflowLatched: false, currentPage: page }));` then `renderRailNow()`. (`onSwipe` is unchanged — it already clamps against `currentPageCount`.)
- `tickStatusLines` → tick the card timers:

```ts
const tickStatusLines = (): void => {
  const nowMs = Date.now();
  for (const timer of document.querySelectorAll<HTMLElement>("#board .cardtimer")) {
    const since = timer.dataset["since"];
    if (since === undefined) {
      continue;
    }
    const startedMs = Date.parse(since);
    if (Number.isNaN(startedMs)) {
      continue;
    }
    const text = elapsedLabel(nowMs - startedMs);
    if (timer.textContent !== text) {
      timer.textContent = text;
    }
  }
};
```

- `onTilesClick` / `tileFromPointerEvent`: selector `[data-card-index]`, index into `currentCards`, `model` is now a `PlacedCard` (no `.kind` check — every card is a session): `void pressSessionTile(card.session, …)`; long-press identity `identityOf(card.session)`.
- `openActionSheetFor`: `const ref = resolveBoardCard(currentCards, pending.identity);` and the element query `#board [data-card-index="${ref.index}"]`.
- `wireInteraction`: `#tiles` → `#board`.

- [ ] **Step 4: Delete the tile module**

`git rm app/src/tiles.ts test/tiles.test.ts`. (Their pure helpers and tests live on in `cards.ts` / `test/strip-cards.test.ts` since Task 3; `stripGridLayout` and `visibleStripKeys` die with the square grid.)

- [ ] **Step 5: Full verification**

Run: `bun run check` (Biome + build + full test suite). Expected: everything green. Fix fallout — no other module may still import `./tiles`.

- [ ] **Step 6: Commit**

```bash
git add -u app
git add app/src/main.ts app/src/tile-identity.ts test/strip-tile-identity.test.ts
git commit -m "feat(strip): drive the board from main; retire the square tile grid"
```

---

### Task 10: Documentation sync

**Files:**
- Modify: `docs/design.md` (the "Strip app (Xeneon Edge)" section), `AGENTS.md` (the strip bullets in Conventions)

**Interfaces:** none — prose only. The dated files under `docs/superpowers/` are historical; do not edit them.

- [ ] **Step 1: Rewrite `docs/design.md`'s strip section**

Replace the Geometry/Tile anatomy/Rail subsections with the amended spec's contract. Must state: the 496px (~19.4%) rail; the parent-grouped board (grouping join, nested flattening, orphan tail, group-atomic packing rules including the 7-12 empty-page rule and page-count derivation, the accepted early lineage hop, the scan-order trade-off); fixed 1012×102 cards, up to 12 per page, no flex-resize; primary/subagent card anatomy (status edge + waiting/error border+wash, chip + unread dot, one-line italic-fallback title, 24-point model cap, meta project suppression, status word + in-place-ticking timer, bare badge, origin disc, sub pill + indent + violet spine); rail contents (token block + day-over-day sparkline semantics incl. adjacency and DST elapsed-fraction mapping, unread/health row, countdown-first quota rows with bare binding tag and no ticks, pager); and the additive `dayCurves` contract (running max, ≤96 points, date-keyed rollover). Keep the Interaction subsection, updating "tile" to "card" where needed.

- [ ] **Step 2: Update `AGENTS.md`**

Fix the strip bullets that now lie: the 32%-rail/15-square-tiles sentence in the strip-app bullet, the quota bullet's tick/`binds` wording, and the token bullet (add `dayCurves` + sparkline, note schemaVersion stays 1 and the additive-key compat rule). Point at the new spec by path.

- [ ] **Step 3: Commit**

```bash
git add docs/design.md AGENTS.md
git commit -m "docs: sync strip contract to the board redesign"
```

---

### Task 11: Gate, deploy, and visual verification

**Files:** none new.

- [ ] **Step 1: Full gate**

Run: `bun run check` — Biome, typecheck, daemon + plugin build, full test suite. Must be fully green (pristine output).

- [ ] **Step 2: Deploy both sides locally**

The daemon changed (Task 7), so the full local install applies: `bun scripts/install-local.ts` (accept the Stream Deck confirmation dialog if prompted — the keypad plugin is rebuilt but visually unchanged). Then the strip app: `bun run bundle:app && bun run install:app` (bundle:app runs build:app itself; install:app is `bun scripts/install-app.ts`).

- [ ] **Step 3: Visual verification against the mockup**

With the daemon and app running on the Xeneon Edge: `screencapture -x -D 3 /tmp/strip-live.png` and compare against `docs/superpowers/specs/assets/2026-08-25-strip-board/d6.png` — check: grouped subs indented under their parents with the violet spine, orphan subs at the end, quota percents flush-right with countdown first, 8px bars, sparkline showing today bright over yesterday dim with the `yda` label (yesterday appears only after the collector has lived across a midnight — verify today-only rendering meanwhile), unread dot + green health dot, page dots. Verify tap opens a session, long-press opens the sheet, fling pages (if >12 sessions). If the display runs 1280×360 HiDPI, re-check hairlines are visible.

- [ ] **Step 4: Report**

Present the live screenshot beside d6.png to Drew with any deviations called out. Do not tune visuals beyond the mockup without asking.
