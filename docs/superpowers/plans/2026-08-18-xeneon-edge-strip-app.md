# Xeneon Edge Strip App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone Tauri 2 macOS app that renders the stream-deck-agents session grid on a Corsair Xeneon Edge 2560×720 strip — 4 web-native tiles + a status rail — consuming the existing daemon snapshot contract unchanged.

**Architecture:** The app is a third consumer of the daemon's `snapshot-v2.json`. The webview (TypeScript) polls the file via a tiny Rust command, reduces it with the shared (newly parameterized) layout reducer, and renders tiles as DOM/CSS — not the Stream Deck SVG renderer. Tile clicks ack via the installed daemon binary and route focus exactly like the plugin. The daemon (`src/core/`) and Stream Deck plugin behavior do not change.

**Tech Stack:** Bun + TypeScript (strict), Tauri 2 (WKWebView, Rust core), CSS keyframe animation, `bun test`.

Spec: `docs/superpowers/specs/2026-08-18-xeneon-edge-strip-app-design.md` (committed).

## Global Constraints

- Existing tests must pass unmodified; the only tolerated edit is adding `pageCount` to a whole-object `LayoutResult` assertion if one exists (Task 2 checks).
- Biome: 2-space indent, double quotes, semicolons, 120 cols; `noExplicitAny`, `noConsole` (scripts log via `process.stdout.write`), `noProcessEnv`, `noDefaultExport`, `noNonNullAssertion` (relaxed in `test/**`), nursery `noFloatingPromises` (void every fire-and-forget promise), `useImportType`.
- tsconfig strictness: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` (bracket access on index signatures, e.g. `dataset["keyIndex"]`), `verbatimModuleSyntax` (`import type` / `export type`), `erasableSyntaxOnly` (no enums, no parameter properties), `noPropertyAccessFromIndexSignature`.
- Tests: `bun test`, files in `test/`, `import { describe, expect, test } from "bun:test"`.
- Verification per task: `bun run typecheck`, targeted `bun test <file>`, `bun run lint`. Final gate before done: `bun run check`.
- Conventional commits (see `git log --oneline`).
- No new runtime dependencies for the webview beyond `@tauri-apps/api` and `@tauri-apps/plugin-autostart`. No Vite — frontend bundles via `bun build`.
- Environment already verified: `cargo 1.97.0`, `bun 1.3.14`. If cargo is missing at execution time, STOP and ask the user to install rustup.
- The snapshot file's parse cost at 2s intervals is negligible; the app re-parses every poll and gates DOM updates on a rendered-model signature instead of mtime-gating the parse (the staleness check must run every poll regardless, since a dead daemon's mtime stops changing).

---

### Task 1: Share `SnapshotView` via `src/protocol.ts`

The app type-checks and bundles `src/plugin/layout.ts`, which imports `SnapshotView` from `src/plugin/snapshot-reader.ts` — a module with a value-level `node:fs` import that must never enter the app graph. Moving the type into the runtime-agnostic contract module fixes this; `snapshot-reader.ts` re-exports it so no existing consumer changes.

**Files:**
- Modify: `src/protocol.ts` (after the `SessionSnapshotV2` type, ~line 97)
- Modify: `src/plugin/snapshot-reader.ts` (lines 22-31)

**Interfaces:**
- Consumes: nothing.
- Produces: `SnapshotView` exported from `src/protocol.ts`; `src/plugin/snapshot-reader.ts` continues to export it (re-export) so `src/plugin/layout.ts` and `src/plugin/controller.ts` are untouched.

- [ ] **Step 1: Move the type**

In `src/protocol.ts`, directly after the `SessionSnapshotV2` type:

```ts
export type SnapshotView = {
  snapshot: SessionSnapshotV2;
  degraded: boolean;
};
```

In `src/plugin/snapshot-reader.ts`, delete the local `SnapshotView` definition and change the protocol import:

```ts
import { parseSessionSnapshot, type SessionSnapshotV2, type SnapshotView } from "../protocol";

