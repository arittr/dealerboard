# Hourly Token Activity Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cumulative token sparkline with a midnight-to-midnight activity chart: hourly bars for today, a cyan partial current hour, and a muted yesterday line aligned by LA clock hour.

**Architecture:** Keep the existing schema-v1 token sidecar and collector unchanged. Add a pure reducer that differences validated cumulative day curves into 24 stateful clock-hour buckets, then add pure geometry helpers that map those buckets into the existing 500 by 84 SVG box. Finally swap the rail's thin DOM renderer and CSS from cumulative paths to activity bars plus a segmented yesterday overlay.

**Tech Stack:** TypeScript 7, Bun 1.3.14 and `bun:test`, plain DOM/SVG in the Tauri webview, existing `Intl.DateTimeFormat` LA timezone helpers, biome and tsc through `bun run check`.

**Spec:** `docs/superpowers/specs/2026-09-02-hourly-token-activity-design.md` — read it before every task; it is authoritative when wording here is abbreviated.

## Global Constraints

- Work only on `wip/hourly-token-activity-spec`; the branch already contains the approved spec commit `7d27cd4`.
- Dealerboard has no ticket workflow. Do not search for, create, or update Linear tickets.
- No backward-compatibility implementation is authorized. Preserve only the existing behavior where an optional missing `dayCurves` field yields totals/rates without a chart.
- Do not modify `src/core/token-usage.ts`, `src/token-usage-snapshot.ts`, token accounting, `agentsview` invocation, sidecar schema/version, point limits, poll cadence, session/quota protocols, database code, or gestures.
- Keep the rail structurally outside the gesture system. The new chart has no event handlers, controls, tooltip, hover, or tap behavior.
- Exact visual data contract: 24 LA wall-clock positions; today bars through the newest observed hour; cyan only for the partial current hour; yesterday as muted-blue segmented line; shared zero-based y-scale; `12a` / `12p` / `12a` labels; `yda` label; no projection or cumulative line.
- Exact coverage contract: cumulative boundary reads use the newest point at or before the boundary only when no more than 30 minutes old; LA midnight is an exact synthetic zero; no interpolation across gaps.
- Exact DST contract: spring's nonexistent clock hour stays absent; fall's two repeated-hour intervals fold into one position and are unmeasured if either elapsed interval lacks coverage.
- Tests exercise reducer output, structured geometry, and minimal DOM behavior. Do not assert a complete rendered SVG or large command/string with regexes.
- TDD for every code task: add the behavioral test, run it and observe the expected failure, implement the minimum, rerun it, then run the complete focused file.
- Use exact-path `git add`, never `git add -A`; never bypass lefthook. Each task ends in its own detailed commit.
- Full source gate is `bun run check` (biome CI, both TypeScript configs, core/plugin builds, and all Bun tests). App installation is `bun run install:app` and replaces/relaunches `/Applications/Dealerboard.app`.

## File map and task boundaries

| File | Responsibility | Tasks |
| --- | --- | --- |
| `app/src/token-usage.ts` | Existing rates plus new hourly reduction and pure SVG geometry; final rail-model switch removes cumulative sparkline code | 1, 2, 3 |
| `app/src/rail.ts` | Thin DOM/SVG renderer and rail composition | 3 |
| `app/styles.css` | Existing 84px-native chart footprint and activity colors | 3 |
| `test/strip-token-usage.test.ts` | Reducer and geometry behavioral coverage | 1, 2, 3 |
| `test/strip-rail.test.ts` | Minimal renderer structure, labels, draw order, and signature coverage | 3 |
| `docs/design.md` | Current rail contract | 4 |
| `README.md` | User-facing feature and optional-integration wording | 4 |

Task 1 adds the activity model alongside the still-live cumulative sparkline so the branch compiles between commits. Task 2 adds geometry alongside the old geometry. Task 3 performs the atomic model/renderer cutover and deletes every old sparkline type/helper in the same commit. Task 4 updates documentation and runs delivery gates.

---

### Task 1: Reduce cumulative day curves into truthful hourly activity

**Files:**
- Modify: `app/src/token-usage.ts:78-180` (LA time helpers, new activity model and reducer beside `reduceSparkline`)
- Test: `test/strip-token-usage.test.ts:164-220` (new `reduceTokenActivity` suite before the existing sparkline suite)

**Interfaces:**
- Consumes: `TokenUsageSnapshot.dayCurves`, `TokenUsageDayCurve`, existing `LA_TIME_ZONE`, `laDayBoundsMs()`, and `previousProviderDay()`.
- Produces: `ACTIVITY_BOUNDARY_MAX_AGE_MS`, `HourlyActivityBucket`, `TokenActivityChartModel`, and `reduceTokenActivity(snapshot: TokenUsageSnapshot): TokenActivityChartModel | null`.
- Task 2 consumes all produced types without changing their names or shapes.
- This task does **not** change `TokenUsageRailModel` or `reduceTokenUsageRead`; the old sparkline remains wired until Task 3.

- [ ] **Step 1: Add reducer fixtures and the standard-day failing test**

Extend the `app/src/token-usage` import in `test/strip-token-usage.test.ts` with the exact new exports:

```ts
  ACTIVITY_BOUNDARY_MAX_AGE_MS,
  reduceTokenActivity,
```

Extend the type import from `src/token-usage-snapshot` with `TokenUsageDayCurve`. Add these fixtures immediately before the new suite:

```ts
const curve = (providerDay: string, points: Array<[string, number]>): TokenUsageDayCurve => ({
  providerDay,
  points: points.map(([fetchedAt, totalTokens]) => ({ fetchedAt, totalTokens })),
});

const measured = (hour: number, tokens: number) => ({ hour, state: "measured" as const, tokens });
const absent = (hour: number, state: "future" | "unmeasured" | "nonexistent") => ({
  hour,
  state,
  tokens: null,
});
```

Add the suite and first test:

