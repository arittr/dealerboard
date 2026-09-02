# Hourly token activity: today bars with yesterday overlay

## Problem

Kickoff (Drew): "the line is always up and to the right and doesn't show much
extra info, it's always the same more or less. how can we improve it"

The rail currently plots each LA calendar day's cumulative token total. The
collector deliberately keeps that total monotone, and the view scales it from
zero, so the line can only move up and right. Yesterday's cumulative line adds
some pace comparison, but both curves usually have the same visual shape and
the chart repeats information already conveyed by the total and rolling rates.

After comparing recent-activity, pace-delta, and projection mockups, Drew chose
an activity histogram, expanded it to a full day, and approved a yesterday
overlay. The approved visual is a midnight-to-midnight comparison: today's
hourly activity is shown as bars through the current hour, and yesterday's
hourly activity is a thin line aligned by LA clock hour.

## Goal

Replace the cumulative sparkline with a compact chart that makes bursts, quiet
periods, and day-over-day differences visible at a glance while preserving the
rail's current footprint. The chart must use the existing token snapshot,
remain truthful when observations are incomplete, and leave the total, rolling
rates, staleness treatment, quota panels, and rail interaction boundary
unchanged.

## Non-goals

- Predicting the end-of-day total.
- Showing a rolling 24-hour window. The available curves retain today and the
  adjacent previous calendar day; they do not retain the preceding rolling
  comparison window.
- Adding hover, tap, drill-down, tooltips, or chart controls.
- Changing token accounting, `agentsview` polling, snapshot schema, point
  limits, or sidecar publication.
- Adding provider-level token attribution.
- Making historical gaps look like measured zero usage.

## Post-install retention amendment

The first installed physical check exposed a pre-existing retention defect,
not a renderer defect. Repeatedly applying whole-array uniform downsampling to
an already-downsampled 96-point curve retained roughly half of the points near
midnight and half near the newest sample, progressively erasing the middle of
the day. A 24-hour synthetic run reproduced the live first-edge/last-edge
shape and its approximately 23-hour interior gap.

Drew approved a narrow collector amendment: retain the latest observation in
each fixed 30-minute elapsed-time bucket. A normal day then retains 48 points,
spring DST retains 46, and fall DST retains 50, all below the unchanged
96-point schema bound. LA hour boundaries align with these absolute half-hour
buckets, so the reducer receives a recent observation before every covered
hour boundary without interpolation. Missing collection buckets remain
missing.

The amendment does not backfill or fabricate history already destroyed by the
old downsampler. Existing gaps remain visibly unmeasured while new coverage
fills forward. The physical check also authorizes setting the sparse chart
labels to `20px`, weight `600`, and neutral `#cbd5e1` inside the unchanged 500
by 84 view box.

## Visual contract

The token section keeps its current two-column flow: the `/hr` and `/10m`
values stay on the left and the chart stays in the existing 500 by 84 SVG box
on the right.

The chart contains:

- 24 stable x positions, one for each LA wall-clock hour from midnight through
  23:00;
- solid neutral-gray bars for today's measured hourly activity;
- a cyan bar for the current, incomplete hour;
- no today bar for a future or unmeasured hour;
- a thin muted-blue line for yesterday's hourly activity, rendered behind the
  bars and broken across unmeasured hours;
- small `12a`, `12p`, and `12a` labels at the left edge, center, and right edge;
  and
- a small `yda` label at the last rendered point of yesterday's line.

Both series share one zero-based y-scale derived from the largest measured
hourly total in either series. This makes bar and line heights directly
comparable. A one-token floor prevents divide-by-zero geometry when every
measured bucket is zero. The current bar is not extrapolated to a full hour;
cyan communicates that it is partial.

More token usage is not inherently good or bad. The chart therefore does not
use green/red success semantics. Neutral gray distinguishes today, muted blue
distinguishes yesterday, and the rail's existing cyan marks only the live
partial bucket.

The old area fill, cumulative today line, endpoint dot, and `yda <total>` label
are removed. The top-level `<total> today` value remains the authoritative
daily total.

## Data model

The app continues to consume `TokenUsageSnapshot.dayCurves` unchanged:

```ts
type TokenUsageDayCurvePoint = { fetchedAt: string; totalTokens: number };
type TokenUsageDayCurve = {
  providerDay: string;
  points: TokenUsageDayCurvePoint[];
};
type TokenUsageDayCurves = {
  today: TokenUsageDayCurve;
  yesterday: TokenUsageDayCurve | null;
};
```

`app/src/token-usage.ts` replaces `SparklineModel` with these domain-named
activity types. The model distinguishes measured zero from every absent state:

```ts
type HourlyActivityBucket =
  | {
      hour: number; // LA wall-clock hour, 0...23
      state: "measured" | "current";
      tokens: number;
    }
  | {
      hour: number;
      state: "future" | "unmeasured" | "nonexistent";
      tokens: null;
    };

type TokenActivityChartModel = {
  today: HourlyActivityBucket[]; // exactly 24 stable positions
  yesterday: HourlyActivityBucket[] | null; // exactly 24 when present
  yMax: number;
};
```

