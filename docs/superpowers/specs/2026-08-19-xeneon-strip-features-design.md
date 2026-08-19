# Xeneon Strip Feature Set — Design Spec

Date: 2026-08-19
Status: approved-for-planning
Predecessor: `2026-08-18-xeneon-edge-strip-app-design.md` (the port this builds on)

## Context

The Xeneon Edge strip app (`app/` webview + `app/src-tauri/` Rust crate) is a
working port of the Stream Deck tile surface: it reads the same
`snapshot-v2.json` the daemon writes, renders the same tiles, and routes tile
presses. The strip is a 2560×720 touchscreen with a real web platform behind
it, so a class of features that were impossible on the Stream Deck's
per-key raster images is now available. This spec covers the first feature
set exploiting that.

Out of scope (discussed, deliberately dropped):

- **Notifications** — the harness/Paseo layer already owns "come look at
  this"; the strip would be a second, dumber doorbell.
- **Swipe-to-ack** — contradicts the locked membership rule "only viewing
  clears unread" (`docs/design.md`). Open question, not in this spec.

## Locked constraints (apply to every feature)

1. **Additive-only snapshot evolution.** The installed Stream Deck plugin
   parses the same `snapshot-v2.json`. New per-session fields MUST be
   optional-with-default in `parseSession` (the `model`/`originKind`
   precedent: missing key → default, unknown keys ignored). New providers
   or statuses remain forbidden — the parser rejects those.
2. **Tile contract sync.** Any change to what a tile shows must update
   `docs/design.md`. Strip visuals (`app/src/tiles.ts` + `app/styles.css`)
   are a port of `src/plugin/render.ts`; strip-only additions are fine, but
   shared anatomy changes must be mirrored or explicitly documented as
   strip-only.
3. **Biome/tsconfig gates.** `noExplicitAny`, `noEvolvingTypes`,
   `noConsole`, `noProcessEnv` (env enters via `src/core/cli.ts` DI only),
   `noNonNullAssertion` (relaxed in `test/**`), `exactOptionalPropertyTypes`,
   `noPropertyAccessFromIndexSignature` (bracket access), nursery
   `noFloatingPromises`. `bun run check` is the full gate.
4. **Historical docs are immutable.** Never edit existing dated files under
   `docs/superpowers/` or `docs/verification/`; new work gets new dated
   files.
5. **Daemon write-back discipline.** Titles/models are written back without
   touching `updated_at` (the prune lease). New per-pass write-backs
   (activity line) follow the same rule and write only on change.

## Feature 1 — Rich tile data surface

The daemon already knows more than it publishes. Ship five additive fields
on `ProjectedSession` (all `string | null`, all defaulting to `null` when
absent, so old daemon/new app and new daemon/old plugin interoperate):

| Snapshot field    | Source                                                        | Drives |
|-------------------|---------------------------------------------------------------|--------|
| `unreadSince`     | existing `unread_since` column (projection already reads it)  | per-tile unread dot; exact rail unread count (replaces the documented approximation in `app/src/main.ts`) |
| `statusSince`     | new `status_since` column (schema v11), stamped when a hook event changes the row's own status; backfilled from `updated_at` | "working 12m" / "waiting 3m" ticking timer on the tile |
| `activityLine`    | new `activity_line` column (schema v11), written by the daemon's maintenance pass from transcript tails (below) | per-tile footer: what the agent is doing right now |
| `transcriptPath`  | existing `transcript_path` column (schema v5)                 | "Reveal transcript" action (Feature 3) |
| `originParentRef` | new `origin_parent_ref` column (schema v11), stamped by the Paseo overlay from `labels["paseo.parent-agent-id"]` | data half of tree clusters (Feature 5) |

Decisions:

- **`statusSince` semantics.** It tracks the row's *own* status transitions
  (Activity → working, Attention → waiting, Stop → idle, StopFailure →
  error; `BackgroundWorkStarted/Cleared` do not restamp). The projection's
  subtree-lifted effective status does not restamp it — a parent held at
  `working` only by live children shows its own timer. Documented
  limitation, accepted.
- **`activityLine` v1 covers claude + codex only**, extracted by extending
  the existing `createSessionFactsResolver` transcript tail
  (`src/core/titles.ts`), which already reads the last 64 KiB on
  `(mtime, size)` change every 2s. Content: last tool call as
  `"ToolName target"` (target truncated; whole line ≤ 64 code points), else
  null. Tool *names* and short targets only — never arguments beyond a
  path/command head — matching the existing payload-minimality posture.
  Other providers get null; a hook-payload route (`tool_name` on Activity
  events) is a possible later upgrade and is NOT in this spec.
- **Schema v11** = three additive `ALTER TABLE active_sessions ADD COLUMN`
  statements (`status_since TEXT`, `origin_parent_ref TEXT`,
  `activity_line TEXT`), following the v6 `model`-column precedent.
  `status_since` backfills from `updated_at`; the others backfill null.
