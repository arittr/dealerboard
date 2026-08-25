# Strip Board Redesign: Parent-Grouped Cards and the Compact Rail

Date: 2026-08-25

Status: Approved by Drew (visual mockup d6), then reviewed by a three-model
panel (gpt-5.6-sol, qwen3.8-max-preview, kimi k3) and amended with the
adjudicated findings. Drew approved the three behavior-visible resolutions:
group-atomic page fill, the accepted early lineage hop, and the additive
(no-bump) snapshot key. Drew subsequently approved upward Paseo-lineage status
aggregation: an active subagent keeps every existing ancestor on the board
even when the ancestor's own turn is done and read. Supersedes the strip
*presentation* sections of
[2026-08-25-strip-rail-quota-windows-design.md](2026-08-25-strip-rail-quota-windows-design.md)
(tick marks and window display on the rail) and the strip geometry/tile-anatomy
sections of [2026-08-18-xeneon-edge-strip-app-design.md](2026-08-18-xeneon-edge-strip-app-design.md).
Wire/data contracts and keypad presentation are untouched. Shared snapshot
membership changes only for the Paseo ancestor-visibility rule stated below.

Visual reference: [assets/2026-08-25-strip-board/d6.png](assets/2026-08-25-strip-board/d6.png)
(the approved render, real snapshot data) and its source
[d6.html](assets/2026-08-25-strip-board/d6.html). The mockup is the contract of
record for proportions and treatments except where this document states a
correction or deviation — each such departure is flagged inline ("corrected" /
"deviation from the mockup"); this document is the contract of record for
behavior.

## Motivation

The shipped strip ported the 72×72 Stream Deck key onto a 32:9 canvas: square
tiles capped small, floated in dead margins, and truncated titles at ~12
characters per line, while a fixed 32% rail spent most of its area on air.
Drew's critique: the rail is too wide for its density, and the key metaphor
wastes the medium. Three mockup rounds converged on a board of wide session
cards with subagents grouped under their Paseo parents, and a rail that earns
a ~19% width.

## Scope

- `app/` (strip webview) rendering and view models: full board + rail redesign.
  The strip's board gets an app-local grouped-board reducer: the shared
  `reduceLayout` / `STRIP_GEOMETRY` in `src/plugin/layout.ts` produce dense
  slot-rank page slices and cannot express grouping or column packing, so the
  strip stops consuming its paging while the keypad keeps the shared reducer
  unchanged. Label fallbacks reuse the shared label chain.
- `src/core/token-usage.ts` + `src/token-usage-snapshot.ts`: one new data
  requirement (per-day cumulative curves) shipped as an additive snapshot key —
  no schema bump (see New data).
- `src/core/projection.ts`: one shared membership refinement. Active Paseo
  subagent status aggregates through `originParentRef` ancestry before the
  existing visibility filter, so a done/read ancestor remains projected while
  its descendant is active. This changes both snapshot consumers consistently;
  it adds no wire or registry fields.
- `src/plugin/render.ts`, the keypad plugin and its overflow latch,
  `src/protocol.ts`, `quota-snapshot.json`, ack/routing semantics: unchanged.
- `docs/design.md`'s strip section and `AGENTS.md`'s strip description are
  rewritten to this contract at implementation time.

All dimensions below are native 2560×720 pixels; the implementation stays
viewport-relative (the 1280×360 HiDPI mode scales proportionally, nothing
pixel-locked), and the top 28px stays clear of critical content. Thin marks
(hairline borders, the 2px spine, the 8px status edge) map per-axis to
viewport units and must stay at least one physical pixel in the 1280×360 mode.

## Board

### Geometry

- The session area is the canvas minus the 496px rail (~19.4%) and outer
  gutters.
- Cards are a fixed standard size: 1012×102 with 12px gaps, two columns of six
  rows — up to 12 cards per page. Twelve is a maximum, not an invariant:
  group-atomic page fill (below) can leave a page sparse. Cards never grow or
  shrink with session count: one session renders one standard card top-left;
  empty canvas stays empty.

### Ordering: parent-grouped, stable

The board replaces flat slot order with grouped order:

1. Primary sessions (everything not a Paseo subagent) in slot order.
2. Each primary is immediately followed by its subagents in slot order. The
   join is `originParentRef` (subagent) = `originRef` (parent). Both fields
   are already published on `ProjectedSession` in the wire snapshot
   (`src/protocol.ts`; the snapshot's `schemaVersion` stays 2 — no protocol
   change. The "v11" in earlier drafts is the registry's SQLite schema, not
   the wire format).
