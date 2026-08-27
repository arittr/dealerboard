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