```ts
describe("reduceTokenActivity", () => {
  test("differences today and adjacent yesterday by LA clock hour and marks the partial current hour", () => {
    const today = curve(DAY, [
      ["2026-08-20T07:00:00.000Z", 0], // LA midnight
      ["2026-08-20T08:00:00.000Z", 10],
      ["2026-08-20T09:00:00.000Z", 30],
      ["2026-08-20T18:00:00.000Z", 80], // 11:00
      ["2026-08-20T18:30:00.000Z", 100],
    ]);
    const yesterday = curve("2026-08-19", [
      ["2026-08-19T07:00:00.000Z", 0],
      ["2026-08-19T08:00:00.000Z", 5],
      ["2026-08-19T09:00:00.000Z", 20],
    ]);

    const activity = reduceTokenActivity(snapshot({ dayCurves: { today, yesterday } }));

    expect(activity?.today).toHaveLength(24);
    expect(activity?.today[0]).toEqual(measured(0, 10));
    expect(activity?.today[1]).toEqual(measured(1, 20));
    expect(activity?.today[2]).toEqual(absent(2, "unmeasured"));
    expect(activity?.today[11]).toEqual({ hour: 11, state: "current", tokens: 20 });
    expect(activity?.today[12]).toEqual(absent(12, "future"));
    expect(activity?.yesterday?.slice(0, 3)).toEqual([
      measured(0, 5),
      measured(1, 15),
      absent(2, "unmeasured"),
    ]);
    expect(activity?.yMax).toBe(20);
  });
});
```

- [ ] **Step 2: Add coverage, adjacency, zero, and no-invention failing tests**

Add inside the same suite:

```ts
  test("accepts a boundary observation at 30 minutes old and rejects one at 30 minutes plus one millisecond", () => {
    expect(ACTIVITY_BOUNDARY_MAX_AGE_MS).toBe(30 * 60_000);
    const start = Date.parse("2026-08-20T07:00:00.000Z");
    const modelFor = (firstOffsetMs: number) =>
      reduceTokenActivity(
        snapshot({
          dayCurves: {
            today: curve(DAY, [
              [iso(start + firstOffsetMs), 10],
              [iso(start + 2 * 60 * 60_000), 30],
            ]),
            yesterday: null,
          },
        }),
      );

    expect(modelFor(30 * 60_000)?.today[0]).toEqual(measured(0, 10));
    expect(modelFor(30 * 60_000 - 1)?.today[0]).toEqual(absent(0, "unmeasured"));
  });

  test("does not interpolate across a collector gap", () => {
    const activity = reduceTokenActivity(
      snapshot({
        dayCurves: {
          today: curve(DAY, [
            ["2026-08-20T07:00:00.000Z", 0],
            ["2026-08-20T08:00:00.000Z", 10],
            ["2026-08-20T12:00:00.000Z", 90],
            ["2026-08-20T12:30:00.000Z", 100],
          ]),
          yesterday: null,
        },
      }),
    );

    expect(activity?.today[1]).toEqual(absent(1, "unmeasured"));
    expect(activity?.today[2]).toEqual(absent(2, "unmeasured"));
    expect(activity?.today[3]).toEqual(absent(3, "unmeasured"));
    expect(activity?.today[5]).toEqual({ hour: 5, state: "current", tokens: 10 });
  });

  test("drops non-adjacent and isolated yesterday overlays", () => {
    const today = curve(DAY, [
      ["2026-08-20T07:00:00.000Z", 0],
      ["2026-08-20T08:00:00.000Z", 10],
    ]);
    const nonAdjacent = reduceTokenActivity(
      snapshot({
        dayCurves: {
          today,
          yesterday: curve("2026-08-18", [
            ["2026-08-18T07:00:00.000Z", 0],
            ["2026-08-18T08:00:00.000Z", 5],
            ["2026-08-18T09:00:00.000Z", 10],
          ]),
        },
      }),
    );
    const isolated = reduceTokenActivity(
      snapshot({
        dayCurves: {
          today,
          yesterday: curve("2026-08-19", [
            ["2026-08-19T07:00:00.000Z", 0],
            ["2026-08-19T08:00:00.000Z", 5],
          ]),
        },
      }),
    );

    expect(nonAdjacent?.yesterday).toBeNull();
    expect(isolated?.yesterday).toBeNull();
  });

  test("keeps measured zero distinct and uses a finite one-token scale", () => {
    const activity = reduceTokenActivity(
      snapshot({
        dayCurves: {
          today: curve(DAY, [
            ["2026-08-20T07:00:00.000Z", 0],
            ["2026-08-20T08:00:00.000Z", 0],
            ["2026-08-20T08:30:00.000Z", 0],
          ]),
          yesterday: null,
        },
      }),
    );

    expect(activity?.today[0]).toEqual(measured(0, 0));
    expect(activity?.today[1]).toEqual({ hour: 1, state: "current", tokens: 0 });
    expect(activity?.today[2]).toEqual(absent(2, "future"));
    expect(activity?.yMax).toBe(1);
  });

  test("returns null without day curves or any reducible activity", () => {
    expect(reduceTokenActivity(snapshot())).toBeNull();
    expect(
      reduceTokenActivity(
        snapshot({
          dayCurves: { today: curve(DAY, [["2026-08-20T18:45:00.000Z", 50]]), yesterday: null },
        }),
      ),
    ).toBeNull();
  });
```

The gap fixture deliberately leaves hours 1–4 unmeasured. Hour 5 is the
12:00–13:00 LA current interval and uses its exact 12:00 start plus the 12:30
latest endpoint; no tokens are assigned to the unknown interior hours.

- [ ] **Step 3: Add spring/fall DST failing tests**

Add inside the suite:

```ts
  test("spring DST leaves the nonexistent 02:00 clock position empty", () => {
    const activity = reduceTokenActivity(
      snapshot({
        providerDay: "2026-03-08",
        dayCurves: {
          today: curve("2026-03-08", [
            ["2026-03-08T08:00:00.000Z", 0], // 00:00 PST
            ["2026-03-08T09:00:00.000Z", 10], // 01:00 PST
            ["2026-03-08T10:00:00.000Z", 20], // 03:00 PDT
            ["2026-03-08T10:30:00.000Z", 25],
          ]),
          yesterday: null,
        },
      }),
    );

    expect(activity?.today[0]).toEqual(measured(0, 10));
    expect(activity?.today[1]).toEqual(measured(1, 10));
    expect(activity?.today[2]).toEqual(absent(2, "nonexistent"));
    expect(activity?.today[3]).toEqual({ hour: 3, state: "current", tokens: 5 });
  });

  test("fall DST folds both 01:00 intervals and rejects an incompletely measured fold", () => {
    const complete = reduceTokenActivity(
      snapshot({
        providerDay: "2026-11-01",
        dayCurves: {
          today: curve("2026-11-01", [
            ["2026-11-01T07:00:00.000Z", 0], // 00:00 PDT
            ["2026-11-01T08:00:00.000Z", 10], // first 01:00
            ["2026-11-01T09:00:00.000Z", 30], // second 01:00
            ["2026-11-01T10:00:00.000Z", 35], // 02:00 PST
            ["2026-11-01T10:30:00.000Z", 45],
          ]),
          yesterday: null,
        },
      }),
    );
    const incomplete = reduceTokenActivity(
      snapshot({
        providerDay: "2026-11-01",
        dayCurves: {
          today: curve("2026-11-01", [
            ["2026-11-01T07:00:00.000Z", 0],
            ["2026-11-01T08:00:00.000Z", 10],
            ["2026-11-01T10:00:00.000Z", 35],
            ["2026-11-01T10:30:00.000Z", 45],
          ]),
          yesterday: null,
        },
      }),
    );

    expect(complete?.today[1]).toEqual(measured(1, 25));
    expect(complete?.today[2]).toEqual({ hour: 2, state: "current", tokens: 10 });
    expect(incomplete?.today[1]).toEqual(absent(1, "unmeasured"));
  });
```

- [ ] **Step 4: Run the focused test and confirm RED**

Run: `bun test test/strip-token-usage.test.ts`

Expected: FAIL at module import because `ACTIVITY_BOUNDARY_MAX_AGE_MS` and `reduceTokenActivity` do not exist. Existing rate and sparkline tests must still pass once temporary stub exports are added; do not weaken them.

- [ ] **Step 5: Add the activity types and hourly reducer**

In `app/src/token-usage.ts`, add after `TokenUsageRailModel`:

```ts
export const ACTIVITY_BOUNDARY_MAX_AGE_MS = 30 * 60_000;

export type HourlyActivityBucket =
  | { hour: number; state: "measured" | "current"; tokens: number }
  | { hour: number; state: "future" | "unmeasured" | "nonexistent"; tokens: null };

export type TokenActivityChartModel = {
  today: HourlyActivityBucket[];
  yesterday: HourlyActivityBucket[] | null;
  yMax: number;
};

type NumberedCurvePoint = { atMs: number; totalTokens: number };
type IntervalActivity =
  | { state: "measured" | "current"; tokens: number }
  | { state: "future" | "unmeasured"; tokens: null };
```

Beside the existing LA formatter, add a local-hour formatter. Keep midnight normalized to zero even if JavaScriptCore emits `24`:

```ts
const laHourFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: LA_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

const laClockHour = (atMs: number): number => {
  const hour = Number(laHourFormat.formatToParts(new Date(atMs)).find((part) => part.type === "hour")?.value ?? "0");
  return hour % 24;
};
```

Add these helpers after `laDayBoundsMs`. Preserve the discriminated states; do not use `0` as a missing-data sentinel:

```ts
const measuredBucket = (hour: number, tokens: number, current: boolean): HourlyActivityBucket => ({
  hour,
  state: current ? "current" : "measured",
  tokens: Math.max(0, tokens),
});

const absentBucket = (
  hour: number,
  state: "future" | "unmeasured" | "nonexistent",
): HourlyActivityBucket => ({ hour, state, tokens: null });

const pointsWithinDay = (curve: TokenUsageDayCurve, startMs: number, endMs: number): NumberedCurvePoint[] =>
  curve.points
    .map((point) => ({ atMs: Date.parse(point.fetchedAt), totalTokens: point.totalTokens }))
    .filter((point) => point.atMs >= startMs && point.atMs < endMs);

const totalAtBoundary = (
  points: readonly NumberedCurvePoint[],
  boundaryMs: number,
  dayStartMs: number,
): number | null => {
  if (boundaryMs === dayStartMs) return 0;
  let latest: NumberedCurvePoint | null = null;
  for (const point of points) {
    if (point.atMs > boundaryMs) break;
    latest = point;
  }
  return latest !== null && boundaryMs - latest.atMs <= ACTIVITY_BOUNDARY_MAX_AGE_MS
    ? latest.totalTokens
    : null;
};
```

Implement actual-hour intervals and folding. Today's curve uses its latest
in-day point to separate complete, current, and future intervals; historical
yesterday attempts the complete local day:

```ts
const reduceCurveActivity = (curve: TokenUsageDayCurve, today: boolean): HourlyActivityBucket[] => {
  const { startMs, endMs } = laDayBoundsMs(curve.providerDay);
  const points = pointsWithinDay(curve, startMs, endMs);
  const latest = points.at(-1) ?? null;
  const byHour = Array.from({ length: 24 }, () => [] as IntervalActivity[]);

  for (let intervalStart = startMs; intervalStart < endMs; intervalStart += ONE_HOUR_MS) {
    const intervalEnd = Math.min(intervalStart + ONE_HOUR_MS, endMs);
    const hour = laClockHour(intervalStart);
    if (today && (latest === null || latest.atMs < intervalStart)) {
      byHour[hour]?.push({ state: "future", tokens: null });
      continue;
    }

    const current = today && latest !== null && latest.atMs < intervalEnd;
    const effectiveEnd = current && latest !== null ? latest.atMs : intervalEnd;
    const startTotal = totalAtBoundary(points, intervalStart, startMs);
    const endTotal = totalAtBoundary(points, effectiveEnd, startMs);
    byHour[hour]?.push(
      startTotal === null || endTotal === null
        ? { state: "unmeasured", tokens: null }
        : { state: current ? "current" : "measured", tokens: Math.max(0, endTotal - startTotal) },
    );
  }

  return byHour.map((parts, hour) => {
    if (parts.length === 0) return absentBucket(hour, "nonexistent");
    const elapsed = parts.filter((part) => part.state !== "future");
    if (elapsed.length === 0) return absentBucket(hour, "future");
    if (elapsed.some((part) => part.state === "unmeasured")) return absentBucket(hour, "unmeasured");
    const tokens = elapsed.reduce((sum, part) => sum + (part.tokens ?? 0), 0);
    const current = elapsed.some((part) => part.state === "current") || parts.some((part) => part.state === "future");
    return measuredBucket(hour, tokens, current);
  });
};

const bucketIsObserved = (
  bucket: HourlyActivityBucket,
): bucket is Extract<HourlyActivityBucket, { state: "measured" | "current" }> =>
  bucket.state === "measured" || bucket.state === "current";

const hasYesterdaySegment = (buckets: readonly HourlyActivityBucket[]): boolean => {
  let previousMeasured = false;
  for (const bucket of buckets) {
    const measuredNow = bucket.state === "measured";
    if (previousMeasured && measuredNow) return true;
    previousMeasured = measuredNow;
  }
  return false;
};

export const reduceTokenActivity = (snapshot: TokenUsageSnapshot): TokenActivityChartModel | null => {
  const curves = snapshot.dayCurves;
  if (curves === undefined) return null;

  const today = reduceCurveActivity(curves.today, true);
  const candidateYesterday =
    curves.yesterday !== null && curves.yesterday.providerDay === previousProviderDay(curves.today.providerDay)
      ? reduceCurveActivity(curves.yesterday, false)
      : null;
  const yesterday = candidateYesterday !== null && hasYesterdaySegment(candidateYesterday) ? candidateYesterday : null;
  const observed = [...today, ...(yesterday ?? [])].filter(bucketIsObserved);
  if (observed.length === 0) return null;

  return {
    today,
    yesterday,
    yMax: Math.max(1, ...observed.map((bucket) => bucket.tokens)),
  };
};
```

