# Xeneon Strip Shell & Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lane B of the Xeneon strip feature set — replace the strip's 2s snapshot poll with Rust file-watch push, and add the touchscreen's first gestures: a long-press per-session action sheet and horizontal swipe paging.

**Architecture:** The Rust host (`app/src-tauri`) watches the daemon's app-support **directory** with the `notify` crate (the daemon publishes by atomic rename, so the file's inode is swapped, not written) and emits a `snapshot-changed` Tauri event carrying the exact `read_snapshot` payload shape (`{ mtimeMs, contents }`). The webview does one initial read, then ingests pushed payloads; a slow 10s timer remains solely for the staleness check (dead daemon → OFFLINE) plus recovery reads while degraded. Gestures are classified by a new pure, unit-tested state machine (`app/src/gestures.ts`) fed by pointer listeners in `app/src/main.ts`; a long-press opens a DOM action sheet (`app/src/action-sheet.ts`, pure model + DOM render, the `rail.ts` pattern) backed by two new fixed-argv Rust commands (`reveal_transcript`, `clear_session`); a horizontal fling pages via the existing `jumpToPage`.

**Tech Stack:** Bun + TypeScript (strict), Tauri 2 (WKWebView, Rust core, `notify` v8), `bun test` for pure frontend logic, `cargo check`/`cargo clippy` as the Rust gate.

Spec: `docs/superpowers/specs/2026-08-19-xeneon-strip-features-design.md` (Features 2 and 3 only).

**Lane boundary:** This is Lane B (shell & interaction). Lane A (data surface) owns `src/protocol.ts`, the daemon, and the tile-content additions. Lane B depends on Lane A only for the `transcriptPath` snapshot field, and reads it **defensively** so this lane lands green with or without Lane A (Reveal transcript is simply disabled until the field exists). Lanes A and B both touch `app/src/main.ts` and `app/styles.css` — if Lane A's edits are present, apply this plan's edits on top; the regions differ (Lane A: `unreadCount`, rail/timer; Lane B: ingest/start/pointer wiring/sheet/swipe) except the import block and the header comment, which may need a manual merge.

## Global Constraints

- Existing tests must pass unmodified. New logic gets new test files (`test/strip-gestures.test.ts`, `test/strip-action-sheet.test.ts`).
- Biome: 2-space indent, double quotes, semicolons, 120 cols; `noExplicitAny`, `noConsole` (the temporary pointer logger in Task 3 writes to the DOM, never the console), `noProcessEnv`, `noDefaultExport`, `noNonNullAssertion` (relaxed in `test/**`), nursery `noFloatingPromises` (void every fire-and-forget promise), `useImportType`.
- tsconfig strictness: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature` (bracket access, e.g. `dataset["keyIndex"]`, `record["transcriptPath"]`), `verbatimModuleSyntax` (`import type`), `erasableSyntaxOnly` (no enums), `noImplicitReturns`.
- Tests: `bun test`, files in `test/`, `import { describe, expect, test } from "bun:test"`. Bun has **no DOM** — only pure modules are unit-tested; DOM/Tauri wiring is verified by typecheck + build + the on-panel checklist (the repo's existing split: `monitors.ts` tested / `window.ts` not, `snapshot-view.ts` tested / `main.ts` not).
- Rust is not bun-testable: gate with `cargo check` and `cargo clippy` run in `app/src-tauri`. Adding `notify` fetches from crates.io once (network needed) and rewrites `app/src-tauri/Cargo.lock` — commit the lockfile.
- New Rust commands follow the existing pattern (`ack_session`, `main.rs:57-64`): installed-binary or system-binary absolute path, fixed argv, no shell, blocking wait.
- **No swipe-to-ack.** It violates the locked "only viewing clears unread" rule. Swipe pages; nothing else.
- **Quota data never appears here** — no `quota-snapshot.json`, no `read_quota_snapshot`; that is Lane C.
- The app must keep working when Lane A has not landed: `transcriptPath` is read defensively (`Record<string, unknown>` bracket access) and the Reveal item degrades to disabled.
- No capabilities changes: `core:default` already includes `core:event:default` (allow-listen/unlisten/emit/emit-to — verified in `app/src-tauri/gen/schemas/desktop-schema.json`), and `navigator.clipboard` is a web API needing no Tauri permission.
- Conventional commits matching `git log --oneline` style (`feat(app): …`, `docs(app): …`). **Never `git add -A`** — the working tree carries unrelated changes; stage exactly the files each task lists.
- Never edit existing dated files under `docs/superpowers/` or `docs/verification/`; new records get new dated files.
- Per-task gates: `bun run typecheck`, targeted `bun test`, `bun run build:app` (frontend tasks), `cargo check && cargo clippy` in `app/src-tauri` (Rust tasks). Final gate: `bun run check`.

---

### Task 1: Rust snapshot file-watch and the `snapshot-changed` event

Add the `notify` dependency, extract a shared `read_snapshot_payload`, and watch the app-support directory (never the file — the daemon's atomic-rename publish swaps inodes, so a file watch dies on the first publish). On any event touching `snapshot-v2.json`, re-read the file and emit `snapshot-changed` with the identical payload shape as `read_snapshot`. The watcher is a process-lifetime resource, deliberately leaked after a successful `watch()`; a failed watch is swallowed — the frontend's staleness reads (Task 2) are the fallback.

**Files:**
- Modify: `app/src-tauri/Cargo.toml` (dependencies, lines 9-12)
- Modify: `app/src-tauri/src/main.rs` (full-file rewrite of the 91-line file; every existing command preserved verbatim except one stale comment)
- Modify: `app/src-tauri/Cargo.lock` (regenerated by `cargo check`)

**Interfaces:**
- Consumes: nothing new (existing `app_support_root`, `run`, `SnapshotPayload`).
- Produces: Tauri event `snapshot-changed` with payload `{ mtimeMs: number; contents: string }` — structurally identical to the `read_snapshot` result (`SnapshotPayload`, `main.rs:8-13`). Task 2 subscribes to this exact event name.

- [ ] **Step 1: Add the `notify` dependency**

In `app/src-tauri/Cargo.toml`, change the `[dependencies]` section (lines 9-12) to:

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-autostart = "2"
serde = { version = "1", features = ["derive"] }
notify = "8"
```

- [ ] **Step 2: Rewrite `app/src-tauri/src/main.rs`**

Replace the whole file with:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use notify::{Event, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use std::time::UNIX_EPOCH;
use tauri::Emitter;

const SNAPSHOT_FILE_NAME: &str = "snapshot-v2.json";
const SNAPSHOT_CHANGED_EVENT: &str = "snapshot-changed";

#[derive(Serialize, Clone)]
struct SnapshotPayload {
    #[serde(rename = "mtimeMs")]
    mtime_ms: u64,
    contents: String,
}

fn app_support_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|error| error.to_string())?;
    Ok(PathBuf::from(home).join("Library/Application Support/com.drewritter.stream-deck-agents"))
}

