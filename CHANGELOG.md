# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-08-26

First versioned release. Dealerboard — daemon plus strip app — is in daily
production use: a bank of live lines to every coding agent, lamps for who
needs attention, press to barge in.

### Changed

- Renamed the project from stream-deck-agents to dealerboard: binary,
  LaunchAgent, data dir, app bundle, provider shims/hooks, and the
  deprecated Elgato plugin identity (`com.drewritter.dealerboard.sdPlugin`,
  matching UUIDs, and its bundled profile).
- Replaced the Tauri scaffold's placeholder `0.1.0` with real semver,
  synced across `package.json`, `tauri.conf.json`, and `Cargo.toml`.

### Added

- `scripts/bump-version.sh` + `.version-bump.json` — bump all declared
  version files in one step, with drift detection (`--check`) and a
  repo-wide audit for undeclared version strings (`--audit`).
