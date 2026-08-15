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
- If the deployed copy and repo should stay in sync permanently, use
  `streamdeck link` to point the app at the repo's `.sdPlugin` instead of
  copying (not currently set up).

## Conventions

- Tile rendering lives in `src/plugin/render.ts` (pure SVG string functions,
  no SDK imports). Status frame colors: working `#20B8FF`, waiting `#FFB020`,
  idle `#4ADE80`, error `#FF4D67`; `COLOR_NEUTRAL` `#94A3B8` is non-status
  chrome only (NEXT frame, page count, OFFLINE text). Provider corner chips:
  Claude `#D97757`, Codex `#A855F7`, Kimi `#3B82F6` (`PROVIDER_COLORS`).
- Session status model: `idle` = turn finished (set by the Stop hook),
  `working` = Activity, `waiting` = Attention, `error` = StopFailure. For
  Claude sessions, a Bash `run_in_background` PreToolUse arms the per-session
  `background_outstanding` flag (schema v3) and Stop then maps to `working`
  instead of `idle`; a `<task-notification>` prompt or a TaskStop PreToolUse
  disarms it. A tile's effective status is the max (`error > waiting > working
  > idle`) over its whole subtree, and any live subagent row lifts it to at
  least `working` (`src/core/projection.ts`).
- Session lifecycle: rows are deleted by SessionEnd hooks, by the daemon's
  stale prune (top-level rows with no hook for 24h, checked every minute;
  `sessions prune [hours]` manually), or by `sessions clear`/`clear-all`.
  Every provider late-joins on `UserPromptSubmit` (`SessionObserved`), so a
  session whose start hook was missed — or whose row was pruned while still
  alive — reappears at its next prompt.
- Tile labels prefer the session title over the project name. Only Kimi
  pushes titles via hooks; the daemon resolves Claude titles from the
  transcript's `ai-title` records (path stored in schema v4's
  `transcript_path`) and Codex titles from `~/.codex/session_index.jsonl`'s
  `thread_name` (`src/core/titles.ts`), writing them back without touching
  `updated_at` (the prune's aging signal). Titles word-wrap to two
  12-code-point lines with an ellipsis on overflow.
- The daemon is no longer read-only: it owns maintenance (titles every 2s,
  prune every 60s) and rewrites the snapshot every 5s as a heartbeat. The
  plugin treats a snapshot older than 10s as a dead daemon and renders the
  degraded treatment (OFFLINE / "!" flags).
- Update `docs/design.md` when changing the visible tile contract (colors,
  layout, marks). Dated files under `docs/superpowers/` and
  `docs/verification/` are historical records — do not edit them.
