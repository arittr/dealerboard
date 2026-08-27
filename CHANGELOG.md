# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Flick a slat vertically to dismiss it: a slat an ack would remove (an
  errored session or a viewed idle result) slides out and acks; live slats
  flash instead.

### Changed

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
