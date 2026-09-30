# Retire the Stream Deck Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the deprecated Stream Deck plugin from Dealerboard entirely — source, packaging, dependencies, build steps, dead tests, and documentation residue — while relocating the four symbols the strip app reuses into app-owned modules.

**Architecture:** Three pure modules move from `src/plugin/` into `app/src/` (`provider-marks.ts`, `board-settings.ts`, `ghostty-focus.ts`); `labelForSession` folds into the existing `app/src/board.ts`. The app never imports from `src/plugin/` again, so the entire plugin namespace, its rollup packaging, its `sdPlugin/` manifest, its seven dependencies, and its ten test files can be deleted without touching strip behavior, the daemon, or the snapshot protocol.

**Tech Stack:** Bun 1.3.14, TypeScript 7 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`), Biome 2.5.6, bun:test, Tauri (untouched).

**Spec:** `docs/superpowers/specs/2026-09-28-retire-stream-deck-design.md`

## Global Constraints

- Strip behavior does not change: no rendering, layout, card-anatomy, or gesture change.
- `src/core/**`, the daemon, the CLI, `src/protocol.ts` fields/validation, the snapshot-v2 compatibility path, and `app/src-tauri/**` are not modified.
- No change to the persisted localStorage key or `schemaVersion: 1`.
- `validateBoardSettings` must tolerate unknown keys, including a legacy `overflowLatched`, so existing stored pages are not reset.
- No new dependency may be added. This change only removes dependencies.
- The relocated modules must not import from `src/plugin/` or use Bun APIs; they stay pure so the browser bundle can import them.
- Code style: 2-space indent, double quotes, 120-column width, `import type` for type-only imports (Biome `useImportType`, `noUnusedImports`, `noUnusedVariables`, `noDefaultExport` are errors).
- Each task ends green. Run `bun run check` (Biome CI + typecheck + `build:core` + `bun test`) before the task's commit.
- The pre-commit hook runs Biome and typecheck on staged files; do not bypass it.

## Review Focus

Inputs and conditions the spec implies but no task's happy-path test exercises. Each is pinned to a test in the owning task.

1. **A stored board-settings value written by an older build still carries `overflowLatched`** (as a boolean, or even wrongly typed). A reasonable person expects their saved page to survive the upgrade rather than reset to page 1. → Task 2.
2. **A `currentPage` valid as a number but past the current page count** (the user dismissed sessions and the board shrank). A reasonable person expects clamping to the last page, not a reset to 0. → Existing `test/strip-board.test.ts` "clamps a persisted out-of-range page and reports dirty"; confirm it still passes in Task 2.
3. **A model id that is exactly a vendor prefix** (`"gpt-"`, `"claude-"`). A reasonable person expects the raw id to survive, not an empty chip label. → Task 1.
4. **A model id containing astral characters** (emoji). A reasonable person expects the cap to count characters, not UTF-16 code units that split a surrogate pair. → Task 1.
5. **A session with an empty-string title and project.** A reasonable person expects the label to fall through to `provider + short id`, never an empty card title. → Task 2.

---

### Task 1: Relocate provider marks to `app/src/provider-marks.ts`

**Files:**
- Create: `app/src/provider-marks.ts`
- Create: `test/strip-provider-marks.test.ts`
- Modify: `app/src/cards.ts:9`

**Interfaces:**
- Consumes: `Provider` from `src/protocol.ts`.
- Produces:
  - `PROVIDER_LETTERS: Record<Provider, string>`
  - `modelLabel(model: string, maxCodePoints: number): string`

- [ ] **Step 1: Write the failing test**

Create `test/strip-provider-marks.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PROVIDER_LETTERS, modelLabel } from "../app/src/provider-marks";

describe("modelLabel", () => {
  test("strips one known vendor prefix", () => {
    expect(modelLabel("claude-fable-5", 10)).toBe("fable-5");
    expect(modelLabel("gpt-5.6-luna", 10)).toBe("5.6-luna");
    expect(modelLabel("zai/glm-5.3", 10)).toBe("glm-5.3");
    expect(modelLabel("openai/o3", 10)).toBe("o3");
    expect(modelLabel("grok-4.6", 10)).toBe("4.6");
  });

  test("keeps an unprefixed id", () => {
    expect(modelLabel("k3", 10)).toBe("k3");
  });

  test("keeps the raw id when stripping would empty it", () => {
    expect(modelLabel("gpt-", 10)).toBe("gpt-");
    expect(modelLabel("claude-", 10)).toBe("claude-");
  });

  test("caps by code points with an ellipsis", () => {
    expect(modelLabel("someverylongmodel", 10)).toBe("someveryl…");
    expect(modelLabel("someverylongmodel", 6)).toBe("somev…");
    expect(modelLabel("k3", 6)).toBe("k3");
  });

  test("counts code points, not UTF-16 code units", () => {
    expect(modelLabel("🚀🚀🚀🚀🚀🚀", 3)).toBe("🚀🚀…");
  });
});

describe("PROVIDER_LETTERS", () => {
  test("maps every provider to its chip letter", () => {
    expect(PROVIDER_LETTERS).toEqual({
      claude: "C",
      codex: "X",
      kimi: "K",
      pi: "P",
      omp: "O",
      zcode: "Z",
      deepseek: "D",
      grok: "G",
      qwen: "Q",
      evener: "E",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/strip-provider-marks.test.ts`
Expected: FAIL — cannot resolve `../app/src/provider-marks`.

- [ ] **Step 3: Create `app/src/provider-marks.ts`**

Copy `PROVIDER_LETTERS` verbatim from `src/plugin/render.ts:71-82`, copy `MODEL_LABEL_PREFIXES` from `src/plugin/render.ts:39`, and copy `modelLabel` from `src/plugin/render.ts:222-232`. Import the type with `import type { Provider } from "../../src/protocol";`. Keep the `modelLabel` doc comment from the source (`src/plugin/render.ts:215-221`), but drop its "ten normally, six when the label must yield width to the descendant badge" sentence — that cap is the tile's concern and does not move. Add a one-line module header stating this is the strip's provider mark and model-label helper, split out of the retired plugin renderer.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/strip-provider-marks.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Point `app/src/cards.ts` at the new module**

Change `app/src/cards.ts:9` from `import { modelLabel, PROVIDER_LETTERS } from "../../src/plugin/render";` to `from "./provider-marks"`.

- [ ] **Step 6: Run the strip card tests and the full gate**

Run: `bun test test/strip-cards.test.ts && bun run check`
Expected: PASS. `src/plugin/render.ts` still exists and still owns its own copy; both copies coexist until Task 4.

- [ ] **Step 7: Commit**

```bash
git add app/src/provider-marks.ts app/src/cards.ts test/strip-provider-marks.test.ts
git commit -m "refactor(strip): move provider marks and model label into the app"
```

---

### Task 2: Relocate board settings and fold `labelForSession` into `board.ts`

**Files:**
- Create: `app/src/board-settings.ts`
- Create: `test/strip-board-settings.test.ts`
- Modify: `app/src/board.ts` (import block `:8-14`, `BoardResult.settings` `:281`, `reduceBoard` `:288-297`, plus the new label helper)
- Modify: `test/strip-board.test.ts` (add a `labelForSession` describe)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `type BoardSettingsV1 = { schemaVersion: 1; currentPage: number }`
  - `DEFAULT_BOARD_SETTINGS: BoardSettingsV1` (value `{ schemaVersion: 1, currentPage: 0 }`)
  - `type ValidatedBoardSettings = { settings: BoardSettingsV1; defaulted: boolean }`
  - `validateBoardSettings(stored: unknown): ValidatedBoardSettings`
  - `labelForSession(session: SessionLabelSource): string` exported from `app/src/board.ts`, with `type SessionLabelSource = Pick<ProjectedSession, "provider" | "sessionId" | "title" | "project">`

- [ ] **Step 1: Write the failing settings test**

Create `test/strip-board-settings.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_BOARD_SETTINGS, validateBoardSettings } from "../app/src/board-settings";

describe("validateBoardSettings", () => {
  test("restores a valid value", () => {
    expect(validateBoardSettings({ schemaVersion: 1, currentPage: 3 })).toEqual({
      settings: { schemaVersion: 1, currentPage: 3 },
      defaulted: false,
    });
  });

  test("defaults wrong-typed, wrong-version, and missing fields", () => {
    const invalid: unknown[] = [
      null,
      undefined,
      "page",
      42,
      [],
      { schemaVersion: 2, currentPage: 0 },
      { schemaVersion: 1, currentPage: -1 },
      { schemaVersion: 1, currentPage: 1.5 },
      { schemaVersion: 1, currentPage: "0" },
      { schemaVersion: 1 },
      { currentPage: 0 },
    ];
    for (const stored of invalid) {
      expect(validateBoardSettings(stored)).toEqual({ settings: DEFAULT_BOARD_SETTINGS, defaulted: true });
    }
  });

  test("tolerates unknown keys, including a legacy overflowLatched", () => {
    expect(validateBoardSettings({ schemaVersion: 1, overflowLatched: true, currentPage: 2 })).toEqual({
      settings: { schemaVersion: 1, currentPage: 2 },
      defaulted: false,
    });
    expect(validateBoardSettings({ schemaVersion: 1, overflowLatched: "yes", currentPage: 2 })).toEqual({
      settings: { schemaVersion: 1, currentPage: 2 },
      defaulted: false,
    });
    expect(validateBoardSettings({ schemaVersion: 1, currentPage: 2, future: "x" })).toEqual({
      settings: { schemaVersion: 1, currentPage: 2 },
      defaulted: false,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/strip-board-settings.test.ts`
Expected: FAIL — cannot resolve `../app/src/board-settings`.

- [ ] **Step 3: Create `app/src/board-settings.ts`**

Port `validateLayoutSettings` from `src/plugin/layout.ts:118-152`, renaming the public symbols per the spec (`LayoutSettingsV1`→`BoardSettingsV1`, `DEFAULT_LAYOUT_SETTINGS`→`DEFAULT_BOARD_SETTINGS`, `validateLayoutSettings`→`validateBoardSettings`, `ValidatedSettings`→`ValidatedBoardSettings`) and the file-local `isRecord` from `src/plugin/layout.ts:126-127`. Drop `overflowLatched` from the type, the default, and the validity predicate, so validity is exactly `schemaVersion === 1 && typeof currentPage === "number" && Number.isSafeInteger(currentPage) && currentPage >= 0`. The predicate already ignores keys it does not read, which is what makes a stored `overflowLatched` harmless. Add a one-line module header noting this is the strip's persisted page settings, superseding the plugin's layout settings.

- [ ] **Step 4: Run the settings test to verify it passes**

Run: `bun test test/strip-board-settings.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing `labelForSession` test**

Add to `test/strip-board.test.ts` (import `labelForSession` from `../app/src/board`):

```ts
describe("labelForSession", () => {
  const source = (over: Partial<Parameters<typeof labelForSession>[0]>) => ({
    provider: "claude" as const,
    sessionId: "abcdef1234567890",
    title: null,
    project: null,
    ...over,
  });

  test("falls back title, then project, then provider plus short session id", () => {
    expect(labelForSession(source({ title: "Fix the bug", project: "proj" }))).toBe("Fix the bug");
    expect(labelForSession(source({ title: null, project: "proj" }))).toBe("proj");
    expect(labelForSession(source({ title: "", project: "proj" }))).toBe("proj");
    expect(labelForSession(source({ title: null, project: null, provider: "kimi" }))).toBe("kimi abcdef12");
    expect(labelForSession(source({ title: null, project: "" }))).toBe("claude abcdef12");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/strip-board.test.ts`
Expected: FAIL — `labelForSession` is not exported from `../app/src/board`.

- [ ] **Step 7: Move `labelForSession` into `app/src/board.ts` and rewire the settings import**

In `app/src/board.ts`, replace the import block at `:8-14` with `import { DEFAULT_BOARD_SETTINGS, type BoardSettingsV1, validateBoardSettings } from "./board-settings";`. Add the file-local `SHORT_SESSION_ID_LENGTH = 8`, the exported `type SessionLabelSource` (copied from `src/plugin/layout.ts:75`) and the exported `labelForSession` (copied from `src/plugin/layout.ts:77-85`). Update `BoardResult.settings` (`:281`) to `BoardSettingsV1`, and in `reduceBoard` (`:288-297`) call `validateBoardSettings`, build `{ ...DEFAULT_BOARD_SETTINGS, currentPage }`, and drop the `restored.overflowLatched` term from `dirty`. The four `labelForSession(...)` call sites (`:81`, `:96`, `:114`, `:158`) are unchanged.

- [ ] **Step 8: Run the board tests and the full gate**

Run: `bun test test/strip-board.test.ts test/strip-board-settings.test.ts && bun run check`
Expected: PASS, including the pre-existing "clamps a persisted out-of-range page and reports dirty" case (Review Focus 2) and the paging/rendering suites.

- [ ] **Step 9: Commit**

```bash
git add app/src/board-settings.ts app/src/board.ts test/strip-board-settings.test.ts test/strip-board.test.ts
git commit -m "refactor(strip): move board settings into the app and fold in the session label"
```

---

### Task 3: Relocate the Ghostty focus script to `app/src/ghostty-focus.ts`

**Files:**
- Create: `app/src/ghostty-focus.ts`
- Modify: `app/src/press.ts:14`
- Modify: `test/press.test.ts:4`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces: `FOCUS_GHOSTTY_TERMINAL_SCRIPT: string`

- [ ] **Step 1: Create `app/src/ghostty-focus.ts`**

Copy the constant verbatim from `src/plugin/ghostty-focus.ts:7-24`. Rewrite the module header (currently `src/plugin/ghostty-focus.ts:1-6`): it should say this is the AppleScript the strip's press routing runs to focus a Ghostty terminal by id, kept as a dependency-free leaf so no `node:child_process` leaks into the browser bundle.

- [ ] **Step 2: Repoint both importers**

Change `app/src/press.ts:14` to `import { FOCUS_GHOSTTY_TERMINAL_SCRIPT } from "./ghostty-focus";` and `test/press.test.ts:4` to `import { FOCUS_GHOSTTY_TERMINAL_SCRIPT } from "../app/src/ghostty-focus";`.

- [ ] **Step 3: Run the routing and press tests**

Run: `bun test test/press.test.ts test/strip-routing.test.ts`
Expected: PASS — `test/press.test.ts` still asserts the script is passed to `focusGhostty` with the terminal id.

- [ ] **Step 4: Commit**

```bash
git add app/src/ghostty-focus.ts app/src/press.ts test/press.test.ts
git commit -m "refactor(strip): move the Ghostty focus script into the app"
```

---

### Task 4: Delete the Stream Deck source, tests, and packaging

Every app consumer now imports its own copy, so the plugin namespace is unreferenced and can go.

**Files:**
- Delete: `src/plugin/` (all 14 modules)
- Delete: `rollup.config.mjs`
- Delete: `com.drewritter.dealerboard.sdPlugin/` (manifest plus 7 tracked assets)
- Delete: `test/controller.test.ts`, `test/scheduler.test.ts`, `test/session-ack.test.ts`, `test/claude-session-activation.test.ts`, `test/codex-session-activation.test.ts`, `test/evener-session-activation.test.ts`, `test/kimi-session-activation.test.ts`, `test/paseo-session-activation.test.ts`, `test/render.test.ts`, `test/layout.test.ts`
- Modify: `app/tsconfig.json` (remove the two `../src/plugin/*` entries from `include`)
- Modify: `package.json` (remove `build:plugin` and `pack:plugin`; `build` becomes `bun run typecheck && bun run build:core`)

**Interfaces:**
- Consumes: Tasks 1–3 (the app no longer imports `src/plugin/`).
- Produces: a repository whose `bun run check` compiles no plugin.

- [ ] **Step 1: Confirm no remaining importers before deleting**

Run: `grep -rn "src/plugin" app/src test --include=*.ts`
Expected: no output. If anything prints, stop — a consumer was missed.

- [ ] **Step 2: Delete the source, packaging, and tests**

```bash
git rm -r src/plugin com.drewritter.dealerboard.sdPlugin rollup.config.mjs
git rm test/controller.test.ts test/scheduler.test.ts test/session-ack.test.ts \
  test/claude-session-activation.test.ts test/codex-session-activation.test.ts \
  test/evener-session-activation.test.ts test/kimi-session-activation.test.ts \
  test/paseo-session-activation.test.ts test/render.test.ts test/layout.test.ts
rm -rf com.drewritter.dealerboard.sdPlugin
```

The final `rm -rf` clears any local gitignored `bin/` output left under the packaging directory.

- [ ] **Step 3: Drop the stale typecheck includes**

In `app/tsconfig.json`, remove `"../src/plugin/layout.ts"` and `"../src/plugin/render.ts"` from `include`, leaving `"src/**/*.ts"`, `"../src/protocol.ts"`, and `"../src/quota-snapshot.ts"`.