fn read_snapshot_payload() -> Result<SnapshotPayload, String> {
    let path = app_support_root()?.join(SNAPSHOT_FILE_NAME);
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
async fn read_snapshot() -> Result<SnapshotPayload, String> {
    read_snapshot_payload()
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
/// dependency-light beyond tauri/serde/notify.
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

/// Watch the app-support directory — not the file, because the daemon
/// publishes by atomic rename, which swaps the file's inode — and push every
/// snapshot-v2.json change to the webview with the same payload shape as
/// `read_snapshot`.
fn watch_snapshot(app: &tauri::App) -> Result<(), String> {
    let directory = app_support_root()?;
    let handle = app.handle().clone();
    let mut watcher = notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
        let Ok(event) = result else {
            return;
        };
        let touches_snapshot = event
            .paths
            .iter()
            .any(|path| path.file_name().and_then(|name| name.to_str()) == Some(SNAPSHOT_FILE_NAME));
        if !touches_snapshot {
            return;
        }
        // Read fresh rather than trusting the event: a burst of events for one
        // publish collapses into identical payloads, which the webview skips.
        if let Ok(payload) = read_snapshot_payload() {
            let _ = handle.emit(SNAPSHOT_CHANGED_EVENT, payload);
        }
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(&directory, RecursiveMode::NonRecursive)
        .map_err(|error| error.to_string())?;
    // Process-lifetime resource: dropping the watcher would stop delivery, so
    // it is deliberately leaked once the watch is live.
    std::mem::forget(watcher);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            // A failed watch (for example the app-support directory does not
            // exist yet) must not sink the app: the webview's 10s staleness
            // reads are the fallback until an event stream exists.
            let _ = watch_snapshot(app);
            Ok(())
        })
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

Notes on the deliberate choices:

- `SnapshotPayload` gains `Clone` because `Emitter::emit` requires `S: Serialize + Clone`.
- `notify::recommended_watcher` picks the platform backend (FSEvents on macOS). The callback signature is `FnMut(Result<Event, notify::Error>) + Send + 'static`; the captured `AppHandle` is `Send`.
- `std::mem::forget(watcher)` is intentional: there is no owner to store it in, and dropping it silently stops delivery. If clippy's `mem_forget` lint fires in the executor's toolchain, allow it locally with `#[allow(clippy::mem_forget)]` on `watch_snapshot` — do not restructure into `Box::leak`, which has the same semantics.

- [ ] **Step 3: Rust gate**

Run: `cd app/src-tauri && cargo check`
Expected: PASS. First run fetches `notify` and transitive deps from crates.io and rewrites `Cargo.lock`.

Run: `cd app/src-tauri && cargo clippy`
Expected: PASS with no warnings (apply the local `#[allow]` above only if `mem_forget` fires).

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/main.rs
git commit -m "feat(app): push snapshot changes from a directory watch"
```

---

### Task 2: Frontend push ingestion — drop the 2s poll

Subscribe to `snapshot-changed`, keep one initial `read_snapshot`, and replace the 2s interval with a 10s staleness-only timer. The `lastGood` degradation logic in `app/src/snapshot-view.ts` is untouched — `reduceSnapshotRead` already models staleness as a pure function of `(read, lastGood, now)`, so re-reducing the last payload at a new `now` is exactly the OFFLINE check.

**Files:**
- Modify: `app/src/bridge.ts` (whole file is 18 lines; add the event import and one export)
- Modify: `app/src/main.ts` (header comment lines 1-6, `POLL_MS` line 18, module state line 24 area, import line 11, `poll` lines 114-121, `start` lines 133-142)
- Test: none new — the reduction is already covered by `test/strip-snapshot-view.test.ts`; this task is wiring only (repo convention: `main.ts` is the untested wiring boundary). Gates are typecheck + build + on-panel.

**Interfaces:**
- Consumes: the `snapshot-changed` event (Task 1); existing `readSnapshot` bridge and `reduceSnapshotRead` (`app/src/snapshot-view.ts:30-48`).
- Produces: `onSnapshotChanged(handler: (payload: SnapshotPayload) => void): Promise<UnlistenFn>` in `app/src/bridge.ts`; main.ts `ingest(payload: SnapshotPayload | null)` used by the initial read, the event subscription, and the staleness timer.

- [ ] **Step 1: Add the subscribe wrapper to `app/src/bridge.ts`**

Change the import block (lines 1-4) from:

```ts
/** The webview's narrow call surface into the Rust host (see src-tauri/main.rs). */

import { invoke } from "@tauri-apps/api/core";
import type { Provider } from "../../src/protocol";
```

to:

```ts
/** The webview's narrow call surface into the Rust host (see src-tauri/main.rs). */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Provider } from "../../src/protocol";
```

Append at the end of the file:

```ts
/**
 * Subscribe to the Rust host's file-watch push. The event name matches
 * SNAPSHOT_CHANGED_EVENT in src-tauri/main.rs; the payload shape is identical
 * to readSnapshot's result. Resolves to an unlisten fn — unused at app
 * lifetime. Requires no capability entry: core:default includes
 * core:event:allow-listen.
 */
export const onSnapshotChanged = (handler: (payload: SnapshotPayload) => void): Promise<UnlistenFn> =>
  listen<SnapshotPayload>("snapshot-changed", (event) => handler(event.payload));
```

- [ ] **Step 2: Rework `app/src/main.ts` from poll to push**

Replace the header comment (lines 1-6):

```ts
/**
 * App entry: one initial snapshot read, then daemon pushes via the Rust
 * host's file watch (snapshot-changed events). A slow 10s timer only
 * re-checks staleness (a dead daemon's heartbeat stops, rendering OFFLINE)
 * and retries real reads while degraded, so a missed event or a
 * late-starting daemon self-heals. Layout reduces with the strip geometry
 * and re-renders only when the serialized key models change (so CSS status
 * animations are never restarted). Page settings persist to localStorage;
 * the reducer validates them on every read.
 */
```

Replace the import from `./bridge` (line 11):

```ts
import {
  ackSession,
  focusGhostty,
  onSnapshotChanged,
  openUrl,
  readPaseoServerId,
  readSnapshot,
  type SnapshotPayload,
} from "./bridge";
```

Replace `const POLL_MS = 2000;` (line 18) with:

```ts
const STALENESS_CHECK_MS = 10_000;
```

Add one module-state line directly under `let lastReadMtimeMs: number | null = null;` (line 24):

```ts
let lastPayload: SnapshotPayload | null = null;
```

Replace the `poll` function (lines 114-121) with:

```ts
const ingest = (payload: SnapshotPayload | null): void => {
  lastPayload = payload;
  lastReadMtimeMs = payload === null ? null : payload.mtimeMs;
  const reduction = reduceSnapshotRead(payload, lastGood, Date.now());
  lastGood = reduction.lastGood;
  currentView = reduction.view;
  applyLayout(reduceLayout(reduction.view, loadStoredSettings(), STRIP_GEOMETRY));
};

const readAndIngest = async (): Promise<void> => {
  ingest(await readSnapshot().catch(() => null));
};

/**
 * The staleness half of the old 2s poll: a healthy view only needs its file
 * age re-evaluated against the last payload (no I/O); a degraded view retries
 * a real read so a missed event or a late-starting daemon self-heals.
 */
const checkStaleness = async (): Promise<void> => {
  if (lastPayload !== null && currentView !== null && !currentView.degraded) {
    ingest(lastPayload);
    return;
  }
  await readAndIngest();
};
```

Replace the `start` function (lines 133-142) with:

```ts
const start = (): void => {
  void startStripWindowManager();
  void ensureAutostart();
  wireInteraction();
  void readAndIngest();
  void onSnapshotChanged(ingest);
  setInterval(() => {
    void checkStaleness();
  }, STALENESS_CHECK_MS);
  setInterval(renderRailNow, 1000);
};
```

Everything below `start` stays unchanged.

- [ ] **Step 3: Verify**

Run: `bun run typecheck`
Expected: PASS (both tsconfigs; `app/tsconfig.json` picks up the bridge/main edits).

Run: `bun test test/strip-snapshot-view.test.ts`
Expected: PASS unmodified — the reduction contract is unchanged.

Run: `bun run build:app`
Expected: bundle succeeds; `listen` resolves from `@tauri-apps/api/event`.

- [ ] **Step 4: Smoke the push path on the panel**

Run: `bun run dev:app` (daemon running). Expected: tiles render as before; when a watched session changes state (start or finish a turn in one), its tile flips within ~1s of the daemon's publish rather than on the old up-to-2s cadence. Kill the daemon (`launchctl bootout gui/$(id -u)/com.drewritter.stream-deck-agents`) → within ~10s the strip degrades to OFFLINE; restart it (`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.drewritter.stream-deck-agents.plist`) → the strip recovers without an app restart. If push never delivers (tiles update only on the 10s fallback), STOP and report — do not proceed to gestures on a broken event path.

- [ ] **Step 5: Commit**

```bash
git add app/src/bridge.ts app/src/main.ts
git commit -m "feat(app): ingest pushed snapshots, poll only for staleness"
```

---

### Task 3: Pointer gesture recognizer (long-press core) + on-panel touch validation

A pure state machine classifies each stroke from the pointer events main.ts feeds it. This task ships tap-preservation (click suppression after non-tap strokes) and long-press detection with a temporary visible behavior (flash the tile) used to validate the hardware; Task 4 swaps the flash for the action sheet, Task 5 adds swipe classification. The on-panel pointer validation is folded in as a temporary, **never committed** DOM logger: it proves the Xeneon delivers pointer events to the webview before gesture behavior depends on them.

**Files:**
- Create: `app/src/gestures.ts`
- Modify: `app/src/main.ts` (module state after line 27, `onTilesClick` lines 151-171, `wireInteraction` lines 173-175, plus new functions before `wireInteraction`)
- Modify: `app/styles.css` (`#strip` rule, lines 15-21)
- Test: `test/strip-gestures.test.ts`

