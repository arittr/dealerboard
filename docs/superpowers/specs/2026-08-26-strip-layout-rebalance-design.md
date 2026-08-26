# Strip layout rebalance — wider rail, full-width quota bars, no scroll

Date: 2026-08-26
Status: Approved direction (mockup round); adversarially reviewed (two
independent read-only reviewers, findings incorporated below); spec pending
Drew's review
Approved mockup (contract of record): `assets/2026-08-26-strip-layout-rebalance/d7.html`
Predecessor contract: `assets/2026-08-25-strip-board/d6.html` (board card anatomy is unchanged from it except where stated)

## Problem

At 2560×720 with the two-account Claude group, the 600px rail's content
stack totals ~750px against the 720px window (measured with real system-font
line heights: tokens block ~207px including the sparkline's 14px margin and
intra-gaps, unread ~39px, Claude group ~160px, four provider meters ~204px
plus gaps, pager ~28px, padding and borders ~62px) — ~30px of overflow. The
body scrolls (a visible scrollbar on the strip), `space-between` has no
slack, and every rail section packs upward — the squish Drew flagged.
Meanwhile the board spends 966px per card on a title plus one meta line,
leaving a dead middle.

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
  states). This is a render change in `app/src/cards.ts` (the word span is
  not created; the separate timer span and the 1s `.cardtimer` ticker are
  untouched), not a CSS hide. The keypad plugin renderer is untouched.
  Head-row arithmetic is roughly neutral: at 886 without the word, a
  working/idle title gets ~697px (vs ~693 today at 966 with it); a waiting
  card keeps the bold word and loses the full 80px (~602px title room, ~5–6
  characters) — visible in d7 and accepted in the mockup round.
  - Edge case: a working/idle card whose `statusSince` is null/unparseable
    (old-daemon path) already renders no timer; with the word gone it shows
    a bare status dot. Accepted — the dot still carries the state, and
    current daemons always stamp `statusSince`.
- All other card anatomy (chip, unread corner dot, sub pill, meta line,
  badge, origin disc, edge/wash/breathe treatments) is unchanged from d6.

### Rail (760px, top to bottom)

Padding stays `6.111vh 3.5% 2.222vh` (44px top — 24px fullscreen — ~26.6px
sides at the new width); inner width ≈ 705px. The rail's vertical machinery
adopts the d7 asset's structure (this supersedes any flat/`space-between`
reading): the five quota sections move into one **quota zone** container
with `flex: 1; justify-content: space-evenly`, so the freed slack
concentrates between quota panels; the tokens block, unread (pinned ~20px
below the tokens block), and pager (small bottom margin) keep fixed
spacing. `renderRail` wraps the quota sections in the zone element — pure
DOM containment, no model or signature change.

Vertical budget (system-font line heights): the rebuilt tokens block
(~136–146px vs ~207) and the 26px unread (~30 vs ~39) free ~70–80px; with
today's two Claude accounts the stack totals ~670–680px, leaving **~40–50px
of slack**. A THIRD Claude account (+63px: one meter + stack gap) would
overflow 720 by ~14–24px — the rebalance does NOT absorb it. That is out of
scope and recorded as a known limit; the natural lever when it becomes real
is the sparkline row's height (each 12px there buys most of the gap), not
the quota rows.