- [ ] **Step 4: Drop the plugin build steps**

In `package.json`, delete the `build:plugin` and `pack:plugin` scripts and change `build` to `"bun run typecheck && bun run build:core"`.

- [ ] **Step 5: Run the full gate**

Run: `bun run check`
Expected: PASS — Biome CI, typecheck for both tsconfigs, `build:core`, and the remaining 45 test files all green. `dist/` no longer receives a `plugin-stage`.

- [ ] **Step 6: Commit**

```bash
git add -A app/tsconfig.json package.json
git commit -m "chore: delete the deprecated Stream Deck plugin, its tests, and its packaging"
```

---

### Task 5: Remove the retired dependencies and config residue

**Files:**
- Modify: `package.json` (dependencies and devDependencies)
- Modify: `bun.lock` (via `bun install`)
- Modify: `biome.json` (remove the `rollup.config.mjs` override)
- Modify: `.gitignore` (remove the `com.drewritter.dealerboard.sdPlugin/bin/` line)

**Interfaces:**
- Consumes: Task 4 (nothing builds the plugin any more).
- Produces: a dependency set with no `@elgato/*`, no `rollup`, and no `tslib`.

- [ ] **Step 1: Remove the dependencies**

In `package.json`, delete `@elgato/streamdeck` from `dependencies`, and delete `@elgato/cli`, `@rollup/plugin-commonjs`, `@rollup/plugin-node-resolve`, `@rollup/plugin-terser`, `@rollup/plugin-typescript`, `rollup`, and `tslib` from `devDependencies`. Leave `@tauri-apps/*`, `@biomejs/biome`, `@types/*`, `lefthook`, and `typescript` untouched. `tslib` is removed as a *direct* dependency because it only fed the rollup TypeScript pipeline; it is also pulled in transitively by `rxjs` under the elgato CLI tree.

