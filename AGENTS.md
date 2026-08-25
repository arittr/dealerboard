# AGENTS.md

## Issue tracking

- NEVER create, search, read, update, or otherwise use Linear tickets for work
  in this repository. This repository-level rule overrides any generic Linear
  ticket lifecycle workflow.

## Build and test

- `bun test` — run the test suite.
- `bun run typecheck` — type-check without emitting.
- `bun run build` — typecheck, compile the core daemon (`dist/stream-deck-agents`), and bundle the plugin (`com.drewritter.stream-deck-agents.sdPlugin/bin/plugin.js` via rollup).
- `bun run build:plugin` — plugin bundle only (sufficient for render/layout changes).

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


## Deploying plugin changes locally

The Stream Deck app does NOT run the repo's `.sdPlugin` directory. It runs an
installed copy at:

```
~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.drewritter.stream-deck-agents.sdPlugin
```

Source edits are invisible on the device until the bundle is rebuilt, copied
over, and the plugin process restarted. Bump `Version` in
`com.drewritter.stream-deck-agents.sdPlugin/manifest.json` first — the Stream
Deck app ignores updates whose version is not newer:

```sh
# edit manifest.json: bump "Version"
bun run build:plugin
cp com.drewritter.stream-deck-agents.sdPlugin/manifest.json \
  "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.drewritter.stream-deck-agents.sdPlugin/manifest.json"
cp com.drewritter.stream-deck-agents.sdPlugin/bin/plugin.js{,.map} \
  "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.drewritter.stream-deck-agents.sdPlugin/bin/"
bun node_modules/@elgato/cli/bin/streamdeck.mjs restart com.drewritter.stream-deck-agents
```

Notes:

- Only the plugin process restarts; the launchd daemon is untouched. Core
  changes under `src/core/` instead need `bun scripts/install-local.ts` (full
  reinstall: daemon, plist, packaged plugin).
- The installer fails safe on two deploy hazards: it refuses up front —
  before the executable swap or daemon bootout — when the installed
  database's schema is newer than the build being installed, and it waits
  for the Stream Deck app to actually install the packaged plugin version
  (accept the app's confirmation dialog; at 120s unconfirmed it fails, and
  a re-run converges).
- The plugin and daemon deploy in lockstep: the plugin's snapshot parser
  rejects unknown provider keys, so a new daemon with an old plugin degrades
  the grid — and the manifest `Version` bump above is what makes the plugin
  update actually stick.
- If the deployed copy and repo should stay in sync permanently, use
  `streamdeck link` to point the app at the repo's `.sdPlugin` instead of
  copying (not currently set up).

## Conventions

- Tile rendering lives in `src/plugin/render.ts` (pure SVG string functions,
  no SDK imports). Status frame colors: working `#20B8FF`, waiting `#FFB020`,
  idle `#4ADE80`, error `#FF4D67`; `COLOR_NEUTRAL` `#94A3B8` is non-status
  chrome only (NEXT frame, page count, OFFLINE text). Provider corner chips
  carry a one-letter mark (`PROVIDER_LETTERS`: Claude C, Codex X, Kimi K, pi
  P, omp O, zcode Z, deepseek D, grok G, qwen Q) on hues picked for mutual
  distinctness on the LCD panel, not brand fidelity (`PROVIDER_COLORS`):
  Claude `#D97757`, Codex `#D946EF`, Kimi `#3B82F6`, pi `#0EA514`, omp
  `#F5F0EA`, zcode `#EAB308`, deepseek `#2DD4BF`, grok `#F472B6`, qwen
  `#EF4444`. Session
  tiles also carry the model id as neutral-chrome text right of the chip
  (vendor prefix stripped, ten-code-point cap); the registry stores the raw
  id (schema v6 `model` column; the v8 repair backfills it into pre-merge v7
  databases that were
  stamped without it, so every v8-or-later database has it), Kimi, pi, and
  qwen push it at session start (pi via its shim's `session_start`), and the daemon
  resolves Claude/Codex ids (transcript tails) and grok's id (summary.json)
  in the same maintenance pass as titles (last `"model":"…"` in the tail
  wins). Null never clears a stored model.
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
  A tile's effective status is the max (`error > waiting > working > idle`)
  over its whole subtree, and any live subagent row lifts it to at least
  `working` (`src/core/projection.ts`). `status_since` (schema v11) records
  the row's own last status transition: Activity/Attention/Stop/StopFailure
  restamp it only when the status value actually changes, BackgroundWork
  events never restamp it, starts initialize it, and the projection's
  subtree-lifted effective status never touches it — a parent held working
  by live children shows its own timer.
- Unread ledger and grid visibility: a turn ending — a Stop that settles to
  idle, or StopFailure — stamps `unread_since` (added in schema v7; v8 was a
  shape-repair stamp; the current latest, v11, adds `status_since`
  (backfilled from `updated_at`), `origin_parent_ref`, and `activity_line`;
  v10 widened the provider CHECK for grok (v9 added the `acked_at`
  watermark));
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
  storage hygiene, not visibility) and on the grid idle ⟺ unread.
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
  to the `acked_at` watermark; a difference-guard keeps
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
- Tile labels prefer the session title over the project name. Kimi and pi
  push titles via hook events (pi's shim pushes on `session_info_changed`,
  fired by `/name`); the daemon resolves Claude titles from the transcript's
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
  and activity lines every 2s, the Paseo overlay every 2s, prune every 60s)
  and rewrites the snapshot every 5s as a heartbeat. The plugin treats a
  snapshot older than 10s as a dead daemon and renders the degraded
  treatment (OFFLINE / "!" flags).
