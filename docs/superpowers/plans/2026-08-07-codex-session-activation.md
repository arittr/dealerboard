# Codex Session Tile Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Stream Deck key press foreground the ChatGPT/Codex desktop app and select the exact thread represented by a Codex session tile, while every non-Codex session tile remains a no-op.

**Architecture:** Preserve the current hook-to-snapshot data path and use the full `ProjectedSession.sessionId` already present in each structured `KeyModel`. A plugin-local adapter encodes that ID into `codex://threads/<thread-id>` and calls the fixed macOS `/usr/bin/open -u` executable through Node's no-shell `execFile`; the SDK-independent controller routes Codex keys to that adapter and requests the pressed key's native alert if local launch fails.

**Tech Stack:** TypeScript, Bun and `bun:test`, Stream Deck's Node.js 24 plugin runtime, official `@elgato/streamdeck` SDK 2.1.0, Rollup, macOS LaunchServices via `/usr/bin/open`, and the official Stream Deck CLI for validation, packaging, and plugin-only restart.

**Spec:** `docs/superpowers/specs/2026-08-07-codex-session-activation-design.md` (approved by Drew; approval committed in `cb57eb5`).

## Global Constraints

- Gate A is first: prove that each Codex surface currently feeding the registry uses a hook `sessionId` accepted by `codex://threads/<thread-id>`. If any represented surface fails, commit the evidence receipt, stop, and redesign; do not start Task 2.
- Every `provider: "codex"` tile uses the desktop deep-link route, including a CLI-origin tile. This version does not focus a CLI terminal or window.
- Claude, Kimi, blank, missing, unsupported-layout, and cold-offline keys remain no-ops. `NEXT` behavior is unchanged.
- Use the full structured `sessionId`. Never derive activation from the rendered label, shortened ID, title, project, logical slot, coordinates, recency, or frontmost-window state.
- Construct `codex://threads/${encodeURIComponent(sessionId)}` and execute exactly `/usr/bin/open` with `['-u', url]`. Do not use a shell, ambient `PATH`, Elgato `system.openUrl`, `-n`, or `-g`.
- A successful `open` exit proves only local LaunchServices acceptance. Exact app foregrounding, exact existing-task selection, and absence of duplicate creation require live observation.
- One launcher failure produces one best-effort `showAlert(context)` request and no retry. An alert IPC failure must not escape `keyDown`.
- Resolve a press against the newest reduced `KeyModel` once at handler entry. Do not add schema/allocation revisions; the approved spec accepts the asynchronous redraw race and requires a follow-up design if it proves observable.
- Degraded last-good Codex tiles remain activatable; a blank cold/offline grid has no activation target.
- This is a plugin-only change. Do not modify `src/core/`, SQLite, the daemon, `src/protocol.ts`, snapshot parsing, layout, rendering, animation scheduling, or `src/plugin/session-grid-action.ts`.
- Do not read, extract, rewrite, or otherwise modify `/Applications/ChatGPT.app` or any file inside its bundle. Obtain the app version from its UI and deliver links only through LaunchServices.
- Keep Node.js 24, Stream Deck 7.1, macOS 12, `@elgato/streamdeck` 2.1.0, and manifest schema version 3 unchanged. Add no dependency.
- Update the plugin manifest version from `0.1.8.0` to `0.1.8.1` before packaging or local deployment.
- Tests assert structured calls and the small public URL contract. Do not assert large generated scripts, bundles, SVGs, or JSON strings.
- New dated spec, plan, and verification files are immutable records after their commits; never revise earlier dated records.
- Every code task follows red-green TDD, runs the full relevant verification commands, and commits only its exact files. Never skip pre-commit hooks.
- Source, package, installed-copy, and physical evidence are separate gates. Do not claim push, merge, installation, or physical success from source tests.

## File and interface map

