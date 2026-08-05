# Stream Deck Agent Registry Design

Date: 2026-08-05

Status: Approved design

## Summary

Build a macOS-local system that projects every currently active top-level agent session onto a 15-key Stream Deck. It supports Codex App and CLI, Claude Code CLI, and Kimi Code CLI and Web. A single daemon owns session membership, normalized state, child-agent rollup, stable key placement, paging, and safe activation. Harness-specific adapters report facts; a thin Stream Deck plugin renders the daemon's current projection.

The system is independent of AgentDeck and Herdr. It has no database, desktop dashboard, session history, manual dismissal flow, or remote service.

## Goals

- Show one tile for every active top-level agent session.
- Encode `working`, `waiting`, `idle`, and `error` through tile color alone.
- Keep a live session on the same logical key throughout its lifetime.
- Roll all live subagents into their top-level parent as a bare numeric badge.
- Remove a tile when its CLI surface closes, its App/Web task is archived, or its observation lease expires.
- Recover quiet, already-running sessions after installation or restart instead of relying on hooks alone.
- Focus the exact source surface on key press where a stable activation mechanism exists.
- Remain additive and reversible when installing harness hooks.

## Non-goals

- No AgentDeck or Herdr integration or dependency.
- No stop, approve, archive, prompt-injection, or other agent-control actions.
- No fuzzy window selection by title, repository, or working directory.
- No visible `done`, `closed`, or `stale` states.
- No closed-session history, dismissal UI, desktop dashboard, or remote access.
- No database, event log, generalized adapter SDK, or distributed event-ordering protocol.
- No support for multiple Stream Deck devices in v1.

## Prior-art findings

We installed and exercised AgentDeck 1.0.2 with its Stream Deck plugin 1.0.4.0. It proved that a 5x3 session profile with status-first tiles is useful, but it also exposed boundaries this design must avoid:

- Hook-only discovery found two active Claude sessions while `claude agents --json` reported five interactive sessions. Quiet existing sessions require reconciliation.
- AgentDeck used project names rather than the session titles Drew wants.
- Its Codex setup rejected an existing user-owned `[features]` table instead of merging configuration structurally.
- It did not support Kimi.
- Its key press opened an internal AgentDeck detail view rather than focusing the source surface.
- It reserved keys for quota information instead of using all 15 keys for sessions.
- The plugin and daemon had a visible protocol seam around repeated unknown slot-map commands.

We retain the useful ideas—status-first tiles, one local registry, and a thin deck client—but own the complete system and contracts ourselves.

## Architecture

The system has three layers:

1. **First-party provider adapters** observe each harness through supported hooks, task metadata, local APIs or event streams, and authoritative process/task reconciliation.
2. **`stream-deck-agents` daemon** runs as a per-user LaunchAgent. It is the only writer for the normalized registry, lease state, child rollups, slot allocator, persisted placement hints, and activation broker.
3. **Thin consumers** comprise the Stream Deck plugin and `agentctl`. The plugin renders complete deck snapshots and reports presses. `agentctl` sends hook events and provides read-only `status` and `doctor` commands.

The daemon is a small TypeScript service. Provider adapters are built-in modules, not a plugin platform. The Stream Deck plugin contains no provider-specific discovery logic and never infers whether a session is active.

## Normalized session model

Adapters supply facts for both top-level sessions and subagents. Only top-level sessions are eligible for placement.

```ts
type Provider = "codex" | "claude" | "kimi";
type Surface = "app" | "cli" | "web";
type SessionState = "working" | "waiting" | "idle" | "error";

type SessionIdentity = {
  provider: Provider;
  surface: Surface;
  sessionId: string;
  incarnation: string;
};

type ObservedSession = {
  identity: SessionIdentity;
  parentIdentity?: SessionIdentity;
  title?: string;
  repositoryOrWorktree?: string;
  selfState: SessionState;
  activation?: ActivationTarget;
};
```

`sessionId` is the harness's stable task or session identifier. `incarnation` is an adapter-derived token that remains stable for one live surface lifetime and changes after an authoritative close followed by a reopen. For a CLI this can incorporate the process start identity; for App/Web it must use the strongest lifecycle identity exposed by the harness. This prevents a late exit observation from removing a reopened session.

The daemon derives and owns:

- The observation lease and last source health.
- The top-level ancestor for every live subagent.
- The total live descendant count for the badge.
- Effective state across the entire top-level subtree.
- Logical slot and allocation revision.
- Display title fallback.
- The current physical-key projection.

