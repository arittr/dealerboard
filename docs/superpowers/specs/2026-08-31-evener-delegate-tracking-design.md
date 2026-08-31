---
topic: 2026-08-31-evener-delegate-tracking
status: ready              # draft | ready | ratified | paused | abandoned | completed
created: 2026-08-31
---

# Evener delegate tracking: separate workspace routing, run identity, and stable lineage

## Goal

Restore correct Evener child tracking after Evener changed read-only descendant
aliases to share their root's stable workspace `ref`.

Dealerboard will consume the current supported AppWire v3 identity model:

- `ref` identifies the workspace transport route;
- `sessionId` / `threadId` identifies one root or child run;
- `delegateId` identifies a stable delegate across run generations; and
- delegate diagnostics identify ownership and nested delegate lineage.

Dealerboard's visible contract remains intentionally simple: the board shows
active child runs. It does not show dormant stable delegates or delegate history.
The repair changes the Evener collector and authoritative cleanup path, not the
published snapshot or board UI.

## Confirmed root cause

Evener commit `7c5dd61f6` (2026-08-28) changed local read-only descendant aliases
to use their root's stable workspace ref. A live AppWire probe confirmed this
shape:

- root and child have distinct `sessionId` values;
- child `evener.ref` equals the root `evener.ref`;
- child `evener.parentRef` also names that root workspace ref;
- `thread/read` with only `ref` returns the root; and
- `thread/read` with `ref` plus the child's `threadId` returns the child.

Dealerboard currently keys `states` and `subscribed` by `ref`, reads by `ref`
only, resolves parents through `states.get(parentRef)`, and ignores the
notification `threadId`. The resulting behavior depends on list order:

- one alias overwrites another in collector state;
- root state may leak into child hydration or the reverse;
- the root subscription suppresses child subscriptions;
- child notifications may update or close the root; and
- nested linkage cannot be recovered from the shared ref.

Evener also now publishes a stable delegate projection in
`thread.evener.diagnostics.delegates` and through
`evener/delegate/updated`. Its supported fields include `delegateId`,
`ownerSessionId`, `rootSessionId`, `childSessionId`, `parentDelegateId`,
`lifecycle`, `phase`, `status`, `terminal`, `resumable`, `needsAttention`,
`model`, and `projectionRevision`.

## User-visible contract

- A non-terminal child run appears under its correct active parent.
- A nested child appears under its immediate parent run, not merely under the
  root workspace.
- Root and child status, title, model, attention, completion, and failure
  updates affect only the targeted session.
- When a child run becomes inactive or terminal, its card disappears.
- When a stable delegate starts a replacement run, the old run disappears and
  the new run appears without a duplicate or ghost.
- Closing a root removes all descendant cards even if unread output causes the
  root card itself to remain.
- Dormant but resumable delegates do not get cards. Delegate history is not
  added to the snapshot.

## Non-goals

- No persistent stable-delegate history or generation browser.
- No card for an idle/resumable delegate without an active child run.
- No job cards; Evener jobs and delegates remain distinct resources.
- No snapshot-v2, registry-table, Stream Deck, or Xeneon layout redesign.
- No direct reads of Evener's private state files. AppWire remains the only
  production integration.
- No protocol-version bump: the required fields and notifications are part of
  the current AppWire v3 contract.

## Identity model

The collector will use four separate indices rather than overloading `ref`:

```text
statesBySessionId:       sessionId -> EvenerThreadState
sessionIdsByRef:         ref -> set<sessionId>
delegatesById:           delegateId -> EvenerDelegateInfo
delegateByChildSession:  childSessionId -> delegateId
subscribedSessionIds:    set<sessionId>
```

`EvenerThreadState` keeps `sessionId` and `ref` as independent required fields.
It may also carry a resolved `delegateId` and `parentSessionId`, but those are
recomputed from each complete refresh rather than inferred from ref equality.

### Parent resolution

For a child with a stable delegate projection:

1. If `parentDelegateId` is present, find that delegate and use its
   `childSessionId` as the immediate parent session.
2. Otherwise use `ownerSessionId` as the parent session.
3. Require the resolved parent session to exist in the same complete candidate
   snapshot before publishing the child.

For an older hub without delegate diagnostics, preserve the old unique-ref
behavior: resolve `parentRef` only when it names exactly one candidate state.
A shared or otherwise ambiguous parent ref is never guessed.

## Refresh and subscription data flow

A refresh is an all-or-nothing candidate build:

1. Page `thread/list` with `includeSubagents: true` and the existing bounded
   page/item limits.
2. Parse all local rows into a candidate map keyed by `sessionId`. Reject
   duplicate session IDs or malformed identity/status fields.
3. For every live candidate, call `thread/read` with both:

   ```json
   {
     "ref": "<workspace ref>",
     "threadId": "<session id>",
     "includeTurns": false,
     "subscribe": true
   }
   ```

   The first read replaces the socket subscription; later reads extend it.
   Subscription bookkeeping is keyed by session ID.
4. Merge each returned thread by its returned `sessionId`, and collect stable
   delegate projections from `evener.diagnostics.delegates`.
5. Resolve parent links from delegate projections, falling back to an
   unambiguous legacy `parentRef` only when stable metadata is absent.
6. Derive the active-child set using Dealerboard's existing child visibility
   semantics. Closed, not-loaded, terminal, and settled idle children are not
   active cards.
7. Build registry events and authoritative active-child reconciliation from the
   same candidate state.
8. Atomically replace collector indices and emit the update only after every
   candidate and parent edge validates.

A lifecycle notification arriving during an asynchronous refresh invalidates
that candidate generation. The notification applies to the last known-good
state when it has an unambiguous `threadId`, and the collector immediately
re-runs refresh. This prevents an older read response from overwriting a newer
notification.

## Notification routing

`stateForParams` becomes session-first:

1. Read `threadId` from notification params and look up
   `statesBySessionId`.
2. If no `threadId` is present, allow `ref` fallback only when
   `sessionIdsByRef.get(ref)` has exactly one member.
3. Otherwise do not mutate or emit an event; request an immediate refresh.

`thread/started`, `thread/closed`, status, turn, name, model, attention, and
escalation handlers all use this one resolver. A returned or embedded thread is
parsed by its own `sessionId`, never by the notification's shared ref.

`evener/delegate/updated` is accepted as supported topology/lifecycle input. It
updates no registry edge directly: it invalidates the current candidate and
triggers an immediate complete refresh, so parent changes and generation
replacement use the same transactional reconciliation path as reconnect.

## Authoritative registry reconciliation

The collector update gains an optional authoritative Evener reconciliation
payload containing the complete set of child session IDs that should currently
exist. The CLI applies one update through a registry function that:

1. applies the accompanying registry events;
2. deletes Evener child rows absent from the authoritative active-child set;
3. leaves all top-level Evener rows untouched; and
4. commits both operations in one SQLite transaction.

Reconciliation is emitted only after a complete valid refresh. A timeout,
disconnect, malformed page, page/item limit breach, read failure, ambiguous
parent, or candidate invalidated by a concurrent lifecycle notification cannot
carry authoritative cleanup.

This cleanup repairs stale children left by an earlier daemon process or by the
old ref-collision bug. It is intentionally provider- and role-scoped:
`provider = 'evener' AND parent_session_id IS NOT NULL`. Other providers and
Evener roots are outside its mutation boundary.

## Close and replacement behavior

A child close removes that session from all collector indices, emits
`SubagentStop` once, and lets the next complete refresh confirm reconciliation.

A root close walks the resolved session-parent graph depth-first. It emits one
`SubagentStop` for every descendant before `SessionEnd` for the root, then
removes the whole subtree from collector indices and subscription bookkeeping.
The explicit child events are required because an unread root can be retained
in the registry, preventing the schema's foreign-key cascade from running.