- Create `src/plugin/codex-session-activation.ts`: own URL construction and the no-shell macOS process adapter. It exports `ActivateCodexSession`, `ProcessExecutor`, `createCodexSessionActivator`, and the production `activateCodexSession` function.
- Create `test/codex-session-activation.test.ts`: behaviorally verify fixed executable/arguments, path encoding, one-argument safety, and executor failure propagation.
- Modify `src/plugin/controller.ts`: add activation and alert ports; route one captured `KeyModel` without importing Node or the Stream Deck SDK.
- Modify `test/controller.test.ts`: add fake activation/alert ports and cover exact identity, provider/no-op behavior, degraded state, paging, reflow, and failure containment.
- Modify `src/plugin/plugin.ts`: wire the production activator and SDK-native alert through one shared current-key lookup.
- Modify `com.drewritter.stream-deck-agents.sdPlugin/manifest.json`: remove false read-only product copy and bump `0.1.8.0` to `0.1.8.1`.
- Create `docs/verification/2026-08-07-codex-session-deep-link-probe.md`: immutable Gate A receipt created only after the live probe.
- Create `docs/verification/2026-08-07-codex-session-activation-local.md`: immutable source/package/install/physical receipt created only after the final local gate.

---

### Task 1: Prove hook IDs are exact desktop deep-link IDs

**Files:**
- Create: `docs/verification/2026-08-07-codex-session-deep-link-probe.md`
- Read: `docs/superpowers/specs/2026-08-07-codex-session-activation-design.md`
- Read: `docs/hook-configuration.md:332-586`

**Interfaces:**
- Consumes: the installed `stream-deck-agents sessions list` output, OpenAI's documented `codex://threads/<thread-id>` route, and live Codex tasks whose identity Drew can confirm from their content.
- Produces: an immutable PASS/FAIL receipt proving whether every Codex surface currently producing tiles shares the desktop thread-ID contract. Tasks 2-5 require PASS for all represented surfaces.

This is a live UI/evidence task. Keep it with the coordinating agent; do not delegate app interaction to a code implementer. It may foreground Codex but must not inspect or modify the app bundle.

- [ ] **Step 1: Confirm the installed registry exposes candidate Codex identities**

Run the exact installed binary and print only identity/display metadata:

```bash
REGISTRY_BIN="$HOME/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents"
test -x "$REGISTRY_BIN"
"$REGISTRY_BIN" sessions list |
  jq -r '.[] | select(.provider == "codex" and .parentSessionId == null) | [.sessionId, (.title // ""), (.project // "")] | @tsv'
```

Expected: at least two top-level Codex rows. Record which rows came from Desktop and which came from CLI based on the known sessions Drew opened; the current snapshot has no source-surface field and must not infer one.

If fewer than two rows exist, open the required real sessions and wait for their `SessionStart` hooks rather than inserting registry rows manually.

- [ ] **Step 2: Establish an ambiguity pair and represented-surface coverage**

In Codex Desktop, prepare two existing tasks in the same project/worktree with the same visible title. Put the unique marker `ACTIVATION-PROBE-A` in one task and `ACTIVATION-PROBE-B` in the other so selected content, not title or path, establishes ground truth.

If Codex CLI currently produces Stream Deck tiles, keep one CLI-origin session active and give its content the marker `ACTIVATION-PROBE-CLI`. Re-run Step 1 and identify the full hook ID for every probe task.

Read the installed app version from the app's About/settings UI. Do not obtain it from `ChatGPT.app/Contents/Info.plist` or any other bundle file.

- [ ] **Step 3: Deliver each documented deep link through LaunchServices**

For each probe task, paste its full Step 1 ID into `read`, generate the URL with `jq`'s URI encoder, and open it without a shell-constructed command:

```bash
printf 'Full Codex thread ID: ' >&2
IFS= read -r CODEX_THREAD_ID
CODEX_THREAD_URL="$(jq -nr --arg id "$CODEX_THREAD_ID" '$id | @uri | "codex://threads/\(.)"')"
/usr/bin/open -u "$CODEX_THREAD_URL"
```

After each invocation, observe all three clauses before moving to the next ID:

1. ChatGPT/Codex becomes the foreground app.
2. The task containing the expected unique marker is selected.
3. No new task or duplicate sidebar entry appears.

Expected: PASS for A, B, and the CLI-origin probe when that surface is represented. An `/usr/bin/open` exit code of zero alone is not a PASS.

- [ ] **Step 4: Write the immutable Gate A receipt**

Create `docs/verification/2026-08-07-codex-session-deep-link-probe.md` with:

- date/time and the app version observed in the UI;
- the exact official documentation URL and URL shape tested;
- one row per probe containing source surface, full hook ID, visible title/project, unique marker, `open` exit result, foreground result, exact-selection result, and duplicate-creation result;
- an overall PASS only when every represented source surface passes every clause;
- a statement that no app-bundle file was read or changed; and
- a statement that no implementation code existed during the probe.

Do not leave unfilled fields. If any clause fails, record the actual failure and mark the receipt FAIL.

- [ ] **Step 5: Gate and commit the evidence**

Run:

```bash
git diff --check
git status --short
```

If the receipt is FAIL, commit it with the first command below, stop the plan, and ask Drew for a new design. If it is PASS, use the second command and continue to Task 2:

```bash
git add docs/verification/2026-08-07-codex-session-deep-link-probe.md
git commit -m "docs: record failed Codex deep-link identity probe"
```

```bash
git add docs/verification/2026-08-07-codex-session-deep-link-probe.md
git commit -m "docs: prove Codex hook IDs route to exact desktop tasks"
```

---

### Task 2: Add the no-shell Codex activation adapter

**Files:**
- Create: `src/plugin/codex-session-activation.ts`
- Create: `test/codex-session-activation.test.ts`

**Interfaces:**
- Consumes: Gate A's proven identity equivalence.
- Produces:
  - `type ActivateCodexSession = (sessionId: string) => Promise<void>`
  - `type ProcessExecutor = (file: string, args: readonly string[]) => Promise<void>`
  - `createCodexSessionActivator(execute: ProcessExecutor): ActivateCodexSession`
  - production `activateCodexSession: ActivateCodexSession`

- [ ] **Step 1: Write the failing adapter tests**

Create `test/codex-session-activation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  createCodexSessionActivator,
  type ProcessExecutor,
} from "../src/plugin/codex-session-activation";

type ProcessCall = {
  file: string;
  args: string[];
};

describe("Codex session activation", () => {
  test("opens one encoded technical thread ID through the fixed macOS launcher", async () => {
    const calls: ProcessCall[] = [];
    const execute: ProcessExecutor = (file, args) => {
      calls.push({ file, args: [...args] });
      return Promise.resolve();
    };
    const activate = createCodexSessionActivator(execute);

    await activate("thread/one?two space;ü$HOME&`");

    expect(calls).toEqual([
      {
        file: "/usr/bin/open",
        args: [
          "-u",
          "codex://threads/thread%2Fone%3Ftwo%20space%3B%C3%BC%24HOME%26%60",
        ],
      },
    ]);
  });

  test("propagates a launcher rejection", async () => {
    const failure = new Error("launch failed");
    const activate = createCodexSessionActivator(() => Promise.reject(failure));

    await expect(activate("thread-id")).rejects.toBe(failure);
  });
});
```

This test proves shell-significant input remains data in one URL argument; it does not execute a shell or create a sentinel file.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
bun test test/codex-session-activation.test.ts
```

Expected: FAIL because `src/plugin/codex-session-activation.ts` does not exist. If it passes, stop and inspect the worktree rather than continuing with an unknown prior implementation.

- [ ] **Step 3: Implement the minimal adapter**

Create `src/plugin/codex-session-activation.ts`:

```ts
/**
 * Exact Codex desktop navigation behind a small injectable process boundary.
 *
 * The fixed executable and argument array avoid shell parsing; the caller
 * receives only LaunchServices request success or failure, not app-level
 * confirmation that the requested task became visible.
 */

import { execFile } from "node:child_process";

export type ActivateCodexSession = (sessionId: string) => Promise<void>;

export type ProcessExecutor = (file: string, args: readonly string[]) => Promise<void>;

export const createCodexSessionActivator = (
  execute: ProcessExecutor,
): ActivateCodexSession =>
  (sessionId) =>
    execute("/usr/bin/open", [
      "-u",
      `codex://threads/${encodeURIComponent(sessionId)}`,
    ]);

const executeFile: ProcessExecutor = (file, args) =>
  new Promise<void>((resolve, reject) => {
    execFile(file, [...args], (error) => {
      if (error === null) {
        resolve();
        return;
      }
      reject(error);
    });
  });

export const activateCodexSession = createCodexSessionActivator(executeFile);
```

Do not add session-ID validation here. The existing hook/snapshot contract already supplies a non-empty bounded string, and `encodeURIComponent` makes it one URL path segment.

- [ ] **Step 4: Run focused and full verification to verify GREEN**

Run:

```bash
bun test test/codex-session-activation.test.ts
bun test
bun run typecheck
```

Expected: all commands PASS. Typecheck confirms the Node 24 child-process types fit the injected interface.

- [ ] **Step 5: Commit the adapter slice**

```bash
git status --short
git add src/plugin/codex-session-activation.ts test/codex-session-activation.test.ts
git commit -m "plugin: add exact Codex deep-link launcher"
```

---

### Task 3: Route Codex key presses and wire native failure alerts

**Files:**
- Modify: `test/controller.test.ts:130-190,492-525`
- Modify: `src/plugin/controller.ts:20-50,153-169`
- Modify: `src/plugin/plugin.ts:10-32`

**Interfaces:**
- Consumes: `ActivateCodexSession` and production `activateCodexSession` from Task 2; existing `KeyModel`, `ProjectedSession`, paging reducer, action-context lookup, and SDK `KeyAction.showAlert()`.
- Produces: required `SessionGridPorts.activateCodexSession` and `SessionGridPorts.showAlert`, exact Codex routing in `keyDown`, and production SDK/runtime wiring with no Node or SDK imports in the controller.

- [ ] **Step 1: Add fake activation and alert ports to the controller harness**

In `test/controller.test.ts`, add these fakes after `FakeImagePort`:

```ts
class FakeActivationPort {
  readonly sessionIds: string[] = [];
  failure: Error | null = null;

  readonly activate = (sessionId: string): Promise<void> => {
    this.sessionIds.push(sessionId);
    return this.failure === null ? Promise.resolve() : Promise.reject(this.failure);
  };
}

class FakeAlertPort {
  readonly contexts: string[] = [];
  failure: Error | null = null;

  readonly show = (context: string): Promise<void> => {
    this.contexts.push(context);
    return this.failure === null ? Promise.resolve() : Promise.reject(this.failure);
  };
}
```

Extend `Harness` and `makeController` exactly:

```ts
type Harness = {
  controller: SessionGridController;
  clock: FakeClock;
  snapshot: FakeSnapshotPort;
  settingsPort: FakeSettingsPort;
  images: FakeImagePort;
  activation: FakeActivationPort;
  alerts: FakeAlertPort;
};
```

```ts
  const activation = new FakeActivationPort();
  const alerts = new FakeAlertPort();
  const controller = new SessionGridController({
    readSnapshot: snapshot.read,
    getGlobalSettings: settingsPort.get,
    setGlobalSettings: settingsPort.set,
    setImage: images.send,
    activateCodexSession: activation.activate,
    showAlert: alerts.show,
    clock,
  });
  return { controller, clock, snapshot, settingsPort, images, activation, alerts };
