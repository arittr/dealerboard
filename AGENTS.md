# AGENTS.md

## Issue tracking

- NEVER create, search, read, update, or otherwise use Linear tickets for work
  in this repository. This repository-level rule overrides any generic Linear
  ticket lifecycle workflow.

## Build and test

- `bun test` — run the test suite.
- `bun run typecheck` — type-check without emitting.
- `bun run build` — typecheck, compile the core daemon (`dist/stream-deck-agents`), and bundle the plugin (`com.drewritter.stream-deck-agents.sdPlugin/bin/plugin.js` via rollup).
- `bun run build:plugin` — plugin bundle only (deprecated integration — see
  "Deploying changes locally"; the bundle keeps building but is never
  deployed).

## Lint, format, and hooks

- `bun run lint` / `bun run lint:fix` / `bun run format` — Biome check /
  autofix / format. `bun run check` is the full gate (`biome ci . && bun run
  build && bun test`); run it before considering work done.
- Biome (pinned, see devDependencies) lints and formats `src/`, `test/`,
  `scripts/`, `extensions/`, and `app/` (minus `app/src-tauri`), plus root
  `*.json`/`*.mjs` — the `.sdPlugin` directory is deliberately excluded.
  Style: 2 spaces, double quotes, semicolons, 120 columns. Strict rules
  include `noExplicitAny`, `noEvolvingTypes`,
  `noConsole`, `noProcessEnv` (env enters via `src/core/cli.ts` DI only),
  `noDefaultExport`, `noNonNullAssertion` (relaxed in `test/**`), and
  nursery `noFloatingPromises`; `useLiteralKeys` stays off because
  `noPropertyAccessFromIndexSignature` requires bracket access.
- tsconfig carries the full strictness set (`exactOptionalPropertyTypes`,
  `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`,
  `erasableSyntaxOnly`, etc.) — keep new code clean under all of them.
- Lefthook (pinned) runs pre-commit (Biome autofix on staged files +
  typecheck) and pre-push (`bun run check`); installed via `bun run prepare`.
  Lefthook globs are NOT standard: `*` spans `/`, and `dir/**/*.ts` matches
  nothing — keep the `*.ts` / `*.{ts,json,mjs}` forms in `lefthook.yml`.


## Deploying changes locally

Core changes under `src/core/` deploy with `bun scripts/install-local.ts`
(reinstalls the daemon executable, plist, pi/omp shims, and grok hook). The
installer fails safe: it refuses up front — before the executable swap or
daemon bootout — when the installed database's schema is newer than the
build being installed.