export type { SnapshotView } from "../protocol";
```

- [ ] **Step 2: Verify**

Run: `bun run typecheck && bun test test/layout.test.ts test/controller.test.ts`
Expected: PASS, no test edits needed.

- [ ] **Step 3: Commit**

```bash
git add src/protocol.ts src/plugin/snapshot-reader.ts
git commit -m "refactor(protocol): share SnapshotView for the strip app"
```

---

### Task 2: Parameterize `src/plugin/layout.ts` geometry (TDD)

The reducer's 15/14/15 constants are keypad-shaped. Parameterize them into a `LayoutGeometry`, keep the keypad values as the default export, and add the strip geometry (4 tiles, full-density pages, no NEXT tile — the rail pages externally). Also expose `pageCount` on `LayoutResult` for the rail's page dots.

**Files:**
- Modify: `src/plugin/layout.ts`
- Test: `test/layout.test.ts`

**Interfaces:**
- Consumes: `SnapshotView` (Task 1).
- Produces:
  - `type LayoutGeometry = { keyCount: number; pageSessionKeys: number; maxUnpagedSessions: number; nextKey: boolean }`
  - `const KEYPAD_GEOMETRY: LayoutGeometry` (15/14/15/nextKey:true) — the default
  - `const STRIP_GEOMETRY: LayoutGeometry` (4/4/4/nextKey:false)
  - `reduceLayout(view: SnapshotView, storedState: unknown, geometry?: LayoutGeometry): LayoutResult`
  - `advanceLayoutPage(view: SnapshotView, storedState: unknown, geometry?: LayoutGeometry): LayoutResult`
  - `LayoutResult` gains `pageCount: number`

- [ ] **Step 1: Write the failing tests**

Append to `test/layout.test.ts` (the existing `session`/`sessionsAt`/`healthyView`/`settings`/`sessionKeyAt`/`range` helpers are in scope in this file). Add `STRIP_GEOMETRY` to the import from `../src/plugin/layout`:

```ts
describe("reduceLayout with strip geometry", () => {
  test("packs up to four sessions with no paging and no NEXT key", () => {
    const result = reduceLayout(healthyView(sessionsAt(1, 2, 3)), DEFAULT_LAYOUT_SETTINGS, STRIP_GEOMETRY);
    expect(result.keys).toHaveLength(4);
    expect(result.pageCount).toBe(1);
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(1);
    expect(result.keys[3]).toEqual({ kind: "blank", degraded: false });
  });

  test("engages paging above four sessions, emitting no NEXT key", () => {
    const result = reduceLayout(healthyView(sessionsAt(1, 2, 3, 4, 5)), DEFAULT_LAYOUT_SETTINGS, STRIP_GEOMETRY);
    expect(result.keys).toHaveLength(4);
    expect(result.pageCount).toBe(2);
    expect(result.settings).toEqual(settings(true, 0));
    expect(result.keys.every((key) => key.kind !== "next")).toBe(true);
  });

  test("holds the latch at exactly four sessions and releases at three", () => {
    const held = reduceLayout(healthyView(sessionsAt(1, 2, 3, 4)), settings(true, 0), STRIP_GEOMETRY);
    expect(held.settings.overflowLatched).toBe(true);
    const released = reduceLayout(healthyView(sessionsAt(1, 2, 3)), settings(true, 0), STRIP_GEOMETRY);
    expect(released.settings).toEqual(settings(false, 0));
  });

  test("clamps an out-of-range page to the last page", () => {
    const result = reduceLayout(healthyView(sessionsAt(1, 2, 3, 4, 5)), settings(true, 7), STRIP_GEOMETRY);
    expect(result.settings.currentPage).toBe(1);
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(5);
  });

  test("a rail page jump via stored settings lands on the requested page", () => {
    const result = reduceLayout(healthyView(sessionsAt(...range(1, 9))), settings(true, 2), STRIP_GEOMETRY);
    expect(result.pageCount).toBe(3);
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(9);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/layout.test.ts`
Expected: FAIL (`STRIP_GEOMETRY` is not exported / arity errors).

- [ ] **Step 3: Implement the geometry parameterization**

In `src/plugin/layout.ts`:

Replace the module docstring's first line ("Pure paging reducer for the 5x3 Stream Deck profile.") with:

```ts
/**
 * Pure paging reducer: maps live sessions onto a fixed tile grid in dense
 * slot-rank order. Geometry is parameterized: the 5x3 Stream Deck keypad is
 * the default; the Xeneon strip pages full-density with no NEXT tile (its
 * rail pages externally). Sessions sort by their stable logical slot and pack
 * onto tiles by rank, so the grid never shows holes; the overflow latch
 * engages above the geometry's unpaged capacity, holds at or above it, and
 * releases below it. An out-of-range current page clamps to the last page.
 *
 * All page/latch state lives in this module as validated settings; the
 * reducer performs no I/O and imports no Stream Deck SDK types.
 */
```

Add after the `KeyModel` type:

```ts
export type LayoutGeometry = {
  /** Total tiles in the grid. */
  keyCount: number;
  /** Session tiles per page once overflow paging engages. */
  pageSessionKeys: number;
  /** Overflow engages above this live count and holds at or above it. */
  maxUnpagedSessions: number;
  /** True: a paged grid's last tile is NEXT. False: paging is external (strip rail). */
  nextKey: boolean;
};

export const KEYPAD_GEOMETRY: LayoutGeometry = {
  keyCount: 15,
  pageSessionKeys: 14,
  maxUnpagedSessions: 15,
  nextKey: true,
};

export const STRIP_GEOMETRY: LayoutGeometry = {
  keyCount: 4,
  pageSessionKeys: 4,
  maxUnpagedSessions: 4,
  nextKey: false,
};
```

Change `LayoutResult` (and delete the now-redundant `InternalLayout` type):

```ts
export type LayoutResult = {
  /** Validated, clamped, latch-updated settings to persist when dirty. */
  settings: LayoutSettingsV1;
  /** True only after NEXT or a validation, clamping, or latch change. */
  dirty: boolean;
  /** Exactly geometry.keyCount models, one per tile, row-major. */
  keys: KeyModel[];
  /** Total pages; 1 when unpaged. Exposed for external pagers (the strip rail). */
  pageCount: number;
};
```

Delete the `KEY_COUNT`, `PAGE_SESSION_KEYS`, and `MAX_UNPAGED_SESSIONS` constants. Update `buildKeys`:

```ts
const buildKeys = (
  sessions: readonly ProjectedSession[],
  degraded: boolean,
  settings: LayoutSettingsV1,
  pageCount: number,
  geometry: LayoutGeometry,
): KeyModel[] => {
  const keys: KeyModel[] = [];
  if (!settings.overflowLatched) {
    for (let key = 0; key < geometry.keyCount; key++) {
      keys.push(sessionKey(sessions[key], degraded));
    }
    return keys;
  }
  const start = settings.currentPage * geometry.pageSessionKeys;
  for (let key = 0; key < geometry.pageSessionKeys; key++) {
    keys.push(sessionKey(sessions[start + key], degraded));
  }
  if (geometry.nextKey) {
    keys.push({
      kind: "next",
      page: settings.currentPage + 1,
      pageCount,
      degraded,
    });
  }
  return keys;
};
```

Update `reduceInternal` to take the geometry and return `LayoutResult` directly:

```ts
const reduceInternal = (view: SnapshotView, storedState: unknown, geometry: LayoutGeometry): LayoutResult => {
  const sessions = sortedSessions(view);
  const count = sessions.length;
  const { settings: restored, defaulted } = validateStoredSettings(storedState);

  // The latch engages only when the live count exceeds the unpaged capacity;
  // once engaged it holds while at least that many sessions remain live.
  const overflow = restored.overflowLatched
    ? count >= geometry.maxUnpagedSessions
    : count > geometry.maxUnpagedSessions;

  if (!overflow) {
    const settings: LayoutSettingsV1 = { ...DEFAULT_LAYOUT_SETTINGS };
    const dirty = defaulted || restored.overflowLatched || restored.currentPage !== 0;
    return { settings, dirty, keys: buildKeys(sessions, view.degraded, settings, 1, geometry), pageCount: 1 };
  }

  // Latched pages are dense by construction, so every page in range is
  // non-empty and clamping reduces to bounding the page index.
  const pageCount = Math.ceil(count / geometry.pageSessionKeys);
  const currentPage = Math.min(restored.currentPage, pageCount - 1);
  const settings: LayoutSettingsV1 = { schemaVersion: 1, overflowLatched: true, currentPage };
  const dirty = defaulted || !restored.overflowLatched || restored.currentPage !== currentPage;
  return { settings, dirty, keys: buildKeys(sessions, view.degraded, settings, pageCount, geometry), pageCount };
};
```

Update the two exports:

```ts
export const reduceLayout = (
  view: SnapshotView,
  storedState: unknown,
  geometry: LayoutGeometry = KEYPAD_GEOMETRY,
): LayoutResult => reduceInternal(view, storedState, geometry);

export const advanceLayoutPage = (
  view: SnapshotView,
  storedState: unknown,
  geometry: LayoutGeometry = KEYPAD_GEOMETRY,
): LayoutResult => {
  const base = reduceInternal(view, storedState, geometry);
  if (!base.settings.overflowLatched || base.pageCount <= 1) {
    return base;
  }
  const currentPage = (base.settings.currentPage + 1) % base.pageCount;
  const settings: LayoutSettingsV1 = { ...base.settings, currentPage };
  return {
    settings,
    dirty: true,
    keys: buildKeys(sortedSessions(view), view.degraded, settings, base.pageCount, geometry),
    pageCount: base.pageCount,
  };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/layout.test.ts && bun run typecheck`
Expected: PASS. If any pre-existing test does a whole-object `toEqual` on a `LayoutResult`, add `pageCount` to its expected literal (the only permitted existing-test edit).

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS (controller/scheduler suites exercise the default keypad geometry).

- [ ] **Step 6: Commit**

```bash
git add src/plugin/layout.ts test/layout.test.ts
git commit -m "feat(layout): parameterize grid geometry, add strip geometry"
```

---

### Task 3: Tauri scaffold and build wiring

The app skeleton: `app/` webview frontend (bundled by `bun build`, no Vite) plus `app/src-tauri/` crate. Deliverable: `bun run dev:app` opens an undecorated 1280×360 window showing four empty tile slots, and the repo gate still passes.

**Files:**
- Create: `app/index.html`, `app/styles.css`, `app/src/main.ts`, `app/tsconfig.json`
- Create: `app/src-tauri/Cargo.toml`, `app/src-tauri/build.rs`, `app/src-tauri/tauri.conf.json`, `app/src-tauri/capabilities/default.json`, `app/src-tauri/src/main.rs`
- Modify: `package.json`, `biome.json`, `.gitignore`

**Interfaces:**
- Consumes: nothing (Tasks 4-6 fill in pure modules; Tasks 7-11 wire behavior).
- Produces: the `app/` tree, `bun run build:app` / `dev:app` / `bundle:app` scripts, app typecheck via `bun run typecheck`.

- [ ] **Step 1: Install the Tauri packages**

```bash
bun add -d @tauri-apps/cli
bun add @tauri-apps/api @tauri-apps/plugin-autostart
```

- [ ] **Step 2: Create the webview skeleton**

`app/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="./styles.css" />
    <title>Agent Strip</title>
  </head>
  <body>
    <main id="strip">
      <div id="tiles"></div>
      <aside id="rail"></aside>
    </main>
    <script type="module" src="./main.js"></script>
  </body>
</html>
```

`app/styles.css` (base; tiles and rail styling land in Tasks 8-9):

```css
:root {
  color-scheme: dark;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: #10151c;
  color: #e8eef7;
  font-family: -apple-system, "SF Pro Text", system-ui, sans-serif;
  user-select: none;
  -webkit-user-select: none;
}
#strip {
  display: grid;
  grid-template-columns: 1fr 24%;
  gap: 1.56vw;
  padding: 8.33vh 1.56vw;
  height: 100vh;
}
#tiles {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1.56vw;
}
.tile.blank {
  background: #0f131b;
  border-radius: 1vw;
}
```

`app/src/main.ts` (skeleton; replaced in Task 8):

```ts
const tiles = document.querySelector<HTMLElement>("#tiles");
if (tiles !== null) {
  for (let index = 0; index < 4; index += 1) {
    const tile = document.createElement("div");
    tile.className = "tile blank";
    tiles.append(tile);
  }
}
```

`app/tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": [],
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*.ts", "../src/protocol.ts", "../src/plugin/layout.ts", "../src/plugin/render.ts"]
}
```

- [ ] **Step 3: Create the Tauri crate**

`app/src-tauri/Cargo.toml`:

```toml
[package]
name = "agent-strip"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2" }

[dependencies]
tauri = { version = "2" }
tauri-plugin-autostart = "2"
serde = { version = "1", features = ["derive"] }
```

`app/src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build()
}
```

`app/src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Agent Strip",
  "version": "0.1.0",
  "identifier": "com.drewritter.agent-strip",
  "build": {
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Agent Strip",
        "decorations": false,
        "resizable": true,
        "width": 1280,
        "height": 360
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": ["app"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns"]
  }
}
```

`app/src-tauri/capabilities/default.json` (window/monitor permissions the JS side needs; if a runtime log names a missing ACL id, add it):

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "default window permissions",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-set-position",
    "core:window:allow-set-size",
    "core:window:allow-outer-position",
    "core:window:allow-available-monitors",
    "autostart:allow-enable",
    "autostart:allow-is-enabled"
  ]
}
```

`app/src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running agent-strip");
}
```

(If the installed `tauri-plugin-autostart` major version has a different init signature, check its crate source under `~/.cargo/registry/src/` and adapt — do not guess.)

- [ ] **Step 4: Generate app icons**

