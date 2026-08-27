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

## 2026-08-27 01:02 — Ratified
- **Commit:** 53a30a6
- **Cold-read:** codex/gpt-5.6-sol, two rounds (agents 5c0a04a2, 8f0b9cdd;
  a first attempt was voided for integrity and re-run). Round 1: 11
  findings — dispositioned 2026-08-27 (entries above): partially refuted
  with code evidence (F1, F3), already answered by design (F2, F10),
  folded into the spec (F4-F8), settled as decisions (F9, F11). Round 2:
  10 questions — 8 answered by the amended spec, finding 9 plus residual
  explicitness folded in (entry above).
- **Sign-off:** Drew — "go ahead" (2026-08-27, in response to "say the
  word and I'll record your ratification")

## 2026-08-27 01:43 — Plan review round 1: NOT READY; 0/1/≥2-retained failure contract settled
- **Decided:** Sol's plan review (agent 1705c847, on plan commit 27be488)
  returned 6 findings, all accepted. Its finding 2 exposed an internal
  contradiction in the ratified notebook: the state table's "never
  fetched → unavailable grouped (null stamp)" row conflicted with the
  ratified requirements (fallback when cswap yields <2 accounts; grouped
  starvation scoped to ≥2 retained). Settled per the requirements, which
  take precedence over the illustrative table: failure with 0 or 1
  retained accounts stays in fallback mode (codexbar probe runs,
  ungrouped panel); grouped starvation applies only from ≥2 retained;
  retained accounts and their collector stamp are one atomic state, also
  populated by legacy-snapshot seeding at restart (finding 3). Table row
  repaired accordingly — recorded as a consistency repair, not a
  reversal of any ratified decision. FLAGGED for Drew's morning review:
  if this reading is wrong, it is a one-line spec change plus a Task 4
  test adjustment.
- **Because:** the requirements section is what was reviewed, amended,
  and ratified; the table row described a state the ratified collector
  design makes unreachable except via the seeding path now handled
  explicitly.
- **Deciders:** steering-session under Drew's overnight "fix and
  proceed" instruction (2026-08-27)

## 2026-08-27 02:28 — Plan review round 2: NOT READY; two-bounce reached; ratification voided
- **Decided:** (1) Sol's round-2 review (agent 20b87bb9, plan a027ef0)
  is right that the 2026-08-27 receipt was voided by the post-receipt
  spec amendments (36deba8 and later): status flipped back to ready;
  Drew's re-sign-off over the full delta since 53a30a6 is QUEUED FOR
  MORNING. Deviation from the reviewer's literal fix, recorded openly:
  no third cold-read — two rounds ran and were dispositioned, the voided
  delta was itself adversarially reviewed by both plan-review rounds, and
  the workflow's own rule is to never loop gates. (2) Two plan-review
  rejections = two-bounce: gating stops; the steering seat resolved the
  remaining findings conversationally. Finding 2: claude's state now
  resolves after every other provider's await with no await between
  computing and committing both halves (cswap read stays first for stamp
  semantics); regression test added. Finding 3: starvation requires a
  usable (non-null) stamp — a null-stamp legacy seed takes the fallback
  probe — and starvation publishes with unavailable canonicalized false;
  spec edge cases updated, two tests added. Finding 4: the physical
  receipt now specifies the repo's real install sequence, fresh-daemon
  verification, and reversible fault injection.
- **Because:** the reviewer's findings were verified against the plan and
  code; the fixes follow its required-fix guidance except where the
  never-loop-gates rule overrides (the third cold-read).
- **Deciders:** steering-session under Drew's overnight instruction;
  ratification explicitly reserved for Drew

## 2026-08-27 09:37 — Ratified
- **Commit:** 4a1a7fe
- **Cold-read:** codex/gpt-5.6-sol, two ratify rounds (5c0a04a2, 8f0b9cdd)
  dispositioned in entries above; the post-receipt delta (cold-start
  fallback contract, claude-last atomicity, legacy-seed migration) was
  adversarially reviewed by plan-review rounds 1-2 (1705c847, 20b87bb9)
  and resolved per the two-bounce conversational takeover.
- **Sign-off:** Drew — "ratify" (2026-08-27, morning, over the delta
  summary since 53a30a6)

## 2026-08-27 12:46 — Physical-strip acceptance receipt (plan Task 5 Step 4)
- **Decided:** Receipt executed live on the installed artifacts (daemon via
  install-local.ts, app via install:app, fresh-daemon proof: the new
  grouped snapshot shape — null ambient windows + collector stamp —
  within one pass of install). Data-side verification per check, driven
  by the steering seat with reversible fault injection:
  1. Normal cadence: both seats ok with seat-1 reading ~13 min old —
     bright under the new rule where the old code greyed it. PASS.
  2. Seat-2-only fault (stub cswap reporting usageStatus unavailable):
     seat 2 unavailable, seat 1 ok, group stamp 30s. PASS.
  3. Whole-command failure (exit-1 stub): both rows unavailable, stamp
     frozen at the pre-fault value, ambient windows still null — no
     fallback probe, no budget spend. One good pass cleared it. PASS.
  4. Collector death (launchctl bootout): stamp aged to 399s past the
     360s threshold with the snapshot frozen; daemon restarted after.
     PASS (data); group dim rendered from stamp age per Task 2's tests.
  5. cswap absent (binary renamed): panel collapsed to the ungrouped
     ambient meter with live codexbar data (91%); restored. PASS.
  Visual confirmations on the strip observed live by Drew during the
  run; formal per-check visual sign-off: pending Drew's confirmation.
- **Operational note (in-spec behavior, recorded for awareness):** after
  ~25 min of faults + daemon downtime, the first cswap invocations
  exceeded the 5s exec timeout while catching up overdue usage fetches
  (quota_accounts_failed at 19:30 and 19:42Z); with the seeded snapshot
  being the ungrouped check-5 state (0 retained), the collector correctly
  sat in codexbar fallback until cswap warmed, then re-grouped. Self-
  healed per the ratified 0/1/≥2 contract; bounded budget spend.
- **Deciders:** steering-session (execution); Drew (visual sign-off,
  pending)

## 2026-08-27 12:56 — Run closed: accepted and merged
- **Decided:** Drew accepted the receipt and ordered the merge to main
  ("just merge it pls and restart the daemon and app", 2026-08-27) —
  recorded as the visual sign-off on the acceptance receipt above. Spec
  status flips to completed. SDD run row already in ~/.agents/run-ledger.md.
- **Deciders:** user
