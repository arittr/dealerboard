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
