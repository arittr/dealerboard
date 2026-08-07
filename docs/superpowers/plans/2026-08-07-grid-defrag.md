# Grid Defrag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Stream Deck grid pack session tiles densely in slot-rank order (no blank holes) and switch the overflow latch from slot-number-based to count-based.

**Architecture:** Pure plugin-side change. The daemon registry keeps assigning stable lowest-free logical slots; `src/plugin/layout.ts` stops treating `logicalSlot` as a physical position and treats it as an ordering key — sessions sort by slot and pack onto keys by rank. Overflow pages become uniform dense 14-rank slices with a count-based hysteresis latch (engages at 16+ live sessions, holds at 15, releases at 14 or fewer).

**Tech Stack:** Bun, TypeScript, `bun:test`. The layout reducer is pure (no I/O, no SDK imports).

Spec: `docs/superpowers/specs/2026-08-06-grid-defrag-design.md`

## Global Constraints

- Only three files change: `src/plugin/layout.ts`, `test/layout.test.ts`, `docs/design.md`. Daemon, registry, projection, protocol, controller, and render code stay untouched.
- `LayoutSettingsV1` wire shape unchanged: `{ schemaVersion: 1, overflowLatched: boolean, currentPage: number }` — no settings migration.
- Exported API signatures of `src/plugin/layout.ts` are unchanged (`reduceLayout`, `advanceLayoutPage`, `DEFAULT_LAYOUT_SETTINGS`, types `KeyModel`, `LayoutSettingsV1`, `LayoutResult`); `src/plugin/controller.ts` compiles against them unmodified.
- Tile visuals (colors, geometry, animation) are unchanged — placement only.
- Run tests with `bun test`, type-check with `bun run typecheck`, bundle with `bun run build:plugin`.
- Do not edit dated files under `docs/superpowers/` — they are historical records.

---

### Task 1: Rank-packing layout reducer

**Files:**
- Modify: `src/plugin/layout.ts` (full rewrite of the reducer internals)
- Test: `test/layout.test.ts` (rewrite the placement/latch/paging describes)

**Interfaces:**
- Consumes: `SnapshotView` from `src/plugin/snapshot-reader.ts` (`{ snapshot: SessionSnapshotV1; degraded: boolean }`); `ProjectedSession` from `src/protocol.ts`.
- Produces (all unchanged signatures, consumed by `src/plugin/controller.ts`): `reduceLayout(view: SnapshotView, storedState: unknown): LayoutResult`; `advanceLayoutPage(view: SnapshotView, storedState: unknown): LayoutResult`; `DEFAULT_LAYOUT_SETTINGS: LayoutSettingsV1`; types `KeyModel`, `LayoutSettingsV1`, `LayoutResult`.
- Internal deletions: `FIRST_OVERFLOW_SLOT`, `pageStartSlot`, `pageForSlot`, `clampToNonEmptyPage`, and `nonEmptyPages` (replaced by a dense `pageCount`). Internal additions: `MAX_UNPAGED_SESSIONS = 15`, `sortedSessions(view)`.

- [ ] **Step 1: Rewrite the failing tests**

In `test/layout.test.ts`, keep everything at the top of the file unchanged (imports and the `session`, `range`, `sessionsAt`, `healthySnapshot`, `healthyView`, `settings`, `sessionKeyAt`, `labelFor` helpers) and keep the final `describe("SnapshotCache", ...)` block unchanged. Replace the four placement-related describes with the code below.

Replace `describe("reduceLayout without overflow", ...)` entirely:

```ts
describe("reduceLayout without overflow", () => {
  test("packs sessions densely in slot order, filling gaps", () => {
    const result = reduceLayout(healthyView(sessionsAt(2, 5)), DEFAULT_LAYOUT_SETTINGS);
    expect(result.keys).toHaveLength(15);
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(2);
    expect(sessionKeyAt(result.keys, 1).session.logicalSlot).toBe(5);
    for (let index = 2; index < 15; index++) {
      expect(result.keys[index]).toEqual({ kind: "blank", degraded: false });
    }
  });

  test("maps up to fifteen sessions onto keys in rank order", () => {
    const result = reduceLayout(
      healthyView(sessionsAt(...range(1, 15))),
      DEFAULT_LAYOUT_SETTINGS,
    );
    expect(result.keys).toHaveLength(15);
    for (let index = 0; index < 15; index++) {
      expect(sessionKeyAt(result.keys, index).session.logicalSlot).toBe(index + 1);
    }
    expect(result.settings).toEqual(settings(false, 0));
    expect(result.dirty).toBe(false);
  });

  test("sorts sessions by logical slot defensively", () => {
    const result = reduceLayout(
      healthyView([session(7), session(1), session(3)]),
      DEFAULT_LAYOUT_SETTINGS,
    );
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(1);
    expect(sessionKeyAt(result.keys, 1).session.logicalSlot).toBe(3);
    expect(sessionKeyAt(result.keys, 2).session.logicalSlot).toBe(7);
  });

  test("shifts later ranks left on removal and right on insertion at a freed slot", () => {
    // Slot 3 has ended: the slot-4 and slot-5 tiles sit one key left.
    const afterEnd = reduceLayout(healthyView(sessionsAt(1, 2, 4, 5)), DEFAULT_LAYOUT_SETTINGS);
    expect(sessionKeyAt(afterEnd.keys, 1).session.logicalSlot).toBe(2);
    expect(sessionKeyAt(afterEnd.keys, 2).session.logicalSlot).toBe(4);
    expect(sessionKeyAt(afterEnd.keys, 3).session.logicalSlot).toBe(5);
    expect(afterEnd.keys[4]).toEqual({ kind: "blank", degraded: false });

    // A new session allocated the freed slot 3 inserts at rank 2, shifting
    // the slot-4 and slot-5 tiles one key right.
    const afterStart = reduceLayout(
      healthyView(sessionsAt(1, 2, 3, 4, 5)),
      DEFAULT_LAYOUT_SETTINGS,
    );
    expect(sessionKeyAt(afterStart.keys, 2).session.logicalSlot).toBe(3);
    expect(sessionKeyAt(afterStart.keys, 3).session.logicalSlot).toBe(4);
    expect(sessionKeyAt(afterStart.keys, 4).session.logicalSlot).toBe(5);
  });

  test("does not latch overflow at fifteen live sessions", () => {
    const result = reduceLayout(
      healthyView(sessionsAt(...range(1, 15))),
      DEFAULT_LAYOUT_SETTINGS,
    );
    expect(sessionKeyAt(result.keys, 14).session.logicalSlot).toBe(15);
    expect(result.settings).toEqual(settings(false, 0));
    expect(result.dirty).toBe(false);
  });
});
```

Replace `describe("reduceLayout overflow latch", ...)` entirely:

```ts
describe("reduceLayout overflow latch", () => {
  test("latches overflow when the live count exceeds fifteen", () => {
    const result = reduceLayout(
      healthyView(sessionsAt(...range(1, 16))),
      DEFAULT_LAYOUT_SETTINGS,
    );
    expect(result.keys).toHaveLength(15);
    for (let index = 0; index < 14; index++) {
      expect(sessionKeyAt(result.keys, index).session.logicalSlot).toBe(index + 1);
    }
    expect(result.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 2, degraded: false });
    expect(result.settings).toEqual(settings(true, 0));
    expect(result.dirty).toBe(true);
  });

  test("latches on count, not slot numbers: sparse high slots pack densely", () => {
    // Sixteen live sessions at sparse slots 1..8 and 20..27: page one shows
    // the fourteen lowest ranks with no holes.
    const sparse = sessionsAt(...range(1, 8), ...range(20, 27));
    const result = reduceLayout(healthyView(sparse), DEFAULT_LAYOUT_SETTINGS);
    expect(result.settings).toEqual(settings(true, 0));
    expect(result.dirty).toBe(true);
    for (let index = 0; index < 8; index++) {
      expect(sessionKeyAt(result.keys, index).session.logicalSlot).toBe(index + 1);
    }
    for (let index = 8; index < 14; index++) {
      expect(sessionKeyAt(result.keys, index).session.logicalSlot).toBe(index + 12);
    }
    expect(result.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 2, degraded: false });

    // A single high-slot session never latches and packs to the first key.
    const alone = reduceLayout(healthyView(sessionsAt(20)), DEFAULT_LAYOUT_SETTINGS);
    expect(alone.settings).toEqual(settings(false, 0));
    expect(sessionKeyAt(alone.keys, 0).session.logicalSlot).toBe(20);
    for (let index = 1; index < 15; index++) {
      expect(alone.keys[index]).toEqual({ kind: "blank", degraded: false });
    }
  });

  test("holds the latch at fifteen live sessions", () => {
    const latched = reduceLayout(
      healthyView(sessionsAt(...range(1, 16))),
      DEFAULT_LAYOUT_SETTINGS,
    ).settings;
    const fifteen = sessionsAt(...range(1, 15));
    const held = reduceLayout(healthyView(fifteen), latched);
    expect(held.settings).toEqual(settings(true, 0));
    expect(held.dirty).toBe(false);
    expect(held.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 2, degraded: false });

    // The fifteenth rank sits alone on the second page.
    const secondPage = reduceLayout(healthyView(fifteen), settings(true, 1));
    expect(sessionKeyAt(secondPage.keys, 0).session.logicalSlot).toBe(15);
    for (let index = 1; index < 14; index++) {
      expect(secondPage.keys[index]).toEqual({ kind: "blank", degraded: false });
    }
    expect(secondPage.keys[14]).toEqual({ kind: "next", page: 2, pageCount: 2, degraded: false });
    expect(secondPage.dirty).toBe(false);
  });

  test("releases the latch at fourteen live sessions", () => {
    const result = reduceLayout(healthyView(sessionsAt(...range(1, 14))), settings(true, 0));
    expect(result.settings).toEqual(settings(false, 0));
    expect(result.dirty).toBe(true);
    for (let index = 0; index < 14; index++) {
      expect(sessionKeyAt(result.keys, index).session.logicalSlot).toBe(index + 1);
    }
    expect(result.keys[14]).toEqual({ kind: "blank", degraded: false });
  });
});
```

Replace `describe("paging", ...)` entirely:

```ts
describe("paging", () => {
  // Thirty live sessions make three dense pages: ranks 0..13, 14..27, and
  // the two remaining ranks 28..29.
  const fullView = healthyView(sessionsAt(...range(1, 30)));

  test("NEXT advances through dense fourteen-rank pages and wraps", () => {
    const first = reduceLayout(fullView, settings(true, 0));
    expect(sessionKeyAt(first.keys, 0).session.logicalSlot).toBe(1);
    expect(sessionKeyAt(first.keys, 13).session.logicalSlot).toBe(14);
    expect(first.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 3, degraded: false });

    const second = advanceLayoutPage(fullView, settings(true, 0));
    expect(second.settings).toEqual(settings(true, 1));
    expect(second.dirty).toBe(true);
    expect(sessionKeyAt(second.keys, 0).session.logicalSlot).toBe(15);
    expect(sessionKeyAt(second.keys, 13).session.logicalSlot).toBe(28);
    expect(second.keys[14]).toEqual({ kind: "next", page: 2, pageCount: 3, degraded: false });

    const third = advanceLayoutPage(fullView, settings(true, 1));
    expect(third.settings).toEqual(settings(true, 2));
    expect(sessionKeyAt(third.keys, 0).session.logicalSlot).toBe(29);
    expect(sessionKeyAt(third.keys, 1).session.logicalSlot).toBe(30);
    for (let index = 2; index < 14; index++) {
      expect(third.keys[index]).toEqual({ kind: "blank", degraded: false });
    }
    expect(third.keys[14]).toEqual({ kind: "next", page: 3, pageCount: 3, degraded: false });

    const wrapped = advanceLayoutPage(fullView, settings(true, 2));
    expect(wrapped.settings).toEqual(settings(true, 0));
    expect(wrapped.dirty).toBe(true);
    expect(sessionKeyAt(wrapped.keys, 0).session.logicalSlot).toBe(1);
    expect(wrapped.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 3, degraded: false });
  });

  test("clamps an out-of-range current page to the last page", () => {
    const view = healthyView(sessionsAt(...range(1, 16)));
    const clamped = reduceLayout(view, settings(true, 9));
    expect(clamped.settings).toEqual(settings(true, 1));
    expect(clamped.dirty).toBe(true);
    expect(sessionKeyAt(clamped.keys, 0).session.logicalSlot).toBe(15);
    expect(sessionKeyAt(clamped.keys, 1).session.logicalSlot).toBe(16);
    expect(clamped.keys[14]).toEqual({ kind: "next", page: 2, pageCount: 2, degraded: false });
  });

  test("NEXT without the latch preserves the base reduction", () => {
    const view = healthyView(sessionsAt(1, 2, 3));
    const result = advanceLayoutPage(view, DEFAULT_LAYOUT_SETTINGS);
    expect(result.settings).toEqual(settings(false, 0));
    expect(result.dirty).toBe(false);
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(1);

    // A stored latch that no longer qualifies releases and stays unadvanced.
    const released = advanceLayoutPage(view, settings(true, 1));
    expect(released.settings).toEqual(settings(false, 0));
    expect(released.dirty).toBe(true);
  });
});
```

In `describe("settings validation and dirty marking", ...)`, keep the first two tests unchanged and replace the body of the third test (`"marks settings dirty only after NEXT or a validation, clamping, or latch change"`) with:

```ts
  test("marks settings dirty only after NEXT or a validation, clamping, or latch change", () => {
    const full = healthyView(sessionsAt(...range(1, 16)));
    // Steady state: valid settings, stable snapshot → clean.
    expect(reduceLayout(full, settings(true, 1)).dirty).toBe(false);
    expect(reduceLayout(healthyView([]), DEFAULT_LAYOUT_SETTINGS).dirty).toBe(false);
    // Latch engage and release → dirty.
    expect(reduceLayout(full, DEFAULT_LAYOUT_SETTINGS).dirty).toBe(true);
    expect(reduceLayout(healthyView(sessionsAt(...range(1, 14))), settings(true, 0)).dirty).toBe(
      true,
    );
    // Clamping → dirty.
    expect(reduceLayout(full, settings(true, 9)).dirty).toBe(true);
    // Validation repair → dirty.
    expect(reduceLayout(full, "garbage").dirty).toBe(true);
    // NEXT → dirty.
    expect(advanceLayoutPage(full, settings(true, 0)).dirty).toBe(true);
  });
```

In `describe("KeyModel structure", ...)`, keep the first and third tests unchanged and replace the body of the second test (`"keeps provider, status, descendant count, and logical slot on the session model"`) with — note the key index is now `0` because a lone session packs to the first key:

```ts
  test("keeps provider, status, descendant count, and logical slot on the session model", () => {
    const original = session(4, {
      provider: "codex",
      status: "waiting",
      descendantCount: 3,
      title: "Review",
    });
    // A lone session packs to rank 0 regardless of its logical slot.
    const model = sessionKeyAt(
      reduceLayout(healthyView([original]), DEFAULT_LAYOUT_SETTINGS).keys,
      0,
    );
    expect(model.session).toEqual(original);
    expect(model.session.provider).toBe("codex");
    expect(model.session.status).toBe("waiting");
    expect(model.session.descendantCount).toBe(3);
    expect(model.session.logicalSlot).toBe(4);
    expect(model.label).toBe("Review");
    expect(model.degraded).toBe(false);
  });
```

