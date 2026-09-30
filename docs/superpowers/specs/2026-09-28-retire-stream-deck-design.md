# Retire the deprecated Stream Deck integration

## Problem

The Stream Deck integration is deprecated but still fully present and built:

- `src/plugin/` holds fourteen modules (~1,500 lines), including the plugin
  entry (`plugin.ts`), a 429-line controller, the animation scheduler, and six
  session-activation adapters.
- Packaging ships in the source tree: `rollup.config.mjs` and
  `com.drewritter.dealerboard.sdPlugin/` (manifest plus seven tracked asset
  files).
- Seven dependencies exist only for it, including `@elgato/streamdeck`, which
  is a **production** dependency.
- `build:plugin` runs inside `bun run build`, which `bun run check` and CI
  both invoke, so the dead subsystem is compiled on every gate.
- Ten test files exercise it.

`README.md:352` documents the stance that keeps this alive: `src/plugin/` and
`sdPlugin/` are *"deprecated Stream Deck integration retained for regression
coverage,"* and `README.md:363` adds that it stays in `bun run build` *"so its
source keeps compiling."* This spec reverses that stance deliberately, not by
oversight.

## Goal

Remove the Stream Deck integration entirely — source, packaging, dependencies,
build steps, dead tests, and documentation references — while leaving strip-app
behavior, the registry, the daemon, the snapshot protocol, and the extensions
functionally unchanged.

The strip app reuses a small amount of pure code that currently lives under
`src/plugin/`. Three modules must survive, relocated to app-owned homes:

| `src/plugin/` symbol | App consumer |
| --- | --- |
| `PROVIDER_LETTERS`, `modelLabel` (`render.ts`) | `app/src/cards.ts` |
| `labelForSession` (`layout.ts`) | `app/src/board.ts` |
| `LayoutSettingsV1`, `DEFAULT_LAYOUT_SETTINGS`, `validateLayoutSettings` (`layout.ts`) | `app/src/board.ts` |
| `FOCUS_GHOSTTY_TERMINAL_SCRIPT` (`ghostty-focus.ts`) | `app/src/press.ts` |

Everything else in `src/plugin/` has no consumer outside the plugin and its
tests. Nothing in `src/core/`, `src/protocol.ts`, the daemon, the CLI, or
`extensions/` imports any of these symbols; verification during design showed
their only non-plugin consumers are `app/` and `test/`.

## Non-goals

- No change to strip-app behavior, layout, card anatomy, or visuals.
- No change to the snapshot-v2 protocol or its compatibility fields. Old
  *daemons* still exist and must keep interoperating.
- No change to the registry, projections, daemon, CLI, or evener collectors.
- No change to the extensions' functional contracts (only one misleading
  identifier is renamed).
- No change to the Tauri/Rust host.
- No change to the localStorage key or the persisted settings version.
- No replacement plugin, archive branch, or tarball of the retired source.

## Requirements

### Relocated modules

1. **`app/src/provider-marks.ts`** — exports `PROVIDER_LETTERS` and
   `modelLabel(model, maxCodePoints)` with its vendor-prefix table. The
   `render.ts` SVG tile renderer, `washCycleOffset`, `renderKey`, and all tile
   chrome constants do not move.
2. **`app/src/board-settings.ts`** — exports the persisted strip board settings
   contract:
   - `type BoardSettingsV1 = { schemaVersion: 1; currentPage: number }`
   - `DEFAULT_BOARD_SETTINGS`
   - `validateBoardSettings(stored: unknown): ValidatedBoardSettings`
   - `type ValidatedBoardSettings = { settings: BoardSettingsV1; defaulted: boolean }`
3. **`app/src/ghostty-focus.ts`** — a verbatim move of
   `FOCUS_GHOSTTY_TERMINAL_SCRIPT`.
4. **`labelForSession`** folds into `app/src/board.ts` rather than becoming a
   fourth module: it is eight lines, board-specific, and has exactly one
   consumer. Its `SessionLabelSource` parameter type moves with it.

### Renames

5. The inherited keypad vocabulary is renamed to the strip's own domain, since
   "layout" described the 5x3 keypad grid:
   - `LayoutSettingsV1` → `BoardSettingsV1`
   - `DEFAULT_LAYOUT_SETTINGS` → `DEFAULT_BOARD_SETTINGS`
   - `validateLayoutSettings` → `validateBoardSettings`
6. The extensions' default export `streamDeckAgents` is renamed to
   `dealerboardExtension` in `extensions/pi/dealerboard.ts` and
   `extensions/omp/dealerboard.ts`. The name is cosmetic (a default-export
   identifier nothing imports by name); the extension contract is unchanged.

### Persisted settings behavior

7. The localStorage key and `schemaVersion: 1` are **unchanged**. Existing
   stored values parse.