```

Keep the existing options, snapshot/settings setup, and image port construction around that block unchanged.

- [ ] **Step 2: Replace the display-only key test with exact routing tests**

Replace `"key down on session and blank keys is ignored"` with:

```ts
  test("key down activates the full Codex ID and ignores every other key model", async () => {
    const fullSessionId = "01900000-0000-7000-8000-000000000001";
    const { controller, activation, alerts, settingsPort } = makeController({
      view: healthyView([
        session(1, {
          provider: "codex",
          sessionId: fullSessionId,
          title: null,
          project: null,
        }),
        session(2, { provider: "claude" }),
        session(3, { provider: "kimi" }),
      ]),
    });
    await controller.willAppear(appear("ctx-codex", 0, 0));
    await controller.willAppear(appear("ctx-claude", 0, 1));
    await controller.willAppear(appear("ctx-kimi", 0, 2));
    await controller.willAppear(appear("ctx-blank", 0, 3));

    await controller.keyDown("ctx-codex");
    await controller.keyDown("ctx-claude");
    await controller.keyDown("ctx-kimi");
    await controller.keyDown("ctx-blank");
    await controller.keyDown("missing-context");
    controller.deviceDidConnect("device-2", { columns: 5, rows: 3 });
    await controller.keyDown("ctx-codex");
    controller.deviceDidDisconnect("device-2");
    controller.willDisappear("ctx-codex");
    await controller.keyDown("ctx-codex");

    expect(activation.sessionIds).toEqual([fullSessionId]);
    expect(alerts.contexts).toEqual([]);
    expect(settingsPort.writes).toEqual([]);
  });

  test("a degraded last-good Codex tile remains activatable", async () => {
    const view = healthyView([
      session(1, { provider: "codex", sessionId: "degraded-thread" }),
    ]);
    view.degraded = true;
    const { controller, activation } = makeController({ view });
    await controller.willAppear(appear("ctx-codex", 0, 0));

    await controller.keyDown("ctx-codex");

    expect(activation.sessionIds).toEqual(["degraded-thread"]);
  });

  test("repeated Codex presses issue repeated activation requests", async () => {
    const { controller, activation } = makeController({
      view: healthyView([
        session(1, { provider: "codex", sessionId: "repeat-thread" }),
      ]),
    });
    await controller.willAppear(appear("ctx-codex", 0, 0));

    await controller.keyDown("ctx-codex");
    await controller.keyDown("ctx-codex");

    expect(activation.sessionIds).toEqual(["repeat-thread", "repeat-thread"]);
  });
```

- [ ] **Step 3: Add paging, reassignment, and failure tests**

Add these tests beside the existing `NEXT` test:

```ts
  test("after NEXT, key down activates the Codex session on the current page", async () => {
    const sessions = range(1, 16).map((slot) =>
      session(slot, { provider: "codex", sessionId: `codex-${slot}` }),
    );
    const { controller, activation, settingsPort } = makeController({
      stored: settings(true, 0),
      view: healthyView(sessions),
    });
    await fillGrid(controller);

    await controller.keyDown("ctx-14");
    await controller.keyDown("ctx-0");

    expect(settingsPort.writes).toEqual([settings(true, 1)]);
    expect(activation.sessionIds).toEqual(["codex-15"]);
  });

  test("a reflowed key activates its current Codex owner, never its removed owner", async () => {
    const { controller, clock, snapshot, activation } = makeController({
      view: healthyView([
        session(1, { provider: "codex", sessionId: "removed-thread" }),
        session(2, { provider: "codex", sessionId: "current-thread" }),
      ]),
    });
    await controller.willAppear(appear("ctx-codex", 0, 0));

    snapshot.view = healthyView([
      session(2, { provider: "codex", sessionId: "current-thread" }),
    ]);
    await clock.advance(POLL_MS);
    await controller.keyDown("ctx-codex");

    expect(activation.sessionIds).toEqual(["current-thread"]);
  });

  test("activation failure shows one alert and contains alert failure", async () => {
    const { controller, activation, alerts, settingsPort } = makeController({
      view: healthyView([
        session(1, { provider: "codex", sessionId: "failing-thread" }),
      ]),
    });
    await controller.willAppear(appear("ctx-codex", 0, 0));
    activation.failure = new Error("launch failed");

    await controller.keyDown("ctx-codex");
    alerts.failure = new Error("alert failed");
    await controller.keyDown("ctx-codex");

    expect(activation.sessionIds).toEqual(["failing-thread", "failing-thread"]);
    expect(alerts.contexts).toEqual(["ctx-codex", "ctx-codex"]);
    expect(settingsPort.writes).toEqual([]);
  });
