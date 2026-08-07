# Codex session tile activation design

Date: 2026-08-07

Status: Approved by Drew on 2026-08-07.

Extends: [`2026-08-06-hook-driven-session-registry-design.md`](2026-08-06-hook-driven-session-registry-design.md). This design supersedes only that document's display-only and activation-non-goal decisions for top-level Codex session tiles. Claude and Kimi session tiles remain display-only, and `NEXT` retains its existing paging behavior.

## Goal

Pressing a visible Codex session tile on the Stream Deck brings the ChatGPT/Codex desktop app to the foreground and selects that exact existing Codex thread by its native technical thread ID.

The first version is deliberately narrow: it adds one exact Codex activation route to the existing plugin. It does not add a general activation broker, change the registry or snapshot schema, or infer targets from titles, projects, slots, recency, or frontmost-window state.

## User-visible contract

- Pressing a Codex session tile requests `codex://threads/<thread-id>` for the full session ID carried by that tile.
- The desktop app comes to the foreground and selects that thread. Selecting a different thread, creating a new thread, or opening by title/project approximation does not pass physical verification.
- Every `provider: "codex"` tile uses this desktop route, including a tile whose hook originated in Codex CLI. Terminal/window focus is not part of this version.
- Pressing a Claude, Kimi, blank, or unsupported-layout tile does nothing.
- Pressing `NEXT` continues to advance and wrap pages exactly as it does now.
- A local launcher failure shows Stream Deck's native alert treatment on the pressed key.
- A successful launcher request adds no animation, checkmark, selection state, or persistent visual change. Existing tile rendering remains unchanged.
- Repeated presses issue repeated activation requests. V1 adds no debounce, retry, or request queue.

## Preconditions and evidence boundary

OpenAI's current desktop-app documentation defines `codex://threads/<thread-id>` as the canonical link for opening a local chat by its technical thread ID. The existing Codex hook decoder accepts the native `session_id`, and the repository preserves that value unchanged through SQLite, projection, snapshot parsing, and the plugin's structured `KeyModel`.

That data flow is necessary but does not by itself prove the two IDs are the same contract. Before implementation proceeds past its first evidence task, a live probe must demonstrate that a full Codex hook `sessionId` from the installed registry selects the exact matching existing desktop task through the documented deep link.

The projection does not distinguish Codex Desktop from Codex CLI. The probe therefore covers every Codex surface currently feeding the registry: at minimum two existing Codex tasks with the same visible title and project/worktree but distinguishable content, plus a CLI-origin session when Codex CLI is also producing tiles. It records their full hook IDs, invokes each documented deep link separately, and confirms:

1. the app is brought to the foreground;
2. the expected existing task content is selected for each ID; and
3. no new or duplicate task is created.

If that equivalence does not hold for every represented Codex surface, implementation stops. This design does not authorize silently activating only a subset of indistinguishable Codex tiles, a title/path fallback, private app-server attachment, Apple Events automation, accessibility scripting, or a new persisted surface/`threadId` join. Any of those would require a separate design.

No probe or implementation step reads, extracts, rewrites, or otherwise modifies the installed ChatGPT app bundle or its `Info.plist`. Deep-link delivery goes only through the documented URL and macOS LaunchServices.

## Current state

- The plugin already maps each Stream Deck action context to a row-major physical index and reduces the current snapshot into a structured `KeyModel` for that key.
- A session `KeyModel` retains the complete `ProjectedSession`, including `provider` and the full `sessionId`; only the displayed fallback label shortens the ID.
- `SessionGridController.keyDown` currently ignores session and blank keys and handles only `NEXT`.
- The daemon snapshot and plugin polling path are read-only from the plugin's perspective.
- The installed Elgato SDK exposes `system.openUrl`, but Elgato documents that API as opening the default browser and not supporting custom URL schemes. It is not an activation candidate for `codex://`.
- The plugin already runs only on macOS under Stream Deck's Node.js 24 runtime.

## Design

### Activation eligibility and identity

The controller resolves the pressed context to the current `KeyModel` once, at the beginning of `keyDown`, before awaiting any I/O.

The key is activatable only when all of these are true:

- the layout is supported;
- the context is still registered;
- a snapshot view and reduced layout exist;
- the physical index currently contains `kind: "session"`; and
- that session's provider is exactly `codex`.

The immutable activation input is the full `session.sessionId` copied from that model. The controller never uses the rendered label, title, project, logical slot, physical coordinate, or shortened ID to reconstruct a target.

