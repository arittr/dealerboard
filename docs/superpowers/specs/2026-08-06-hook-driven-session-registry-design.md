# Hook-Driven Agent Session Registry Design

Date: 2026-08-06

Status: Approved by Drew.

Supersedes: The inventory-, reconciliation-, lease-, activation-, and daemon-rendering architecture in [`docs/design.md`](../../design.md). That document and the Gate 0 documents remain historical decision records, not implementation requirements for this design.

## Purpose

Build a small macOS-local system that shows active Claude Code, Codex, and Kimi sessions on Drew's 15-key Stream Deck.

The product is a glanceable recent-attention surface. It reports the latest explicit lifecycle and activity state supplied by each harness. It does not prove that a terminal, window, or process is still open, and it does not reconstruct sessions by scanning provider history.

The core must remain independent of Stream Deck so a different local display can consume the same session projection later. V1 nevertheless implements only the Stream Deck consumer; it does not introduce a generalized surface framework or adapter SDK.

## Decisions

- Harness hooks are the source of session membership and status.
- Hooks write normalized events directly to a shared SQLite database through one small command-line helper.
- There are no leases, heartbeats, status-expiry timers, provider inventories, reconciliation jobs, or tombstones.
- The database contains only active sessions. An end event deletes its row.
- The event transaction validates hierarchy and assigns stable logical slots before commit.
- A read-only Bun/TypeScript daemon derives effective top-level projections and atomically publishes a complete JSON snapshot.
- The Stream Deck plugin is a TypeScript consumer running in Stream Deck's supported Node.js runtime. It owns all device layout, paging, SVG rendering, animation, and action-context behavior.
- One bundled 5x3 Stream Deck profile provisions the 15 action contexts required by the product.
- Session keys are display-only in V1. The only key action is paging with `NEXT` when overflow exists.
- Tests stay concentrated on the actual data flow and core contracts. This is a personal tool, not a production service.

## System boundary

```text
Claude / Codex / Kimi hooks
             |
             v
       event helper -> SQLite
                          |
                          | read-only query
                          v
                 projection daemon
                          |
                          v
               atomic session snapshot
                          |
             +------------+------------+
             |                         |
             v                         v
   Stream Deck plugin        future local surface
```

The database and snapshot live in a per-user application-support directory with permissions restricted to the current user. There is no network listener or remote service.

### Canonical local paths

Every component resolves the current macOS user's home directory through its runtime's operating-system API, never by passing a literal `~`, using its working directory, or consulting ambient `PATH`:

```text
~/Library/Application Support/com.drewritter.stream-deck-agents/
  bin/stream-deck-agents
  registry.sqlite3
  snapshot-v1.json
  logs/

~/Library/LaunchAgents/com.drewritter.stream-deck-agents.plist
```

The application-support directory and installed executable use mode `0700`. The database, snapshot, and LaunchAgent plist use mode `0600`. Snapshot temporary files are created in the same application-support directory so replacement remains atomic.

## Components

### Event helper

One TypeScript command-line program receives a provider name plus native hook input. Provider-specific decoders whitelist only the fields required to construct a normalized event:

- Provider and session identifier.
- Normalized event kind.
- Optional parent session identifier.
- Optional title and project/worktree label.
- Event observation time for diagnostics.

The helper never stores prompts, transcripts, tool arguments, tool output, environment variables, credentials, or arbitrary hook payloads.

Each invocation validates its input and performs one short `BEGIN IMMEDIATE` SQLite transaction. It does not contact the daemon or Stream Deck plugin. This keeps hooks useful when either consumer is absent.

The event and repair subcommands share one registry mutation layer. That layer owns event-role validation, composite provider/session identity, parent existence and provider equality, prospective-cycle rejection, cascading removal, and logical-slot allocation. No other component mutates active registry state during normal operation.

The installed core is one compiled Bun executable named `stream-deck-agents`. Installation invokes its `init` subcommand, hooks invoke `event`, `launchd` invokes `daemon`, and Drew uses `sessions` subcommands for inspection and repair. The responsibilities remain separate inside the codebase even though installation uses one binary.

### Active-session database

SQLite is the source of truth for current hook-reported sessions. It uses WAL mode so independent hook processes can write while the daemon reads.

Each row contains the normalized identity and current facts needed by the projection:

```ts
type ActiveSession = {
  provider: "claude" | "codex" | "kimi";
  sessionId: string;
  parentSessionId: string | null;
  status: "idle" | "working" | "waiting" | "error";
  title: string | null;
  project: string | null;
  logicalSlot: number | null;
  openedAt: string;
  updatedAt: string;
};
```

`(provider, sessionId)` is the session identity. Parent and child identities must use the same provider. V1 assumes a provider does not reuse a session identifier while delayed events from an earlier session with that identifier remain possible.