When one `delegateId` changes from child session A to child session B, a complete
refresh resolves B as active. Its authoritative active set excludes A and
includes B. The registry transaction removes A and starts B without persisting
the stable delegate as a separate card.

## Failure and retry behavior

- **Malformed or contradictory identity:** reject the candidate refresh, retain
  last-known-good state, report the collector's bounded failure diagnostic, and
  reconnect or retry through the existing scheduler.
- **Ambiguous ref-only notification:** make no session mutation and schedule an
  immediate refresh. Never choose the first matching alias.
- **List/read race:** if a listed thread closes before its targeted read, discard
  the candidate and refresh; do not use a root response as the child.
- **Partial pagination or read failure:** no state swap and no authoritative
  cleanup.
- **Unknown delegate notification:** schedule refresh. Do not synthesize a
  session from an incomplete notification.
- **Diagnostic sink or registry-update failure:** preserve existing containment;
  neither may unwind daemon startup. A failed transaction commits neither
  events nor cleanup.
- **Secrets and content:** never log the bearer token, raw thread bodies, turn
  content, or complete delegate payloads. Fixed diagnostic codes remain the
  observable failure surface.

## Backward compatibility

- Current AppWire v3 shared-ref aliases work through `threadId`-targeted reads
  and session-keyed state.
- Older unique-ref v3 rows work through the same primary session map.
- Ref-only notifications remain supported when exactly one session owns the
  ref.
- Older hubs without stable delegate diagnostics retain direct-child linkage
  through unique `parentRef` values.
- Ambiguous nested linkage on an older/mixed hub is withheld and retried rather
  than flattened or attached incorrectly.
- Registry rows, projected agents, snapshot JSON, app parsing, Xeneon grouping,
  and the deprecated top-level Stream Deck layout retain their current schema
  and behavior.

## Requirements and acceptance criteria

- [ ] **Unique run identity:** collector state, previous-state carryover,
      deletion, and subscription bookkeeping use `sessionId`, never `ref`.
  - Acceptance: root, child, and grandchild sharing one ref all survive either
    list order as separate states and cards.
- [ ] **Targeted reads:** every `thread/read` carries both `ref` and `threadId`.
  - Acceptance: a fixture where ref-only read returns the root still hydrates
    the requested child.
- [ ] **Safe notification routing:** `threadId` wins; ref fallback must be
      unique.
  - Acceptance: a child status/completion notification changes or removes only
    that child; ambiguous ref-only notifications emit nothing and refresh.
- [ ] **Supported nested lineage:** stable delegate diagnostics determine
      immediate parents.
  - Acceptance: a nested delegate links to its parent delegate's child session,
    not directly to the root.
- [ ] **Generation replacement:** stable delegate run replacement leaves one
      current child card.
  - Acceptance: session A disappears and session B appears in one registry
    transaction, without a stale or duplicate node.
- [ ] **Restart-safe cleanup:** complete refresh is authoritative for Evener
      child rows.
  - Acceptance: stale children from a previous collector process disappear;
    partial/failed refreshes delete nothing.
- [ ] **Retained-root cleanup:** root close explicitly stops descendants.
  - Acceptance: an unread retained root has no remaining child rows after close.
- [ ] **Compatibility:** legacy unique-ref fixtures remain green and no
      published schema changes.

## Test plan

### Collector tests

Extend `test/evener.test.ts` with captured, sanitized current-schema fixtures:

- root/child/grandchild share one ref and appear in both root-first and
  child-first list order;
- reads are targeted by `threadId` and all sessions receive subscriptions;
- returned read identity must match the requested session;
- status, turn, title, model, close, escalation, and started notifications route
  by child `threadId`;
- ambiguous ref-only notifications schedule refresh without mutation;
- delegate diagnostics resolve direct and nested parent sessions;
- `evener/delegate/updated` invalidates and refreshes topology;
- a stable delegate changes child session A to B;
- notification-during-refresh invalidates the stale candidate;
- root close emits descendant stops recursively; and
- legacy unique-ref/ref-only fixtures continue to pass.

