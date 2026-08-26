# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