**Interfaces:**
- Consumes: main.ts's existing `currentKeys`, `flashTile`, `onTilesClick`.
- Produces (Task 4 and 5 rely on these exactly):
  - `type GesturePoint = { readonly x: number; readonly y: number }`
  - `type GestureInput` — `{ kind: "down" | "move" | "up"; point; now } | { kind: "cancel" | "tick"; now }` (see full union below)
  - `type GestureIntent` — this task: `{ kind: "longpress"; point } | { kind: "suppress-click" }`; Task 5 adds `{ kind: "swipe"; direction }`
  - `const LONG_PRESS_MS = 500`, `const MOVE_SLOP_PX = 12`
  - `createGestureRecognizer(): { feed(input): GestureIntent[]; longPressDueAt(): number | null }`
  - main.ts: `pendingLongPress: PendingLongPress | null`, `handleGestureIntents`, `suppressNextClick` — the wiring points Task 4 and 5 hook into.

- [ ] **Step 1: Write the failing test**

Create `test/strip-gestures.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createGestureRecognizer, type GestureInput, LONG_PRESS_MS, MOVE_SLOP_PX } from "../app/src/gestures";

const down = (x: number, y: number, now: number): GestureInput => ({ kind: "down", point: { x, y }, now });
const move = (x: number, y: number, now: number): GestureInput => ({ kind: "move", point: { x, y }, now });
const up = (x: number, y: number, now: number): GestureInput => ({ kind: "up", point: { x, y }, now });
const tick = (now: number): GestureInput => ({ kind: "tick", now });

describe("createGestureRecognizer", () => {
  test("a clean tap emits nothing and does not suppress the click", () => {
    const recognizer = createGestureRecognizer();
    expect(recognizer.feed(down(100, 100, 0))).toEqual([]);
    expect(recognizer.feed(up(100, 100, 80))).toEqual([]);
  });

  test("a tick before the deadline does not fire the long-press", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    expect(recognizer.feed(tick(LONG_PRESS_MS - 1))).toEqual([]);
  });

  test("holding past the deadline fires the long-press once and swallows the trailing click", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    expect(recognizer.feed(tick(LONG_PRESS_MS))).toEqual([{ kind: "longpress", point: { x: 100, y: 100 } }]);
    expect(recognizer.feed(tick(LONG_PRESS_MS + 100))).toEqual([]);
    expect(recognizer.feed(up(100, 100, LONG_PRESS_MS + 200))).toEqual([{ kind: "suppress-click" }]);
  });

  test("jitter within the slop radius keeps the long-press alive", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    recognizer.feed(move(100 + MOVE_SLOP_PX - 2, 100, 200));
    expect(recognizer.feed(tick(LONG_PRESS_MS))).toEqual([{ kind: "longpress", point: { x: 100, y: 100 } }]);
  });

  test("moving past the slop kills the long-press and the release suppresses the click", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    recognizer.feed(move(100 + MOVE_SLOP_PX + 10, 100, 200));
    expect(recognizer.longPressDueAt()).toBeNull();
    expect(recognizer.feed(tick(LONG_PRESS_MS + 50))).toEqual([]);
    expect(recognizer.feed(up(140, 100, 300))).toEqual([{ kind: "suppress-click" }]);
  });

  test("longPressDueAt tracks the stroke lifecycle", () => {
    const recognizer = createGestureRecognizer();
    expect(recognizer.longPressDueAt()).toBeNull();
    recognizer.feed(down(100, 100, 1000));
    expect(recognizer.longPressDueAt()).toBe(1000 + LONG_PRESS_MS);
    recognizer.feed(up(100, 100, 1100));
    expect(recognizer.longPressDueAt()).toBeNull();
  });

  test("a second finger's down is ignored while a stroke is tracked", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    expect(recognizer.feed(down(300, 300, 10))).toEqual([]);
    expect(recognizer.feed(tick(LONG_PRESS_MS))).toEqual([{ kind: "longpress", point: { x: 100, y: 100 } }]);
  });

  test("a cancel drops the stroke silently", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    expect(recognizer.feed({ kind: "cancel", now: 100 })).toEqual([]);
    expect(recognizer.feed(tick(LONG_PRESS_MS))).toEqual([]);
    expect(recognizer.feed(up(100, 100, 200))).toEqual([]);
  });

  test("a stroke that long-pressed stays suppressed even after drifting", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    recognizer.feed(tick(LONG_PRESS_MS));
    recognizer.feed(move(400, 100, LONG_PRESS_MS + 100));
    expect(recognizer.feed(up(400, 100, LONG_PRESS_MS + 200))).toEqual([{ kind: "suppress-click" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/strip-gestures.test.ts`
Expected: FAIL — `../app/src/gestures` does not resolve.

- [ ] **Step 3: Implement `app/src/gestures.ts`**

```ts
/**
 * Pointer-gesture classification for the strip: a pure state machine fed
 * pointer events (plus a long-press deadline tick) by main.ts, emitting
 * intents. Tap routing stays with the existing click handler; the recognizer
 * only decides when a stroke was something else (long-press, and in a later
 * task, swipe) and when the trailing click must be swallowed. No DOM, no
 * timers — the caller maps Date.now() and setTimeout onto tick/dueAt.
 */

export type GesturePoint = { readonly x: number; readonly y: number };

export type GestureInput =
  | { readonly kind: "down"; readonly point: GesturePoint; readonly now: number }
  | { readonly kind: "move"; readonly point: GesturePoint; readonly now: number }
  | { readonly kind: "up"; readonly point: GesturePoint; readonly now: number }
  | { readonly kind: "cancel"; readonly now: number }
  | { readonly kind: "tick"; readonly now: number };

export type GestureIntent =
  | { readonly kind: "longpress"; readonly point: GesturePoint }
  | { readonly kind: "suppress-click" };

export const LONG_PRESS_MS = 500;
export const MOVE_SLOP_PX = 12;

type Stroke = {
  readonly start: GesturePoint;
  readonly deadline: number;
  moved: boolean;
  longPressed: boolean;
};

export type GestureRecognizer = {
  /** Feed one event; returns the intents it produced (usually empty). */
  feed: (input: GestureInput) => GestureIntent[];
  /** Absolute `now` at which a long-press tick is due; null when the current stroke cannot long-press. */
  longPressDueAt: () => number | null;
};

export const createGestureRecognizer = (): GestureRecognizer => {
  let stroke: Stroke | null = null;

  const longPressDueAt = (): number | null =>
    stroke !== null && !stroke.moved && !stroke.longPressed ? stroke.deadline : null;

  const feed = (input: GestureInput): GestureIntent[] => {
    switch (input.kind) {
      case "down": {
        if (stroke !== null) {
          return []; // a second finger's down is ignored mid-stroke
        }
        stroke = { start: input.point, deadline: input.now + LONG_PRESS_MS, moved: false, longPressed: false };
        return [];
      }
      case "move": {
        if (stroke === null || stroke.longPressed) {
          return [];
        }
        if (Math.hypot(input.point.x - stroke.start.x, input.point.y - stroke.start.y) > MOVE_SLOP_PX) {
          stroke.moved = true;
        }
        return [];
      }
      case "tick": {
        if (stroke !== null && !stroke.moved && !stroke.longPressed && input.now >= stroke.deadline) {
          stroke.longPressed = true;
          return [{ kind: "longpress", point: stroke.start }];
        }
        return [];
      }
      case "up": {
        if (stroke === null) {
          return [];
        }
        const finished = stroke;
        stroke = null;
        return finished.longPressed || finished.moved ? [{ kind: "suppress-click" }] : [];
      }
      case "cancel": {
        stroke = null;
        return [];
      }
    }
  };

  return { feed, longPressDueAt };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/strip-gestures.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Wire the recognizer into `app/src/main.ts`**

Add to the `./gestures` imports — insert this line after the `./bridge` import block:

```ts
import { createGestureRecognizer, type GestureInput, type GestureIntent, type GesturePoint } from "./gestures";
```

Add module state directly under `let currentKeys: readonly KeyModel[] = [];` (line 27):

```ts
type PendingLongPress = { index: number; tile: HTMLElement; point: GesturePoint };

