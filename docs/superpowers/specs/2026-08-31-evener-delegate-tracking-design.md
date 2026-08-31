---
topic: 2026-08-31-evener-delegate-tracking
status: ratified           # draft | ready | ratified | paused | abandoned | completed
activation_amendment: ready # ready | ratified
created: 2026-08-31
---

# Evener delegate tracking and exact-session activation

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
The tracking repair changes the Evener collector and authoritative cleanup path,
not the published snapshot or board layout. The activation repair adds a
provider-specific route for already-interactive Evener root cards without making
native child cards interactive.

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
- Pressing an active Evener root card opens the Evener web frontend at that
  exact session, even when another Evener session is already open.
- If exact activation cannot be constructed or launched, the app flashes and
  Stream Deck shows its activation alert. Neither surface falls back to opening
  Evener at its root or current session.

## Non-goals

- No persistent stable-delegate history or generation browser.
- No card for an idle/resumable delegate without an active child run.
- No job cards; Evener jobs and delegates remain distinct resources.
- No snapshot-v2, registry-table, Stream Deck, or Xeneon layout redesign.
- No change to native-child interaction: native Evener child cards remain
  display-only, and the deprecated Stream Deck layout remains top-level only.
- No direct reads of Evener's private state files. AppWire remains the only
  production integration.
- No protocol-version bump: the required fields and notifications are part of
  the current AppWire v3 contract.
- No invented AppWire activation mutation. The current supported external
  activation contract is the Evener browser route.

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

## Exact-session activation

The tracked application currently has no Evener activation binding. An app
press reaches `routeForSession` and returns `flash`; a Stream Deck press reaches
the controller's unbound-provider branch and shows an alert. No Evener ref is
sent to AppWire, with or without `threadId`.

Evener exposes no AppWire focus, open, or navigate mutation. Its supported
external target is the canonical browser route:

```text
/s/{encodeURIComponent("local:" + sessionId)}
```

A live `evener/navigation/read` with `{resource: "location", ref}` confirmed
that the current hub resolves both root `local:<root sessionId>` and child
`local:<child sessionId>` refs. The shared `thread/list` workspace ref is not an
activation identity for a child. Current native child cards are display-only,
so this repair activates only the root card's `sessionId`; if child interaction
is added later, it must use the child's canonical transcript ref rather than the
shared list ref.

### One activation boundary

Both app and Stream Deck invoke one installed CLI contract:

```text
dealerboard sessions activate evener <session-id>
```

The core Evener endpoint resolver is split so address normalization is shared,
while authentication remains collector-only:

- one resolver normalizes the configured hub address into the loopback AppWire
  endpoint and browser origin;
- the collector adds the bearer token to its in-memory AppWire connection; and
- activation reads no token and never puts one in a URL, argument, diagnostic,
  or child-process environment.

The activation command maps `ws` to `http` and `wss` to `https`, replaces the
AppWire `/rpc` path with `/s/<encoded canonical ref>`, clears query and fragment,
then launches `/usr/bin/open -u <url>` with fixed argv and no shell. It must not
append `/s/...` to `/rpc`: that is the RPC endpoint, not the frontend base.
Configured loopback hosts and ports follow the same normalization as the
collector, including `0.0.0.0` to `127.0.0.1`.

The app route table gains an Evener-specific route carrying `sessionId` rather
than a prebuilt hard-coded URL. `pressSessionTile` keeps its existing causal
`view_session` fire-and-forget call, then invokes a Tauri
`activate_evener_session` command. Tauri runs the installed CLI with the fixed
activation argv. The Stream Deck controller gains an Evener activation port,
wired by the plugin to the same installed CLI command; its existing ack remains
fire-and-forget before activation.

### Upstream deep-link prerequisite

Live reproduction found a separate Evener frontend race: a full-page load of a
valid `/s/<ref>` remains on `Welcome` / `No session open`, while selecting that
same ref from the loaded rail opens the session and produces the same URL.
AppWire location lookup itself succeeds. On a production boot the AppShell can
render while navigation mode is still `unknown`; its location effect returns,
but it does not subscribe to the later `v1` mode transition, so the lookup is
never retried. Existing deep-link tests preload navigation mode or location and
do not exercise that sequence.

