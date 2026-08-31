# Board OFFLINE flapping: tick-stall diagnostic, wake grace, hang-proof widget read

## Goal

OFFLINE on the board means the daemon has actually stopped publishing.
Concretely: (1) any daemon stall long enough to blank the board leaves a
log line; (2) waking the Mac no longer flashes OFFLINE; (3) a hang of the
one foreign file read on the daemon's event loop can no longer stop the
heartbeat.

## Non-goals

- Root-causing the OS-level group-container hang (containermanagerd
  behavior; we remove our exposure to it instead).
- Changing the heartbeat cadence (5s), the staleness threshold (10s), or
  the meaning of `clock_jump` (≥30s: host slept or the clock moved).
- Any new OFFLINE visual treatment; how the board renders a degraded view
  is unchanged — only *when* it degrades changes (R2).
- Fixing quota probe failures (`quota_failed`, `quota_accounts_failed`).

## Requirements

### R1 — `tick_stall` diagnostic (daemon)

- New constant `TICK_STALL_MS = 10_000` in `src/core/daemon.ts`, matching
  the app's `STALE_SNAPSHOT_AGE_MS`: every stall long enough to blank the
  board is long enough to log.
- In `ProjectionDaemon.poll()`, for an inter-tick gap `g`:
  - `g ≥ CLOCK_JUMP_MS` (30s): report `clock_jump` (unchanged);
  - `TICK_STALL_MS ≤ g < CLOCK_JUMP_MS`: report new code `tick_stall`.
  The bands are mutually exclusive. A single stall produces one record
  (only the first post-stall tick observes the large gap).
- `DiagnosticCode` gains `"tick_stall"`. The record shape is unchanged —
  no duration field (see Alternatives).
- Acceptance (unit, injected `nowMs`): tick gaps of 12s → exactly one
  `tick_stall`; 35s → exactly one `clock_jump`, no `tick_stall`; 5s →
  neither.

### R2 — wake grace (app)

- The app self-detects resume: a 1s watchdog interval records its last
  fire time; two consecutive fires ≥ `RESUME_GAP_MS` (5s) apart mean the
  webview was suspended (system sleep) or heavily throttled. False
  positives from occlusion throttling are harmless — they merely grant
  grace.
- Detection opens a grace window of `WAKE_GRACE_MS` (6s). While it lasts,
  a reduction that would newly flip the view to degraded — with a
  `lastGood` payload available — does not apply: the last healthy view
  stays rendered and the app re-reads the snapshot at 1s cadence.
- Grace exits early on the first healthy ingest (fresh file or healthy
  push → healthy view; the expiry check re-arms as today). If grace
  expires with the file still stale, the degraded view applies exactly as
  today.
- With no `lastGood` (nothing healthy ever ingested), grace changes
  nothing.
- Acceptance (fake timers): simulated suspend + stale re-reads inside
  grace hold the healthy view; still stale past grace → degraded; fresh
  read inside grace → healthy, timers re-armed. Physical acceptance:
  sleep the Mac (lid close or equivalent), wake after ≥30s — the board
  must not flash OFFLINE (today it always does).

### R3 — hang-proof widget read (quota collector)

- The widget-snapshot read in `src/core/quota.ts` stops being a
  synchronous call on the event loop: `pollNow` performs an asynchronous
  (off-loop) read raced against `WIDGET_READ_TIMEOUT_MS = 2_000`.
- On timeout: the pass proceeds with no widget fallback (identical to a
  missing file today), a new `widget_read_timeout` diagnostic is reported
  (component `quota`), and the `polling` reentrancy guard is still
  released at pass end.
- At most one widget read is ever outstanding: if a prior read has not
  resolved by the next pass, that pass uses `null` immediately and does
  not start a second read. A late resolution of an abandoned read is
  discarded — it must never apply to a later pass.
- The injectable `readFile` dependency becomes async; both of its call
  sites (the startup seed of `quotaSnapshotPath` and the widget read)
  move to the async contract. Tests inject fakes (never-resolving,
  slow-resolving, immediate).
- `DiagnosticCode` gains `"widget_read_timeout"`.
- Acceptance (unit): a never-resolving read → `pollNow` completes without
  widget data, guard released, diagnostic recorded, and a fake-scheduler
  daemon tick sequence proceeds uninterrupted; a read resolving after
  timeout is discarded; a prompt read behaves exactly as today; a second
  pass while a read is stuck does not spawn a second read.

## Constraints

- Single process, shared event loop by design — collectors stay
  in-process; the fix is isolation of blocking I/O, not process split.
