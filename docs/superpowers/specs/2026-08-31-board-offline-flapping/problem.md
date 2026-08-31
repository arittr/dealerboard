# Problem statement — 2026-08-31-board-offline-flapping

<!-- IMMUTABLE. Written once at kickoff, in the user's words; never edited.
     The ratify gate's cold-read checks the spec against THIS file — not
     against the spec, and not against anyone's memory of the conversation.
     If the problem itself changes, abandon this notebook and start a new one. -->

Kickoff (Drew): "why do i keep seeing offline on the board - is the daemon
flapping or something" — then, after the diagnosis and a fixes discussion:
"what are the fixes" and "write a spec first pls".

## Investigation findings (2026-08-31 session, live evidence)

- The daemon process is not flapping: launchd shows 2 spawns since load,
  the current pid had ~1.5 days of uptime, published health is `ok`, and
  schema versions align (DB v17 = repo v17 = installed binary).
- The board renders OFFLINE when `snapshot-v2.json` goes stale past
  `STALE_SNAPSHOT_AGE_MS` (10s — two missed 5s heartbeats), when a read
  fails or parses badly, or when the published payload's `health.status`
  is not `ok` (`app/src/snapshot-view.ts`).
- Observed live at 12:41 PDT: the daemon's heartbeat gapped 13s and 17s
  back-to-back while a concurrent 2.5s-cadence shell loop stayed on time.
  The daemon's event loop specifically was blocked; the system was not
  globally starved. Healthy cadence before and after was a crisp 5s.
- The daemon's own diagnostic is blind to this: `CLOCK_JUMP_MS` is 30s, so
  10–30s gaps — exactly the band that blanks the board — log nothing.
  Every `clock_jump` actually logged matched a `pmset -g log` sleep or
  DarkWake timestamp (sleep artifacts, not awake stalls).
- Separately, every system wake flashes OFFLINE: the app has no resume
  handling, so its armed expiry check fires against a sleep-stale mtime
  before the daemon's first post-wake heartbeat lands.
- All synchronous work on the daemon's event loop was audited: registry
  SQLite (WAL, 250ms busy cap, fail-fast tick), zcode title reads (WAL,
  per-pass read-only connection, SQLITE_BUSY skips the pass), bounded
  session-file reads, small paseo scans, 12k snapshot writes, and async
  subprocess collectors (agentsview measured at 2s wall / 15s timeout).
  The one remaining foreign synchronous read on the loop is
  `src/core/quota.ts` `defaultReadFile`'s `readFileSync` of CodexBar's
  group-container `widget-snapshot.json`, every 120s — the same file
  previously observed on this machine to hang plain `open()` system-wide;
  the hardening flagged after that incident never landed. A mid-stall
  stack sample has not yet been captured (a 6h sampling trap is armed;
  the bursts are sparse).

## Desired outcome (Drew, from the fixes discussion)

The board should show OFFLINE only when the daemon has actually stopped
publishing; any stall long enough to blank the board must leave log
evidence; waking the Mac must not flash OFFLINE.
