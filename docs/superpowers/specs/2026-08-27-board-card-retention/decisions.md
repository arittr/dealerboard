# Decision log — 2026-08-27-board-card-retention

<!-- APPEND-ONLY. Never rewrite or delete entries. To reverse a settled
     decision, append a new entry titled "Supersedes: <old title>" or
     "Reopens: <old title>" with rationale — the newest entry wins. Gates:
     do not re-litigate settled decisions. -->

<!-- Ratification receipt — REQUIRED before SDD handoff:

## <YYYY-MM-DD HH:MM> — Ratified
- **Commit:** <exact notebook commit hash ratified>
- **Cold-read:** <pool> — <gaps found, and how each was dispositioned>
- **Sign-off:** Drew — <verbatim approval or reference>

Any semantic edit to spec.md after this receipt voids it: flip status back
to ready and re-run the ratify gate. -->

## 2026-08-27 — View clears the badge only; the card stays
- **Decided:** Tapping a card (app) clears `unread_since` and stamps the
  new `viewed_since`, but never removes the card. Read state becomes
  purely cosmetic; `done_since` is what holds a finished card.
- **Rejected:** View does nothing (badges would never clear); keep
  tap-to-open = dismiss (the literal "cleared when I look at it"
  complaint, press.ts:33-34).
- **Because:** the user's audit request identified viewing-as-dismissal as
  the core failure; separating view from dismiss is the foundation every
  other rule hangs on.
- **Deciders:** user

## 2026-08-27 — Subagent results roll up into the parent card
- **Decided:** Finished Paseo subagent cards stay hidden, but their
  done/unread stamps hold the parent's card visible with a
  `pendingResults` badge; viewing/dismissing the parent cascades to
  descendants; orphans (parent row gone) promote to root cards.
- **Rejected:** Subagent cards persist individually (user: "that will get
  cluttered"); persist until the parent consumes them (re-encodes the
  complaint — orchestrators consume within seconds, so cards would still
  evaporate before the user looks); decay window (kept as documented
  future bolt-on).
- **Because:** preserves the design doc's "results belong to the
  orchestrating parent" principle while making orchestrated work visible;
  zero added cards.
- **Deciders:** user

## 2026-08-27 — Paseo views never touch board state
- **Decided:** Delete the passive-view sync path (registry.ts:863-905);
  only Paseo archive, dealerboard gestures, session restart, or expiry
  clear board ledgers.
- **Rejected:** Keep current behavior (any Paseo view clears board
  unread).
- **Because:** Paseo's `requiresAttention` record cannot distinguish the
  user viewing from a parent agent consuming its children, so the middle
  option is unimplementable; under roll-up the badge must reflect what the
  *user* hasn't reviewed.
- **Deciders:** user

## 2026-08-27 — Expiry clock starts at viewing, never before
- **Decided:** Done/errored cards auto-dismiss 24h after being viewed
  (`viewed_since`); unviewed results never expire.