**The Elgato Stream Deck integration is deprecated.** The Elgato app is not
installed on this machine, `install-local.ts` neither packages nor installs
the plugin, and nothing launches or restarts it. The plugin source
(`src/plugin/`), its bundle directory
(`com.drewritter.stream-deck-agents.sdPlugin/`), and its tests stay in the
repo and must keep passing `bun run check` — but do NOT deploy plugin
changes, bump the manifest `Version`, or run `bun run pack:plugin` as part
of any workflow. To revive the integration: the Stream Deck app runs an
installed copy at `~/Library/Application
Support/com.elgato.StreamDeck/Plugins/com.drewritter.stream-deck-agents.sdPlugin`
(not the repo's `.sdPlugin` directory), accepts updates only when the
manifest `Version` is bumped, and `bun run pack:plugin` still produces the
installable package.

## Troubleshooting: exactly one daemon

Exactly one process — the installed daemon — may hold the registry:

```sh
lsof "$HOME/Library/Application Support/com.drewritter.stream-deck-agents/registry.sqlite3"
```

Run this first whenever the strip misbehaves in ways no single writer could
produce (values flapping between two states, titles reverting, phantom
unread). A daemon run from source (`bun src/core/cli.ts daemon`, e.g. from a
worktree during testing) uses the same production database and snapshot
paths as the installed daemon, so the two fight: their 2s maintenance passes
alternate writes (titles, unread stamps, prunes), both publish
snapshot-v2.json, and both shell out to the quota/token collectors. A
worktree daemon also runs whatever half-finished code that checkout holds.
Kill any stray (`ps -ef | grep "cli.ts daemon"`), and never leave one
running after a test — if you started a source daemon to verify a change,
stopping it is part of the change.

## Conventions

- Tile rendering lives in `src/plugin/render.ts` (pure SVG string functions,
  no SDK imports). Status frame colors: working `#20B8FF`, waiting `#FFB020`,
  idle `#4ADE80`, error `#FF4D67`; `COLOR_NEUTRAL` `#94A3B8` is non-status
  chrome only (NEXT frame, page count, OFFLINE text). Provider corner chips
  carry a one-letter mark (`PROVIDER_LETTERS`: Claude C, Codex X, Kimi K, pi
  P, omp O, zcode Z, deepseek D, grok G, qwen Q, Evener E) on hues picked for mutual
  distinctness on the LCD panel, not brand fidelity (`PROVIDER_COLORS`):
  Claude `#D97757`, Codex `#D946EF`, Kimi `#3B82F6`, pi `#0EA514`, omp
  `#F5F0EA`, zcode `#EAB308`, deepseek `#2DD4BF`, grok `#F472B6`, qwen
  `#EF4444`, Evener `#A3E635`. Session
  tiles also carry the model id as neutral-chrome text right of the chip
  (vendor prefix stripped, ten-code-point cap); the registry stores the raw
  id (schema v6 `model` column; the v8 repair backfills it into pre-merge v7
  databases that were
  stamped without it, so every v8-or-later database has it), Kimi, pi, and
  qwen push it at session start (pi via its shim's `session_start`), and the daemon
  resolves Claude/Codex ids (transcript tails) and grok's id (summary.json),
  while Evener publishes root and child models over AppWire: child starts
  retain their initial model, and update-only model-change events apply to
  existing roots or children, so heterogeneous siblings keep distinct models
  as they change. Null never clears a stored model.
  The Paseo origin pip uses `COLOR_ORIGIN_PASEO` `#A78BFA` (bottom-right):
  filled disc for a Paseo parent session, hollow ring for a Paseo subagent,
  nothing for terminal/native sessions.
- Session status model: `idle` = turn finished (set by the Stop hook),
  `working` = Activity, `waiting` = Attention, `error` = StopFailure. For
  Claude sessions, a Bash `run_in_background` PreToolUse arms the per-session
  `background_outstanding` flag (schema v3) and Stop then maps to `working`
  instead of `idle`; a `<task-notification>` prompt or a TaskStop PreToolUse
  disarms it. zcode has no SessionEnd hook (rows age out via the daemon's 1h
  zcode lease — `ZCODE_STALE_SESSION_TTL_MS`), no StopFailure event (zcode
  tiles never go `error`), and no interrupt event except `PostToolUseFailure`
  with `is_interrupt: true`, which maps to `Stop`; an interrupt between tool
  calls that fires no such event leaves the tile `working` until the next
  event or the lease. pi has no permission or question surface (a pi tile
  never shows `waiting`), and pi's `session_shutdown` maps to `SessionEnd`
  for every reason — `/new` and friends close the old row, and the new
  session re-registers via the next start or late-join. omp fires no
  StopFailure-equivalent (an omp tile never shows `error`; an interrupt
  settles as `Stop`, i.e. idle). qwen pushes no title (labels fall back to
  the project name), maps an interrupted turn's `PostToolUseFailure` with
  `is_interrupt: true` to `Stop` (like zcode), shows `error` on real
  `StopFailure` and `waiting` on `permission_prompt` Notifications, and
  `SessionEnd` owns removal under the standard 24h prune; its hooks live in
  `~/.qwen/settings.json` (manual, docs/hook-configuration.md). grok fires `StopCancelled` for
  interrupted/declined turns (mapped to `Stop`, i.e. idle), real `StopFailure`
  (tiles can show `error`), and `permission_prompt` Notifications (tiles can
  show `waiting`); grok has no background tracking, no subagent rows (its
  `subagentType` payloads are dropped), and no `SessionTitleChanged` push
  (titles are pulled). A grok `Stop` with a non-`end_turn` reason is the
  session-teardown observe fire and is dropped — `SessionEnd` owns removal.
  Evener is inventory-backed rather than hook-backed: AppWire `active` maps to
  working, plain `awaiting` is the ordinary post-reply state and maps to idle,
  `warning`/`systemError` map to error, and only `evener.askPending` or a
  non-empty `pendingEscalations` list maps to waiting. Settled awaiting
  subagents therefore remain removed instead of lifting their parents to
  waiting. Ordered `turn/completed` notifications own unread settlement, while
  cold hydration uses `SessionStatusObserved` to repair status without changing
  the unread ledger.
  Every projected node's effective status is the max
  (`error > waiting > working > idle`) over its native subtree, and any live
  native child row is at least `working` (`src/core/projection.ts`). The max
  then rolls up across separate top-level rows through Paseo lineage: every
  effectively active
  Paseo subagent aggregates its status upward along unique
  `originRef`/`originParentRef` ancestry (nested chains and cross-provider
  links included), so a done/read Paseo ancestor stays projected with a
  lifted effective status while any descendant is active — its stored
  status, `unread_since`, and own `status_since` timer unchanged — and
  ordinary visibility resumes once the last active descendant ends;
  missing, ambiguous, or cyclic lineage stops the walk safely, leaving
  those active subagents projected and available to the strip board's
  orphan-tail handling. `status_since` (schema v11) records
  the row's own last status transition: Activity/Attention/Stop/StopFailure
  restamp it only when the status value actually changes, BackgroundWork
  events never restamp it, starts initialize it, and the projection's
  subtree-lifted effective status never touches it — a parent held working
  by live children shows its own timer.
- Unread ledger and grid visibility: a turn ending — a Stop that settles to
  idle, or StopFailure — stamps `unread_since` (added in schema v7; v8 was a
  shape-repair stamp; v11 adds `status_since`
  (backfilled from `updated_at`), `origin_parent_ref`, and `activity_line`;
  v10 widened the provider CHECK for grok (v9 added the `acked_at`
  watermark), v12 adds Qwen to that CHECK, and the current v13 adds Evener);
  a result landed.
  Only viewing clears it: a tile press acks via `sessions ack` (the plugin's
  sole plugin→daemon write, executed against the installed binary), the Paseo
  overlay reports the agent viewed, or a reused SessionStart re-opens the row.
  The ack records its time in `acked_at`, and the overlay never resurrects
  unread from an attention flag raised at or before it.
  Prompts never mark read. Projection admits only top-level rows that are
  active or unread — except that an idle Paseo subagent is never admitted
  (its result is the orchestrating parent's to report, not the user's to
  ack) — so a read-and-idle row stays in the registry (the prune is
  storage hygiene, not visibility) and on the grid idle ⟺ unread; the
  Paseo lineage roll-up (see the status rule) is the one exception — a
  done/read Paseo ancestor, subagent or not, stays admitted with a lifted,
  never-idle effective status while any descendant is active, its
  `unread_since` untouched.
- Origin (added in schema v7): hooks detect it at ingest (`src/core/origin.ts` —
  `PASEO_AGENT_ID` → paseo with the agent id as `origin_ref`, `TERM_PROGRAM`
  → terminal, else null) into `origin_kind`/`origin_ref`/`origin_subagent`.
  The daemon's Paseo overlay (`src/core/paseo.ts`, every 2s) scans
  `~/.paseo/agents/<workspace>/<agentId>.json`, joins on
  `persistence.sessionId` (fallback `runtimeInfo.sessionId`), stamps origin
  plus the subagent bit (Paseo persists the dispatching agent as
  `labels["paseo.parent-agent-id"]`; a top-level `parentAgentId` is honored
  as a fallback) and the dispatching agent's id as `origin_parent_ref`, and
  mirrors `requiresAttention` both ways — false clears unread (viewed in
  Paseo), true sets it without moving the first-news timestamp and subject
  to the `acked_at` watermark. An archived record (`archivedAt` set) takes
  the cleared path even while its attention flag is still up — archiving is
  the user's terminal gesture — with the later of `archivedAt` and
  `updatedAt` as the proof-of-viewing time under the same freshness guard. The same pass un-stamps the origin metadata
  of any other top-level row still carrying the agent's ref from a
  rotated-away provider session (the row, its ledger, and its timers stay),
  so a missed SessionEnd never leaves a duplicate ref to ambiguate the
  lineage roll-up — skipped when the pass names more than one current
  session for the ref, which is ambiguous evidence; a difference-guard keeps
  unchanged rows from dirtying the maintenance signal. The loader normalizes
  record timestamps to canonical UTC (`Date.parse` + `toISOString`,
  unparseable → null) so the watermark's string comparisons stay
  chronological, and its per-file cache evicts entries missing from a pass
  so deleted agent records never accumulate. Tile presses route
  paseo-first: a paseo-origin tile with a known ref opens
  `paseo://h/<serverId>/agent/<agentId>`, else falls back to provider routing.
- Session lifecycle: rows are deleted by SessionEnd hooks, by the daemon's
  stale prune (top-level rows with no hook for 24h — 1h for zcode —
  checked every minute; `sessions prune [hours]` manually), or by
  `sessions clear`/`clear-all`.
  grok has a real SessionEnd and uses the standard 24h prune — no special
  lease.
  Evener rows come from the authenticated AppWire v3 feed: explicit
  `thread/closed` removes them, list omission never does (a hub list may be
  partial), reconnect hydration repairs retained rows, and the standard 24h
  prune is the missed-close backstop.
  Every provider late-joins on `UserPromptSubmit` (`SessionObserved`), so a
  session whose start hook was missed — or whose row was pruned while still
  alive — reappears at its next prompt. Kimi fires SessionStart eagerly for
  blank Web pages; those titleless starts register the row (which is what
  stores the session's model) but stay grid-invisible — idle and never
  unread — until the first prompt, and an abandoned page's row ages out via
  the prune.
- The pi/omp shims (`extensions/{pi,omp}/stream-deck-agents.ts`) are
  dependency-free structural host files (no host imports — jiti loads them
  bare) that spawn the helper detached, serialized through a FIFO queue so
  wire order matches emission order; wire payloads carry only canonical
  event names and allowlisted keys, omitted rather than nulled when absent
  (omit-don't-null); the installer substitutes the
  `__STREAM_DECK_AGENTS_EXECUTABLE__` token, writes atomically at mode 0600,
  and refuses to overwrite a same-named file lacking the managed marker
  (`// stream-deck-agents: managed shim v1`). The grok hook file
  `~/.grok/hooks/stream-deck-agents.json` is managed the same way (marker
  key `x-stream-deck-agents`, token substitution, atomic 0600 write,
  refusal without the marker).
- Evener needs no hook or plugin install. `src/core/evener.ts` connects to the
  local hub's `/rpc`, honoring `EVENER_HUB_ADDR`/`EVENER_HUB_AUTH_TOKEN`, then
  Evener's `hub.toml` and `<hub_state_root>/auth-token` defaults. The bearer
  capability stays in memory and is never logged or persisted; non-loopback
  endpoints are refused. The collector lists only source `local`, hydrates
  roots before live subagents, records each child start's own model, applies
  later root or child model changes only after membership exists, subscribes
  with one replace followed by additive subscriptions, refreshes every 2s,
  and retries disconnects every 5s.
  Evener does not publish a process-local `hub --addr` override; custom
  addresses must also be set durably in `hub.toml` (preferred) or in the
  Stream Deck Agents LaunchAgent's `EVENER_HUB_ADDR` environment.
- Tile labels prefer the session title over the project name. Paseo-origin
  rows take titles from the Paseo overlay alone — provider title events,
  resolver write-backs, and reused-start metadata refreshes all skip them,
  so a user's Paseo rename never oscillates with the provider's own title
  stream (which re-pushes its auto title as the session works). Kimi and pi
  push titles via hook events (pi's shim pushes on `session_info_changed`,
  fired by `/name`); Evener publishes generated/user-renamed titles and model
  changes over AppWire; the daemon resolves Claude titles from the transcript's
  `ai-title` records (path stored in schema v5's `transcript_path`), Codex
  titles from `~/.codex/session_index.jsonl`'s `thread_name`, grok titles
  and models from the `summary.json` under the session directory (globbed
  per target, `(mtime, size)`-cached, `GROK_HOME` override), zcode titles
  from `~/.zcode/cli/db/db.sqlite` (`ZCODE_HOME` override), and omp titles
  from the fixed 256-byte title slot at the head of the session JSONL at the
  row's `transcript_path` (cached on `(mtime, size)`, safe because omp
  rewrites the slot in place on the otherwise append-only file) via
  `createSessionFactsResolver` in `src/core/titles.ts` — wired in `cli.ts`
  and driven by the daemon's 2s maintenance pass, it resolves model ids and
  the strip's activity line alongside titles (claude/codex only: the last
  tool call in the transcript tail as `Tool target`, ≤64 code points, name
  plus a path/command head — never full arguments; written back only on
  change). zcode's database is re-queried per pass, never
  stat-cached (WAL means committed titles can live in `db.sqlite-wal`
  without changing the main file's stat). Titles, models, and activity lines
  are written back without touching `updated_at` (the prune's aging signal).
  Titles word-wrap to two 12-code-point lines with an ellipsis on overflow.
- The daemon is no longer read-only: it owns maintenance (titles, models,
  and activity lines every 2s, the Paseo overlay every 2s, the Evener AppWire
  collector, prune every 60s)
  and rewrites the snapshot every 5s as a heartbeat. The plugin treats a
  snapshot older than 10s as a dead daemon and renders the degraded
  treatment (OFFLINE / "!" flags).
- The Xeneon strip app is a third snapshot consumer: `app/` is the webview
  (frontend sources plus `styles.css`) and `app/src-tauri/` is the Rust
  crate. `bun run build:app` bundles the frontend, `dev:app` runs the Tauri
  dev shell, `bundle:app` produces the release `.app` bundle, and
  `install:app` installs it into /Applications. Snapshot v2 keeps the legacy
  root-only `sessions` list and adds optional-on-wire `agents`; absence parses
  as null and selects the old-daemon sessions/count fallback, while any
  present array, including `[]`, selects graph-exclusive Xeneon reduction.
  Stream Deck remains on `sessions` and `descendantCount`. The daemon validates
  native parentage atomically, resolves safe cross-provider Paseo parents, and
  publishes one mixed graph. The strip's app-local reducer
  (`app/src/board.ts`, per
  `docs/superpowers/specs/2026-08-25-strip-board-redesign-design.md` and
  `docs/superpowers/specs/2026-08-25-xeneon-live-subagent-tree-design.md`,
  summarized in `docs/design.md`'s strip section) sorts primary groups by
  logical slot, immediate native/Paseo children by `openedAt`, provider, and
  ID, and traverses them depth-first at one 44px indent. Missing, ambiguous,
  or cyclic Paseo roots form one deterministic full-width orphan tail while
  retaining safe descendants in depth-first order. Pages still fill
  group-atomically (a ≤6-card group never splits and may backfill a same-page
  gap, a 7–12 group needs a still-empty page and wraps at the six-row seam, a
  larger group fills whole pages) into two columns of six fixed 886×102 cards
  that never flex-resize, beside a fixed 760px (~29.7%) rail; page count derives
  from the packing and the persisted current page (`agent-strip.layout.v1`)
  clamps — the strip no longer consumes the shared
  `reduceLayout`/`STRIP_GEOMETRY` paging (the keypad keeps it unchanged). Card
  visuals
  live in `app/styles.css` + `app/src/cards.ts`, a web-native contract of
  `render.ts`'s status/chip system (status edge with border+wash on
  waiting/error, chip-corner unread dot with a ring, one-line
  italic-fallback title, 24-code-point model cap, meta-line project
  suppression for grouped subs, origin disc, sub pill + indent + violet
  spine) — keep them aligned via `docs/design.md`. Every graph child renders
  its own provider, model, title, effective status, and own `statusSince`
  timer. Graph cards never show a descendant badge; only the old-daemon
  fallback does. Native children always suppress unread and are display-only:
  no tap ack/route/flash and no long-press sheet or deferred action. Paseo
  children retain independent tap and action-sheet behavior. Finished native
  children disappear; there is no history or collapse. Strip-only card extras
  (no keypad counterpart) remain the amber unread dot (the exact `unreadSince`
  ledger flag where permitted), a ticking `statusSince` timer in the status
  row, and an `activityLine` footer; the timer rewrites `textContent` in place
  on the 1s rail cadence so the `renderedSignature` skip is never disturbed.
  The
  window pins to the monitor whose model string matches "xeneon edge" or
  whose physical resolution is 2560×720 (physical, so a scaled 1280×360
  HiDPI mode still matches), re-pins on reconnect, and autostarts at login.
  The rail's unread count is exact: sessions with a non-null `unreadSince`.
- Quota panels (claude, codex, kimi, GLM/zai, Qwen) ship in the rail as
  compact two-line rows (head: chip, label, a bare tag pill naming the
  binding window — no ` binds` suffix — with the muted reset countdown
  first (`26m ·`) at the right so the bright tabular percent aligns flush
  at the rail's edge; second line: the status-palette 8px bar filled to
  the binding window, with a 2px neutral tick at each non-binding
  window's percent — ticks only, no textual non-binding readouts); the
  binding window is the
  lowest percent remaining (ties: session > weekly > extras), and the
  daemon-health dot rides inline on the unread row (green ok, red plus
  OFFLINE when degraded) instead of its own line.
  The daemon's quota collector (`src/core/quota.ts`, started
  from `cli.ts`, own 120s cadence) shells out to the locally installed
  CodexBar CLI for every provider (`codexbar usage --provider <arg> --format
  json`, the arg the contract key except qwen → `alibabatokenplan`, per
  `CODEXBAR_PROVIDER_ARGS`; binary resolved per pass from
  `CODEXBAR_BINARY_CANDIDATES`, serialized spawns), classifies
  the returned windows by `windowMinutes` — weekly = the longest window of at
  least a day, session = the shortest under a day, `usage.extraRateWindows`
  always participates — an extra can be selected as the session window
  (codex's Spark 5-hour), and unselected extras publish as `extraWindows`
  (cap 8) with provider-name-stripped labels (claude's `Fable only`, codex's
  `Spark Weekly`); the widget-snapshot fallback publishes none.
  The collector still runs CodexBar for all five ambient providers. Once per
  same 120s pass it also resolves claude-swap from ~/.local/bin/cswap,
  /opt/homebrew/bin/cswap, then /usr/local/bin/cswap and runs only
  `list --json` with a 5s timeout. It allowlists numeric slot, active slot,
  5-hour/7-day/scoped windows, and source instants into Claude's additive
  `accounts` field; personal and credential fields and raw process output are
  never stored or logged. Two or more accounts render as stable numeric-slot
  meters under one Claude header; zero/one account or no binary uses the
  ambient row. A failed resolved probe keeps last-good account rows
  unavailable and is independent of ambient Claude.
  It publishes `quota-snapshot.json` (`schemaVersion` 2; the strip's reader
  also accepts v1, so daemon and app update in either order; bounded history
  ring of session-window samples; contract in `src/quota-snapshot.ts`) via
  the `writeFileAtomically` primitive; the strip reads it through the
  `read_quota_snapshot` Tauri command and renders from the pure view-model in
  `app/src/quota.ts`. A missing CodexBar binary or a provider disabled in the
  CodexBar app omits that provider entirely, except Claude is synthesized from
  non-empty claude-swap account rows. `snapshot-v2.json` and
  `src/protocol.ts` stay untouched, and nothing CodexBar prints is ever
  logged or persisted.
- A token-usage block ships in the rail: the
  daemon's token-usage collector (`src/core/token-usage.ts`, started from
  `cli.ts`, 30s cadence, 15s run timeout) shells out to the local
  `agentsview` helper (`AGENTSVIEW_BIN` override, else /opt/homebrew/bin,
  else PATH) for the America/Los_Angeles day's cumulative total — input +
  output + cacheCreation + cacheRead across all agents — keeps a 288-sample
  ring (~2.4h, the sole input to the rates), and publishes
  `token-usage-snapshot.json` (contract in `src/token-usage-snapshot.ts`)
  carrying date-keyed per-day cumulative curves in an additive top-level
  `dayCurves` key — `schemaVersion` stays 1 and the parser ignores unknown
  top-level keys, so daemon and app update in either order (an old app
  ignores the key; a new app on an old daemon renders no sparkline): points
  oldest-first with totals clamped to a running maximum (a sample at a
  repeated or stepped-back instant is dropped, so a backward clock never
  publishes a curve the parser rejects), at most 96 per
  day retaining first and latest, and rollover date-keyed (today promotes
  to yesterday only on the immediately preceding LA day, else yesterday
  nulls — an outage across midnight never promotes a stale curve, and
  restart seeding reconciles the same way); the strip
  reads it through the `read_token_usage_snapshot` Tauri command and renders
  today's total and, on one line below it, both rolling rates
  (`↑ 4.7M/hr · ↑ 1.3M/10m`), each rate colored by its own trend (deadband
  max(1000, 10% of the previous window)), plus a day-over-day sparkline
  (yesterday's adjacent complete curve dim with a `yda` micro-label under
  today's partial bright curve with a faint fill, x mapped by elapsed
  fraction of each day's actual length — DST-safe — on one shared zero-based
  y-scale) from the pure view-model in
  `app/src/token-usage.ts`. agentsview output is never logged or persisted.
- Update `docs/design.md` when changing the visible tile contract (colors,
  layout, marks). Dated files under `docs/superpowers/` and
  `docs/verification/` are historical records — do not edit them.
