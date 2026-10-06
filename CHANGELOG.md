# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Compaction no longer drops a Codex (or Claude) card off the board. Both
  harnesses re-fire `SessionStart` with `source: "compact"` after summarizing
  a live thread; the decoder treated it as a fresh session, resetting the row
  to idle and clearing its done/unread ledgers, so the card vanished until
  work resumed and a finished result lost its unread mark. A compaction start
  now maps to a metadata-only `SessionObserved`.

## [2.0.0] - 2026-09-30

### Changed

- The board card's counter now indicates activity instead of session age. A
  working card reads `working 27m 01s`, ticking from the working episode start
  (falling back to `openedAt` on old daemons) with seconds under an hour; a
  waiting card reads `waiting 12m`. The settled idle and error states no longer
  count up — a counter there read as work that was not happening — and instead
  show their state beside the coarse dim `open 3h` session age, with their
  freshness left to the unread dot. The quiet label stays coarse.

### Removed

- The deprecated Stream Deck integration is removed in full: `src/plugin/`,
  the `com.drewritter.dealerboard.sdPlugin` package, `rollup.config.mjs`, ten
  plugin-only test files, and the `build:plugin`/`pack:plugin` scripts. Its
  dependencies (`@elgato/streamdeck`, `@elgato/cli`, `rollup` and its plugins,
  `tslib`) are gone, and the provider-mark and board-settings helpers the strip
  reused now live under `app/src/`.

### Fixed

- Pi sessions driven by Paseo now register board cards. The shim required
  `ctx.mode === "tui"`, but Paseo runs pi headless in RPC mode, where pi
  reports `mode: "rpc"` with `hasUI: true` — so every Paseo pi session was
  filtered as a ghost. The gate now matches the oh-my-pi shim's
  `ctx.hasUI === true` rule, and headless print/JSON sessions stay invisible.
- The session-facts and Paseo sweeps no longer run their filesystem walks on
  the daemon's event loop: both read provider files asynchronously and hand
  the settled results back to the poll, so a slow or contended disk (a large
  Time Machine backup, Spotlight) can no longer stall the heartbeat and flip
  the board OFFLINE for a few seconds. The walks keep their cadence and
  (mtime, size) caches, and a slow sweep now self-throttles with an
  in-flight guard instead of stacking.

## [1.1.0] - 2026-09-03

### Added

- Multi-page strip boards with fill-and-continue card packing, continuation
  markers, page indicators, and axis-locked drag navigation with live peek and
  snap-back feedback.
- Exact Evener session activation and recursive delegate tracking, including
  authoritative lifecycle updates and removal of archived session trees.
- Hourly token activity curves comparing today with yesterday, plus the two
  daily totals on the rail.
- Daemon stall forensics: a 10–30s poll gap logs `tick_stall`, and heartbeat
  writes failing past the staleness threshold latch one
  `snapshot_publish_overdue` — every board-blanking daemon condition now
  leaves a line in `daemon.log`. An abandoned CodexBar widget read logs
  `widget_read_timeout`.

- roborev-spawned reviewer sessions identify themselves: a bundled
  `claude_code_cmd` shim plants the `ROBOREV_SPAWN` marker, the origin
  vocabulary gains a `roborev` kind (schema v16), and identified cards wear
  the containment ring — and the tile its origin pip — in cyan.

- Flick a slat vertically to dismiss it: a slat an ack would remove (an
  errored session or a viewed idle result) slides out and acks; live slats
  flash instead.

### Changed

- The app installer now quits and relaunches a running Dealerboard app around
  the bundle replacement.
- Paseo provenance moved to the harness side: the violet meta-row dot is now
  a containment ring around the provider chip — the harness enclosed by its
  multiplexer, at zero width cost to the title and meta columns. Grouped
  subagents drop the "sub" pill — the indent and spine already identify
  them; only orphan subs keep it.
- The card's status corner now words every number and ends with the dot, so
  numbers and dots align down each column: working cards headline the session
  age ("open 2h") with a dim "quiet 4m" silence fact, while idle, waiting,
  and error keep their status age ("waiting 12m") behind a dim "open 3h"
  fact. The unlabeled working-burst timer is gone.
- Finished sessions persist on the board until dismissed: a done card no
  longer vanishes when its result is passively viewed (for example, a
  foregrounded Paseo agent finishing). Viewing clears only the unread dot;
  the card leaves on a flick or ack, a Paseo archive, a session restart, or
  session end.
- Acknowledging a session settles its error state: tap-ack and a Paseo
  archive retire an errored row to idle instead of leaving it red until the
  24h stale prune, so parent roll-ups clear once their failed subagents are
  acknowledged.

### Fixed

- Tap-to-open now settles pointer-captured clicks on the pager, preserving the
  original card target through browser click delivery.
- Token activity retains enough source history to reconstruct the full current
  and previous day without treating recovered gaps as measured zeroes.
- Waking the Mac no longer flashes the board OFFLINE: sleep-stale snapshot
  evidence is held for a ~6s wake grace while the daemon's first post-wake
  heartbeat lands; fresh evidence — including an explicit unhealthy
  publication — still applies immediately.
- The quota collector's read of CodexBar's group-container widget snapshot
  moved off the daemon's event loop behind a 2s timeout, so a
  containermanagerd hang can no longer stall the heartbeat that keeps the
  board alive.

- Strip gestures work while the app is backgrounded — its usual state. The
  window now accepts first mouse, so a stroke's moves and release reach the
  recognizer instead of being consumed as an activation click; flick and
  swipe work on the first touch, and first taps are no longer swallowed.
- A touchscreen touch-and-hold opens the card action sheet. macOS delivers
  the hold as a synthesized secondary click, which was suppressed outright;
  its contextmenu now routes to the long-press. A mouse right-click opens
  the sheet the same way.

## [1.0.0] - 2026-08-26

First source release of the Dealerboard daemon and macOS strip app.

### Added

- Hook-driven session registry and snapshot daemon for ten provider keys.
- Xeneon Edge-oriented Tauri board with live subagent trees, unread results,
  timers, safe activity categories, actions, quota meters, and token trends.
- Managed Pi, oh-my-pi, and Grok adapters plus documented manual setup for
  Claude, Codex, Kimi, ZCode, and Qwen.
- Optional Paseo lineage/deep links and Evener AppWire inventory.
- MIT license, public setup/security documentation, and a source-only release
  boundary.

### Changed

- Synchronized semantic versioning across `package.json`, Tauri, and Cargo,
  with `scripts/bump-version.sh` for drift checks and future bumps.
- Registry schema 14 clears legacy raw activity text; new activity displays
  use fixed semantic categories only.
- Evener thread-list hydration is bounded before any registry update.
- The deprecated Stream Deck source remains build-tested but is not included
  in supported installation or binary distribution.