- `diagnostics.ts` contract: records carry only timestamp / component /
  fixed code (/ provider / bounded sessionId) — no payloads. Codes are a
  closed union; both new codes join it.
- WKWebView timers are throttled or suspended when the window is hidden
  or the system sleeps: resume detection must tolerate arbitrary gap
  sizes and false positives.
- Bun runtime: async file reads run off the event loop; a genuinely hung
  `open()` may strand its worker. Bounded to one stranded read by R3's
  single-outstanding-read rule.
- TDD throughout. The daemon and quota collector already take injected
  dependencies (`nowMs`, `schedule`, `readFile`, `diagnostics`); the
  app's grace logic must land in the same testable shape as
  `reduceSnapshotRead` — pure reduction plus a thin timer seam — so
  tests use fakes, no real sleeps.

## Alternatives considered

- Lowering `CLOCK_JUMP_MS` to 10s: conflates sleep with stall in one
  code; rejected.
- Carrying the gap duration in the `tick_stall` record: extends the
  deliberately minimal record shape for severity data with no current
  consumer; rejected — the two bands give the coarse read; revisit if
  triage needs it.
- `O_NONBLOCK` on the widget open (the fix suggested after the original
  incident): semantics for regular-file opens mediated by
  containermanagerd are unverified; rejected as the load-bearing fix.
- Subprocess read (`cat` with a kill timer): fully isolates hangs but
  adds process plumbing; held as the fallback if the async read proves
  insufficient in practice.
- Rust-side `NSWorkspace` wake notifications forwarded as a Tauri event:
  real plumbing for a signal JS can self-detect; rejected (YAGNI).
- App-side fixed-cadence staleness polling instead of expiry-scheduled
  checks: already litigated in `app/src/main.ts` comments (detection
  bound); unchanged.

## Open questions

- None blocking. The identity of the currently-stalling frame is
  unconfirmed (6h sampling trap armed 13:04 PDT, 2026-08-31; bursts are
  sparse). R3 stands as latent-defect hardening regardless of what the
  sample eventually shows — settled with Drew 2026-08-31.

## Assumptions

- Losing one pass's widget fallback on a timed-out read is acceptable:
  identical to the missing-file path, and retained per-provider state
  plus the CLI probe path cover it.
- ≤6s of last-healthy (possibly stale) card state after wake is
  preferable to a guaranteed OFFLINE blank flash.
- A daemon that genuinely died before sleep shows OFFLINE ~6s later after
  wake than today — acceptable.
- The Stream Deck plugin needs no wake grace: the deck powers off during
  system sleep and the plugin already has its own wake path (`wake_up`
  diagnostic in `src/plugin/session-grid-action.ts`).

## Edge cases considered

- Daemon genuinely dead (or stalls again) during grace: grace expires
  stale → OFFLINE. Correct — grace delays, never suppresses, a true
  verdict.
- Sub-10s stalls: no log line, and the board doesn't blank either —
  consistent by design.
- Backward clock jump (negative gap): no record; unchanged behavior.
- Widget read resolves after timeout with valid JSON: discarded; the next
  pass reads fresh.
- Suspend during grace / repeated resumes: re-detection re-enters grace.
- Daemon restarted (new binary) while the app slept: fresh mtime at wake
  → healthy ingest exits grace early; no flash.
- App cold start right after wake: no `lastGood` → unchanged behavior.
- Stall storms: one record per stall event, growth bounded by the
  existing 256 KiB log rotation.

## Out of scope (with reasons)

- Deck plugin wake grace: hardware is off during sleep; existing
  `wake_up` path covers resume.
- The group-container hang itself: OS behavior; this spec removes the
  daemon's exposure to it.
- Quota and cswap probe failures, and the Anthropic usage-endpoint budget
  contention: separate known issue.
- Snapshot `health.status` vocabulary changes: nothing here publishes new
  health states.

## Golden-question checklist

- [x] Data migration / existing-data impact: none — no schema, protocol,
  or persisted-state changes; new diagnostic codes are additive JSONL.
- [x] Auth / permissions: N/A — local files only.
- [x] Failure / retry behavior: R3 timeout degrades to the existing
  missing-file path; R2 grace degrades to today's OFFLINE; R1 is
  log-only and best-effort by the diagnostics contract.
- [x] Rollback path: revert the commits; nothing persisted to unwind.
- [x] Observability / logging: R1 and R3 add observability (`tick_stall`,
  `widget_read_timeout`); growth bounded by existing rotation.
- [x] Physical-display legibility (project-specific): wake acceptance on
  the strip — sleep, wake, no OFFLINE flash — plus one observed natural
  stall window landing a `tick_stall` line in `daemon.log`.
