---
topic: 2026-08-27-board-card-retention
status: ratified             # draft | ready | ratified | paused | abandoned | completed
created: 2026-08-27
author-pool: kimi-code/k3    # the ratify cold-read must come from a DIFFERENT model family
---

# Board card retention: nothing leaves by being seen or by finishing

## Goal

Rewrite the board's card-clearing rules so that **reading a result and
finishing work never remove a card**. A card leaves the board only through
an explicit user act or a clock that started after the user viewed the
result. Six coordinated changes:

1. **View ≠ dismiss.** Tapping a card (app) clears only its unread badge
   and starts its expiry clock; the card stays. Dismissal becomes a
   separate, explicit gesture everywhere.
2. **Subagent roll-up.** Finished Paseo subagent results hold the
   *root ancestor's* card on the board with a result badge, instead of
   vanishing instantly (today's `!isPaseoSubagent` carve-out).
3. **Paseo views are inert.** The daemon's Paseo sync no longer clears
   board unread on passive views — including views performed by a parent
   agent consuming its own children. Paseo *archive* still clears.
4. **Viewed-based expiry.** Done/errored cards auto-dismiss 24h after
   being viewed (new `viewed_since` ledger). Unviewed results never
   expire. Weekend-safe by construction.
5. **Ended cards.** A native session that ends with an unviewed result
   keeps a terminal "ended" card under the normal rules instead of being
   hard-deleted.
6. **Causal gestures.** View/dismiss commands act only on the result the
   user actually saw: a result that lands after the snapshot the gesture
   was issued from is never consumed by it.

## Non-goals

- **No Stream Deck plugin changes.** `src/plugin/` and
  `com.drewritter.dealerboard.sdPlugin/` are untouched. The deck's key
  press keeps calling `sessions ack`, which retains dismiss semantics, so
  a press continues to view-and-dismiss exactly as today (without a
  causality watermark — deck presses are unconditional dismissals for
  now). Future work (documented only): short-press = view, long-press =
  dismiss.
- **No roll-up for native (provider-hook) child rows.** Native subagent
  rows are display-only, publish null ledgers, and still delete on
  `SubagentStop`; retaining them would pin the parent `working` forever
  (an idle native child promotes to effective working,
  projection.ts:96). The parent session's own `Stop` result carries the
  card. Roll-up applies only to Paseo-origin subagent rows.
- No change to how statuses are computed or stamped (Stop / StopFailure /
  Interrupt / SessionStatusObserved paths keep their semantics; the only
  stamp change is the missed-completion repair also stamping unread —
  R5).
- No new UI surfaces: no activity feed, no expandable subagent stacks, no
  per-subagent cards on the board.
- No change to Paseo archive *triggering* (archiving in Paseo still clears
  the card) or to the zcode 1-hour prune TTL (but prune now skips
  unviewed rows).
- No quota/token snapshot changes.

## The clearing contract

A root card is **visible** iff any hold:

- effective status is non-idle (`working` / `waiting` / `error`), or
- the row holds `done_since` or `unread_since`, or
- any descendant row (Paseo lineage, any depth) holds `done_since` or
  `unread_since` (roll-up).

A card leaves the board **only** via this exhaustive list:

| # | Path | Effect |
|---|------|--------|
| 1 | Dismiss gesture — app flick, app action-sheet "Dismiss", CLI `sessions ack`, Stream Deck key press (unchanged) | Clears `unread_since` + `done_since`, retires `error → idle`; cascades to descendant ledgers (Paseo lineage) |
| 2 | Manual clear — app "Clear session", CLI `sessions clear` / `clear-all` | Deletes the row and its descendants — native cascade **and** Paseo-linked descendant rows |
| 3 | Paseo archive | Clears the row's ledgers, retires error; cascades ledger-clear to descendants (rows remain until prune) |
| 4 | Reused `SessionStart` | Resets the row's own ledgers and `ended_at` ("a view and a new life"), as today |
| 5 | Viewed expiry — daemon sweep | `viewed_since` older than 24h on a done/errored row → auto-dismiss that row |
| 6 | Stale prune — 24h / 1h (zcode) whole-tree inactivity, daemon-scheduled and CLI `sessions prune` alike | Deletes rows, **skipping any tree containing an unviewed row** (`unread_since` non-null anywhere in the subtree) |

Explicitly **not** removal paths any more:

- Tapping/clicking a card in the app (view only).
- Viewing a session in Paseo (passive `requiresAttention` clearing no
  longer touches board ledgers).
- A parent agent viewing/closing its children in Paseo (same).
- A session settling to idle, finishing, or being a finished subagent.
- A native session ending while holding an unviewed result.

Unread drives the badge/styling channel: reading a result never removes
the card at view time, but the view starts the expiry clock — a viewed
done/errored card auto-dismisses 24h later — while an unviewed result is
exempt from SessionEnd deletion and the stale prune.
`done_since` (or `error` status) is what holds a finished card.

## State model changes

New schema version 17, two columns on `active_sessions`:

- `viewed_since TEXT NULL` — stamped when a dealerboard view gesture
  clears `unread_since`; the only input to the expiry clock. Null while
  unviewed.
- `ended_at TEXT NULL` — stamped when a `SessionEnd` retains the row as an
  "ended" card; cleared by a reused `SessionStart`.

Ledger invariants after this change:

- `unread_since` non-null ⇒ the row is unviewed ⇒ neither prune nor
  expiry may remove it. (`Stop` stamps unread+done together, so
  "unviewed" ⟺ `unread_since` non-null.)
- `done_since` holds visibility; `unread_since` only badges.
- **Only dealerboard view gestures stamp `viewed_since`.** Nothing in the
  Paseo overlay (attention flags, record writes, status repairs, archive)
  stamps it; no external evidence qualifies as "the user viewed this".
- **A newer result cancels the old view clock:** any event that stamps a
  fresh result (`Stop` stamping unread+done, `StopFailure` stamping
  unread, the missed-completion repair stamping unread+done) also clears
  `viewed_since` back to null. The card is unviewed again until the next
  view.
- `acked_at` is retained; it still guards Paseo re-stamps even though the
  passive-view path that motivated it is deleted.

## Requirements

- [ ] **R1 — View command.** New registry operation `viewSession`: clears
      `unread_since`, stamps `viewed_since`, leaves `done_since` and
      status untouched (viewing an `error` card keeps it `error`).
      Cascades to all done/unread descendants along Paseo lineage (each
      gets `unread_since` cleared and `viewed_since` stamped). Every view
      restamps `viewed_since` — repeated views restart the 24h clock.
  - Acceptance: viewing a done-and-unread card leaves it on the board
    with its badge cleared; `done_since` unchanged; re-viewing 23h later
    extends expiry to 24h from the second view.
- [ ] **R2 — Ack is dismiss.** `acknowledgeSession` keeps its current
      clearing semantics (clears unread+done, retires `error → idle`) and
      is now documented and wired purely as *dismiss*; it also cascades to
      descendant ledgers along Paseo lineage (clears their
      `unread_since`/`done_since`, does not delete rows).
  - Acceptance: dismissing a parent with two done children drops the whole
    subtree off the board on the next snapshot; child rows remain in the
    database.
- [ ] **R3 — App gestures.** `app/src/press.ts` tap calls a new
      `view_session` Tauri command (mirroring the `clear_session` wiring)
      instead of `ack`. Flick stays dismiss; `flickRemoves` gating widens
      to any card holding done/unread or in `error` (active
      working/waiting cards still can't be flicked away). Action sheet
      "Ack" relabeled "Dismiss", same ack command.
  - Acceptance: tapping a finished card keeps it on the board; flicking it
    removes it; the 5s local hide still applies only to the flick path.
- [ ] **R4 — CLI.** New `sessions view <provider> <id>` calling
      `viewSession`. `sessions ack` unchanged (dismiss), keeping the
      untouched Stream Deck plugin working as today.
  - Acceptance: `dealerboard sessions view …` on a done session clears its
    badge and leaves the card; `ack` removes it.
- [ ] **R5 — Paseo overlay changes.**
      (a) Delete the passive-view clearing path in `syncPaseoStates`
      (registry.ts:863-905: `requiresAttention` cleared → clear
      `unread_since`).
      (b) Archive handling keeps its freshness guards (stale archive
      records must not clear newer local news) and additionally cascades
      the ledger-clear to descendants along Paseo lineage; rows are not
      deleted.
      (c) The missed-completion settled-record repair now stamps
      `unread_since` alongside `done_since` (unless archived), so a
      repaired settlement badges the card instead of holding it silently.
      (d) Provider-session rotation / duplicate-origin-ref cleanup touches
      status only — it must never clear `unread_since`/`done_since`; a
      retired carrier holding results renders as its own root card per R7.
  - Acceptance: a Paseo record whose attention flag clears (whether by
    user or parent agent) leaves board ledgers untouched; archiving an
    orchestrator clears its card and its children's badges; a repaired
    completion shows up in the parent's `pendingResults`.
- [ ] **R6 — Roll-up visibility + badge.** `rootVisible` drops the
      `!isPaseoSubagent` carve-out: visibility = non-idle, or own
      done/unread, or any descendant (Paseo lineage, any depth — the roll
      goes to the root ancestor, the nearest *visible* card) holding
      done/unread. Snapshot root entries gain `pendingResults: number` —
      count of descendants with `unread_since` non-null — and a published
      root's effective `unreadSince` aggregates its own with its
      descendants', so the rail count and the (legacy) Stream Deck list
      stay coherent without double-counting hidden children. **Active**
      Paseo subagents keep their own actionable cards exactly as today;
      only the finished-idle behavior changes (hidden, result rolled up).
      Idle subagent cards never appear.
  - Acceptance: an idle parent with two finished idle subagents stays
    visible with `pendingResults: 2` and aggregated unread; viewing the
    parent clears the badge to 0 while the card persists (children's
    `done_since` still holds it); a running subagent still has its own
    card.
- [ ] **R7 — Fail-safe promotion.** A Paseo subagent row whose ancestry
      cannot resolve to a visible root — dangling `originParentRef`,
      cycle, malformed record, temporarily missing parent — is treated as
      a root by the projection and persists under the normal rules.
      "Cannot associate" never means "discard".
  - Acceptance: a done subagent whose parent row was deleted renders as
    its own card until dismissed/expired; a cyclic lineage still surfaces
    every result-bearing row.
- [ ] **R8 — Viewed-expiry sweep.** The daemon's existing 60s tick
      auto-dismisses every row where `viewed_since` is older than 24h
      **and** the row holds `done_since` or `error` status: clears
      `done_since` (+ any residual `unread_since`) and retires
      `error → idle`. Semantics: the clock runs from the *most recent*
      view; wall-clock time counts (daemon downtime and sleep included —
      expiry evaluates on the next tick after wake); `working`/`waiting`
      rows are never swept regardless of `viewed_since`; rows never
      viewed (`viewed_since` null) are never swept.
  - Acceptance: a done card viewed 24h+ ago disappears without any
    gesture; an unviewed done card of any age remains; a card that
    received a new result after the view (fresh `unread_since`,
    `viewed_since` cleared) remains.
- [ ] **R9 — Prune respects the unviewed.** `pruneStaleSessions` — whether
      invoked by the daemon's 60s schedule or by CLI `sessions prune` —
      skips any tree containing a row with `unread_since` non-null.
      TTLs otherwise unchanged (24h, 1h zcode). The operator's intentional
      purges are `sessions clear` / `clear-all` (and dismiss/archive),
      not prune.
  - Acceptance: a done-unviewed row older than 24h survives both the
    daemon prune and `sessions prune`; the same row viewed >24h ago is
    swept by R8 and then pruned normally.
- [ ] **R10 — Ended cards.** `SessionEnd` with `unread_since` set skips
      deletion: settles the row to idle, stamps `ended_at`, keeps
      done/unread. Without `unread_since`, deletes as today. A reused
      `SessionStart` clears `ended_at` (card revives in place). The
      handling is ordering-tolerant: a duplicate or late `SessionEnd` for
      an already-ended row is a no-op; a `SessionEnd` for an
      already-deleted row is a no-op; late events (e.g. a trailing
      `Stop`) on a retained row process normally and simply re-stamp. The
      app renders ended cards with an "ended" treatment and tapping one
      does not route anywhere.
  - Acceptance: ending a session with an unviewed result leaves an ended
    card that follows the normal contract (dismiss clears; viewing starts
    its 24h clock); ending a fully-viewed session deletes the row as
    today; SessionEnd → Stop → SessionEnd produces one ended card.
- [ ] **R11 — Causal gestures.** `viewSession` and `acknowledgeSession`
      accept an optional watermark (the `unread_since` value visible in
      the snapshot the gesture was issued from; the app passes it, the
      deck and bare CLI do not). The watermark identifies the newest
      *result* the user saw: a row is consumable iff its current
      `unread_since` is null or ≤ the watermark — consumption then clears
      the row's ledgers together. Auxiliary hold stamps never gate
      consumption: a `done_since` stamped later than its result's unread
      (the ended-card hold, R10) follows the result, and a viewed done
      card (unread already cleared) is consumable by the causal-null
      watermark that saw it. A result that lands after the snapshot
      re-stamps `unread_since` newer than the watermark and protects the
      whole row. Without a watermark the command is unconditional
      (operator/deck intent). View is non-destructive by construction
      (the card persists either way); the watermark is what makes dismiss
      safe.
  - Acceptance: flicking a card whose session produced a newer result
    after the last snapshot leaves the card on the board with the new
    result badged; the same flick with no newer result dismisses; a flick
    of a viewed done card carrying a causal-null watermark dismisses it;
    dismissing an ended card whose done hold postdates its unread
    consumes the whole card.

## Gesture × state matrix

| Card state | Tap | Flick / action-sheet Dismiss | Clear session | Paseo archive | Deck press (interim) |
|---|---|---|---|---|---|
| `working` / `waiting` | view only (clears stale badge; harmless) | not allowed | deletes subtree (native + Paseo-linked) | clears ledgers; active descendants still render (as orphan roots per R7) | dismiss (unconditional) |
| `error` | view: badge off, `viewed_since` stamped, status stays `error` | dismiss: retires `error → idle`, card gone | deletes subtree | clears ledgers, retires error | dismiss |
| done (idle, held) | view: badge off, 24h clock starts | dismiss: card gone | deletes subtree | clears ledgers | dismiss |
| ended (idle, `ended_at`) | view: badge off, clock starts; **no routing** | dismiss: card gone | deletes row | n/a (native-only path) | dismiss |

## Preserved invariants

These existing contracts must survive the change untouched:

- Status priority and subtree roll-up (`error > waiting > working >
  idle`) without restamping the parent's stored status/timers.
- Stable composite identity and logical slot assignment for cards.
- Native-child display-only behavior (null ledgers, delete on
  `SubagentStop`).
- Deterministic orphan-tail ordering for active unassociated rows.
- Paseo archive/attention freshness guards: stale overlay records never
  suppress newer local results; repeated sync passes are idempotent.
- Background-work liveness: a `Stop` with background work outstanding
  stamps no result; the 10-minute background settle grace is unchanged.

## Durability and boundedness

Rows holding unviewed results persist across app/daemon restarts (SQLite
is the source of truth), survive `SessionEnd` (R10), and are exempt from
prune (R9) and expiry (R8). There is **no cap** on how long or how many
unviewed results accumulate — that is the intended contract; the board
holds them until the user acts. The bounded-purge operations are:
dismiss (per card, cascades), `sessions clear` (per session),
`sessions clear-all` (everything), Paseo archive (per agent, cascades).
`sessions prune` is liveness cleanup, not a purge — it cannot remove
unviewed results.

## Edge cases

- **Viewing an active card** (working/waiting): harmless — clears any
  unread badge, stamps `viewed_since`; R8 ignores it until the card is
  done or errored.
- **Error cards:** `StopFailure` stamps unread only. View clears the
  badge; the `error` status holds the card until dismissed or the R8
  sweep retires it 24h after viewing. Unviewed errors persist
  indefinitely. A newer failure re-stamps unread and clears
  `viewed_since` (unviewed again).
- **Parent reuse with done children:** a reused parent `SessionStart`
  resets only the parent's own ledgers; children's done stamps survive
  and expire/archive on their own clocks.
- **View cascade timing:** viewing a parent stamps `viewed_since` on all
  done descendants at the same instant, so the whole subtree's 24h clocks
  run together and the R8 sweep releases the subtree as a unit.
- **Ended card + expiry:** viewing an ended card starts its 24h clock;
  the sweep dismisses it and prune deletes the row on its normal TTL.
- **Gesture races:** covered by R11 — a gesture only ever consumes the
  result the user saw; a newer result keeps the card alive and badged.
- **Parent archived with active descendants:** the parent's ledgers
  clear and its card goes; still-active children render as orphan roots
  (R7) and their eventual results persist as their own cards.
- **Sleep/wake and daemon downtime:** expiry and prune evaluate on the
  next tick using wall-clock time; a card viewed 23h ago whose laptop
  then sleeps 2h is swept on the first tick after wake. No grace period.
- **zcode:** no `SessionEnd` hook exists, so zcode rows still die only
  via prune — now subject to R9's unviewed skip, so unviewed zcode
  results survive past 1h until viewed+24h or dismissal.

## Documentation

- `docs/design.md` sections describing the subagent visibility carve-out
  ("Idle Paseo subagents are also hidden…", ~line 50-51) and the
  passive-view behavior must be rewritten to match this contract.
- `src/core/registry.ts` header comment (lines 12-34, the canonical
  ledger/done-ledger contract) must be rewritten: passive view no longer
  clears unread; view vs dismiss; roll-up; expiry; ended cards.

## Testing

Update the pinned behaviors in `test/projection.test.ts`,
`test/registry.test.ts`, `test/cli.test.ts`, `test/press.test.ts`,
`test/strip-dismissals.test.ts`, `test/daemon.test.ts`. New coverage:

- View doesn't dismiss (app + registry + CLI); view restamps
  `viewed_since`; cascades on view/dismiss.
- Viewed expiry and unviewed-never-expires; expiry after daemon
  downtime/sleep; active rows never swept; new result cancels the view
  clock.
- Prune skipping unviewed trees (daemon-scheduled and CLI alike).
- Roll-up visibility, `pendingResults` counts, aggregated root unread,
  active-subagent cards unchanged, nested-depth roll-up to root.
- Fail-safe promotion: dangling ref, cyclic lineage, parent deleted.
- Ended-card retention/revival/deletion; duplicate/late `SessionEnd`;
  late `Stop` on a retained row.
- Paseo passive view leaving ledgers untouched; archive cascade;
  freshness guards intact; repaired settlements badge.
- Causal gestures: watermark allows the seen result, protects a newer
  one; no-watermark remains unconditional.
- Rotation/duplicate-ref cleanup never clears ledgers.
- Daemon restart with unviewed results: everything still present.

## Out of scope (future)

- Stream Deck long-press dismiss + short-press view split (and giving
  deck gestures a causality watermark).
- Optional per-subagent decay window (individual subagent cards for a
  short window after finishing) if the roll-up badge proves too lossy.
