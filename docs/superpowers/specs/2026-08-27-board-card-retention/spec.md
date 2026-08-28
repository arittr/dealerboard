---
topic: 2026-08-27-board-card-retention
status: ready                # draft | ready | ratified | paused | abandoned | completed
created: 2026-08-27
author-pool: kimi-code/k3    # the ratify cold-read must come from a DIFFERENT model family
---

# Board card retention: nothing leaves by being seen or by finishing

## Goal

Rewrite the board's card-clearing rules so that **reading a result and
finishing work never remove a card**. A card leaves the board only through
an explicit user act or a clock that started after the user viewed the
result. Five coordinated changes:

1. **View ≠ dismiss.** Tapping a card (app) clears only its unread badge
   and starts its expiry clock; the card stays. Dismissal becomes a
   separate, explicit gesture everywhere.
2. **Subagent roll-up.** Finished Paseo subagent results hold the
   *parent's* card on the board with a result badge, instead of vanishing
   instantly (today's `!isPaseoSubagent` carve-out).
3. **Paseo views are inert.** The daemon's Paseo sync no longer clears
   board unread on passive views — including views performed by a parent
   agent consuming its own children. Paseo *archive* still clears.
4. **Viewed-based expiry.** Done/errored cards auto-dismiss 24h after
   being viewed (new `viewed_since` ledger). Unviewed results never
   expire. Weekend-safe by construction.
5. **Ended cards.** A native session that ends with an unviewed result
   keeps a terminal "ended" card under the normal rules instead of being
   hard-deleted.

## Non-goals

- **No Stream Deck plugin changes.** `src/plugin/` and
  `com.drewritter.dealerboard.sdPlugin/` are untouched. The deck's key
  press keeps calling `sessions ack`, which retains dismiss semantics, so
  a press continues to view-and-dismiss exactly as today. Future work
  (documented only): short-press = view, long-press = dismiss.
- No change to how statuses are computed or stamped (Stop / StopFailure /
  Interrupt / SessionStatusObserved paths keep their semantics).
- No new UI surfaces: no activity feed, no expandable subagent stacks, no
  per-subagent cards on the board.
- No change to Paseo archive semantics (archive still clears the card) or
  to the zcode 1-hour prune TTL (but prune now skips unviewed rows).
- No badge-count side channels, no changes to quota/token snapshots.

## The clearing contract

A root card is **visible** iff any hold:

- effective status is non-idle (`working` / `waiting` / `error`), or
- the row holds `done_since` or `unread_since`, or
- any descendant row holds `done_since` or `unread_since` (roll-up).

A card leaves the board **only** via this exhaustive list:

| # | Path | Effect |
|---|------|--------|
| 1 | Dismiss gesture — app flick, app action-sheet "Dismiss", CLI `sessions ack`, Stream Deck key press (unchanged) | Clears `unread_since` + `done_since`, retires `error → idle`; cascades to descendant ledgers |
| 2 | Manual clear — app "Clear session", CLI `sessions clear` / `clear-all` | Deletes row(s), as today |
| 3 | Paseo archive | Clears the card, as today |
| 4 | Reused `SessionStart` | Resets the row's own ledgers and `ended_at` ("a view and a new life"), as today |
| 5 | Viewed expiry — daemon sweep | `viewed_since` older than 24h → auto-dismiss (same effect as #1, no cascade needed: each row carries its own stamp) |
| 6 | Stale prune — 24h / 1h (zcode) whole-tree inactivity | Deletes rows, **now skipping any tree containing an unviewed row** (`unread_since` non-null anywhere in the subtree) |

Explicitly **not** removal paths any more:

- Tapping/clicking a card in the app (view only).
- Viewing a session in Paseo (passive `requiresAttention` clearing no
  longer touches board ledgers).
- A parent agent viewing/closing its children in Paseo (same).
- A session settling to idle, finishing, or being a finished subagent.
- A native session ending while holding an unviewed result.

Unread becomes purely cosmetic (badge/styling); it never gates removal.
`done_since` is what holds a finished card.

## State model changes

New schema version 17, two columns on `active_sessions`:

- `viewed_since TEXT NULL` — stamped when a view clears `unread_since`;
  the only input to the expiry clock. Null while unviewed.
- `ended_at TEXT NULL` — stamped when a `SessionEnd` retains the row as an
  "ended" card; cleared by a reused `SessionStart`.

Existing columns keep their meaning: `unread_since` (unviewed result
landed), `done_since` (undismissed result landed), `status_since`,
`acked_at` (retained; still guards Paseo re-stamps, though the
passive-view path that motivated it is deleted).

Ledger invariants after this change:

- `unread_since` non-null ⇒ the row is unviewed ⇒ neither prune nor
  expiry may remove it. (`Stop` stamps unread+done together, so
  "unviewed" ⟺ `unread_since` non-null.)
- `done_since` holds visibility; `unread_since` only badges.
- `viewed_since` is always ≥ the stamp of the view that cleared unread;
  expiry checks it only when the row is done or errored.

## Requirements

- [ ] **R1 — View command.** New registry operation `viewSession`: clears
      `unread_since`, stamps `viewed_since`, leaves `done_since` and
      status untouched. Cascades to all done/unread descendants (each gets
      `unread_since` cleared and `viewed_since` stamped).
  - Acceptance: viewing a done-and-unread card leaves it on the board
    with its badge cleared; `done_since` unchanged; an `error` card's
    status is unchanged by viewing.
- [ ] **R2 — Ack is dismiss.** `acknowledgeSession` keeps its current
      clearing semantics (clears unread+done, retires `error → idle`) and
      is now documented and wired purely as *dismiss*; it also cascades to
      descendant ledgers (clears their `unread_since`/`done_since`, does
      not delete rows).
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
- [ ] **R5 — Paseo views inert.** Delete the passive-view clearing path in
      `syncPaseoStates` (registry.ts:863-905: `requiresAttention` cleared
      → clear `unread_since`). Archive handling (clears unread+done,
      retires error) unchanged. Settled-record repair unchanged — its
      `done_since` stamp now feeds the roll-up.
  - Acceptance: a Paseo record whose attention flag clears (whether by
    user or parent agent) leaves board ledgers untouched; an archived
    record still clears the card.
- [ ] **R6 — Roll-up visibility + badge.** `rootVisible` drops the
      `!isPaseoSubagent` carve-out: visibility = non-idle, or own
      done/unread, or any descendant done/unread. Snapshot root entries
      gain `pendingResults: number` — count of descendants with
      `unread_since` non-null (unviewed results). Idle subagent cards
      themselves remain hidden (they are never roots; no per-subagent
      cards appear).
  - Acceptance: an idle parent with two finished idle subagents stays
    visible with `pendingResults: 2`; viewing the parent clears the badge
    to 0 while the card persists (children's `done_since` still holds it).
- [ ] **R7 — Orphan promotion.** A Paseo subagent row whose
      `originParentRef` no longer resolves to a row is treated as a root
      by the projection and persists under the normal rules.
  - Acceptance: a done subagent whose parent row was deleted renders as
    its own card until dismissed/expired.
- [ ] **R8 — Viewed-expiry sweep.** The daemon's existing 60s tick
      additionally auto-dismisses every row with `viewed_since` older than
      24h that holds `done_since` or non-idle `error` status: clears
      `done_since` (+ any residual `unread_since`) and retires
      `error → idle`. Rows never viewed (`viewed_since` null) are never
      swept.
  - Acceptance: a done card viewed 24h+ ago disappears without any
    gesture; an unviewed done card older than 24h remains.
- [ ] **R9 — Prune respects the unviewed.** `pruneStaleSessions` skips any
      tree containing a row with `unread_since` non-null (rows are never
      reaped while they hold unviewed results). TTLs otherwise unchanged
      (24h, 1h zcode).
  - Acceptance: a done-unviewed row older than 24h survives prune; the
    same row viewed >24h ago is swept by R8 and then pruned normally.
- [ ] **R10 — Ended cards.** `SessionEnd` with `unread_since` set skips
      deletion: settles the row to idle, stamps `ended_at`, keeps
      done/unread. Without `unread_since`, deletes as today. A reused
      `SessionStart` clears `ended_at` (card revives in place). The app
      renders ended cards with an "ended" treatment and tapping one does
      not route anywhere.
  - Acceptance: ending a session with an unviewed result leaves an ended
    card that follows the normal contract (dismiss clears; viewing starts
    its 24h clock); ending a fully-viewed session deletes the row as
    today.

## Edge cases

- **Viewing an active card** (working/waiting): harmless — clears any
  unread badge, stamps `viewed_since`; expiry (R8) ignores it until the
  card is done or errored.
- **Error cards:** `StopFailure` stamps unread only. View clears the
  badge; the `error` status holds the card until dismissed or the R8 sweep
  retires it 24h after viewing. Unviewed errors persist indefinitely.
- **Parent reuse with done children:** a reused parent `SessionStart`
  resets only the parent's own ledgers; children's done stamps survive and
  expire/archive on their own clocks.
- **View cascade timing:** viewing a parent stamps `viewed_since` on all
  done descendants at the same instant, so the whole subtree's 24h clocks
  run together and the R8 sweep releases the subtree as a unit.
- **Ended card + expiry:** viewing an ended card starts its 24h clock; the
  sweep dismisses it and prune deletes the row on its normal TTL.
- **zcode:** no `SessionEnd` hook exists, so zcode rows still die only via
  prune — now subject to R9's unviewed skip, so unviewed zcode results
  survive past 1h until viewed+24h or dismissal.

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
`test/strip-dismissals.test.ts`, `test/daemon.test.ts`. New coverage: view
doesn't dismiss (app + registry + CLI), cascade on view/dismiss, viewed
expiry and unviewed-never-expires, prune skipping unviewed trees, roll-up
visibility and `pendingResults` counts, orphan promotion, ended-card
retention/revival/deletion, Paseo passive view leaving ledgers untouched
while archive still clears.

## Out of scope (future)

- Stream Deck long-press dismiss + short-press view split.
- Optional per-subagent decay window (individual subagent cards for a
  short window after finishing) if the roll-up badge proves too lossy.