```bash
sips -z 1024 1024 com.drewritter.stream-deck-agents.sdPlugin/imgs/plugin-icon@2x.png --out /tmp/agent-strip-icon.png
cd app && bunx tauri icon /tmp/agent-strip-icon.png
```

Expected: `app/src-tauri/icons/` populated (icon.icns, 32x32.png, 128x128.png, 128x128@2x.png, etc.). Commit the generated icons.

- [ ] **Step 5: Wire build, lint, and ignore**

`package.json` scripts — update `typecheck`, add three:

```json
"typecheck": "tsc --noEmit && tsc --noEmit -p app/tsconfig.json",
"build:app": "bun build app/src/main.ts --outdir app/dist --target browser --minify && cp app/index.html app/styles.css app/dist/",
"dev:app": "bun run build:app && cd app && bunx tauri dev",
"bundle:app": "bun run build:app && cd app && bunx tauri build"
```

`biome.json` `files.includes` becomes:

```json
"includes": ["src/**", "test/**", "scripts/**", "extensions/**", "app/**", "!app/src-tauri/**", "*.json", "*.mjs"]
```

`.gitignore` — append:

```
app/dist/
app/src-tauri/target/
```

- [ ] **Step 6: Verify the gate and the skeleton**

Run: `bun run typecheck && bun run lint && bun test && bun run build:app`
Expected: all PASS.

Then the manual smoke (needs a display attached; any monitor works):

```bash
bun run dev:app
```

Expected: first cargo build takes several minutes; an undecorated 1280×360 window appears with four dark tile slots. Close it with Ctrl+C in the terminal (the window has no title bar).

- [ ] **Step 7: Commit**

```bash
git add app package.json bun.lock biome.json .gitignore
git commit -m "feat(app): tauri scaffold and build wiring"
```

---

### Task 4: Strip press routing (pure)

The routing rules ported from `src/plugin/controller.ts` `keyDown` (lines 156-228) as a pure function: Paseo origin wins, then per-provider. No Tauri imports — the impure shell lives in Task 10's press module.

**Files:**
- Create: `app/src/routing.ts`
- Test: `test/strip-routing.test.ts`

**Interfaces:**
- Consumes: `ProjectedSession` from `src/protocol.ts`.
- Produces:
  - `type SessionRoute = { kind: "paseo"; agentId: string } | { kind: "ghostty"; terminalId: string } | { kind: "url"; url: string } | { kind: "flash" }`
  - `routeForSession(session: ProjectedSession): SessionRoute`

- [ ] **Step 1: Write the failing tests**

`test/strip-routing.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { routeForSession } from "../app/src/routing";
import type { ProjectedSession } from "../src/protocol";

const session = (overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: "session-1",
  status: "idle",
  title: "A session",
  project: "stream-deck-agents",
  descendantCount: 0,
  logicalSlot: 1,
  ghosttyTerminalId: null,
  model: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  ...overrides,
});

describe("routeForSession", () => {
  test("a paseo origin with a ref routes to paseo regardless of provider", () => {
    expect(routeForSession(session({ provider: "claude", originKind: "paseo", originRef: "agent-42" }))).toEqual({
      kind: "paseo",
      agentId: "agent-42",
    });
  });

  test("a paseo origin without a ref falls through to provider routing", () => {
    expect(routeForSession(session({ provider: "codex", originKind: "paseo", originRef: null }))).toEqual({
      kind: "url",
      url: "codex://threads/session-1",
    });
  });

  test("claude with a ghostty terminal routes to ghostty focus", () => {
    expect(routeForSession(session({ provider: "claude", ghosttyTerminalId: "term-9" }))).toEqual({
      kind: "ghostty",
      terminalId: "term-9",
    });
  });

  test("claude without a ghostty terminal flashes", () => {
    expect(routeForSession(session({ provider: "claude" }))).toEqual({ kind: "flash" });
  });

  test("codex routes to its thread deep link, url-encoded", () => {
    expect(routeForSession(session({ provider: "codex", sessionId: "thread 7" }))).toEqual({
      kind: "url",
      url: "codex://threads/thread%207",
    });
  });

  test("kimi routes to the local kimi web session url", () => {
    expect(routeForSession(session({ provider: "kimi" }))).toEqual({
      kind: "url",
      url: "http://127.0.0.1:58627/sessions/session-1",
    });
  });

  test("providers without an activation binding flash", () => {
    for (const provider of ["pi", "omp", "zcode", "deepseek", "grok"] as const) {
      expect(routeForSession(session({ provider }))).toEqual({ kind: "flash" });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/strip-routing.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the router**

`app/src/routing.ts`:

```ts
/**
 * Tile-press routing rules, ported from the Stream Deck controller's keyDown
 * (src/plugin/controller.ts): a Paseo origin with a known agent ref wins over
 * provider routing; claude focuses its Ghostty terminal; codex and kimi open
 * deep links; everything else flashes the tile. Pure — no Tauri imports.
 */

import type { ProjectedSession } from "../../src/protocol";

export type SessionRoute =
  | { kind: "paseo"; agentId: string }
  | { kind: "ghostty"; terminalId: string }
  | { kind: "url"; url: string }
  | { kind: "flash" };

const KIMI_WEB_SESSIONS_URL = "http://127.0.0.1:58627/sessions/";

