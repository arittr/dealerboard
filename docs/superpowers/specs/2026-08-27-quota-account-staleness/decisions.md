# Decision log — 2026-08-27-quota-account-staleness

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

## 2026-08-27 00:25 — Dim means trust, not age; staleness keys to the timestamp each layer owns
- **Decided:** Two-layer state model for the grouped Claude quota section.
  Layer 1: the grouped section carries the ambient panel state (dims when
  dealerboard's own collector misses three 120s passes) — closing the gap
  where the grouped branch of `rail.ts` never rendered ambient state at
  all. Layer 2: an account row dims only when cswap reports
  `usageStatus != "ok"` (the existing `unavailable` mapping); per-account
  reading age never dims.
- **Rejected:** (b) age-based dimming with a threshold sized to cswap's
  worst designed cadence — duplicates cswap's health signal and hardcodes
  upstream poll policy. (c) an additional age-note/backstop layer — covers
  only a hypothetical cswap bug ("ok" status with ancient data); YAGNI.
- **Because:** the per-account `fetchedAt` is cswap's probe timestamp, not
  dealerboard's; cswap's designed cadence (3–10 min healthy, up to 30 min
  post-429 AIMD backoff, per claude-swap 0.25.0 `poll_policy.py`) crosses
  the 6-minute `STALE_QUOTA_AGE_MS` threshold during normal operation, so
  the current check alarms on designed behavior. Root-cause evidence:
  live store showed active seat at `pollIntervalS=1800` after a 429 at
  05:38Z; 175 usage-endpoint 429s logged on 2026-08-26 (heavy-usage day);
  no resident cswap surfaces — dealerboard's collector is the only driver.
- **Deciders:** steering-session (user assented to scribing this as the
  opening position; not yet ratified)

## 2026-08-27 00:25 — Exhausted seat gets no distinct treatment
- **Decided:** An exhausted account row (0% remaining in its binding
  window) renders like any other ok-state row: red/empty bar, normal
  brightness, no badge or extra note.
- **Rejected:** Exhaustion badges, dimming, or other distinct affordances.
- **Because:** Exhaustion is quota truth, not a data-health state, and the
  bar fill plus percent already say it; the dim channel stays reserved for
  "don't trust this number".
- **Deciders:** user

## 2026-08-27 00:43 — Root cause found upstream: dealerboard's own codexbar claude probe saturates the usage budget
- **Decided:** Recorded as evidence (scope addition pending user confirmation):
  the ambient claude probe (`codexbar usage --provider claude`, every 120s
  ≈ 30 calls/hour) hits the same `api.anthropic.com/api/oauth/usage`
  endpoint as cswap (verified in the codexbar binary) with the active
  seat's token, consuming the entire ~28-30/hour budget by itself and
  starving cswap into 30-minute backoff — the very staleness this spec
  addresses. Its reading is never rendered in the grouped two-seat layout.
  Disabling claude in the CodexBar app does not stop it: dealerboard
  invokes the CLI directly with an explicit provider argument (verified
  live 2026-08-27 ~07:45: probe still succeeds, seat-1 429 nine minutes
  prior, poll interval still pinned at 1800s).
- **Because:** Fixing only the display would leave the active seat's data
  genuinely 30 minutes old on heavy days; the probe is pure budget waste
  in the grouped case.
- **Deciders:** steering-session (evidence); scope addition awaits user

## 2026-08-27 00:43 — Single-failure dimming stands (gate finding 9)
- **Decided:** One failed `cswap list` pass immediately marks accounts
  unavailable (dims rows) and one success clears it — existing behavior
  kept, no debounce.
- **Rejected:** Requiring consecutive failures before dimming.
- **Because:** Smallest honest behavior; a 2-minute transient dim is
  acceptable noise. Revisit only if flicker is observed in practice.
- **Deciders:** steering-session

## 2026-08-27 00:50 — One source per situation for claude quota (Supersedes: collector untouched)
- **Decided:** The collector reads cswap before the provider probe loop.
  cswap success with ≥2 accounts → skip the codexbar claude probe, stamp
  the claude entry's `fetchedAt` at the cswap read, publish null ambient
  windows. cswap absent or <2 accounts → codexbar claude probe as today.
  cswap read failure with retained accounts → no codexbar fallback, no
  restamp (group ages toward stale), rows dim via existing unavailable.
  This supersedes the spec's original non-goal "No change to quota
  collection cadence or the collector itself."
- **Rejected:** codexbar-only (cannot see the inactive seat; no pacing —
  120s cadence alone spends the whole ~28-30/hr budget); keeping both
  sources and fixing only the display (active seat stays genuinely ~30 min
  stale on heavy days); codexbar fallback on cswap failure (spends budget
  exactly when cswap is struggling; flaps the layout).
- **Because:** cswap is the only source that can see both seats and the
  active marker, and the only correctly paced client of the shared usage
  budget; the codexbar claude reading is never rendered in the grouped
  layout (verified: quota history rendered nowhere).
- **Deciders:** user ("yes pls" to the settled one-source shape,
  2026-08-27)

## 2026-08-27 00:50 — Gate findings 1-8, 10, 11 dispositioned
- **Decided:** F1: partially refuted — ambient fetchedAt restamps per
  successful pass, forcing a snapshot rewrite; residue (ambient measured
  codexbar, not cswap) resolved by the one-source decision: the stamp now
  IS the cswap read. F2/F10: already answered by the design (no overdue
  state; scope in non-goals). F3: bound verified and documented — worst
  successful pass fits inside STALE_QUOTA_AGE_MS once claude leaves the
  probe loop. F4: explicit state rendering contract added to spec. F5:
  usageStatus enum verified in cswap 0.25.0 source; "ok" = believable
  numbers (last-good under backoff), sentinels structural; uniform non-ok
  → unavailable stands. F6: degenerate cases documented as unchanged
  existing behavior. F7: no schema change needed (existing fields
  suffice). F8: usageFetchedAt authoritative; usageAgeSeconds ignored;
  age affects note text only. F11: retained active marker on command
  failure accepted. (F9 dispositioned in its own entry above.)
- **Because:** gate findings list of 2026-08-27 (agent 5c0a04a2) is the
  record; verifications performed against the worktree code and cswap
  0.25.0 source.
- **Deciders:** steering-session, with user's scope confirmation

## 2026-08-27 01:00 — Gate round 2 findings dispositioned; cold-read complete
- **Decided:** Findings 1-8 and 10 of the second cold-read (agent
  8f0b9cdd) are answered by the amended spec (source authority, no age
  threshold, collector-dead = the collector's own cswap-read stamp aging
  past three passes, uniform status mapping, group-vs-rows dim extent,
  account-count transitions, ambient meter retired in grouped mode, scope
  limited to the claude group). Finding 9 (reset-passed trust horizon)
  and residual explicitness folded into the spec: widget-snapshot path
  excluded in grouped mode; no sleep/wake grace (existing behavior);
  "resetting…" bounded by cswap's reset-clamped scheduling; unknown
  usageStatus values unavailable by construction.
- **Because:** the cold-read judges from problem.md + code only; its
  question list is the record against which the spec was checked, per the
  artifact-gated workflow.
- **Deciders:** steering-session; ratification pending user sign-off