```

The existing `NEXT` test remains in place and continues to prove page wrap and settings persistence. The first new routing test proves missing, unsupported-layout, and disappeared contexts no-op without adding another broad fixture.

- [ ] **Step 4: Run controller tests to verify RED**

Run:

```bash
bun test test/controller.test.ts
```

Expected: FAIL because current session keys still return without invoking the fake activation port. The existing `NEXT` test should remain green.

- [ ] **Step 5: Add controller activation and alert ports**

In `src/plugin/controller.ts`, add the type-only import:

```ts
import type { ActivateCodexSession } from "./codex-session-activation";
```

Extend `SessionGridPorts`:

```ts
export type SessionGridPorts = {
  readSnapshot: () => SnapshotView;
  getGlobalSettings: () => Promise<unknown>;
  setGlobalSettings: (settings: LayoutSettingsV1) => Promise<void>;
  setImage: SendImage;
  activateCodexSession: ActivateCodexSession;
  showAlert: (context: string) => Promise<void>;
  clock: SchedulerClock;
};
```

Update the module comment's side-effect list to `snapshot, settings, image, activation, alert, timers, monotonic time`, then replace `keyDown` with:

```ts
  async keyDown(context: string): Promise<void> {
    if (this.unsupportedReason !== null) {
      return;
    }
    const entry = this.contexts.get(context);
    if (entry === undefined || this.view === null || this.layout === null) {
      return;
    }
    const model = this.layout.keys[entry.index];
    if (model?.kind === "next") {
      this.layout = advanceLayoutPage(this.view, this.storedSettings);
      if (this.layout.dirty) {
        await this.persist(this.layout.settings);
      }
      return;
    }
    if (model?.kind !== "session" || model.session.provider !== "codex") {
      return;
    }
    const sessionId = model.session.sessionId;
    try {
      await this.ports.activateCodexSession(sessionId);
    } catch {
      try {
        await this.ports.showAlert(context);
      } catch {
        // Alert feedback is best-effort; an SDK rejection must not escape the
        // key event or retry an already-failed activation.
      }
    }
  }
```

- [ ] **Step 6: Wire the production adapter and native alert**

In `src/plugin/plugin.ts`, import the Task 2 production function:

```ts
import { activateCodexSession } from "./codex-session-activation";
```

After `snapshotCache`, add one shared lookup so `setImage` and `showAlert` do not duplicate context/type checks:

```ts
const keyActionForContext = (context: string) => {
  const target = streamDeck.actions.getActionById(context);
  return target !== undefined && target.isKey() ? target : undefined;
};
```

Then wire the three ports together:

```ts
  setImage: (context, image) =>
    keyActionForContext(context)?.setImage(image) ?? Promise.resolve(),
  activateCodexSession,
  showAlert: (context) =>
    keyActionForContext(context)?.showAlert() ?? Promise.resolve(),