The database has no closed-session table or event history. `updatedAt` is diagnostic metadata only; it never changes membership or status by age.

Every committed top-level row has a positive logical slot. `SessionStart` preserves the slot of an existing active identity or allocates the lowest free positive slot inside its write transaction. Child sessions always have a null slot. A partial unique index rejects duplicate non-null slots, and a table constraint rejects top-level rows without slots or child rows with slots. Persisting assignments alongside active state prevents daemon restart from reordering the deck.

The composite parent key `(provider, parentSessionId)` references `(provider, sessionId)` with `ON DELETE CASCADE`. Mutation validation still checks parent role and prospective cycles because foreign keys alone cannot express those invariants.

### Schema ownership

`stream-deck-agents init` is the only schema owner. It creates the application-support directory and absent database, enables WAL, and applies known non-destructive migrations in one transaction using `PRAGMA user_version`. Every database connection enables foreign-key enforcement. Installation runs `init` before loading the daemon, installing hooks, or accepting events.

Every runtime subcommand validates `user_version`. Hooks fail open on an unsupported schema, repair commands fail without mutation, and the daemon publishes an unhealthy snapshot. No runtime path automatically deletes or recreates an unrecognized database.

### Projection daemon

A small Bun/TypeScript daemon runs under `launchd` with one long-lived read-only SQLite connection. It publishes once at startup, then checks `PRAGMA data_version` every 250 milliseconds and recomputes only after another connection commits. It reads each projection from one consistent SQLite read transaction and compares the structured result before replacing the snapshot.

The daemon owns:

- Defensive parent/descendant validation and bounded traversal.
- Descendant counts.
- Effective top-level status.
- Ordering by the slots already committed with active top-level sessions.
- The surface-neutral JSON schema.
- Atomic snapshot publication.
- Database and projection diagnostics.

The daemon never mutates the registry. It does not know the Stream Deck's dimensions, action contexts, pages, SVG format, animation phase, or profile settings.

A one-shot `snapshot` subcommand polled by the plugin was considered and rejected for V1. At a one-second interval it could launch 86,400 processes per day while moving deadline, child-process, output-bound, and failure handling into the plugin. The long-lived read-only daemon performs cheaper in-process polls and remains useful to any later local surface.

### Surface-neutral snapshot

The daemon writes one complete snapshot using a temporary file followed by atomic replacement. Consumers poll the file's modification time and reread only after it changes. This avoids a local server, socket protocol, authentication token, reconnect state machine, and delta replay.

The snapshot contains a schema version, health, and ordered top-level sessions:

```ts
type SessionSnapshotV1 = {
  schemaVersion: 1;
  health: {
    status: "ok" | "error";
    message?: string;
  };
  sessions: Array<{
    provider: "claude" | "codex" | "kimi";
    sessionId: string;
    status: "idle" | "working" | "waiting" | "error";
    title: string | null;
    project: string | null;
    descendantCount: number;
    logicalSlot: number;
  }>;
};
```

Consumers always treat a valid snapshot as a complete replacement. Timestamps remain available in SQLite and `sessions list` for diagnostics but are not part of the consumer contract.

A future surface reads this same contract and supplies its own layout and rendering. V1 adds no surface registration system or shared rendering abstraction.

### Stream Deck plugin

The plugin uses TypeScript and the official `@elgato/streamdeck` SDK. It follows the standard Stream Deck TypeScript/Rollup scaffold, declares Node.js 24 and Stream Deck 7.1 as its minimum runtimes, and uses SDK version 3. Bun may install dependencies and run build commands, but Stream Deck does not execute the plugin under Bun.

The plugin bundle includes one read-only profile for device type `0`, containing the same single action in all 15 row-major cells. The manifest registers that `.streamDeckProfile` with `AutoInstall: true`, `Readonly: true`, and `DontAutoSwitchWhenInstalled: false`. Installing and selecting this profile is part of setup and physical verification; installing the plugin alone is not considered ready.

The plugin owns:

- SDK action-context discovery and cleanup.
- Mapping logical slots to the visible 5x3 key grid.
- Overflow paging and the current page.
- Stream Deck global settings used to persist page state.
- Provider marks, titles, descendant badges, and status treatments.
- Dynamic SVG generation and animation scheduling.
- Missing, malformed, or unhealthy snapshot treatment.

On `willAppear`, the plugin verifies one 5x3 keypad device, registers the action's device, context, row, and column, reads the current snapshot when the first context appears, and immediately renders that context from cached state. While at least one relevant context is visible, it checks the canonical snapshot path every 250 milliseconds and rereads after replacement. `willDisappear` unregisters the context and cancels its queued image work; device disconnect clears all contexts for that device. Snapshot polling stops when no relevant context is visible.