export const routeForSession = (session: ProjectedSession): SessionRoute => {
  if (session.originKind === "paseo" && session.originRef !== null) {
    return { kind: "paseo", agentId: session.originRef };
  }
  switch (session.provider) {
    case "claude":
      return session.ghosttyTerminalId === null
        ? { kind: "flash" }
        : { kind: "ghostty", terminalId: session.ghosttyTerminalId };
    case "codex":
      return { kind: "url", url: `codex://threads/${encodeURIComponent(session.sessionId)}` };
    case "kimi":
      return { kind: "url", url: `${KIMI_WEB_SESSIONS_URL}${encodeURIComponent(session.sessionId)}` };
    case "pi":
    case "omp":
    case "zcode":
    case "deepseek":
    case "grok":
      return { kind: "flash" };
  }
  // Exhaustiveness proof: adding a Provider without a case fails typecheck.
  const uncoveredProvider: never = session.provider;
  void uncoveredProvider;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/strip-routing.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/routing.ts test/strip-routing.test.ts
git commit -m "feat(app): session press routing"
```

---

### Task 5: Snapshot read reducer (pure)

The webview port of `SnapshotCache`'s semantics over an async read: staleness (10s), parse failure, explicit unhealthy, last-good retention. Identity-based re-parse caching is dropped (see Global Constraints) — every poll re-parses and rendering is signature-gated instead.

**Files:**
- Create: `app/src/snapshot-view.ts`
- Test: `test/strip-snapshot-view.test.ts`

**Interfaces:**
- Consumes: `parseSessionSnapshot`, `SessionSnapshotV2`, `SnapshotView` from `src/protocol.ts`.
- Produces:
  - `const STALE_SNAPSHOT_AGE_MS: 10_000`
  - `type SnapshotRead = { mtimeMs: number; contents: string }`
  - `type SnapshotReduction = { view: SnapshotView; lastGood: SessionSnapshotV2 | null }`
  - `reduceSnapshotRead(read: SnapshotRead | null, lastGood: SessionSnapshotV2 | null, now: number): SnapshotReduction`

- [ ] **Step 1: Write the failing tests**

`test/strip-snapshot-view.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { reduceSnapshotRead, type SnapshotRead } from "../app/src/snapshot-view";
import type { SessionSnapshotV2 } from "../src/protocol";

const healthy = (sessions: SessionSnapshotV2["sessions"] = []): SessionSnapshotV2 => ({
  schemaVersion: 2,
  health: { status: "ok" },
  sessions,
});

const readOf = (mtimeMs: number, value: unknown): SnapshotRead => ({ mtimeMs, contents: JSON.stringify(value) });

const NOW = 100_000;
const FRESH = NOW - 5_000;

describe("reduceSnapshotRead", () => {
  test("a fresh healthy read renders live and becomes last-good", () => {
    const result = reduceSnapshotRead(readOf(FRESH, healthy()), null, NOW);
    expect(result.view.degraded).toBe(false);
    expect(result.lastGood).not.toBeNull();
  });

  test("a stale read degrades and keeps the last-good snapshot", () => {
    const good = healthy();
    const primed = reduceSnapshotRead(readOf(FRESH, good), null, NOW);
    const stale = reduceSnapshotRead(readOf(NOW - 5_000, good), primed.lastGood, NOW + 20_000);
    expect(stale.view.degraded).toBe(true);
    expect(stale.view.snapshot).toBe(good);
    expect(stale.lastGood).toBe(good);
  });

  test("a staleness boundary at exactly the threshold is not stale", () => {
    const result = reduceSnapshotRead(readOf(FRESH, healthy()), null, FRESH + 10_000);
    expect(result.view.degraded).toBe(false);
  });

  test("a missing read with no last-good degrades to the empty snapshot", () => {
    const result = reduceSnapshotRead(null, null, NOW);
    expect(result.view.degraded).toBe(true);
    expect(result.view.snapshot.sessions).toHaveLength(0);
    expect(result.view.snapshot.health.status).toBe("error");
  });

  test("an unparseable read degrades and keeps last-good", () => {
    const primed = reduceSnapshotRead(readOf(FRESH, healthy()), null, NOW);
    const result = reduceSnapshotRead({ mtimeMs: FRESH, contents: "{not json" }, primed.lastGood, NOW);
    expect(result.view.degraded).toBe(true);
    expect(result.lastGood).not.toBeNull();
  });

  test("an explicitly unhealthy snapshot never becomes last-good", () => {
    const primed = reduceSnapshotRead(readOf(FRESH, healthy()), null, NOW);
    const unhealthy = { schemaVersion: 2, health: { status: "error", message: "boom" }, sessions: [] };
    const result = reduceSnapshotRead(readOf(FRESH, unhealthy), primed.lastGood, NOW);
    expect(result.view.degraded).toBe(true);
    expect(result.view.snapshot).toBe(primed.lastGood);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/strip-snapshot-view.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the reducer**

`app/src/snapshot-view.ts`:

```ts
/**
 * Webview port of the plugin's SnapshotCache semantics
 * (src/plugin/snapshot-reader.ts) over an async read: a missing, stale,
 * unparseable, or explicitly unhealthy snapshot degrades to the last-good
 * view, or to an empty degraded view before the first healthy read. File age
 * IS the daemon-liveness signal: a live daemon rewrites the snapshot every 5s
 * heartbeat, so anything past the stale threshold is a dead daemon.
 */

import { parseSessionSnapshot, type SessionSnapshotV2, type SnapshotView } from "../../src/protocol";

/** Two missed daemon heartbeats; mirrors STALE_SNAPSHOT_AGE_MS in src/plugin/snapshot-reader.ts. */
export const STALE_SNAPSHOT_AGE_MS = 10_000;

export type SnapshotRead = { mtimeMs: number; contents: string };

export type SnapshotReduction = { view: SnapshotView; lastGood: SessionSnapshotV2 | null };

const EMPTY_DEGRADED_SNAPSHOT: SessionSnapshotV2 = {
  schemaVersion: 2,
  health: { status: "error", message: "snapshot_unavailable" },
  sessions: [],
};

const degraded = (lastGood: SessionSnapshotV2 | null): SnapshotView => ({
  snapshot: lastGood ?? EMPTY_DEGRADED_SNAPSHOT,
  degraded: true,
});

export const reduceSnapshotRead = (
  read: SnapshotRead | null,
  lastGood: SessionSnapshotV2 | null,
  now: number,
): SnapshotReduction => {
  if (read === null || now - read.mtimeMs > STALE_SNAPSHOT_AGE_MS) {
    return { view: degraded(lastGood), lastGood };
  }
  let snapshot: SessionSnapshotV2;
  try {
    snapshot = parseSessionSnapshot(JSON.parse(read.contents));
  } catch {
    return { view: degraded(lastGood), lastGood };
  }
  if (snapshot.health.status !== "ok") {
    return { view: degraded(lastGood), lastGood };
  }
  return { view: { snapshot, degraded: false }, lastGood: snapshot };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/strip-snapshot-view.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/snapshot-view.ts test/strip-snapshot-view.test.ts
git commit -m "feat(app): snapshot read reduction"
```

---

### Task 6: Strip monitor detection (pure)

Panel identification: monitor model string contains "xeneon edge" (case-insensitive), else exact physical 2560×720 (physical size is scaling-independent, so HiDPI 1280×360 still matches).

**Files:**
- Create: `app/src/monitors.ts`
- Test: `test/monitors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MonitorInfo = { name: string | null; width: number; height: number }`
  - `isStripMonitor(monitor: MonitorInfo): boolean`

- [ ] **Step 1: Write the failing tests**

`test/monitors.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { isStripMonitor } from "../app/src/monitors";

describe("isStripMonitor", () => {
  test("matches the XENEON EDGE model string, case-insensitively", () => {
    expect(isStripMonitor({ name: "XENEON EDGE", width: 1920, height: 1080 })).toBe(true);
    expect(isStripMonitor({ name: "Corsair Xeneon Edge 14.5", width: 1, height: 1 })).toBe(true);
  });

  test("falls back to the exact physical resolution when the name is absent", () => {
    expect(isStripMonitor({ name: null, width: 2560, height: 720 })).toBe(true);
  });

  test("rejects unrelated names and other resolutions", () => {
    expect(isStripMonitor({ name: "LG UltraFine", width: 2560, height: 1440 })).toBe(false);
    expect(isStripMonitor({ name: null, width: 1280, height: 360 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/monitors.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the detector**

`app/src/monitors.ts`:

```ts
/**
 * Xeneon Edge identification: prefer the monitor model string (the panel
 * reports "XENEON EDGE" over EDID), fall back to its exact physical
 * resolution. Physical size is used so a scaled 1280x360 HiDPI mode still
 * matches.
 */

export type MonitorInfo = { name: string | null; width: number; height: number };

const STRIP_NAME_FRAGMENT = "xeneon edge";
const STRIP_PHYSICAL_WIDTH = 2560;
const STRIP_PHYSICAL_HEIGHT = 720;

export const isStripMonitor = (monitor: MonitorInfo): boolean => {
  if (monitor.name !== null && monitor.name.toLowerCase().includes(STRIP_NAME_FRAGMENT)) {
    return true;
  }
  return monitor.width === STRIP_PHYSICAL_WIDTH && monitor.height === STRIP_PHYSICAL_HEIGHT;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/monitors.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/monitors.ts test/monitors.test.ts
git commit -m "feat(app): strip monitor detection"
```

---

### Task 7: Rust commands and the webview bridge

All webview↔host I/O goes through five Tauri commands — no fs/shell/opener plugin permissions to scope. Commands are async so the blocking process spawns stay off the UI thread.

**Files:**
- Modify: `app/src-tauri/src/main.rs`
- Create: `app/src/bridge.ts`

**Interfaces:**
- Consumes: the Task 3 crate.
- Produces (TS bridge, used by Tasks 8-10):
  - `type SnapshotPayload = { mtimeMs: number; contents: string }`
  - `readSnapshot(): Promise<SnapshotPayload>`
  - `readPaseoServerId(): Promise<string>`
  - `ackSession(provider: Provider, sessionId: string): Promise<void>`
  - `openUrl(url: string): Promise<void>`
  - `focusGhostty(script: string, terminalId: string): Promise<void>`

- [ ] **Step 1: Implement the Rust commands**

Replace `app/src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
struct SnapshotPayload {
    #[serde(rename = "mtimeMs")]
    mtime_ms: u64,
    contents: String,
}

fn app_support_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|error| error.to_string())?;
    Ok(PathBuf::from(home).join("Library/Application Support/com.drewritter.stream-deck-agents"))
}

#[tauri::command]
async fn read_snapshot() -> Result<SnapshotPayload, String> {
    let path = app_support_root()?.join("snapshot-v2.json");
    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    let mtime_ms = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    let contents = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok(SnapshotPayload { mtime_ms, contents })
}

#[tauri::command]
async fn read_paseo_server_id() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|error| error.to_string())?;
    let path = PathBuf::from(home).join(".paseo/server-id");
    let contents = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    Ok(contents.trim().to_string())
}

/// Blocking child-process wait inside async commands: acceptable at this
/// scale (a few short-lived processes per user gesture) and keeps the crate
/// dependency-free beyond tauri/serde.
fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let status = Command::new(program)
        .args(args)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with {status}"))
    }
}

/// The app's only write path back to the daemon, mirroring the plugin's
/// session-ack: the installed binary, fixed subcommand argv, no shell.
#[tauri::command]
async fn ack_session(provider: &str, session_id: &str) -> Result<(), String> {
    let executable = app_support_root()?.join("bin/stream-deck-agents");
    let path = executable.to_string_lossy().to_string();
    run(&path, &["sessions", "ack", provider, session_id])
}

#[tauri::command]
async fn open_url(url: &str) -> Result<(), String> {
    run("/usr/bin/open", &["-u", url])
}

#[tauri::command]
async fn focus_ghostty(script: &str, terminal_id: &str) -> Result<(), String> {
    run("/usr/bin/osascript", &["-e", script, "--", terminal_id])
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .invoke_handler(tauri::generate_handler![
            read_snapshot,
            read_paseo_server_id,
            ack_session,
            open_url,
            focus_ghostty
        ])
        .run(tauri::generate_context!())
        .expect("error while running agent-strip");
}
```

- [ ] **Step 2: Implement the TS bridge**

`app/src/bridge.ts`:

```ts
/** The webview's narrow call surface into the Rust host (see src-tauri/main.rs). */

import { invoke } from "@tauri-apps/api/core";
import type { Provider } from "../../src/protocol";

