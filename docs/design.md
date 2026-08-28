# Dealerboard design

Dealerboard is a macOS-local live status and navigation surface for coding
agents. It favors current state over history, bounded local interfaces over
provider-wide access, and explicit degraded states over stale confidence.

## System shape

Dealerboard has three layers:

1. Provider hooks and the Evener AppWire observer translate provider-specific
   lifecycle signals into a small normalized event union.
2. One per-user LaunchAgent daemon runs maintenance, lineage projection,
   quota/token collectors, and atomic snapshot publication.
3. Thin consumers render snapshots. The Tauri strip app is current; the
   Stream Deck consumer is deprecated but remains build-tested.

Short-lived event/session helpers and the daemon write through independent
SQLite connections. The daemon is the only long-lived maintenance process and
snapshot publisher. Hook helpers always exit zero after bounded input handling,
so display failures do not block provider turns.

## Session model

Sessions use the composite identity `(provider, sessionId)`. A positive
logical slot gives each top-level session stable ordering while it remains in
the registry. Native subagents carry a provider-local parent; Paseo lineage
can safely connect sessions across providers by unique origin references.

The status order is:

```text
error > waiting > working > idle
```

A projected parent receives the maximum effective status of its visible
subtree without changing the parent's stored status, unread ledger, or timer.
Missing, ambiguous, or cyclic Paseo lineage stops safely and leaves sessions
in the orphan tail. Invalid native topology rejects the projection.

## Visibility and card retention

A root card is visible while it is active (`working` / `waiting` /
`error`), holds a finished result (`doneSince` or `unreadSince`), or any
Paseo-lineage descendant holds one. Finished Paseo subagents stay hidden
and roll their results up to the root ancestor with a pending-results
badge and aggregated unread stamp; a subagent whose lineage cannot
resolve renders as its own card rather than being discarded. Native child
rows are display-only and disappear when they finish.

Reading a result never removes a card. A view clears the unread badge and
starts a 24-hour expiry clock (`viewedSince`); the card leaves only
through an explicit dismiss (app flick, action-sheet Dismiss, CLI
`sessions ack`, Stream Deck key press), a manual clear, a Paseo archive,
a reused session start, the viewed-expiry sweep, or the stale prune —
which skips any tree holding an unviewed result. Viewing in Paseo is
inert. A session that ends holding an unviewed result stays as a terminal
"ended" card. Unviewed results never expire and are exempt from prune;
there is no cap on how long or how many accumulate. The standard top-level
prune lease is 24 hours; ZCode uses one hour because it has no
session-end hook. Every provider late-joins on the next submitted prompt
when a start was missed or a live row was pruned.

## Data boundaries

Registry and snapshot strings are bounded. Hook payloads are decoded by
allowlist. Transcript tails are read locally only for supported derived facts:
title, model, and recent activity.

Activity is deliberately low-cardinality. The daemon stores only `File`,
`Command`, `Search`, `Request`, or `Tool`; it never carries a raw command,
path, pattern, query, URL, or tool name into SQLite or a snapshot. Schema 14
clears activity values written by older builds, and the app maps any legacy
unknown activity string to `Activity` before rendering.

Snapshots are mode 0600, written through a sibling temporary file, fsynced,
and atomically renamed. The session snapshot heartbeat is every five seconds;
consumers treat it as offline after ten seconds.

## Strip layout

The strip targets a 2560×720 physical display and scales proportionally in a
1280×360 HiDPI mode. It uses a fixed 760px rail and a two-column board of six
886×102 cards per page. The app remains a floating window when no matching
display exists.

Primary groups sort by logical slot. Immediate children sort by open time,
provider, and identity, then render depth-first. Groups that fit a single
column never split; any other group fills the current page's remaining slots
and continues across pages, its first card on each continued page carrying a
continuation marker, so every page except the last is full.
The orphan tail remains one deterministic full-width block.

### Card contract

- Status colors: working `#20B8FF`, waiting `#FFB020`, idle `#4ADE80`, error
  `#FF4D67`.
- Provider chips: Claude `C`, Codex `X`, Kimi `K`, Pi `P`, oh-my-pi `O`,
  ZCode `Z`, DeepSeek `D`, Grok `G`, Qwen `Q`, Evener `E`.
- The head shows the title and the status corner: an optional dim fact, a
  worded bright number, and the status dot last, so every card's number and
  dot align down the column's right rail. Working cards headline the session
  age (`open 2h`); idle, waiting, and error spell their status age
  (`waiting 12m`) behind a dim `open 3h` fact. Sessions published without
  `openedAt` (an old daemon) simply omit the open facts.
- The meta row can show model, project, and one fixed activity category.
- A Paseo parent's chip wears the containment ring: a violet enclosure with
  a card-colored gap — the harness inside the multiplexer. The ring's shape
  is the semantic; each multiplexer keeps its own hue, same grammar. roborev
  is the second occupant: a reviewer its daemon dispatched wears the ring in
  cyan. A grouped subagent has a dimmed card, indent, and violet spine —
  the tree is its identification, so no pill. Orphans keep subagent styling
  without indent or spine, and only they still carry the `sub` pill.
- Native children never expose tap, acknowledgment, routing, or action-sheet
  behavior. Paseo children remain independently actionable.

Working liveness decays with time since the last event. Recent work is bright
blue; long silence desaturates toward slate. From the 30s fade threshold the
corner leads with a dim `quiet <elapsed>` fact; after ten minutes it stands
down and the card uses the explicit `quiet <elapsed>` treatment. This reports
observation age, not a claim that the agent is stalled.

### Rail contract

The rail contains:

- Daily token total, rolling rates, and an optional LA-calendar-day sparkline.
- Exact unread count plus daemon-health indicator.
- Optional Claude, Codex, Kimi, GLM/zai, and Qwen quota meters.
- Page dots.

Each quota row binds to the lowest remaining window; ties prefer session,
weekly, then extras. Other windows appear only as neutral ticks. With two or
more privacy-safe Claude account readings, stable numeric account slots replace
the ambient Claude row.

Quota and token data use independent sidecar snapshots so daemon and app
versions can roll independently. Missing optional helpers hide their panels.
A failed refresh keeps the last-good percent and pending reset countdown; once
the reading is stale it adds a coarse age such as `1h+ old`, while a spent reset
leaves the age standing alone.

## Interaction

A tap views the card — clearing its unread badge and starting its expiry
clock — then routes Paseo, Claude/Ghostty, Codex, or Kimi when an exact
target exists; an ended card views but never routes. Unsupported or
unbound routes flash. A vertical flick dismisses a finished card — one
holding done/unread or in error (active working/waiting cards can never be
flicked away); a long press opens Open, Dismiss (same eligibility), Reveal
transcript, Copy session ID, and double-confirmed Clear actions. Both
dismiss paths carry the causality watermark of the stamp the gesture was
issued from, so a result landing after the render survives the gesture.
Horizontal flings and rail dots change pages. Native child cards are
excluded from every interaction path.

## Optional collectors

- CodexBar runs every 120 seconds for quota data.
- `cswap list --json` adds privacy-safe Claude account meters.
- `agentsview` runs every 30 seconds for aggregate daily token totals.
- Paseo overlay state refreshes every two seconds.
- Evener uses authenticated loopback AppWire v3 and refreshes every two
  seconds. Lists are capped at 16 pages and 4,096 records before any hydration
  is emitted.

Raw helper output and capabilities are not logged or persisted. Evener's
current protocol sends its bearer in the initial WebSocket Authorization
header, so its loopback connection shares the local-user trust boundary.
