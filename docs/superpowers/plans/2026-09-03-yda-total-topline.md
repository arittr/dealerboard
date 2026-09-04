# Yesterday's Total on the Top Line — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show yesterday's daily token total beside today's on the rail's top line, colored to match the yesterday chart line, and remove the chart's floating `yda` marker.

**Architecture:** Pure view-model derivation in `app/src/token-usage.ts` (new `yesterdayTotalTokens` field on `TokenUsageRailModel`, derived from the existing `dayCurves` snapshot data), thin DOM rendering in `app/src/rail.ts`, styling in `app/styles.css`. No collector, snapshot-schema, protocol, or polling changes.

**Tech Stack:** Bun + TypeScript, hand-rolled DOM/SVG (no framework), biome for lint/format, `bun:test` with the `test/support/fake-dom.ts` harness.

Spec: `docs/superpowers/specs/2026-09-03-yda-total-topline-design.md`

## Global Constraints

- Do NOT touch `src/token-usage-snapshot.ts`, `src/core/token-usage.ts`, the collector, the protocol, or polling.
- Exact visual values: yda text `#60a5fa`, separator `·` in `#475569`, both `font-size: 1.0vw; font-weight: 600`.
- Format the total with the existing `formatTokensCompact`.
- The total is the newest point of the adjacent yesterday curve *inside its own LA day bounds*; it is NOT gated on the chart overlay's two-consecutive-bucket eligibility.
- TDD: write the failing test first in every task.
- `bun test` does not typecheck; the gate is `bun run check` (biome + `tsc --noEmit` + build + tests). Pre-commit hooks run biome/typecheck on staged files, so every commit must typecheck the whole project.
- Commit after each task with the given message.

---

### Task 1: Derive `yesterdayTotalTokens` on the rail model

**Files:**
- Modify: `app/src/token-usage.ts` (type at lines 26-34, helper after `pointsWithinDay` at line 167, `reduceTokenUsageRead` at lines 336-380)
- Test: `test/strip-token-usage.test.ts` (imports at lines 1-16, new tests inside `describe("reduceTokenUsageRead")` after the test ending at line 202)
- Modify (fixture only): `test/strip-rail.test.ts:221-227`

**Interfaces:**
- Consumes: `TokenUsageDayCurves` from `src/token-usage-snapshot.ts` (already exported, line 31); existing `laDayBoundsMs`, `pointsWithinDay`, `previousProviderDay` in `app/src/token-usage.ts`.
- Produces: `TokenUsageRailModel`'s `"ok" | "stale"` variant gains `yesterdayTotalTokens: number | null` — Task 2 renders it. Private helper `yesterdayCurveTotal(curves: TokenUsageDayCurves): number | null`.

- [ ] **Step 1: Write the failing tests**

In `test/strip-token-usage.test.ts`, add `type TokenUsageRailModel` to the import from `../app/src/token-usage` (line 8 imports `reduceTokenUsageRead`; extend the existing import block, keep it sorted per biome):

```ts
import {
  ACTIVITY_BOUNDARY_MAX_AGE_MS,
  formatTokensCompact,
  type HourlyActivityBucket,
  laDayBoundsMs,
  reduceTokenActivity,
  reduceTokenUsageRead,
  STALE_TOKEN_USAGE_AGE_MS,
  TOKEN_ACTIVITY_TIME_LABELS,
  TOKEN_ACTIVITY_VIEWBOX,
  tokenActivityBarRects,
  tokenActivityLineEndpoint,
  tokenActivityLineSegments,
  type TokenUsageRailModel,
} from "../app/src/token-usage";
```

Then, inside `describe("reduceTokenUsageRead")`, immediately after the `"keeps existing missing-curve and stale last-good behavior"` test, add:

```ts
  const withYesterday = (
    yesterday: TokenUsageDayCurve | null,
  ): Extract<TokenUsageRailModel, { state: "ok" | "stale" }> => {
    const model = reduceTokenUsageRead(
      read(
        snapshot({
          dayCurves: {
            today: curve(DAY, [
              ["2026-08-20T07:00:00.000Z", 0],
              ["2026-08-20T08:00:00.000Z", 10],
            ]),
            yesterday,
          },
        }),
      ),
      NOW,
    );
    if (model.state === "hidden") throw new Error("expected a rendered token model");
    return model;
  };

  test("yesterday total is the newest in-day point of the adjacent curve", () => {
    const model = withYesterday(
      curve("2026-08-19", [
        ["2026-08-19T07:00:00.000Z", 0],
        ["2026-08-19T20:00:00.000Z", 640_000],
        ["2026-08-20T06:30:00.000Z", 897_400], // 23:30 LA, still yesterday
      ]),
    );
    expect(model.yesterdayTotalTokens).toBe(897_400);
  });

  test("yesterday total never reads a point at or after LA midnight", () => {
    const model = withYesterday(
      curve("2026-08-19", [
        ["2026-08-19T20:00:00.000Z", 640_000],
        ["2026-08-20T07:05:00.000Z", 12_000], // 00:05 LA — belongs to today
      ]),
    );
    expect(model.yesterdayTotalTokens).toBe(640_000);
  });

  test("yesterday total is null when the curve is missing, non-adjacent, or empty", () => {
    expect(withYesterday(null).yesterdayTotalTokens).toBeNull();
    expect(withYesterday(curve("2026-08-18", [["2026-08-18T20:00:00.000Z", 500]])).yesterdayTotalTokens).toBeNull();
    expect(withYesterday(curve("2026-08-19", [])).yesterdayTotalTokens).toBeNull();
  });

  test("yesterday total survives a curve too sparse for the overlay", () => {
    const model = withYesterday(curve("2026-08-19", [["2026-08-19T20:00:00.000Z", 640_000]]));
    expect(model.yesterdayTotalTokens).toBe(640_000);
    expect(model.activity?.yesterday).toBeNull(); // one isolated point: no line
  });

  test("yesterday total is null without day curves", () => {
    const model = reduceTokenUsageRead(read(snapshot()), NOW);
    if (model.state === "hidden") throw new Error("expected a rendered token model");
    expect(model.yesterdayTotalTokens).toBeNull();
  });
```