- [ ] **Step 6: Run focused tests and correct only implementation defects**

Run: `bun test test/strip-token-usage.test.ts`

Expected: PASS, including every existing rate/sparkline test and the new standard, tolerance, gap, adjacency, zero, spring-DST, and fall-DST tests. If a fixture expectation is wrong, prove it against LA timestamps before changing it; do not tune production behavior to a mistaken test.

- [ ] **Step 7: Run typecheck and commit Task 1**

Run: `bun run typecheck`

Expected: PASS for root and app TypeScript configurations.

Then:

```bash
git status --short
git add app/src/token-usage.ts test/strip-token-usage.test.ts
git commit -m "feat(app): reduce token day curves into hourly activity" \
  -m "Add a pure 24-position LA clock-hour reducer with bounded cumulative boundary reads, explicit missing/future/current states, adjacent-yesterday validation, shared scaling, and spring/fall DST behavior." \
  -m "Leave the existing sparkline wired until the geometry and renderer tasks, preserving a compiling independently reviewable commit."
```

---

### Task 2: Map hourly activity into structured SVG geometry

**Files:**
- Modify: `app/src/token-usage.ts` (new activity geometry beside the old sparkline geometry)
- Test: `test/strip-token-usage.test.ts` (new geometry suite after reducer tests)

**Interfaces:**
- Consumes: `HourlyActivityBucket`, `TokenActivityChartModel` from Task 1.
- Produces: `TOKEN_ACTIVITY_VIEWBOX`, `TOKEN_ACTIVITY_TIME_LABELS`, `TokenActivityPoint`, `TokenActivityBarRect`, `tokenActivityBarRects(model)`, `tokenActivityLineSegments(model)`, and `tokenActivityLineEndpoint(segments)`.
- Task 3 imports every produced value by these exact names.
- This task still leaves the cumulative renderer live so the branch compiles between commits.

- [ ] **Step 1: Add failing bar-geometry tests**

Extend the token-usage test import with the geometry values and the Task 1
bucket type:

```ts
  TOKEN_ACTIVITY_TIME_LABELS,
  TOKEN_ACTIVITY_VIEWBOX,
  type HourlyActivityBucket,
  tokenActivityBarRects,
  tokenActivityLineEndpoint,
  tokenActivityLineSegments,
```

Add a local fixture after the reducer suite:

```ts
const activityBuckets = (
  values: Partial<Record<number, { state: "measured" | "current"; tokens: number }>>,
): HourlyActivityBucket[] =>
  Array.from({ length: 24 }, (_, hour) => {
    const value = values[hour];
    return value === undefined ? absent(hour, "unmeasured") : { hour, ...value };
  });
```

Add the suite:

```ts
describe("token activity SVG geometry", () => {
  test("maps measured and current buckets into stable centered bar slots", () => {
    const bars = tokenActivityBarRects({
      today: activityBuckets({
        0: { state: "measured", tokens: 10 },
        1: { state: "current", tokens: 20 },
        2: { state: "measured", tokens: 0 },
      }),
      yesterday: null,
      yMax: 20,
    });

    expect(TOKEN_ACTIVITY_VIEWBOX).toEqual({ width: 500, height: 84 });
    expect(bars.map(({ hour, current }) => ({ hour, current }))).toEqual([
      { hour: 0, current: false },
      { hour: 1, current: true },
      { hour: 2, current: false },
    ]);
    expect(bars[0]?.height).toBeCloseTo(28, 5);
    expect(bars[1]?.height).toBeCloseTo(56, 5);
    expect(bars[2]?.height).toBe(0);
    expect(bars[0]?.x).toBeGreaterThanOrEqual(0);
    expect(bars[1]?.x).toBeGreaterThan(bars[0]?.x ?? 0);
  });

  test("future, unmeasured, and nonexistent today buckets emit no rectangle", () => {
    const today = Array.from({ length: 24 }, (_, hour): HourlyActivityBucket =>
      absent(hour, hour === 0 ? "future" : hour === 1 ? "nonexistent" : "unmeasured"),
    );
    expect(tokenActivityBarRects({ today, yesterday: null, yMax: 1 })).toEqual([]);
  });
```

- [ ] **Step 2: Add failing segmented-line and label tests**

Add inside the suite:

```ts
  test("splits yesterday at missing buckets and places points at slot centers", () => {
    const yesterday = activityBuckets({
      0: { state: "measured", tokens: 10 },
      1: { state: "measured", tokens: 20 },
      3: { state: "measured", tokens: 5 },
      4: { state: "measured", tokens: 15 },
    });
    const segments = tokenActivityLineSegments({
      today: Array.from({ length: 24 }, (_, hour) => absent(hour, "future")),
      yesterday,
      yMax: 20,
    });

    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.map((point) => point.hour))).toEqual([
      [0, 1],
      [3, 4],
    ]);
    expect(segments[0]?.[0]?.x).toBeCloseTo(500 / 48, 5);
    expect(segments[0]?.[1]?.y).toBe(4);
    expect(tokenActivityLineEndpoint(segments)).toEqual(segments[1]?.[1]);
  });

  test("publishes the fixed sparse time labels", () => {
    expect(TOKEN_ACTIVITY_TIME_LABELS).toEqual([
      { text: "12a", x: 0, anchor: "start" },
      { text: "12p", x: 250, anchor: "middle" },
      { text: "12a", x: 500, anchor: "end" },
    ]);
  });
});
```

- [ ] **Step 3: Run the focused test and confirm RED**

Run: `bun test test/strip-token-usage.test.ts`

Expected: FAIL at import because the activity geometry exports do not exist. Task 1 reducer tests remain green once temporary declarations are present.

- [ ] **Step 4: Implement structured geometry**

Add after `reduceTokenActivity` and before the old sparkline geometry block:

```ts
export const TOKEN_ACTIVITY_VIEWBOX = { width: 500, height: 84 } as const;
const TOKEN_ACTIVITY_PLOT_TOP = 4;
const TOKEN_ACTIVITY_PLOT_BOTTOM = 60;
const TOKEN_ACTIVITY_BAR_WIDTH = 12;
const TOKEN_ACTIVITY_SLOT_WIDTH = TOKEN_ACTIVITY_VIEWBOX.width / 24;

export const TOKEN_ACTIVITY_TIME_LABELS = [
  { text: "12a", x: 0, anchor: "start" },
  { text: "12p", x: TOKEN_ACTIVITY_VIEWBOX.width / 2, anchor: "middle" },
  { text: "12a", x: TOKEN_ACTIVITY_VIEWBOX.width, anchor: "end" },
] as const;

export type TokenActivityPoint = { hour: number; x: number; y: number };
export type TokenActivityBarRect = TokenActivityPoint & {
  width: number;
  height: number;
  current: boolean;
};

const activityHeight = (tokens: number, yMax: number): number =>
  (tokens / Math.max(1, yMax)) * (TOKEN_ACTIVITY_PLOT_BOTTOM - TOKEN_ACTIVITY_PLOT_TOP);

const activityPoint = (hour: number, tokens: number, yMax: number): TokenActivityPoint => {
  const height = activityHeight(tokens, yMax);
  return {
    hour,
    x: (hour + 0.5) * TOKEN_ACTIVITY_SLOT_WIDTH,
    y: TOKEN_ACTIVITY_PLOT_BOTTOM - height,
  };
};

export const tokenActivityBarRects = (model: TokenActivityChartModel): TokenActivityBarRect[] =>
  model.today.flatMap((bucket) => {
    if (!bucketIsObserved(bucket)) return [];
    const point = activityPoint(bucket.hour, bucket.tokens, model.yMax);
    const height = activityHeight(bucket.tokens, model.yMax);
    return [
      {
        ...point,
        x: point.x - TOKEN_ACTIVITY_BAR_WIDTH / 2,
        width: TOKEN_ACTIVITY_BAR_WIDTH,
        height,
        current: bucket.state === "current",
      },
    ];
  });

export const tokenActivityLineSegments = (model: TokenActivityChartModel): TokenActivityPoint[][] => {
  if (model.yesterday === null) return [];
  const segments: TokenActivityPoint[][] = [];
  let current: TokenActivityPoint[] = [];
  const flush = (): void => {
    if (current.length >= 2) segments.push(current);
    current = [];
  };
  for (const bucket of model.yesterday) {
    if (bucket.state === "measured") current.push(activityPoint(bucket.hour, bucket.tokens, model.yMax));
    else flush();
  }
  flush();
  return segments;
};

export const tokenActivityLineEndpoint = (
  segments: readonly (readonly TokenActivityPoint[])[],
): TokenActivityPoint | null => segments.at(-1)?.at(-1) ?? null;
```

The zero-height bar remains in structured geometry. This preserves measured-zero versus missing without forcing a visible minimum that would falsely imply activity.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
bun test test/strip-token-usage.test.ts
bun run typecheck
```

Expected: both PASS. No old sparkline test changes in this task.

- [ ] **Step 6: Commit Task 2**

```bash
git status --short
git add app/src/token-usage.ts test/strip-token-usage.test.ts
git commit -m "feat(app): map hourly token activity into SVG geometry" \
  -m "Add structured bar rectangles, gap-preserving yesterday line segments, a shared 500 by 84 plot, and fixed sparse clock labels." \
  -m "Keep geometry DOM-free so tests assert behavior instead of brittle rendered SVG strings."
```

---

### Task 3: Replace the cumulative rail renderer with activity bars and overlay

**Files:**
- Modify: `app/src/token-usage.ts:26-34,139-221,224-261` (switch rail model, wire activity, delete old sparkline reducer/geometry)
- Modify: `app/src/rail.ts:1-7,16-29,83-162` (imports, SVG renderer, token-section wiring)
- Modify: `app/styles.css:813-855` (comments and chart classes; retain dimensions)
- Test: `test/strip-token-usage.test.ts:179-255` (delete old sparkline suites; add rail-model integration assertions)
- Test: `test/strip-rail.test.ts:205-274` (activity fixture and minimal renderer behavior)

**Interfaces:**
- Consumes: all Task 1 model/reducer exports and Task 2 geometry exports.
- Produces: `TokenUsageRailModel.activity: TokenActivityChartModel | null`, `.rail-token-activity`, `.token-activity-yesterday`, `.token-activity-bar`, `.current`, `.token-activity-axis`, `.token-activity-yda`.
- Removes: `SparklinePoint`, `SparklineModel`, `reduceSparkline`, `SPARKLINE_VIEWBOX`, `sparklinePolylinePoints`, `sparklineFillPoints`, `sparklineEndpoint`, `sparklineBlock`, `.rail-sparkline`, and their tests/imports.

- [ ] **Step 1: Change reducer tests to require the new rail-model field**

In the existing `reduceTokenUsageRead` suite, update a representative successful snapshot to include `dayCurves`, then assert the public model uses `activity`, not `sparkline`:

```ts
  test("publishes hourly activity on the rail model", () => {
    const value = snapshot({
      dayCurves: {
        today: curve(DAY, [
          ["2026-08-20T07:00:00.000Z", 0],
          ["2026-08-20T08:00:00.000Z", 10],
          ["2026-08-20T08:30:00.000Z", 15],
        ]),
        yesterday: null,
      },
    });
    const model = reduceTokenUsageRead(read(value), NOW);
    if (model.state === "hidden") throw new Error("expected a rendered token model");
    expect(model.activity?.today[0]).toEqual(measured(0, 10));
    expect("sparkline" in model).toBe(false);
  });

  test("keeps existing missing-curve and stale last-good behavior", () => {
    const withoutCurves = reduceTokenUsageRead(read(snapshot()), NOW);
    if (withoutCurves.state === "hidden") throw new Error("expected a rendered token model");
    expect(withoutCurves.activity).toBeNull();

    const staleValue = snapshot({
      unavailable: true,
      dayCurves: {
        today: curve(DAY, [
          ["2026-08-20T07:00:00.000Z", 0],
          ["2026-08-20T08:00:00.000Z", 10],
        ]),
        yesterday: null,
      },
    });
    const stale = reduceTokenUsageRead(read(staleValue), NOW);
    expect(stale.state).toBe("stale");
    if (stale.state === "hidden") throw new Error("expected retained last-good activity");
    expect(stale.activity).not.toBeNull();
  });
