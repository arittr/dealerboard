# Decision log — 2026-08-31-board-offline-flapping

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

## 2026-08-31 13:30 — One spec covers all three fixes

- **Decided:** A single notebook specs the stall diagnostic (R1), wake
  grace (R2), and widget-read hardening (R3).
- **Rejected:** Spec'ing only the proven mechanisms (R1+R2) while a
  mid-stall stack sample confirms the blocker; two separate notebooks.
- **Because:** R3 is justified as latent-defect hardening — a synchronous
  read of a foreign, historically-hanging file on the heartbeat loop is
  wrong regardless of whether it is today's culprit. If the armed trap
  later names a different frame, that is a new finding, not a spec
  rewrite.
- **Deciders:** user (chose "All three fixes, one spec" when asked)

## 2026-08-31 13:30 — R1 is a new code, not a lowered clock-jump threshold

- **Decided:** Add `tick_stall` for gaps in [10s, 30s); `clock_jump`
  keeps its ≥30s meaning. No duration field on the record.
- **Rejected:** Lowering `CLOCK_JUMP_MS`; extending `DiagnosticRecord`
  with a gap duration.
- **Because:** `clock_jump` is documented as "host slept or the clock
  jumped" — reusing it for awake stalls conflates the two things the
  investigation had to separate. The record shape stays minimal per the
  diagnostics contract; the two bands already give a coarse severity
  read.
- **Deciders:** steering-session (proposed in the fixes discussion; user
  moved to spec on that basis)

## 2026-08-31 13:30 — R2 self-detects resume in JS; no native wake plumbing

- **Decided:** A 1s watchdog notices its own late firing (≥5s) and opens
  a 6s grace window that holds the last healthy view while re-reading at
  1s.
- **Rejected:** Rust-side `NSWorkspace` wake observer forwarded as a
  Tauri event.
- **Because:** The same sleep that staled the file made the app's timers
  late — the signal is already in-process. Occlusion-throttle false
  positives only grant harmless grace. A genuinely dead daemon still
  shows OFFLINE, ~6s later.
- **Deciders:** steering-session

## 2026-08-31 13:30 — R3 is an async read raced with a 2s timeout

- **Decided:** The widget read moves off the event loop; timeout yields
  the missing-file path plus a `widget_read_timeout` diagnostic; at most
  one read outstanding; late resolutions discarded; the injectable
  `readFile` dependency goes async at both call sites.
- **Rejected:** `O_NONBLOCK` on the open (unverified semantics for
  regular files under containermanagerd); subprocess read via `cat`
  (held as fallback if the async read proves insufficient).
- **Because:** `pollNow` is already async and `readFile` already
  injectable — this is the smallest change that makes the heartbeat
  independent of that file's open() behavior, with damage bounded to one
  stranded worker.
- **Deciders:** steering-session

## 2026-08-31 13:30 — Implementation order R1 → R2 → R3

- **Decided:** Land the diagnostic first, wake grace second, hardening
  third.
- **Because:** R1 and R2 are proven-by-evidence and tiny; R1's log lines
  plus the armed 6h sampling trap may upgrade R3 from "lead suspect" to
  "confirmed" before it lands.
- **Deciders:** steering-session

## 2026-08-31 13:30 — Kickoff status note

- 6h mid-stall sampling trap armed 13:04 PDT (watcher pid 45288; log
  `/tmp/dealerboard-stall-watch.log`, samples
  `/tmp/dealerboard-stall-sample-*.txt`). No catches at spec time.
- Investigation problem tracked in decision-log id
  e2b39c72-5d88-403c-ab19-9c10a56fe00d and memory note
  `board-offline-heartbeat-stalls`.