- [ ] **Step 2: Run the layout tests to verify they fail**

Run: `bun test test/layout.test.ts`
Expected: FAIL — the new packing, count-latch, dense-paging, and clamp tests fail against the old slot-positional reducer (e.g. "packs sessions densely in slot order" expects a session at key 0 but the old code renders a blank there). The settings-validation, label, and SnapshotCache tests still pass.

- [ ] **Step 3: Rewrite the reducer**

Replace the entire contents of `src/plugin/layout.ts` with:

```ts
/**
 * Pure paging reducer for the 5x3 Stream Deck profile.
 *
 * Maps live sessions onto fifteen physical keys in dense slot-rank order.
 * Sessions sort by their stable logical slot and pack onto keys by rank, so
 * the grid never shows holes between tiles: a session ending shifts later
 * tiles one key left, and a new session reusing a freed slot inserts at that
 * rank, shifting later tiles one key right. Without overflow, ranks 0..14
 * land on keys 0..14. Once the live count exceeds fifteen, the overflow
 * latch engages: keys 0..13 show the current page's fourteen ranks and key
 * 14 is NEXT; pages are uniform dense fourteen-rank slices. The latch holds
 * while the live count is at least fifteen and ends at fourteen or fewer. An
 * out-of-range current page clamps to the last page.
 *
 * All page/latch state lives in this module as validated settings; the
 * reducer performs no I/O and imports no Stream Deck SDK types.
 */

import type { ProjectedSession } from "../protocol";
import type { SnapshotView } from "./snapshot-reader";

export type KeyModel =
  | { kind: "blank"; degraded: boolean }
  | { kind: "next"; page: number; pageCount: number; degraded: boolean }
  | { kind: "session"; session: ProjectedSession; label: string; degraded: boolean };

export type LayoutSettingsV1 = {
  schemaVersion: 1;
  overflowLatched: boolean;
  currentPage: number;
};

export type LayoutResult = {
  /** Validated, clamped, latch-updated settings to persist when dirty. */
  settings: LayoutSettingsV1;
  /** True only after NEXT or a validation, clamping, or latch change. */
  dirty: boolean;
  /** Exactly fifteen models, one per physical key, row-major. */
  keys: KeyModel[];
};

export const DEFAULT_LAYOUT_SETTINGS: LayoutSettingsV1 = {
  schemaVersion: 1,
  overflowLatched: false,
  currentPage: 0,
};

const KEY_COUNT = 15;
const PAGE_SESSION_KEYS = 14;
const MAX_UNPAGED_SESSIONS = 15;
const SHORT_SESSION_ID_LENGTH = 8;

const labelForSession = (session: ProjectedSession): string => {
  if (session.title !== null && session.title.length > 0) {
    return session.title;
  }
  if (session.project !== null && session.project.length > 0) {
    return session.project;
  }
  return `${session.provider} ${session.sessionId.slice(0, SHORT_SESSION_ID_LENGTH)}`;
};

const sessionKey = (session: ProjectedSession | undefined, degraded: boolean): KeyModel =>
  session === undefined
    ? { kind: "blank", degraded }
    : { kind: "session", session, label: labelForSession(session), degraded };

const buildKeys = (
  sessions: readonly ProjectedSession[],
  degraded: boolean,
  settings: LayoutSettingsV1,
  pageCount: number,
): KeyModel[] => {
  const keys: KeyModel[] = [];
  if (!settings.overflowLatched) {
    for (let key = 0; key < KEY_COUNT; key++) {
      keys.push(sessionKey(sessions[key], degraded));
    }
    return keys;
  }
  const start = settings.currentPage * PAGE_SESSION_KEYS;
  for (let key = 0; key < PAGE_SESSION_KEYS; key++) {
    keys.push(sessionKey(sessions[start + key], degraded));
  }
  keys.push({
    kind: "next",
    page: settings.currentPage + 1,
    pageCount,
    degraded,
  });
  return keys;
};

type ValidatedSettings = {
  settings: LayoutSettingsV1;
  defaulted: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validateStoredSettings = (stored: unknown): ValidatedSettings => {
  if (isRecord(stored)) {
    const value = stored;
    if (
      value.schemaVersion === 1 &&
      typeof value.overflowLatched === "boolean" &&
      typeof value.currentPage === "number" &&
      Number.isSafeInteger(value.currentPage) &&
      value.currentPage >= 0
    ) {
      return {
        settings: {
          schemaVersion: 1,
          overflowLatched: value.overflowLatched,
          currentPage: value.currentPage,
        },
        defaulted: false,
      };
    }
  }
  return { settings: { ...DEFAULT_LAYOUT_SETTINGS }, defaulted: true };
};

type InternalLayout = LayoutResult & { pageCount: number };

/** Sort defensively by logical slot even though the daemon already orders. */
const sortedSessions = (view: SnapshotView): ProjectedSession[] =>
  [...view.snapshot.sessions].sort((a, b) => a.logicalSlot - b.logicalSlot);

const reduceInternal = (view: SnapshotView, storedState: unknown): InternalLayout => {
  const sessions = sortedSessions(view);
  const count = sessions.length;
  const { settings: restored, defaulted } = validateStoredSettings(storedState);

  // The latch engages only when the live count exceeds fifteen; once engaged
  // it holds while at least fifteen sessions remain live.
  const overflow = restored.overflowLatched
    ? count >= MAX_UNPAGED_SESSIONS
    : count > MAX_UNPAGED_SESSIONS;

  if (!overflow) {
    const settings: LayoutSettingsV1 = { ...DEFAULT_LAYOUT_SETTINGS };
    const dirty = defaulted || restored.overflowLatched || restored.currentPage !== 0;
    return {
      settings,
      dirty,
      keys: buildKeys(sessions, view.degraded, settings, 1),
      pageCount: 1,
    };
  }

  // Latched pages are dense by construction, so every page in range is
  // non-empty and clamping reduces to bounding the page index.
  const pageCount = Math.ceil(count / PAGE_SESSION_KEYS);
  const currentPage = Math.min(restored.currentPage, pageCount - 1);
  const settings: LayoutSettingsV1 = { schemaVersion: 1, overflowLatched: true, currentPage };
  const dirty = defaulted || !restored.overflowLatched || restored.currentPage !== currentPage;
  return {
    settings,
    dirty,
    keys: buildKeys(sessions, view.degraded, settings, pageCount),
    pageCount,
  };
};

export const reduceLayout = (view: SnapshotView, storedState: unknown): LayoutResult => {
  const { settings, dirty, keys } = reduceInternal(view, storedState);
  return { settings, dirty, keys };
};

/**
 * Advance to the next page, wrapping. Without overflow, or with a single
 * page, nothing moves and the base reduction's dirty flag is preserved.
 */
export const advanceLayoutPage = (view: SnapshotView, storedState: unknown): LayoutResult => {
  const base = reduceInternal(view, storedState);
  if (!base.settings.overflowLatched || base.pageCount <= 1) {
    return { settings: base.settings, dirty: base.dirty, keys: base.keys };
  }
  const currentPage = (base.settings.currentPage + 1) % base.pageCount;
  const settings: LayoutSettingsV1 = { ...base.settings, currentPage };
  return {
    settings,
    dirty: true,
    keys: buildKeys(sortedSessions(view), view.degraded, settings, base.pageCount),
  };
};
```