- The Xeneon strip app is a third snapshot consumer: `app/` is the webview
  (frontend sources plus `styles.css`) and `app/src-tauri/` is the Rust
  crate. `bun run build:app` bundles the frontend, `dev:app` runs the Tauri
  dev shell, `bundle:app` produces the release `.app` bundle, and
  `install:app` installs it into /Applications. It reads the same snapshot
  file as the plugin — the daemon and the plugin are unchanged. Strip
  geometry is a second `LayoutGeometry`, `STRIP_GEOMETRY` in
  `src/plugin/layout.ts` (up to 15 square tiles per page; the measured tile
  area chooses the largest packing across at most 3 rows, capped at the
  three-across square size; rail pages, no NEXT tile; the rail occupies 32%
  of the strip width). Tile visuals
  live in `app/styles.css` + `app/src/tiles.ts`, a web-native port of
  `render.ts` — keep the two in sync via `docs/design.md`. Strip-only tile
  extras (no keypad counterpart): an amber unread dot (the exact
  `unreadSince` ledger flag), a ticking `statusSince` timer line, and an
  `activityLine` footer; the timer rewrites `textContent` in place on the
  1s rail cadence so the `renderedSignature` skip is never disturbed. The
  window pins to the monitor whose model string matches "xeneon edge" or
  whose physical resolution is 2560×720 (physical, so a scaled 1280×360
  HiDPI mode still matches), re-pins on reconnect, and autostarts at login.
  The rail's unread count is exact: sessions with a non-null `unreadSince`.
- Quota panels (claude, codex, kimi, GLM/zai, Qwen) ship in the rail as
  compact two-line rows (head: chip, label, a tag pill naming the binding
  window, percent remaining plus its reset countdown; second line: the
  status-palette bar filled to the binding window with a neutral tick at
  every other window's percent — no sparkline); the binding window is the
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
  `Spark Weekly`); the widget-snapshot fallback publishes none — and
  publishes `quota-snapshot.json` (`schemaVersion` 2; the strip's reader
  also accepts v1, so daemon and app update in either order; bounded history
  ring of session-window samples; contract in `src/quota-snapshot.ts`) via
  the `writeFileAtomically` primitive; the strip reads it through the
  `read_quota_snapshot` Tauri command and renders from the pure view-model in
  `app/src/quota.ts`. A missing CodexBar binary or a provider disabled in the
  CodexBar app omits that provider entirely. `snapshot-v2.json` and
  `src/protocol.ts` stay untouched, and nothing CodexBar prints is ever
  logged or persisted.
- A token-usage block ships in the rail in place of the old clock: the
  daemon's token-usage collector (`src/core/token-usage.ts`, started from
  `cli.ts`, 30s cadence, 15s run timeout) shells out to the local
  `agentsview` helper (`AGENTSVIEW_BIN` override, else /opt/homebrew/bin,
  else PATH) for the America/Los_Angeles day's cumulative total — input +
  output + cacheCreation + cacheRead across all agents — keeps a 288-sample
  ring (~2.4h), and publishes `token-usage-snapshot.json` (own
  `schemaVersion`; contract in `src/token-usage-snapshot.ts`); the strip
  reads it through the `read_token_usage_snapshot` Tauri command and renders
  today's total and, on one line below it, both rolling rates
  (`↑ 4.7M/hr · ↑ 1.3M/10m`), each rate colored by its own trend (deadband
  max(1000, 10% of the previous window)) from the pure view-model in
  `app/src/token-usage.ts`. agentsview output is never logged or persisted.
- Update `docs/design.md` when changing the visible tile contract (colors,
  layout, marks). Dated files under `docs/superpowers/` and
  `docs/verification/` are historical records — do not edit them.