The renderer receives structured buckets. Token differencing, coverage
decisions, adjacency checks, DST folding, and normalization remain in the pure
view-model module, not in DOM code.

`TokenUsageRailModel` replaces its `sparkline` field with `activity`. This is an
app-internal model change, not a persisted or wire-format change.

## Hourly reduction

### Calendar and adjacency

- `today.providerDay` defines the LA calendar day shown by the bars.
- Yesterday is used only when its `providerDay` is the immediately preceding
  calendar date and reduction produces at least two consecutive measured
  buckets. A missing, empty, non-adjacent, or isolated-point curve produces no
  overlay.
- Each day is bounded with the existing LA timezone helpers. The reduction
  walks actual one-hour intervals from local midnight to the next local
  midnight and maps each interval to the LA wall-clock hour at its start.
- A normal day maps one interval into each of the 24 positions. On spring DST,
  the skipped clock hour has state `nonexistent`. On fall DST, both
  repeated-hour intervals are summed into the same clock-hour position. If
  either elapsed interval is unmeasured, the combined position is unmeasured
  rather than a misleading partial total. While the first or second repeated
  interval is in progress, the folded position is `current` and sums only
  elapsed measured activity.

This preserves a stable 24-column clock face while respecting the existing
23/25-hour LA day bounds.

### Cumulative boundary reads

An hourly value is the non-negative difference between the cumulative total at
the interval's end and its cumulative total at the interval's start.

For a boundary, use the newest point at or before that instant only when it is
no more than 30 minutes old. The tolerance matches the collector's fixed
30-minute retention buckets, allowing normal polling jitter without treating
a collector outage as coverage. Do not use a point after the boundary and do
not interpolate across a gap; either would assign tokens to an hour that was
not observed.

LA midnight has an exact synthetic cumulative total of zero because the
provider-day total resets at that boundary. Other boundaries require a retained
observation within the tolerance.

For today's current interval, use the newest point as the partial end instead
of the future hour boundary. Intervals after that point have state `future` and
remain empty. A completed interval or partial current interval is measured
only when both boundary totals are available; otherwise its state is
`unmeasured`.

Curve totals are contractually non-decreasing. The reducer still clamps a
calculated difference at zero so malformed arithmetic can never create a bar
below the baseline.

### Scaling and geometry

`yMax` is the maximum `measured` or `current` bucket across today and
yesterday, with a floor of one. Today's bar height and each yesterday point use
`tokens / yMax`. Yesterday points sit at the horizontal center of their clock
hour's slot.

The existing SVG view box remains 500 by 84. Geometry helpers return structured
bar rectangles and yesterday line segments so behavior can be tested without
asserting a large rendered SVG string. Missing yesterday buckets split the line
into independent segments; the renderer must never draw through a data gap.

The current hour is identified from the newest valid point, not wall-clock
`Date.now()`, so a stale snapshot does not manufacture a newer partial bucket.
The existing stale state continues to dim the whole token section.

## Rendering

`app/src/rail.ts` replaces the cumulative sparkline renderer with a thin SVG
shell for the activity model:

1. Draw the three fixed time labels.
2. Draw yesterday's available line segments and its `yda` endpoint label.
3. Draw today's measured bars over the line.
4. Apply the current-hour cyan fill only to the bucket whose model marks
   `current`.

The chart adds no event handlers and remains structurally outside the board's
gesture system. `railRenderSignature` already includes the complete token
model; the new structured activity field therefore invalidates rendering
whenever a bucket, coverage state, current marker, or yesterday input changes.

CSS keeps the current `.rail-sparkline` footprint under a domain-named activity
class. The chart must not increase the token block's height or reduce quota
panel space at the 2560 by 720 target resolution.

## Empty, stale, and incomplete states

- No token snapshot, invalid JSON, or no successful fetch: preserve the current
  hidden token-section behavior.
- Valid snapshot without `dayCurves`: show total and rolling rates, but no
  chart, as today.
- No reducible buckets in either curve: omit the chart.
- Today only: render measured bars with no yesterday line or `yda` label.
- Yesterday only at the start of a new day: render the yesterday line while
  today's positions remain empty until a current bucket is measurable.
- Long historical collection gap: affected bars are absent and yesterday's
  line is broken; do not spread the observed increase across the gap.
- Stale/unavailable latest poll with retained last-good curves: preserve the
  chart and the existing whole-section stale opacity.
- Zero-usage measured hour: retain a measured zero bucket in the model. It may
  have zero visible height, but it remains distinct from `null` for scale,
  line-segmentation, signatures, and tests.

## Files and boundaries

Expected implementation surface:

- `src/core/token-usage.ts`: fixed 30-minute day-curve retention buckets.
- `src/token-usage-snapshot.ts`: unchanged schema limit with accurate retention
  documentation.
- `app/src/token-usage.ts`: hourly reduction, activity model, and pure geometry.
- `app/src/rail.ts`: SVG activity renderer and token-section wiring.
- `app/styles.css`: domain-named activity chart styling within the current
  dimensions.