If a session is confirmed present before a current state signal arrives, it starts as `idle`. The next hook or observation corrects it.

## Membership and lifecycle

Membership and activity state are separate.

### CLI surfaces

A Claude Code, Codex, or Kimi CLI session is present while the agent process is associated with a live controlling TTY, terminal pane, or equivalent terminal surface. An authoritative process exit removes it immediately. Merely leaving the terminal application open after the agent process exits does not keep the tile.

### App and Web surfaces

A Codex App or Kimi Web task is present while the harness reports it as unarchived. Archiving is an authoritative removal. Closing the application or browser alone does not archive the task.

### Leases

Every upsert or reconcile refreshes the adapter's observation lease. An authoritative close, exit, or archive removes immediately; otherwise a disconnected source remains present only until its monotonic lease deadline. Expiry removes the tile with no visible stale state. A later observation creates it again and it allocates normally.

### Turn state

- `working`: a turn, tool call, or live descendant is actively executing.
- `waiting`: the session or a live descendant requires human input or approval.
- `idle`: the surface is present with no active turn and no outstanding human request. A completed turn becomes idle, not done.
- `error`: the session or a live descendant has surfaced an unrecovered failure that requires attention. A recoverable tool error while the agent continues remains working.

Effective top-level state uses this priority across the complete live subtree:

```text
error > waiting > working > idle
```

Subagents never receive keys. The badge is the total number of live descendants attached to the top-level session and is omitted at zero.

## Adapter contract

The daemon accepts only three session mutations:

### `UPSERT`

Creates or refreshes one observed session with identity, display fields, self-state, optional parent identity, and optional typed activation target. It renews the lease but cannot assign a key.

### `REMOVE`

Removes one identity for an authoritative close, process exit, archive, or incarnation end. It is immediate.

### `RECONCILE`

Supplies the complete live set for an explicitly named authoritative provider scope. Included sessions are upserted. Existing sessions owned by that scope but omitted from the complete set are removed. Partial observations must use `UPSERT`; they cannot claim completeness and remove omissions.

The daemon serializes mutations in receive order. V1 has no adapter epoch protocol, universal sequence numbers, delta replay log, or wall-clock conflict resolver. Incarnations prevent old-surface removal races, and complete reconciliation repairs missed hook events. An adapter may use a harness-provided ordering token internally when that harness exposes one, but it is not part of the shared contract.

Hook delivery has a hard local deadline and never blocks or fails the agent workflow. A missed transient state update is acceptable because the next observation corrects it; membership is repaired by reconciliation.

## Provider adapters

### Claude Code CLI

- Lifecycle and tool hooks provide fast state, title, input/approval, error, and subagent observations.
- Process and controlling-TTY reconciliation discovers quiet sessions and removes exited CLI surfaces.
- A terminal activation target is reported only when an exact pane or tab locator is available.

### Codex App and CLI

- Supported hooks or telemetry plus local rollout/task metadata provide state, title, identity, and hierarchy.
- App task inventory is authoritative for unarchived membership.
- CLI process and TTY reconciliation is authoritative for terminal membership.
- App archive and CLI process exit remove immediately.
- App activation requires an exact supported task route. CLI activation requires an exact terminal locator.

### Kimi Code CLI and Web

- CLI hooks provide fast state and process/TTY reconciliation provides membership.
- Web observation uses a stable authenticated local session API or event stream that can enumerate complete unarchived task state.
- CLI activation requires an exact terminal locator. Web activation requires an exact browser-tab token or another supported stable task target.

### Provider proof gate

Implementation starts with bounded, read-only probes against the currently installed versions of all three harnesses. Each adapter must prove current identifiers, membership semantics, titles, state signals, parent relationships, and archive or exit behavior before claiming support. Activation is optional, but observation is not.

If Codex App or Kimi Web lacks a stable observation surface, implementation stops at that adapter boundary and the design is revised with Drew. V1 must not substitute accessibility automation, screen scraping, title matching, or undocumented destructive configuration changes.

## Stream Deck projection

### Tile rendering

Each session tile has:

- A thick status-colored frame around a dark interior.
- A small provider mark in the upper-left corner.
- A two-line primary title.
- A bare numeric live-descendant badge in the upper-right, with no `+` prefix.
- No state text or state glyph.

The primary label is the harness session or task title. Fallback order is repository/worktree name, then provider plus a shortened session identifier. The four frame colors are:

- Working: blue `#20B8FF`
- Waiting: amber `#FFB020`
- Idle: slate `#94A3B8`
- Error: red `#FF4D67`

### Stable logical slots

