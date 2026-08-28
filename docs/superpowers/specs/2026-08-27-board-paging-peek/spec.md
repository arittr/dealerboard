---
topic: 2026-08-27-board-paging-peek
status: ready            # draft | ready | ratified | paused | abandoned | completed
created: 2026-08-27
author-pool: claude-paseo   # the ratify cold-read must come from a DIFFERENT model family
---

# Board paging: scoped drag-follow swipe, bidirectional peek, page pips, group splitting

## Goal

Make the strip's board paging legible and touch-native. Four coordinated
changes: (1) the swipe gesture becomes a drag-follow — the board tracks the
finger and either commits the page turn or visibly snaps back — and is
scoped to the slats only, with the status rail pinned; (2) the next page
physically peeks in at the board's right edge as clipped card slivers
carrying live status color and unread dots; (3) a vertical pip column
between the peek and the rail maps every page — position, unread, activity
— and jumps on tap; (4) board packing splits groups larger than a page's
remaining space instead of stranding a blank column. All indicator cost is
paid horizontally (the rail narrows 760 → 638 native px); no vertical
space is reserved anywhere.

## Non-goals

- No vertical paging or continuous scroll — pages stay discrete and
  horizontal.
- No change to card anatomy, status semantics, or the liveness/decay
  system.
- No rail content redesign beyond absorbing the width reduction; the
  rail's pager dots are removed, not restyled.
- No keypad/tile-surface changes — this is strip-only.
- No repacking of non-group cards beyond what splitting requires; packing
  order semantics otherwise unchanged.

## Requirements

- [ ] Requirement: Swipe zone is the board region only.
  - Acceptance: a drag beginning over the rail never pages and never
    moves the rail; a drag beginning over the board pages regardless of
    which card or blank space it starts on.
- [ ] Requirement: Drag-follow paging with snap-back.
  - Acceptance: during a horizontal drag the current page translates with
    the finger and the adjacent page enters from the corresponding edge;
    release past the commit threshold (~25% of board width, or a
    velocity flick — exact values tuned on device) completes the turn,
    any other release animates back to rest. A failed swipe is visible
    as motion-and-return, never a silent no-op.
- [ ] Requirement: Constant geometry across pages and states.
  - Acceptance: the board's left gutter is 40px native (was 16) on every
    page, whether or not the return sliver is present; cards never shift
    position when indicator elements appear or disappear.
- [ ] Requirement: Return sliver (left edge).
  - Acceptance: when a page exists behind the current one, its cards
    nearest the shared edge (rightmost occupied column) render as 14px
    row-aligned slivers in the left gutter — surface plus faint status
    edge color; absent on page 1, where the empty gutter itself means
    "at the start".
- [ ] Requirement: Next-page peek (right edge).
  - Acceptance: when a next page exists, its leftmost column renders as
    54px row-aligned slivers between the board and the pip column —
    dimmed card surface (sub vs primary surfaces distinguished), status
    edge color per row, unread corner dot per row. Absent on the last
    page. During a drag the peek is continuous with the incoming page —
    the sliver grows into the real card under the finger.
- [ ] Requirement: Pip column.
  - Acceptance: a 22px vertical band between peek and rail shows one pip
    per page, top = page 1, vertically centered; the current page's pip
    is enlarged and lit; every other pip carries at most one corner
    mini-dot — amber if that page holds unread, else blue if any session
    there is working, else none. The current pip carries no mini-dot
    (the board itself shows its own state). Tapping a pip jumps to that
    page. Hidden entirely when only one page exists.
- [ ] Requirement: Rail narrows to 638px native.
  - Acceptance: rail content (tokens, sparkline, unread line, quota
    meters) renders without wrapping or clipping at 638px, including the
    longest realistic quota note beside its percent; `.rail-pager` and
    `.page-dot` are deleted.
- [ ] Requirement: Split large groups.
  - Acceptance: a group larger than the current page's remaining slots
    fills them and continues on the next page with a continuation
    marker on its first continued card; the kickoff scenario (five
    singles + a nine-card group) renders with no empty column on
    page 1.

## Constraints

- Fixed card geometry is inviolable: 886×102 native cards, 12px gaps,
  6 rows; cards never flex-resize.
- No reserved vertical space: nothing informational above the 44px
  menu-bar clearance or below row six.
- Indicator vocabulary reuses the board's existing status hues (working
  #20b8ff, idle #4ade80, waiting/unread #ffb020, error #ff4d67) — no new
  colors, no text labels in the bands.
- The rail is outside the gesture system entirely — no handlers, no
  translation, no visual response to board drags.
- WKWebView touch delivery on the Xeneon is unverified for sustained
  drags (the contextmenu-synthesis workaround in main.ts proves the OS
  interposes on touch). An on-device pointer-event diagnostic gates
  gesture threshold tuning.

## Alternatives considered