- **Rendering** (strip only; the Stream Deck tile anatomy is unchanged):
  unread dot, timer line, and activity footer land in `app/src/tiles.ts` +
  `app/styles.css`; the rail unread count switches to exact
  (`unreadSince !== null`). Timer ticks on the existing 1s rail cadence and
  must update `textContent` in place so the `renderedSignature` skip is not
  disturbed. `docs/design.md` gains a strip-only anatomy section.

## Feature 2 — File-watch snapshot push

Replace the frontend's 2s `setInterval` poll with push:

- Rust (`app/src-tauri/src/main.rs`): watch the app-support **directory**
  (not the file — the daemon publishes by atomic rename, which swaps
  inodes) with the `notify` crate; on events touching `snapshot-v2.json`,
  read it and emit a Tauri event carrying the same payload shape as
  today's `read_snapshot` (`{ mtimeMs, contents }`).
- Frontend (`app/src/main.ts`, `app/src/bridge.ts`): initial read via the
  existing command, then `listen` for the event; keep a slow (~10s) timer
  solely for the staleness check that renders OFFLINE when the daemon's 5s
  heartbeat dies. The `lastGood` degradation logic in
  `app/src/snapshot-view.ts` is unchanged.

## Feature 3 — Gestures

The touchscreen's first interactions, all app-side:

- **Long-press action sheet.** ~500ms pointerdown without movement on a
  tile opens a small overlay with: Open (existing press routing), Ack,
  Reveal transcript (`/usr/bin/open -R <transcriptPath>`; disabled when
  null), Copy session ID (`navigator.clipboard`), Clear session (new Rust
  command mirroring `ack_session`, invoking the installed binary's
  `sessions clear`; destructive → inline confirm step). Dismiss on
  pointer-up-outside / Escape.
- **Horizontal swipe paging.** A horizontal fling changes pages via the
  existing `jumpToPage`; page dots already render in the rail.
- **Touch validation is folded in, not a spike:** the first gesture task
  begins by logging `pointerdown`/`pointermove` on the panel to confirm the
  Xeneon delivers pointer events to the webview. If it doesn't, gestures
  stop at mouse-compatible behavior and the finding is reported.

## Feature 4 — Quota panels (codexbar-style)

Per-provider quota/usage panels in the rail, à la CodexBar: percent
remaining, reset countdown, and a burn-rate trend (will I run out before
the reset?).

- **Data path is separate from the session snapshot.** A new daemon-side
  collector (`src/core/quota.ts`) reads local provider credentials, polls
  the usage endpoints, and atomically writes `quota-snapshot.json` next to
  `snapshot-v2.json`. The session snapshot and the Stream Deck plugin are
  untouched.
- **v1 providers: codex + claude** (matching CodexBar's coverage). Exact
  endpoints/auth headers are a research task: read CodexBar's source and
  capture redacted response fixtures into `test/fixtures/` before
  implementing the parser.
- **Trend history lives in the file** (a bounded ring of
  `{ fetchedAt, fractionRemaining }` per provider, written by the daemon),
  so app restarts don't lose the trend.
- **Failure isolation.** Missing/expired creds or endpoint changes must
  never affect the session pipeline: the collector logs, marks the provider
  panel "unavailable", and keeps last-good data with a stale flag.
- **App side:** one new Tauri command `read_quota_snapshot` (same
  `{ mtimeMs, contents }` shape) and a rail section rendering bar + % +
  countdown + sparkline per provider.

## Feature 5 — Paseo tree clusters (spec-only, deferred)

Render a Paseo parent with its subagent tiles nested beneath it — the one
idea structurally impossible on the Stream Deck. The data half
(`originParentRef`) ships in Feature 1. The rendering half is deliberately
NOT planned yet: idle Paseo subagents are never admitted to the grid, so
the tree is a live, churning "orchestration in flight" visualization whose
layout (nesting, connectors, FLIP animation through constant child
appear/disappear) should be designed against the real panel, not blind.
Plan it after Features 1–4 ship, with the panel in hand.

## Lane structure (for execution)

- **Lane A — data surface** (Feature 1): core-heavy, TDD throughout.
  Plan: `docs/superpowers/plans/2026-08-19-xeneon-strip-data-surface.md`
- **Lane B — shell & interaction** (Features 2+3): app/Rust-side; depends
  on Lane A only for `transcriptPath` (degrades gracefully without it).
  Plan: `docs/superpowers/plans/2026-08-19-xeneon-strip-shell.md`
- **Lane C — quota panels** (Feature 4): fully independent file/IPC path.
  Plan: `docs/superpowers/plans/2026-08-19-xeneon-strip-quota.md`

Lanes A/B/C are parallel-safe (disjoint files except that B and A both
touch `app/src/main.ts`/`tiles.ts` — sequence those edits or rebase between
lanes). Feature 5 gets its own plan later.

## Verification

- Core: `bun test` (TDD per task), `bun run typecheck`, `bun run lint`.
- Plugin-compat: a protocol test proves a snapshot carrying the five new
  fields still parses, and that snapshots missing them parse with null
  defaults (this simulates old-plugin/new-daemon and new-app/old-daemon).
- App: `bun run build:app`, plus a manual on-panel checklist per plan
  (unread dot, timer tick, activity footer, push latency, gestures, quota
  panels).
- Full gate before done: `bun run check`.