- [ ] **Step 4: Run the layout tests to verify they pass**

Run: `bun test test/layout.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Full verification and controller-fixture audit**

Run: `bun test && bun run typecheck && bun run build:plugin`
Expected: all green. `test/controller.test.ts` passes unmodified — its fixtures are dense (slots `1..15`, `1..16`, `1..17`), and the count-based latch/paging/clamp produce identical results for dense inputs (16 sessions latch with NEXT `1/2`; stored page 5 clamps to page 1; 17 sessions keep two pages and write nothing). If any other fixture turns out to depend on gap behavior, update its expectations to the packed semantics from Step 1 — do not change controller source.

- [ ] **Step 6: Commit**

```bash
git add src/plugin/layout.ts test/layout.test.ts
git commit -m "Pack session tiles densely by slot rank"
```

### Task 2: Update the visible-contract docs

**Files:**
- Modify: `docs/design.md` ("Stable logical placement" and "Overflow" sections, lines ~75-98)

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: the updated visible-tile contract the AGENTS.md convention requires for placement changes.

- [ ] **Step 1: Replace the placement and overflow sections**

In `docs/design.md`, replace this exact block (from `### Stable logical placement` through the end of the `### Overflow` section):

```markdown
### Stable logical placement

- A new top-level session takes the lowest free logical slot.
- State, title, badge, and capability changes never reassign it.
- Removal releases the slot.
- Other live sessions are not compacted into gaps.
- Stability is guaranteed only while registry membership is uninterrupted. A lease expiry removes the assignment; a later observation allocates normally.

With no overflow, logical slots 1 through 15 map to physical keys 1 through 15.

### Overflow

When all first 15 logical slots are occupied and another session arrives:

- Physical keys 1 through 14 display sessions from the current page.
- Physical key 15 becomes `NEXT` on every page.
- The session in logical slot 15 becomes the first session on page two.
- The new logical-slot-16 session becomes the second session on page two.
- Further pages contain 14 logical slots each.
- `NEXT` cycles through non-empty pages and wraps.
- Vacated logical cells remain blank until reused by the lowest-free allocator.
- If the current page empties, select the nearest earlier non-empty page; if none exists, select the earliest later page.

Drew chose not to compact slot 15 back automatically after overflow. Therefore overflow is an explicit persisted projection latch, not something derived solely from the current count. It ends when no live higher-page session remains, including the slot-15 session moved to page two. Moving slot 15 into overflow is the only permitted live-session movement.
```