The plugin uses one shared animation clock, coalesces obsolete frames, and updates only visible keys whose rendered frame changed. The initial cadence is at most four frames per second for any animated key and never exceeds the SDK's ten-programmatic-updates-per-second guidance for a key. A worst-case page with 14 animated keys is tuned and checked on the physical device rather than assuming a global SDK quota that the published guidance does not define.

Dynamic titles and labels are length-bounded and XML-escaped before SVG construction. The complete SVG data URL is percent-encoded before `setImage`. The plugin does not depend on animated GIF support or attempt video-rate animation.

## Event and lifecycle contract

Provider adapters map native hooks into these normalized transitions:

| Normalized event | Database effect |
|---|---|
| `SessionStart` | In one `BEGIN IMMEDIATE` transaction, insert or reset a top-level session as `idle`, preserve its existing slot, or allocate the lowest free positive slot. |
| `Activity` | Update an existing session to `working`. Prompt and tool activity map here. |
| `Attention` | Update an existing session to `waiting`. Permission and other user-attention hooks map here. |
| `Stop` | Update an existing session to `idle`. |
| `StopFailure` | Update an existing session to `error`. |
| `SessionEnd` | Delete the existing top-level session, its active descendants, and its slot assignment. |
| `SubagentStart` | Insert or reset a child as `idle` when its parent is active. The child receives no logical slot. |
| `SubagentStop` | Delete the existing child and its active descendants. |

Only `SessionStart` and `SubagentStart` may create rows. Every other event updates or deletes an existing row and otherwise becomes a logged no-op. Therefore a delayed activity or stop event cannot resurrect a session after its end event. A start that violates role, parent, provider, slot, or prospective-cycle invariants is also a logged no-op.

V1 trusts each harness to deliver events for one session in useful order. It does not add sequence numbers, an event log, reconciliation, or incarnation fencing. Missed and reordered events are accepted limitations. Stale rows are repaired explicitly rather than inferred from elapsed time.

## Hierarchy and effective status

Only top-level sessions appear in the published snapshot. Each top-level projection includes the number of active descendants in its subtree.

The daemon computes effective status across the top-level session and all active descendants using this priority:

```text
error > waiting > working > idle
```

For example, an idle parent with one waiting child appears as waiting with descendant count `1`. The registry mutation layer rejects self-parenting, missing parents, cross-provider parentage, and prospective cycles before commit. The daemon defensively treats any topology that still violates those invariants as a projection error rather than traversing it.

## Stable ordering and Stream Deck paging

A newly observed top-level session receives the lowest free positive logical slot in the same transaction that creates it. Status, title, project, and descendant changes do not move it. Deletion releases its slot, but remaining sessions do not compact.

Without overflow, logical slots 1 through 15 map to physical keys 1 through 15.

Once a live session occupies a logical slot above 15:

- Physical keys 1 through 14 display the current page's logical cells.
- Physical key 15 displays `NEXT` on every page.
- Logical slot 15 becomes the first cell on page two.
- Additional pages each contain 14 logical cells.
- `NEXT` cycles through non-empty pages and wraps.
- Vacated logical cells remain blank until reused by the lowest-free allocator.
- If the current page empties, the plugin selects the nearest earlier non-empty page, or the earliest later page when none exists.

Overflow is a Stream Deck projection concern. Its latch and current page live in plugin global settings, not in the database or core snapshot. Restored settings are validated and the page is clamped to a non-empty page; settings are written only after `NEXT` or clamping. The latch ends when no live session remains on a higher page, including the session moved from logical slot 15.

## Tile presentation and animation

Each session tile contains:

- A small provider mark.
- A two-line session title.
- Project or worktree as the first title fallback.
- Provider plus shortened session identifier as the final fallback.
- A bare active-descendant count when greater than zero.

Status is primarily communicated by the frame:

- Working: blue `#20B8FF` moving highlight or orbit.
- Waiting: amber `#FFB020` breathing frame.
- Idle: static slate `#94A3B8` frame.
- Error: red `#FF4D67` pulse.

Animation phase is local plugin state and never appears in the database or snapshot. Exact easing, cadence, typography, and icon treatment are tuned on the physical device. Session keys do nothing when pressed in V1; only `NEXT` handles input.

## Failure and recovery behavior

### Hook failures

Hook execution is fail-open. The helper attempts one short transaction and one bounded retry for SQLite contention. Malformed input, an unavailable or unsupported database, or a failed write is logged, then the helper exits successfully so it does not interrupt the harness.

### Daemon and snapshot failures

`launchd` keeps the daemon running. On a database or schema read failure, the daemon does not mutate or recreate the database. It publishes a schema-valid snapshot with `health.status` set to `error` and an empty `sessions` array.

The plugin validates `schemaVersion` and required fields. During one plugin process lifetime, a missing, malformed, or explicitly unhealthy snapshot retains the last good session rendering and adds a clear error treatment. A cold plugin without cached state renders an otherwise blank offline treatment.