8. `overflowLatched` is dropped from the strip's settings type and validator.
   It was keypad paging state inherited from the deck; `reduceBoard` always
   wrote `false` and only read it to detect and rewrite a stale deck-era value.
   To avoid resetting a user's page on the first read after upgrade,
   `validateBoardSettings` continues to **tolerate unknown keys**, so a stored
   value that still carries `overflowLatched` validates normally.
9. `app/src/board.ts` stops reading and writing `overflowLatched`. This is the
   only intentional behavior delta, and it is a no-op for every value the strip
   itself has written since the board redesign.

### Deletions

10. Delete `src/plugin/` in full (fourteen modules).
11. Delete `rollup.config.mjs`.
12. Delete `com.drewritter.dealerboard.sdPlugin/` (manifest and seven tracked
    asset files).
13. Delete the ten tests that exercise only the retired surface:
    `test/controller.test.ts`, `test/scheduler.test.ts`,
    `test/session-ack.test.ts`, `test/claude-session-activation.test.ts`,
    `test/codex-session-activation.test.ts`,
    `test/evener-session-activation.test.ts`,
    `test/kimi-session-activation.test.ts`,
    `test/paseo-session-activation.test.ts`, `test/render.test.ts`, and
    `test/layout.test.ts`.

### Build and dependencies

14. `package.json` scripts: remove `build:plugin` and `pack:plugin`; `build`
    becomes `bun run typecheck && bun run build:core`.
15. Remove dependencies that exist only for the retired integration:
    `@elgato/streamdeck` (from `dependencies`), `@elgato/cli`,
    `@rollup/plugin-commonjs`, `@rollup/plugin-node-resolve`,
    `@rollup/plugin-terser`, `@rollup/plugin-typescript`, `rollup`, and
    `tslib`. `tslib`'s only reference in the repository is its `package.json`
    entry; it moves with the rollup TypeScript pipeline.
16. Refresh `bun.lock` with `bun install`; no `@elgato/*` or `rollup` entry may
    remain.
17. `app/tsconfig.json`: remove the explicit `../src/plugin/layout.ts` and
    `../src/plugin/render.ts` entries from `include`. The relocated modules are
    covered by the existing `src/**/*.ts` entry. `../src/protocol.ts` and
    `../src/quota-snapshot.ts` stay.
18. Configuration cleanup:
    - `.gitignore`: remove the now-dead
      `com.drewritter.dealerboard.sdPlugin/bin/` line.
    - `biome.json`: remove the `rollup.config.mjs` override (`noProcessEnv` and
      `noDefaultExport` off); it has no subject once the file is deleted. Keep
      `"*.mjs"` in `files.includes`, because
      `test/fixtures/quota/browser-check.mjs` remains.

### Documentation and residue

