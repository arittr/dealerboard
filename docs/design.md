# Stream Deck Agents: Product Design

Date: 2026-08-05

Status: Superseded on 2026-08-06 by the [hook-driven session registry design](superpowers/specs/2026-08-06-hook-driven-session-registry-design.md). Retained as a historical decision record.

Gate 0 spec: [2026-08-05-stream-deck-agent-gate-0-design.md](superpowers/specs/2026-08-05-stream-deck-agent-gate-0-design.md)

## Purpose of this document

This document records the product Drew wants and the architectural direction that survived design review. It is not an implementation contract. Statements about provider APIs, current-session inventory, state recovery, lineage, focus, Stream Deck lifecycle, and packaging must be proven by Gate 0 before they become implementation requirements.

## Product intent

Build a macOS-local system that projects currently active agent sessions onto Drew's 15-key Stream Deck. The target providers are Codex App and CLI, Claude Code CLI, and Kimi Code CLI and Web.

The deck is a glanceable status and navigation surface. It is not a second agent dashboard, transcript viewer, command console, or historical inbox.

## Prior-art checkpoint

We installed and exercised AgentDeck 1.0.2 with its Stream Deck plugin 1.0.4.0. It confirmed that status-first session tiles and a local registry are useful, while exposing boundaries for this product:

- Hook-only discovery missed quiet existing sessions that `claude agents --json` could enumerate.
- Its tiles used project names rather than the session titles Drew wants.
- Its Codex setup did not safely merge an existing user-owned `[features]` table.
- It did not support Kimi.
- A key press opened an AgentDeck detail view instead of focusing the source surface.
- It reserved deck keys for quota information instead of using the deck as a session surface.

We retain the useful interaction ideas, but AgentDeck and Herdr are neither dependencies nor integration targets.

## Locked user experience

### One tile per logical top-level session

- Top-level sessions receive tiles.
- Subagents never receive their own keys.
- A bare numeric badge shows the total live descendants when that count is authoritatively known and greater than zero.
- The badge has no `+` prefix.
- The descendant badge is prominent in the upper-right corner so it remains legible on a small panel.
- Unknown lineage must not be represented as a known zero; Gate 0 determines whether every target provider can support the strict badge contract.

### Status is color-only

Session tiles use a thick status-colored frame around a dark interior:

- Working: blue `#20B8FF`
- Waiting for Drew: amber `#FFB020`
- Idle (turn finished, at prompt): green `#4ADE80`
- Error requiring attention: red `#FF4D67`

Working uses a shallow full-tile blue wash behind a static dim blue frame. The
wash breathes from 4% to 14% opacity over four seconds, keeping the title and
provider chip crisp. Each working tile enters that cycle at its own offset,
derived from the session id, so several sessions working at once read as
separately active rather than as one blinking block; the offset is a property
of the session id alone, so a tile holds its place across repaints, page flips,
and restarts. Waiting keeps a deeper four-second amber breath, error keeps a
faster two-second red pulse, and idle remains static. Animated status
treatments change opacity only; they do not move, scale, or change stroke width
on the small panels.

There is no visible status word or status glyph. A session whose current state is unknown must not be rendered as known-idle. Gate 0 must determine whether unknown sessions receive a distinct neutral treatment or remain hidden until state becomes known.

Each tile also has:

- A provider-colored chip in the upper-left with the provider's one-letter mark in dark text: terracotta `#D97757` C for Claude, fuchsia `#D946EF` X for Codex, blue `#3B82F6` K for Kimi, green `#0EA514` P for pi, cream `#F5F0EA` O for oh-my-pi, gold `#EAB308` Z for zcode, teal `#2DD4BF` D for deepseek, pink `#F472B6` G for grok, and red `#EF4444` Q for Qwen. Hues are chosen for mutual distinctness on the LCD panel, not brand fidelity.
- The session's model id as small neutral-chrome text right of the provider chip, when known: vendor prefix stripped (`claude-fable-5` shows as `fable-5`, `grok-4.6` as `4.6`), capped at ten code points with an ellipsis. Kimi pushes its model in SessionStart hooks (a titleless start registers too — see the membership rule below — so fresh sessions get their model); pi pushes it through its shim's `session_start`; Qwen pushes it in its SessionStart hook. The daemon resolves Claude and Codex models from transcript/rollout tails (last occurrence wins, so mid-session model switches register). The daemon resolves grok's model (and title) from the session's `summary.json`. omp, zcode, and deepseek have no model source — their tiles show the chip alone.
- An origin pip in the free bottom-right corner for Paseo-origin sessions: a filled violet `#A78BFA` disc (center 122,122, radius 9) for a Paseo parent session and a hollow violet ring (stroke width 3) for a Paseo subagent. Terminal-origin and origin-unknown sessions render no pip. Pressing a Paseo-origin tile with a known agent reference routes to the Paseo app deep link `paseo://h/<serverId>/agent/<agentId>` instead of the provider's own activation; a null reference falls back to provider routing. Provider routing is otherwise unchanged: Claude tiles focus their Ghostty terminal, Codex tiles open `codex://threads/<thread>`, and Kimi tiles open the Web session at the fixed local origin.
- A two-line session title. Kimi pushes `session_title` through its hooks; the daemon resolves Claude titles from the transcript's `ai-title` records and Codex titles from `~/.codex/session_index.jsonl`'s `thread_name`, writing them back to the registry. Grok titles come from the same `summary.json` pull. Title text is word-wrapped into two twelve-code-point lines; a word longer than a line hard-splits, and text that outlives the second line ends in an ellipsis.
- Repository or worktree name as the first fallback while no title is known.
- Provider plus shortened session identifier as the final fallback.

### Membership, not completion history

The product should show sessions that are currently attached, loaded, running, or otherwise positively live according to a provider-supported complete inventory.

- An authoritative process exit, attachment close, or archive removes a session.
- Archive can be an authoritative negative fact, but lack of archive is not positive liveness.
- A stale observation disappears; reconnecting observation creates it again.
- A completed turn becomes idle rather than done. A Claude session with a background shell still running is the exception: the outstanding shell keeps the tile at working until the shell's completion notification (or a TaskStop) lands and the wake turn ends without re-arming.
- Closed, done, and stale are not visible tile states.
- There is no manual dismissal or retained closed-session history.