- Alternative: in-grid indicator card (a card-shaped pager occupying a
  grid slot).
  - Rejected because: consumes a session slot when the board is full and
    reserves a fixed position; the user ruled out reserved slots and
    bottom chrome outright.
- Alternative: page-tab column (card-like per-page tabs with micro-maps
  between board and rail).
  - Rejected because: ~150px of rail width for information the 22px pip
    column carries; heaviest chrome of the candidates.
- Alternative: overflow signpost tile in the dead column (from the reflow
  round).
  - Rejected because: redundant once the peek exists — the peek says
    what's on the next page continuously and with live status, not only
    when a column happens to be empty.
- Alternative: compact 3-column grid to fit everything on one page.
  - Rejected because: breaks the fixed card geometry and shrinks touch
    targets and text below strip-legible sizes.
- Alternative: vertical paging (suggested by the pip column's vertical
  stack).
  - Rejected because: vertical is the scarce axis and both its edges are
    already spoken for (menu-bar overlay above, zero margin below), so a
    vertical layout has no room for the peek — the load-bearing
    affordance; ~9cm of drag travel makes drag-follow twitchy; the 32:9
    strip physically reads as a horizontal ribbon. Acknowledged cost:
    horizontal swipe stays claimed by paging and is unavailable for
    future per-card gestures.
- Alternative: deck layers (each page past the next adds a thinner sliver
  layer) for page count.
  - Rejected because: layer-counting stops working past ~3 pages and
    says nothing about pages behind you; the pip column carries count,
    direction, and per-page state explicitly. Could be revisited as a
    purely decorative depth cue if the pips prove illegible on glass.

## Open questions

- Do the 14px return sliver and 9px pip mini-dots register at arm's
  length on the physical strip, or do they need to grow (mini-dots to
  12–14px)? — tag: user-decides (on-glass check during bring-up)
- Does WKWebView deliver a reliable pointer-move stream during sustained
  touch drags on the Xeneon? If not, drag-follow degrades and the
  gesture design must be revisited. — tag: impl-detail (diagnostic
  first; it gates threshold tuning)
- Exact commit threshold values (fraction of width, velocity constant,
  rubber-band resistance at the ends). — tag: impl-detail (tuned on
  device)
- Minimum remaining slots worth splitting a group into (splitting a
  group to place one card may read worse than leaving the gap). — tag:
  impl-detail
- Continuation marker form on a split group's first continued card (the
  mockups show an "↩ cont." tag; a spine-only treatment is plausible).
  — tag: impl-detail (default to the mockup's tag)
- Does the longest realistic quota note fit at 638px, or does the rail
  need note abbreviation? — tag: impl-detail (measure before committing
  the width)

## Assumptions

- Realistic page counts stay small (≤4); the pip column's vertical
  centering has ample room at any plausible count.
- Board pages remain full replacements (no partially-scrolled rest
  states).
- The visual-companion mockups under
  `.superpowers/brainstorm/38658-1787880653/content/` (machine-local,
  gitignored) are the visual reference: `final-candidate.html` is the
  ratifiable design; `indicator-placement.html` and
  `peek-iterations.html` record the explored alternatives.

## Edge cases considered

- Single page: no peek, no return sliver, no pip column; the 40px gutter
  remains (constant geometry).
- Current page disappears (sessions end while viewing a later page):
  page index clamps to the last page; indicator re-renders.
- Drag past the first or last page: rubber-band resistance, snap back.
- Unread on the current page: shown by the card itself; the current pip
  stays clean.
- Degraded/OFFLINE board: indicator elements hidden along with cards.
- A split group whose parent card lands as the last slot of a page: the
  continuation marker carries the group identity onto the next page.

## Out of scope (with reasons)

- Keypad/tile surface — reason: different display with no paging.
- Auto-balancing sessions across pages — reason: packing order is
  meaningful (groups, arrival); balancing would shuffle it. YAGNI.
- Per-card horizontal gestures (dismiss, archive) — reason: horizontal
  swipe is now claimed by paging; revisit only with a new gesture budget.

## Golden-question checklist

- [x] Data migration / existing-data impact: N/A — pure UI change; no
  protocol, schema, or persisted-state changes.
- [x] Auth / permissions: N/A — local display app, no new capabilities.
- [x] Failure / retry behavior: gesture failure is snap-back (visible by
  design); degraded/OFFLINE handling unchanged; no network surface.
- [x] Rollback path: revert the commits; no migrations or persisted
  state to unwind.
- [x] Observability / logging: on-device pointer-event diagnostic during
  bring-up (removable after threshold tuning); no permanent logging
  added.
- [x] Physical-display legibility (project-specific): on-glass
  acceptance pass required before completion — return sliver and
  mini-dot visibility at arm's length, rail fit at 638px — mirroring
  the prior notebook's physical-strip receipt.
