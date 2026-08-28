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
