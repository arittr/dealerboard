---
topic: 2026-08-27-quota-account-staleness
status: ready            # draft | ready | ratified | paused | abandoned | completed
created: 2026-08-27
author-pool: claude-seat2   # the ratify cold-read must come from a DIFFERENT model family
---

# Claude quota: one source per situation, staleness keyed to the timestamp each layer owns

## Goal

Stop the strip's Claude account rows from greying during normal operation.
Two coordinated changes:

1. **Data (root cause):** stop the collector's `codexbar usage --provider
   claude` probe whenever cswap serves the grouped two-seat view. The probe
   costs ~30 calls/hour against Anthropic's ~28–30/hour per-account usage
   budget — the entire allowance — starving cswap into 429s and 30-minute
   backoff, and its reading is never rendered in the grouped layout.
   Claude quota comes from exactly one source per situation: cswap when it
   reports ≥2 accounts, codexbar otherwise.
2. **Display:** replace the per-account 6-minute age check (calibrated to
   dealerboard's 120s collector but applied to cswap's probe timestamps)
   with a two-layer model where each layer keys off a timestamp its own
   collector writes: the group dims when dealerboard's collector goes
   quiet, an account row dims when cswap reports it cannot fetch.

## Non-goals

- No change to non-claude providers (codex, kimi, zai, qwen): their
  collection path and `STALE_QUOTA_AGE_MS` semantics stay as they are.
- No change to the single-account / cswap-absent claude path: the
  ungrouped ambient panel keeps its codexbar probe and existing semantics.
- No upstream cswap or codexbar changes; no reading of cswap's private
  cache (`~/.claude-swap-backup/cache/usage.json`).
- No quota snapshot schema change (verified: both layers reuse existing
  fields).
- No redesign of the account rows' layout, marker, or note text beyond
  what the state model requires.

## Requirements

- [ ] Requirement: source selection — the collector reads cswap before the
      provider probe loop; when the read succeeds with ≥2 accounts it
      skips the codexbar claude probe for that pass.
  - Acceptance: in grouped operation, `codexbar usage --provider claude`
    is not invoked and the widget-snapshot rescue path is not consulted
    for claude either; claude's published snapshot entry carries the
    account rows, `unavailable: false`, null ambient windows, and
    `fetchedAt` stamped by the collector at the successful cswap read.
    With one source there is also no two-probe window that can straddle an
    account switch mid-pass.
- [ ] Requirement: fallback — when cswap is absent or authoritatively
      reports <2 accounts, the codexbar claude probe runs as today and the
      ungrouped panel renders unchanged.
  - Acceptance: with cswap removed, claude behaves exactly as on main.
- [ ] Requirement: cswap read failure keeps the group and starves the
      stamp — no codexbar fallback probe.
  - Acceptance: on exec failure/timeout/invalid output with ≥2 retained
    accounts, the retained rows are marked `unavailable: true` (existing
    behavior), ambient `unavailable` stays false, and `fetchedAt` is not
    restamped — so persistent failure ages the group into stale while a
    transient one only dims the rows for ~one pass.
- [ ] Requirement: the grouped section renders the ambient panel state.
  - Acceptance: `rail.ts` sets `data-state` on the grouped section from
    the panel state (today only the non-grouped branch does); the group
    dims when the collector misses three 120s passes or has never read
    cswap successfully.
- [ ] Requirement: an account row's state ignores reading age.
  - Acceptance: an account with `unavailable: false` renders "ok"
    regardless of `fetchedAt` age; the per-account state space collapses
    to ok | unavailable (no per-account "stale").
- [ ] Requirement: an account row dims exactly when cswap says its data
      is not good.
  - Acceptance: `usageStatus != "ok"` (mapped to `unavailable: true` by
    `claude-swap-quota.ts`) renders the row dimmed with the existing
    "Xm/Xh+ old" age note; `usageStatus == "ok"` renders bright.

## State rendering contract

| Situation | Group | Account rows |
| --- | --- | --- |
| Healthy, readings merely on cswap's schedule (up to ~30 min old under 429 backoff) | bright | bright, reset countdowns |
| One seat's fetches failing (`usageStatus != "ok"`) | bright | that row dims + age note; other row bright |
| Whole `cswap list` failing this pass (transient) | bright (stamp ≤3 passes old) | both rows dim + age notes |
| `cswap list` failing ≥3 passes, or collector dead | dims (stale) | both rows also dim (unavailable) |
| Seat exhausted (0% remaining) | bright | bright; red/empty bar says it (user decision) |
| Never fetched (cold start, cswap failing from the first pass) | unavailable (null stamp) | em-dash / unavailable note (existing) |
| cswap reports <2 accounts | ungrouped ambient panel, unchanged semantics | n/a |

## Constraints

- Anthropic's `/api/oauth/usage` endpoint budgets ~28–30 requests per
  rolling hour per account identity for non-first-party clients; codexbar
  and cswap hit the same endpoint (verified in the codexbar binary) and
  share that budget per account. cswap (v0.25.0) paces deliberately: 180s
  floor, 300s active ceiling, 600s idle/exhausted ceiling, AIMD backoff to
  1800s (±10% jitter) after 429s. Reading age up to ~33 minutes is
  designed behavior, not a fault.
- cswap's `usageStatus` values (v0.25.0 `json_output.py`): `ok`,
  `token_expired`, `api_key`, `keychain_unavailable`, `relogin_required`,
  `foreign_credential`, `no_credentials`, `unavailable` (fetch failed).
  cswap serves last-good numbers under backoff as `ok`; sentinels are
  structural faults. Dealerboard treats all non-ok values uniformly as
  unavailable (existing parse, unchanged).
- `usageFetchedAt` is the authoritative per-account timestamp (existing
  parse); `usageAgeSeconds` is ignored. Age affects only the note text on
  unavailable rows, never state.
- Pass-duration bound for the group threshold: with claude removed from
  the probe loop, a fully successful pass is ≤ ~4×60s (codexbar's own
  per-provider success ceiling) + cswap's 5s, comfortably inside
  `STALE_QUOTA_AGE_MS` (360s); slower passes imply failing probes, which
  correctly age toward stale. The cswap read precedes the probe loop, so
  its stamp cadence tracks pass starts.
- One failed `cswap list` pass dims rows immediately; one success clears
  it. No debounce (decision log, gate finding 9).
- The ambient claude history ring stops accumulating in grouped mode;
  quota history is rendered nowhere in the app (verified), so this is
  invisible. The token-usage chart is a separate snapshot.
- View-model logic stays DOM-free in `app/src/quota.ts`; rendering in
  `app/src/rail.ts`; collector in `src/core/quota.ts`.

## Alternatives considered

- Alternative: fetch claude directly from codexbar only (drop cswap).
  - Rejected because: codexbar reads the live `~/.claude` credentials and
    can only ever see the active seat — the two-seat display is impossible
    without cswap's credential store; and the codexbar CLI is a one-shot
    with no pacing, so dealerboard's 120s cadence alone consumes the
    entire usage budget.
- Alternative: keep both sources (status quo) and fix only the display.
  - Rejected because: the active seat's data would remain genuinely
    ~30 minutes old on heavy days; the probe spends the whole budget on a
    reading the grouped layout never renders.
- Alternative: age-based dimming with a threshold sized to cswap's worst
  designed cadence (45–60 min).
  - Rejected because: duplicates cswap's own health signal and hardcodes
    upstream poll policy; the false-alarm boundary moves instead of
    disappearing.
- Alternative: compare reading age against cswap's own schedule
  (`nextPollAt`/`pollIntervalS`).
  - Rejected because: not exposed by `cswap list --json`; would need an
    upstream PR or coupling to cswap's private cache.
- Alternative: probe codexbar claude as a fallback when the cswap read
  fails.
  - Rejected because: it reintroduces budget spend exactly when cswap is
    struggling (often because of budget), and flips the layout between
    grouped and ungrouped on transient failures.
- Alternative: a generous age backstop for cswap reporting "ok" with
  ancient data.
  - Rejected because: requires a cswap bug; YAGNI. Revisit if observed.

## Open questions

- Exact test surface: extend `test/strip-quota.test.ts`,
  `test/strip-rail.test.ts`, `test/quota.test.ts`, or add a file for the
  source-selection and grouped-state behavior? — tag: impl-detail

## Assumptions

- `usageStatus != "ok"` is cswap's authoritative fetch-health signal;
  verified against claude-swap 0.25.0 source.
- The strip is the only surface rendering per-account quota rows (no
  keypad equivalent; `styles.css` comment confirms).
- The CodexBar app's own claude polling is user-disabled (2026-08-27);
  dealerboard's CLI invocation is unaffected by that app setting and must
  be removed by this change.

## Edge cases considered

- Collector dead: stamp ages → group dims. Previously invisible for the
  grouped layout (grouped branch set no `data-state`).
- cswap under 429 backoff with `usageStatus == "ok"`: rows stay bright at
  30-minute reading age (the false alarm this spec removes).
- Transition ≥2 → <2 accounts (account removed): next successful cswap
  read is authoritative; collector resumes the codexbar claude probe;
  panel renders ungrouped. The reverse transition swaps back. No flapping
  on failure: failed reads retain the last-known account set.
- Whole-command failure retains the previous `active` marker: accepted —
  best-known identity, and the rows are dimmed anyway (gate finding 11).
- Clock skew / `usageFetchedAt` in the future: age never drives state;
  note text may read oddly until the next fetch. Cosmetic, accepted.
- Missing cswap binary after accounts were present: collector treats it
  as cswap absent → codexbar fallback, ungrouped panel (existing "absent"
  path). Missing codexbar binary in fallback mode: existing
  provider-absent behavior, unchanged.
- Sleep/wake: the first pass after wake may render the group stale for up
  to ~one pass (~2 min) until a cswap read lands — existing behavior for
  every provider panel today; accepted, no wake grace.
- Binding reset passes while a reading is `ok`: the row stays bright and
  shows the existing "resetting…" note. Bounded honestly: cswap clamps
  its next poll to a known reset + 60s slack (`RESET_SLACK_S`), so fresh
  numbers follow within minutes even under backoff.
- Unknown future `usageStatus` values: non-ok by construction (the parse
  tests `=== "ok"`), so they render unavailable — safe default.

## Out of scope (with reasons)

- Upstream cswap PR to publish `nextPollAt` — reason: third-party; the
  two-layer model does not need it.
- Remediating the 429 saturation beyond removing dealerboard's probe —
  reason: remaining callers (cswap) are correctly paced; the CodexBar app
  side is user-managed.
- Token-usage panel staleness (`rail-tokens`) — reason: separate data
  path; semantics already correct.
- Distinct treatment for an exhausted seat — reason: exhaustion is quota
  truth, already conveyed by the bar (user decision, 2026-08-27).
- Debounce/hysteresis for transient cswap failures — reason: decision log
  (gate finding 9); revisit only if flicker is observed.

## Golden-question checklist

- [ ] Data migration / existing-data impact: none — snapshot schema
      unchanged; old snapshots parse as before (null ambient windows are
      already representable).
- [ ] Auth / permissions: N/A — no new data sources; one existing
      invocation removed per pass.
- [ ] Failure / retry behavior: specified in the state rendering contract
      and cswap-read-failure requirement.
- [ ] Rollback path: revert the commit; no persisted state changes.
- [ ] Observability / logging: existing failure-transition logging
      (`reportFailure`) unchanged; the removed probe logs nothing new.
- [ ] Visual regression surface: dimmed-group vs dimmed-row treatments
      verified on the physical strip, not just in tests.