export type SnapshotPayload = { mtimeMs: number; contents: string };

export const readSnapshot = (): Promise<SnapshotPayload> => invoke<SnapshotPayload>("read_snapshot");

export const readPaseoServerId = (): Promise<string> => invoke<string>("read_paseo_server_id");

export const ackSession = (provider: Provider, sessionId: string): Promise<void> =>
  invoke<void>("ack_session", { provider, sessionId });

export const openUrl = (url: string): Promise<void> => invoke<void>("open_url", { url });

export const focusGhostty = (script: string, terminalId: string): Promise<void> =>
  invoke<void>("focus_ghostty", { script, terminalId });
```

- [ ] **Step 3: Verify compilation**

Run: `cd app/src-tauri && cargo check && cd ../..`
Expected: compiles clean (first build downloads crates; several minutes).

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/main.rs app/src/bridge.ts
git commit -m "feat(app): rust commands and webview bridge"
```

---

### Task 8: Live tile grid

Wire the poll loop: every 2s, `read_snapshot` → `reduceSnapshotRead` → `reduceLayout` with `STRIP_GEOMETRY` → DOM render, gated on a serialized model signature so CSS animations are not restarted by no-op polls. Tiles are DOM/CSS ports of the `render.ts` anatomy: status frame border + keyframe animation, provider chip + model label, 2-line clamped title, descendant badge, origin pip, degraded flag / OFFLINE blank.

**Files:**
- Modify: `src/plugin/render.ts` (export `PROVIDER_LETTERS` and `modelLabel` — additive, no behavior change)
- Create: `app/src/tiles.ts`
- Modify: `app/styles.css`
- Modify: `app/src/main.ts` (replaces the Task 3 skeleton)

