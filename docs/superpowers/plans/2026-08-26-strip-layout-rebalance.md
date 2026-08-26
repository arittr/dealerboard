# Strip Layout Rebalance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebalance the 2560×720 Agent Strip: 760px rail with full-width quota bars spread through the freed height, rates beside an 84px sparkline, 26px unread, and a 2×886 board whose working/idle cards drop the redundant status word — killing the rail scrollbar.

**Architecture:** Pure app-side change (`app/` plus its tests). Four code seams: the sparkline geometry constants (`app/src/token-usage.ts`), the rail's tokens-row/quota-zone DOM (`app/src/rail.ts`), the card status row (`app/src/cards.ts`), and the CSS geometry (`app/styles.css`). No daemon, snapshot-schema, or keypad-plugin changes; render-skip signatures hash model data only and need no edits.

**Tech Stack:** TypeScript (strict, `erasableSyntaxOnly` — no TS parameter properties), Bun test, Biome, lefthook pre-commit (biome + typecheck), Tauri app build.

**Spec:** `docs/superpowers/specs/2026-08-26-strip-layout-rebalance-design.md` (read it first; it carries the approved d7 contract at `docs/superpowers/specs/assets/2026-08-26-strip-layout-rebalance/d7.html` and an adversarial-review record).

## Global Constraints

- Native px convert at 2560×720: `px / 25.6 = vw`, `px / 7.2 = vh`. Copy the exact values from this plan; do not re-derive.
- No CSS-value unit tests (brittle); geometry is proven by `bun run check`, `bun run build:app`, and the live device gate.
- DOM code: all text through `textContent`, never `innerHTML` (existing rule in both renderers).
- Match surrounding code style; Biome and typecheck run in the pre-commit hook — never skip hooks.
- Work happens in the worktree `.worktrees/strip-rebalance-spec` on branch `wip/strip-layout-rebalance` (already rebased onto main `d613c73`).
- Commit after every task with only that task's files.
- The keypad plugin (`src/plugin/`) and everything under `src/core/` are out of bounds.

---

### Task 0: Worktree baseline

**Files:** none modified.

- [ ] **Step 1: Install dependencies in the worktree** (fresh worktrees have no `node_modules`)

Run: `cd /Users/drewritter/projects/stream-deck-agents/.worktrees/strip-rebalance-spec && bun install --frozen-lockfile`

- [ ] **Step 2: Verify the baseline is green**

Run: `bun test`
Expected: all tests pass, 0 failures. If not, STOP and report — do not fix unrelated failures.

---

### Task 1: Sparkline geometry constants (446×84, baseline 78, span 74)