There is deliberately no snapshot heartbeat and no age-based daemon-health inference. A stale file is not used to expire sessions. `launchd` restart behavior and logs provide operational recovery.

### Stale session repair

If a harness omits an end event, the session remains active indefinitely. The core CLI therefore provides:

- `sessions list` for a read-only active-session listing.
- `sessions clear <provider> <session-id>` to remove one selected session and its descendants.
- `sessions clear-all` to remove all active registry state.

These commands operate on active registry state only. There is no automatic cleanup policy.

Core, daemon, and plugin diagnostics use small bounded local logs. Diagnostics must not include stored provider payloads or transcript content.

## Runtime and repository structure

The codebase uses TypeScript throughout:

- Core helper and daemon run on Bun and use built-in `bun:sqlite`.
- Shared event and snapshot types contain no Bun or Stream Deck imports.
- The Stream Deck plugin builds and packages with the official scaffold under Node.js 24, then runs under Stream Deck's Node.js 24 runtime.
- Bun is the repository package manager and test runner where compatible.

The first local installation proceeds in this order:

1. Compile and install the Bun core at the canonical absolute path.
2. Run `stream-deck-agents init` to create or migrate the database.
3. Install and load the read-only projection daemon's LaunchAgent.
4. Build, validate, and install the Stream Deck plugin and bundled 5x3 profile.
5. Have Drew add the documented hook snippets to the three harnesses manually.

Hooks are configured last so the first `SessionStart` cannot arrive before its schema exists. V1 does not require a general installer, updater, marketplace package, cross-platform bundle, or automatic mutation of provider configuration.

## Lean verification strategy

Implementation uses TDD for the contracts that can silently corrupt the displayed state:

1. **Event to SQLite:** start, status changes, end deletion, late-event non-resurrection, invalid-topology rejection, cascading children, and stable logical-slot reuse.
2. **SQLite to snapshot:** a real temporary database produces one transaction-consistent, schema-versioned snapshot through `data_version` detection and atomic replacement.
3. **Snapshot to key model:** representative snapshots produce the expected structured visible-key models, paging, provider identity, status treatment, and animation selection. One renderer case includes bounded Unicode and XML metacharacters.
4. **Concurrent hook smoke:** two real helper processes start different top-level sessions and receive distinct slots from one SQLite database.
5. **Plugin lifecycle smoke:** appearing contexts render immediately from cached state, disappearing contexts stop receiving work, and the scheduler coalesces frames without exceeding the per-key update bound.

Renderer tests assert structured key models and minimal SVG validity, not large generated SVG strings or aesthetic details. Animation quality is reviewed on the physical deck.

Completion evidence is intentionally small and separate:

- Typecheck and focused automated tests pass.
- The Stream Deck plugin builds and packages under Node.js 24 with the bundled profile registered in its manifest.
- The plugin and profile install and expose all 15 expected contexts on Drew's device.
- The physical check covers idle, working, waiting, error, descendant aggregation, session removal, overflow paging, profile switch away/back, and a page with 14 animated keys.

The physical check does not re-prove that Codex Desktop or the other harnesses invoke their configured hooks; that premise is accepted for this personal V1.

## Accepted limitations

- Membership means a start hook has occurred without a corresponding end hook; it does not mean a window or process was independently verified open.
- Missed end hooks leave stale rows until manual repair.
- Reordered provider events can produce incorrect current state.
- A daemon crash can leave the last atomic snapshot on disk without an age-based offline signal.
- V1 is macOS-local, single-user, and intended for Drew's current setup.
- The plugin targets one 15-key Stream Deck profile; another surface requires a new consumer but no core registry changes.

## Non-goals

- Provider inventory scanning or AgentsView integration.
- Leases, heartbeats, expiry, reconciliation, event replay, or cold-start recovery from provider history.
- Terminal/window/process verification.
- Session activation, focus, archive, approval, stop, prompt injection, or other agent-control actions.
- A desktop dashboard, transcript viewer, historical inbox, or remote service.
- A public provider adapter SDK or generalized display framework.
- Production-grade concurrency stress, fault injection, telemetry, auto-update, signing, marketplace distribution, or cross-platform packaging.

## External references

- [Stream Deck SDK getting started](https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/)
- [Stream Deck key image API](https://docs.elgato.com/streamdeck/sdk/guides/keys/)
- [Stream Deck bundled profiles](https://docs.elgato.com/streamdeck/sdk/guides/profiles/)
- [Stream Deck plugin guidelines](https://docs.elgato.com/guidelines/stream-deck/plugins/)
- [Stream Deck settings](https://docs.elgato.com/streamdeck/sdk/guides/settings/)
- [Bun SQLite](https://bun.sh/docs/runtime/sqlite)
- [Bun standalone executables](https://bun.sh/docs/bundler/executables)
