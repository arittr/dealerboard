# Claude Code Ghostty terminal activation design

Date: 2026-08-07

Status: Approved by Drew on 2026-08-07.

Extends: [`2026-08-06-hook-driven-session-registry-design.md`](2026-08-06-hook-driven-session-registry-design.md) and [`2026-08-07-codex-session-activation-design.md`](2026-08-07-codex-session-activation-design.md). This design supersedes their display-only decisions only for top-level Claude Code sessions that start directly in a compatible Ghostty terminal. Codex and Kimi keep their current activation routes, and `NEXT` keeps its current paging behavior.

## Goal

Pressing a visible Claude Code session tile on the Stream Deck focuses the exact existing Ghostty terminal in which that session is running.

The first version is deliberately narrow:

- Claude runs through the ordinary `claude` command.
- The Claude process runs directly in Ghostty.
- The existing direct-exec Claude `SessionStart` hook captures the terminal binding.
- The Stream Deck plugin focuses an already-running Ghostty terminal by its stable native terminal ID.

There is no Claude wrapper, shim, launcher, resume command, tmux integration, OSC marker, terminal-title mutation, working-directory handshake, or generic activation broker.

## User-visible contract

- Pressing a bound Claude tile brings Ghostty to the foreground and focuses the exact terminal captured for that session.
- Two Claude sessions remain independently activatable even when they have the same working directory, title, project name, or status.
- Pressing an unbound Claude tile shows Stream Deck's native alert treatment and otherwise does nothing.
- Pressing a tile whose stored terminal no longer exists shows the same alert and otherwise does nothing.
- A press never opens Ghostty, creates a terminal, launches Claude, resumes a Claude session, types text, or changes terminal state.
- Claude tiles retain their existing rendering. Binding success or failure adds no badge, color, label, selection state, or animation.
- Codex and Kimi activation, blank keys, unsupported layouts, and `NEXT` retain their current behavior.
- Repeated presses make repeated exact focus requests. V1 adds no retry, debounce, queue, or fallback targeting.

Like the existing hook-driven registry, this feature does not add process-liveness reconciliation. A missed `SessionEnd` can leave a stale session row. If its Ghostty terminal still exists, the exact stored terminal can still be focused; if the terminal no longer exists, activation fails with an alert. Automatic stale-session cleanup remains out of scope.

## Preconditions and evidence boundary

Ghostty's native AppleScript terminal model must expose all three of these read-only or callable capabilities:

- `id`: stable terminal identity;
- `pid`: foreground process ID; and
- `tty`: terminal device path.

Upstream references are Ghostty's [AppleScript integration documentation](https://ghostty.org/docs/features/applescript), the current [AppleScript dictionary source](https://raw.githubusercontent.com/ghostty-org/ghostty/main/macos/Ghostty.sdef), and [PR #11922](https://github.com/ghostty-org/ghostty/pull/11922), which added the foreground PID and TTY properties.

The design checks these capabilities through the API itself rather than parsing a Ghostty version string. A build without them produces an unbound Claude session; there is no compatibility fallback.

The existing Claude hook configuration is part of the identity proof. Claude's exec-form hook spawns the installed `stream-deck-agents` executable directly, without a shell. For a direct Claude process in Ghostty, the hook helper's `process.ppid` is therefore the Claude foreground PID reported by Ghostty. V1 does not walk ancestors: if the immediate parent is not the Ghostty terminal's foreground process, the session is not bound.

A live probe on 2026-08-07 established the required join on Drew's updated Ghostty build:

- the direct Claude process was PID `65095` on `ttys000`;
- Ghostty reported PID `65095`, TTY `/dev/ttys000`, and one stable terminal ID;
- exactly one terminal matched the hook's parent PID; and
- after focusing a disposable different Ghostty window, focusing the captured stable ID returned to the original terminal and made Ghostty frontmost.

The disposable window was closed after the probe. This proves the native route is viable on the installed build. It does not replace the installed-plugin and physical-key acceptance gates below.

## Rejected alternatives

The following approaches are explicitly rejected:

- **Working directory, title, project, recency, or frontmost-terminal matching.** These values are not unique and cannot distinguish the required same-directory case.
- **OSC marker or temporary-directory handshake.** Writing an escape sequence into the parent TTY and polling Ghostty can create a join, but it mutates terminal state and adds timing and restoration failure modes that the native PID API makes unnecessary.
- **Claude wrapper, shim, or launcher.** Normal `claude` invocation is a product requirement, and the direct hook already supplies the needed process relationship.
- **Storing only a PID or TTY for later activation.** PIDs can be reused and a TTY is not the stable native focus identity. They are discovery evidence only; the registry stores Ghostty's stable terminal ID.
- **tmux pane mapping.** A direct Ghostty terminal is the V1 boundary. tmux would require a separate authoritative pane-to-terminal design.
- **Launching or resuming on activation.** A tile represents an existing session. Missing identity must fail closed rather than create new state.
- **A provider-neutral activation-target union or broker.** Claude's Ghostty binding is provider- and surface-specific. Codex and Kimi keep their existing adapters.

## Design

### Trusted SessionStart enrichment

Native hook JSON is not allowed to supply a terminal target. `decodeNativeHook` continues to whitelist only provider lifecycle fields and initializes every decoded `SessionStart` with `ghosttyTerminalId: null`.

After decoding, the CLI enriches only a top-level Claude `SessionStart`. The enrichment input comes from the local process environment and Ghostty's native API, not stdin. Codex starts, Kimi starts, subagent starts, and every non-start event bypass terminal discovery entirely.

This preserves the existing trust boundary: a crafted provider payload cannot select an arbitrary terminal ID.

### Direct Ghostty binding

The Claude binder is a small core adapter with an injected process executor. Its production path applies these gates in order:

1. `TERM_PROGRAM` must be exactly `ghostty`.
2. `TMUX` must be absent.
3. `process.ppid` must be an integer greater than one.
4. One fixed `/usr/bin/osascript` program first verifies that Ghostty is already running, then queries its terminals for native `pid` equal to that parent PID.
5. The query must return exactly one terminal, a non-empty bounded stable `id`, and a native `tty` shaped as an absolute `/dev/tty...` device path.

The PID is the identity join. The TTY is a required native-capability and sanity check; it is never used to search for a different terminal. At one instant `process.ppid` identifies one kernel process, and Ghostty must report exactly one terminal whose foreground PID is that same process.

The adapter uses a no-shell child-process API, a fixed executable path, fixed AppleScript source, and the parent PID as one argument. It does not consult ambient `PATH`, interpolate shell text, enumerate processes, walk ancestors, write to a terminal, poll, sleep, or mutate Ghostty.

Discovery has a fixed 300-millisecond timeout within the existing one-second Claude hook budget. Spawn failure, timeout, AppleScript error, missing API capability, zero matches, multiple matches, malformed output, or an ineligible environment returns `null`. The CLI then applies the `SessionStart` normally with a null binding and exits zero. Binding failure can never block Claude startup or suppress the session's status tile.

Diagnostics use bounded fixed reason codes and do not record AppleScript output, process details, TTY paths, terminal IDs, prompts, or transcript data.

### Registry schema and lifecycle

Database schema v2 adds one nullable `ghostty_terminal_id` column to `active_sessions`. It is an additive migration from v1; existing rows receive `NULL`, and no backfill or terminal scan runs during migration.

Only a top-level `provider: "claude"` row may carry a non-null value. Codex rows, Kimi rows, and child rows always carry null. Registry mutation enforces that rule, and projection rejects a corrupt row that violates it rather than publishing a partial snapshot.

The normalized start event becomes:

```ts
type SessionStart = {
  kind: "SessionStart";
  provider: Provider;
  sessionId: string;
  title: string | null;
  project: string | null;
  ghosttyTerminalId: string | null;
  observedAt: string;
};
```

Lifecycle behavior is exact:

| Event | Ghostty binding effect |
|---|---|
| New top-level `SessionStart` | Insert the supplied terminal ID or null. |
| Repeated top-level `SessionStart` | Overwrite the previous value, including overwriting a prior ID with null; preserve the existing logical slot and `opened_at`. |
| `Activity`, `Attention`, `Stop`, `StopFailure` | Preserve the binding unchanged. |
| `SubagentStart`, `SubagentStop` | Never create or change a binding. |
| `SessionEnd` | Delete the session row and its binding. |
| `sessions clear` / `clear-all` | Delete selected registry state and its bindings exactly as today. |