- A new top-level session takes the lowest free logical slot.
- State, title, child count, and activation changes never move it.
- Removal releases its logical slot for the next session.
- Existing live sessions are never compacted to fill a gap.

With 15 or fewer sessions, logical slots 1 through 15 map directly to physical keys 1 through 15.

### Overflow

When the 16th session arrives, the deck enters overflow mode:

- Physical keys 1 through 14 display sessions from the current page.
- Physical key 15 displays `NEXT` on every page.
- The prior logical-slot-15 session becomes the first session on page two. This is the only permitted movement caused by entering overflow.
- The new logical-slot-16 session becomes the second session on page two.
- Further pages contain 14 logical slots each.
- Pressing `NEXT` cycles through pages and wraps from the last page to the first.
- Session closure does not compact higher pages. Overflow remains while any live session occupies a higher-page logical slot.
- If the current page becomes empty after removals, the view moves to the nearest earlier non-empty page.
- When no live session remains above logical slot 14, overflow ends and key 15 returns to session use.

Paging changes the view, not logical assignments.

## Key activation

Each rendered session cell carries its session identity and allocation revision. A press sends the physical key coordinate, current page, identity, and allocation revision. The daemon verifies that the current projection still assigns that exact cell to that identity and revision before dispatching activation.

The activation broker accepts only tagged targets:

- `terminal-locator`: exact application and pane, tab, or window locator.
- `codex-task-id`: exact supported Codex task route.
- `browser-tab-token`: exact supported browser/tab identity.

Adapters cannot supply shell commands. The broker does not search by title, repository, or working directory. Unsupported, stale, ambiguous, timed-out, or failed activation triggers the native Stream Deck alert and changes no session state or placement.

The `NEXT` control is handled as a deck projection action, not as a session activation.

## Local transport and security

- The daemon listens on `127.0.0.1` only.
- A random bearer token is stored in a mode-`0600` file under the per-user application-support directory.
- Hooks, `agentctl`, and the Stream Deck plugin read the token from disk; it is never embedded in provider configuration.
- Ingress uses versioned JSON requests.
- The plugin subscribes over a local authenticated WebSocket.
- Every plugin update is a complete deck snapshot. With only 15 physical cells, full snapshots are simpler than delta replay and are small enough.
- On reconnect, the plugin discards its prior view and accepts the daemon's complete current snapshot.
- The daemon remains the single serializer and writer.

## Persistence

There is no database. Runtime session records, states, leases, child topology, activation targets, and rendered snapshots remain in memory and are reconstructed from adapters.

`placements.json`, stored mode `0600` under the application-support directory, contains only:

```json
{
  "schemaVersion": 1,
  "nextAssignmentRevision": 42,
  "reservations": [
    {
      "sessionKey": "provider/surface/session/incarnation",
      "logicalSlot": 3,
      "assignmentRevision": 19
    }
  ]
}
```

It is rewritten only when membership or logical placement changes, including removal by lease expiry. Status changes and heartbeats do not touch disk.

Each write serializes a complete replacement to a sibling temporary file, flushes it, and atomically renames it over `placements.json`. A write failure leaves the in-memory registry running, logs the failure, and retries on the next placement change.

### Daemon restart

1. Load valid reservations as unconfirmed placement hints. They are not visible sessions.
2. Start the deck projection empty and trigger provider reconciliation.
3. Confirmed identities reclaim their previous logical slots and appear immediately.
4. Keep unconfirmed hints reserved for a 10-second startup grace so a new observation cannot steal a still-live session's key.
5. Release any remaining unconfirmed hints after the grace period. A later reconnect allocates normally.

A missing, malformed, or unsupported-version file is ignored with a diagnostic. Reconciliation rebuilds the live deck; only previous slot continuity is lost.

## Installation and ownership

`agentctl install` installs the daemon LaunchAgent, the Stream Deck plugin and 5x3 profile, the bearer token, built-in provider observers, and additive harness hook entries.

- JSON and TOML configuration are parsed and edited structurally.
- Existing unrelated settings and hooks are preserved.
- Repeated installation is idempotent and updates only owned entries.
- The shipped profile is added without replacing other Stream Deck profiles.
- The installer does not remove or configure AgentDeck, Herdr, or other agent tools.
- No automatic updater is part of v1.

An `install-manifest.json` records only the exact files and identifiable configuration entries owned by this installation. `agentctl uninstall` stops the LaunchAgent and removes only those owned files and entries. It does not touch provider histories, tasks, unrelated hooks, or other Stream Deck profiles.