The paired Evener repair makes AppShell observe navigation mode and performs the
pending location lookup when mode becomes `v1`. Its regression test must start
with unknown mode, complete the real initialize-capability transition, resolve
the location read asynchronously, and assert that the requested session pane is
opened. Dealerboard's live exact-activation acceptance is blocked until a hub
containing that fix is running; opening a generic hub page is not an acceptable
workaround.

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

The internal `EvenerCollectorUpdate` gains
`activeChildSessionIds: readonly string[] | null`. A non-null value is the
complete authoritative set from a valid refresh; `null` marks a live incremental
update that must not perform omission-based cleanup. This field remains inside
the daemon/registry integration and is not added to the shared snapshot
protocol. The CLI applies one update through `applyEvenerCollectorUpdate`, a
registry function that:

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
- **Unusable configured Evener address or malformed session identity:** activation
  exits non-zero without launching a URL. The app flashes once and Stream Deck
  alerts once; neither opens a generic hub URL.
- **Browser launch failure:** propagate the non-zero activation result to the
  calling surface's existing failure feedback. The earlier view/ack gesture is
  not rolled back.
- **Session closes after the snapshot:** still launch the exact canonical route.
  Evener owns its unavailable-session presentation; Dealerboard must not guess a
  replacement or activate the current session.
- **Hub without reliable initial deep links:** fail live acceptance rather than
  claim exact activation. There is no AppWire mutation fallback.
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
- Existing Claude, Codex, Kimi, Paseo, and unbound-provider routes are unchanged.
- Existing custom loopback Evener addresses and ports apply equally to
  collection and activation; activation does not require or expose the bearer
  token.
- Evener root cards become exactly activatable on app and Stream Deck. Native
  child cards remain display-only and snapshot fields remain unchanged.
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
- [ ] **Exact root activation:** an Evener root press launches the configured
      frontend at `/s/<encoded local:sessionId>` through the shared CLI boundary.
  - Acceptance: app and Stream Deck presses for session A activate A while
    Evener is showing B; neither uses the shared list ref or opens the hub root.
- [ ] **Contained activation failure:** unusable configured address, invalid
      identity, process failure, and browser-launch failure use existing surface
      feedback.
  - Acceptance: app flashes once or Stream Deck alerts once, and no fallback URL
    is launched.
- [ ] **Cold deep-link reliability:** a fresh Evener frontend resolves a valid
      exact route after navigation capability initialization.
  - Acceptance: an upstream test begins in unknown navigation mode, resolves the
    location asynchronously, and opens the requested pane; a live cold-load
    smoke does the same.

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

Add activation coverage in Dealerboard:

- `test/strip-routing.test.ts`: Evener returns the Evener-specific route with the
  exact session ID; all existing provider routes remain unchanged.
- `test/press.test.ts`: an Evener root views then activates; activation failure
  flashes exactly once; native Evener children remain display-only.
- `test/controller.test.ts`: an Evener key press acks then invokes its Evener
  activation port with the exact session ID; failure alerts exactly once; the
  old unbound-provider table no longer includes Evener.
- `test/evener.test.ts`: address normalization produces separate AppWire and web
  endpoints; canonical refs are encoded; `/rpc/s/...`, tokens, queries, and
  fragments never enter the activation URL.
- `test/cli.test.ts`: exact activation grammar, fixed `/usr/bin/open -u` argv,
  custom loopback address, invalid input, and non-zero launch propagation.
- Tauri unit tests: `activate_evener_session` constructs only the fixed installed
  binary argv and reports a non-zero child result.

Add the paired upstream Evener test in `frontend/src/shell/AppShell.test.tsx`:

- start a full `/s/<ref>` load with navigation mode unknown;
- let initialization advertise navigation v1;
- assert one location read for the exact ref; and
- resolve it and assert the requested root or nested pane replaces the welcome
  fallback.