- [ ] **Step 2: Refresh the lockfile**

Run: `bun install`
Expected: exit 0; `bun.lock` rewritten without the removed packages.

- [ ] **Step 3: Verify the lockfile is clean**

Run: `grep -n "@elgato/\|@rollup/\|\"rollup\"" bun.lock`
Expected: no output. Then run `grep -n "tslib" bun.lock`; a remaining transitive `tslib` retained by another package is acceptable, but it must no longer appear under the root `devDependencies` block (`bun.lock` near the top). Direct-dependency removal plus a clean `bun run check` is the requirement; the lockfile purge of a transitive is a nice-to-have.

- [ ] **Step 4: Remove the dead config**

In `biome.json`, delete the override object whose `includes` is `["rollup.config.mjs"]`. Keep the `"*.mjs"` entry in `files.includes` — `test/fixtures/quota/browser-check.mjs` still needs it. In `.gitignore`, delete the `com.drewritter.dealerboard.sdPlugin/bin/` line.

- [ ] **Step 5: Run the full gate**

Run: `bun run check`
Expected: PASS with the reduced dependency tree.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock biome.json .gitignore
git commit -m "chore: drop the Stream Deck, rollup, and tslib dependencies"
```

---

### Task 6: Scrub the documentation and rename the extension export

**Files:**
- Modify: `README.md` (architecture diagram ~`:64`, requirements bullet `:78`, repository layout `:352`, release scope `:359-366`)
- Modify: `docs/design.md` (`:16`, `:54`)
- Modify: `SECURITY.md:40`
- Modify: `scripts/install-local.ts` (header `:1-8`)
- Modify: `src/protocol.ts:4`
- Modify: `CHANGELOG.md` (new `### Removed` entry under `[Unreleased]`)
- Modify: `test/protocol.test.ts:549-572` (reword the plugin-compat test)
- Modify: `extensions/pi/dealerboard.ts:420`, `extensions/omp/dealerboard.ts:412`