const gestures = createGestureRecognizer();
let gestureTimer: number | null = null;
let pendingLongPress: PendingLongPress | null = null;
let suppressNextClick = false;
```

Add these functions immediately before `wireInteraction` (line 173):

```ts
const tileFromPointerEvent = (event: PointerEvent): PendingLongPress | null => {
  if (!(event.target instanceof HTMLElement)) {
    return null;
  }
  const tile = event.target.closest<HTMLElement>("[data-key-index]");
  if (tile === null) {
    return null;
  }
  const index = Number(tile.dataset["keyIndex"]);
  const model = currentKeys[index];
  if (model === undefined || model.kind !== "session") {
    return null;
  }
  return { index, tile, point: { x: event.clientX, y: event.clientY } };
};

const handleGestureIntents = (intents: readonly GestureIntent[]): void => {
  for (const intent of intents) {
    switch (intent.kind) {
      case "longpress":
        if (pendingLongPress !== null) {
          flashTile(pendingLongPress.tile); // Task 4 replaces the flash with the action sheet.
        }
        break;
      case "suppress-click":
        suppressNextClick = true;
        break;
    }
  }
};

const scheduleLongPressTimer = (): void => {
  if (gestureTimer !== null) {
    clearTimeout(gestureTimer);
    gestureTimer = null;
  }
  const dueAt = gestures.longPressDueAt();
  if (dueAt !== null) {
    gestureTimer = setTimeout(
      () => {
        gestureTimer = null;
        handleGestureIntents(gestures.feed({ kind: "tick", now: Date.now() }));
      },
      Math.max(0, dueAt - Date.now()),
    );
  }
};

const feedPointer = (input: GestureInput): void => {
  handleGestureIntents(gestures.feed(input));
  scheduleLongPressTimer();
};

const onStripPointerDown = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  pendingLongPress = tileFromPointerEvent(event);
  feedPointer({ kind: "down", point: { x: event.clientX, y: event.clientY }, now: Date.now() });
};

const onStripPointerMove = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  feedPointer({ kind: "move", point: { x: event.clientX, y: event.clientY }, now: Date.now() });
};

const onStripPointerUp = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  feedPointer({ kind: "up", point: { x: event.clientX, y: event.clientY }, now: Date.now() });
  pendingLongPress = null;
};

