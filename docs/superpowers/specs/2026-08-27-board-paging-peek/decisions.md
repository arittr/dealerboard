# Decision log — 2026-08-27-board-paging-peek

<!-- APPEND-ONLY. Never rewrite or delete entries. To reverse a settled
     decision, append a new entry titled "Supersedes: <old title>" or
     "Reopens: <old title>" with rationale — the newest entry wins. Gates:
     do not re-litigate settled decisions. -->

<!-- Entry format:

## <YYYY-MM-DD HH:MM> — <decision title>
- **Decided:** <what>
- **Rejected:** <alternatives ruled out, if any>
- **Because:** <rationale>
- **Deciders:** <who/what settled it: user | gate:<kind> | steering-session>

-->

<!-- Ratification receipt — REQUIRED before SDD handoff:

## <YYYY-MM-DD HH:MM> — Ratified
- **Commit:** <exact notebook commit hash ratified>
- **Cold-read:** <pool> — <gaps found, and how each was dispositioned>
- **Sign-off:** Drew — <verbatim approval or reference>

Any semantic edit to spec.md after this receipt voids it: flip status back
to ready and re-run the ratify gate. -->

<!-- Scribing note: these entries were batch-scribed at session close
     (2026-08-27 20:23) in decision order, not incrementally as landed.
     The visual record of the steering session is the machine-local
     mockup sequence under .superpowers/brainstorm/38658-1787880653/
     content/ (reflow-options, indicator-placement, peek-iterations,
     final-candidate). -->

## 2026-08-27 20:23 — Swipe zone is the slats; the status card is pinned
- **Decided:** The paging gesture lives on the board region only. The
  rail takes no gesture handlers, never translates, and gives no visual
  response to board drags.
- **Rejected:** Whole-strip swipe surface (the implicit status quo).
- **Because:** The rail is ambient state, not paged content — dragging it
  with the board misstates what pages; and a stable element under the
  hand anchors the drag visually.
- **Deciders:** user ("the swipable area right now is just the agent
  slats, not the status card. they should be separate")

## 2026-08-27 20:23 — Drag-follow with snap-back replaces release-time classification
- **Decided:** The board tracks the finger during a horizontal drag;
  release past ~25% of board width or a velocity flick commits the page
  turn, anything else animates back. Exact constants are tuned on
  device, gated on a pointer-event diagnostic (WKWebView touch delivery
  on the Xeneon is unverified for sustained drags).
- **Rejected:** Tuning the existing recognizer's thresholds (classify at
  pointer-up: |dx| ≥ 80px, |dy| ≤ 48px, no velocity term, zero feedback
  during the drag).
- **Because:** The kickoff complaint was as much illegibility as
  misclassification — with no drag feedback, a rejected swipe is
  indistinguishable from a dead gesture. Drag-follow makes every
  outcome visible and is self-teaching.
- **Deciders:** steering-session (user assented via the mechanics
  mockup)

## 2026-08-27 20:23 — Indicator budget: no reserved grid slots, no bottom chrome
- **Decided:** The page indicator may only spend horizontal width in the
  band between the slats and the status card. Nothing reserves a card
  slot, a bottom margin, or top clearance.
- **Rejected:** In-grid indicator card (occupies a slot when full);
  page-tab column (~150px rail squeeze — ruled out with it).
- **Because:** Vertical space and card slots are the scarce resources on
  a 720px strip; width is abundant.
- **Deciders:** user ("we cant take up a fixed bottom margin, so far A
  is the only real opt")

## 2026-08-27 20:23 — Horizontal paging retained; vertical rejected
- **Decided:** Pages remain side-by-side and the gesture stays
  horizontal, despite the pip column's vertical stack suggesting
  otherwise.
- **Rejected:** Vertical swipe/scroll paging.
- **Because:** Vertical is the scarce axis with both edges spoken for
  (menu-bar overlay above, zero margin below) — a vertical layout has no
  room for the peek, which is the design's load-bearing affordance;
  ~9cm of drag travel makes drag-follow twitchy; the 32:9 strip reads
  as a horizontal ribbon. Acknowledged cost: horizontal swipe stays
  claimed by paging, unavailable for future per-card gestures.
- **Deciders:** user (assented to the recorded recommendation)

## 2026-08-27 20:23 — Final indicator: bidirectional peek + pip column on constant geometry
- **Decided:** Compose A3 and A2 from the iteration round: a 14px return
  sliver in a constant 40px left gutter (present when pages exist
  behind), a 54px next-page peek at the board's right edge (row-aligned
  slivers, status colors, unread dots, continuous with the incoming
  page during a drag), and a 22px vertical pip column (one pip per
  page, current lit, amber/blue corner mini-dots, tap to jump). Rail
  narrows 760 → 638 native px and loses its pager dots.