**Interfaces:**
- Consumes: Tasks 1–5 (the integration is gone).
- Produces: documentation with no claim that a Stream Deck integration exists, and an accurately named extension factory.

- [ ] **Step 1: Update `README.md`**

In the architecture diagram, replace the `deprecated Stream Deck UI` node and its edge so the daemon snapshot feeds only the macOS strip app. In the requirements list, reword the Node 24+ bullet to drop "for the deprecated Stream Deck integration" while keeping the requirement. In "Repository layout", delete the `src/plugin/` and `com.drewritter.dealerboard.sdPlugin/` entry. In "Release scope", delete the paragraph stating the integration is deprecated, remains in `bun run build`, and should not be packed.

- [ ] **Step 2: Update `docs/design.md`**

At `:16`, the component overview says "the Stream Deck consumer is deprecated but remains build-tested"; make the Tauri strip app the only thin consumer, with no second consumer described. At `:54`, remove "Stream Deck key press" from the list of dismissal paths.

- [ ] **Step 3: Update `SECURITY.md`, `scripts/install-local.ts`, and `src/protocol.ts`**

In `SECURITY.md:40`, drop "or Stream Deck plugin" from the release-artifacts sentence. In the `scripts/install-local.ts` header, replace the paragraph describing the plugin as deprecated-but-bundled with a statement that the installer manages only the daemon, LaunchAgent, shims, and grok hook. At `src/protocol.ts:4`, reword "imported by both the Bun core and the Node.js Stream Deck plugin bundle" to "imported by both the Bun core and the strip app", keeping the "free of runtime-specific and SDK imports" clause.