```

Delete the complete `describe("reduceSparkline", ...)` and `describe("sparkline SVG geometry", ...)` suites and remove their old imports. Do not delete rate, formatting, staleness, or LA-day-bound tests.

- [ ] **Step 2: Replace the renderer fixture and add failing DOM assertions**

In `test/strip-rail.test.ts`, import `HourlyActivityBucket` with `TokenUsageRailModel`, then add:

```ts
const emptyActivity = (state: "future" | "unmeasured" = "future"): HourlyActivityBucket[] =>
  Array.from({ length: 24 }, (_, hour) => ({ hour, state, tokens: null }));

const activity = (): NonNullable<Extract<TokenUsageRailModel, { state: "ok" | "stale" }>["activity"]> => {
  const today = emptyActivity();
  today[0] = { hour: 0, state: "measured", tokens: 10 };
  today[1] = { hour: 1, state: "current", tokens: 20 };
  const yesterday = emptyActivity("unmeasured");
  yesterday[0] = { hour: 0, state: "measured", tokens: 5 };
  yesterday[1] = { hour: 1, state: "measured", tokens: 15 };
  return { today, yesterday, yMax: 20 };
};
```

Replace `visibleTokens().sparkline` with `activity: activity()`. Replace the existing sparkline-specific tests with:

```ts
  test("renders today bars over yesterday segments in the fixed chart box", () => {
    withFakeDocument((root) => {
      renderRail(root as unknown as HTMLElement, model({ tokens: visibleTokens() }));
      const nodes = descendants(root);
      const chart = nodes.find((node) => hasClass(node, "rail-token-activity"));
      const svg = nodes.find((node) => node.tagName === "svg");
      const svgHasClass = (node: (typeof nodes)[number], name: string): boolean =>
        node.attributes["class"]?.split(/\s+/u).includes(name) ?? false;
      const yesterday = nodes.filter((node) => svgHasClass(node, "token-activity-yesterday"));
      const bars = nodes.filter((node) => svgHasClass(node, "token-activity-bar"));
      expect(chart).toBeDefined();
      expect(chart?.listeners).toEqual({});
      expect(svg?.attributes["viewBox"]).toBe("0 0 500 84");
      expect(yesterday).toHaveLength(1);
      expect(bars).toHaveLength(2);
      expect(svgHasClass(bars[1]!, "current")).toBe(true);
      if (svg === undefined || yesterday[0] === undefined || bars[0] === undefined) {
        throw new Error("expected activity SVG, yesterday segment, and today bar");
      }
      expect(svg.children.indexOf(yesterday[0])).toBeLessThan(svg.children.indexOf(bars[0]));
    });
  });

  test("renders sparse clock labels plus yda and omits the chart without activity", () => {
    withFakeDocument((root) => {
      renderRail(root as unknown as HTMLElement, model({ tokens: visibleTokens() }));
      const svgHasClass = (node: ReturnType<typeof descendants>[number], name: string): boolean =>
        node.attributes["class"]?.split(/\s+/u).includes(name) ?? false;
      expect(
        descendants(root)
          .filter((node) => svgHasClass(node, "token-activity-axis"))
          .map((node) => node.textContent),
      ).toEqual(["12a", "12p", "12a"]);
      expect(descendants(root).filter((node) => svgHasClass(node, "token-activity-yda")).map((node) => node.textContent)).toEqual(["yda"]);
    });
    withFakeDocument((root) => {
      renderRail(root as unknown as HTMLElement, model({ tokens: { ...visibleTokens(), activity: null } }));
      expect(descendants(root).some((node) => hasClass(node, "rail-token-activity"))).toBe(false);
    });
  });

  test("today-only activity renders no yesterday line or label", () => {
    withFakeDocument((root) => {
      const todayOnly = activity();
      todayOnly.yesterday = null;
      renderRail(root as unknown as HTMLElement, model({ tokens: { ...visibleTokens(), activity: todayOnly } }));
      const svgClasses = descendants(root).map((node) => node.attributes["class"] ?? "");
      expect(svgClasses.some((value) => value.includes("token-activity-yesterday"))).toBe(false);
      expect(svgClasses.some((value) => value.includes("token-activity-yda"))).toBe(false);
    });
  });

  test("the rail signature tracks activity coverage and the current marker", () => {
    const before = visibleTokens();
    const afterActivity = activity();
    afterActivity.today[2] = { hour: 2, state: "current", tokens: 4 };
    afterActivity.today[1] = { hour: 1, state: "measured", tokens: 20 };
    const after = { ...visibleTokens(), activity: afterActivity };
    expect(railRenderSignature(model({ tokens: after }))).not.toBe(railRenderSignature(model({ tokens: before })));
  });