```

Retain snapshot/settings and clock ports unchanged. `SessionGridAction.onKeyDown` remains unchanged because it already forwards the current action context ID.

- [ ] **Step 7: Run focused, full, type, and bundle verification to verify GREEN**

Run:

```bash
bun test test/controller.test.ts test/codex-session-activation.test.ts
bun test
bun run typecheck
bun run build:plugin
```

Expected: every command PASS. `build:plugin` proves Rollup preserves the Node built-in import for the Node.js 24 runtime without pulling Bun-only core modules into the plugin.

- [ ] **Step 8: Commit the controller/runtime slice**

```bash
git status --short
git add src/plugin/controller.ts src/plugin/plugin.ts test/controller.test.ts
git commit -m "plugin: activate Codex sessions on key press"
```

---

### Task 4: Publish truthful plugin metadata and pass the package gate

**Files:**
- Modify: `com.drewritter.stream-deck-agents.sdPlugin/manifest.json:3,10,24`

**Interfaces:**
- Consumes: the working plugin behavior from Tasks 2-3 and current manifest version `0.1.8.0`.
- Produces: version `0.1.8.1`, accurate interaction copy, a validated bundle, and one packaged `.streamDeckPlugin` artifact under `dist/`.

- [ ] **Step 1: Update only version and interaction copy**

In `manifest.json`, make these exact replacements while preserving tab formatting:

```json
"Version": "0.1.8.1",
```

```json
"Tooltip": "Shows live agent sessions; press a Codex tile to open its task.",
```

```json
"Description": "Displays live agent sessions from the local registry on a 15-key grid. Press a Codex tile to open its task in the desktop app.",
```

Do not change the action UUID, profile, SDK version, runtime floors, icons, states, or layout.

- [ ] **Step 2: Run the complete source and package gate**

Run:

```bash
git diff --check
bun test
bun run typecheck
bun run build:plugin
bun run pack:plugin
```

Expected:

- all tests PASS;
- typecheck exits zero;
- Rollup writes `com.drewritter.stream-deck-agents.sdPlugin/bin/plugin.js` and its source map;
- Stream Deck validation prints `Validation successful`; and
- packing succeeds with exactly one current `.streamDeckPlugin` artifact in `dist/`.

These commands prove source and package only. Do not report the installed plugin or physical device as updated.

- [ ] **Step 3: Review the complete implementation against the spec**

Run:

```bash
git diff main --stat
git diff main -- src/plugin test com.drewritter.stream-deck-agents.sdPlugin/manifest.json
```

Check each spec clause explicitly: exact full ID, fixed executable/arguments, no shell, Codex-only routing, degraded activation, repeated presses without debounce or queueing, current-page mapping, previous-owner rejection, single alert, no retry, unchanged successful-activation visuals, unchanged `NEXT`, unchanged core/protocol/layout/render/scheduler/action class, and truthful manifest copy.

Complete the reviewer checkpoint required by the execution workflow selected at handoff: `subagent-driven-development` runs its spec-compliance and code-quality reviewers, while `executing-plans` presents its batch checkpoint. Fix only validated in-scope findings, reproduce each behavioral issue with a focused failing test, rerun the commands in Step 2, and commit each coherent correction separately.

- [ ] **Step 4: Commit the manifest/package slice**

Generated bundle/package outputs stay governed by the repository's existing ignore/tracking rules. Commit only the manifest unless a validated review fix changed source:

```bash
git status --short
git add com.drewritter.stream-deck-agents.sdPlugin/manifest.json
git commit -m "plugin: advertise Codex tile activation"
```

---

### Task 5: Deploy only the plugin and record physical proof

**Files:**
- Create: `docs/verification/2026-08-07-codex-session-activation-local.md`
- Read: `AGENTS.md:16-38`

**Interfaces:**
- Consumes: source/package-green commit set from Tasks 2-4, manifest version `0.1.8.1`, Gate A PASS, the installed Stream Deck plugin directory, and Drew's physical observations.
- Produces: an installed plugin-only update plus an immutable receipt that separates source, package, installed-copy, and physical evidence. It does not modify or restart the core daemon.

This task mutates the installed Stream Deck plugin and restarts its process. Stop and get Drew's explicit immediate approval before Step 2. If Drew declines or is unavailable, end with source/package gates complete and report installed/physical as not run; do not create an empty receipt.

- [ ] **Step 1: Reconfirm source/package state before asking to deploy**

Run:

```bash
git status --short
git log --oneline --decorate -6
bun test
bun run typecheck
bun run build:plugin
bun run pack:plugin
```

Expected: clean tracked worktree, all source/package commands PASS, and current manifest version `0.1.8.1`.

- [ ] **Step 2: After Drew approves, copy only plugin artifacts and restart only the plugin**

Run exactly from the feature worktree:

```bash
INSTALLED_PLUGIN="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.drewritter.stream-deck-agents.sdPlugin"
SOURCE_PLUGIN="com.drewritter.stream-deck-agents.sdPlugin"