### Registry and CLI tests

Add tests proving authoritative reconciliation:

- event application and stale-child deletion are atomic;
- cleanup is limited to Evener child rows;
- Evener roots and every other provider remain untouched;
- no authoritative payload means no omission-based cleanup;
- a thrown event or cleanup operation rolls back the whole update; and
- daemon wiring applies the collector update through the new transactional
  function.

### Projection and app regression tests

Existing generic nested-agent projection, protocol validation, and recursive
board grouping tests remain the downstream contract. Add a focused end-to-end
fixture only if the collector/registry tests cannot prove that A-to-B generation
replacement produces the expected snapshot graph.

### Verification gates

1. Run focused Evener collector, registry, CLI, projection, protocol, and board
   tests.
2. Run `bun run check`.
3. Run a sanitized live-hub smoke while a nested delegate is active:
   compare AppWire `sessionId`/delegate parentage with Dealerboard's published
   `snapshot-v2.json` after two refresh intervals. No raw prompts, tokens, or
   credentials may be captured.

## Alternatives considered

- **Keep keying by ref and special-case children.** Rejected because ref is
  intentionally shared transport identity. Any order or suffix workaround
  would continue to misroute reads and notifications.
- **Require only the newest schema and remove ref-only compatibility.** Rejected
  because supporting an unambiguous legacy notification is cheap and does not
  weaken current routing.
- **Use delegate projections as the persistent card identity.** Rejected for
  this repair because dormant/resumable delegates and generation history need a
  separate product model. Stable metadata is consumed for active-run linkage,
  not exposed as a new card type.
- **Fix session identity but ignore delegate diagnostics.** Rejected because
  shared `parentRef` cannot express immediate nested lineage, leaving a known
  integration defect.
- **Rely on periodic registry prune for ghosts.** Rejected because it is delayed,
  cannot express authoritative generation replacement, and does not repair an
  unread retained root promptly.
- **Read Evener private state files.** Rejected because AppWire now exposes the
  required supported identity and lifecycle contract.

## Existing-data impact and rollback

There is no schema migration. On the first complete successful refresh after
deployment, stale Evener child rows may be removed; this is the intended repair.
Evener root rows and unrelated providers are unchanged.

Rollback is a code revert. Because no new persisted columns or snapshot fields
exist, rollback requires no data migration. Rows already removed as stale active
children are recreated by the old collector only if it can observe them.

## Observability

Use the existing fixed `evener_collector_failed` diagnostic for bounded failure
containment. Tests may inspect retry scheduling and state, but production logs
must not add raw AppWire frames. If implementation needs additional diagnosis,
add fixed reason codes (for example candidate identity invalid or ambiguous
notification) without session content or credentials.

## Golden-question checklist

- [x] Data migration / existing-data impact: no schema migration; first valid
      refresh removes stale Evener child rows only.
- [x] Auth / permissions: unchanged AppWire bearer capability, held in memory.
- [x] Failure / retry behavior: last-known-good state; no cleanup from partial
      refreshes; ambiguous notifications refresh instead of guessing.
- [x] Rollback path: code revert; no stored schema or snapshot version change.
- [x] Observability / logging: fixed sanitized diagnostics; no thread content or
      bearer token.
- [x] Visual regression surface: none by design; existing active-child cards and
      recursive grouping remain the contract.
- [x] Concurrency: notification-invalidated refresh generations prevent stale
      async read results from overwriting newer lifecycle state.
- [x] Security: only supported authenticated AppWire data is consumed; private
      state files and raw payload logging remain prohibited.

## Open implementation details

- Whether the authoritative active-child set is carried as a dedicated internal
  collector update type or a provider-scoped registry event. It must remain an
  internal daemon/registry contract and must be applied atomically with events.
- Whether a targeted read race retries the one session or restarts the complete
  candidate. The observable rule is fixed: no partial swap or cleanup.
