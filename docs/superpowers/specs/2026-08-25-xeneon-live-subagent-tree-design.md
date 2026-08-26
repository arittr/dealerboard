# Xeneon Live Subagent Tree Design

**Date:** 2026-08-25
**Status:** Approved design
**Scope:** Xeneon Edge strip app, daemon projection, and shared snapshot protocol

## Summary

The Xeneon board will show every live subagent as a child card. This applies equally to provider-native children, including Evener AppWire subagents, and to the existing cross-provider Paseo lineage. Each child card shows its own title, model, status, and status timer when known. Nested execution remains ordered depth-first but renders at one visual indent level. Finished children disappear; the board does not retain subagent history.

The current Xeneon descendant-number badge will disappear once the daemon supplies the complete graph. Counts are a compact-surface substitute for hidden topology, and Xeneon has enough room and paging support to render that topology directly. There is no automatic collapse rule. A future explicit user-controlled collapse may show the number of hidden live descendants, but collapse is outside this design.

Native child cards are informational and display-only. Existing Paseo subagent cards remain independently actionable.

## Problem

The product currently has two incompatible meanings of “subagent”:

1. Provider-native children use `active_sessions.parent_session_id`. Projection hides those rows, rolls their status into the top-level session, and publishes only `descendantCount`.
2. Paseo subagents remain top-level registry rows. The Paseo overlay links them with `origin_ref` and `origin_parent_ref`; projection publishes them individually, and the Xeneon board groups them into a tree.

Evener uses the first path. AppWire supplies each child’s identity, parent, title, model, and status, but the collector emits a model-less `SubagentStart`, the registry stores the child model as null, and root-only projection discards the child’s display facts. This hides the most useful property of Evener subagents: one parent may run heterogeneous models.

The count-versus-tree distinction therefore follows storage representation rather than Xeneon’s product intent.

## Goals

- Show every live provider-native and Paseo subagent on Xeneon.
- Show each Evener child’s own model, title, effective status, and status timer.
- Use one Xeneon graph and one grouping algorithm for native and Paseo hierarchy.
- Preserve existing root visibility, unread, status-rollup, packing, paging, and degraded-view semantics.
- Keep native child cards display-only.
- Preserve daemon/app deployment-order safety.
- Leave the current Stream Deck projection working until that consumer is removed.

## Non-goals

- Completed-subagent history.
- Automatic or user-controlled tree collapse.
- New activation routes for Evener or provider-native children.
- Making native child rows independently acknowledgeable, clearable, or revealable.
- Redesigning card colors, sizes, rail content, page packing, or status semantics.
- Removing the Stream Deck code or the legacy `sessions` field in this change.
- Reusing Paseo origin fields to encode provider-native hierarchy.

## User experience

### Board membership

A child card exists exactly while its native child row or active Paseo subagent is live in the projected graph. A native `SubagentStop` removes the row. Existing Paseo admission remains unchanged: an idle Paseo subagent with no active descendant is not projected.

A live child keeps every resolvable ancestor visible through effective-status rollup. When the final child ends, ordinary root visibility resumes.

### Visual hierarchy

- Primary roots retain the current full-size card treatment.
- Every subagent uses the existing dimmed subagent card and hollow-ring `sub` pill. A subagent in a resolved primary group also uses the violet spine and 44px indent.
- Nested descendants render in depth-first order directly after their immediate parent but flatten to the same single visual indent.
- Each child shows its own provider chip, model label, title, project suppression, effective status, and the row’s own status timer.
- An Evener child keeps the lime `E` chip because Evener is the observed session provider; its heterogeneous execution model appears in the model label.
- Native child cards never show an unread dot. Their results belong to the orchestrating parent, and the display-only card has no acknowledgement action.
- Missing or unsafe Paseo parentage places the child in the existing full-width orphan tail. Every orphan-tail card remains unindented and has no spine.
- The complete-graph view shows no descendant-number badge.

The browser mockup approved during design review showed an Evener parent followed by live child cards on `claude-opus-4.1`, `gpt-5.6-terra`, and `gemini-3-pro`, alongside an existing Paseo group. This textual contract, not the temporary companion file, is authoritative.

### Interaction

- Native and Evener child cards are display-only.
- A tap on a native child performs no route, flash, acknowledgement, or other mutation.
- A long press on a native child does not open the action sheet.
- Native child cards use a non-interactive cursor/touch treatment.
- Root cards keep their current tap and long-press behavior.
- Paseo subagent cards keep their current independent route and action-sheet behavior.

## Snapshot architecture

### Additive Xeneon graph

Snapshot schema version 2 gains an optional top-level `agents` field. The field is optional on the wire for deployment compatibility; the parser represents absence distinctly from a present empty graph.