3. Nested subagents flatten: a Paseo subagent whose parent is itself a
   subagent attaches to its nearest on-grid ancestor's group, at the same
   single indent level, ordered directly after its own parent within that
   group. There is no recursive visual nesting.
4. Orphan subagents — live Paseo subagents whose ancestor row is genuinely
   absent or whose lineage cannot be resolved — form one atomic tail block
   strictly after every group, in slot order. A done/read ancestor that still
   exists in the registry is not an orphan case: active-descendant aggregation
   keeps it on-grid. The tail never backfills ahead of groups.

### Paseo ancestor visibility and status

Paseo parentage joins top-level provider sessions through `originRef` /
`originParentRef`; it is separate from the provider-native
`parent_session_id` tree. Projection therefore resolves status in two phases:

1. Compute each top-level row's effective provider-native subtree status as
   today, including the existing rule that any live native descendant lifts an
   idle root to at least `working`.
2. For each effectively active Paseo subagent, walk its resolved Paseo ancestry
   and aggregate status upward using the same
   `error > waiting > working > idle` priority. This walk crosses provider
   boundaries, supports nested subagents, and is bounded against cycles and
   missing links.

The aggregate is the ancestor's projected status. A parent whose own state is
idle and read is therefore projected as at least `working` while any descendant
is active; a waiting or failed descendant lifts it to `waiting` or `error`.
Aggregation does not mutate the stored row, fabricate unread state, or restamp
`statusSince`: the parent keeps its own timer and `unreadSince` remains null.
When the final active descendant stops, the parent immediately falls back to
its own status and ordinary visibility rule, so a read-idle parent leaves the
board then. This is a visibility aggregation over existing registry rows, not
resurrection after an authoritative row removal such as SessionEnd, explicit
clear, or stale prune.

### Packing and paging

Pages fill group-atomically in grouped order (a lone primary is a group of
one; the orphan tail is one block):

- A group of six or fewer cards never splits: it drops whole into the first
  column of the current page with room; a later group may backfill a gap left
  earlier **on the same page**; if it fits in no column of the current page,
  it starts the next page. Backfill never crosses a page boundary.
- A group of 7–12 cards needs two adjacent empty columns, so it starts on the
  current page only while that page is still empty; otherwise it starts the
  next page. It fills the first column and wraps at the six-row boundary into
  the second (the spine continues at the top of the continuation column).
- A group larger than a page fills whole pages from a fresh page and
  continues across page seams. These are the only ways a group ever splits.
- Page count derives from the packing, not the session count; the rail's
  pager dots follow it, and the persisted current page
  (`agent-strip.layout.v1`) clamps when the page count shrinks. The keypad's
  overflow-latch hysteresis is a NEXT-key concern and does not carry to the
  board.

Two accepted trade-offs (reviewed with Drew):

- Scan order can deviate from strict linear order when a large group skips a
  too-small gap — deterministic and stable, not strictly linear.
- Placement stability has one qualification: hooks stamp only Paseo kind/ref
  at ingest, and the daemon's overlay adds `originSubagent` and
  `originParentRef` on its ~2s pass, so a freshly appeared subagent can render
  ungrouped for its first seconds and then hop into its parent's group once
  the stamp lands. This one-time early hop is accepted; there is no admission
  gating on resolved lineage. Beyond that, cards move only on membership
  change — parentage, once stamped, is immutable for the session's lifetime.

### Primary card anatomy

- Left status edge (8px) in the status color; waiting and error cards
  additionally get a full status-colored border and a faint status-tinted
  surface wash so they pop from working/idle cards.