1. **Token block** — `562.7M today` line unchanged (1.6vw, 650). Below it
   (10px margin), a single row replaces the old rates-then-sparkline stack:
   - Left: a fixed **240px (9.375vw)** column with the two rolling rates
     stacked vertically (`↑ 31.1M/hr` over `↑ 12.2M/10m`, 6px between),
     1.2vw, existing trend colors, no `·` separator. Bottom-aligned to the
     sparkline's box. Width check: the widest reachable string is the
     flat-trend `→ 999.9M/10m` at ~216px (B-suffix values reach ~223px;
     `formatTokensCompact` emits only k/M/B) — all under 240 with margin.
   - Right: separated by an **18px gap**, the sparkline fills the remainder
     (~447px), **84px tall**. In `app/src/token-usage.ts` the coupled
     geometry constants ALL change together: `SPARKLINE_VIEWBOX` 436×80 →
     **446×84**, `SPARKLINE_BASELINE_Y` 70 → **78**, `SPARKLINE_CURVE_SPAN`
     66 → **74** (curve band y∈[4,78], matching d7's drawn baseline).
     Changing only the viewbox would leave a 14px dead band and a shrunken
     curve. The fill polygon keeps production semantics and **closes at the
     baseline (y=78)** — the d7 asset's close at the box bottom (y=84) is a
     mockup artifact; the spec wins. `.rail-sparkline`'s `aspect-ratio`
     (styles.css) changes 436/80 → **446/84** in step, and its full-width
     sizing gives way to the flex-remainder row slot. Uniform
     matched-aspect scaling is retained so 2px strokes and the 20px `yda`
     label stay true. The `yda <total>` label (hardcoded in `rail.ts`'s
     sparkline block) moves to baseline y=48, right-anchored at x=444.
     Honest note: at y=48 the label clears the yesterday line for
     yesterday-≥-today data (the common case), but when today runs far
     ahead of yesterday the line's right end can pass through the label
     band — the old y=30 had the mirror-image collision zone, so this
     relocates rather than removes an existing data-dependent overlap.
     Remaining curve semantics (midnight-anchored day fraction, shared
     zero-based y-scale, endpoint dot, yesterday-line gating) are
     unchanged.
   - Degraded form: when the snapshot has no day curves the sparkline is
     absent and the row renders the rates column alone (row height from the
     rates); total + rates without curves matches today's behavior.
   - Note: the d7 asset sizes the rates column to its content and draws the
     sparkline in a 460×84 box; the fixed 240px column, 18px gap, and
     446×84 box here are the normative geometry (visually equivalent, and
     stable as the rate values change width).
2. **Unread row** — text drops to **26px (1.016vw)**; dot, OFFLINE, amber
   active treatment, and count semantics unchanged.
3. **Quota panels** (inside the zone) — the existing two-line meter contract
   is retained verbatim (head line: chip, label, binding tag pill, muted
   countdown then bright right-flush percent; 8px full-row-width bar on the
   headroom palette with 2px neutral ticks for non-binding windows). At the
   760px rail the bars span ~705px (~693px inside the Claude account
   stack's 12px indent) — this is where the reclaimed space goes. The
   Claude two-account group (shared header, orange spine, indented account
   meters, muted micro-indices, active dot, per-account dimming, ambient
   fallback) is structurally unchanged.
4. **Pager dots** — unchanged.

### Explicit non-goals

- No third board column, no bottom bar (rejected variants B and C).
- No new card data. The remaining dead middle in 886px cards is a data
  problem (current tool call, what a waiting agent awaits); filling it needs
  daemon-side collection and is future work, out of scope here.
- Fitting a third Claude account without scrolling (see the vertical budget
  above) — deferred until a third account exists.
- No daemon, snapshot-schema, wire, or keypad-plugin changes. This is
  entirely an Agent Strip app change (`app/`), plus the strip-side card
  renderer in `app/src/cards.ts`.

## Implementation surface

- `app/styles.css` — strip/board/rail widths; tokens-block row (240px rates
  column, 6px intra-gap, 18px column gap); unread size; `.rail-sparkline`
  aspect-ratio 446/84 and row-slot sizing; quota-zone flex rules. Update the
  stale geometry comments while there: "600px native rail" (`:17`), "two
  966px columns" (`:23–33`), "436x80-native box" (`:521–531`).
- `app/src/rail.ts` — tokens section DOM (rates column + sparkline row);
  quota-zone wrapper around the quota sections; `yda` label baseline; stale
  436×80 comments (`:110–111`, `:135`).
- `app/src/token-usage.ts` — `SPARKLINE_VIEWBOX`, `SPARKLINE_BASELINE_Y`,
  `SPARKLINE_CURVE_SPAN` (and the "436x80 / y=70" comments at `:182–196`).
- `app/src/cards.ts` — omit the status word span for working/idle (appended
  at the `card-status` row today; the timer span stays).
- `test/support/fake-dom.ts` — extend for card-DOM tests: `style` needs
  `setProperty` (working cards set `--wash-delay`) and elements need
  `remove()`; without this, rendering a working card in tests throws.
- `docs/design.md` — the affected subsections under "Strip app (Xeneon
  Edge)" are **Geometry** (600px rail / 966×102 columns), **Card anatomy**
  (status row gains the working/idle no-word rule; subagent width 922 →
  **842**; orphan full width 966 → 886), and **Rail** (600px header; rates
  "on one line" with the `·` separator → stacked column beside the
  sparkline; sparkline "below the rates … 436×80" → beside, 446×84; add the
  quota-zone distribution and 26px unread).
- Tests:
  - `test/strip-token-usage.test.ts` — the four geometry tests pinning
    436×80 (polyline points, fill closings at y=70, endpoint, viewbox
    equality) update to the 446×84 / baseline-78 / span-74 constants. These
    are the only existing tests this change breaks.
  - `test/strip-rail.test.ts` — new DOM tests for the tokens row (rates
    column with two rate lines and the sparkline as siblings; degraded
    no-sparkline form) — note the current fixtures all use
    `tokens: { state: "hidden" }`, so a visible-tokens fixture is new — and
    for the quota-zone wrapper containing the five quota sections.
  - `test/strip-cards.test.ts` — status-word coverage: working/idle cards
    render no status-word node, waiting/error do. Requires driving
    `renderBoard` against the extended fake DOM (no card-level builder is
    exported today) or exporting the card builder; either way the fake-dom
    extension above is a prerequisite.
  - No CSS-value assertions anywhere — geometry is proven on the device.
  - The render-skip signatures need no changes: both hash model data, not
    DOM shape (verified in review).

## Verification gates

1. `bun run check` (Biome, both typechecks, builds, full suite).
2. `bun run build:app` + `bun run install:app`; relaunch Agent Strip.
3. Live capture: no scrollbar, quota zone spread with air, full-width bars,
   both Claude accounts legible, board 2×886 with no clipped cards, tokens
   row (rates beside sparkline) rendering with real data.
4. Physical Xeneon approval from Drew — code/test success is not the visual
   gate.

No daemon reinstall is required; deployment is the app bundle only.

## Adversarial review record (2026-08-26)

Two independent read-only reviewers (geometry/arithmetic; code-contract)
attacked the first draft. Incorporated: the third-account headroom claim was
false (baseline ledger undercounted ~25px of line-height/margins) — retracted
and moved to non-goals; the sparkline's coupled baseline/span constants and
the styles.css aspect-ratio twin were unstated — now normative (78/74,
446/84); the fill-close ambiguity between spec and asset — resolved in the
spec's favor (baseline close); the rail's air-distribution machinery — d7's
quota-zone structure adopted as normative; the test plan was inverted
(listed two files with nothing failing, missed the one with four guaranteed
failures) — corrected, with the fake-dom prerequisite budgeted; bars
"~650px" → ~705px; the three unstated gaps (10/6/18) pinned. Claims that
survived attack: all horizontal geometry and conversions, the 240px rates
column against everything `formatTokensCompact` can emit, signature
stability, keypad-plugin isolation, pixel-free board reducer, no daemon
coupling.
