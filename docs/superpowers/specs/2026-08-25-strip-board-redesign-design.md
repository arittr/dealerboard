# Strip Board Redesign: Parent-Grouped Cards and the Compact Rail

Date: 2026-08-25

Status: Approved by Drew (visual mockup d6). Supersedes the strip *presentation*
sections of [2026-08-25-strip-rail-quota-windows-design.md](2026-08-25-strip-rail-quota-windows-design.md)
(tick marks and window display on the rail) and the strip geometry/tile-anatomy
sections of [2026-08-18-xeneon-edge-strip-app-design.md](2026-08-18-xeneon-edge-strip-app-design.md).
Data contracts, membership semantics, and the keypad plugin are untouched except
where stated.

Visual reference: [assets/2026-08-25-strip-board/d6.png](assets/2026-08-25-strip-board/d6.png)
(the approved render, real snapshot data) and its source
[d6.html](assets/2026-08-25-strip-board/d6.html). The mockup is the contract of
record for proportions and treatments; this document is the contract of record
for behavior.

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
- `src/core/token-usage.ts` + `src/token-usage-snapshot.ts`: one new data
  requirement (per-day cumulative curves) with a schema bump.
- `src/plugin/render.ts`, the keypad plugin, `src/protocol.ts`,
  `quota-snapshot.json`, membership/ack/routing semantics: unchanged.
- `docs/design.md` strip section is rewritten to this contract at
  implementation time.

All dimensions below are native 2560×720 pixels; the implementation stays
viewport-relative (the 1280×360 HiDPI mode scales proportionally, nothing
pixel-locked), and the top 28px stays clear of critical content.

## Board

### Geometry

- The session area is the canvas minus the 496px rail (~19.4%) and outer
  gutters.
- Cards are a fixed standard size: 1012×102 with 12px gaps, two columns of six
  rows — 12 cards per page (down from 15). Cards never grow or shrink with
  session count: one session renders one standard card top-left; empty canvas
  stays empty. Beyond a page, the existing fling/pager paging applies.

### Ordering: parent-grouped, stable

The board replaces flat slot order with grouped order:

1. Primary sessions (everything not a Paseo subagent) in slot order.
2. Each primary is immediately followed by its own subagents in slot order. The
   join is `originParentRef` (subagent) = `originRef` (parent), both already in
   the session snapshot (schema v11).
3. Orphan subagents — live Paseo subagents whose parent session is not on the
   grid — collect at the end of the board in slot order.

Placement within a page is group-atomic first-fit: a parent plus its subagents
drops whole into the first column with room; a later group may backfill a
skipped gap. Groups never split across columns and never interleave. A group
taller than one column (>6 cards) splits column-to-column but stays contiguous
in scan order; a group larger than a page continues on the next page. Pages are
dense slices of the grouped order.

Accepted trade-off (reviewed with Drew): visual scan order can deviate from
strict linear order when a large group skips a too-small gap — deterministic
and stable, not strictly linear. Stability holds because parentage is
immutable for a session's lifetime: cards move only when membership changes,
never on status changes.

### Primary card anatomy

- Left status edge (8px) in the status color; waiting and error cards
  additionally get a full status-colored border and a faint status-tinted
  surface wash so they pop from working/idle cards.