- **Rejected:** Deck layers as the page-count cue (illegible past ~3
  pages, silent about pages behind); pure single-direction peek (blind
  to page count and to pages behind).
- **Because:** Every element reuses vocabulary the board already taught
  — amber = unread, blue = working, edges = "a page lives this way" —
  and the drag affordance is the same object as the indicator. Open
  on-glass checks (sliver and mini-dot sizes, rail fit) are recorded in
  the spec's open questions.
- **Deciders:** user ("i think this makes sense" → "sgtm")

## 2026-08-27 20:23 — Reflow: split groups larger than the remaining page space
- **Decided:** A group that does not fit the current page's remaining
  slots fills them and continues on the next page, its first continued
  card carrying a continuation marker. The kickoff scenario renders
  with no empty column.
- **Rejected:** Atomic groups + overflow signpost tile (redundant — the
  peek already announces the next page, continuously and with live
  status); compact 3-column grid (breaks fixed geometry and
  touch-target sizes).
- **Because:** The original argument for atomicity — a split group reads
  as disconnected — is answered by drag-follow plus the peek: the
  continuation is visibly pullable into view. Split threshold and
  marker form stay open as impl-details in the spec.
- **Deciders:** user ("no that sgtm" to the recorded recommendation)

## 2026-08-27 21:06 — Ratify-gate cold-read dispositioned (19 findings)
- **Decided:** Sol's cold-read (Paseo agent 9ada8f64, reviewer profile,
  reading problem.md + code pointers only) returned 19 findings; all
  dispositioned. Already covered by the spec as written: root-cause
  discipline partially (1 — diagnostic gates tuning), atomicity
  reversal (2), peek space source (4), announcement content (6), swipe
  definition (11), gesture start zone (13), failure feedback (14),
  completion evidence (19). Amended into the spec this pass:
  - (3) packing generalized: groups fill-and-continue in unchanged
    first-fit order, sequence-general, invariant "every page except
    the last is full";
  - (5) peek/return bands are page-level tap targets; sliver rows
    never individually interactive, never in card-index routing;
  - (7, 8) pip aggregates = OR of the page's cards' existing
    view-model bits from the current snapshot; no new persisted or
    historical page state;
  - (9) page identity = clamped numeric index; no per-page "seen"
    state exists;
  - (10) peek visibility is not viewing — unread/ack semantics
    unchanged;
  - (12, 13) axis-lock arbitration; sheet-open suppression;
    cancel/window-leave snaps back;
  - (14) single-page drags rubber-band (nowhere-to-go is visible);
  - (15) snapshots defer during an active drag, apply at settle;
  - (16) column-break spine behavior unchanged; continuation marker is
    page-break-only;
  - (17) degraded renders indicator from the same last-good snapshot
    as cards; paging stays available;
  - (18) pip hit areas get invisible slop to touch size; pips are
    secondary to the swipe; pip column accepted to ~8 pages, no
    overflow treatment (YAGNI);
  - (1) the bring-up diagnostic must localize the failing layer
    (delivery / recognition / navigation / render), not assume
    delivery.
- **Rejected:** No finding declined outright; none re-litigated settled
  decisions.
- **Because:** Every disposition either states the answer already
  implied by the settled design's logic (reuse of existing per-card
  semantics, YAGNI on new state) or records a contract the spec had
  left implicit. The findings list in the gate transcript is the
  record.
- **Deciders:** gate:ratify-cold-read (sol) + steering seat
  dispositions; user ratification pending

## 2026-08-27 21:41 — Cross-spec note: board-card-retention coexists
- **Decided:** Compatibility with the concurrently authored
  2026-08-27-board-card-retention notebook is verified, not assumed:
  its dismiss flick is vertical (gestures.ts FLICK_MIN_VERTICAL_PX,
  horizontal-bounded), this spec's paging drag is horizontal, and the
  axis-lock arbitration requirement here is the mechanism keeping them
  separate — it is load-bearing for both notebooks. Retention keeps
  more cards on the board, so page counts rise and this indicator
  carries more weight; the pip column's ~8-page comfort range absorbs
  that.
- **Because:** Two specs landing the same day both touch board gesture
  and card-population semantics; future readers of either should know
  the interaction was checked.
- **Deciders:** steering-session (user aware via sign-off exchange)

## 2026-08-27 21:41 — Ratified
- **Commit:** f6e0e0c
- **Cold-read:** sol (codex/gpt-5.6-sol, reviewer profile, Paseo agent
  9ada8f64) — 19 findings; 7 already covered by the spec as written,
  12 dispositioned by amendment in the entry above; none declined,
  none re-litigated settled decisions. The gate transcript's findings
  list is the record.