The handler resolves against the newest reduced layout at press time. If snapshot refresh has removed or reassigned the key, the removed session is not activated. Because image updates are asynchronous, the physical image may lag a just-completed reflow while an SDK send is pending; the SDK provides no display acknowledgement or hard upper bound for that lag. During that transition a press follows the newer model. V1 accepts this redraw race in order to never activate a recycled key's previous owner. No database-level allocation revision or snapshot-schema change is added. If physical use makes the race observable, display-revision fencing requires a follow-up design rather than an implicit fallback in this feature.

A degraded last-good snapshot remains activatable. Degradation means membership may be stale, but the provider-native thread ID is still exact; opening that same persisted thread is safe. A blank cold/offline grid has no target and no-ops.

### Codex activation adapter

A new plugin-local adapter owns custom-URL construction and process execution behind one injected asynchronous function:

```ts
type ActivateCodexSession = (sessionId: string) => Promise<void>;
```

For one `sessionId`, the production adapter:

1. encodes the ID as one URL path segment with `encodeURIComponent`;
2. constructs `codex://threads/<encoded-session-id>`;
3. invokes the fixed executable `/usr/bin/open` with the argument array `['-u', url]`; and
4. resolves only when that child process exits successfully.

The implementation uses Node's `execFile` or an equivalent no-shell child-process API. It never constructs a shell command, consults ambient `PATH`, passes `-n` or `-g`, or accepts an executable path from session data. macOS `open -u` delegates the custom scheme to whichever application LaunchServices has registered for it and permits that application to come to the foreground.

The adapter promise means only that LaunchServices accepted the local request. The URL scheme provides no acknowledgement that the correct task was ultimately displayed. Exact task selection remains a physical acceptance gate.

### Controller ports and key routing

`SessionGridPorts` gains two narrow ports:

```ts
activateCodexSession: ActivateCodexSession;
showAlert: (context: string) => Promise<void>;
```

`SessionGridController.keyDown` routes by the captured key model:

- `next`: preserve the current page-advance and dirty-settings persistence path;
- Codex session: await `activateCodexSession(fullSessionId)`;
- every other model: return without I/O.

If Codex activation rejects, the controller requests `showAlert(context)` once and then returns. Alert rejection is also contained so an SDK IPC failure does not escape the action event as an unhandled rejection. V1 performs no automatic retry because a failed or ambiguous activation must not produce duplicate navigation requests.

Activation never writes global settings, the registry, or the snapshot.

### SDK and runtime wiring

The plugin entrypoint supplies the production ports:

- the Codex adapter receives the Node child-process executor;
- `showAlert` resolves the current action by context ID, verifies it is still a key, and calls the SDK's native `showAlert()` method;
- a disappeared or non-key action makes the alert request a resolved no-op.

`SessionGridAction.onKeyDown` remains a thin adapter that passes only the action context ID to the controller. No layout, provider, or URL logic moves into the SDK action class.

### Product text and documentation

The plugin manifest stops describing the grid as read-only. Its tooltip and description state that the grid displays live sessions and that Codex tiles can open their tasks. The manifest version increases from `0.1.8.0` before local deployment because Stream Deck ignores a copied plugin whose version is not newer.

No tile colors, geometry, labels, marks, or status meanings change, so `src/plugin/render.ts` and the visible-tile sections of `docs/design.md` remain untouched. This design record is the current behavioral contract for key activation; existing dated design records remain historical and are not edited.

## Data flow

```text
Codex hook session_id
        |
        v
registry -> projection -> snapshot -> KeyModel.session.sessionId
                                      |
Stream Deck keyDown(context) ----------+
        |
        v
capture current Codex session ID
        |
        v
encode one URL path segment
        |
        v
/usr/bin/open -u codex://threads/<id>
        |
        v
LaunchServices -> ChatGPT/Codex app -> exact existing thread
```

There is no reverse acknowledgement channel from the app to the plugin.

## Failure behavior

| Condition | Result |
|---|---|
| Unsupported layout, missing context/view/layout, blank key | No-op. |
| Claude or Kimi session | No-op. |
| Codex session with a degraded last-good snapshot | Attempt the exact stored thread ID. |
| Session disappears or key is reassigned before `keyDown` is handled | Use the current model; never activate the previous owner. |
| `/usr/bin/open` cannot spawn or exits nonzero | Show one native alert on the pressed key; do not retry. |
| Pressed action disappears before the alert | Alert port resolves as a no-op. |
| Alert IPC rejects | Contain the rejection; do not retry activation. |
| `open` exits zero but the app selects the wrong task | Not detectable in-process; physical gate fails and the feature is not accepted. |