19. `README.md`: update the architecture diagram (drop the "deprecated Stream
    Deck UI" branch), the requirements bullet that declares Node 24+ *"for the
    deprecated Stream Deck integration,"* the repository-layout entry
    (`README.md:352`), and the release-scope paragraph (`README.md:359-366`).
    The `engines.node` field itself is unchanged; the README bullet is reworded
    to drop the retired rationale.
20. `docs/design.md`: update the component overview (`:16`, "the Stream Deck
    consumer is deprecated but remains build-tested") and the dismissal list
    (`:54`, "Stream Deck key press").
21. `SECURITY.md:40`: drop the Stream Deck plugin from the release-artifacts
    sentence.
22. `scripts/install-local.ts`: update the header comment that describes the
    plugin as deprecated-but-bundled.
23. `src/protocol.ts:4`: the header comment says the module is imported by "the
    Bun core and the Node.js Stream Deck plugin bundle"; reword to the Bun core
    and the strip app.
24. `CHANGELOG.md`: add a `### Removed` entry under `[Unreleased]`. Historical
    entries that mention the plugin are history and stay untouched.

## Files and boundaries

Expected implementation surface:

- `app/src/provider-marks.ts`, `app/src/board-settings.ts`,
  `app/src/ghostty-focus.ts` (new).
- `app/src/cards.ts`, `app/src/board.ts`, `app/src/press.ts` (import updates;
  `labelForSession` and its source type move into `board.ts`).
- `app/tsconfig.json`, `package.json`, `bun.lock`, `.gitignore`, `biome.json`.
- `test/strip-provider-marks.test.ts` and `test/strip-board-settings.test.ts`
  (new), `test/press.test.ts`, `test/protocol.test.ts`.
- `README.md`, `docs/design.md`, `SECURITY.md`, `scripts/install-local.ts`,
  `src/protocol.ts`, `CHANGELOG.md`.
- `extensions/pi/dealerboard.ts`, `extensions/omp/dealerboard.ts` (rename).

Deleted: `src/plugin/**`, `rollup.config.mjs`,
`com.drewritter.dealerboard.sdPlugin/**`, and the ten retired test files listed
above.

Deliberately unchanged:

- `src/core/**` and the daemon;
- `src/protocol.ts` fields and validation;
- snapshot-v2 parsing and its compatibility tests;
- `app/src/main.ts` and every strip rendering module other than the import
  updates above;
- the Tauri host and `app/src-tauri/**`.

## Testing

Deleted outright: the ten files in requirement 13.

Migrated coverage (the survivors from files that are otherwise deleted):

- `modelLabel` cases from `test/render.test.ts` move to a new
  `test/strip-provider-marks.test.ts`: vendor-prefix stripping, the code-point
  cap with ellipsis, the empty-after-strip fallback, and the
  `PROVIDER_LETTERS` map. All `renderKey`, `washCycleOffset`, and tile-chrome
  cases are dropped with the code.
- `validateBoardSettings` and `labelForSession` cases move to a new
  `test/strip-board-settings.test.ts`. They must cover: valid settings restore,
  out-of-range and wrong-typed settings default, unknown extra keys are
  tolerated (including a stored `overflowLatched`), and the label falls back
  title → project → `provider + short session id`. The paging/latch/SnapshotCache
  cases from `test/layout.test.ts` are dropped with their code.

Adjusted:

- `test/press.test.ts` imports `FOCUS_GHOSTTY_TERMINAL_SCRIPT` from the new
  path; assertions unchanged.
- `test/protocol.test.ts:549`: the "plugin compat" test keeps its assertions
  (they verify snapshot forward/back-compatibility with old *daemons*), but the
  name and comment drop the installed-plugin framing.

Commands:

- `bun run check` (biome ci + typecheck + `build:core` + `bun test`).
- `bun run build:app`.
- A residual-reference sweep for `src/plugin`, `sdPlugin`, `@elgato`, `rollup`,
  `build:plugin`, and `pack:plugin` across tracked files, excluding historical
  CHANGELOG entries and this spec.

`cargo test` and `bundle:app` are not required: nothing in this change touches
the Rust host.

## Acceptance criteria

1. `src/plugin/`, `rollup.config.mjs`, and
   `com.drewritter.dealerboard.sdPlugin/` no longer exist.
2. `package.json` has no `@elgato/*`, `rollup`, or `tslib` dependency, and
   `bun.lock` resolves none of them.
3. `bun run build` no longer builds a plugin, and `bun run check` passes.
4. The strip app builds and its existing test suite passes unchanged in
   behavior, including card rendering, board paging, press routing, and
   snapshot handling.
5. A stored `{schemaVersion: 1, overflowLatched: <bool>, currentPage: n}` value
   still restores its `currentPage` after the upgrade.
6. No tracked file references the retired integration except historical
   CHANGELOG entries and this spec.
7. The relocated modules keep their behavior under the migrated tests.

## Alternatives considered

- **Deactivate only** — keep `src/plugin/` and its tests, drop it from
  `build`/`check`, and remove packaging and dependencies. Smaller diff, but
  leaves ~1,000 lines of unbuilt code whose dependencies are no longer
  declared, so it silently rots. Rejected: the stated goal is retirement.
- **Move survivors to a top-level `src/shared/`.** Preserves a cross-surface
  namespace for a possible future deck revival, but creates a namespace with
  exactly one consumer. Rejected as speculative; `app/src/` states the truth
  that this is display and routing code.
- **Fold every survivor into its consumer.** Fewest files, but grows
  already-large `cards.ts`/`board.ts` and forces the survivor tests into
  unrelated suites. Rejected in favour of small app-owned modules that preserve
  the current pure-module plus focused-test pattern.
- **Move survivors verbatim, keeping `LayoutSettingsV1` and
  `overflowLatched`.** Lowest risk and no behavior delta, but carries keypad
  vocabulary and dead paging state into the strip forever. Rejected once the
  validator's tolerance of unknown keys made the drop safe for stored values.
- **Keep the dependencies after deleting the source.** Rejected: an unused
  production dependency (`@elgato/streamdeck`) is exactly the residue this
  change exists to remove.

## Open questions

None blocking. `engines.node` stays `>=24`; only the README rationale changes.
If the deck is ever revived, it returns as a new consumer of the app-owned
modules rather than as a reason to keep this code.

## Golden-question checklist

- [x] Data migration / existing-data impact: persisted board settings keep
      their localStorage key and `schemaVersion: 1`; the validator tolerates
      unknown keys, so a stored legacy `overflowLatched` still restores the
      page. No database, snapshot, or protocol migration.
- [x] Auth / permissions: N/A; no new surface, and the retired plugin's
      permissions disappear with it.
- [x] Failure / retry behavior: unchanged; no daemon, collector, or snapshot
      path is touched.
- [x] Rollback path: revert the commit; all deletions are recoverable from git
      and no stored state is rewritten.
- [x] Observability / logging: only the retired plugin's own diagnostics are
      removed; daemon and app logging are unchanged.
- [x] Backward compatibility: snapshot-v2 fields and their compatibility tests
      stay, because old daemons remain. Old *plugin* interoperability is no
      longer a goal.
- [x] Physical-display legibility: N/A; this change does not alter rendering.