const onStripPointerCancel = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  feedPointer({ kind: "cancel", now: Date.now() });
  pendingLongPress = null;
};
```

Replace `wireInteraction` (lines 173-175) with:

```ts
const wireInteraction = (): void => {
  document.querySelector<HTMLElement>("#tiles")?.addEventListener("click", onTilesClick);
  const strip = document.querySelector<HTMLElement>("#strip");
  strip?.addEventListener("pointerdown", onStripPointerDown);
  strip?.addEventListener("pointermove", onStripPointerMove);
  strip?.addEventListener("pointerup", onStripPointerUp);
  strip?.addEventListener("pointercancel", onStripPointerCancel);
};
```

Add the suppression guard at the top of `onTilesClick` (its body currently starts at line 152 with `if (!(event.target instanceof HTMLElement)) {`):

```ts
const onTilesClick = (event: MouseEvent): void => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  if (!(event.target instanceof HTMLElement)) {
    return;
  }
  // ...rest unchanged
```

In `app/styles.css`, extend the `#strip` rule (lines 15-21) so gestures are never stolen by native pan/zoom or the touch callout:

```css
#strip {
  display: grid;
  grid-template-columns: 1fr 24%;
  gap: 1.56vw;
  padding: 8.33vh 1.56vw;
  height: 100vh;
  touch-action: none;
  -webkit-touch-callout: none;
}
```

- [ ] **Step 6: Verify build and tests**

Run: `bun run typecheck && bun test test/strip-gestures.test.ts && bun run build:app`
Expected: all PASS.

- [ ] **Step 7: On-panel pointer validation (temporary logger — never committed)**

Add this block at the end of `start()` in `app/src/main.ts` (working tree only):

```ts
  // TEMPORARY pointer diagnostics for Xeneon validation — remove before commit.
  const debug = document.createElement("div");
  debug.style.cssText = "position:fixed;left:0;top:0;z-index:99;background:#000;color:#0f0;font-size:24px;padding:8px;";
  document.body.append(debug);
  let lines: string[] = [];
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) {
    document.querySelector<HTMLElement>("#strip")?.addEventListener(type, (event) => {
      lines = [...lines.slice(-4), `${type} ${event.pointerType} ${Math.round(event.clientX)},${Math.round(event.clientY)}`];
      debug.textContent = lines.join("  |  ");
    });
  }
```

Run: `bun run dev:app` with the window on the Xeneon panel. Touch the strip: tap, hold, drag.

Expected and decision:
- Touch produces `pointerdown`/`pointermove`/`pointerup` lines with `pointerType` `touch` (or `mouse` if the digitizer emulates one) → gestures are viable. Long-pressing a session tile flashes it after ~500ms. Record the observed `pointerType` for the Task 7 verification record.
- Touch produces **no** pointer events at all → STOP. Remove the logger, commit nothing further from Tasks 3-5, and report: gestures degrade to mouse-compatible behavior (taps keep working via the click handler); the finding goes to the orchestrator/user.

Then **delete the temporary block entirely** and re-run `bun run typecheck && bun run build:app` to confirm the tree is clean.

- [ ] **Step 8: Commit**

```bash
git add app/src/gestures.ts test/strip-gestures.test.ts app/src/main.ts app/styles.css
git commit -m "feat(app): pointer gesture recognizer with long-press"
```

(The temp logger was removed in Step 7 and is not part of this commit; verify with `git diff --cached app/src/main.ts` that no `gesture-debug` code is staged.)

---

### Task 4: Long-press action sheet

The long-press intent now opens a small overlay sheet anchored at the touch point: Open (the tap's existing ack + routing), Ack, Reveal transcript (new Rust command; disabled while the snapshot carries no `transcriptPath`), Copy session ID (`navigator.clipboard`), and Clear session (new Rust command running the installed binary's `sessions clear`, behind an inline two-tap confirm). Dismissal: pointer-down on the backdrop or Escape.

**Files:**
- Create: `app/src/action-sheet.ts`
- Test: `test/strip-action-sheet.test.ts`
- Modify: `app/src-tauri/src/main.rs` (insert two commands after `ack_session`; extend `generate_handler!`)
- Modify: `app/src/bridge.ts` (two new exports)
- Modify: `app/src/main.ts` (replace the Task-3 flash in `handleGestureIntents`; add sheet state/functions; Escape in `wireInteraction`; imports)
- Modify: `app/styles.css` (append sheet styles at end of file, after the `@container` block ending line 305)

**Interfaces:**
- Consumes: Task 3's `pendingLongPress`, `handleGestureIntents`; existing `pressSessionTile` (`app/src/press.ts:20`) and bridge functions; `sessions clear <provider> <session-id>` argv confirmed at `src/core/cli.ts:311-329`; Lane A's locked `transcriptPath: string | null` snapshot field (read defensively — absent pre-Lane-A).
- Produces:
  - `type SheetActionId = "open" | "ack" | "reveal" | "copy" | "clear"`
  - `buildSheetModel(session: ProjectedSession, options: SheetOptions): SheetModel`
  - `reduceSheetSelection(clearArmed: boolean, id: SheetActionId): { clearArmed: boolean; fire: boolean }`
  - `transcriptPathOf(session: ProjectedSession): string | null`
  - `buildSheetOverlay(model: SheetModel, handlers: SheetHandlers): HTMLElement`
  - Rust commands `reveal_transcript(path)`, `clear_session(provider, session_id)`; bridge `revealTranscript`, `clearSession`.

- [ ] **Step 1: Write the failing test**

Create `test/strip-action-sheet.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildSheetModel, reduceSheetSelection, transcriptPathOf } from "../app/src/action-sheet";
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

/**
 * transcriptPath is additive (Lane A): inject it the way a new daemon
 * would, regardless of whether the type has the field yet.
 */
const withTranscriptPath = (path: string | null): ProjectedSession => {
  const value = session();
  (value as Record<string, unknown>)["transcriptPath"] = path;
  return value;
};

describe("transcriptPathOf", () => {
  test("is null when the key is absent (old daemon / pre-Lane-A protocol)", () => {
    expect(transcriptPathOf(session())).toBeNull();
  });

  test("is null for a null or empty value", () => {
    expect(transcriptPathOf(withTranscriptPath(null))).toBeNull();
    expect(transcriptPathOf(withTranscriptPath(""))).toBeNull();
  });

  test("returns a present path", () => {
    expect(transcriptPathOf(withTranscriptPath("/tmp/t.jsonl"))).toBe("/tmp/t.jsonl");
  });
});

describe("buildSheetModel", () => {
  test("lists the five actions in order", () => {
    const model = buildSheetModel(session(), { title: "A session", clipboardAvailable: true, clearArmed: false });
    expect(model.title).toBe("A session");
    expect(model.items.map((item) => item.id)).toEqual(["open", "ack", "reveal", "copy", "clear"]);
    expect(model.items.map((item) => item.label)).toEqual([
      "Open",
      "Ack",
      "Reveal transcript",
      "Copy session ID",
      "Clear session",
    ]);
  });

  test("Reveal transcript is disabled without a transcript path, enabled with one", () => {
    const disabled = buildSheetModel(session(), { title: "t", clipboardAvailable: true, clearArmed: false });
    expect(disabled.items[2]?.enabled).toBe(false);
    const enabled = buildSheetModel(withTranscriptPath("/tmp/t.jsonl"), {
      title: "t",
      clipboardAvailable: true,
      clearArmed: false,
    });
    expect(enabled.items[2]?.enabled).toBe(true);
  });

  test("Copy session ID is disabled when the clipboard API is unavailable", () => {
    const model = buildSheetModel(session(), { title: "t", clipboardAvailable: false, clearArmed: false });
    expect(model.items[3]?.enabled).toBe(false);
  });

  test("an armed clear shows the confirm label and the confirming flag", () => {
    const model = buildSheetModel(session(), { title: "t", clipboardAvailable: true, clearArmed: true });
    expect(model.items[4]).toEqual({ id: "clear", label: "Confirm clear", enabled: true, confirming: true });
  });
});

describe("reduceSheetSelection", () => {
  test("the first clear tap arms without firing", () => {
    expect(reduceSheetSelection(false, "clear")).toEqual({ clearArmed: true, fire: false });
  });

  test("the second clear tap fires and disarms", () => {
    expect(reduceSheetSelection(true, "clear")).toEqual({ clearArmed: false, fire: true });
  });

  test("any other action fires immediately and resets the arm", () => {
    expect(reduceSheetSelection(true, "ack")).toEqual({ clearArmed: false, fire: true });
    expect(reduceSheetSelection(false, "open")).toEqual({ clearArmed: false, fire: true });
  });
});
```

Note for the executor: if Lane A has already landed, `ProjectedSession` carries the five new required fields — add `unreadSince: null, statusSince: null, activityLine: null, transcriptPath: null, originParentRef: null` to the `session` factory above so typecheck passes, and keep `withTranscriptPath` as the injector for the enabled-path tests.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/strip-action-sheet.test.ts`
Expected: FAIL — `../app/src/action-sheet` does not resolve.

- [ ] **Step 3: Implement `app/src/action-sheet.ts`**

```ts
/**
 * Long-press action sheet: the per-session action menu. buildSheetModel,
 * reduceSheetSelection, and transcriptPathOf are the pure, tested core;
 * buildSheetOverlay is the DOM surface (like renderRail — exercised on the
 * panel, not under bun test). All text goes through textContent.
 */

import type { ProjectedSession } from "../../src/protocol";

export type SheetActionId = "open" | "ack" | "reveal" | "copy" | "clear";

export type SheetItem = {
  id: SheetActionId;
  label: string;
  enabled: boolean;
  /** True only for the armed "Confirm clear" state. */
  confirming: boolean;
};

export type SheetModel = {
  title: string;
  items: SheetItem[];
};

export type SheetOptions = {
  /** Tile label — the layout's title/project fallbacks are already applied. */
  title: string;
  clipboardAvailable: boolean;
  clearArmed: boolean;
};

/**
 * transcriptPath rides the snapshot as an additive field (Lane A); until it
 * lands, parsed sessions simply lack the key. Read it defensively so the
 * sheet works — with Reveal disabled — against both protocol shapes.
 */
export const transcriptPathOf = (session: ProjectedSession): string | null => {
  const record: Record<string, unknown> = session;
  const value = record["transcriptPath"];
  return typeof value === "string" && value.length > 0 ? value : null;
};

export const buildSheetModel = (session: ProjectedSession, options: SheetOptions): SheetModel => ({
  title: options.title,
  items: [
    { id: "open", label: "Open", enabled: true, confirming: false },
    { id: "ack", label: "Ack", enabled: true, confirming: false },
    { id: "reveal", label: "Reveal transcript", enabled: transcriptPathOf(session) !== null, confirming: false },
    { id: "copy", label: "Copy session ID", enabled: options.clipboardAvailable, confirming: false },
    {
      id: "clear",
      label: options.clearArmed ? "Confirm clear" : "Clear session",
      enabled: true,
      confirming: options.clearArmed,
    },
  ],
});

/** Inline confirm for the destructive action: Clear must be tapped twice. */
export const reduceSheetSelection = (
  clearArmed: boolean,
  id: SheetActionId,
): { clearArmed: boolean; fire: boolean } => {
  if (id === "clear" && !clearArmed) {
    return { clearArmed: true, fire: false };
  }
  return { clearArmed: false, fire: true };
};

export type SheetHandlers = {
  onAction: (id: SheetActionId) => void;
  onDismiss: () => void;
};

/**
 * Full-window overlay carrying the sheet; the caller appends it to the body
 * and positions the `.action-sheet` element. A pointer-down landing on the
 * backdrop (not the sheet) dismisses.
 */
export const buildSheetOverlay = (model: SheetModel, handlers: SheetHandlers): HTMLElement => {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) {
      handlers.onDismiss();
    }
  });
  const sheet = document.createElement("div");
  sheet.className = "action-sheet";
  const title = document.createElement("div");
  title.className = "sheet-title";
  title.textContent = model.title;
  sheet.append(title);
  for (const item of model.items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = item.confirming ? "sheet-item confirming" : "sheet-item";
    button.disabled = !item.enabled;
    button.textContent = item.label;
    button.addEventListener("click", () => handlers.onAction(item.id));
    sheet.append(button);
  }
  overlay.append(sheet);
  return overlay;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/strip-action-sheet.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Add the two Rust commands**