**Interfaces:**
- Consumes: `STRIP_GEOMETRY`, `reduceLayout`, `KeyModel` (Task 2); `reduceSnapshotRead` (Task 5); `readSnapshot`, `SnapshotPayload` (Task 7); `modelLabel`, `PROVIDER_LETTERS` (this task's `render.ts` exports).
- Produces:
  - `renderTiles(root: HTMLElement, keys: readonly KeyModel[]): void` — tiles carry `data-key-index`
  - `main.ts` poll loop, settings persistence under localStorage key `agent-strip.layout.v1`
  - Exported from `src/plugin/render.ts`: `PROVIDER_LETTERS: Record<Provider, string>`, `modelLabel(model: string, maxCodePoints: number): string`

- [ ] **Step 1: Export the shared marks from render.ts**

In `src/plugin/render.ts`, add the `export` keyword to the `PROVIDER_LETTERS` const and the `modelLabel` const. Nothing else changes.

- [ ] **Step 2: Verify the plugin still builds and tests pass**

Run: `bun test test/render.test.ts && bun run build:plugin`
Expected: PASS (additive exports only).

- [ ] **Step 3: Implement the tile renderer**

`app/src/tiles.ts`:

```ts
/**
 * DOM tile renderer for the strip: a web-native port of the Stream Deck SVG
 * tile anatomy (src/plugin/render.ts) — status frame, provider chip + model
 * label, two-line clamped title, descendant badge, Paseo origin pip, degraded
 * flag. Status color and animation live in styles.css (status-* classes);
 * this module owns structure and text only. All text goes through
 * textContent; no innerHTML anywhere.
 */

import type { KeyModel } from "../../src/plugin/layout";
import { modelLabel, PROVIDER_LETTERS } from "../../src/plugin/render";

/** Strip tiles are wide enough that the keypad's badged six-point cap never applies. */
const STRIP_MODEL_LABEL_MAX_CODE_POINTS = 10;

const appendText = (parent: HTMLElement, className: string, text: string): HTMLSpanElement => {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
};

const sessionTile = (model: Extract<KeyModel, { kind: "session" }>, index: number): HTMLElement => {
  const { session } = model;
  const tile = document.createElement("div");
  tile.className = `tile session status-${session.status}`;
  tile.dataset["keyIndex"] = String(index);

  const topband = document.createElement("div");
  topband.className = "topband";
  const chip = appendText(topband, "chip", PROVIDER_LETTERS[session.provider]);
  chip.dataset["provider"] = session.provider;
  if (session.model !== null) {
    appendText(topband, "model", modelLabel(session.model, STRIP_MODEL_LABEL_MAX_CODE_POINTS));
  }
  if (session.descendantCount > 0) {
    appendText(topband, "badge", String(session.descendantCount));
  }
  tile.append(topband);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = model.label;
  tile.append(title);

  if (session.originKind === "paseo") {
    const pip = document.createElement("span");
    pip.className = session.originSubagent ? "pip subagent" : "pip parent";
    tile.append(pip);
  }
  if (model.degraded) {
    appendText(tile, "flag", "!");
  }
  return tile;
};

const blankTile = (degraded: boolean): HTMLElement => {
  const tile = document.createElement("div");
  tile.className = "tile blank";
  if (degraded) {
    appendText(tile, "offline", "OFFLINE");
  }
  return tile;
};

export const renderTiles = (root: HTMLElement, keys: readonly KeyModel[]): void => {
  root.replaceChildren(
    ...keys.map((model, index) => {
      switch (model.kind) {
        case "session":
          return sessionTile(model, index);
        case "blank":
        case "next":
          // STRIP_GEOMETRY never emits NEXT (the rail pages); treat it as blank defensively.
          return blankTile(model.degraded);
      }
    }),
  );
};
```

- [ ] **Step 4: Add the tile styles**

Append to `app/styles.css` (colors match `src/plugin/render.ts`; animation opacities match its sinusoid ranges: working wash 0.04–0.14 over 4s, waiting/error frame breathe 0.20–0.90 over 4s/2s, idle static):

```css
.tile {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 3.5%;
  border: 0.5vw solid transparent;
  border-radius: 1vw;
  background: #11151d;
  overflow: hidden;
}

.tile.session {
  cursor: pointer;
}

/* Status frames (colors and motion mirror src/plugin/render.ts). */
.status-idle {
  border-color: #4ade80;
}
.status-working {
  border-color: rgb(32 184 255 / 0.3);
}
.status-working::before {
  content: "";
  position: absolute;
  inset: 0;
  background: #20b8ff;
  opacity: 0.04;
  animation: wash 4s ease-in-out infinite alternate;
}
@keyframes wash {
  from {
    opacity: 0.04;
  }
  to {
    opacity: 0.14;
  }
}
.status-waiting {
  animation: breathe 4s ease-in-out infinite alternate;
}
.status-error {
  animation: pulse 2s ease-in-out infinite alternate;
}
@keyframes breathe {
  from {
    border-color: rgb(255 176 32 / 0.2);
  }
  to {
    border-color: rgb(255 176 32 / 0.9);
  }
}
@keyframes pulse {
  from {
    border-color: rgb(255 77 103 / 0.2);
  }
  to {
    border-color: rgb(255 77 103 / 0.9);
  }
}

.topband {
  display: flex;
  align-items: center;
  gap: 1vw;
}
.chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 3.2vw;
  height: 3.2vw;
  border-radius: 22%;
  color: #10151c;
  font-size: 1.9vw;
  font-weight: 700;
}
.chip[data-provider="claude"] {
  background: #d97757;
}
.chip[data-provider="codex"] {
  background: #d946ef;
}
.chip[data-provider="kimi"] {
  background: #3b82f6;
}
.chip[data-provider="pi"] {
  background: #0ea514;
}
.chip[data-provider="omp"] {
  background: #f5f0ea;
}
.chip[data-provider="zcode"] {
  background: #eab308;
}
.chip[data-provider="deepseek"] {
  background: #2dd4bf;
}
.chip[data-provider="grok"] {
  background: #f472b6;
}
.model {
  color: #94a3b8;
  font-size: 1.5vw;
}
.badge {
  margin-left: auto;
  color: #e8eef7;
  font-size: 2.4vw;
  font-weight: 600;
}

.title {
  flex: 1;
  display: -webkit-box;
  -webkit-box-align: center;
  -webkit-box-pack: center;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  text-align: center;
  font-size: 2vw;
  line-height: 1.25;
}

.pip {
  position: absolute;
  right: 4%;
  bottom: 4.5%;
  width: 1.2vw;
  height: 1.2vw;
  border-radius: 50%;
}
.pip.parent {
  background: #a78bfa;
}
.pip.subagent {
  border: 0.22vw solid #a78bfa;
  background: transparent;
}

.flag {
  position: absolute;
  left: 4%;
  bottom: 4%;
  color: #ffb020;
  font-size: 1.6vw;
  font-weight: 700;
}

.tile.blank {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
}
.offline {
  color: #94a3b8;
  font-size: 1.4vw;
  letter-spacing: 0.2em;
}
```

(The `.tile.blank` rule from Task 3's base styles is superseded by this one; delete the Task 3 `.tile.blank` block when appending.)

- [ ] **Step 5: Implement the poll loop**

Replace `app/src/main.ts`:

```ts
/**
 * App entry: poll the daemon snapshot every 2s, reduce layout with the strip
 * geometry, and re-render only when the serialized key models change (so CSS
 * status animations are never restarted by a no-op poll). Page settings
 * persist to localStorage; the reducer validates them on every read.
 */

import { type LayoutResult, reduceLayout, STRIP_GEOMETRY } from "../../src/plugin/layout";
import type { SessionSnapshotV2 } from "../../src/protocol";
import { readSnapshot } from "./bridge";
import { reduceSnapshotRead } from "./snapshot-view";
import { renderTiles } from "./tiles";

const POLL_MS = 2000;
const SETTINGS_KEY = "agent-strip.layout.v1";

let lastGood: SessionSnapshotV2 | null = null;
let renderedSignature = "";

const loadStoredSettings = (): unknown => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
  } catch {
    return null;
  }
};

const persistSettings = (settings: unknown): void => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Best effort: a dropped page preference re-derives on the next poll.
  }
};

const applyLayout = (layout: LayoutResult): void => {
  if (layout.dirty) {
    persistSettings(layout.settings);
  }
  const signature = JSON.stringify(layout.keys);
  const root = document.querySelector<HTMLElement>("#tiles");
  if (root !== null && signature !== renderedSignature) {
    renderedSignature = signature;
    renderTiles(root, layout.keys);
  }
};

const poll = async (): Promise<void> => {
  const payload = await readSnapshot().catch(() => null);
  const reduction = reduceSnapshotRead(payload, lastGood, Date.now());
  lastGood = reduction.lastGood;
  applyLayout(reduceLayout(reduction.view, loadStoredSettings(), STRIP_GEOMETRY));
};

const start = (): void => {
  void poll();
  setInterval(() => {
    void poll();
  }, POLL_MS);
};

start();
```

- [ ] **Step 6: Verify**

Run: `bun run typecheck && bun run lint && bun run build:app`
Expected: PASS.

Manual: `bun run dev:app` with the daemon running — live sessions appear with animated status frames, chips, titles. OFFLINE path: `launchctl bootout gui/$(id -u)/com.drewritter.stream-deck-agents`, watch tiles gain `!`/OFFLINE after ~10s, then restore with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.drewritter.stream-deck-agents.plist`.

- [ ] **Step 7: Commit**

```bash
git add src/plugin/render.ts app/src/tiles.ts app/styles.css app/src/main.ts
git commit -m "feat(app): live tile grid"
```

---

### Task 9: Rail — health, clock, unread, pager

The right rail: daemon health (with heartbeat age), clock, unread count, page dots with tap-to-jump. Page jumps work through the reducer's validated stored settings — no new reducer API.

**Files:**
- Create: `app/src/rail.ts`
- Modify: `app/styles.css`, `app/src/main.ts`

**Interfaces:**
- Consumes: `SnapshotView`, `LayoutResult` (Tasks 1-2), main.ts poll loop (Task 8).
- Produces:
  - `type RailModel = { degraded: boolean; heartbeatAgeMs: number | null; unreadCount: number; page: number; pageCount: number; now: Date }`
  - `type RailActions = { onJumpToPage: (page: number) => void }` — `page` is 0-based
  - `renderRail(root: HTMLElement, model: RailModel, actions: RailActions): void`
  - main.ts exposes `currentView` for Task 10's click routing (already exported state pattern: module-level `let`).

- [ ] **Step 1: Implement the rail renderer**

`app/src/rail.ts`:

```ts
/**
 * The strip's fixed right rail: daemon health (with heartbeat age), clock,
 * unread count, and page dots. Rebuilt wholesale on each render — the rail is
 * small and has no CSS animations to disturb.
 */

export type RailModel = {
  degraded: boolean;
  /** Age of the snapshot file's mtime; null when no read has succeeded. */
  heartbeatAgeMs: number | null;
  unreadCount: number;
  /** 1-based current page. */
  page: number;
  pageCount: number;
  now: Date;
};

export type RailActions = {
  /** Jump to a 0-based page; the layout reducer validates and clamps it. */
  onJumpToPage: (page: number) => void;
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

const healthSection = (model: RailModel): HTMLElement => {
  const section = document.createElement("section");
  section.className = "rail-health";
  const dot = document.createElement("span");
  dot.className = model.degraded ? "dot bad" : "dot ok";
  section.append(dot);
  const text = document.createElement("span");
  if (model.degraded) {
    text.className = "offline-text";
    text.textContent = "OFFLINE";
  } else {
    const ageSeconds = model.heartbeatAgeMs === null ? null : Math.max(0, Math.round(model.heartbeatAgeMs / 1000));
    text.textContent = ageSeconds === null ? "daemon ok" : `daemon ok · ${ageSeconds}s ago`;
  }
  section.append(text);
  return section;
};

const pagerSection = (model: RailModel, actions: RailActions): HTMLElement => {
  const section = document.createElement("section");
  section.className = "rail-pager";
  for (let page = 1; page <= model.pageCount; page += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = page === model.page ? "page-dot current" : "page-dot";
    button.textContent = "●";
    const target = page - 1;
    button.addEventListener("click", () => actions.onJumpToPage(target));
    section.append(button);
  }
  return section;
};

export const renderRail = (root: HTMLElement, model: RailModel, actions: RailActions): void => {
  const clock = document.createElement("section");
  clock.className = "rail-clock";
  clock.textContent = `${pad2(model.now.getHours())}:${pad2(model.now.getMinutes())}`;

  const unread = document.createElement("section");
  unread.className = model.unreadCount > 0 ? "rail-unread active" : "rail-unread";
  unread.textContent = model.unreadCount === 1 ? "1 unread" : `${model.unreadCount} unread`;

  root.replaceChildren(healthSection(model), clock, unread, pagerSection(model, actions));
};
```

- [ ] **Step 2: Add the rail styles**

Append to `app/styles.css`:

```css
#rail {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 2vh;
  background: #10141c;
  border: 1px solid #232b38;
  border-radius: 1vw;
  padding: 3.5%;
  color: #94a3b8;
  font-size: 1.5vw;
}

.rail-health {
  display: flex;
  align-items: center;
  gap: 0.8vw;
}
.dot {
  width: 1vw;
  height: 1vw;
  border-radius: 50%;
}
.dot.ok {
  background: #4ade80;
}
.dot.bad {
  background: #ff4d67;
}
.offline-text {
  color: #ff4d67;
  font-weight: 700;
  letter-spacing: 0.15em;
}

.rail-clock {
  color: #e8eef7;
  font-size: 3.4vw;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.rail-unread.active {
  color: #ffb020;
  font-weight: 600;
}

.rail-pager {
  display: flex;
  gap: 0.6vw;
}
.page-dot {
  appearance: none;
  border: none;
  background: none;
  padding: 0.4vw;
  color: #2a3342;
  font-size: 1.1vw;
  cursor: pointer;
}
.page-dot.current {
  color: #94a3b8;
}
```

- [ ] **Step 3: Wire the rail into main.ts**

In `app/src/main.ts`:

Add imports:

```ts
import type { SnapshotView } from "../../src/protocol";
import { renderRail } from "./rail";
```

Add module state next to `lastGood`:

```ts
let currentView: SnapshotView | null = null;
let lastReadMtimeMs: number | null = null;
let currentPage = 0;
let currentPageCount = 1;
```

Add the unread counter and the rail render, after `persistSettings`:

```ts
/**
 * Grid-visible unread: the projection admits only active or unread rows, and
 * unread is stamped exactly when a turn settles to idle or error, so an
 * on-grid idle/error tile is an unread result. A session re-prompted back to
 * working while still unread is not counted (prompts never mark read).
 */
const unreadCount = (view: SnapshotView): number =>
  view.snapshot.sessions.filter((session) => session.status === "idle" || session.status === "error").length;

const jumpToPage = (page: number): void => {
  if (currentView === null) {
    return;
  }
  applyLayout(
    reduceLayout(currentView, { schemaVersion: 1, overflowLatched: true, currentPage: page }, STRIP_GEOMETRY),
  );
  // renderRailNow is declared below; referenced here only at click time.
  renderRailNow();
};

const renderRailNow = (): void => {
  const root = document.querySelector<HTMLElement>("#rail");
  if (root === null || currentView === null) {
    return;
  }
  renderRail(
    root,
    {
      degraded: currentView.degraded,
      heartbeatAgeMs: lastReadMtimeMs === null ? null : Date.now() - lastReadMtimeMs,
      unreadCount: unreadCount(currentView),
      page: currentPage + 1,
      pageCount: currentPageCount,
      now: new Date(),
    },
    { onJumpToPage: jumpToPage },
  );
};
```

Update `applyLayout` to own the page state (single assignment point, so polls and rail jumps stay consistent):

```ts
const applyLayout = (layout: LayoutResult): void => {
  if (layout.dirty) {
    persistSettings(layout.settings);
  }
  currentPage = layout.settings.currentPage;
  currentPageCount = layout.pageCount;
  const signature = JSON.stringify(layout.keys);
  const root = document.querySelector<HTMLElement>("#tiles");
  if (root !== null && signature !== renderedSignature) {
    renderedSignature = signature;
    renderTiles(root, layout.keys);
  }
};
```

Update `poll` to record the new view state:

```ts
const poll = async (): Promise<void> => {
  const payload = await readSnapshot().catch(() => null);
  const reduction = reduceSnapshotRead(payload, lastGood, Date.now());
  lastGood = reduction.lastGood;
  currentView = reduction.view;
  lastReadMtimeMs = payload?.mtimeMs ?? null;
  applyLayout(reduceLayout(reduction.view, loadStoredSettings(), STRIP_GEOMETRY));
};
```

And in `start`, add a 1s rail tick after the poll interval setup:

```ts
  setInterval(renderRailNow, 1000);
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun run lint && bun run build:app && bun test`
Expected: PASS.

Manual: `bun run dev:app` — rail shows health/clock/unread; with >4 live sessions the dots appear and clicking a dot jumps pages (persists across restart).

- [ ] **Step 5: Commit**

```bash
git add app/src/rail.ts app/styles.css app/src/main.ts
git commit -m "feat(app): rail with health, clock, unread, pager"
```

---

### Task 10: Tile press interaction

Click (mouse or driver-translated touch) on a session tile: fire-and-forget ack, then route. Failure or an unroutable target flashes the tile — the app's equivalent of the plugin's `showAlert`.

**Files:**
- Create: `app/src/press.ts`
- Modify: `app/src/main.ts`
- Modify: `app/styles.css`

**Interfaces:**
- Consumes: `routeForSession` (Task 4); `ackSession`, `openUrl`, `focusGhostty`, `readPaseoServerId` (Task 7); `KeyModel` (Task 2); main.ts `currentView`/poll (Tasks 8-9).
- Produces:
  - `type PressDeps = { ack: (provider: Provider, sessionId: string) => Promise<void>; openUrl: (url: string) => Promise<void>; focusGhostty: (script: string, terminalId: string) => Promise<void>; readPaseoServerId: () => Promise<string>; flash: () => void }`
  - `pressSessionTile(session: ProjectedSession, deps: PressDeps): Promise<void>`

- [ ] **Step 1: Implement the press handler**

`app/src/press.ts`:

```ts
/**
 * Tile press = the Stream Deck keyDown gesture: ack fire-and-forget (a failed
 * ack only means the tile stays unread until the next lifecycle event — never
 * flash for it), then route. Routing failures flash the tile, matching the
 * plugin's activation alert.
 */

import type { ProjectedSession, Provider } from "../../src/protocol";
import { routeForSession } from "./routing";

/** Ported verbatim from src/plugin/claude-session-activation.ts. */
const FOCUS_GHOSTTY_TERMINAL_SCRIPT = `
on run argv
  set targetId to item 1 of argv
  if application "Ghostty" is not running then error "ghostty_not_running"
  tell application "Ghostty"
    set matchingTerminals to {}
    repeat with candidateWindow in windows
      repeat with candidateTerminal in terminals of candidateWindow
        if (id of candidateTerminal) is targetId then
          set end of matchingTerminals to candidateTerminal
        end if
      end repeat
    end repeat
    if (count of matchingTerminals) is not 1 then error "ghostty_terminal_match_count"
    set matchedTerminal to item 1 of matchingTerminals
    focus matchedTerminal
  end tell
end run`;

export type PressDeps = {
  ack: (provider: Provider, sessionId: string) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  focusGhostty: (script: string, terminalId: string) => Promise<void>;
  readPaseoServerId: () => Promise<string>;
  flash: () => void;
};

export const pressSessionTile = async (session: ProjectedSession, deps: PressDeps): Promise<void> => {
  void deps.ack(session.provider, session.sessionId).catch(() => {});
  const route = routeForSession(session);
  try {
    switch (route.kind) {
      case "paseo": {
        const serverId = await deps.readPaseoServerId();
        await deps.openUrl(`paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(route.agentId)}`);
        return;
      }
      case "ghostty":
        await deps.focusGhostty(FOCUS_GHOSTTY_TERMINAL_SCRIPT, route.terminalId);
        return;
      case "url":
        await deps.openUrl(route.url);
        return;
      case "flash":
        deps.flash();
        return;
    }
  } catch {
    deps.flash();
  }
};
```

- [ ] **Step 2: Wire clicks in main.ts**

In `app/src/main.ts`:

Add imports:

```ts
import { ackSession, focusGhostty, openUrl, readPaseoServerId } from "./bridge";
import { pressSessionTile } from "./press";
```

(`readSnapshot` stays imported from `./bridge` — merge into one import statement.)

Track the current keys: add module state `let currentKeys: readonly KeyModel[] = [];` (and add `type KeyModel` to the layout import), set it inside `applyLayout` before the render:

```ts
const applyLayout = (layout: LayoutResult): void => {
  if (layout.dirty) {
    persistSettings(layout.settings);
  }
  currentKeys = layout.keys;
  const signature = JSON.stringify(layout.keys);
  const root = document.querySelector<HTMLElement>("#tiles");
  if (root !== null && signature !== renderedSignature) {
    renderedSignature = signature;
    renderTiles(root, layout.keys);
  }
};
```

Add the delegation handler at the end of the file:

```ts
const FLASH_MS = 320;

const flashTile = (tile: HTMLElement): void => {
  tile.classList.add("flash");
  setTimeout(() => tile.classList.remove("flash"), FLASH_MS);
};

const onTilesClick = (event: MouseEvent): void => {
  if (!(event.target instanceof HTMLElement)) {
    return;
  }
  const tile = event.target.closest<HTMLElement>("[data-key-index]");
  if (tile === null) {
    return;
  }
  const index = Number(tile.dataset["keyIndex"]);
  const model = currentKeys[index];
  if (model === undefined || model.kind !== "session") {
    return;
  }
  void pressSessionTile(model.session, {
    ack: ackSession,
    openUrl,
    focusGhostty,
    readPaseoServerId,
    flash: () => flashTile(tile),
  });
};

const wireInteraction = (): void => {
  document.querySelector<HTMLElement>("#tiles")?.addEventListener("click", onTilesClick);
};
```

Call `wireInteraction()` in `start()`.

- [ ] **Step 3: Add the flash style**

Append to `app/styles.css`:

```css
.tile.flash {
  animation: flashblink 0.32s ease-out;
}
@keyframes flashblink {
  0% {
    box-shadow: inset 0 0 0 1vw rgb(148 163 184 / 0.9);
  }
  100% {
    box-shadow: none;
  }
}
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun run lint && bun run build:app && bun test`
Expected: PASS.

Manual: `bun run dev:app` with a live Claude session — clicking its tile focuses the Ghostty terminal and the tile clears (ack). A grok/pi tile flashes.

- [ ] **Step 5: Commit**

```bash
git add app/src/press.ts app/src/main.ts app/styles.css
git commit -m "feat(app): tile press interaction"
```

---

### Task 11: Window pinning and login autostart

Pin the frameless window to the Xeneon Edge at launch (model-string match, resolution fallback), re-pin within 5s of a reconnect, and register the app as a login item on first run. When the panel is absent the window stays a normal floating window — the app remains usable without the hardware.

**Files:**
- Create: `app/src/window.ts`
- Modify: `app/src/main.ts`

**Interfaces:**
- Consumes: `isStripMonitor` (Task 6); `@tauri-apps/api/window`, `@tauri-apps/plugin-autostart` (Task 3).
- Produces: `startStripWindowManager(): Promise<void>` — pins, shows, and re-pins on a 5s interval.

- [ ] **Step 1: Implement the window manager**

`app/src/window.ts`:

```ts
/**
 * Pins the frameless window onto the Xeneon Edge. Detection prefers the
 * EDID model string, falling back to the exact physical resolution (physical
 * size is scaling-independent, so a HiDPI 1280x360 mode still matches). A
 * 5s re-pin interval covers panel reconnects; with no strip attached the
 * window is left alone as a normal floating window.
 */

import { availableMonitors, getCurrentWindow, type Monitor } from "@tauri-apps/api/window";
import { isStripMonitor } from "./monitors";

const REPIN_INTERVAL_MS = 5000;

const findStripMonitor = async (): Promise<Monitor | undefined> =>
  (await availableMonitors()).find((monitor) =>
    isStripMonitor({ name: monitor.name, width: monitor.size.width, height: monitor.size.height }),
  );

const pinTo = async (target: Monitor): Promise<void> => {
  const window = getCurrentWindow();
  await window.setPosition(target.position);
  await window.setSize(target.size);
};

export const startStripWindowManager = async (): Promise<void> => {
  const window = getCurrentWindow();
  const initial = await findStripMonitor().catch(() => undefined);
  if (initial !== undefined) {
    await pinTo(initial).catch(() => {});
  }
  setInterval(() => {
    void (async () => {
      const strip = await findStripMonitor().catch(() => undefined);
      if (strip === undefined) {
        return;
      }
      const position = await window.outerPosition().catch(() => null);
      if (position === null) {
        return;
      }
      if (position.x !== strip.position.x || position.y !== strip.position.y) {
        await pinTo(strip).catch(() => {});
      }
    })();
  }, REPIN_INTERVAL_MS);
};
```

- [ ] **Step 2: Wire the window manager and autostart into main.ts**

Add imports to `app/src/main.ts`:

```ts
import { enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { startStripWindowManager } from "./window";
```

Add the autostart helper (best effort — a failed registration just means no login launch):

```ts
const ensureAutostart = async (): Promise<void> => {
  try {
    if (!(await isEnabled())) {
      await enable();
    }
  } catch {
    // Login-item registration is best effort.
  }
};
```

Update `start()`:

```ts
const start = (): void => {
  void startStripWindowManager();
  void ensureAutostart();
  wireInteraction();
  void poll();
  setInterval(() => {
    void poll();
  }, POLL_MS);
  setInterval(renderRailNow, 1000);
};
```

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun run lint && bun run build:app && bun test`
Expected: PASS.

Manual (needs the Edge attached): `bun run dev:app` — the window jumps onto the strip, filling it. Unplug the Edge (window parks wherever macOS moves it), replug — within ~5s it re-pins to the strip.

- [ ] **Step 4: Commit**

```bash
git add app/src/window.ts app/src/main.ts
git commit -m "feat(app): window pinning and login autostart"
```

---

### Task 12: Install script, docs, and hardware acceptance

Ship it: `scripts/install-app.ts` (build + replace `/Applications/Agent Strip.app`), repo docs updated, and the on-hardware acceptance checklist recorded.

**Files:**
- Create: `scripts/install-app.ts`
- Modify: `package.json` (add the script)
- Modify: `docs/design.md`, `AGENTS.md`
- Create: `docs/verification/<today>-xeneon-strip-acceptance.md` (after the user runs the checklist)

**Interfaces:**
- Consumes: everything above.
- Produces: `bun run install:app`.

- [ ] **Step 1: Write the installer**

`scripts/install-app.ts` (follows `scripts/install-local.ts` idioms: spawnSync with argument arrays, absolute paths, `process.stdout.write` logging):

```ts
/**
 * Explicit macOS-local installer for the Agent Strip Xeneon app: build the
 * release bundle (frontend + Tauri), then replace the installed copy in
 * /Applications. The only destructive step is replacing a path that must end
 * in .app.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_NAME = "Agent Strip.app";
const BUNDLE_PATH = join(REPO_ROOT, "app/src-tauri/target/release/bundle/macos", APP_NAME);
const INSTALL_PATH = join("/Applications", APP_NAME);

const run = (step: string, command: string, args: readonly string[]): void => {
  const result = spawnSync(command, [...args], { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    process.stderr.write(`install-app: step "${step}" failed with status ${result.status ?? "signal"}\n`);
    process.exit(1);
  }
};

run("build", "bun", ["run", "bundle:app"]);
if (!existsSync(BUNDLE_PATH)) {
  process.stderr.write(`install-app: bundle missing at ${BUNDLE_PATH}\n`);
  process.exit(1);
}
if (existsSync(INSTALL_PATH)) {
  if (!INSTALL_PATH.endsWith(".app")) {
    process.stderr.write(`install-app: refusing to remove non-app path ${INSTALL_PATH}\n`);
    process.exit(1);
  }
  rmSync(INSTALL_PATH, { recursive: true });
}
cpSync(BUNDLE_PATH, INSTALL_PATH, { recursive: true });
process.stdout.write(`install-app: installed ${INSTALL_PATH}\n`);
process.stdout.write("install-app: launch it once (open -a 'Agent Strip'); login autostart enables itself on first run\n");
```

Add to `package.json` scripts:

```json
"install:app": "bun scripts/install-app.ts"
```

- [ ] **Step 2: Verify the installer**

Run: `bun run install:app`
Expected: release build completes (first release build is slow), `/Applications/Agent Strip.app` exists.

Run: `open -a "Agent Strip"`
Expected: the app launches and pins to the Edge.

- [ ] **Step 3: Update docs/design.md**

Append a `## Strip app (Xeneon Edge)` section documenting the strip's visible contract:

- Geometry: 4 tiles + fixed 24%-width rail; viewport-unit sizing so 2560×720 native and 1280×360 HiDPI render identically.
- Tile anatomy is a DOM/CSS port of the keypad tile: same status colors (`#20B8FF` working / `#FFB020` waiting / `#4ADE80` idle / `#FF4D67` error, `#94A3B8` neutral chrome), same animation semantics (working 4s wash at 0.04–0.14 opacity + static 30% frame, waiting 4s frame breathe 0.20–0.90, error 2s pulse, idle static), same provider chips/letters/colors, model label right of chip (vendor prefix stripped, 10-code-point cap — the keypad's badged 6-point cap does not apply), title clamped to 2 lines with ellipsis (replaces the manual 12-code-point wrap), descendant badge upper-right, Paseo pip bottom-right (filled = parent, hollow = subagent, `#A78BFA`), degraded `!` flag, OFFLINE blank when degraded.
- Rail: daemon health (ok + heartbeat age / OFFLINE), clock, unread count (on-grid idle+error tiles), page dots with tap-to-jump.
- Interaction: click = the keypad's keyDown (fire-and-forget ack, then paseo/claude/codex/kimi routing; failure or unroutable = tile flash).

- [ ] **Step 4: Update AGENTS.md**

Add a "Xeneon strip app" paragraph under Conventions covering: `app/` (webview) + `app/src-tauri/` (crate) layout; `bun run build:app` / `dev:app` / `bundle:app` / `install:app`; the app is a third snapshot consumer — daemon and plugin unchanged; strip geometry via `STRIP_GEOMETRY` in `src/plugin/layout.ts` (4 tiles, rail pages — no NEXT tile); tile visuals live in `app/styles.css` + `app/src/tiles.ts` (web-native port of `render.ts`; keep the two in sync via `docs/design.md`); window pins to the monitor matching "xeneon edge" or physical 2560×720, re-pins on reconnect, autostarts at login; quota panels are deliberately deferred (rail is a plain section stack so they slot in later).

- [ ] **Step 5: Run the repo gate**

Run: `bun run check`
Expected: `biome ci` clean, core+plugin build, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/install-app.ts package.json docs/design.md AGENTS.md
git commit -m "feat(app): install script and strip docs"
```

- [ ] **Step 7: On-hardware acceptance (user runs; agent records)**

Hand the user this checklist; when they report back, record the outcomes in `docs/verification/<today>-xeneon-strip-acceptance.md` and commit it:

1. `bun run install:app` installs cleanly; `open -a "Agent Strip"` pins the frameless window to the Edge.
2. With the daemon running, live sessions render with animated status frames matching the Stream Deck's colors/motion.
3. OFFLINE path: `launchctl bootout gui/$(id -u)/com.drewritter.stream-deck-agents`, wait ~10s → tiles dim/flag, rail shows OFFLINE; restore with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.drewritter.stream-deck-agents.plist`.
4. Touch (with the Touchscreen Gestures driver installed): tapping a Claude tile focuses its Ghostty terminal and clears its unread state; a paseo-origin tile opens the Paseo agent. Mouse click does the same.
5. With >4 live sessions, rail dots page and the choice survives an app restart.
6. Unplug the Edge → window parks on the primary display; replug → re-pins within ~5s.
7. Log out/in (or reboot) → the app auto-launches.
8. Display scaling: switch the Edge to a scaled 1280×360 mode → layout and text scale proportionally, nothing clips.

---

## Self-Review Notes

- Spec coverage: Tauri shell (Tasks 3, 7, 11), snapshot contract + staleness (Tasks 5, 8), layout parameterization (Task 2), web-native tiles (Task 8), rail (Task 9), interaction parity (Tasks 4, 10), install/build/docs (Tasks 3, 12). Quota panels, daemon changes, iCUE compat, and Stream Deck retirement are out of scope per the spec.
- Known deliberate deviation from spec wording: the app re-parses the snapshot every poll rather than mtime-gating the parse (Global Constraints; staleness must be evaluated every poll anyway, and DOM updates are signature-gated).
- Type-consistency checks made while writing: `SnapshotPayload.mtimeMs` matches Rust's `#[serde(rename = "mtimeMs")]`; `SnapshotPayload` is structurally identical to `SnapshotRead` (Task 5) so the payload passes directly; `RailActions.onJumpToPage` is 0-based and `RailModel.page` is 1-based; `KeyModel` import lands in Task 10 (Task 8's main.ts must not import it); Task 3's temporary `.tile.blank` CSS is removed in Task 8.