```

Update the existing token-flow class assertion from `rail-sparkline` to `rail-token-activity`. Keep the assertions for total, two rates, no separator, and rail section order.

- [ ] **Step 3: Run the two focused files and confirm RED**

Run:

```bash
bun test test/strip-token-usage.test.ts test/strip-rail.test.ts
```

Expected: FAIL because `TokenUsageRailModel` still exposes `sparkline` and the renderer still creates `.rail-sparkline` with cumulative SVG elements. Quota and rate tests remain green after temporary type fixes.

- [ ] **Step 4: Atomically switch the rail model and remove cumulative code**

In `TokenUsageRailModel`, replace:

```ts
      sparkline: SparklineModel | null;
```

with:

```ts
      activity: TokenActivityChartModel | null;
```

In both successful return paths of `reduceTokenUsageRead`, replace `sparkline: reduceSparkline(snapshot)` with:

```ts
activity: reduceTokenActivity(snapshot)
```

Delete all old cumulative sparkline types, reduction, and geometry identified in this task's **Removes** interface. Retain `formatTokensCompact`, LA day bounds, rate calculation, and all new activity exports.

- [ ] **Step 5: Implement the thin activity SVG renderer**

Replace the token-usage import in `app/src/rail.ts` with:

```ts
import {
  formatTokensCompact,
  TOKEN_ACTIVITY_TIME_LABELS,
  TOKEN_ACTIVITY_VIEWBOX,
  type TokenActivityChartModel,
  type TokenActivityPoint,
  tokenActivityBarRects,
  tokenActivityLineEndpoint,
  tokenActivityLineSegments,
  type TokenUsageRailModel,
  type TokenUsageRateLine,
} from "./token-usage";
```

Replace `sparkPolyline` and `sparklineBlock` with:

```ts
const activityPoints = (points: readonly TokenActivityPoint[]): string =>
  points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");

const tokenActivityBlock = (activity: TokenActivityChartModel): HTMLElement => {
  const block = document.createElement("div");
  block.className = "rail-token-activity";
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", `0 0 ${TOKEN_ACTIVITY_VIEWBOX.width} ${TOKEN_ACTIVITY_VIEWBOX.height}`);

  for (const axis of TOKEN_ACTIVITY_TIME_LABELS) {
    const label = document.createElementNS(SVG_NAMESPACE, "text");
    label.setAttribute("class", "token-activity-axis");
    label.setAttribute("x", String(axis.x));
    label.setAttribute("y", "82");
    label.setAttribute("text-anchor", axis.anchor);
    label.textContent = axis.text;
    svg.append(label);
  }

  const segments = tokenActivityLineSegments(activity);
  for (const segment of segments) {
    const line = document.createElementNS(SVG_NAMESPACE, "polyline");
    line.setAttribute("class", "token-activity-yesterday");
    line.setAttribute("points", activityPoints(segment));
    svg.append(line);
  }

  const endpoint = tokenActivityLineEndpoint(segments);
  if (endpoint !== null) {
    const label = document.createElementNS(SVG_NAMESPACE, "text");
    label.setAttribute("class", "token-activity-yda");
    label.setAttribute("x", "498");
    label.setAttribute("y", String(Math.max(16, endpoint.y - 6)));
    label.setAttribute("text-anchor", "end");
    label.textContent = "yda";
    svg.append(label);
  }

  for (const bar of tokenActivityBarRects(activity)) {
    const rect = document.createElementNS(SVG_NAMESPACE, "rect");
    rect.setAttribute("class", bar.current ? "token-activity-bar current" : "token-activity-bar");
    rect.setAttribute("x", bar.x.toFixed(2));
    rect.setAttribute("y", bar.y.toFixed(2));
    rect.setAttribute("width", bar.width.toFixed(2));
    rect.setAttribute("height", bar.height.toFixed(2));
    svg.append(rect);
  }

  block.append(svg);
  return block;
};
```

In `tokensSection`, replace the `model.sparkline` branch with:

```ts
  if (model.activity !== null) {
    flow.append(tokenActivityBlock(model.activity));
  }
```

Update the module header's `rates-beside-sparkline` wording to describe rates
beside the hourly activity comparison. Do not change the rail's rebuild or
interaction claims.

Do not add `preserveAspectRatio`, event listeners, ARIA interactivity, or an extra wrapper. The existing fixed-height flex behavior remains.

- [ ] **Step 6: Replace sparkline CSS without changing the footprint**

Replace the `.rail-sparkline` comment and rules in `app/styles.css` with:

```css
/* LA clock-hour token activity: today is a neutral bar series, the incomplete
   current hour is cyan, and adjacent yesterday is a muted line behind it.
   Sparse labels use the bottom 20px of the existing 500x84-native box. */
.rail-token-activity {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 11.667vh; /* 84px native */
  overflow: visible;
}
.rail-token-activity svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.token-activity-bar {
  fill: #94a3b8;
  opacity: 0.68;
}
.token-activity-bar.current {
  fill: #20b8ff;
  opacity: 1;
}
.token-activity-yesterday {
  fill: none;
  stroke: #3b82f6;
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
  opacity: 0.68;
}
.token-activity-axis,
.token-activity-yda {
  fill: #94a3b8;
  font-size: 16px;
}
```

The 16px SVG text scales through the view box and is intentionally smaller than the prior 20px `yda <total>` label. If the physical display requires opacity or offset tuning, change only the CSS/label offsets and repeat Task 4's on-glass gate.

- [ ] **Step 7: Run focused tests, typecheck, build the webview, and scan removed names**

Run:

```bash
bun test test/strip-token-usage.test.ts test/strip-rail.test.ts
bun run typecheck
bun run build:app
if rg -n "SparklineModel|reduceSparkline|SPARKLINE_VIEWBOX|sparklinePolylinePoints|sparklineFillPoints|sparklineEndpoint|rail-sparkline|sparklineBlock" app/src app/styles.css test/strip-token-usage.test.ts test/strip-rail.test.ts; then exit 1; fi
```

Expected: all commands PASS; the final `rg` prints nothing and exits through the successful negated branch. Do not broaden the scan into historical specs/plans, where the old vocabulary is intentionally recorded.

- [ ] **Step 8: Commit Task 3**

```bash
git status --short
git add app/src/token-usage.ts app/src/rail.ts app/styles.css test/strip-token-usage.test.ts test/strip-rail.test.ts
git commit -m "feat(app): render hourly token activity with yesterday overlay" \
  -m "Cut the rail from cumulative sparkline data to the structured activity model. Render neutral today bars, a cyan partial hour, segmented muted-blue yesterday activity, and sparse midnight/noon labels in the existing chart footprint." \
  -m "Remove the obsolete cumulative reducer, SVG helpers, styles, and brittle renderer assertions while preserving totals, rolling rates, staleness, quotas, and the rail interaction boundary."