A Claude `/clear` or other lifecycle path that emits a new `SessionStart` therefore re-runs discovery and replaces the old target rather than inheriting it accidentally.

### Snapshot v2

The daemon publishes strict snapshot schema v2. Each projected top-level session adds:

```ts
ghosttyTerminalId: string | null;
```

The canonical snapshot path becomes `snapshot-v2.json`. The v2 parser accepts only `schemaVersion: 2`, requires the new field on every projected session, validates it as null or a non-empty bounded string, and rejects a non-null value on any provider other than Claude. It does not accept or upgrade v1 snapshots.

The daemon's unhealthy snapshot also uses schema v2. Old `snapshot-v1.json` files are ignored and need not be deleted. Core and plugin are deployed together through the full local installer; mixed versions are not a supported operating mode.

The nullable field is intentionally narrow. The snapshot does not add PID, TTY, application name, window ID, process metadata, or a generic activation-target object.

### Claude activation adapter

The plugin gains one provider-specific port:

```ts
type ActivateClaudeSession = (ghosttyTerminalId: string) => Promise<void>;
```

The production adapter invokes a fixed `/usr/bin/osascript` program through a no-shell child-process API and passes the bounded terminal ID as one argument. Before addressing Ghostty, the script checks whether the application is already running. If it is not running, the script fails without sending an Apple Event that could launch it.

When Ghostty is running, the script enumerates terminals by native stable `id`, requires exactly one match, and invokes Ghostty's native `focus` command on that terminal. It does not activate by PID or TTY, create a window or terminal, send keystrokes, run a command, or use Accessibility UI scripting.

The promise resolves only when `osascript` exits successfully. That proves the local native request completed, not that the physical display visibly changed; exact foreground and focus remain physical acceptance gates.

### Controller routing and failure feedback

`SessionGridController.keyDown` resolves the current structured `KeyModel` once at press time, preserving the existing protection against activating a previous occupant after layout reflow.

Routing becomes:

- `next`: keep the current page-advance and settings path;
- Codex session: keep the current Codex adapter;
- Kimi session: keep the current Kimi adapter;
- Claude session with a non-null `ghosttyTerminalId`: call the Claude adapter with that exact ID;
- Claude session with a null `ghosttyTerminalId`: request one native alert and return;
- blank or unsupported model: return without I/O.

If Claude activation rejects, the controller requests one native alert and returns. Alert rejection is contained. There is no retry, fallback, settings write, registry write, target clearing, or second matching attempt.

A degraded last-good snapshot remains eligible when it contains a non-null exact terminal ID. If the terminal disappeared while the snapshot was stale, the native ID lookup fails and produces the ordinary alert.

### Product text and documentation

The plugin manifest description and tooltip state that Claude tiles focus their bound Ghostty terminals, alongside the current Codex and Kimi behavior. The manifest version increases above `0.1.8.2` before deployment because Stream Deck ignores a copied plugin whose version is not newer.

`docs/hook-configuration.md` documents the activation prerequisites: ordinary direct `claude`, Ghostty with native `pid`/`tty` terminal properties, no tmux, and no activation fallback. The existing direct-exec hook snippets do not change.

No colors, geometry, text layout, provider marks, or status meanings change, so `src/plugin/render.ts` and the visible-tile contract in `docs/design.md` remain untouched. Historical dated documents remain unchanged.

## Data flow

```text
ordinary `claude` in a direct Ghostty terminal
        |
        | direct-exec SessionStart hook
        v
hook helper process.ppid --------------------------+
        |                                           |
        | fixed native Ghostty query                 |
        v                                           |
exactly one terminal { id, pid == ppid, tty }       |
        |                                           |
        v                                           |
SessionStart.ghosttyTerminalId                      |
        |                                           |
        v                                           |
SQLite v2 -> projection -> snapshot v2 -> KeyModel |
                                                    |
Stream Deck keyDown(context) -----------------------+
        |
        v
capture current Claude terminal ID
        |
        v
fixed native Ghostty focus-by-id request
        |
        v
exact existing terminal, or one alert
```

No target identity travels from the native hook JSON into this path, and there is no reverse acknowledgement channel from Ghostty to the registry.