Kimi Web eagerly creates a titleless session when a blank page opens, but may
never emit an end event when that unused page is abandoned. A titleless Kimi
`SessionStart` is therefore insufficient evidence for *grid* membership — but
it still establishes registry membership: the row registers (which is also
what stores the session's model), and because an idle, never-unread row is
never projected, the abandoned page never becomes a tile and ages out via the
ordinary prune. The first `UserPromptSubmit` flips the row working and
visible; a titled `SessionStart` still establishes membership immediately
when an existing session is resumed. Registry membership is not grid
visibility: the projection admits only active or unread rows, so a resumed
session whose titled `SessionStart` lands idle with no unviewed result stays
off the grid until its next Activity or unread output.

Source health and session membership are separate. A source outage may preserve its last confirmed membership only for a bounded, provider-specific lease. The session disappears when that lease expires. As implemented, the lease is uniform: the daemon prunes any top-level session whose last hook is older than 24 hours, and a still-live session pruned by mistake reappears at its next prompt (every provider late-joins on `UserPromptSubmit`). The daemon also rewrites the snapshot every five seconds as a heartbeat; the plugin treats a file older than ten seconds as a dead daemon and degrades instead of rendering stale tiles as live.

Membership is also attention-scoped: a tile exists if and only if the session is active (working, waiting, or error) or unread — idle with an unviewed result. One refinement: an idle Paseo subagent (hollow-ring origin) with no active descendant is never admitted, even when unread — a finished subagent's result is consumed by the orchestrating parent agent, not by the user pressing tiles, so completed subagent runs never pile up on the grid. Active subagents still show with their ring. Unread is a per-session ledger (`unread_since`, added in schema v7; the current schema is v11 — v8 repaired pre-merge v7 databases missing the `model` column, v9 added the `acked_at` ack watermark, v10 widened the provider CHECK for grok, and v11 added `status_since`, `origin_parent_ref`, and `activity_line` for the strip's data surface). A turn ending — a Stop that settles to idle, or StopFailure — stamps it, because a result landed; only an explicit view clears it: a tile press acks through the daemon (`sessions ack`, the plugin's sole write path), the Paseo overlay reports the agent viewed in Paseo, or a `SessionStart` reuses the session. The ack is timestamped in `acked_at`, so a Paseo attention flag raised before the view can never resurrect the tile afterwards. Prompting again does not mark the earlier result read. A read-and-idle row persists in the registry — subject to the ordinary prune — and is not projected onto the grid (so on the grid idle implies unread), with one exception: a Paseo ancestor stays projected with its effective status lifted while any Paseo descendant is active, its stored status and unread ledger untouched (the lineage rule in the strip section below). No separate dismiss action exists: viewing the result retires the tile.

The previous proposal equated unarchived App/Web tasks with active tasks. That is rejected: on 2026-08-05 this host had 288 unarchived top-level Codex threads, which would turn the deck into a historical inbox.

### Stable logical placement

- A new top-level session takes the lowest free logical slot.
- State, title, badge, and capability changes never reassign it.
- Removal releases the slot.
- The logical slot is an ordering key, not a position. The visible grid packs live sessions densely in slot order: removal shifts every later tile one key left, and a new session reusing a freed slot inserts at that rank, shifting later tiles one key right. Blank keys appear only after the last live tile.
- Stability is guaranteed only while registry membership is uninterrupted. A lease expiry removes the assignment; a later observation allocates normally.

With no overflow, the packed rank order maps to physical keys 1 through 15 in order.

### Overflow

When the live session count exceeds fifteen:

- Physical keys 1 through 14 display the current page's fourteen sessions in rank order.
- Physical key 15 becomes `NEXT` on every page.
- Pages are dense fourteen-tile slices of the rank order.
- `NEXT` cycles through pages and wraps.
- An out-of-range current page clamps to the last page.

Overflow is an explicit persisted projection latch with hysteresis, not something derived solely from the instantaneous count: it engages when the live count exceeds fifteen, holds while at least fifteen sessions are live, and ends at fourteen or fewer. Live sessions reflow as membership changes; the grid never shows holes between tiles.

## Candidate architecture

The staff review unanimously retained this three-layer shape.

### First-party provider adapters

Built-in adapters observe supported provider surfaces and own provider-specific joining, inventory, state, and event ordering. V1 does not expose an adapter SDK or accept arbitrary third-party normalized mutations.

### One per-user daemon

A small TypeScript daemon runs as a LaunchAgent and is the sole owner of:

- Logical sessions and runtime attachments.
- Known and unknown facts.
- Parent/descendant topology.
- Membership leases.
- Effective state and badge projection.
- Stable logical placement and paging.
- Complete Stream Deck snapshots.
- Diagnostics and capability health.

Provider calls and raw-hook queues must be bounded. External I/O must not run while the pure reducer's serialization path is held.

### Thin consumers

- The Stream Deck plugin renders complete daemon snapshots and reports key events.
- `agentctl` sends bounded raw hook events and provides read-only `status` and `doctor` output.
- There is no desktop dashboard.

## Candidate logical model

A logical provider session can have multiple runtime attachments. This avoids duplicate tiles when the same session appears through CLI, App, or Web. The logical session is visible while at least one attachment is positively live. Closing one attachment removes only that attachment; the tile disappears when no live attachment remains.

```ts
type LogicalSessionIdentity = {
  provider: "codex" | "claude" | "kimi";
  sessionId: string;
};

type RuntimeAttachment = {
  surface: "app" | "cli" | "web" | "background";
  hostInstance: string;
  incarnation: string;
  membership: "live" | "unknown";
  activity: "working" | "idle" | "unknown";
  attention: "waiting" | "clear" | "unknown";
  failure: "error" | "clear" | "unknown";
  lineageComplete: boolean;
  descendantCount?: number;
  canActivate: boolean;
};
```

Gate 0 must prove a deterministic identity and incarnation recipe for each surface. An incarnation must remain stable across daemon restart for one live attachment and change after an authoritative close followed by reopen. If a provider cannot supply both properties, that surface cannot claim strict support.

Effective state retains the selected priority:

```text
error > waiting > working > idle
```

State and descendants aggregate across all live attachments and the complete live subtree. A descendant row exists only while its subagent runs, so a live descendant lifts the subtree to at least `working` even when the child never emits activity of its own. Idle requires positive evidence that activity is idle, attention is clear, and failure is clear everywhere in that aggregate. Unknown facts do not collapse to idle. Parent topology must reject self-parenting, cycles, illegal cross-scope links, and unbounded traversal.

## Candidate adapter ownership and causality

The former public `UPSERT` / `REMOVE` / `RECONCILE` contract is retired. Receive-order serialization cannot prevent an old inventory from deleting a new session, resurrecting a closed session, or overwriting newer waiting state.

Each provider/surface scope instead has one exclusive, stateful in-process owner:

- Raw hooks enqueue bounded provider events to that owner; they do not mutate the normalized registry directly.
- Membership snapshots establish only membership.
- Fact patches update title, activity, attention, failure, lineage, and capability without renewing membership or resurrecting a closed attachment.
- Authoritative incarnation-end events remove membership and create an in-memory exact-incarnation tombstone for the daemon lifetime.
- One reconcile can be in flight per scope.
- Reconcile begin captures a scope generation and the current identity mutation revisions.
- Reconcile commit applies inclusion and omission only to identities unchanged since that fence.
- Events observed during the inventory are applied after the inventory result.

This is local scope fencing, not a global event log, distributed clock, database, or generalized epoch protocol.

## Target provider capabilities

The product goal remains all requested surfaces, but none is declared supported before Gate 0.

| Surface | Current evidence | Unproven requirements |
|---|---|---|
| Claude Code CLI/background | `claude agents --json` can enumerate quiet top-level interactive and background sessions. | Complete state recovery, descendant inventory, incarnation recipe, exact terminal focus. |
| Codex App | Stored thread metadata and an embedded app-server exist. | Supported external live-attachment inventory, state subscription, lineage, exact task focus. |
| Codex CLI | Process and rollout evidence exist. | Complete quiet process-to-session join, current state, lineage, terminal focus. |
| Kimi Code CLI | Hooks and process/session artifacts exist. | Complete quiet process-to-session join, restart-safe state and lineage, terminal focus. |
| Kimi Web | Authenticated local server APIs expose stored sessions and aggregate state while a server runs. | Browser-client attachment inventory, cold-history distinction, lineage, exact existing-tab focus. |

Gate 0 produces a capability matrix. Drew then decides whether the product retains one strict universal contract or permits explicit capability tiers. Missing evidence is never silently replaced with recency, LRU, title/CWD matching, accessibility scraping, or undocumented IPC.

## Activation boundary

Exact focus remains a product goal, not a v1 implementation promise.

- Every surface starts with `canActivate=false`.
- No concrete activation target union or broker is implemented until Gate 0 proves an identity-to-target join for at least one surface.
- A session key with no proven target safely no-ops and invokes the current Stream Deck action context's native alert.
- Focus must select the exact existing surface. Opening a duplicate browser tab or matching a window by title, repository, or working directory does not pass.
- If multiple attachments are live and no authoritative target can be selected, activation remains disabled.

Allocation revision fencing remains part of the eventual boundary so a recycled key can never activate its previous owner.

## Stream Deck boundary

V1 targets exactly one connected compatible 5×3 device.

- Zero or multiple compatible connected devices means not ready.
- The plugin binds `(deviceId, row, column)` to the current SDK action context on `willAppear`.
- It drops the binding on `willDisappear` or disconnect.
- SDK action contexts are ephemeral render/alert handles, never persisted identity.
- Profile readiness requires all 15 expected live contexts.
- On daemon disconnect, the plugin disables presses and blanks or renders an explicit offline treatment instead of leaving stale actionable tiles.
- Authenticated reconnection replaces the complete projection from one current snapshot.

The exact profile install/uninstall behavior and physical rendering are Gate 0 proofs.

## Persistence direction

There is no database. Runtime facts are rebuilt from providers.

An atomic, mode-`0600` JSON file may persist only placement hints, allocation revisions, and the explicit overflow latch. Identities are stored as structured fields rather than delimiter-concatenated strings. The parser must bound file size and validate unique identities, slots, revisions, and safe integers.

Hints remain invisible until their owning provider scope confirms membership. They release after that scope's first complete reconcile or a declared per-scope failure deadline. Failed writes use bounded retry/backoff and surface degraded health.

## Transport and security direction

- Communication remains local to the current macOS user.
- Full Stream Deck snapshots are preferred to delta replay.
- A `0700` runtime directory and capability-specific bounded validation are required.
- Hostile same-UID processes are out of scope and must be documented; a `0600` token is not a boundary against them.
- Raw hooks cannot submit activation targets.
- Gate 0 decides loopback bearer transport versus a mode-`0600` Unix socket based on what the Stream Deck runtime can reliably access.

## Packaging and ownership direction

The LaunchAgent must use an owned runtime or self-contained bundle and absolute paths. It cannot depend on an interactive shell, nvm, repository checkout, or ambient `PATH`.

Installation remains additive and reversible:

- Preflight and parse every target before mutation.
- Apply atomic semantic configuration edits.
- Publish an ownership manifest last.
- Record semantic entry identifiers and installed-content hashes.
- Reinstall or uninstall only unchanged owned material.
- Preserve and diagnose user-modified owned material instead of overwriting or deleting it.
- Keep daemon/hook ownership separate from Stream Deck plugin/profile ownership until supported removal is proven.

Apple Events, TCC identity, signing, profile prompts, login launch, sleep/wake, and upgrade behavior are evidence gates rather than paper assumptions.

## Non-goals

- No AgentDeck or Herdr dependency or integration.
- No database, replay log, generalized adapter SDK, or remote service.
- No session history, desktop dashboard, or manual dismissal.
- No stop, approve, archive, prompt injection, or other agent-control action.
- No fuzzy focus or screen scraping.
- No automatic updater in the first version.
- No full product implementation plan until Gate 0 is reviewed.

## Decision after Gate 0

Gate 0 does not automatically weaken or cut the product. It reports evidence. Drew then chooses one of two explicit outcomes:

1. Keep the strict universal contract and exclude or block surfaces that cannot satisfy it.
2. Approve capability tiers that truthfully represent reduced membership, state, lineage, or activation support.

Only after that choice do we revise this candidate design into an implementation contract and write the full product plan.

## Strip app (Xeneon Edge)

The strip is a frameless Tauri webview pinned to the Xeneon Edge touch
display — a third snapshot consumer alongside the Stream Deck plugin. It
renders the same projection the deck renders, so the deck remains the
reference contract for session semantics; this section records the strip's
own visible contract, rewritten for the 2026-08-25 board redesign
(parent-grouped wide cards, compact rail). The strip's board is an app-local
grouped reducer (`app/src/board.ts`): the shared `reduceLayout` paging in
`src/plugin/layout.ts` cannot express grouping or column packing, so the
strip stopped consuming it (the keypad keeps it unchanged) while label
fallbacks reuse the shared chain. The full behavioral spec is
[superpowers/specs/2026-08-25-strip-board-redesign-design.md](superpowers/specs/2026-08-25-strip-board-redesign-design.md).

All dimensions below are native 2560×720 pixels, viewport-relative in the
implementation (px/25.6 → vw, px/7.2 → vh), so the 1280×360 HiDPI mode
scales proportionally and nothing is pixel-locked; macOS draws its menu bar
as a ~30px overlay on the strip display (no visibleFrame reservation), so
the top 44px stays clear of critical content — board and rail alike — and
thin marks (hairline borders, the 2px spine, the 8px status edge) map
per-axis to viewport units and never drop below one physical pixel in the
HiDPI mode (`max(1px, …)`).

### Geometry

- The session area is the canvas minus the fixed 600px rail (~23.4%) and the
  outer gutters; the board holds two 966×102 columns of six rows with 12px
  gaps — up to 12 cards per page.
- Cards are a fixed standard size and never grow or shrink with session
  count: one session renders one standard card top-left, empty canvas stays
  empty. Twelve is a maximum, not an invariant — group-atomic page fill
  (below) can leave a page sparse.

### Ordering: parent-grouped, stable

The board replaces flat slot order with grouped order:

1. Primary sessions (everything not a Paseo subagent) in slot order.
2. Each primary is immediately followed by its subagents in slot order. The
  join is `originParentRef` (subagent) = `originRef` (parent); both fields
  are already on `ProjectedSession` and the wire `schemaVersion` stays 2 —
  no protocol change.
3. Nested subagents flatten: a subagent whose parent is itself a subagent
  attaches to its nearest on-grid ancestor's group, at the same single
  indent level, ordered directly after its own parent within that group.
  There is no recursive visual nesting.
4. Orphan subagents — live Paseo subagents with no on-grid ancestor — form
  one atomic tail block strictly after every group, in slot order; the tail
  never backfills ahead of groups.

Paseo lineage carries status as well as grouping: `originParentRef` resolves
to a parent root's unique Paseo `originRef` — separate from the
provider-native `parent_session_id` tree — and every effectively active
Paseo subagent rolls its status up that ancestry with the same
`error > waiting > working > idle` priority, across nested chains and
provider boundaries. A done/read ancestor therefore stays on the board with
a lifted effective status (at least `working`) while any descendant is
active; its stored status, `unreadSince`, and own `statusSince` timer are
untouched, and ordinary visibility resumes as soon as the last active
descendant ends. A missing link, an ambiguous duplicate ref, or a cycle
stops the walk safely — no snapshot failure — leaving those active
subagents to the orphan tail.

### Packing and paging

Pages fill group-atomically in grouped order (a lone primary is a group of
one; the orphan tail is one block):

- A group of six or fewer cards never splits: it drops whole into the first
  column of the current page with room; a later group may backfill a gap
  left earlier on the same page; if it fits in no column of the current
  page, it starts the next page. Backfill never crosses a page boundary.
- A group of 7–12 cards needs two adjacent empty columns, so it starts on
  the current page only while that page is still empty; otherwise it starts
  the next page. It fills the first column and wraps at the six-row
  boundary into the second (the spine continues at the top of the
  continuation column).
- A group larger than a page fills whole pages from a fresh page and
  continues across page seams — with the 7–12 rule, the only ways a group
  ever splits.
- Page count derives from the packing, not the session count; the rail's
  pager dots follow it, and the persisted current page
  (`agent-strip.layout.v1`) clamps when the page count shrinks. The
  keypad's overflow-latch hysteresis is a NEXT-key concern and does not
  carry to the board.

Two accepted trade-offs: scan order can deviate from strict linear order
when a large group skips a too-small gap (deterministic and stable); and
placement stability has one qualification — hooks stamp only Paseo kind/ref
at ingest, and the daemon's overlay adds `originSubagent` and
`originParentRef` on its ~2s pass, so a freshly appeared subagent can render
ungrouped for its first seconds and then hop into its parent's group once
the stamp lands (accepted; there is no admission gating on resolved
lineage). Beyond that, cards move only on membership change — parentage,
once stamped, is immutable for the session's lifetime.

### Card anatomy

- Left status edge (8px) in the status color — working `#20B8FF`, waiting
  `#FFB020`, idle `#4ADE80`, error `#FF4D67`; waiting and error cards
  additionally get a full status-colored border and a faint status-tinted
  surface wash so they pop from working/idle cards.
- Status animation semantics carry over unchanged from the tile contract
  (opacity-only; working's staggered shallow wash breathe 0.04→0.14,
  waiting's border breathe, error's 2s pulse, idle static), retargeted to
  edge/border/wash — including the wall-clock-seeded negative
  animation-delay so a recreated card resumes mid-wash instead of snapping
  to the dim end.
- Provider chip (42px, one-letter mark on the locked hues) with the amber
  unread dot on its corner (an 18px `#FFB020` disc on a 3px card-colored
  ring) whenever `unreadSince` is set — on the grid, idle ⟺ unread,
  unchanged.
- One-line 32px title in primary ink, ellipsized on overflow. The label
  chain is the shared one: title, else project name, else provider +
  shortened session id; any fallback (not just project) renders italic as
  its only cue.
- Muted meta line: model id (vendor prefix stripped, capped at 24 code
  points — the tile contract's ten-point cap does not apply) · project ·
  `activityLine` when present. A grouped subagent whose project equals its
  parent's suppresses the project (redundant).
- Meta-line right end, in order: the violet `#A78BFA` origin disc for Paseo
  parents, then the bare descendant-count badge (`2`, never `+2` — the
  locked badge convention) when `descendantCount > 0`; the count is live
  descendants per the existing contract (e.g. Claude Task subagents), not
  the number of grouped sub-cards.
- Right-aligned on the head line: status dot + status word + tabular-numeral
  elapsed timer (`statusSince`, the row's own status stamp), ticking in
  place on the 1s rail cadence so the render-signature skip and CSS
  animations are never disturbed.
- Subagent cards: dimmed treatment — near-canvas surface, hairline border
  (`max(1px, 0.078125vw)`), 26px muted title, 32px chip, half-opacity
  status edge; a hollow-violet-ring "sub" pill after the chip replaces the
  corner ring pip. Grouped subagents indent 44px (922×102, right edges
  flush) under their parent, connected by a 2px violet spine from the
  parent's bottom edge with an elbow into each subagent card; orphans keep
  the dimmed treatment and pill at full 966px width, no indent or spine.
  The idle-subagent admission rule is unchanged: an idle Paseo subagent
  with no active descendant is never projected — one retained by an active
  descendant projects as effectively active — so grouped subagent cards are
  always active.
- A degraded card keeps the `!` flag; an all-blank page renders OFFLINE.

### Rail

Fixed 600px (~23.4%), top to bottom:

- **Token block**: today's total (`48.9M today`) with the two trend-colored
  rolling rates on one line (`↑ 32.3M/hr · ↓ 8.5M/10m`) — unchanged
  semantics, still computed from the 288-sample ring, which is retained
  unchanged and remains the sole input to the rates.
- **Day-over-day sparkline** below the rates: a midnight-anchored LA-day
  x-axis with yesterday's complete cumulative curve as a dim 2px line
  ending in a `yda <total>` micro-label (an SVG `<text>` at the mockup's
  baseline) and today's partial curve as a bright 2px line with a faint
  fill, ending in an endpoint dot at the current position, all in a
  matched-aspect 436×80 viewBox. Semantics:
  - The yesterday line renders only when the snapshot's yesterday curve is
    stamped with the LA calendar day immediately preceding the today curve's
    `providerDay`; otherwise only today's line renders. No curves in the
    snapshot → no sparkline (the block keeps total + rates).
  - Each curve maps x by elapsed fraction of its own day's actual length,
    so 23/25-hour DST days share the axis correctly.
  - One shared zero-based y-scale spans the maximum of both curves.
  - The block's existing stale-dimming applies to the sparkline with it.
- **Unread row**: the daemon-health dot (green ok; red plus OFFLINE when
  degraded) inline before the exact unread count (sessions with a non-null
  `unreadSince`).
- **Quota rows** (claude, codex, kimi, GLM/zai, Qwen — strip-only, no
  keypad equivalent), one compact two-line row each: the head line carries
  the provider chip, the label, and a pill naming the binding window —
  bare, no ` binds` suffix (binding selection — the lowest percent
  remaining, ties session > weekly > extras — is unchanged). The right side
  reads `<reset countdown> · <percent>` with the muted countdown first so
  the bright tabular percents align flush at the rail's right edge
  regardless of countdown width; "resetting…" takes the countdown's muted
  slot at reset time. The second line is the 8px full-row-width bar filled
  to the binding window's percent on the headroom palette (green `#4ADE80`
  above 25% remaining, amber `#FFB020` from 10%, red `#FF4D67` below),
  with a 2px neutral tick at each non-binding window's percent — the tick
  is the whole non-binding treatment; textual readouts proved too busy for
  the row.
- **Pager dots**: one per page, tap to jump.
- Data plumbing is unchanged: quota via `quota-snapshot.json` and token
  usage via `token-usage-snapshot.json`, each its own file with its own
  `schemaVersion`, read through Tauri commands, never the session snapshot.
  A provider whose last fetch failed renders dimmed with a last-updated
  age in place of the percent; a provider disabled in CodexBar (or with no
  binary installed) is omitted; a missing file renders no quota rows /
  hides the token block. Stale-dimming semantics are unchanged.

The sparkline's data is additive: `token-usage-snapshot.json` gains a
top-level `dayCurves` key while its `schemaVersion` stays 1 — the parser's
contract ignores unknown top-level keys precisely so a newer daemon never
breaks an older app; an old app ignores the key and keeps the full block, a
new app on an old daemon sees no key and renders no sparkline. Both curves
are date-keyed (`today` always present, `yesterday` nullable); points are
oldest-first with totals clamped non-negative — within a day the collector
stores the running maximum, so a curve is monotone non-decreasing even if
the helper reports a correction — and each day is bucket-downsampled to at
most 96 points while always retaining the day's first and latest sample.
Rollover is date-keyed, never positional: when a sample lands on a new LA
day, today's finished curve is promoted to `yesterday` only if its
`providerDay` is exactly the calendar day preceding the new day, otherwise
`yesterday` becomes null — a daemon down across midnight never promotes a
stale curve; restart seeding reconciles a seeded curve against the current
LA day the same way (adjacent promotes, gapped drops, never mislabeled).

### Interaction

- A tap is the keypad's keyDown: a fire-and-forget ack, then the same
  paseo/claude/codex/kimi routing (subagent cards included). A failed or
  unroutable press flashes the card. All cards are ≥90px in their smallest
  dimension.
- Snapshot delivery is push, not poll: the Rust host watches the app-support
  directory (the daemon publishes by atomic rename, which swaps the file's
  inode, so the watch targets the directory) and emits a `snapshot-changed`
  event carrying the same `{ mtimeMs, contents }` payload as `read_snapshot`.
  The webview does one initial read and then ingests events; the OFFLINE
  check is a one-shot timer at the payload's actual expiry (a dead daemon's
  5s heartbeat stops re-arming it, so the flip lands one 10s threshold
  after the last publish), while a slow 10s pass retries real reads only
  while degraded, so a missed event or a late-starting daemon self-heals.
- A long-press (~500ms without drifting past a 12px slop) on a session card
  opens an action sheet anchored at the touch point: Open (the tap's ack +
  routing), Ack, Reveal transcript (`/usr/bin/open -R`; disabled until the
  snapshot carries `transcriptPath`), Copy session ID, and Clear session —
  the destructive action sits behind an inline two-tap confirm ("Confirm
  clear") and runs the installed binary's `sessions clear`. The sheet
  dismisses on a pointer-down outside it or on Escape.
- A horizontal fling (≥80px of travel with ≤48px of vertical drift) pages
  the board — left for next, right for previous — reusing the rail's page
  jump, so the dots follow and the page persists. A stroke that moved but
  matched no gesture swallows its trailing click, keeping taps, holds, and
  drags unambiguous. There is deliberately no swipe-to-ack: only viewing
  clears unread.
- The webview's native context menu is suppressed outright — every
  `contextmenu` event is canceled at the document root. macOS delivers a
  touch-and-hold as a synthesized secondary click, and the native menu that
  answers it (a lone "Refresh") warps the cursor onto the strip display; the
  pointer must never be moved to the panel. The long-press action sheet
  above remains the strip's only hold surface.