```

---

### Task 4: Update product documentation and complete delivery gates

**Files:**
- Modify: `docs/design.md:126-140` (rail contract)
- Modify: `README.md:34-46,164-185` (feature and `agentsview` wording)
- Verify only: all implementation and test files from Tasks 1–3

**Interfaces:**
- Consumes: completed chart behavior from Tasks 1–3.
- Produces: current documentation, full source receipt, installed-app receipt, and physical-strip acceptance notes.
- No source behavior is added in this task. If a gate exposes a defect, return to the owning task and use TDD; do not patch around it here.

- [ ] **Step 1: Update the design contract**

In `docs/design.md`, replace:

```markdown
- Daily token total, rolling rates, and an optional LA-calendar-day sparkline.
```

with:

```markdown
- Daily token total and rolling rates, plus an optional LA-calendar-day activity
  chart: hourly bars through the current hour with adjacent yesterday overlaid
  by clock hour.
```

Do not change quota or interaction wording.

- [ ] **Step 2: Update README feature and integration wording**

Replace the feature bullet:

```markdown
- Optional quota meters and daily token-usage trends.
```

with:

```markdown
- Optional quota meters, rolling token rates, and hourly today-versus-yesterday
  activity.
```

Replace `daily token totals, rates, and trend curves` with:

```markdown
daily token totals, rolling rates, and hourly activity curves
```

Replace `aggregate daily token totals and trend curves` with:

```markdown
aggregate daily token totals, rolling rates, and today/yesterday activity curves
```

- [ ] **Step 3: Run documentation and source consistency checks**

Run:

```bash
git diff --check
if rg -n "optional LA-calendar-day sparkline|daily token-usage trends|daily token totals, rates, and trend curves|aggregate daily token totals and trend curves" docs/design.md README.md; then exit 1; fi
rg -n "hourly bars|hourly today-versus-yesterday|hourly activity curves|today/yesterday activity curves" docs/design.md README.md
```

Expected: diff check PASS; removed-copy scan prints nothing; replacement-copy scan prints all intended updated lines.

- [ ] **Step 4: Run focused behavior gates**

Run:

```bash
bun test test/strip-token-usage.test.ts test/strip-rail.test.ts
bun run typecheck
bun run build:app
```

Expected: PASS. Record exact test counts rather than saying only “green.”

- [ ] **Step 5: Run the full source gate**

Run: `bun run check`

Expected: biome CI, both TypeScript configs, daemon/plugin builds, and the complete Bun suite all exit 0. Record the exact test/failure counts from this fresh run. Do not substitute the pre-plan 1,335-test receipt; implementation changes require a new receipt.

- [ ] **Step 6: Commit Task 4 before installation**

```bash
git status --short
git add docs/design.md README.md
git commit -m "docs: describe hourly token activity comparison" \
  -m "Update the rail contract and optional agentsview integration copy from cumulative trends to rolling rates plus hourly today-versus-yesterday activity." \
  -m "Keep collection, quota, and interaction documentation unchanged."
```

The pre-commit hook must run normally. After commit, `git status --short --branch` must show a clean task branch.

- [ ] **Step 7: Build, install, and relaunch the actual app**

Run:

```bash
bun run install:app
```

Expected: the script builds the Tauri app, replaces `/Applications/Dealerboard.app`, and relaunches it. This is installed-app evidence, separate from source/build evidence. The daemon does not change, so do not run `bun scripts/install-local.ts`.

- [ ] **Step 8: Verify the installed chart with sanitized data**

On the 2560 by 720 strip, verify all of the following against the installed app:

1. Today is bars, not an always-rising cumulative line.
2. The chart reserves midnight-to-midnight clock positions; completed measured hours render neutral gray.
3. The newest partial hour alone is cyan; future today hours render no bars.
4. Adjacent yesterday renders as a muted-blue line behind the bars and visibly rises/falls with hourly activity.
5. A missing yesterday curve removes both line and `yda` label without shifting the rates column.
6. `12a`, `12p`, `12a`, and `yda` are legible and do not collide with `/hr`, `/10m`, unread, or quota content.
7. The chart height and rail/quota spacing match the previous installed layout.
8. Tap, hold, vertical flick, and horizontal paging started on the rail do nothing; the chart has no interaction handlers.

Use synthetic or sanitized totals only in screenshots/receipts. Never capture provider credentials, raw prompts, transcript content, account identities, or unsanitized sidecar files.

If opacity, bar width, or label offset needs on-glass tuning, make the smallest CSS/geometry-only change, add/update a focused behavior assertion only when the contract changes, rerun Steps 4–7, and amend neither a prior commit nor test history: create a separate `fix(app): tune token activity legibility` commit.

- [ ] **Step 9: Final branch audit**

Run:

```bash
git status --short --branch
git log --oneline --decorate -5
git diff --check main...HEAD
git diff --stat main...HEAD
```

Expected: clean `wip/hourly-token-activity-spec`; four implementation and
documentation commits after the spec and plan commits; no whitespace errors;
diff limited to the seven files listed in the file map plus the already-committed
spec and this plan. Reconcile source, committed, installed, and physical
evidence separately in the handoff.

---

## Completion evidence matrix

| Claim | Required evidence |
| --- | --- |
| Reducer contract implemented | Focused Task 1 tests: standard day, tolerance edges, gap, adjacency, zero, spring/fall DST |
| SVG geometry implemented | Focused Task 2 structured rectangle/segment/label tests |
| Rail renderer implemented | Focused Task 3 DOM tests, typecheck, `build:app`, removed-name scan |
| Source branch healthy | Fresh `bun run check` with exact test and failure count |
| Installed app updated | Successful `bun run install:app` receipt and relaunched process |
| Design works on target | Physical 2560 by 720 observations for legibility, layout, overlay, and non-interaction |

Do not collapse these into one “done” statement. A passing source suite does not prove the installed bundle changed, and an installed bundle does not prove the physical chart is legible.