**Files:**
- Modify: `app/src/token-usage.ts:182-188` (constants + comment) and `:196` (comment)
- Test: `test/strip-token-usage.test.ts:222-256` (the four pinned-geometry tests)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `SPARKLINE_VIEWBOX = { width: 446, height: 84 }` (exported const; Task 2's viewBox test and `rail.ts` depend on it). `SPARKLINE_BASELINE_Y = 78`, `SPARKLINE_CURVE_SPAN = 74` stay module-private; the exported functions `sparklinePolylinePoints`, `sparklineFillPoints`, `sparklineEndpoint` keep their signatures.

- [ ] **Step 1: Update the four geometry tests to the new box**

In `test/strip-token-usage.test.ts`, replace the `describe("sparkline SVG geometry", …)` block bodies (keep the same structure):

```ts
describe("sparkline SVG geometry", () => {
  test("polyline points map to d7's 446x84 viewBox: x*446, baseline 78 minus y*74", () => {
    expect(
      sparklinePolylinePoints([
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ]),
    ).toBe("0.00,78.00 223.00,41.00 446.00,4.00");
  });

  test("fill closes today's curve along the baseline at both ends; no points → null", () => {
    expect(
      sparklineFillPoints([
        { x: 0.25, y: 0 },
        { x: 0.75, y: 1 },
      ]),
    ).toBe("111.50,78.00 334.50,4.00 334.50,78.00 111.50,78.00");
    expect(sparklineFillPoints([])).toBeNull();
  });

  test("endpoint is the mapped last point; none when empty", () => {
    expect(
      sparklineEndpoint([
        { x: 0, y: 1 },
        { x: 0.5, y: 0.5 },
      ]),
    ).toEqual({ cx: 223, cy: 41 });
    expect(sparklineEndpoint([])).toBeNull();
  });

  test("the viewBox matches d7's 446x84 box", () => {
    expect(SPARKLINE_VIEWBOX).toEqual({ width: 446, height: 84 });
  });
});
```

(The fill's baseline close at y=78 is deliberate — the d7 asset's close at the box bottom is a mockup artifact; the spec resolves this in favor of the baseline.)

- [ ] **Step 2: Run to verify the four tests fail with the old constants**

Run: `bun test test/strip-token-usage.test.ts`
Expected: exactly 4 failures (values still computed against 436/70/66), everything else passes.

- [ ] **Step 3: Change the constants**

In `app/src/token-usage.ts`, replace lines 182-188:

```ts
/* SVG geometry for the sparkline (d7's exact 446x84 box: curve baseline y=78,
   curve max y=4). Pure and DOM-free so rail.ts stays a thin attribute shell. */

export const SPARKLINE_VIEWBOX = { width: 446, height: 84 } as const;

const SPARKLINE_BASELINE_Y = 78;
const SPARKLINE_CURVE_SPAN = 74;
```

And the comment at line 196: `/** Polyline points attribute for a curve: x*446, 78 − y*74. */`

- [ ] **Step 4: Run to verify green**

Run: `bun test test/strip-token-usage.test.ts && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/token-usage.ts test/strip-token-usage.test.ts
git commit -m "feat(strip): move sparkline geometry to d7's 446x84 box"
```

---

### Task 2: Rail tokens row, quota zone, yda label

**Files:**
- Modify: `app/src/rail.ts` (`sparklineBlock` label at `:134-141`, `tokensSection` at `:148-169`, `renderRail` at `:345-356`, stale 436×80 comments at `:110-111`)
- Test: `test/strip-rail.test.ts` (new tests appended; existing tests must keep passing unchanged)

**Interfaces:**
- Consumes: Task 1's `SPARKLINE_VIEWBOX` (already imported by rail.ts; the viewBox attribute becomes `"0 0 446 84"`).
- Produces: DOM class names Task 4 styles: `.tokens-flow` (the row), `.tokens-rate` (now a stacked column inside it), `.rail-sparkline` (unchanged name), `.rail-quota-zone` (wraps the `.rail-quota` sections). The `.tokens-rate-sep` span is no longer rendered.

- [ ] **Step 1: Write the failing tests**

Append to `test/strip-rail.test.ts` (the file already imports `descendants`, `hasClass`, `renderedText`, `withFakeDocument`, `renderRail`, `model`, `quotaPanel`). Add one import: `import type { TokenUsageRailModel } from "../app/src/token-usage";`

```ts
const visibleTokens = (): TokenUsageRailModel => ({
  state: "ok",
  totalTokens: 562_700_000,
  hour: { tokens: 31_100_000, trend: "up" },
  tenMin: { tokens: 12_200_000, trend: "up" },
  sparkline: {
    today: {
      points: [
        { x: 0, y: 0 },
        { x: 0.65, y: 0.88 },
      ],
    },
    yesterday: {
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      label: "yda 641M",
    },
  },
});

describe("token block layout", () => {
  test("stacks the two rates in a column beside the sparkline, no separator", () => {
    withFakeDocument((root) => {
      renderRail(root as unknown as HTMLElement, model({ tokens: visibleTokens() }), { onJumpToPage: () => {} });
      const tokens = descendants(root).find((node) => node.className === "rail-tokens");
      expect(tokens?.children.map((node) => node.className)).toEqual(["tokens-today", "tokens-flow"]);
      const flow = tokens?.children[1];
      expect(flow?.children.map((node) => node.className)).toEqual(["tokens-rate", "rail-sparkline"]);
      expect(flow?.children[0]?.children).toHaveLength(2);
      expect(descendants(root).some((node) => node.className === "tokens-rate-sep")).toBe(false);
      expect(renderedText(root)).toContain("562.7M today");
      expect(renderedText(root)).toContain("↑ 31.1M/hr");
      expect(renderedText(root)).toContain("↑ 12.2M/10m");
    });
  });

  test("without day curves the row renders the rates column alone", () => {
    withFakeDocument((root) => {
      renderRail(
        root as unknown as HTMLElement,
        model({ tokens: { ...visibleTokens(), sparkline: null } }),
        { onJumpToPage: () => {} },
      );
      const flow = descendants(root).find((node) => node.className === "tokens-flow");
      expect(flow?.children.map((node) => node.className)).toEqual(["tokens-rate"]);
    });
  });

  test("the yda label and viewBox carry d7's 446x84 geometry", () => {
    withFakeDocument((root) => {
      renderRail(root as unknown as HTMLElement, model({ tokens: visibleTokens() }), { onJumpToPage: () => {} });
      const svg = descendants(root).find((node) => node.tagName === "svg");
      expect(svg?.attributes["viewBox"]).toBe("0 0 446 84");
      const label = descendants(root).find((node) => node.tagName === "text");
      expect(label?.attributes["x"]).toBe("444");
      expect(label?.attributes["y"]).toBe("48");
      expect(label?.textContent).toBe("yda 641M");
    });
  });
});

test("quota sections sit inside one flex zone between unread and pager", () => {
  withFakeDocument((root) => {
    renderRail(
      root as unknown as HTMLElement,
      model({ quota: [quotaPanel(), quotaPanel({ provider: "codex" })] }),
      { onJumpToPage: () => {} },
    );
    const zone = descendants(root).find((node) => node.className === "rail-quota-zone");
    expect(zone?.children.map((node) => node.className)).toEqual(["rail-quota", "rail-quota"]);
    expect(root.children.map((node) => node.className.split(" ")[0])).toEqual([
      "rail-unread",
      "rail-quota-zone",
      "rail-pager",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify they fail for the right reasons**

Run: `bun test test/strip-rail.test.ts`
Expected: the four new tests fail — `tokens-flow` doesn't exist, the label is at `x=434/y=30`, no `rail-quota-zone` node. Every pre-existing test still passes.

- [ ] **Step 3: Implement in `app/src/rail.ts`**

Replace `tokensSection` (lines 148-169) — the separator span is deleted; `rateSpan` is unchanged:

```ts
const tokensSection = (model: TokenUsageRailModel): HTMLElement | null => {
  if (model.state === "hidden") {
    return null;
  }
  const section = document.createElement("section");
  section.className = "rail-tokens";
  section.dataset["state"] = model.state;
  const today = document.createElement("div");
  today.className = "tokens-today";
  today.textContent = `${formatTokensCompact(model.totalTokens)} today`;
  const flow = document.createElement("div");
  flow.className = "tokens-flow";
  const rates = document.createElement("div");
  rates.className = "tokens-rate";
  rates.append(rateSpan(model.hour, "hr"), rateSpan(model.tenMin, "10m"));
  flow.append(rates);
  if (model.sparkline !== null) {
    flow.append(sparklineBlock(model.sparkline));
  }
  section.append(today, flow);
  return section;
};
```

In `sparklineBlock`, move the yda label to d7's baseline (lines 134-141):

```ts
  if (sparkline.yesterday !== null) {
    const label = document.createElementNS(SVG_NAMESPACE, "text");
    // d7's baseline: y=48 of the 84px box, right-anchored at x=444.
    label.setAttribute("x", "444");
    label.setAttribute("y", "48");
    label.setAttribute("text-anchor", "end");
    label.setAttribute("font-size", "20");
    label.setAttribute("fill", "#94A3B8");
    label.textContent = sparkline.yesterday.label;
    svg.append(label);
  }
```

Update the stale comment at lines 110-111 to name the new box: `// d7's matched-aspect geometry: the 446x84 viewBox scales uniformly (no` / `// preserveAspectRatio) so strokes and the endpoint circle stay true.`

In `renderRail` (lines 345-356), wrap the quota sections in the zone:

```ts
export const renderRail = (root: HTMLElement, model: RailModel, actions: RailActions): void => {
  const tokens = tokensSection(model.tokens);
  const nowMs = model.now.getTime();
  const zone = document.createElement("div");
  zone.className = "rail-quota-zone";
  zone.append(...model.quota.map((quota) => quotaSection(quota, nowMs)));

  const sections: HTMLElement[] = [];
  if (tokens !== null) {
    sections.push(tokens);
  }
  sections.push(unreadSection(model), zone, pagerSection(model, actions));
  root.replaceChildren(...sections);
};
```

Also update the module doc comment (lines 1-8): the rail now renders "the token block (total over rates-beside-sparkline), the unread row, the quota zone, and page dots".

- [ ] **Step 4: Run to verify green**

Run: `bun test test/strip-rail.test.ts test/strip-quota.test.ts && bun run typecheck`
Expected: all pass (strip-quota exercises the same panels through the model layer).

- [ ] **Step 5: Commit**

```bash
git add app/src/rail.ts test/strip-rail.test.ts
git commit -m "feat(strip): rates beside sparkline, quota zone wrapper"
```

---

### Task 3: Drop the working/idle status word

**Files:**
- Modify: `app/src/cards.ts:189` (the word span append), `test/support/fake-dom.ts` (add `style.setProperty`)
- Test: `test/strip-cards.test.ts` (new DOM tests appended)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: working/idle cards have no `.status-word` node; waiting/error keep it. `FakeElement.style` gains a non-enumerable `setProperty(name, value)` that writes into the same record (later tests may rely on it).

- [ ] **Step 1: Extend the fake DOM**

In `test/support/fake-dom.ts`, replace the constructor (lines 13-15):

```ts
  constructor(tagName: string) {
    this.tagName = tagName;
    // renderBoard sets custom properties (--wash-delay) via the CSSOM API;
    // mirror them into the same record reads use, kept non-enumerable so
    // style-content assertions see only real declarations.
    Object.defineProperty(this.style, "setProperty", {
      enumerable: false,
      value: (name: string, value: string): void => {
        this.style[name] = value;
      },
    });
  }
```

- [ ] **Step 2: Write the failing tests**

Append to `test/strip-cards.test.ts`. Add imports: `renderBoard` to the existing `../app/src/cards` import list, and

```ts
import { descendants, hasClass, withFakeDocument } from "./support/fake-dom";
```

```ts
describe("status word rendering", () => {
  const pageWith = (status: ProjectedSession["status"]) => ({
    cards: [placed({}, { status, statusSince: "2026-08-25T00:08:00.000Z" })],
  });

  test("working and idle cards render dot and timer with no status word", () => {
    for (const status of ["working", "idle"] as const) {
      withFakeDocument((root) => {
        renderBoard(root as unknown as HTMLElement, pageWith(status), false);
        const nodes = descendants(root);
        expect(nodes.some((node) => hasClass(node, "status-word"))).toBe(false);
        expect(nodes.some((node) => hasClass(node, "status-dot"))).toBe(true);
        expect(nodes.filter((node) => hasClass(node, "cardtimer"))).toHaveLength(1);
      });
    }
  });

  test("waiting and error cards keep their bright status word", () => {
    for (const status of ["waiting", "error"] as const) {
      withFakeDocument((root) => {
        renderBoard(root as unknown as HTMLElement, pageWith(status), false);
        const word = descendants(root).find((node) => hasClass(node, "status-word"));
        expect(word?.textContent).toBe(status);
        expect(descendants(root).filter((node) => hasClass(node, "cardtimer"))).toHaveLength(1);
      });
    }
  });
});
```

- [ ] **Step 3: Run to verify the first test fails for the right reason**

Run: `bun test test/strip-cards.test.ts`
Expected: "working and idle cards…" fails because a `.status-word` node IS present; "waiting and error…" already passes. (If instead it fails with a `setProperty`/TypeError, Step 1 is wrong — fix that first.)

- [ ] **Step 4: Implement in `app/src/cards.ts`**

Replace line 189 (`appendText(statusRow, "status-word", model.status);`) with:

```ts
  // Working/idle carry their state in the dot and edge color; only the
  // attention states spell it out.
  if (model.status === "waiting" || model.status === "error") {
    appendText(statusRow, "status-word", model.status);
  }
```

The timer span below it is untouched — its text is `model.timer.slice(model.status.length + 1)`, which never depended on the word span existing.

- [ ] **Step 5: Run to verify green**

Run: `bun test test/strip-cards.test.ts test/strip-board.test.ts && bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/cards.ts test/strip-cards.test.ts test/support/fake-dom.ts
git commit -m "feat(strip): drop the redundant working/idle status word"
```

---

### Task 4: CSS geometry — 760 rail, 886 cards, tokens row, quota zone

**Files:**
- Modify: `app/styles.css`

No unit tests (global constraint: no CSS-value assertions); this task's gates are typecheck-free builds and the device. Apply each change exactly:

- [ ] **Step 1: Strip and board widths**

`#strip` (line ~15-21): `grid-template-columns: 1fr 23.4375%; /* 600px native rail */` → `grid-template-columns: 1fr 29.6875%; /* 760px native rail */`

`#board` block comment (line ~23): "two 966px columns" → "two 886px columns" (leave the rest of the comment intact).

`#board` rule: `grid-template-columns: repeat(2, 37.734vw); /* 966px native */` → `grid-template-columns: repeat(2, 34.609vw); /* 886px native */`

- [ ] **Step 2: Tokens row**

Replace the `.tokens-rate` rule:

```css
/* The two rolling rates stack in a fixed column beside the sparkline; the
   240px width holds the widest compact value (→ 999.9M/10m ≈ 216px). */
.tokens-flow {
  display: flex;
  align-items: flex-end;
  gap: 0.703vw; /* 18px native */
  margin-top: 1.389vh; /* 10px native */
}
.tokens-rate {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.833vh; /* 6px native */
  width: 9.375vw; /* 240px native */
  color: #94a3b8;
  font-size: 1.2vw;
}
```

Delete the `.tokens-rate-sep` rule entirely (the span is gone). Keep the `[data-trend]` color rules unchanged.

- [ ] **Step 3: Sparkline box**

Replace the `.rail-sparkline` rule and its comment block (lines ~518-530):

```css
/* d7's day-over-day sparkline: a 446x84-native box beside the rates — faint
   fill under today's curve, dim yesterday line, bright today line, endpoint
   dot, and the yda micro-label as SVG text at d7's baseline (uniform
   viewBox scaling keeps it 20px native). */
.rail-sparkline {
  position: relative;
  flex: 1;
  min-width: 0;
  /* Match the 446x84 viewBox's aspect so the uniformly scaled SVG fills the
     row's remaining width instead of centering with side gaps. */
  aspect-ratio: 446 / 84;
  overflow: visible; /* the endpoint dot sits at the plot edge */
}
```

(The old `margin-top: 0.547vw` dies with the stacked layout; `.tokens-flow` owns the spacing now.)

- [ ] **Step 4: Unread and quota zone**

`.rail-unread`: add `margin-top: 1.667vh; /* + the rail gap ≈ 20px below the token block */` and `font-size: 1.016vw; /* 26px native */`.

Add after the `.rail-unread.active` rule:

```css
/* The quota panels share one flex zone that absorbs the rail's free height,
   spreading the meters evenly instead of packing them (the reclaimed space
   goes between the bars). */
.rail-quota-zone {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: space-evenly;
  min-height: 0;
}
```

- [ ] **Step 5: Build and full suite**

Run: `bun run check && bun run build:app`
Expected: Biome clean, both typechecks pass, all tests pass, app bundle builds (the known pre-existing Rollup `this` warning is acceptable; nothing else).

- [ ] **Step 6: Commit**

```bash
git add app/styles.css
git commit -m "feat(strip): 760px rail, 886px cards, tokens-row geometry"
```

---

### Task 5: Update docs/design.md to the new contract

**Files:**
- Modify: `docs/design.md` (Geometry ~:339-341, Card anatomy ~:448-460, Rail ~:470-492)

- [ ] **Step 1: Geometry section** — in the first Geometry bullet replace "the fixed 600px rail (~23.4%)" with "the fixed 760px rail (~29.7%)" and "two 966×102 columns" with "two 886×102 columns".

- [ ] **Step 2: Card anatomy** — replace the status-row bullet (currently "Right-aligned on the head line: status dot + status word + tabular-numeral elapsed timer…") with:

```markdown
- Right-aligned on the head line: status dot + tabular-numeral elapsed
  timer (`statusSince`, the row's own status stamp), ticking in place on
  the 1s rail cadence so the render-signature skip and CSS animations are
  never disturbed. Working and idle cards render no status word — the dot
  and edge color carry the state; waiting and error keep their bright bold
  word. Every child uses its own provider, model, title, effective status,
  and timer rather than inheriting display facts from its parent.
```

In the subagent bullet: "(922×102, right edges flush)" → "(842×102, right edges flush)" and "at full 966px width" → "at full 886px width".

- [ ] **Step 3: Rail section** — "Fixed 600px (~23.4%), top to bottom:" → "Fixed 760px (~29.7%), top to bottom:". Replace the token-block and sparkline bullets with:

```markdown
- **Token block**: today's total (`48.9M today`) over a row that puts the
  two trend-colored rolling rates — stacked vertically in a fixed 240px
  column, no separator — beside the day-over-day sparkline. Rate semantics
  are unchanged, still computed from the 288-sample ring, which is retained
  unchanged and remains the sole input to the rates. With no day curves the
  row renders the rates column alone.
- **Day-over-day sparkline** beside the rates: a midnight-anchored LA-day
  x-axis with yesterday's complete cumulative curve as a dim 2px line
  ending in a `yda <total>` micro-label (an SVG `<text>` at the mockup's
  baseline) and today's partial curve as a bright 2px line with a faint
  fill, ending in an endpoint dot at the current position, all in a
  matched-aspect 446×84 viewBox. Semantics:
```

(keep the four sub-bullets under it unchanged). In the unread bullet append: "The unread text renders at 26px — quieter than the token totals." After the pager bullet's section-order context, add one bullet before **Pager dots**:

```markdown
- The five quota panels share one flex zone that absorbs the rail's free
  height, spreading the meters evenly; tokens, unread, and pager keep
  fixed spacing.
```

- [ ] **Step 4: Verify no stale numbers remain**

Run: `rg -n "966|600px|436|922" docs/design.md`
Expected: no hits describing the strip's current contract (hits inside dated specs/history sections are fine — docs/design.md has none; if a hit remains, judge whether it states current behavior and fix it).

- [ ] **Step 5: Commit**

```bash
git add docs/design.md
git commit -m "docs: record the rebalanced strip layout contract"
```

---

### Task 6: Full gate, install, live verification

**Files:** none modified (operational task).

- [ ] **Step 1: Full repository gate**

Run: `bun run check`
Expected: Biome clean, both typechecks, core + plugin builds, full suite green.

- [ ] **Step 2: Guard against a concurrent installer, then install the app**

Run: `pgrep -fl 'install-app|install-local|tauri build|cargo build' || true` — if anything is running, wait for it to finish before proceeding.
Then: `bun run install:app`
Expected: bundle build + `/Applications/Agent Strip.app` install succeed.

- [ ] **Step 3: Relaunch and verify runtime invariants**

Run: `open -a "Agent Strip"`, then
`lsof "$HOME/Library/Application Support/com.drewritter.stream-deck-agents/registry.sqlite3"`
Expected: exactly one installed daemon owns the registry (no source daemon started by this work — the daemon is untouched).

- [ ] **Step 4: Capture the live strip**

Identify the Xeneon display index with `system_profiler SPDisplaysDataType | rg -n "Resolution|Display"` and capture it: `screencapture -x -D <index> /tmp/strip-rebalance-live.png`, then view the image. Verify against the spec: no scrollbar; rail 760 with the quota zone spread and full-width bars; rates stacked beside the 84px sparkline; 26px unread; both Claude accounts legible; board 2×886 with working/idle cards showing dot+timer only and waiting cards keeping the bright word; no clipping anywhere.

- [ ] **Step 5: Hand to Drew for the physical Xeneon gate**

Report the capture and stop. Drew's physical approval is the completion gate — code and tests passing is not it. Do not merge to main until Drew approves the live result.

---

## Self-review record

Spec coverage: strip grid + board widths (T4), status word (T3), tokens row DOM (T2) and CSS (T4), sparkline constants (T1) with label/viewBox (T2), unread size (T4), quota zone (T2 DOM, T4 CSS), docs (T5), gates + install + physical (T6), fake-dom prerequisite (T3 Step 1). Non-goals honored: no daemon/plugin/board-reducer edits anywhere. Type consistency: `.tokens-flow` / `.rail-quota-zone` names match between T2 tests, T2 implementation, and T4 CSS; `SPARKLINE_VIEWBOX` values match between T1 and T2's `"0 0 446 84"` assertion.