In `app/src-tauri/src/main.rs` (as left by Task 1), insert immediately after the `ack_session` function:

```rust
/// Reveal a session transcript in Finder: `/usr/bin/open -R <path>`, fixed
/// argv, no shell. The path comes from the daemon's own snapshot field.
#[tauri::command]
async fn reveal_transcript(path: &str) -> Result<(), String> {
    run("/usr/bin/open", &["-R", path])
}

/// Destructive session delete via the installed binary, mirroring
/// `ack_session`'s fixed-argv invocation (`sessions clear <provider> <id>`,
/// validated in src/core/cli.ts). The webview gates this behind a confirm.
#[tauri::command]
async fn clear_session(provider: &str, session_id: &str) -> Result<(), String> {
    let executable = app_support_root()?.join("bin/stream-deck-agents");
    let path = executable.to_string_lossy().to_string();
    run(&path, &["sessions", "clear", provider, session_id])
}
```

Extend the `generate_handler!` list — replace:

```rust
            ack_session,
            open_url,
```

with:

```rust
            ack_session,
            reveal_transcript,
            clear_session,
            open_url,
```

Run: `cd app/src-tauri && cargo check && cargo clippy`
Expected: PASS, no warnings.

- [ ] **Step 6: Extend the bridge**

Append to `app/src/bridge.ts`:

```ts
export const revealTranscript = (path: string): Promise<void> => invoke<void>("reveal_transcript", { path });

/** Destructive: deletes the session row. The action sheet confirms before calling this. */
export const clearSession = (provider: Provider, sessionId: string): Promise<void> =>
  invoke<void>("clear_session", { provider, sessionId });
```

- [ ] **Step 7: Wire the sheet into `app/src/main.ts`**

Extend the `./bridge` import block to include `clearSession` and `revealTranscript` (alphabetical: after `ackSession`, before `focusGhostty` / after `onSnapshotChanged`… final block):

```ts
import {
  ackSession,
  clearSession,
  focusGhostty,
  onSnapshotChanged,
  openUrl,
  readPaseoServerId,
  readSnapshot,
  revealTranscript,
  type SnapshotPayload,
} from "./bridge";
```