```ts
export type AgentIdentity = {
  provider: Provider;
  sessionId: string;
};

export type ProjectedAgentNode = {
  provider: Provider;
  sessionId: string;
  role: "primary" | "subagent";
  lineage: "native" | "paseo" | null;
  parent: AgentIdentity | null;

  status: SessionStatus;
  title: string | null;
  project: string | null;
  model: string | null;
  openedAt: string;
  statusSince: string | null;
  activityLine: string | null;
  unreadSince: string | null;

  logicalSlot: number | null;
  ghosttyTerminalId: string | null;
  transcriptPath: string | null;
  originKind: SessionOriginKind | null;
  originRef: string | null;
  originSubagent: boolean;
  originParentRef: string | null;
};

export type SessionSnapshotV2 = {
  schemaVersion: 2;
  health: SnapshotHealth;
  sessions: ProjectedSession[];
  agents: ProjectedAgentNode[] | null;
};
```

The raw field is absent in old snapshots. `parseSessionSnapshot` returns `agents: null` when absent and a validated array when present. A new daemon always writes an array, including an empty array when no nodes are visible.

`ProjectedAgentNode` deliberately has no descendant count. The legacy `ProjectedSession.descendantCount` remains unchanged for the temporary Stream Deck projection.

### Node roles

- A visible ordinary registry root is `role: "primary"`, `lineage: null`, and `parent: null`.
- A provider-native child is `role: "subagent"`, `lineage: "native"`, and has a required same-provider parent identity.
- A Paseo subagent root is `role: "subagent"`, `lineage: "paseo"`, and has a resolved cross-provider parent identity when its unique origin lineage is safe.
- An unresolved, ambiguous, or cyclic Paseo subagent remains `role: "subagent"` and `lineage: "paseo"` with `parent: null`; the board treats it as an orphan rather than a primary.

Registry roots retain positive logical slots. Native children retain `logicalSlot: null`. Paseo subagents are registry roots and may retain their logical slot even though the Xeneon graph classifies them as subagents.

A native node also has `unreadSince: null`, no origin metadata, no transcript path, and no terminal binding. These are deliberate projection invariants: native children are live execution detail, not independently actionable or acknowledgeable sessions. Paseo nodes retain their existing root-row facts.

### Compatibility transition

The daemon produces `sessions` and `agents` from one read transaction and one validated projection pass.

- **New app + old daemon:** `agents` is absent. Xeneon uses the current `sessions` reducer as a temporary fallback, including its existing count behavior because no child identities are available.
- **Old app/plugin + new daemon:** the old parser reconstructs known fields and ignores the unknown top-level `agents` field.
- **New app + new daemon:** Xeneon uses `agents` exclusively and renders no count badges.

After the Stream Deck consumer is removed, a separate contract cleanup may make `agents` required and remove `sessions`, `descendantCount`, and the fallback. That cleanup is not part of this implementation.

## Registry and event flow

### Initial child model

`SubagentStart` gains `model: string | null`.

- Evener supplies the model parsed from the AppWire thread.
- Providers without an authoritative child model send null.
- Child insertion stores the model.
- A repeated child start may backfill a non-null model but never clears an existing model with null.

### Model changes

Add this registry event:

```ts
{
  kind: "SessionModelChanged";
  provider: Provider;
  sessionId: string;
  model: string;
  observedAt: string;
}
```

`SessionModelChanged` accepts a non-empty bounded model and updates only an existing row, regardless of whether that row is a root or child. It must never create membership or change role, parentage, status, unread state, timers, or the prune lease.

Evener child hydration emits this safe update after membership is established, and `thread/model/changed` no longer drops child notifications. Unchanged models are ignored by the registry difference guard. A null `SubagentStart` model never clears a stored model; the model-change event does not accept null.

If a child start is rejected because its parent is invalid or absent, the following model update is also ignored; it cannot accidentally create a top-level session.

## Projection

### One validated pass

Projection continues to validate every native registry edge before publishing anything:

- composite identities are unique;
- native parents exist under the same provider;
- native children have no logical slot or terminal binding;
- roots have positive logical slots;
- native topology is acyclic and completely reachable from roots.

The projection pass produces both:

1. the unchanged legacy root-only `sessions` list; and
2. the unified Xeneon `agents` graph.

Duplicated root facts in the two arrays come from the same intermediate root result. Tests assert that identity, display facts, effective status, and logical slot agree.

### Per-node effective status

Compute native subtree status bottom-up for every row, not only each root.

```text
error > waiting > working > idle
```

A native child row exists only while the child is live, so its projected status is at least `working` even when its stored status is `idle`. Each node takes the maximum of its own effective status and every child subtree. The result rolls upward through native edges and then through resolvable Paseo ancestry.

`statusSince` remains the row’s own last status transition. A subtree lift never restamps it.

The legacy root `descendantCount` remains the number of live provider-native descendants and does not begin counting Paseo cards. Xeneon does not consume this count when `agents` is present.

### Paseo parent resolution

Resolve Paseo parent refs to composite node identities only when `originRef` is unique. Missing or ambiguous refs produce a null graph parent.

Before publication, detect cycles in the resolved Paseo graph. Clear unsafe cycle edges so cycle participants become orphans; never emit a cyclic `agents` graph. Native registry cycles remain hard projection failures because the registry claims authoritative topology.

## Ordering and grouping