`agentctl doctor` is read-only and reports these gates separately:

- Daemon installed, running, authenticated, and writable state directory.
- Each provider's hooks/observer, current observation capability, and latest reconciliation health.
- Stream Deck plugin connection and profile availability.
- Physical 15-key device presence when the Stream Deck SDK exposes it.

`agentctl status --json` returns the daemon's normalized current registry and deck projection for diagnostics and tests.

## Failure behavior

- **Dropped hook event:** the hook returns without blocking the harness; the next observation corrects state and reconciliation repairs membership.
- **Adapter disconnect:** observed sessions survive only until their leases expire, then disappear without a stale tile.
- **Daemon crash:** the LaunchAgent restarts it; confirmed sessions reclaim placement hints.
- **Stream Deck disconnect:** the daemon continues operating; reconnection receives one complete snapshot.
- **Malformed placement file:** start without hints and rebuild from providers.
- **Activation failure:** show the native Stream Deck alert and change nothing else.
- **Unsupported provider surface:** report the failed capability through `doctor`; do not silently substitute fuzzy or screen-based observation.

## Testing strategy

### Pure reducer and allocator tests

- Membership transitions for upsert, authoritative removal, complete reconciliation, and lease expiry using a fake monotonic clock.
- Working/waiting/idle/error mapping and recursive state priority.
- Total live-descendant badge count and zero-badge omission.
- Lowest-free-slot allocation, stable placement, released-slot reuse, and no compaction.
- The 15-to-16 overflow transition, including movement of only logical slot 15.
- Multi-page cycling, page persistence through gaps, empty-page fallback, and exit from overflow.
- Allocation revision checks for stale presses and recycled keys.
- Startup reservation confirmation and 10-second hint expiry.

### Adapter contract tests

- Run hook senders against a temporary daemon rather than matching generated command strings.
- Parse and exercise representative provider event fixtures as structured data.
- Spawn real temporary child processes attached to test PTYs for CLI membership and exit behavior.
- Exercise complete versus partial reconciliation semantics.
- Verify title fallback, archive/exit removal, descendant mapping, and safe default-to-idle behavior.

### Daemon integration tests

- Loopback authentication and rejection of unauthenticated requests.
- Serialized mutation handling and complete WebSocket snapshot publication.
- Atomic placement replacement and recovery from interrupted or malformed state.
- Daemon and plugin reconnect behavior without event replay.
- Activation timeout, typed-target validation, and stale-cell rejection.

### Installer tests

- Install twice into temporary JSON and TOML configurations and verify semantic idempotence.
- Preserve unrelated settings and hooks.
- Uninstall only owned entries and files.
- Exercise installed hook commands against a fake daemon instead of asserting large rendered strings.

### Stream Deck plugin tests

- Render representative tile images for every provider and state, long titles, repository fallbacks, zero and nonzero badges, and `NEXT`.
- Use focused image fixtures or pixel-level visual comparisons for public rendering behavior.
- Verify that key events include cell identity and allocation revision.
- Verify native alert behavior for rejected activation.

### Live acceptance gates

Software tests do not prove the physical deck or current harness integrations. Final acceptance requires a real 15-key Stream Deck and current installations of Codex, Claude Code, and Kimi:

1. Start real top-level sessions on every supported surface and confirm titles, provider marks, and state colors.
2. Exercise working, waiting, idle, and error without visible status text.
3. Spawn and stop subagents and confirm recursive state rollup and bare badge counts.
4. Close CLI surfaces and archive App/Web tasks and confirm immediate disappearance.
5. Interrupt an observer and confirm lease-based disappearance and clean reappearance.
6. Exercise 15, 16, and more sessions and verify stable placement and paging.
7. Restart the daemon and plugin and verify placement recovery and full-snapshot convergence.
8. Verify exact focus on supported targets and native alert/no-op on unsupported targets.

Claims must remain separate: unit/integration green, plugin installed, daemon running, provider observation proven, and physical-device behavior are distinct gates.

## Approved decisions

- Own the daemon and first-party harness adapters; do not build on AgentDeck or Herdr.
- Active membership is based on live terminal surfaces or unarchived App/Web tasks.
- Closed and stale sessions disappear instead of becoming visible states.
- Use status color without status text.
- Use a bare numeric subagent badge and no child tiles.
- Preserve logical placement; introduce `NEXT` only on overflow.
- Persist placement hints in atomic JSON, not a database.
- Keep activation focus-only, exact, typed, and revision-fenced.
- Prefer complete reconciliation and complete deck snapshots over generalized event machinery.