### Verification gates

1. Run focused Evener collector, registry, CLI, projection, protocol, and board
   tests.
2. Run `bun run check`.
3. Run a sanitized live-hub smoke while a nested delegate is active:
   compare AppWire `sessionId`/delegate parentage with Dealerboard's published
   `snapshot-v2.json` after two refresh intervals. No raw prompts, tokens, or
   credentials may be captured.
4. With Evener showing session B, press session A in the app and on Stream Deck;
   verify the browser route and visible pane are A. Repeat from a fresh browser
   load. Record no token-bearing URL or capture.

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
- **Open the Evener hub root.** Rejected because it reproduces the reported bug:
  the user sees whichever session Evener already has open, not the pressed one.
- **Hard-code `127.0.0.1:9180` in both UI clients.** Rejected because it ignores
  supported hub configuration and duplicates routing logic.
- **Append the route to the AppWire URL.** Rejected because `/rpc` is the
  WebSocket endpoint; `/rpc/s/...` is not a frontend route.
- **Send the bearer token in the activation URL.** Rejected because browser auth
  state owns web access and URLs leak through history, process inspection, and
  logs.
- **Add an unsupported AppWire focus method.** Rejected because no such current
  contract exists; the canonical browser route is the supported boundary.
- **Ship Dealerboard URL launching without repairing the cold-load race.**
  Rejected because opening a syntactically exact URL that leaves `Welcome`
  visible does not satisfy exact activation.

## Existing-data impact and rollback

There is no schema migration. On the first complete successful refresh after
deployment, stale Evener child rows may be removed; this is the intended repair.
Evener root rows and unrelated providers are unchanged. Activation adds a CLI
verb and app/plugin wiring but persists no new data. The paired Evener frontend
repair changes no URL or AppWire contract.

Rollback is a code revert. Because no new persisted columns or snapshot fields
exist, rollback requires no data migration. Rows already removed as stale active
children are recreated by the old collector only if it can observe them.

## Observability

Use the existing fixed `evener_collector_failed` diagnostic for bounded failure
containment. Tests may inspect retry scheduling and state, but production logs
must not add raw AppWire frames. If implementation needs additional diagnosis,
add fixed reason codes (for example candidate identity invalid, ambiguous
notification, or activation launch failed) without session content or
credentials. Activation failures reach the app/Stream Deck through their
existing flash/alert behavior; never log a token or token-bearing URL.

## Golden-question checklist

- [x] Data migration / existing-data impact: no schema migration; first valid
      refresh removes stale Evener child rows only.
- [x] Auth / permissions: AppWire bearer capability remains collector-only and
      held in memory; browser activation uses existing browser auth state.
- [x] Failure / retry behavior: last-known-good state; no cleanup from partial
      refreshes; ambiguous notifications refresh instead of guessing.
- [x] Rollback path: code revert in Dealerboard and the paired Evener frontend;
      no stored schema, AppWire, URL, or snapshot version change.
- [x] Observability / logging: fixed sanitized diagnostics; no thread content or
      bearer token.
- [x] Visual regression surface: no layout change; existing active-child cards
      and recursive grouping remain the contract. Activation is behavioral.
- [x] Concurrency: notification-invalidated refresh generations prevent stale
      async read results from overwriting newer lifecycle state.
- [x] Security: only supported authenticated AppWire data is consumed; private
      state files and raw payload logging remain prohibited; activation reads no
      bearer token and launches fixed argv without a shell.

## Fixed implementation boundaries

- Authoritative child reconciliation is carried only by the internal
  `EvenerCollectorUpdate`; it is not a generic `RegistryEvent` and does not enter
  the published protocol.
- A targeted read race discards and restarts the complete candidate refresh.
  Per-session retry must not produce a mixed-generation candidate.
- Exact activation is rooted in `sessionId` and the canonical browser route. It
  never uses a shared list ref, generic hub fallback, or invented AppWire method.
- Dealerboard and Evener cold-load fixes are both required before exact-session
  activation can be marked complete.