- `test/strip-token-usage.test.ts`: reduction and geometry behavior.
- `test/token-usage.test.ts`: full-day and DST retention coverage.
- `test/strip-rail.test.ts`: minimal DOM contract and render-signature coverage.
- `docs/design.md` and `README.md`: replace cumulative trend/sparkline wording
  with hourly activity comparison wording.

The following are deliberately unchanged:

- `src/token-usage-snapshot.ts` schema, validation, and point limit;
- token accounting and `agentsview` command invocation;
- app/daemon sidecar read cadence; and
- session snapshot, quota snapshot, protocol, database, and gesture code.

The collector amendment is limited to how valid same-day points are retained.
It must not change token calculation, polling, publication, schema version, or
the 96-point compatibility bound.

## Testing

Pure reducer tests must cover:

- a standard LA day with known cumulative boundaries produces the expected
  hourly differences;
- today always returns 24 stable positions;
- completed, current partial, future, measured-zero, and unmeasured buckets
  stay distinct;
- the current partial hour uses the newest observation rather than the future
  boundary;
- today and adjacent yesterday share one y-scale;
- missing, empty, non-adjacent, and isolated-point yesterday curves omit the
  overlay;
- a boundary observation within 30 minutes is accepted and one outside the
  tolerance leaves the bucket unmeasured;
- no interpolation or token distribution occurs across a long gap;
- spring DST leaves the nonexistent clock hour empty;
- fall DST folds both repeated intervals into one clock-hour bucket and rejects
  a partially measured fold; and
- all-zero measured data uses a finite scale and geometry.

Geometry tests operate on structured points/rectangles and verify:

- 24 stable bar slots;
- shared-scale bar and line heights;
- missing yesterday hours split line segments;
- future/unmeasured today buckets emit no rectangle; and
- the current rectangle carries the current visual state.

Renderer tests remain small behavioral assertions rather than snapshots of the
entire SVG. They verify bars, yesterday segments/label, the three time labels,
draw order, current-hour class/data state, chart omission, and that the render
signature changes for render-affecting activity input.

Run `bun run check` as the full source gate. Then install/relaunch the app and
verify on the 2560 by 720 strip display with synthetic or sanitized data that:

- bars and the overlay are legible at normal viewing distance;
- the line remains visible without obscuring the bars;
- `12a` / `12p` / `12a` and `yda` do not collide with rates or quota content;
- the chart fits the existing 84px-native height; and
- the rail still has no gesture handlers or board interaction behavior.

## Acceptance criteria

1. The old cumulative up-and-right graphic is gone.
2. The rail shows a stable midnight-to-midnight 24-position chart.
3. Today's measured hourly token activity appears as neutral bars only through
   the current hour; the partial current hour is cyan.
4. Adjacent yesterday activity appears as a muted line aligned by LA clock
   hour and scaled with today; absent data is not connected or invented.
5. Total, `/hr`, `/10m`, trend arrows, stale opacity, unread count, quota
   panels, layout footprint, and interaction behavior remain unchanged.
6. No persisted schema, point-limit, protocol, or polling change is introduced;
   the collector changes only its same-day retention compaction.
7. Focused tests, `bun run check`, installed-app smoke, and physical strip
   legibility all pass before completion is claimed.

## Alternatives considered

- **Recent two-hour 10-minute bars.** Most detailed burst view and directly
  supported by the sample ring, but Drew wants a full-day pattern.
- **Rolling 24 hours ending now.** Useful alone, but overlaying its preceding
  comparison window requires data from portions of the day before yesterday,
  which the current snapshot does not retain. Rejected to avoid a schema and
  retention expansion.
- **Two overlaid bar series.** Semantically exact but visually dense in the
  available width. A line gives yesterday a distinct, quieter visual grammar.
- **Today-minus-yesterday delta line.** Compact and bidirectional, but hides the
  absolute burst pattern and assigns positive/negative semantics to usage.
- **End-of-day projection.** Visually polished but implies unjustified
  certainty for bursty agent workloads.
- **Linear interpolation across sparse points.** Produces smooth complete
  charts but invents when activity happened during collection gaps. Rejected.
- **Extend snapshot retention.** Would enable arbitrary rolling comparisons but
  expands the wire/persistence contract without being needed for the approved
  calendar-day design.

## Open questions

None blocking. On-glass tuning may adjust bar width, stroke opacity, and label
offsets without changing the visual or data contracts above. Any change to
bucket duration, comparison period, missing-data semantics, or collection
retention requires Drew's approval.

## Golden-question checklist

- [x] Data migration / existing-data impact: none; the token snapshot schema and
      retained curves are unchanged.
- [x] Auth / permissions: N/A; existing local sidecar data only.
- [x] Failure / retry behavior: unchanged; missing and stale sidecar behavior
      keeps today's semantics, and historical gaps remain visibly unmeasured.
- [x] Rollback path: revert the app/model/docs commit; no stored state to unwind.
- [x] Observability / logging: no new logs; chart coverage is derived locally
      from already-validated timestamps.
- [x] Backward compatibility: no new compatibility path; an existing older
      snapshot without optional `dayCurves` continues to show totals/rates and
      omit the chart.
- [x] Physical-display legibility: explicit installed-app and 2560 by 720 strip
      acceptance is required.
