# AGENTS.md

## Build and test

- `bun test` — run the test suite.
- `bun run typecheck` — type-check without emitting.
- `bun run build` — typecheck, compile the core daemon (`dist/stream-deck-agents`), and bundle the plugin (`com.drewritter.stream-deck-agents.sdPlugin/bin/plugin.js` via rollup).
- `bun run build:plugin` — plugin bundle only (sufficient for render/layout changes).

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
  `working` = Activity, `waiting` = Attention, `error` = StopFailure. A tile's
  effective status is the max (`error > waiting > working > idle`) over its
  whole subtree, and any live subagent row lifts it to at least `working`
  (`src/core/projection.ts`).
- Update `docs/design.md` when changing the visible tile contract (colors,
  layout, marks). Dated files under `docs/superpowers/` and
  `docs/verification/` are historical records — do not edit them.