- [ ] **Step 4: Add the CHANGELOG entry**

Under `## [Unreleased]`, add a `### Removed` section: the Stream Deck integration is removed in full — its source, packaging, dependencies (`@elgato/streamdeck`, `@elgato/cli`, `rollup` and its plugins), `build:plugin`/`pack:plugin` scripts, and tests. Leave the historical `[1.1.0]` entry that mentions the plugin as history.

- [ ] **Step 5: Rename the extension export**

Rename the default export `streamDeckAgents` to `dealerboardExtension` in `extensions/pi/dealerboard.ts` and `extensions/omp/dealerboard.ts`. Update the one-line comment above each to match (pi's currently reads "pi's extension contract: a default-exported factory invoked with the ExtensionAPI."). Do not change the body or the extension contract.

- [ ] **Step 6: Reword the protocol compatibility test**

In `test/protocol.test.ts`, rename the test at `:549` from `"plugin compat: a snapshot carrying the five fields parses with values intact"` to `"a snapshot carrying the five data-surface fields parses with values intact"`, and replace the comment at `:550-553` so it describes interoperability with an older *daemon* rather than the installed plugin. Keep every assertion unchanged — the fields and their defaults are protocol compatibility, not plugin compatibility.

- [ ] **Step 7: Run the full gate and the residue sweep**

Run: `bun run check`
Expected: PASS.

Run: `grep -rn -i "stream deck\|streamdeck\|sdPlugin\|@elgato\|build:plugin\|pack:plugin\|src/plugin\|rollup" README.md SECURITY.md docs/design.md scripts src app test extensions --include=*.ts --include=*.md`
Expected: no output. Historical `CHANGELOG.md` entries and this plan and its spec are the only permitted mentions; if the sweep prints one, decide whether it is history or a missed reference.

- [ ] **Step 8: Commit**

```bash
git add README.md docs/design.md SECURITY.md scripts/install-local.ts src/protocol.ts CHANGELOG.md test/protocol.test.ts extensions/pi/dealerboard.ts extensions/omp/dealerboard.ts
git commit -m "docs: record the Stream Deck retirement and rename the extension export"
```