- **Rejected:** Flat 24h after done (user: "idk what about coming back
  after the weekend" — Friday's unviewed results would be gone Monday);
  flat 72h (long weekends still wipe); no expiry (board relies entirely on
  manual hygiene).
- **Because:** the board's job is to hold results until the user processes
  them; only seen results are safe to age out.
- **Deciders:** user

## 2026-08-27 — Session end keeps unviewed results as an ended card
- **Decided:** `SessionEnd` with an unviewed result retains the row as a
  terminal "ended" card (idle, `ended_at` stamped) under the normal
  contract; nothing unviewed → delete as today; reused `SessionStart`
  revives in place.
- **Rejected:** Always delete on end (loses unviewed results when a
  session closes before the user looks — another leak under the "never
  lose what I haven't seen" principle).
- **Deciders:** user

## 2026-08-27 — Stream Deck plugin untouched; long-press is future work
- **Decided:** No changes to `src/plugin/` or the sdPlugin. Deck key press
  keeps calling `sessions ack` = dismiss (today's behavior). Future:
  short-press = view, long-press = dismiss.
- **Because:** user: "long press dismisses but we also don't have to work
  on that codebase at all." Keeping `ack` = dismiss in the core is what
  lets the deck coast unchanged.
- **Deciders:** user

## 2026-08-27 21:24 — Ratify gate findings 1-25 dispositioned
- **Decided:** Cold-read by codex/gpt-5.6-sol (agent d7ced209, fast mode)
  returned 25 findings against problem.md + code. Dispositions:
  - **Already covered by the spec as written:** F2 (only dealerboard view
    gestures count as viewing — R5 deletes the Paseo passive-view path
    entirely, so the overlay's inability to prove a human view no longer
    matters; invariant added), F3 (ack keeps dismiss semantics so the
    untouched deck is unaffected — R2/R4), F7 (R6 defines the complete
    admission predicate), F13 (R7 orphan promotion covers parent-absent
    results; native cascade-delete-on-clear unchanged), F16 (gesture ×
    state matrix added to spec), F19 (error contract in spec edge cases,
    strengthened by the viewed-clock reset below), F21 (view is
    non-destructive by construction now, so tap-before-route ordering is
    harmless; dismiss safety is the causality guard, F5), F24 (preserved
    invariants section added), F25 (testing section extended with the
    race/ordering/restart/sleep/weekend cases).
  - **Folded into the spec (amendments):** F1 (R10 ordering tolerance:
    duplicate/late SessionEnd no-op, late Stop on a retained row
    re-stamps), F4 (R8 clock semantics: most-recent view restarts the
    clock, wall-clock incl. sleep, active rows never swept, and a new
    result clears `viewed_since` — unviewed again), F5 (R11 causal
    gestures: optional unread-stamp watermark; deck/bare CLI
    unconditional), F6 (R9: CLI `sessions prune` follows the same
    unviewed-skip rule; clear/clear-all are the only purges), F8/F11 (R6:
    roll-up targets the root ancestor at any depth; published root unread
    aggregates descendants'), F10 (R6: active subagents keep their own
    cards — only finished-idle behavior changes), F14 (R7 extended to
    cycles/malformed/unresolvable ancestry), F15 (clear/delete now follows
    Paseo lineage as well as native), F17 (archive cascades ledger-clear
    to descendants; freshness guards kept), F18 (rotation/duplicate-ref
    cleanup touches status only, never ledgers), F20 (missed-completion
    repair now stamps unread+done so repaired settlements badge), F22 (R6:
    aggregated root unread keeps rail/deck counts coherent), F23
    (durability/boundedness section: no cap on unviewed accumulation;
    prune is cleanup, not purge).
  - **Rejected / out of scope:** F8/F9/F12 partially — native
    (provider-hook) child rows are excluded from roll-up (display-only,
    delete on SubagentStop; retaining them would pin the parent `working`
    forever since idle native children promote to effective working). The
    parent session's own Stop result carries the card; no new outcome
    vocabulary for child completions (roll-up follows the existing stamp
    semantics — YAGNI).
- **Because:** the gate's findings list is the record; each finding was
  checked against the spec and either found covered, folded in, or ruled
  out with rationale.
- **Deciders:** steering-session; ratification sign-off reserved for user

## 2026-08-27 21:24 — Causal gestures (from gate F5)
- **Decided:** View and dismiss accept an optional watermark (the
  `unread_since` stamp visible in the snapshot acted upon); clears apply
  only to stamps ≤ the watermark. No watermark = unconditional (operator
  CLI, deck press). A result that lands after the snapshot survives the
  gesture.
- **Rejected:** Binding gestures to routing success instead (routing
  failures are about the destination, not the result); making all
  gestures unconditional (today's bug: a flick can consume a result that
  landed after render).
- **Because:** fire-and-forget gestures carrying only (provider, id)
  otherwise let a delayed dismissal eat a result the user never saw —
  the same failure class the whole redesign exists to kill.
- **Deciders:** steering-session (gate finding accepted)

## 2026-08-27 21:24 — Expiry clock semantics (from gate F4)
- **Decided:** The 24h clock runs from the most recent view; wall-clock
  time counts including sleep/daemon downtime (evaluated on the next
  60s tick); only done/errored rows are swept, never working/waiting;
  any newer result clears `viewed_since`, making the card unviewed again.
- **Because:** without these clauses the "24h after viewing" rule is
  ambiguous in exactly the situations the redesign must be safe in
  (weekends, laptop sleep, rapid successive results).
- **Deciders:** steering-session (gate finding accepted)

## 2026-08-27 21:24 — Lineage-aware destructive ops (from gate F15/F17)
- **Decided:** Manual clear (`sessions clear`, app "Clear session")
  deletes Paseo-linked descendants as well as native ones; Paseo archive
  and dismiss cascade ledger-clears along Paseo lineage. Prune follows
  the same unviewed-skip rule whether daemon-scheduled or CLI-invoked.
- **Rejected:** Leaving destructive ops native-topology-only (clearing an
  orchestrator would orphan its children's rows into surprise root
  cards); letting CLI prune bypass the unviewed skip (an operator alias
  for the daemon bug).
- **Because:** group-level retention must behave consistently across both
  lineage systems; "cannot associate" never means "discard", and an
  explicit subtree clear should mean the whole subtree.
- **Deciders:** steering-session (gate findings accepted)

## 2026-08-27 21:26 — Ratified
- **Commit:** 5d71f23
- **Cold-read:** codex/gpt-5.6-sol, one round (agent d7ced209, fast mode)
  — 25 findings: 9 already covered by the spec as written, 14 folded in
  as amendments (R10 ordering tolerance; R8 clock semantics + new-result
  clock reset; R11 causal gestures; R9 CLI-prune skip; R6 root-ancestor
  roll-up, aggregated root unread, active-subagent carve-out; R7
  fail-safe promotion for unresolvable ancestry; lineage-aware
  clear/archive; rotation never clears ledgers; repair settlements badge;
  durability/boundedness; preserved invariants), 1 rejected
  (native-child roll-up — the native parts of F8/F12). Per-finding
  dispositions in the "Ratify gate findings 1-25 dispositioned" entry.
- **Sign-off:** Drew — "Ratify, then plan" (2026-08-27, in response to
  "Ratify the amended notebook and move to the implementation plan?")

## 2026-08-28 — Plan review round 2: NOT READY; two-bounce reached; steering seat takes over
- **Decided:** Sol's round-2 review (agent 1e3392da, on plan commit
  54d8044) returned 13 resolved, 7 reopened (F1, F2, F8, F9, F12, F16,
  F18), and 11 new findings (N1–N11). Two plan-review rejections =
  two-bounce: gating stops per the standing rule (never loop gates); the
  steering seat resolved all 18 remaining findings conversationally,
  editing the plan directly. Resolutions:
  - F1 + N1 merged into one semantic fix (spec R11 amended — see below):
    the causal guard keys on the result's identity stamp (`unread_since`),
    never on the auxiliary `done_since` hold; consumption clears the
    row's ledgers together. This fixed Task 3's SQL (33 placeholders → 6)
    and Task 12's unwrapped watermarks, and added the viewed-done-card
    and ended-card causal-dismiss tests (Tasks 3–4).
  - F2: watermark capture moved to pointer-down via a new pure seam,
    `app/src/gesture-target.ts` (`capturePendingPress`), unit-tested
    including the ingest-mid-stroke case; `flickAway` consumes
    `pending.watermark`. (The `flickAway` consumption line itself is main.ts
    DOM glue, untestable under bun per house style — the capture contract
    is what's pinned.)
  - F8 + F9 + N5: prune rebuilt as an in-memory connected-component keep
    set (native + resolved Paseo edges, undirected) — no DDL (the daemon
    connection forbids it), normalized resolver input matching the
    projection, whole-component retention with sibling/descendant/live-
    child tests.
  - F12 + N10: action-sheet Dismiss gated by the shared `flickRemoves`
    predicate with matrix tests; the `flickRemoves` expression itself is
    unchanged (the appended tests are marked regression pins — the claimed
    red was impossible, Sol was right).
  - F16 + N9: Task 8 reordered — protocol AND projection tests (incl. the
    :108 exact literal) write and run red before any producer change.
  - F18: Task 13 enumerates all four PlacedCard/seed factories (incl. the
    new strip-gesture-target factory).
  - N2: Task 9 publishes aggregated `doneSince` alongside aggregated
    `unreadSince`, so a roll-up-held parent is flickable.
  - N3: fresh Paseo flags that land an unread stamp clear `viewed_since`
    (Task 5), and the sweep defensively excludes unread rows (Task 7).
  - N4: roll-up aggregation stops at descendants that publish their own
    card (active subagents, fail-safe roots) — no rail double-count;
    nested-depth tests added.
  - N6: the stale-archive test now expects the parent's origin unstamp
    (a counted change) while asserting the newer child ledgers survive.
  - N7: Task 5's projection integration test is listed in its red/green
    runs and commit.
  - N8: the expiry daemon test stops the daemon, advances past 24h, and
    starts a fresh daemon — wall-clock expiry across downtime.
  - N11: Task 14's registry header lists every clearing path (incl.
    archive, sweep, manual clear); the design-doc Interaction text
    excludes active cards from flick.
- **Because:** the reviewer's findings were verified against the plan and
  code; the two-bounce rule assigns resolution to the steering seat
  instead of a third gate round.
- **Deciders:** steering-session (kimi/k3)

## 2026-08-28 — Consistency repair: R11 keys consumption on the result identity (FLAGGED for Drew)
- **Decided:** Spec R11 amended post-ratification: causal consumption keys
  on the row's `unread_since` (the result's identity stamp) rather than
  comparing each stamp to the watermark. The ratified text ("clears only
  stamps ≤ its stamp") would have made an ended card's `done_since` hold
  (stamped at SessionEnd, later than its unread) unconsumable by the flick
  that saw the card — contradicting R10's own contract. This is a
  consistency repair inside the ratified intent ("a newer result survives
  the gesture"), not a reversal: no requirement's acceptance behavior
  changes except that the ended-card and viewed-done-card dismissals now
  work at all. FLAGGED: if this reading is wrong, it's a one-paragraph
  spec change plus Task 3's SQL.
- **Because:** the ledger invariant already names `unread_since` non-null
  ⟺ unviewed; the result's identity is its unread stamp, and auxiliary
  holds (`done_since` at SessionEnd) exist only to hold the card for that
  result.
- **Deciders:** steering-session under the two-bounce takeover; flagged
  for Drew's review at run close

## 2026-08-28 — Supersedes: acked_at advances to the exact consumed stamp
- **Decided:** `acked_at` now advances to the GESTURE instant whenever a
  view/dismiss consumes anything (and stays put when nothing was
  consumed). This supersedes the plan-review F3 disposition (consumed
  stamp) — Qwen's final review demonstrated empirically that Paseo stamps
  attention for a turn-end ~350ms after the local Stop, so a consumed-stamp
  `acked_at` let the trailing flag resurrect just-viewed/dismissed cards on
  the next sync (the exact complaint family this redesign exists to kill).
  Gesture-time is safe because acked_at suppression never clears local
  state (the watermark protects in-transit results) and the gesture
  instant can only postdate what the user saw.
- **Deciders:** user (final-review adjudication, Qwen I2)

## 2026-08-28 — Final-review dispositions (consistency repairs, flagged for Drew)
- **Decided:** The dual final review (Sol + Qwen, both "with fixes")
  produced five findings, all fixed in one consolidated wave
  (1f0af9a..f425b13) and verified by scoped re-review:
  1. Prune now also protects rows holding a live view clock (Sol C1) —
     spec R9 + contract row 6 amended: the ratified R8 promise ("24h after
     viewing") was silently defeasible by prune; the amendment is a
     consistency repair of the R8/R9 seam, not a new rule.
  2. A landing Paseo attention flag also stamps `done_since` (Sol I1) —
     spec R5 gained item (e); a flag-only idle card no longer vanishes on
     view.
  3. acked_at → gesture time (Supersedes entry above).
  4. Tap/sheet paths consume the pointer-down watermark capture (Sol I2 +
     Qwen I1) — implementation gap against ratified R11, no spec text
     change needed.
  5. Rejected flicks un-hide on newer news (Sol I3) — same.
  Qwen's three minors: M1 (ended-card prune interaction) was subsumed by
  fix 1; M2 (R6 wording) folded in — visibility propagates to the root
  ancestor, facts aggregate to the nearest self-publishing card; M3
  (stray blank line) folded in. Sol triaged all six task-level deferred
  minors safe-to-defer; #5 (gesture-target comment) became true under
  fix 4.
- **Because:** the whole point of the run — nothing leaves by being seen
  or by finishing — had five seam-level leaks the per-task gates could
  not see; the final whole-branch review was the net that caught them.
- **Deciders:** steering-session under the two-bounce takeover; the one
  settled-decision reversal (acked_at) is the user's ruling above.

## 2026-08-28 — Run closed: merged to main
- **Decided:** Drew ordered the merge ("Merge to main locally"); the branch
  fast-forwarded (1b40c01..5b95be8) and the merged result ran green (1217
  tests, 0 fail; full gate + cargo). Spec status flips to completed. SDD
  run row already in ~/.agents/run-ledger.md.
- **Deciders:** user

## 2026-09-01 — Supersedes: Session end keeps unviewed results as an ended card

- **Decided:** An authoritative tab/session close or archive removes its
  Dealerboard slat and descendants immediately, even when the tree holds
  unread or failed results. Provider `SessionEnd`, Paseo `archivedAt`, and
  Evener's archived navigation tier are terminal lifecycle evidence. `Stop`
  and turn completion are not terminal: they retain finished results under
  the existing view, dismiss, and expiry contract.
- **Decided:** Evener reads navigation locations by canonical
  `local:<sessionId>` root identity and refreshes immediately on
  `evener/navigation/invalidated`. Idle is never inferred to mean closed.
  Harnesses without a close/archive signal retain their stale-session TTL,
  and maintenance removes legacy rows carrying `ended_at`.
- **Rejected:** Retaining an unread ended card after the harness says the
  session is gone; inferring closure from idle or turn completion.
- **Because:** Dealerboard is a live status surface. A slat must reflect an
  extant tab/session, while a completed turn inside an extant session still
  needs to hold its result for review.
- **Deciders:** user ("always drop the slat if the tab/session is closed or
  archived in any harness")