Add the action-sheet import immediately **before** the `./bridge` import block (biome's `organizeImports` assist sorts by module path: `./action-sheet` < `./bridge` — verified enforced by `biome check`):

```ts
import {
  buildSheetModel,
  buildSheetOverlay,
  reduceSheetSelection,
  type SheetActionId,
  transcriptPathOf,
} from "./action-sheet";
```

Add `ProjectedSession` to the protocol type imports — the line `import type { SessionSnapshotV2, SnapshotView } from "../../src/protocol";` becomes:

```ts
import type { ProjectedSession, SessionSnapshotV2, SnapshotView } from "../../src/protocol";
```

Add sheet state under the Task-3 gesture state (`let suppressNextClick = false;`):

```ts
type SheetContext = {
  point: GesturePoint;
  session: ProjectedSession;
  label: string;
  tile: HTMLElement;
};

let sheetOverlay: HTMLElement | null = null;
let sheetClearArmed = false;
```

Add these functions immediately before `handleGestureIntents`:

```ts
const dismissActionSheet = (): void => {
  sheetOverlay?.remove();
  sheetOverlay = null;
  sheetClearArmed = false;
};

const clipboardAvailable = (): boolean => "clipboard" in navigator;

const openActionSheet = (context: SheetContext): void => {
  sheetOverlay?.remove(); // re-render path keeps sheetClearArmed; real dismissals reset it
  const model = buildSheetModel(context.session, {
    title: context.label,
    clipboardAvailable: clipboardAvailable(),
    clearArmed: sheetClearArmed,
  });
  const overlay = buildSheetOverlay(model, {
    onAction: (id) => runSheetAction(context, id),
    onDismiss: dismissActionSheet,
  });
  document.body.append(overlay);
  const sheet = overlay.querySelector<HTMLElement>(".action-sheet");
  if (sheet !== null) {
    const x = Math.min(
      Math.max(context.point.x, sheet.offsetWidth / 2 + 8),
      window.innerWidth - sheet.offsetWidth / 2 - 8,
    );
    const y = Math.min(Math.max(context.point.y, sheet.offsetHeight + 8), window.innerHeight - 8);
    sheet.style.left = `${x - sheet.offsetWidth / 2}px`;
    sheet.style.top = `${y - sheet.offsetHeight}px`; // above the finger
  }
  sheetOverlay = overlay;
};

const runSheetAction = (context: SheetContext, id: SheetActionId): void => {
  const selection = reduceSheetSelection(sheetClearArmed, id);
  sheetClearArmed = selection.clearArmed;
  if (!selection.fire) {
    openActionSheet(context); // re-render with the armed "Confirm clear" label
    return;
  }
  dismissActionSheet();
  const { session, tile } = context;
  switch (id) {
    case "open":
      void pressSessionTile(session, {
        ack: ackSession,
        openUrl,
        focusGhostty,
        readPaseoServerId,
        flash: () => flashTile(tile),
      });
      return;
    case "ack":
      void ackSession(session.provider, session.sessionId).catch(() => {});
      return;
    case "reveal": {
      const path = transcriptPathOf(session);
      if (path !== null) {
        void revealTranscript(path).catch(() => {});
      }
      return;
    }
    case "copy":
      if (clipboardAvailable()) {
        void navigator.clipboard.writeText(session.sessionId).catch(() => {});
      }
      return;
    case "clear":
      void clearSession(session.provider, session.sessionId).catch(() => {});
      return;
  }
};

const openActionSheetFor = (pending: PendingLongPress): void => {
  const model = currentKeys[pending.index];
  if (model === undefined || model.kind !== "session") {
    return;
  }
  sheetClearArmed = false;
  openActionSheet({ point: pending.point, session: model.session, label: model.label, tile: pending.tile });
};
```

In `handleGestureIntents` (Task 3), replace the `longpress` case:

```ts
      case "longpress":
        if (pendingLongPress !== null) {
          openActionSheetFor(pendingLongPress);
        }
        break;
```

In `wireInteraction`, add the Escape dismissal (backdrop pointer-down dismissal lives in `buildSheetOverlay`):

```ts
const wireInteraction = (): void => {
  document.querySelector<HTMLElement>("#tiles")?.addEventListener("click", onTilesClick);
  const strip = document.querySelector<HTMLElement>("#strip");
  strip?.addEventListener("pointerdown", onStripPointerDown);
  strip?.addEventListener("pointermove", onStripPointerMove);
  strip?.addEventListener("pointerup", onStripPointerUp);
  strip?.addEventListener("pointercancel", onStripPointerCancel);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      dismissActionSheet();
    }
  });
};
```

Note: the overlay covers the whole window, so while the sheet is open, pointer events land on the overlay — not `#strip` — and the gesture recognizer is naturally unaffected.

- [ ] **Step 8: Sheet styles**

Append to `app/styles.css` (after the closing brace of the `@container (max-height: 40vh)` block, end of file):

```css
/* Long-press action sheet. The overlay covers the window; the sheet is
   positioned by main.ts at the touch point. */
.sheet-overlay {
  position: fixed;
  inset: 0;
  z-index: 10;
  background: rgb(0 0 0 / 0.25);
}
.action-sheet {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 0.6vh;
  min-width: 16vw;
  padding: 1.2vh 0.8vw;
  background: #1a2230;
  border: 1px solid #2a3342;
  border-radius: 0.8vw;
  box-shadow: 0 1vh 4vh rgb(0 0 0 / 0.5);
}
.sheet-title {
  max-width: 22vw;
  padding: 0 0.6vw 0.8vh;
  border-bottom: 1px solid #2a3342;
  color: #94a3b8;
  font-size: 1.3vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sheet-item {
  appearance: none;
  border: none;
  border-radius: 0.5vw;
  background: none;
  color: #e8eef7;
  font-size: 1.6vw;
  padding: 1.2vh 0.8vw;
  text-align: left;
  cursor: pointer;
}
.sheet-item:active {
  background: #232b38;
}
.sheet-item:disabled {
  color: #4a5568;
  cursor: default;
}
.sheet-item.confirming {
  color: #ff4d67;
  font-weight: 700;
}
```

- [ ] **Step 9: Verify**

Run: `bun run typecheck && bun test test/strip-action-sheet.test.ts test/strip-gestures.test.ts && bun run build:app`
Expected: all PASS.

Run: `bun run dev:app` and long-press a tile on the panel. Expected: the sheet opens near the touch point with the tile label as its title; "Reveal transcript" is disabled until Lane A lands (enabled afterwards for sessions with a transcript); a plain tap elsewhere dismisses it.

- [ ] **Step 10: Commit**

```bash
git add app/src/action-sheet.ts test/strip-action-sheet.test.ts app/src-tauri/src/main.rs app/src/bridge.ts app/src/main.ts app/styles.css
git commit -m "feat(app): long-press session action sheet"
```

---

### Task 5: Horizontal swipe paging

Extend the recognizer with fling classification (TDD) and wire the swipe intent to the existing `jumpToPage`, clamped to the valid page range. Thresholds keep taps, long-presses, and sloppy drags unambiguous: 80px minimum horizontal travel, 48px maximum vertical drift, dominant-axis implied. No time bound — a slow horizontal drag-release paging is acceptable and simpler. There is deliberately no swipe-to-ack.

**Files:**
- Modify: `app/src/gestures.ts` (intent union, constants, `up` case)
- Test: `test/strip-gestures.test.ts` (append a swipe describe block)
- Modify: `app/src/main.ts` (`handleGestureIntents` swipe case + `onSwipe`)

**Interfaces:**
- Consumes: Task 3's recognizer and wiring; existing `jumpToPage(page)` (`app/src/main.ts:56-65` pre-Lane-B), `currentPage`, `currentPageCount`. `reduceLayout` clamps high pages (`src/plugin/layout.ts:170`) but not negative ones — `onSwipe` clamps both ends before calling.
- Produces: `GestureIntent` gains `{ readonly kind: "swipe"; readonly direction: "previous" | "next" }`; `const SWIPE_MIN_HORIZONTAL_PX = 80`, `const SWIPE_MAX_VERTICAL_PX = 48`.

- [ ] **Step 1: Write the failing tests**

Append to `test/strip-gestures.test.ts` (add `SWIPE_MIN_HORIZONTAL_PX` to the import from `../app/src/gestures`):

```ts
describe("swipe classification", () => {
  test("a leftward fling pages next and suppresses the click", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(400 - SWIPE_MIN_HORIZONTAL_PX - 40, 320, 120));
    expect(recognizer.feed(up(280, 320, 200))).toEqual([
      { kind: "swipe", direction: "next" },
      { kind: "suppress-click" },
    ]);
  });

  test("a rightward fling pages previous", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 300, 0));
    recognizer.feed(move(100 + SWIPE_MIN_HORIZONTAL_PX + 40, 310, 150));
    expect(recognizer.feed(up(220, 310, 250))).toEqual([
      { kind: "swipe", direction: "previous" },
      { kind: "suppress-click" },
    ]);
  });

  test("a vertical-dominant drag is not a swipe but still swallows the click", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 100, 0));
    recognizer.feed(move(430, 400, 200));
    expect(recognizer.feed(up(430, 400, 250))).toEqual([{ kind: "suppress-click" }]);
  });

  test("a short horizontal drag below the threshold is not a swipe", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(400 + SWIPE_MIN_HORIZONTAL_PX - 20, 305, 150));
    expect(recognizer.feed(up(400 + SWIPE_MIN_HORIZONTAL_PX - 20, 305, 200))).toEqual([
      { kind: "suppress-click" },
    ]);
  });

  test("a stroke that long-pressed never becomes a swipe", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(tick(LONG_PRESS_MS));
    recognizer.feed(move(100, 300, LONG_PRESS_MS + 100));
    expect(recognizer.feed(up(100, 300, LONG_PRESS_MS + 200))).toEqual([{ kind: "suppress-click" }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/strip-gestures.test.ts`
Expected: FAIL — `SWIPE_MIN_HORIZONTAL_PX` is not exported.

- [ ] **Step 3: Extend `app/src/gestures.ts`**

Replace the `GestureIntent` type with:

```ts
export type GestureIntent =
  | { readonly kind: "longpress"; readonly point: GesturePoint }
  | { readonly kind: "swipe"; readonly direction: "previous" | "next" }
  | { readonly kind: "suppress-click" };
```

Add the constants under `MOVE_SLOP_PX`:

```ts
export const SWIPE_MIN_HORIZONTAL_PX = 80;
export const SWIPE_MAX_VERTICAL_PX = 48;
```

Replace the `up` case in `feed` with:

```ts
      case "up": {
        if (stroke === null) {
          return [];
        }
        const finished = stroke;
        stroke = null;
        if (finished.longPressed) {
          return [{ kind: "suppress-click" }];
        }
        const dx = input.point.x - finished.start.x;
        const dy = input.point.y - finished.start.y;
        if (Math.abs(dx) >= SWIPE_MIN_HORIZONTAL_PX && Math.abs(dy) <= SWIPE_MAX_VERTICAL_PX) {
          return [{ kind: "swipe", direction: dx < 0 ? "next" : "previous" }, { kind: "suppress-click" }];
        }
        return finished.moved ? [{ kind: "suppress-click" }] : [];
      }
```

Also update the module header comment's intent list ("long-press, and in a later task, swipe" → "long-press or swipe").

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/strip-gestures.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Wire `onSwipe` in `app/src/main.ts`**

Add immediately before `handleGestureIntents`:

```ts
const onSwipe = (direction: "previous" | "next"): void => {
  if (currentView === null || currentPageCount <= 1) {
    return;
  }
  const delta = direction === "next" ? 1 : -1;
  jumpToPage(Math.min(Math.max(currentPage + delta, 0), currentPageCount - 1));
};
```

Add the swipe case to `handleGestureIntents`:

```ts
      case "swipe":
        onSwipe(intent.direction);
        break;
```

`jumpToPage` already re-renders the rail (page dots follow) and persists the page through `applyLayout`'s dirty-settings path, exactly like a page-dot tap.

- [ ] **Step 6: Verify**

Run: `bun run typecheck && bun test test/strip-gestures.test.ts && bun run build:app`
Expected: all PASS.

On-panel (`bun run dev:app`): a plain tap still routes and a hold still opens the sheet after a fling surface touch. Paging itself needs >15 live sessions (`STRIP_GEOMETRY.pageSessionKeys` is 15, `src/plugin/layout.ts:39-44`) — with fewer, `onSwipe`'s `currentPageCount <= 1` guard makes the fling a correct no-op; trust the unit tests for direction mapping in that case. With 16+ sessions: a horizontal fling left advances one page, right goes back, and the rail dots follow.

- [ ] **Step 7: Commit**

```bash
git add app/src/gestures.ts test/strip-gestures.test.ts app/src/main.ts
git commit -m "feat(app): horizontal swipe paging"
```

---

### Task 6: Docs — `docs/design.md` interaction section

The strip's visible interaction contract changes; `docs/design.md` must record it. `AGENTS.md` needs no update: its strip prose (third snapshot consumer, geometry, sync via `docs/design.md`) does not mention polling cadence or gestures, and the daemon/plugin descriptions are untouched — verify that claim while editing and only then skip it.

**Files:**
- Modify: `docs/design.md` (Interaction section, lines 342-346 — currently the file's final section)

**Interfaces:**
- Consumes: the behavior shipped in Tasks 1-5.
- Produces: the recorded contract Lane A/C plans and future strip work read.

- [ ] **Step 1: Replace the Interaction section**

Replace lines 342-346 (the `### Interaction` section, currently just the tap bullet) with:

```md
### Interaction

- A tap is the keypad's keyDown: a fire-and-forget ack, then the same
  paseo/claude/codex/kimi routing. A failed or unroutable press flashes the
  tile.
- Snapshot delivery is push, not poll: the Rust host watches the app-support
  directory (the daemon publishes by atomic rename, which swaps the file's
  inode, so the watch targets the directory) and emits a `snapshot-changed`
  event carrying the same `{ mtimeMs, contents }` payload as `read_snapshot`.
  The webview does one initial read and then ingests events; a slow 10s
  timer only re-checks staleness (a dead daemon's 5s heartbeat stops,
  rendering OFFLINE) and retries real reads while degraded, so a missed
  event or a late-starting daemon self-heals.
- A long-press (~500ms without drifting past a 12px slop) on a session tile
  opens an action sheet anchored at the touch point: Open (the tap's ack +
  routing), Ack, Reveal transcript (`/usr/bin/open -R`; disabled until the
  snapshot carries `transcriptPath`), Copy session ID, and Clear session —
  the destructive action sits behind an inline two-tap confirm ("Confirm
  clear") and runs the installed binary's `sessions clear`. The sheet
  dismisses on a pointer-down outside it or on Escape.
- A horizontal fling (≥80px of travel with ≤48px of vertical drift) pages
  the tile grid — left for next, right for previous — reusing the rail's
  page jump, so the dots follow and the page persists. A stroke that moved
  but matched no gesture swallows its trailing click, keeping taps, holds,
  and drags unambiguous. There is deliberately no swipe-to-ack: only viewing
  clears unread.
```

- [ ] **Step 2: Check AGENTS.md staleness**

Read the strip paragraph of `AGENTS.md` (the "Xeneon strip app" bullet under Conventions). Expected: every statement still true (snapshot file consumer, geometry, build commands, pinning, deferred quota panels). If — and only if — a statement went stale, fix that sentence minimally.

- [ ] **Step 3: Run the repo gate**

Run: `bun run check`
Expected: `biome ci` clean, core+plugin build, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add docs/design.md
git commit -m "docs(app): strip snapshot push and gestures"
```

(Add `AGENTS.md` to the stage only if Step 2 amended it.)

---

### Task 7: On-panel verification and final gate

Exercises everything the lane shipped, on the physical Xeneon panel. Use the installed app (`bun run install:app`, then `open -a "Agent Strip"`) or `bun run dev:app` — one shell for the whole checklist.

- [ ] **Step 1: On-panel checklist**

1. **Push latency** — with the daemon running, start or finish a turn in a watched session: its tile flips within ~1s of the change, not on a 2s cadence. The rail's heartbeat age stays under ~5-6s between updates.
2. **OFFLINE path** — `launchctl bootout gui/$(id -u)/com.drewritter.stream-deck-agents`: within ~10s the strip degrades (OFFLINE rail, `!` flags). Restore with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.drewritter.stream-deck-agents.plist`: the strip recovers without an app restart, at push speed.
3. **Touch delivery** — record the `pointerType` observed during Task 3 Step 7 (expected `touch` or `mouse`). If it was "no pointer events", Tasks 4-5 were already halted there; note it and stop here.
4. **Tap regression** — a plain tap on a Claude tile focuses its Ghostty terminal and acks (an idle unread tile leaves the grid on the next publish); a Codex tile opens its thread; an unroutable tile flashes once.
5. **Long-press sheet** — a ~500ms hold opens the sheet near the finger with the tile's label as title and five items. "Reveal transcript" is disabled if Lane A has not landed; if it has landed, enabled for claude/codex sessions and reveals the file in Finder. "Ack" acks without routing. "Copy session ID" puts the session id on the clipboard (paste into a terminal to confirm). "Clear session" → "Confirm clear" → second tap removes the tile on the next publish. Tap outside dismisses; Escape (keyboard attached) dismisses.
6. **Swipe paging** — with more sessions than one page holds, a horizontal fling left advances one page, right goes back; the rail dots follow; the page survives an app restart (localStorage, same as dot taps). A tap mid-swipe-surface still routes; a vertical drag does nothing.
7. **Mouse parity** — every gesture above also works with a mouse (hold = long-press, drag-release = swipe).

- [ ] **Step 2: Record the verification**

Write `docs/verification/<today>-xeneon-strip-shell-acceptance.md` (new dated file — never edit existing ones) capturing: the observed `pointerType`, each checklist item's outcome, and any deviations.

```bash
git add docs/verification/<today>-xeneon-strip-shell-acceptance.md
git commit -m "test(app): strip shell on-panel acceptance record"
```

- [ ] **Step 3: Final gate**

Run: `bun run check`
Expected: `biome ci .` clean, `bun run build` (typecheck incl. app tsconfig, core binary, plugin bundle) succeeds, `bun test` all green. Plus `cd app/src-tauri && cargo check && cargo clippy` clean. Done.

---

## Self-Review Notes

- Spec coverage: Feature 2 file-watch push (Tasks 1-2: directory watch, `snapshot-v2.json` filter, `{ mtimeMs, contents }` payload identical to `read_snapshot`, initial read + `listen`, 10s staleness-only timer, `lastGood` degradation untouched). Feature 3 gestures (Tasks 3-5: long-press sheet with all five actions + inline clear confirm + outside/Escape dismissal, swipe paging via `jumpToPage`, touch validation folded into the first gesture task as a temporary logger that is removed before commit). Locked constraints honored: additive-only snapshot evolution (no protocol change in this lane), `docs/design.md` updated (Task 6), no swipe-to-ack, quota untouched.
- Deliberate deviations from spec wording, all disclosed in-line: (1) the sheet dismisses on backdrop **pointer-down** rather than pointer-up-outside — strictly more responsive on touch and a superset of the spec's intent; (2) the staleness timer also retries real reads while degraded — the spec's "solely for the staleness check" plus the recovery the file-watch design needs when the watch fails or the daemon starts late; (3) `transcriptPath` is read through a `Record<string, unknown>` bracket access instead of a typed field, so this lane compiles and runs green whether or not Lane A has landed — simplify to `session.transcriptPath` after Lane A merges (noted in Task 4's test step).
- No capabilities changes were needed: verified in `app/src-tauri/gen/schemas/desktop-schema.json` that `core:default` includes `core:event:default` (allow-listen/unlisten/emit/emit-to); `navigator.clipboard` is a plain web API.
- Type-consistency checks made while writing: `SnapshotPayload` in `bridge.ts:6` matches the Rust struct's `mtimeMs` rename; `onSnapshotChanged`'s handler type is assignable to main.ts's `ingest(payload: SnapshotPayload | null)`; `KeyModel`'s session variant carries `label` (used by `tiles.ts:44`) for the sheet title; `clear_session`'s argv `["sessions", "clear", provider, session_id]` matches `src/core/cli.ts:311-329`; Rust command arg `session_id` ↔ JS `sessionId` camelCase conversion matches the proven `ack_session` pattern.
- Cross-lane conflicts: `app/src/main.ts` import block and header comment (Lane A also edits this file), `app/styles.css` (Lane A appends tile anatomy; Lane B appends sheet styles — disjoint blocks), `app/src-tauri/src/main.rs` (Lane C adds `read_quota_snapshot`; the `generate_handler!` list may need a merge).