The implementation does not log prompts, task content, raw hook payloads, or child-process error text. Tests may use synthetic IDs, including shell metacharacters, to prove the value remains one encoded URL argument.

## Test strategy

Implementation follows TDD and tests structured behavior rather than rendered commands or large strings.

### Activation adapter tests

A focused adapter test injects a fake executor and proves:

- the fixed executable is `/usr/bin/open`;
- arguments are exactly `['-u', 'codex://threads/<encoded-id>']`;
- a session ID containing `/`, `?`, spaces, Unicode, and shell metacharacters remains within one URL argument, with path/query delimiters encoded;
- the adapter does not invoke a shell; and
- executor rejection/nonzero completion rejects the activation promise.

The exact URL is a small public protocol contract, so asserting it directly is intentional and not a generated-script snapshot.

### Controller behavior tests

Controller tests inject fake activation and alert ports and prove:

- a Codex tile passes its complete session ID exactly once;
- the eight-character fallback label is never used as identity;
- Claude, Kimi, blank, unsupported, missing, and stale contexts do not activate;
- degraded Codex tiles remain activatable;
- `NEXT` still pages and persists settings without activating;
- after paging, a press activates the Codex session on the current page rather than the prior page;
- a removed/reassigned key never activates its previous session;
- activation rejection requests one alert and performs no settings write; and
- alert rejection is contained.

Renderer and snapshot protocol tests do not change because activation adds no visual or schema fields.

### Repository verification

After implementation:

1. `bun test`
2. `bun run typecheck`
3. `bun run build:plugin`
4. validate/package the plugin using the repository's existing Stream Deck tooling

These prove source and bundle behavior only. They do not prove the installed plugin or physical key path.

## Live acceptance gates

### Gate A: documented deep-link identity probe

Before implementation is treated as viable, run the ambiguity and represented-surface probe from the preconditions section. Record the installed app version, each full hook ID and known source surface, the documented URL form, and pass/fail for foregrounding, exact selection, and duplicate creation. Do not inspect or modify the app bundle.

### Gate B: installed plugin

After source verification and Drew's approval to deploy:

1. bump the manifest above `0.1.8.0`;
2. build the plugin bundle;
3. copy the manifest, `plugin.js`, and source map to the installed plugin directory; and
4. restart only `com.drewritter.stream-deck-agents`.

Core installation and the launchd daemon remain untouched because this is a plugin-only change.

### Gate C: physical Stream Deck proof

With at least two Codex sessions available, including the ambiguity pair:

- background the desktop app, press each Codex tile, and confirm foreground plus exact task selection;
- confirm neither press creates a duplicate task;
- exercise a Codex tile on page two and confirm the visible current-page mapping;
- press Claude and Kimi tiles and confirm they remain no-ops;
- confirm `NEXT` still advances and wraps pages; and
- confirm ordinary status rendering and animation remain unchanged.

Installed-version evidence and physical observations are reported separately from source-test results. No push, merge, or broad reinstall is implied by these gates.

## Expected implementation files

- `src/plugin/codex-session-activation.ts` — URL construction and no-shell macOS launcher adapter.
- `src/plugin/controller.ts` — Codex routing, captured target, and alert failure path.
- `src/plugin/plugin.ts` — production activation and alert ports.
- `test/codex-session-activation.test.ts` — adapter contract tests.
- `test/controller.test.ts` — key routing, paging, reflow, and failure tests.
- `com.drewritter.stream-deck-agents.sdPlugin/manifest.json` — truthful interaction text and deployment version bump.

No changes are expected in the core registry, schema, projection daemon, shared snapshot protocol, layout reducer, renderer, scheduler, or SDK action class.

## Explicitly out of scope

- Claude or Kimi activation.
- Codex CLI terminal/window focus distinct from the documented desktop-thread route.
- A provider-neutral activation target union or broker.
- App-server attachment, private IPC, Apple Events, accessibility automation, window-title matching, working-directory matching, or recency fallback.
- Archive, stop, approval, prompt injection, or any other session-control action.
- Activation acknowledgement, selected-tile state, success animation, or navigation history.
- Retries, debounce, cancellation, or concurrent-request coordination.
- Registry, database, daemon, or snapshot-schema changes.
- Cross-platform URL launching.

## External contracts

- [ChatGPT desktop app commands: deep links](https://learn.chatgpt.com/docs/reference/commands.md#deep-links)
- [Elgato Stream Deck system API: opening URLs](https://docs.elgato.com/streamdeck/sdk/guides/system/#opening-urls)
- `open(1)` on macOS, specifically `-u` custom-scheme dispatch through LaunchServices
- [Node.js `child_process.execFile`](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)