## Failure behavior

| Condition | Result |
|---|---|
| Claude starts directly in a compatible Ghostty terminal and exactly one PID match exists | Store the stable terminal ID. |
| Claude starts outside Ghostty | Store null; status tile still appears. |
| `TMUX` is present | Store null; tmux mapping is out of scope. |
| Ghostty lacks `pid` or `tty`, is unavailable, or rejects the query | Store null; no fallback. |
| Parent PID has zero or multiple Ghostty matches | Store null; do not guess. |
| Native query times out or returns malformed identity | Store null; hook remains fail-open. |
| A later status event arrives | Preserve the binding. |
| A new SessionStart cannot bind | Overwrite any prior binding with null. |
| Claude tile has a null binding | Show one native alert; do not activate. |
| Stored terminal ID no longer exists | Show one native alert; do not launch Ghostty or Claude. |
| Ghostty is not running at press time | Show one native alert; do not launch Ghostty. |
| Focus request fails or is denied by macOS automation policy | Show one native alert; do not retry. |
| Pressed action disappears before alert delivery | Alert port resolves as a no-op. |
| Alert IPC rejects | Contain the rejection. |
| A valid ID request exits zero but the wrong terminal is visible | Not detectable in-process; physical acceptance fails. |

The implementation never logs native command output or interpolates terminal identity into a shell command. macOS Apple Events permission is an installed-runtime precondition; the implementation does not drive System Settings, request Accessibility control, or work around a denial.

## Test strategy

Implementation follows TDD and tests structured behavior rather than matching generated AppleScript text.

### Binder and CLI tests

The native binder uses an injected executor and environment so tests prove:

- discovery is attempted only for a Claude `SessionStart`;
- non-Ghostty and tmux environments return null without spawning;
- the immediate parent PID is passed as one argument to the fixed executable with no shell;
- one valid native match returns its stable ID;
- zero, multiple, malformed, missing-capability, rejected, and timed-out results return null;
- no ancestor, cwd, title, or TTY fallback runs; and
- a binding failure still writes the `SessionStart` and preserves the hook's exit-zero contract.

Tests assert the small executable/argument boundary and parsed native result, not the full AppleScript source. The real script is covered by the live integration gate.

### Schema, lifecycle, and projection tests

Real temporary SQLite databases prove:

- a v1 database migrates additively to v2 without changing existing session data or slots;
- existing rows receive null bindings;
- repeated init at v2 is idempotent and a future unknown version remains untouched;
- new and repeated SessionStart events store and overwrite the binding, including ID-to-null;
- status and subagent events preserve the top-level binding;
- SessionEnd and repair commands delete it with the row;
- non-Claude and child bindings cannot reach a valid projection; and
- projection publishes the exact root binding and no descendant binding.

### Snapshot protocol tests

Protocol tests prove:

- a complete schema-v2 snapshot parses;
- schema v1, missing fields, empty or oversized IDs, non-string values, and non-Claude non-null targets reject;
- duplicate logical slots still reject; and
- unhealthy schema-v2 snapshots retain the existing cold/last-good behavior.

### Plugin tests

The Claude activation adapter and controller use injected ports to prove:

- the adapter uses fixed `/usr/bin/osascript`, one terminal-ID argument, and no shell;
- it refuses to launch Ghostty when the app is not already running;
- it requires one exact ID match and propagates native failure;
- a bound Claude tile passes its exact stored ID once;
- a null Claude binding requests one alert without invoking any activator;
- a rejected activation requests one alert and no retry;
- alert rejection is contained;
- page changes and reflow use the current model rather than a previous occupant;
- degraded exact targets remain attemptable; and
- Codex, Kimi, `NEXT`, blank keys, rendering, and animation remain unchanged.

The fixed AppleScript programs are not snapshot-tested as large strings. Native matching and focus behavior receive a focused live check.

### Repository verification

After implementation:

1. `bun test`
2. `bun run typecheck`
3. `bun run build`
4. validate and package the plugin through the repository's existing build/install path

These commands prove source and bundle behavior only. They do not prove the migrated installed database, running daemon, installed plugin, macOS automation authorization, or physical Stream Deck focus path.

## Live acceptance gates

### Gate A: native binding integration

On a Ghostty build exposing terminal `pid` and `tty`:

1. Start two ordinary direct `claude` sessions in separate Ghostty terminals from the same working directory.
2. Confirm `TMUX` is absent for both.
3. Confirm each SessionStart stores a distinct non-null terminal ID.
4. Correlate each hook parent PID with exactly one Ghostty terminal PID and observe its TTY.
5. Run a focused adapter probe for each stored ID and confirm exact terminal selection.

No title, cwd, frontmost-window, or recency signal may participate in the result.

### Gate B: installed core and plugin

Because this feature changes the database, daemon snapshot protocol, and plugin together:

1. bump the manifest above `0.1.8.2`;
2. run the full local installer, including schema migration, daemon replacement, plugin packaging, installation, and restart;
3. verify installed database `user_version = 2` and existing rows retained with null bindings;
4. verify the daemon publishes `snapshot-v2.json` with `schemaVersion: 2`;
5. verify the installed plugin consumes that file without an offline/error treatment; and
6. record any macOS automation prompt or authorization separately.

Source, migrated-installed, running-daemon, and installed-plugin evidence are reported as separate gates.

### Gate C: physical Stream Deck proof

With the two same-directory Claude sessions still running:

- background Ghostty, press each Claude tile, and confirm Ghostty foregrounds the exact corresponding terminal;
- alternate presses several times to rule out frontmost or recency coincidence;
- exercise a Claude tile on a later page if overflow is available;
- create a controlled stale target by withholding `SessionEnd` or using disposable test state, remove its Ghostty terminal, and confirm the tile alerts without opening Ghostty or starting Claude;
- press a deliberately unbound Claude tile and confirm one alert;
- confirm Codex and Kimi still activate through their existing routes;
- confirm `NEXT`, status rendering, and animation remain unchanged; and
- confirm ordinary `claude` invocation was used throughout.

Installed version evidence and physical observations are reported separately. No push, merge, or broader deployment is implied.

## Expected implementation files

- `src/protocol.ts` — SessionStart target and strict snapshot-v2 contract.
- `src/core/claude-ghostty-binding.ts` — bounded native parent-PID discovery.
- `src/core/cli.ts` — trusted Claude SessionStart enrichment.
- `src/core/providers.ts` — payload decoder initializes a null trusted target.
- `src/core/schema.ts` — additive SQLite v2 migration.
- `src/core/registry.ts` — target persistence and lifecycle behavior.
- `src/core/projection.ts` — defensive target projection.
- `src/core/paths.ts` — canonical `snapshot-v2.json` path.
- `src/plugin/claude-session-activation.ts` — no-shell native focus-by-ID adapter.
- `src/plugin/controller.ts` — Claude routing and alert behavior.
- `src/plugin/plugin.ts` — production Claude activation port.
- Focused tests under `test/` for binder, CLI, schema, registry, projection, protocol, adapter, and controller behavior.
- `docs/hook-configuration.md` — direct-Ghostty activation prerequisites.
- `com.drewritter.stream-deck-agents.sdPlugin/manifest.json` — truthful interaction text and deployment version bump.

No changes are expected in the layout reducer, renderer, animation scheduler, SDK action class, profile, provider hook snippets, Codex adapter, or Kimi adapter.

## Explicitly out of scope

- Claude Desktop or any Claude surface other than direct Claude Code in Ghostty.
- tmux, screen, SSH-to-remote terminals, or other terminal emulators.
- A Claude wrapper, shim, alias, shell function, launcher, resume command, or hook change that replaces ordinary `claude` invocation.
- OSC escape sequences, terminal writes, working-directory mutation, title mutation, polling, or restoration logic.
- PID-, TTY-, cwd-, title-, project-, recency-, window-, or frontmost-based activation fallback.
- Launching Ghostty, creating a terminal or window, launching or resuming Claude, or typing into a terminal.
- Provider-neutral activation targets, brokers, registries, or capability negotiation.
- Process heartbeats, liveness scans, leases, automatic stale-row cleanup, or SessionEnd repair.
- Activation acknowledgement, selected-tile state, success animation, or persistent error decoration.
- Retries, debounce, cancellation, queues, or concurrent-request coordination.
- Accessibility UI scripting, System Settings automation, or automatic permission repair.
- Cross-platform terminal activation.