with:

```markdown
### Stable logical placement

- A new top-level session takes the lowest free logical slot.
- State, title, badge, and capability changes never reassign it.
- Removal releases the slot.
- The logical slot is an ordering key, not a position. The visible grid packs live sessions densely in slot order: removal shifts every later tile one key left, and a new session reusing a freed slot inserts at that rank, shifting later tiles one key right. Blank keys appear only after the last live tile.
- Stability is guaranteed only while registry membership is uninterrupted. A lease expiry removes the assignment; a later observation allocates normally.

With no overflow, the packed rank order maps to physical keys 1 through 15 in order.

### Overflow

When the live session count exceeds fifteen:

- Physical keys 1 through 14 display the current page's fourteen sessions in rank order.
- Physical key 15 becomes `NEXT` on every page.
- Pages are dense fourteen-tile slices of the rank order.
- `NEXT` cycles through pages and wraps.
- An out-of-range current page clamps to the last page.

Overflow is an explicit persisted projection latch with hysteresis, not something derived solely from the instantaneous count: it engages when the live count exceeds fifteen, holds while at least fifteen sessions are live, and ends at fourteen or fewer. Live sessions reflow as membership changes; the grid never shows holes between tiles.
```

- [ ] **Step 2: Commit**

```bash
git add docs/design.md
git commit -m "Document dense grid packing and count-based overflow"
```

## After the plan (manual, user-gated)

Optional on-device verification via the AGENTS.md deploy loop (bump manifest `Version`, `bun run build:plugin`, copy bundle + manifest to the installed plugin, `streamdeck restart`) — only after asking the user, since it restarts their local plugin process. On device: end a middle session and watch later tiles shift left; start a new session and watch it fill the lowest freed rank; exceed fifteen live sessions to confirm the count-based latch and NEXT paging.