- Status animation semantics carry over unchanged from the tile contract
  (opacity-only; working's staggered shallow wash breathe, waiting's frame
  breathe, error's 2s pulse, idle static), retargeted to edge/border/wash —
  including the wall-clock-seeded negative animation delay
  (`washAnimationDelay`) so a recreated card resumes mid-wash instead of
  snapping to the dim end.
- Provider chip (42px, one-letter mark, locked hues) with the amber unread dot
  on its corner when `unreadSince` is set (on the grid, idle ⟺ unread —
  unchanged).
- One-line 32px title in primary ink, ellipsized on overflow. The label chain
  is the shared one: title, else project name, else provider + shortened
  session id; any fallback (not just project) renders italic as its only cue.
- Muted meta line: model id (vendor prefix stripped, capped at 24 code points
  with an ellipsis — the tile contract's 10-point cap does not apply) ·
  project · `activityLine` when present.
- Right-aligned: status dot + status word + tabular-numeral elapsed timer
  (`statusSince`, ticking in place on the 1s cadence as today).
- Meta-line right end: violet origin disc for Paseo parents, and the bare
  descendant-count badge (`2`, never `+2` — the locked badge convention; the
  d6 mockup's `+2` is corrected) when `descendantCount > 0`. The count is
  live descendants per the existing contract (e.g. Claude Task subagents),
  not the number of grouped sub-cards.
- Degraded snapshot: cards keep the `!` flag; an all-blank page renders
  OFFLINE — unchanged semantics.

### Subagent card treatment

- Dimmed: near-canvas surface, hairline border, 26px muted title, 32px chip,
  half-opacity status edge; a hollow-violet-ring "sub" pill after the chip
  replaces the corner ring pip.
- Grouped subagents indent 44px (968×102, right edges stay flush) under their
  parent, connected by a 2px violet spine from the parent's bottom edge with an
  elbow into each subagent card.
- A grouped subagent whose project equals its parent's suppresses the project
  in the meta line (redundant; deviation from the mockup, which repeats it).
- Orphans keep the dimmed treatment and "sub" pill at full 1012px width, no
  indent or spine.
- The idle-subagent admission rule is unchanged: an idle Paseo subagent with no
  active descendant is never projected. An otherwise-idle subagent retained by
  an active descendant has an effectively active projected status, so every
  grouped subagent card is still active.

### Interaction

Unchanged: tap = ack + provider/Paseo routing (subagent cards included),
long-press = action sheet at the touch point, horizontal fling = page, failed
press flashes the card. All cards are ≥90px in their smallest dimension.

## Rail

Fixed 496px (~19.4%), top to bottom:

- **Token block**: today's total (`48.9M` + "tokens today") with the two
  trend-colored rolling rates (`↑ 32.3M/hr · ↓ 8.5M/10m`) — unchanged
  semantics, still computed from the 288-sample ring, which is retained
  unchanged.
- **Day-over-day sparkline** — a new element (the shipped rail has no
  sparkline; the ring feeds the rates only): a midnight-anchored LA-day x-axis
  with yesterday's complete cumulative curve as a dim 2px line ending in a
  ≥20px `yda <total>` micro-label, and today's partial curve as a bright 2px
  line with a faint fill ending in an endpoint dot at the current position.
  Semantics:
  - The yesterday line renders only when the snapshot's yesterday curve is
    stamped with the LA calendar day immediately preceding the snapshot's
    `providerDay`; otherwise only today's line renders. No curves in the
    snapshot → no sparkline (the block keeps total + rates).
  - Each curve maps x by elapsed fraction of its own day's actual length, so
    23/25-hour DST days share the axis correctly.
  - One shared zero-based y-scale spans the maximum of both curves.
  - The block's existing stale-dimming applies to the sparkline with it.
- **Unread row**: the daemon-health dot (green ok; red + OFFLINE when
  degraded) inline before the exact unread count — the current production
  treatment, no standalone health line.
- **Quota rows** (claude, codex, kimi, zai, qwen), one compact row each: head
  line with chip, provider name, and a pill naming the binding window; the
  right side reads `<reset countdown> · <percent>` with the muted countdown
  first so the bright tabular percents align flush at the rail's right edge
  regardless of countdown width ("resetting…" takes the countdown's muted slot
  at reset time, as the existing formatter does). Below, an 8px
  full-row-width bar filled to the binding window's percent on the headroom
  palette (green >25%, amber 10–25%, red <10%). **Only the binding window
  renders**: the non-binding tick marks and extra-window readouts from the
  2026-08-25 quota-windows spec are retired from the display, and the pill's
  ` binds` suffix retires with them (every displayed window is the binding
  one). The snapshot contract keeps publishing all windows; selection logic is
  unchanged.
- **Pager dots**: unchanged behavior.
- Stale/unavailable dimming semantics for quota and token data are unchanged.

## New data: per-day token curves

The yesterday line needs data the collector does not keep — its sample ring
spans ~2.4h. Change to `src/core/token-usage.ts` /
`src/token-usage-snapshot.ts`:

- `token-usage-snapshot.json` gains an additive top-level `dayCurves` key.
  `schemaVersion` stays 1: the parser's documented contract ignores unknown
  top-level keys precisely so a newer daemon never breaks an older app
  (verified; approved by Drew). An old app ignores the key and keeps the full
  block; a new app on an old daemon sees no key and renders no sparkline.
- Shape (both curves date-keyed):

  ```ts
  dayCurves: {
    today: { providerDay: string; points: { fetchedAt: string; totalTokens: number }[] };
    yesterday: { providerDay: string; points: { fetchedAt: string; totalTokens: number }[] } | null;
  }
  ```

  Points are oldest-first, totals clamp non-negative like the rates, and each
  day is bucket-downsampled to at most 96 points while always retaining the
  day's first and latest sample. Within a day the collector stores the running
  maximum, so a curve is monotone non-decreasing even if the helper reports a
  correction.
- Rollover is date-keyed, never positional: when a sample lands on a new LA
  day, today's finished curve is promoted to `yesterday` only if its
  `providerDay` is exactly the calendar day preceding the new day; otherwise
  `yesterday` becomes null. A daemon that was down across midnight (or for
  days) therefore never promotes a stale curve.
- Restart seeding: curves seed from the previous publication exactly like the
  ring, then the same date-key check runs against the current LA day —
  a seeded "today" from an older day is either promoted (if adjacent) or
  dropped, never mislabeled.
- The 288-sample `samples` ring is unchanged and remains the sole input to the
  /hr and /10m rates.
- agentsview output is still never logged or persisted beyond the snapshot.

## Not building

- No keypad/plugin render changes; the deck keeps its square-tile contract and
  overflow latch.
- No per-provider token split, activity feeds, or any data beyond the fields
  named here.
- No status-based zones or reordering (rejected in review: rounds d3/d4).
- No recursive visual nesting for sub-of-sub chains (flattened to one level).
- No admission gating on resolved Paseo lineage.
- No swipe-to-ack, no new gestures.

## Testing

View-model units (pure, DOM-free, matching the existing test style):

- Shared projection: separate top-level Paseo rows retain every existing
  ancestor while a descendant is active, aggregate status upward across nested
  and cross-provider lineage, preserve the ancestor's unread value and own
  timer, release it after the final descendant stops, and bound missing/cyclic
  lineage without a snapshot blackout.
- Grouped-order derivation: parent join, nested-subagent flattening to the
  nearest on-grid ancestor, orphan tail atomicity, slot order within groups,
  and the lineage hop (a subagent's overlay stamp arriving after its first
  projection regroups it exactly once).
- Packing: group-atomic page fill (three 4-card groups → pages of 8 and 4),
  same-page-only backfill, the 7–12 empty-page rule with spine continuation,
  the >12 page split, page-count derivation, persisted-current-page clamping
  when the page count shrinks, and the session-count boundaries: 1–3 (sparse
  standard-size cards, no growth), exactly 12, 13 (two pages), and 15+.
- Quota row formatting: countdown-then-percent, "resetting…" in the muted
  slot, pill without the ` binds` suffix, no tick marks.
- Day-curve reduction: yesterday-adjacency check (adjacent renders, gap hides),
  absent-key fallback (no sparkline, block intact), DST elapsed-fraction
  mapping on 23/25-hour days, shared y-scale, stale dimming.

Collector boundary tests: bucket downsampling bound with first/latest
retention, date-keyed rollover including the skipped-day case, and restart
seeding of curves. Parser tests: `dayCurves` accepted additively under
schemaVersion 1, an old reader's parse of a curve-bearing snapshot (unknown
key ignored), and the existing version rejection unchanged.

Render tests for the card DOM: anatomy per status, subagent treatment and
indent/spine structure, meta-line project suppression, bare badge, the full
title fallback chain with ellipsis, the 24-point model cap, wash
phase-continuity (negative animation delay) on recreated cards, and the
degraded treatments (per-card `!` flag; the all-blank OFFLINE page).

Interaction: tap, long-press, and fling identity resolve correctly through the
grouped DOM (card → session mapping survives grouping and paging).

Gate: `bun run check`, plus visual verification against d6.png on the device
in both display modes.
