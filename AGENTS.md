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
  `scripts/`, and root `*.json`/`*.mjs` only — the `.sdPlugin` directory is
  deliberately excluded. Style: 2 spaces, double quotes, semicolons, 120
  columns. Strict rules include `noExplicitAny`, `noEvolvingTypes`,
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
  P, omp O, zcode Z, deepseek D) on hues picked for mutual distinctness on
  the LCD panel, not brand fidelity (`PROVIDER_COLORS`): Claude `#D97757`,
  Codex `#D946EF`, Kimi `#3B82F6`, pi `#0EA514`, omp `#F5F0EA`, zcode
  `#EAB308`, deepseek `#2DD4BF`. Session tiles also carry the model id as
  neutral-chrome text right of the chip (vendor prefix stripped,
  ten-code-point cap); the registry stores the raw id (schema v6 `model`
  column; the v8 repair backfills it into pre-merge v7 databases that were
  stamped without it, so v8 — the latest version — always has it), Kimi
  pushes it via SessionStart, and the daemon resolves
  Claude/Codex ids in the same maintenance pass as titles (last
  `"model":"…"` in the tail wins). Null never clears a stored model. The
  Paseo origin pip uses `COLOR_ORIGIN_PASEO` `#A78BFA` (bottom-right):
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
  settles as `Stop`, i.e. idle). A tile's effective status is the max
  (`error > waiting > working > idle`) over its whole subtree, and any live
  subagent row lifts it to at least `working` (`src/core/projection.ts`).
- Unread ledger and grid visibility: a turn ending — a Stop that settles to
  idle, or StopFailure — stamps `unread_since` (added in schema v7; current
  latest is v8, a shape-repair stamp); a result landed.
  Only viewing clears it: a tile press acks via `sessions ack` (the plugin's
  sole plugin→daemon write, executed against the installed binary), the Paseo
  overlay reports the agent viewed, or a reused SessionStart re-opens the row.
  Prompts never mark read. Projection admits only top-level rows that are
  active or unread, so a read-and-idle row stays in the registry (the prune is
  storage hygiene, not visibility) and on the grid idle ⟺ unread.
- Origin (added in schema v7): hooks detect it at ingest (`src/core/origin.ts` —
  `PASEO_AGENT_ID` → paseo with the agent id as `origin_ref`, `TERM_PROGRAM`
  → terminal, else null) into `origin_kind`/`origin_ref`/`origin_subagent`.
  The daemon's Paseo overlay (`src/core/paseo.ts`, every 2s) scans
  `~/.paseo/agents/<workspace>/<agentId>.json`, joins on
  `persistence.sessionId` (fallback `runtimeInfo.sessionId`), stamps origin
  plus the subagent bit (`parentAgentId` present), and mirrors
  `requiresAttention` both ways — false clears unread (viewed in Paseo), true
  sets it without moving the first-news timestamp; a difference-guard keeps
  unchanged rows from dirtying the maintenance signal. Tile presses route
  paseo-first: a paseo-origin tile with a known ref opens
  `paseo://h/<serverId>/agent/<agentId>`, else falls back to provider routing.
- Session lifecycle: rows are deleted by SessionEnd hooks, by the daemon's
  stale prune (top-level rows with no hook for 24h — 1h for zcode —
  checked every minute; `sessions prune [hours]` manually), or by
  `sessions clear`/`clear-all`.
  Every provider late-joins on `UserPromptSubmit` (`SessionObserved`), so a
  session whose start hook was missed — or whose row was pruned while still
  alive — reappears at its next prompt.
- The pi/omp shims (`extensions/{pi,omp}/stream-deck-agents.ts`) are
  dependency-free structural host files (no host imports — jiti loads them
  bare) that spawn the helper detached, serialized through a FIFO queue so
  wire order matches emission order; wire payloads carry only canonical
  event names and allowlisted keys, omitted rather than nulled when absent
  (omit-don't-null); the installer substitutes the
  `__STREAM_DECK_AGENTS_EXECUTABLE__` token, writes atomically at mode 0600,
  and refuses to overwrite a same-named file lacking the managed marker
  (`// stream-deck-agents: managed shim v1`).
- Tile labels prefer the session title over the project name. Kimi and pi
  push titles via hook events (pi's shim pushes on `session_info_changed`,
  fired by `/name`); the daemon resolves Claude titles from the transcript's
  `ai-title` records (path stored in schema v5's `transcript_path`), Codex
  titles from `~/.codex/session_index.jsonl`'s `thread_name`, zcode titles
  from `~/.zcode/cli/db/db.sqlite` (`ZCODE_HOME` override), and omp titles
  from the fixed 256-byte title slot at the head of the session JSONL at the
  row's `transcript_path` (cached on `(mtime, size)`, safe because omp
  rewrites the slot in place on the otherwise append-only file) via
  `createSessionFactsResolver` in `src/core/titles.ts` — wired in `cli.ts`
  and driven by the daemon's 2s maintenance pass, it resolves model ids
  alongside titles. zcode's database is re-queried per pass, never
  stat-cached (WAL means committed titles can live in `db.sqlite-wal`
  without changing the main file's stat). Titles and models are written back
  without touching `updated_at` (the prune's aging signal). Titles word-wrap
  to two 12-code-point lines with an ellipsis on overflow.
- The daemon is no longer read-only: it owns maintenance (titles and models
  every 2s, the Paseo overlay every 2s, prune every 60s) and rewrites the
  snapshot every 5s as a heartbeat. The plugin treats a snapshot older than
  10s as a dead daemon and renders the degraded treatment (OFFLINE / "!"
  flags).
- Update `docs/design.md` when changing the visible tile contract (colors,
  layout, marks). Dated files under `docs/superpowers/` and
  `docs/verification/` are historical records — do not edit them.