test -f "$INSTALLED_PLUGIN/manifest.json"
test -d "$INSTALLED_PLUGIN/bin"
test -f "$SOURCE_PLUGIN/manifest.json"
test -f "$SOURCE_PLUGIN/bin/plugin.js"
test -f "$SOURCE_PLUGIN/bin/plugin.js.map"
cp "$SOURCE_PLUGIN/manifest.json" "$INSTALLED_PLUGIN/manifest.json"
cp "$SOURCE_PLUGIN/bin/plugin.js" "$INSTALLED_PLUGIN/bin/plugin.js"
cp "$SOURCE_PLUGIN/bin/plugin.js.map" "$INSTALLED_PLUGIN/bin/plugin.js.map"
bun node_modules/@elgato/cli/bin/streamdeck.mjs restart com.drewritter.stream-deck-agents
```

Do not run `scripts/install-local.ts`; core files and the LaunchAgent are out of scope.

- [ ] **Step 3: Verify the installed copy, not just the source tree**

Run:

```bash
INSTALLED_PLUGIN="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.drewritter.stream-deck-agents.sdPlugin"
SOURCE_PLUGIN="com.drewritter.stream-deck-agents.sdPlugin"

jq -r '.Version' "$INSTALLED_PLUGIN/manifest.json"
cmp "$SOURCE_PLUGIN/manifest.json" "$INSTALLED_PLUGIN/manifest.json"
cmp "$SOURCE_PLUGIN/bin/plugin.js" "$INSTALLED_PLUGIN/bin/plugin.js"
cmp "$SOURCE_PLUGIN/bin/plugin.js.map" "$INSTALLED_PLUGIN/bin/plugin.js.map"
```

Expected: printed version `0.1.8.1`; every `cmp` exits zero.

- [ ] **Step 4: Perform the physical Stream Deck matrix**

With Drew observing the device and desktop app:

1. Background ChatGPT/Codex, press probe tile A, and confirm foreground plus `ACTIVATION-PROBE-A` content.
2. Repeat for probe tile B and confirm `ACTIVATION-PROBE-B`; neither press creates a duplicate task.
3. If a CLI-origin tile is present, press it and confirm the same exact thread opens in Desktop; do not claim terminal focus.
4. Press available Claude and Kimi tiles and confirm they remain no-ops.
5. Press `NEXT` and confirm paging/wrap are unchanged.
6. When at least sixteen sessions are genuinely present, press a Codex tile on page two and confirm it opens that page's exact thread. If fewer exist, record this clause as NOT RUN rather than synthesizing sessions or claiming it from unit tests.
7. Observe idle, working, waiting, error, descendant, and animation treatments remain unchanged for the states currently available; record unavailable states as NOT RUN.

Any wrong selection, duplicate task, activation from a non-Codex tile, broken `NEXT`, or lost rendering is a physical failure. Stop and diagnose; do not broaden the implementation with a fuzzy fallback.

- [ ] **Step 5: Create the immutable local verification receipt**

Create `docs/verification/2026-08-07-codex-session-activation-local.md` with separate sections for:

- source commit hashes and exact outputs/counts from `bun test`, typecheck, and build;
- package validation result and packaged artifact name;
- installed path, installed version, and the three successful `cmp` checks;
- each physical matrix clause marked PASS, FAIL, or NOT RUN with Drew's observed result;
- explicit statements that core/LaunchAgent and the ChatGPT app bundle were untouched; and
- explicit statements that push, merge, and broader release were not performed.

Do not convert NOT RUN into PASS based on unit or package evidence.

- [ ] **Step 6: Commit only the completed receipt**

```bash
git diff --check
git status --short
git add docs/verification/2026-08-07-codex-session-activation-local.md
git commit -m "docs: record Codex tile activation local verification"
```

End by reporting branch/worktree state and each evidence plane separately. Integration, push, or pull request creation is a distinct user decision after this plan.