- **Sign-off:** Drew — "great, go ahead" (following "i think this makes
  sense" on the design and "no that sgtm" on the recorded
  recommendations), with the judgment-call dispositions — always-fill
  invariant, mid-drag snapshot deferral, index-based page identity,
  peek-not-viewing — explicitly surfaced and none vetoed.

Any semantic edit to spec.md after this receipt voids it: flip status
back to ready and re-run the ratify gate.

## 2026-08-27 23:33 — Plan-review two-bounce disposition
- **Decided:** Sol's second plan-review pass (Paseo agent 4c6389f7,
  codex/gpt-5.6-sol) remained NOT READY after verifying the first-pass
  resolutions. Seven first-pass findings were resolved; the remaining rail
  boundary issue and four newly exposed blockers were handled in the plan:
  `#paging-region` now excludes the rail, source payload freshness is kept
  ahead of deferral and local dismissal re-reduces through
  `resubmitLatest()`, a release-only failed drag carries a `drag-move`
  before snap-back, the long-press tick rejects locked drags independently
  of threshold ordering, and threshold-dependent tests derive from named
  constants. The two receipt advisories were also folded in.
- **Process:** The plan-review gate had rejected the same artifact twice, so
  the two-bounce rule closed the gate loop; no third review was fired. The
  steering seat completed the disposition conversationally against the
  ratified spec and current main. The spec itself was not edited, and the
  unratified retention plan was not part of this disposition.
- **Because:** The remaining findings were concrete plan defects, not reasons
  to change the settled design. The smallest fixes make the execution order,
  event boundary, deferred-snapshot ordering, failure feedback, tuning
  contract, and final-artifact receipt explicit.
- **Deciders:** Drew — "try again, we ran out of fable credits"; steering
  seat disposition under the two-bounce rule.

## 2026-08-28 23:54 — Return sliver grows to 24px on glass
- **Decided:** Grow the page-return sliver from 14px to 24px within the
  existing 40px left gutter. The transient previous-page placement follows
  the same 24px edge so drag-follow remains continuous. Keep the pip column
  and its 9px amber/blue mini-dots unchanged. Keep the existing status-edge
  alpha for this pass; the observed problem was insufficient card surface,
  not insufficient status-color contrast.
- **Because:** On the live two-page strip, the 14px cue read as detached
  status ticks rather than the edge of a card: its 8px status edge left only
  6px of card surface. At 24px the same status edge leaves 16px of card
  surface while consuming no additional layout space and shifting neither
  the board nor the 638px rail.
- **Evidence:** Live two-page inspection after the native-overscroll fix;
  paging worked in both directions, the rail fit, and the pip dots remained
  legible. Drew approved the 24px recommendation verbatim: "sure". A fresh
  install and on-glass re-check remain required before this item closes.
- **Deciders:** Drew + steering seat

## 2026-08-29 00:24 — Return cue grows to 32px and uses card surfaces
- **Supersedes:** The 2026-08-28 23:54 decision's 24px width and unchanged
  surface treatment. The 9px pip-mini decision remains unchanged.
- **Decided:** Grow the steady return cue and transient previous-page edge
  together from 24px to 32px inside the existing 40px gutter, leaving an 8px
  separation from the current board. Give primary return slivers the normal
  card surface (`#1c2430`) and sub slivers the existing quieter card surface
  (`#171e28`). Keep the 8px status edge and its hue/opacity, row alignment,
  pips, 9px mini-dots, card positions, and 638px rail unchanged. Peek-side
  slivers retain their current treatment.
- **Because:** The freshly installed 24px build was geometrically correct but
  still read mainly as detached status ticks on the physical strip. Added
  width alone did not make the dim surface legible. The chosen surfaces reuse
  existing card vocabulary rather than inventing a new color, while 32px
  shows 24px of surface and preserves 8px of gutter separation.
- **Evidence:** Drew's on-glass verdict: "we should show more ya its v faint";
  Drew approved the bounded 32px/brighter-surface design with "yes". A fresh
  review, install, and arm's-length re-check remain required.
- **Deciders:** Drew + steering seat

## 2026-08-29 00:41 — 32px return cue accepted on glass
- **Decided:** Accept the installed 32px return cue with normal/quiet card
  surfaces as the final legibility treatment. The return-cue user-decision is
  closed; no further width, surface, status-edge, pip, card-position, or rail
  change is authorized by this receipt.
- **Evidence:** Task 9c's one-file CSS change passed its Sol review, fresh
  repository checks, rebuild, reinstall, and an arm's-length inspection of
  the newly installed app on page 2. Drew's physical acceptance and shipment
  instruction was: "great ship it".
- **Boundary:** This receipt accepts the return cue and current installed
  geometry. It does not substitute for Task 10's condensed final-artifact
  smoke after the temporary diagnostic wiring is removed.
- **Deciders:** Drew