(`TokenUsageDayCurve` is already imported at line 16; `curve`, `snapshot`, `read`, `DAY`, `NOW` are existing fixtures in this file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/strip-token-usage.test.ts`
Expected: FAIL — the five new tests fail with `Expected: 897400, Received: undefined` (or `toBeNull` receiving `undefined`), because `yesterdayTotalTokens` does not exist yet. (`bun test` does not typecheck, so this is a runtime failure.)

- [ ] **Step 3: Implement the derivation**

In `app/src/token-usage.ts`:

a) Extend the import from `../../src/token-usage-snapshot` (lines 9-13) with the curves type:

```ts
import {
  parseTokenUsageSnapshot,
  type TokenUsageDayCurve,
  type TokenUsageDayCurves,
  type TokenUsageSnapshot,
} from "../../src/token-usage-snapshot";
```

b) Add the field to the rail model (lines 26-34):

```ts
export type TokenUsageRailModel =
  | { state: "hidden" }
  | {
      state: "ok" | "stale";
      totalTokens: number;
      yesterdayTotalTokens: number | null;
      hour: TokenUsageRateLine;
      tenMin: TokenUsageRateLine;
      activity: TokenActivityChartModel | null;
    };
```

c) Add the helper immediately after `pointsWithinDay` (which ends at line 167):

```ts
/**
 * Yesterday's final total: the newest curve point inside its own LA day — the
 * provider total resets at LA midnight, so that point is the day's end total.
 * Deliberately not gated on the overlay's two-consecutive-bucket eligibility:
 * the top-line total is the line's legend and is a real provider reading even
 * when the line itself cannot render.
 */
const yesterdayCurveTotal = (curves: TokenUsageDayCurves): number | null => {
  const { yesterday } = curves;
  if (yesterday === null || yesterday.providerDay !== previousProviderDay(curves.today.providerDay)) {
    return null;
  }
  const { startMs, endMs } = laDayBoundsMs(yesterday.providerDay);
  return pointsWithinDay(yesterday, startMs, endMs).at(-1)?.totalTokens ?? null;
};
```

d) In `reduceTokenUsageRead`, compute the total once right after the `state` line (line 350) and add it to BOTH return objects (the zero-anchor branch at line 365 and the normal branch at line 374):

```ts
  const state = snapshot.unavailable || nowMs - fetchedAtMs > STALE_TOKEN_USAGE_AGE_MS ? "stale" : "ok";
  const yesterdayTotal = snapshot.dayCurves === undefined ? null : yesterdayCurveTotal(snapshot.dayCurves);
```

Then each return object gains `yesterdayTotalTokens: yesterdayTotal,` directly after its `totalTokens: snapshot.totalTokens,` line.

e) Update the fixture in `test/strip-rail.test.ts` (lines 221-227) so the project still typechecks with the new required field:

```ts
const visibleTokens = (): Extract<TokenUsageRailModel, { state: "ok" | "stale" }> => ({
  state: "ok",
  totalTokens: 562_700_000,
  yesterdayTotalTokens: 897_400_000,
  hour: { tokens: 31_100_000, trend: "up" },
  tenMin: { tokens: 12_200_000, trend: "up" },
  activity: activity(),
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/strip-token-usage.test.ts test/strip-rail.test.ts`
Expected: PASS — all new and existing tests. (The rail renderer ignores the new field until Task 2.)

- [ ] **Step 5: Commit**

```bash
git add app/src/token-usage.ts test/strip-token-usage.test.ts test/strip-rail.test.ts
git commit -m "feat: derive yesterday's token total on the rail model"
```

---

### Task 2: Render the top-line fragment, remove the chart's `yda` marker

**Files:**
- Modify: `app/src/rail.ts` (import at lines 22-33, `tokenActivityBlock` at lines 90-137, `tokensSection` at lines 139-160)
- Modify: `app/src/token-usage.ts` (remove `tokenActivityLineEndpoint` at lines 317-319)
- Modify: `app/styles.css` (`.tokens-today` rule ends at line 812; shared label rule at lines 871-876)
- Test: `test/strip-rail.test.ts` (token block layout describe at lines 229-322)
- Test: `test/strip-token-usage.test.ts` (import line 13, assertion line 485)

**Interfaces:**
- Consumes: `yesterdayTotalTokens: number | null` from Task 1; `formatTokensCompact` (already imported in `rail.ts`).
- Produces: rendered `.tokens-yda-sep` and `.tokens-yda` spans inside `.tokens-today`; no `token-activity-yda` element anywhere. `tokenActivityLineEndpoint` no longer exists.

- [ ] **Step 1: Write the failing tests**

In `test/strip-rail.test.ts`:

a) Replace the test `"renders sparse clock labels plus yda and omits the chart without activity"` (lines 273-293) with:

```ts
  test("renders sparse clock labels and no in-chart yda marker; omits the chart without activity", () => {
    withFakeDocument((root) => {
      renderRail(root as unknown as HTMLElement, model({ tokens: visibleTokens() }));
      const svgHasClass = (node: ReturnType<typeof descendants>[number], name: string): boolean =>
        node.attributes["class"]?.split(/\s+/u).includes(name) ?? false;
      expect(
        descendants(root)
          .filter((node) => svgHasClass(node, "token-activity-axis"))
          .map((node) => node.textContent),
      ).toEqual(["12a", "12p", "12a"]);
      expect(descendants(root).some((node) => svgHasClass(node, "token-activity-yda"))).toBe(false);
    });
    withFakeDocument((root) => {
      renderRail(root as unknown as HTMLElement, model({ tokens: { ...visibleTokens(), activity: null } }));
      expect(descendants(root).some((node) => hasClass(node, "rail-token-activity"))).toBe(false);
    });
  });
```

b) Delete the test `"places yda at the last rendered endpoint when yesterday ends early"` (lines 295-301) entirely.

c) Replace the test `"today-only activity renders no yesterday line or label"` (lines 303-312) with:

```ts
  test("today-only activity renders no yesterday line", () => {
    withFakeDocument((root) => {
      const todayOnly = activity();
      todayOnly.yesterday = null;
      renderRail(root as unknown as HTMLElement, model({ tokens: { ...visibleTokens(), activity: todayOnly } }));
      const svgClasses = descendants(root).map((node) => node.attributes["class"] ?? "");
      expect(svgClasses.some((value) => value.includes("token-activity-yesterday"))).toBe(false);
    });
  });
```

d) Add three new tests at the end of the `describe("token block layout")` block (after the signature test ending at line 321):

```ts
  test("the top line carries yesterday's total next to today's", () => {
    withFakeDocument((root) => {
      renderRail(root as unknown as HTMLElement, model({ tokens: visibleTokens() }));
      const today = descendants(root).find((node) => node.className === "tokens-today");
      const sep = descendants(root).find((node) => node.className === "tokens-yda-sep");
      const yda = descendants(root).find((node) => node.className === "tokens-yda");
      expect(yda?.textContent).toBe("897.4M yda");
      expect(sep?.textContent).toBe(" · ");
      expect(today?.children.map((node) => node.className)).toEqual(["tokens-yda-sep", "tokens-yda"]);
      expect(renderedText(root)).toContain("562.7M today");
    });
  });

  test("omits the yesterday fragment when there is no yesterday total", () => {
    withFakeDocument((root) => {
      renderRail(root as unknown as HTMLElement, model({ tokens: { ...visibleTokens(), yesterdayTotalTokens: null } }));
      expect(descendants(root).some((node) => node.className === "tokens-yda")).toBe(false);
      expect(renderedText(root)).not.toContain("yda");
    });
  });

  test("the rail signature tracks the yesterday total", () => {
    const base = visibleTokens();
    expect(railRenderSignature(model({ tokens: { ...base, yesterdayTotalTokens: 897_400_001 } }))).not.toBe(
      railRenderSignature(model({ tokens: base })),
    );
  });
```

(The signature test passes immediately — `railRenderSignature` serializes the whole token model — and guards the field against future signature narrowing.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/strip-rail.test.ts`
Expected: FAIL — the new fragment tests find no `tokens-yda` element, and the clock-labels test still finds a `token-activity-yda` element.

- [ ] **Step 3: Implement**

a) `app/src/rail.ts` — remove `tokenActivityLineEndpoint` from the import block (line 31), leaving the rest sorted.

b) `app/src/rail.ts` — in `tokenActivityBlock`, delete the endpoint-label block (lines 114-123):

```ts
  const endpoint = tokenActivityLineEndpoint(segments);
  if (endpoint !== null) {
    const label = document.createElementNS(SVG_NAMESPACE, "text");
    label.setAttribute("class", "token-activity-yda");
    label.setAttribute("x", endpoint.x.toFixed(2));
    label.setAttribute("y", String(Math.max(16, endpoint.y - 6)));
    label.setAttribute("text-anchor", "end");
    label.textContent = "yda";
    svg.append(label);
  }
```

(The `segments` variable stays — the polyline loop above still uses it.)

c) `app/src/rail.ts` — in `tokensSection`, after the `today.textContent` line (line 148), add the fragment:

```ts
  const today = document.createElement("div");
  today.className = "tokens-today";
  today.textContent = `${formatTokensCompact(model.totalTokens)} today`;
  if (model.yesterdayTotalTokens !== null) {
    const sep = document.createElement("span");
    sep.className = "tokens-yda-sep";
    sep.textContent = " · ";
    const yda = document.createElement("span");
    yda.className = "tokens-yda";
    yda.textContent = `${formatTokensCompact(model.yesterdayTotalTokens)} yda`;
    today.append(sep, yda);
  }
```

(Setting `textContent` first and appending after keeps the base text as the div's first child; the separator span carries the surrounding spaces.)

d) `app/src/token-usage.ts` — delete the now-unused export (lines 317-319):

```ts
export const tokenActivityLineEndpoint = (
  segments: readonly (readonly TokenActivityPoint[])[],
): TokenActivityPoint | null => segments.at(-1)?.at(-1) ?? null;
```

e) `test/strip-token-usage.test.ts` — remove `tokenActivityLineEndpoint,` from the import (line 13) and delete this assertion from the `"splits yesterday at missing buckets"` test (line 485):

```ts
    expect(tokenActivityLineEndpoint(segments)).toEqual(segments[1]?.[1] ?? null);
```

f) `app/styles.css` — change the shared label rule (lines 871-876) from:

```css
.token-activity-axis,
.token-activity-yda {
```

to:

```css
.token-activity-axis {
```

and add directly after the `.tokens-today` rule (which ends at line 812):

```css
.tokens-yda-sep {
  color: #475569;
  font-size: 1.0vw;
  font-weight: 600;
}
.tokens-yda {
  color: #60a5fa;
  font-size: 1.0vw;
  font-weight: 600;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/strip-rail.test.ts test/strip-token-usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/rail.ts app/src/token-usage.ts app/styles.css test/strip-rail.test.ts test/strip-token-usage.test.ts
git commit -m "feat: show yesterday's total beside today's, drop the chart's yda marker"
```

---

### Task 3: Docs, full gate, physical check

**Files:**
- Modify: `docs/design.md:130-132`

**Interfaces:**
- Consumes: the finished behavior from Tasks 1-2.
- Produces: accurate rail-contract wording; a green `bun run check`.

- [ ] **Step 1: Update the rail contract wording**

In `docs/design.md`, replace lines 130-132:

```md
- Daily token total and rolling rates, plus an optional LA-calendar-day activity
  chart: hourly bars through the current hour with adjacent yesterday overlaid
  by clock hour.
```

with:

```md
- Daily token total and rolling rates, with yesterday's final total beside
  today's in the overlay line's blue, plus an optional LA-calendar-day activity
  chart: hourly bars through the current hour with adjacent yesterday overlaid
  by clock hour.
```

- [ ] **Step 2: Run the full gate**

Run: `bun run check`
Expected: PASS — biome ci, both typechecks, both builds, and the full test suite are all green.

- [ ] **Step 3: Commit**

```bash
git add docs/design.md
git commit -m "docs: yesterday total in the rail contract"
```

- [ ] **Step 4: Physical strip verification**

Run: `bun run install:app` and relaunch the app. On the 2560 by 720 strip, confirm with the user:

- the top line reads `<total> today · <yda total> yda` with the yda fragment in the lighter blue, and does not wrap or push the rates/chart row down;
- the chart shows bars, the yesterday line, and the three clock labels — with no floating `yda` marker;
- the blue total reads at normal viewing distance.

---

## Self-review notes

- Spec coverage: derivation rules (Task 1), top-line fragment + marker removal + CSS (Task 2), signature coverage (Task 2 step 1d), docs wording (Task 3), `bun run check` + physical check (Task 3). No spec requirement is untasked.
- Placeholders: none — every code step carries exact code.
- Type consistency: `yesterdayTotalTokens` (model field, Task 1) is consumed verbatim in Task 2; `yesterdayCurveTotal` is private to `app/src/token-usage.ts`; `.tokens-yda` / `.tokens-yda-sep` class names match across `rail.ts`, `styles.css`, and tests.
