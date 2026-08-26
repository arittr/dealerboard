# Strip layout rebalance — wider rail, full-width quota bars, no scroll

Date: 2026-08-26
Status: Approved direction (mockup round); spec pending Drew's review
Approved mockup (contract of record): `assets/2026-08-26-strip-layout-rebalance/d7.html`
Predecessor contract: `assets/2026-08-25-strip-board/d6.html` (board card anatomy is unchanged from it except where stated)

## Problem

At 2560×720 with the two-account Claude group, the 600px rail's content stack
totals ~720–730px: tokens block ~190px (total line, rates line, 102px
sparkline), unread ~33px, Claude group ~160px, four provider meters ~204px,
pager, inter-section gaps, and 60px vertical padding. The body scrolls (a
visible scrollbar on the strip), `space-between` has no slack, and every rail
section packs upward — the squish Drew flagged. Meanwhile the board spends
966px per card on a title plus one meta line, leaving a dead middle.

Three mockup rounds (native-resolution renders with live data, in the
brainstorm companion) converged on variant **D2b**:

- Round 1: A (tidy 600 rail) / B (3×600 board) / C (bottom bar) / D (rail 760,
  board 2×886) — Drew picked **D**.
- Round 2: D2a (single-line meters spread out) vs D2b (full-width bars) —
  Drew picked **D2b**, plus: quota bars reclaim the freed space, unread text
  smaller, and the /hr + /10m rates sit beside the sparkline (Drew's
  suggestion mid-round).

## Locked visible contract (native px at 2560×720; vw = px/25.6, vh = px/7.2)

### Strip grid

- `#strip`: `grid-template-columns: 1fr 29.6875%` — the rail is 760px native
  (was 600 / 23.4375%). The board area is 1800px.

### Board

- Two columns of **886×102** cards (was 966): `repeat(2, 34.609vw)`. Rows,
  gaps, and padding are unchanged: six 102px rows, 12px gaps, 44px top
  padding for the menu-bar overlay (24px in fullscreen), 16px left padding.
  16 + 886 + 12 + 886 = 1800 exactly.
- `BOARD_COLUMNS`/`BOARD_ROWS` and the packing reducer are untouched — this
  is a CSS-width change only.
- Subagent cards keep the 44px indent and spine; they become 842 wide with
  right edges flush, per the existing rule.
- **Status word**: working and idle cards (primary and subagent) no longer
  render the status word — the colored dot plus the timer carry the state.
  Waiting and error keep their bright bold word (they are the attention
  states). This is a render change in `app/src/cards.ts` (the span is not
  created), not a CSS hide. The keypad plugin renderer is untouched.
- All other card anatomy (chip, unread corner dot, sub pill, meta line,
  badge, origin disc, edge/wash/breathe treatments) is unchanged from d6.

### Rail (760px, top to bottom)

Padding stays `6.111vh 3.5% 2.222vh` (44px top — 24px fullscreen — ~27px
sides at the new width); inner width ≈ 704px. The rail remains a flex column
with `justify-content: space-between; gap: 1vh`; the sections stay flat (no
new wrapper). The rebuilt tokens block and smaller unread line free ~80px,
which space-between distributes as air between sections — with a third
Claude account (+~63px) the rail still fits without scrolling.

1. **Token block** — `562.7M today` line unchanged (1.6vw, 650). Below it, a
   single row replaces the old rates-line-then-sparkline stack:
   - Left: a fixed **240px (9.375vw)** column with the two rolling rates
     stacked vertically (`↑ 31.1M/hr` over `↑ 12.2M/10m`), 1.2vw, existing
     trend colors, no `·` separator. 240px fits the widest compact value
     (`↓ 999.9M/10m`). Bottom-aligned to the sparkline's baseline.
   - Right: the sparkline fills the remainder (~446px), **84px tall**.
     `SPARKLINE_VIEWBOX` (`app/src/token-usage.ts`) changes 436×80 →
     **446×84**; uniform matched-aspect scaling is retained so 2px strokes
     and the 20px `yda` label stay true. The `yda <total>` label (hardcoded
     in `rail.ts`'s sparkline block) moves to baseline y=48, right-anchored
     at x=444, clear of the yesterday line. Curve semantics
     (midnight-anchored day fraction, shared zero-based y-scale, fill,
     endpoint dot, yesterday-line gating) are unchanged.
   - Note: the d7 asset sizes the rates column to its content and draws the
     sparkline in a 460×84 box; the fixed 240px column and 446×84 box here
     are the normative geometry (visually equivalent, and stable as the
     rate values change width).
2. **Unread row** — text drops to **26px (1.016vw)**; dot, OFFLINE, amber
   active treatment, and count semantics unchanged.
3. **Quota panels** — the existing two-line meter contract is retained
   verbatim (head line: chip, label, binding tag pill, muted countdown then
   bright right-flush percent; 8px full-row-width bar on the headroom
   palette with 2px neutral ticks for non-binding windows). At the 760px
   rail the bars span ~650px — this is where the reclaimed space goes. The
   Claude two-account group (shared header, orange spine, indented account
   meters, muted micro-indices, active dot, per-account dimming, ambient
   fallback) is structurally unchanged.
4. **Pager dots** — unchanged.

### Explicit non-goals

- No third board column, no bottom bar (rejected variants B and C).
- No new card data. The remaining dead middle in 886px cards is a data
  problem (current tool call, what a waiting agent awaits); filling it needs
  daemon-side collection and is future work, out of scope here.
- No daemon, snapshot-schema, wire, or keypad-plugin changes. This is
  entirely an Agent Strip app change (`app/`), plus the strip-side card
  renderer in `app/src/cards.ts`.

## Implementation surface

- `app/styles.css` — strip/board/rail widths, tokens-block row, unread size,
  sparkline height. No changes to card status treatments beyond what the
  word removal makes moot.
- `app/src/rail.ts` — tokens section DOM (rates column + sparkline row).
- `app/src/token-usage.ts` — `SPARKLINE_VIEWBOX`.
- `app/src/cards.ts` — omit the status word for working/idle (the word is
  appended at the `card-status` row today; the timer stays).
- `docs/design.md` — Board and Rail sections updated to this contract.
- `test/strip-rail.test.ts`, `test/strip-cards.test.ts` — DOM-structure
  coverage, no CSS-value assertions:
  tokens row contains the rates column (two rate lines) and sparkline as
  siblings; working/idle cards have no status-word node while waiting/error
  do; the render-skip signature is unaffected (it already folds in tokens
  and status inputs).

## Verification gates

1. `bun run check` (Biome, both typechecks, builds, full suite).
2. `bun run build:app` + `bun run install:app`; relaunch Agent Strip.
3. Live capture: no scrollbar, rail sections spread with air, full-width
   bars, both Claude accounts legible, board 2×886 with no clipped cards.
4. Physical Xeneon approval from Drew — code/test success is not the visual
   gate.

No daemon reinstall is required; deployment is the app bundle only.