- Status animation semantics carry over unchanged from the tile contract
  (opacity-only; working's staggered shallow wash breathe, waiting's frame
  breathe, error's 2s pulse, idle static), retargeted to edge/border/wash.
- Provider chip (42px, one-letter mark, locked hues) with the amber unread dot
  on its corner when `unreadSince` is set (on the grid, idle ⟺ unread —
  unchanged).
- One-line 32px title in primary ink; a null title falls back to the project
  name rendered italic (same ink — italic is the only fallback cue).
- Muted meta line: model id (vendor prefix stripped) · project ·
  `activityLine` when present.
- Right-aligned: status dot + status word + tabular-numeral elapsed timer
  (`statusSince`, ticking in place on the 1s cadence as today).
- Right edge: violet origin disc for Paseo parents; descendant badge (`+2`)
  beside the timer row when `descendantCount > 0`.
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
- The idle-subagent admission rule is unchanged: idle Paseo subagents are never
  projected, so grouped subagents are always active.

### Interaction

Unchanged: tap = ack + provider/Paseo routing (subagent cards included),
long-press = action sheet at the touch point, horizontal fling = page, failed
press flashes the card. All cards are ≥90px in their smallest dimension.

## Rail

Fixed 496px (~19.4%), top to bottom:

- **Token block**: today's total (`48.9M` + "tokens today") with the two
  trend-colored rolling rates (`↑ 32.3M/hr · ↓ 8.5M/10m`) — unchanged
  semantics.
- **Day-over-day sparkline** (replaces the 2.4h-ring sparkline): a
  midnight-anchored LA-day x-axis with yesterday's complete cumulative curve
  as a dim 2px line ending in a ≥20px `yda <total>` micro-label, and today's
  partial curve as a bright 2px line with a faint fill ending in an endpoint
  dot at the current hour. No axes, gridlines, or legend.
- **Unread row**: the daemon-health dot (green ok; red + OFFLINE when
  degraded) inline before the exact unread count — the current production
  treatment, no standalone health line.
- **Quota rows** (claude, codex, kimi, zai, qwen), one compact row each: head
  line with chip, provider name, and the binding-window tag pill; the right
  side reads `<reset countdown> · <percent>` with the muted countdown first so
  the bright tabular percents align flush at the rail's right edge regardless
  of countdown width. Below, an 8px full-row-width bar filled to the binding
  window's percent on the headroom palette (green >25%, amber 10–25%, red
  <10%). **Only the binding window renders**: the non-binding tick marks and
  extra-window readouts from the 2026-08-25 quota-windows spec are retired
  from the display (the snapshot contract keeps publishing them; selection
  logic is unchanged).
- **Pager dots**: unchanged behavior.
- Stale/unavailable dimming semantics for quota and token data are unchanged.

## New data: per-day token curves

The yesterday line needs data the collector does not keep — its sample ring
spans ~2.4h. Change to `src/core/token-usage.ts` /
`src/token-usage-snapshot.ts`:

- The collector maintains per-day cumulative curves keyed by the
  America/Los_Angeles `providerDay`: today's curve appends (downsampled to a
  bounded point count, ≤96 points/day) as samples land; at day rollover
  today's completed curve becomes yesterday's and a fresh one starts. Only two
  days are retained.
- `token-usage-snapshot.json` gains the curves and bumps its `schemaVersion`.
- Version handling (needs Drew's sign-off per the compat rule): the strip's
  reader accepts the previous schema and renders a today-only sparkline when
  curves are absent, matching the established update-in-either-order pattern
  (quota snapshot v2 reader accepting v1). The alternative is lockstep deploy
  of daemon and app.
- agentsview output is still never logged or persisted beyond the snapshot.

## Not building

- No keypad/plugin render changes; the deck keeps its square-tile contract.
- No per-provider token split, activity feeds, or any data beyond the fields
  named here.
- No status-based zones or reordering (rejected in review: rounds d3/d4).
- No swipe-to-ack, no new gestures.

## Testing

- View-model units (pure, DOM-free, matching the existing test style):
  grouped-order derivation (parent join, orphan rule, slot order within
  groups), group-atomic first-fit placement including the >6-card split and
  paging slices, quota-row right-side formatting (countdown · percent), and
  day-curve reduction (rollover, downsampling bound, absent-yesterday
  fallback).
- Collector boundary tests for the curve persistence and schema bump.
- Render tests updated for the card DOM (anatomy per status, subagent
  treatment, indent/spine structure, meta-line project suppression).
- Visual verification against d6.png on the device for both display modes.