- Primary groups retain ascending positive `logicalSlot` order.
- Every node includes the registry’s existing `opened_at` timestamp as `openedAt`.
- Immediate children sort by `openedAt`, then provider, then session ID.
- The identity tie-breaker makes equal batch timestamps deterministic without a database migration.
- Traverse children depth-first in pre-order so each descendant follows its immediate parent.
- Render every descendant in a resolved primary group at one visual indent level.
- A top-level Paseo subagent may own native children; both stay in the nearest resolvable primary’s group.
- All orphans form one atomic tail block after ordinary groups. Parentless Paseo subagents are orphan roots, sorted by `openedAt` and composite identity. Traverse each orphan root’s still-safe child edges depth-first before the next orphan root, so native children of an orphan remain directly after that parent without violating deterministic root order. Render the whole tail full-width with no indent or spine.

The existing group-atomic packing rules remain unchanged. A group may span pages under the existing greater-than-12 rule. Page settings clamp when disappearing children reduce the page count.

## Xeneon reducer and rendering

When `snapshot.agents` is non-null, `reduceBoard` builds its groups from the graph. It does not attempt to reconstruct hierarchy from origin refs because the daemon has already resolved parent identities and removed unsafe edges.

Board card seeds carry whether the node is display-only. Rendering keeps the existing subagent anatomy and suppresses the descendant badge for every graph-backed card. Event wiring checks the display-only flag before scheduling tap or long-press behavior; it does not rely on CSS alone.

When `snapshot.agents` is null, the reducer uses the existing session-based grouping path for old-daemon compatibility.

## Failure handling

### Core projection failures

Any invalid native topology or corrupt row fails the whole read transaction. The daemon publishes its existing bounded unhealthy snapshot and diagnostic code; it never publishes a partial graph.

### External Paseo uncertainty

Missing, duplicate, or cyclic Paseo lineage is not evidence that otherwise valid registry rows are corrupt. Those active subagents remain visible as orphans.

### Wire failures

The parser validates:

- bounded field shapes and known enums;
- a non-empty canonical UTC `openedAt` timestamp for every node;
- unique composite node identities;
- role/lineage combinations;
- required same-provider parents for native children;
- existence of every non-null parent identity;
- legal logical-slot and terminal-binding combinations;
- absence of graph cycles.

An invalid graph rejects the snapshot. Xeneon retains and displays its last-good snapshot as degraded under the existing ten-second heartbeat contract.

### Interaction safety

Display-only child cards are rejected before click or long-press actions are constructed. They cannot acknowledge, clear, reveal, copy, route, or flash. A disappearing child invalidates a pending pointer identity through the existing identity re-resolution path.

## Testing

Implementation follows test-driven development.

### Protocol

- Missing `agents` parses as null.
- A valid mixed graph parses without changing `sessions`.
- Invalid identity, parent, role/lineage, slot, binding, and cycle cases reject.
- Old parsers ignore the additive field.

### Registry and providers

- `SubagentStart` stores and backfills a non-null model without null-clearing.
- `SessionModelChanged` updates existing root and child rows only.
- A model change for an unknown identity is ignored.
- Generic providers emit null child models where no source exists.

### Evener

- Hydration records each child model.
- Heterogeneous siblings retain distinct models.
- Child model-change notifications update the child.
- Nested children hydrate parent-first.
- Idle/closed child removal remains unchanged.
- An invalid/missing parent cannot be promoted by a facts update.

### Projection

- Mixed native and Paseo hierarchy produces one acyclic graph.
- Nested native status rolls up at every node and through Paseo ancestry.
- Live idle children project as working.
- Models, timestamps, and display facts survive projection.
- Native nodes publish `unreadSince: null` and no independent routing facts.
- Equal timestamps use deterministic identity ordering.
- Missing/ambiguous/cyclic Paseo lineage becomes orphaned.
- Native corruption still fails atomically.
- Legacy `sessions` remains unchanged and agrees with duplicate graph roots.

### Xeneon board and cards

- Primary groups retain logical-slot order.
- Mixed child types sort and traverse depth-first.
- Nested descendants flatten to one indent.
- Orphan roots sort deterministically, retain safe descendants in depth-first order, and render as one full-width unspined tail.
- Group packing and page clamping retain current behavior.
- Graph-backed cards show no descendant badge.
- Evener children show distinct model labels and status treatments.
- Old-daemon fallback retains current session behavior.

### Interaction

- Native child tap is a no-op.
- Native child long press never opens the action sheet.
- No acknowledgement, clear, route, flash, or deferred action fires.
- Root and Paseo interactions remain unchanged.

### Gates

Run focused tests during implementation, then the required full gate:

```sh
bun run check
```

A gate counts only when it exits zero.

## Documentation

Implementation updates the living Xeneon contract in `docs/design.md` and the repository guidance in `AGENTS.md` if its summary becomes stale. Existing dated specs and verification records remain untouched.

## Approved decisions

- Xeneon shows every live subagent.
- Evener uses the same visual tree concept as Paseo.
- Native and Evener child cards are display-only.
- Finished child cards disappear; there is no history.
- Nested descendants flatten to one visual indent.
- The complete graph shows no count badge.
- There is no automatic collapse threshold.
- The Xeneon graph is additive during the short Stream Deck transition.
