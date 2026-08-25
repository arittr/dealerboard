# Strip rail: consistent alignment + per-provider quota windows

Date: 2026-08-25

## Problem

The strip's right rail grew block by block and it shows: three type scales,
two dot sizes, and a weekly summary floating between the label and the
right-aligned percent, so the value column shifts whenever a row lacks data
(GLM's missing reset note, Qwen's missing weekly). The quota contract also
keeps only a session and a weekly window per provider, but CodexBar reports
more: claude carries a `Fable only` weekly-scoped window, codex carries
`Codex Spark 5-hour` / `Codex Spark Weekly` extras. Today the collector scans
`extraRateWindows` only as a fallback when no session window exists and
discards everything else — future harness- or model-specific windows have no
home.

## Decisions (mockup-driven)

Direction "one bar, every window" at a 32% rail width, chosen from
interactive mockups (`.superpowers/brainstorm/`, 2026-08-25). At 32% the
percent and its reset countdown fit on the row together, so the rail gains
no tap interaction. Tile cost of the wider rail: zero at 6+ sessions (the
three-row packing is height-bound); worst case −14% tile size on a sparse
5-session single row. Health dot, unread row, and pager dots all shrink.

## Rail layout (`app/styles.css`, `app/src/rail.ts`)

- `#strip` grid: `1fr 24%` → `1fr 32%`. Rail type stays vw-locked (same
  sizes, more room).
- Token block: hero line unchanged; the two rate lines merge into one —
  `↑ 4.7M/hr · ↑ 1.3M/10m` — each rate span keeping its own trend color,
  the separator muted.
- Unread row: health dot 1vw → 0.5vw; text unchanged.
- Pager: page-dot font-size 1.1vw → 0.6vw, padding 0.4vw → 0.2vw.
- Quota row: chip, label, a muted tag pill naming the binding window, then
  right-aligned `93% · 3d` (percent bright, countdown muted, tabular-nums).
  The floating weekly summary text is dropped — the bar and ticks carry it.
  Unavailable rows keep the existing muted `updated Xm ago` / `unavailable`
  note and dimming; the tag pill renders whenever window data exists
  (last-good included) and is omitted only when never fetched.
- Quota bar: fills to the binding window's percent with the existing
  thresholds (>25% green, ≥10% amber, else red). Every other window draws a
  2px tick at its own percent (`#e8eef7` at 75% opacity). Single-window
  providers (qwen) render no ticks.

## Binding rule and tags (`app/src/quota.ts` view-model)

Each provider's windows reduce to an ordered list: session (when present),
weekly (when present), then extras in published order. Each entry carries
its tag, percent remaining, and reset instant.

- Binding window = lowest `percentRemaining`. Ties break by list order —
  session before weekly before extras — which approximates "the shorter
  window runs out sooner" without carrying window lengths in the contract.
- Tag text: session → `session`, weekly → `weekly`, extra → its published
  `label`. When the provider has more than one window the tag reads
  `<name> binds`; a single window renders the bare name.
- Head right text: `<binding pct> · <binding reset countdown>`; the
  countdown is omitted when the binding window has no reset instant (zai's
  session window reports none).
- `headlinePercent` / `headlineResetAtMs` / `formatWeeklySummary` are
  replaced by the binding-window selection; `quotaBarColor` and the reset
  countdown formatting are unchanged.

## Data contract (`src/quota-snapshot.ts` → schemaVersion 2)

`ProviderQuota` gains:

```
extraWindows: [{ id, label, percentRemaining, resetAt }]  // max 8
```

- `id`: CodexBar's window id (`claude-weekly-scoped-fable`); `label`: the
  display tag, derived daemon-side from CodexBar's title with the provider's
  own display name stripped (`Codex Spark Weekly` → `Spark Weekly`,
  `Fable only` stays), capped at 14 code points with an ellipsis.
- `percentRemaining` is a 0..100 number (extras publish only real readings);
  `resetAt` is a canonical UTC ISO instant or null.
- The session/weekly fields stay as they are — the history ring keys off
  the session window and is unchanged.
- `parseQuotaSnapshot` accepts v1 (extraWindows defaults to `[]`) and v2;
  the writer emits v2. Unknown provider keys stay ignored. Daemon and strip
  app can update in either order.

## Collector (`src/core/quota.ts`)

- `extraRateWindows` is always parsed, not just when no session window
  exists. Session/weekly classification is unchanged (extras still feed the
  session fallback, so codex's Spark 5-hour remains its session window).
- Every extra window not selected as session or weekly publishes into
  `extraWindows` with its derived label. Selection order keeps main-trio
  windows ahead of extras on equal lengths, so codex's secondary weekly
  stays the weekly window and `Codex Spark Weekly` lands in extras.
- The CodexBar widget-snapshot fallback carries only primary/secondary/
  tertiary — it publishes no extras.

## Tests

- `test/quota-snapshot.test.ts`: v1 input parses with empty extras; v2
  round-trips; extras validation (entry cap, bad percent, bad instant,
  missing id/label); unknown provider keys still dropped.
- `test/quota.test.ts`: claude fixture gains `extraRateWindows`
  (Fable only) and publishes it with label intact; codex fixture gains
  Spark Weekly and publishes `Spark Weekly` with the provider name
  stripped; extras are collected even when a session window exists;
  widget-fallback rows publish no extras.
- `test/strip-quota.test.ts`: binding selects the minimum percent;
  precedence tie-break (session > weekly > extras); tick list contents and
  omission for single-window providers; tag strings plus the `binds`
  suffix rule; head text `93% · 3d` and the no-reset-instant case;
  unavailable rendering unchanged.

## Docs

`docs/design.md` rail quota section and the AGENTS.md quota paragraph move
to the v2 contract: extras, binding window, ticks, 32% rail, tightened
dots, one-line rates.

## Non-goals

No tap/cycle/expand interaction on quota rows; no % ↔ reset flip modes.
No zai `Daily tokens`, codex reset credits, or pace summaries. History ring
stays session-window-only. Keypad plugin untouched (quota is strip-only).
Deploy is the usual pair — daemon via `bun scripts/install-local.ts`, strip
via `bun run install:app` — order-independent thanks to the v1-tolerant
reader.
