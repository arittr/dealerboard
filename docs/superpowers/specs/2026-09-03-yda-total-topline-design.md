# Yesterday's token total on the top line

## Problem

The hourly activity chart (2026-09-02) replaced the cumulative sparkline and
with it removed the `yda <total>` endpoint label — yesterday's daily total is
no longer shown anywhere. The chart keeps a bare `yda` marker at the line's
endpoint, but it names nothing quantitatively, and at the strip's real scale
(busy evenings, bars through the current hour) any in-chart label collides
with bars and adds clutter.

Drew reviewed browser mockups of three placements (in-chart endpoint label,
beside the today total, third rates row), then three on-chart backing
treatments under a busy-day stress case (plain, halo, chip), then three
top-line connection treatments. He chose: the total lives on the top line,
rendered in the yesterday line's blue so color alone connects it to the
chart, and the chart's floating `yda` marker is removed entirely.

## Goal

Show yesterday's daily token total next to today's, visually tied to the
yesterday line by color, while decluttering the chart. No snapshot, schema,
collector, or footprint changes.

## Non-goals

- Changing the hourly reduction, chart geometry, scaling, or line segmentation.
- Changing token accounting, retention, or the snapshot contract.
- Reintroducing any in-chart text label for the yesterday series.
- Hover, tooltips, or interaction of any kind.

## Visual contract

The token section's top line becomes:

```
<total> today · <yda total> yda
```

- `<total> today` is unchanged: `#e8eef7`, `1.6vw`, weight 650.
- The separator `·` renders in muted `#475569`.
- `<yda total> yda` renders in `#60a5fa` — a lighter shade of the line's
  `#3b82f6`, legible at text size — at `1.0vw`, weight 600, using the existing
  `formatTokensCompact` formatting.
- The yda fragment appears only when a yesterday total is available
  (derivation rules below); otherwise the top line is exactly `<total> today`.

The chart loses its floating endpoint marker: the `yda` text element is no
longer rendered. Axis labels, bars, yesterday line, current-hour cyan, stale
opacity, and the 500 by 84 view box are all unchanged. The top-line addition
sits within the existing `.tokens-today` line and does not increase the token
block's height: the yda fragment is smaller text on the same baseline row.

Because the blue fragment is the line's only legend, it must be present
whenever the yesterday line can render — the derivation below guarantees the
total exists whenever the overlay does, and also covers cases where the
overlay cannot render (isolated or sparse points).

## Data model

`TokenUsageRailModel`'s `ok`/`stale` variant gains one field:

```ts
yesterdayTotalTokens: number | null;
```

Derivation in `reduceTokenUsageRead` (app/src/token-usage.ts), from the
already-validated snapshot:

- `snapshot.dayCurves?.yesterday` must be non-null and its `providerDay` must
  be the immediately preceding calendar day of `today.providerDay` — the same
  adjacency rule the chart overlay uses.
- The total is the newest curve point whose `fetchedAt` falls within
  yesterday's LA day bounds (`laDayBoundsMs`). `totalTokens` is cumulative
  and the provider day resets at LA midnight, so the newest in-day point is
  the day's final total. A point after midnight belongs to today and is never
  read as yesterday's.
- Missing curve, non-adjacent day, or no in-day points → `null`.

This is deliberately not gated on the chart overlay's stricter eligibility
(two consecutive measured buckets): the total is the line's legend and is
truthful — a real provider-reported cumulative reading — even when the
hourly overlay cannot render.

App-internal model change only; nothing is persisted or sent over the wire.

## Rendering

`app/src/rail.ts`:

- `tokensSection` appends the separator span and a `tokens-yda` span to the
  `.tokens-today` div when `yesterdayTotalTokens !== null`.
- `tokenActivityBlock` drops the endpoint-label block. `tokenActivityLineEndpoint`
  in app/src/token-usage.ts becomes unused and is removed along with its test.
- `railRenderSignature` already serializes the whole token model, so the new
  field invalidates rendering with no signature change.
- The whole-section stale opacity covers the new fragment automatically.

`app/styles.css`:

- `.token-activity-yda` leaves the shared axis-label rule (`.token-activity-axis`
  keeps `20px`/600/`#cbd5e1`).
- New `.tokens-yda` (`#60a5fa`, `1.0vw`, weight 600) and `.tokens-yda-sep`
  (`#475569`, `1.0vw`) rules.

## Files and boundaries

- `app/src/token-usage.ts`: `yesterdayTotalTokens` derivation; remove
  `tokenActivityLineEndpoint`.
- `app/src/rail.ts`: top-line fragment; remove the endpoint label rendering.
- `app/styles.css`: style swap above.
- `test/strip-token-usage.test.ts`: derivation coverage; drop the endpoint
  test.
- `test/strip-rail.test.ts`: top-line fragment present/absent; chart emits no
  `token-activity-yda`; signature reacts to `yesterdayTotalTokens`.
- `docs/design.md`: rail section mentions the yesterday total beside today's.

Unchanged: `src/token-usage-snapshot.ts`, `src/core/token-usage.ts`, polling,
protocol, quota panels, gesture code, README (its aggregate wording stays
accurate).

## Testing

Reducer tests:

- adjacent yesterday curve with in-day points → newest in-day `totalTokens`;
- points after midnight are never read as yesterday's total;
- missing, null, non-adjacent, or empty yesterday curve → `null`;
- a yesterday curve too sparse for the overlay (isolated point) still yields
  the total;
- no `dayCurves` → `null`.

Renderer tests:

- the top line shows separator + `yda` fragment iff `yesterdayTotalTokens` is
  non-null, with the compact formatting;
- the chart renders no `token-activity-yda` element;
- the render signature changes when `yesterdayTotalTokens` changes.

Run `bun run check` as the full gate, then install/relaunch and verify on the
2560 by 720 strip: the blue total reads at viewing distance, the top line
doesn't wrap or push the rates/chart row, and the chart is clean without the
floating marker.

## Acceptance criteria

1. `<total> today · <yda total> yda` renders with the blue treatment whenever
   an adjacent yesterday curve has an in-day point.
2. The chart contains no `yda` text element; everything else about it is
   unchanged.
3. No snapshot, schema, collector, protocol, or footprint change.
4. Focused tests and `bun run check` pass; installed-app physical check on the
   strip confirms legibility and layout.

## Alternatives considered

- **In-chart `yda <total>` label (plain, halo, or chip backing).** Rejected
  via busy-day mockup: the endpoint sits low among late-night bars, every
  backing treatment fought the plot, and the label read as disconnected from
  the line it named.
- **Third row in the rates column.** Rejected via mockup: grows the token
  block taller than the chart and squeezes quota panels.
- **Legend swatch (mini line sample) beside the top-line total.** Rejected
  via mockup: most explicit connection but a new kind of element and the
  busiest top line.
- **Blue top-line total while keeping the chart's tinted `yda` marker.**
  Rejected via mockup: two `yda` touchpoints; removing the marker keeps the
  plot clean and the color echo is sufficient.

## Golden-question checklist

- [x] Data migration / existing-data impact: none; reads existing snapshot
      fields only.
- [x] Auth / permissions: N/A; local sidecar data only.
- [x] Failure / retry behavior: unchanged; the fragment follows the section's
      existing stale/hidden states.
- [x] Rollback path: revert the commit; no stored state.
- [x] Observability / logging: no new logs.
- [x] Backward compatibility: older snapshots without `dayCurves` simply render
      no yda fragment.
- [x] Physical-display legibility: installed-app strip check is required.
