---
topic: 2026-08-27-quota-account-staleness
status: ready            # draft | ready | ratified | paused | abandoned | completed
created: 2026-08-27
author-pool: claude-seat2   # the ratify cold-read must come from a DIFFERENT model family
---

# Per-account quota staleness keyed to the timestamp each layer owns

## Goal

Stop the Claude account rows in the strip's quota group from dimming during
normal operation. Replace the single 6-minute age check — calibrated to
dealerboard's own 120s collector but applied to cswap's probe timestamps —
with a two-layer model where each layer's staleness keys off a timestamp
that layer's collector actually owns: the group dims when dealerboard's
collector goes quiet, an account row dims when cswap reports it cannot
fetch.

## Non-goals

- No change to ungrouped provider panels (codex, kimi, zai, qwen): their
  `fetchedAt` genuinely is dealerboard's collector timestamp and the
  existing `STALE_QUOTA_AGE_MS` semantics are correct for them.
- No upstream cswap changes and no reading of cswap's private cache
  (`~/.claude-swap-backup/cache/usage.json`).
- No change to quota collection cadence or the collector itself.
- No redesign of the account rows' layout, marker, or note text beyond what
  the state model requires.

## Requirements

- [ ] Requirement: the grouped Claude section carries the ambient panel
      state, like ungrouped providers do.
  - Acceptance: when the ambient claude `fetchedAt` exceeds
    `STALE_QUOTA_AGE_MS` (or the provider is unavailable), the grouped
    section renders `data-state` accordingly and the whole group dims;
    today `rail.ts` sets `data-state` only in the non-grouped branch.
- [ ] Requirement: an account row's state ignores reading age.
  - Acceptance: an account with `unavailable: false` renders state "ok"
    regardless of how old its `fetchedAt` is; the existing per-account
    stale dimming (opacity 0.45 at >6 min) no longer occurs.
- [ ] Requirement: an account row dims exactly when cswap says its data is
      not good.
  - Acceptance: `usageStatus != "ok"` (mapped today to `unavailable: true`
    by `claude-swap-quota.ts`) renders the row dimmed with the existing
    "Xm/Xh+ old" age note; `usageStatus == "ok"` renders bright.

## Constraints

- Anthropic's `/api/oauth/usage` endpoint budgets roughly 28–30 requests
  per rolling hour per identity for non-first-party clients. cswap
  (v0.25.0) rations accordingly: 180s floor, 300s active-account ceiling,
  600s idle/exhausted ceiling, AIMD backoff to 1800s after 429s. Reading
  age up to 30 minutes is designed behavior, not a fault.
- `cswap list --json` exposes per-account `usage`, `usageStatus`,
  `usageFetchedAt`, `usageAgeSeconds` only — no poll schedule.
- Dealerboard's collector (120s cadence, 5s exec timeout) is the only cswap
  surface running on this machine; cswap fetches happen inside those
  invocations when an account's stored schedule says it is due.
- View-model logic stays DOM-free in `app/src/quota.ts`; rendering stays in
  `app/src/rail.ts` (existing layering).

## Alternatives considered

- Alternative: keep age-based dimming, raise the per-account threshold to
  cswap's designed worst cadence (45–60 min).
  - Rejected because: it duplicates cswap's own health signal with a
    constant that hardcodes upstream's poll policy and silently rots when
    upstream retunes it; the false-alarm boundary moves instead of
    disappearing.
- Alternative: compare reading age against cswap's own schedule
  (`nextPollAt`/`pollIntervalS`) so "stale" means "cswap missed its own
  promise".
  - Rejected because: those fields are not in `cswap list --json`; getting
    them means an upstream PR (out of scope) or reading cswap's private
    cache file (couples to undocumented internals).
- Alternative: keep a generous age backstop on top of the two-layer model,
  for the case where cswap reports "ok" while serving ancient data.
  - Rejected because: that case requires a cswap bug; YAGNI. Revisit if it
    is ever observed.

## Open questions

- When the grouped section dims as a whole, should the per-account age
  notes appear so the user can see how old each seat's reading is? — tag:
  gate-decides
- Exact test surface: extend `test/strip-quota.test.ts` and
  `test/strip-rail.test.ts`, or is a new test file warranted for the
  grouped-state rendering? — tag: impl-detail

## Assumptions

- `usageStatus != "ok"` is cswap's authoritative signal that fetches are
  failing; verified against claude-swap 0.25.0 source (`usage_store.py`,
  `poll_policy.py`, `json_output.py` field set).
- The strip is the only surface rendering per-account quota rows (no
  keypad equivalent exists; `styles.css` comment confirms).

## Edge cases considered

- Dealerboard collector dead: ambient `fetchedAt` ages past 6 min → whole
  group dims (layer 1). Previously invisible for the grouped layout.
- cswap under 429 backoff with `usageStatus == "ok"`: rows stay bright even
  at 30-minute reading age (the false alarm this spec removes).
- cswap auth-dead or persistently 429ing past its last-good horizon:
  `usageStatus != "ok"` → row dims with age note (layer 2, unchanged).
- One seat ok, one seat unavailable: only the bad seat dims; group state
  unaffected (ambient read succeeded).
- Accounts array shrinks below 2 (account removed from cswap): grouped
  layout collapses to the ungrouped panel, which keeps ambient-state
  semantics — unchanged behavior, no interaction with this fix.

## Out of scope (with reasons)

- Upstream cswap PR to publish `nextPollAt` in JSON — reason: third-party
  project; the two-layer model does not need it.
- Diagnosing/remediating yesterday's 429 saturation (175 events on
  2026-08-26) — reason: cswap-side behavior under a heavy-usage day;
  dealerboard's fix must simply render it honestly.
- Token-usage panel staleness (`rail-tokens`) — reason: separate data path
  with its own collector-owned timestamp; semantics already correct.
- Distinct treatment for an exhausted seat (0% remaining) — reason:
  exhaustion is quota truth, already conveyed by the bar fill and percent;
  the dim channel stays reserved for data health (user decision,
  2026-08-27).

## Golden-question checklist

- [ ] Data migration / existing-data impact: N/A — view-model change only;
      quota-snapshot schema untouched.
- [ ] Auth / permissions: N/A — no new data sources; same cswap invocation.
- [ ] Failure / retry behavior: covered by the two-layer model itself (the
      feature is failure rendering).
- [ ] Rollback path: revert the commit; no persisted state changes.
- [ ] Observability / logging: N/A — pure rendering change; collector
      diagnostics unchanged.
- [ ] Visual regression surface: the dimmed-group treatment must remain
      distinguishable from a dimmed single row on the physical strip —
      verify on device, not just in tests.
