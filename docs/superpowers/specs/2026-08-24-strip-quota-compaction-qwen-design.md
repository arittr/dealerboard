# Strip quota compaction + Qwen panel

Date: 2026-08-24

## Problem

The Xeneon strip's right rail stacks one four-line quota panel per provider
(head, bar, meta+sparkline, weekly). With four providers (claude, codex, kimi,
GLM/zai) the rail already overflows the 720px strip and scrolls; adding the
requested fifth (Qwen) makes it worse. The current panels also read as
visually noisy (floating sparkline, sparse lines).

## Goals

1. All five quota panels plus the fixed rail sections (health, token usage,
   unread, pager) fit the strip height with no scrolling.
2. Add a Qwen quota panel sourced from CodexBar.
3. Keep the quota snapshot contract stable (no schema bump).

## Data layer

- `QUOTA_PROVIDER_KEYS` gains `"qwen"` (contract order: claude, codex, kimi,
  zai, qwen). `schemaVersion` stays 1: `parseQuotaSnapshot` ignores unknown
  provider keys, so an older strip app reading a newer daemon's file simply
  drops the qwen row, and a newer strip on an older daemon shows no qwen row.
- The collector (`src/core/quota.ts`) maps each contract key to its CodexBar
  `--provider` argument; qwen maps to `alibabatokenplan` (Alibaba Token Plan,
  the only qwen-family provider enabled in the local CodexBar config, region
  `intl-personal`). The other four map to themselves.
- Auth caveat (out of scope, documented): CodexBar fetches Token Plan via
  browser cookies; a daemon- or shell-spawned CodexBarCLI cannot read Safari's
  cookie store without Full Disk Access (or a manual Cookie header pasted in
  CodexBar settings). Until that is fixed the qwen row renders in the existing
  dimmed unavailable treatment — the same failure path every provider already
  uses. No new code path needed.

## Rail rendering

Each quota panel becomes exactly two lines; the sparkline, meta line, and
standalone weekly line are dropped (the history ring stays in the snapshot
contract, still recorded, just not rendered):

- Head line: provider chip, label, then right-aligned session percent
  remaining in bright text plus the reset countdown in muted text
  (`79% · 26m`); unavailable panels show the existing muted
  `updated Xm ago` / `unavailable` text instead, and dim as today.
- Bar line: the session bar (status-palette fill, unchanged thresholds)
  flexing to the available width, with the weekly summary right of it in
  muted text when present (`wk 94% · 3d`).

View-model (`app/src/quota.ts`) replaces `formatWeeklyLine`,
`quotaStatusText`, and `sparklinePoints` with:

- `formatSessionPercent(model)` — `"—"` when the percent is null, else the
  rounded percent (last-good numbers keep showing while unavailable).
- `formatSessionNote(model, now)` — muted right text: `updated Xm ago` /
  `unavailable` for unavailable panels; `resetting…` or the bare countdown
  for ok panels; empty when there is no reset instant.
- `formatWeeklySummary(percent, resetAtMs, now)` — `wk 88% · 4d` /
  `wk 88%` / null.

Qwen chrome: label "Qwen", chip letter `Q`, chip hue `#8B5CF6` (distinct from
the rail set's orange/magenta/blue/teal).

## Tests

- `test/quota.test.ts`: five providers; the qwen probe is asserted to spawn
  `--provider alibabatokenplan` with a new `codexbar-qwen.json` fixture;
  pass-count expectations move 4 → 5.
- `test/strip-quota.test.ts`: provider order includes qwen; the replaced
  formatting helpers get branch coverage mirroring the old tests.
- `test/quota-snapshot.test.ts`: qwen joins the kimi/zai key-parsing test.

## Docs

`docs/design.md` rail quota bullet and the AGENTS.md quota sentence are
updated to the five-provider, two-line-row contract with the qwen →
`alibabatokenplan` mapping.

## Non-goals

No schema bump, no history-ring removal, no keypad/plugin changes, no daemon
deploy (a live qwen row needs the usual `bun scripts/install-local.ts`
reinstall so the daemon polls the new provider).
