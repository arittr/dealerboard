# Xeneon Live Subagent Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish every live provider-native and Paseo subagent in an additive snapshot graph and render that graph on Xeneon as a safe, depth-first, single-indent tree with each child’s own model, title, status, and timer.

**Architecture:** Keep the legacy root-only `sessions` projection intact for Stream Deck while adding a normalized `agents` graph to snapshot schema version 2. Build both arrays from one validated registry pass, then let the Xeneon reducer consume daemon-resolved composite parent identities; old-daemon snapshots continue through the existing `sessions` fallback. Carry an explicit `displayOnly` bit into board cards and reject native-card interaction before press or action-sheet work is constructed.

**Tech Stack:** Bun, TypeScript with strict compiler flags, `bun:sqlite`, Tauri webview DOM/CSS, Bun test, Biome.

**Spec:** `docs/superpowers/specs/2026-08-25-xeneon-live-subagent-tree-design.md`

## Global Constraints

- Keep session snapshot `schemaVersion: 2`; `agents` is additive and optional on raw old-daemon JSON, but `parseSessionSnapshot` must normalize absence to `agents: null`.
- A new daemon always publishes `agents` as an array, including `[]` in bounded unhealthy snapshots and when no nodes are visible.
- Keep legacy `sessions` and `ProjectedSession.descendantCount` unchanged for Stream Deck; the plugin must continue reducing only `sessions`.
- Do not add a database migration: `active_sessions` already stores `parent_session_id`, `model`, and `opened_at`.
- Preserve status priority exactly: `error > waiting > working > idle`; a live native child has a `working` floor, and subtree lifts never restamp `statusSince`.
- Preserve root admission, unread, native-only descendant counts, group-atomic packing, paging/clamping, heartbeat degradation, and rail unread semantics.
- Native graph nodes publish `unreadSince: null`, `logicalSlot: null`, no terminal binding, no transcript path, and no origin metadata; native cards are display-only.
- Paseo subagents remain independently actionable and retain their existing root-row routing facts and logical slots.
- Sort immediate children by `openedAt`, then provider, then session ID; traverse depth-first pre-order and render all resolved descendants at one 44px visual indent.
- Clear every parent edge owned by a Paseo cycle participant, making every cycle participant an orphan; missing and ambiguous Paseo refs are also orphans rather than projection failures.
- Native topology corruption remains an atomic projection failure; never publish a partial graph.
- Do not change card geometry, rail content, status colors, page packing, or Stream Deck rendering.
- Keep native tap and long press mutation-free: no ack, route, flash, sheet, reveal, copy, or clear.
- Update `docs/design.md` and `AGENTS.md`; do not edit dated files under `docs/superpowers/specs/` or `docs/verification/`.
- Every focused and full gate counts only when it exits zero; the final required gate is `bun run check`.

## File and Interface Map

- `src/protocol.ts` owns `RegistryEvent`, `AgentIdentity`, `ProjectedAgentNode`, normalized `SessionSnapshotV2`, and graph wire validation.
- `src/core/registry.ts` owns child model persistence and the update-only `SessionModelChanged` mutation.
- `src/core/providers.ts` normalizes generic provider child starts with `model: null`.
- `src/core/evener.ts` extracts AppWire child models, emits parent-first membership followed by safe model updates, and accepts child model-change notifications.
- `src/core/projection.ts` validates all native rows once, computes per-node effective status, resolves safe Paseo parents, and produces both `sessions` and `agents`.
- `src/core/daemon.ts`, `src/plugin/snapshot-reader.ts`, and `app/src/snapshot-view.ts` own healthy/unhealthy/empty normalized snapshot constructors.
- `app/src/board.ts` owns old-daemon session grouping, new graph grouping, unchanged packing, and the explicit card interaction/badge contract.
- `app/src/cards.ts` owns graph badge suppression, child presentation, and the display-only CSS class.
- `app/src/tile-identity.ts` owns immediate and deferred interactive-card resolution.
- `app/src/main.ts` owns tap and long-press event wiring and must use those resolvers before constructing actions.
- `src/plugin/layout.ts`, `app/src/routing.ts`, `app/src/press.ts`, and `app/src/action-sheet.ts` accept the shared board-session shape without changing legacy behavior.
- `app/styles.css` owns the minimal non-interactive cursor treatment; all card geometry remains unchanged.

---

### Task 1: Persist Child Models and Add Update-Only Model Events

**Files:**
- Modify: `src/protocol.ts:30-90`
- Modify: `src/core/registry.ts:64-76,358-403,493-523`
- Modify: `src/core/providers.ts:330-345`
- Modify: `src/core/evener.ts:535-545`
- Modify: `test/registry.test.ts:64-76` and the `applyRegistryEvents` suite
- Modify: `test/providers.test.ts:353-430`
- Modify: `test/protocol.test.ts:334-387`
- Modify: `test/cli.test.ts:990-1015`
- Modify: `test/projection.test.ts:627-760`

**Interfaces:**
- Consumes: existing `active_sessions.model`, the existing 256-code-point wire bound, and `applyRegistryEvents(db, events)` transaction ordering.
- Produces: required `SubagentStart.model: string | null` and `{ kind: "SessionModelChanged"; provider; sessionId; model; observedAt }`.

- [ ] **Step 1: Extend the registry test fixture and write failing child-model tests**

Update `subStart` in `test/registry.test.ts` so every child start carries the required model:

```ts
const subStart = (
  sessionId: string,
  parentSessionId: string,
  options: {
    provider?: Provider;
    title?: string | null;
    project?: string | null;
    model?: string | null;
    at?: string;
  } = {},
): Extract<RegistryEvent, { kind: "SubagentStart" }> => ({
  kind: "SubagentStart",
  provider: options.provider ?? "claude",
  sessionId,
  parentSessionId,
  title: options.title ?? null,
  project: options.project ?? null,
  model: options.model ?? null,
  observedAt: options.at ?? at(1),
});
```

Add these tests to the `applyRegistryEvents` suite:

```ts
test("stores and backfills a child model without null-clearing it", () => {
  applyRegistryEvents(db, [start("parent"), subStart("child", "parent", { model: "model-a", at: at(2) })]);
  expect(getRow("child")?.model).toBe("model-a");

  applyRegistryEvents(db, [subStart("child", "parent", { model: null, at: at(3) })]);
  expect(getRow("child")?.model).toBe("model-a");

  applyRegistryEvents(db, [subStart("child", "parent", { model: "model-b", at: at(4) })]);
  expect(getRow("child")?.model).toBe("model-b");
});

test("SessionModelChanged updates only model on existing roots and children", () => {
  applyRegistryEvents(db, [start("root", { model: "root-a", at: at(1) }), subStart("child", "root", { at: at(2) })]);
  const rootBefore = getRow("root");
  const childBefore = getRow("child");
  if (rootBefore === null || childBefore === null) {
    throw new Error("model-change fixtures must exist");
  }

  expect(
    applyRegistryEvents(db, [
      { kind: "SessionModelChanged", provider: "claude", sessionId: "root", model: "root-b", observedAt: at(3) },
      { kind: "SessionModelChanged", provider: "claude", sessionId: "child", model: "child-b", observedAt: at(4) },
    ]),
  ).toEqual(["applied", "applied"]);

  expect(getRow("root")).toEqual({ ...rootBefore, model: "root-b" });
  expect(getRow("child")).toEqual({ ...childBefore, model: "child-b" });
});

test("SessionModelChanged ignores unknown, unchanged, empty, and oversized models", () => {
  applyRegistryEvents(db, [start("root", { model: "stable", at: at(1) })]);
  expect(
    applyRegistryEvents(db, [
      { kind: "SessionModelChanged", provider: "claude", sessionId: "missing", model: "new", observedAt: at(2) },
      { kind: "SessionModelChanged", provider: "claude", sessionId: "root", model: "stable", observedAt: at(3) },
      { kind: "SessionModelChanged", provider: "claude", sessionId: "root", model: "", observedAt: at(4) },
      {
        kind: "SessionModelChanged",
        provider: "claude",
        sessionId: "root",
        model: "m".repeat(257),
        observedAt: at(5),
      },
    ]),
  ).toEqual(["ignored", "ignored", "ignored", "ignored"]);
  expect(getRow("root")?.model).toBe("stable");
});

test("a facts update cannot promote a child whose start had no valid parent", () => {
  expect(
    applyRegistryEvents(db, [
      subStart("orphan", "missing", { model: "child-model", at: at(1) }),
      { kind: "SessionModelChanged", provider: "claude", sessionId: "orphan", model: "child-model", observedAt: at(2) },
    ]),
  ).toEqual(["ignored", "ignored"]);
  expect(getRow("orphan")).toBeNull();
});
```

- [ ] **Step 2: Update protocol/provider expectations and run the focused red tests**

In `test/providers.test.ts`, require `model: null` in every decoded `SubagentStart`. In `test/protocol.test.ts`, add `model: null` to the child start and add this union member:

```ts
{
  kind: "SessionModelChanged",
  provider: "evener",
  sessionId: "s2",
  model: "gpt-5.6-terra",
  observedAt,
},
```

Update the expected event-kind list to include `SessionModelChanged`. Add `model: null` to normalized `SubagentStart` literals in `test/cli.test.ts` and `test/projection.test.ts`.

Run:

```sh
bun test test/registry.test.ts test/providers.test.ts test/protocol.test.ts
```

Expected: FAIL because the event union and registry mutation do not yet support child models or `SessionModelChanged`.

- [ ] **Step 3: Add the normalized event shapes and generic-provider null model**

Change the `RegistryEvent` members in `src/protocol.ts` to:

```ts
| {
    kind: "SessionModelChanged";
    provider: Provider;
    sessionId: string;
    model: string;
    observedAt: string;
  }
| {
    kind: "SubagentStart";
    provider: Provider;
    sessionId: string;
    parentSessionId: string;
    title: string | null;
    project: string | null;
    model: string | null;
    observedAt: string;
  }
```

In `src/core/providers.ts`, add `model: null` to the generic `SubagentStart` object. In the existing Evener child start in `src/core/evener.ts`, add `model: state.model`; Task 2 will add the follow-up update event.

- [ ] **Step 4: Store/backfill child models and implement the difference-guarded update**

In `applySubagentStart`, preserve a stored model on null and backfill on non-null:

```ts
db.run(
  `UPDATE active_sessions
   SET parent_session_id = ?, status = 'idle', title = ?, project = ?,
       model = COALESCE(?, model),
       status_since = CASE WHEN status IS NOT 'idle' THEN ? ELSE status_since END,
       updated_at = ?
   WHERE provider = ? AND session_id = ?`,
  [
    event.parentSessionId,
    event.title,
    event.project,
    event.model,
    event.observedAt,
    event.observedAt,
    event.provider,
    event.sessionId,
  ],
);
```

Use the model column in the child insert rather than the current hard-coded null:

```ts
db.run(
  `INSERT INTO active_sessions
     (${COLUMNS}, status_since)
   VALUES (?, ?, ?, 'idle', ?, ?, NULL, ?, ?, NULL, 0, NULL, ?, NULL, NULL, 0, NULL, ?)`,
  [
    event.provider,
    event.sessionId,
    event.parentSessionId,
    event.title,
    event.project,
    event.observedAt,
    event.observedAt,
    event.model,
    event.observedAt,
  ],
);
```

Add the update-only handler; it deliberately omits `updated_at` and every lifecycle field:

```ts
const isNonEmptyBoundedModel = (model: string): boolean =>
  model.length > 0 && Array.from(model).length <= 256;

const applySessionModelChanged = (
  db: Database,
  event: Extract<RegistryEvent, { kind: "SessionModelChanged" }>,
): MutationResult => {
  if (!isNonEmptyBoundedModel(event.model)) {
    return "ignored";
  }
  const result = db.run(
    "UPDATE active_sessions SET model = ? WHERE provider = ? AND session_id = ? AND model IS NOT ?",
    [event.model, event.provider, event.sessionId, event.model],
  );
  return result.changes > 0 ? "applied" : "ignored";
};
```

Dispatch it immediately after `SessionTitleChanged`:

```ts
case "SessionModelChanged":
  return applySessionModelChanged(db, event);
```

- [ ] **Step 5: Run focused tests and strict type checking**

Run:

```sh
bun test test/registry.test.ts test/providers.test.ts test/protocol.test.ts test/cli.test.ts test/projection.test.ts
bun run typecheck
```

Expected: both commands exit 0. Type checking is the completeness check that every normalized `SubagentStart` constructor now supplies `model`.

- [ ] **Step 6: Commit the model event contract**

```sh
git add src/protocol.ts src/core/registry.ts src/core/providers.ts src/core/evener.ts test/registry.test.ts test/providers.test.ts test/protocol.test.ts test/cli.test.ts test/projection.test.ts
git commit -m "feat: retain native subagent models"
```

---

### Task 2: Hydrate and Update Evener Child Models

**Files:**
- Modify: `src/core/evener.ts:373-387,522-564,848-856`
- Modify: `test/evener.test.ts:77-115,184-269` and live-notification tests

**Interfaces:**
- Consumes: Task 1’s required `SubagentStart.model` and update-only `SessionModelChanged`.
- Produces: parent-first child event order `SubagentStart` → `SessionModelChanged` when non-null → title → status, plus root/child model-change notifications that never create membership.

- [ ] **Step 1: Make the Evener thread fixture model-selectable and write failing assertions**

Add `model?: string` to the `thread` fixture options and replace the fixed model with:

```ts
modelProvider: options.model ?? "gpt-5.6-sol",
```

Extend the existing parent-first hydration test with two children:

```ts
thread("terra-child", "active", {
  parentRef: "local:root",
  kind: "subagent",
  model: "gpt-5.6-terra",
}),
thread("opus-child", "active", {
  parentRef: "local:root",
  kind: "subagent",
  model: "claude-opus-4.1",
}),
thread("root", "active", { name: "Root title", model: "gpt-5.6-sol" }),
```

Assert the normalized child facts rather than only kinds:

```ts
expect(
  initialEvents
    .filter((event) => event.kind === "SubagentStart")
    .map((event) => [event.sessionId, event.model]),
).toEqual([
  ["opus-child", "claude-opus-4.1"],
  ["terra-child", "gpt-5.6-terra"],
]);

expect(
  initialEvents
    .filter((event) => event.kind === "SessionModelChanged")
    .map((event) => [event.sessionId, event.model]),
).toEqual([
  ["opus-child", "claude-opus-4.1"],
  ["terra-child", "gpt-5.6-terra"],
]);
```

Because subscriptions are serialized, update the same test to respond to three `thread/read` requests in order: root with `replaceSubscription: true`, then `opus-child` and `terra-child` with `replaceSubscription: false`. Call `await flush()` after each response before reading the next request, and assert the final request list has length 3. Send the model-change notification only after the `terra-child` read response has registered that child.

After the child is registered, add a notification assertion:

```ts
socket.message({
  method: "thread/model/changed",
  params: { ref: "local:terra-child", model: "gemini-3-pro" },
});
expect(updates.flatMap((update) => update.events).at(-1)).toEqual({
  kind: "SessionModelChanged",
  provider: "evener",
  sessionId: "terra-child",
  model: "gemini-3-pro",
  observedAt: "2026-08-26T05:00:00.000Z",
});
```

Keep the existing nested parent-first and idle/closed-removal assertions; update expected event-kind sequences to include `SessionModelChanged` immediately after each child start when its model is non-null.

- [ ] **Step 2: Run the Evener test and verify the child notification is red**

```sh
bun test test/evener.test.ts
```

Expected: FAIL because hydration emits no safe child model update and `handleModelChanged` still drops children.

- [ ] **Step 3: Add the safe model event helper and emit it after child membership**

Add beside `titleEvent`:

```ts
const modelEvent = (state: EvenerThreadState, observedAt: string): RegistryEvent | null =>
  state.model === null
    ? null
    : {
        kind: "SessionModelChanged",
        provider: "evener",
        sessionId: state.sessionId,
        model: state.model,
        observedAt,
      };
```

In the child branch of `hydrateState`, keep `SubagentStart` first, set `state.registered = true`, then append the safe update before title/status:

```ts
if (!state.registered) {
  events.push({
    kind: "SubagentStart",
    provider: "evener",
    sessionId: state.sessionId,
    parentSessionId: parent.sessionId,
    title: state.title,
    project: state.project,
    model: state.model,
    observedAt,
  });
  state.registered = true;
  state.cleanupEmitted = false;
}
const model = modelEvent(state, observedAt);
if (model !== null) {
  events.push(model);
}
const title = titleEvent(state, observedAt);
if (title !== null) {
  events.push(title);
}
events.push(statusObservedEvent(state, observedAt));
```

This order is intentional: if registry membership is rejected, the following model update is update-only and is ignored too.

- [ ] **Step 4: Replace root-refresh model notifications with update-only events for every state**

Replace `handleModelChanged` with:

```ts
const handleModelChanged = (params: Record<string, unknown>): void => {
  const state = stateForParams(params);
  const model = boundedString(params["model"]);
  if (state === null || model === null) {
    return;
  }
  state.model = model;
  emit([
    {
      kind: "SessionModelChanged",
      provider: "evener",
      sessionId: state.sessionId,
      model,
      observedAt: now(),
    },
  ]);
};
```

Do not call `observedEvent` here: a fact notification must not create a root or child.

- [ ] **Step 5: Run the Evener and registry/provider regression set**

```sh
bun test test/evener.test.ts test/registry.test.ts test/providers.test.ts
bun run typecheck
```

Expected: both commands exit 0; heterogeneous siblings retain distinct models, child changes emit, and removal ordering stays unchanged.

- [ ] **Step 6: Commit Evener model propagation**

```sh
git add src/core/evener.ts test/evener.test.ts
git commit -m "feat: publish Evener child model changes"
```

---

### Task 3: Build the Unified Projection Graph in One Validated Pass

**Files:**
- Modify: `src/protocol.ts:92-126` (graph types only; snapshot field lands in Task 4)
- Modify: `src/core/projection.ts:23-291,293-439`
- Modify: `test/projection.test.ts:18-615`

**Interfaces:**
- Consumes: validated `ProjectionRow[]`, native `parentSessionId`, Paseo `originRef`/`originParentRef`, stored `opened_at`, and Task 1 child models.
- Produces: `projectSnapshotRows(rows): { sessions: ProjectedSession[]; agents: ProjectedAgentNode[] }`; keeps `projectRows(rows): ProjectedSession[]` as the legacy test/caller wrapper until Task 4 wires publication.

- [ ] **Step 1: Add graph types and enrich the projection row fixture**

Add to `src/protocol.ts`:

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
```

Add `openedAt: string` to `ProjectionRow`, `opened_at: unknown` to `StoredRow`, and `opened_at` to `PROJECTION_COLUMNS`. Extend the `row` test helper options with `model?: string | null` and `openedAt?: string`, then return:

```ts
model: options.model ?? null,
openedAt: options.openedAt ?? "2026-08-26T05:00:00.000Z",
```

- [ ] **Step 2: Write failing graph projection tests**

Import `projectSnapshotRows` and add tests that make the required graph explicit:

```ts
test("projects mixed native and Paseo hierarchy with per-node facts", () => {
  const result = projectSnapshotRows([
    row("root", {
      provider: "evener",
      slot: 1,
      status: "idle",
      unreadSince: null,
      originKind: "paseo",
      originRef: "agent-root",
      model: "gpt-5.6-sol",
      openedAt: "2026-08-26T05:00:00.000Z",
    }),
    row("native", {
      provider: "evener",
      parent: "root",
      status: "idle",
      model: "claude-opus-4.1",
      openedAt: "2026-08-26T05:00:02.000Z",
      statusSince: "2026-08-26T05:00:02.000Z",
    }),
    row("native-nested", {
      provider: "evener",
      parent: "native",
      status: "waiting",
      model: "gpt-5.6-terra",
      openedAt: "2026-08-26T05:00:03.000Z",
    }),
    row("paseo", {
      provider: "codex",
      slot: 2,
      status: "working",
      unreadSince: null,
      originKind: "paseo",
      originRef: "agent-paseo",
      originSubagent: 1,
      originParentRef: "agent-root",
      openedAt: "2026-08-26T05:00:01.000Z",
    }),
    row("paseo-native", {
      provider: "codex",
      parent: "paseo",
      status: "error",
      model: "gemini-3-pro",
      openedAt: "2026-08-26T05:00:04.000Z",
    }),
  ]);

  expect(result.agents.map((node) => node.sessionId)).toEqual([
    "root",
    "paseo",
    "paseo-native",
    "native",
    "native-nested",
  ]);
  expect(result.agents.map((node) => [node.sessionId, node.status])).toEqual([
    ["root", "error"],
    ["paseo", "error"],
    ["paseo-native", "error"],
    ["native", "waiting"],
    ["native-nested", "waiting"],
  ]);
  expect(result.agents.find((node) => node.sessionId === "paseo")?.parent).toEqual({
    provider: "evener",
    sessionId: "root",
  });
  expect(result.agents.find((node) => node.sessionId === "native")?.parent).toEqual({
    provider: "evener",
    sessionId: "root",
  });
});

test("native nodes remove independent routing and unread facts", () => {
  const { agents } = projectSnapshotRows([
    row("root", { status: "working", slot: 1 }),
    row("child", {
      parent: "root",
      title: "Child title",
      project: "child-project",
      model: "child-model",
      openedAt: "2026-08-26T05:00:01.000Z",
      statusSince: "2026-08-26T05:00:02.000Z",
      activityLine: "Read child.ts",
      unreadSince: "2026-08-26T05:01:00.000Z",
      transcriptPath: "/tmp/child.jsonl",
      originKind: "paseo",
      originRef: "should-not-publish",
      originSubagent: 1,
      originParentRef: "should-not-publish",
    }),
  ]);
  expect(agents.find((node) => node.sessionId === "child")).toMatchObject({
    role: "subagent",
    lineage: "native",
    logicalSlot: null,
    ghosttyTerminalId: null,
    transcriptPath: null,
    originKind: null,
    originRef: null,
    originSubagent: false,
    originParentRef: null,
    unreadSince: null,
    title: "Child title",
    project: "child-project",
    model: "child-model",
    openedAt: "2026-08-26T05:00:01.000Z",
    statusSince: "2026-08-26T05:00:02.000Z",
    activityLine: "Read child.ts",
  });
});

test("missing, ambiguous, and cyclic Paseo parentage becomes parentless", () => {
  const { agents } = projectSnapshotRows([
    row("missing", {
      provider: "claude",
      slot: 1,
      status: "working",
      originKind: "paseo",
      originRef: "missing-child",
      originSubagent: 1,
      originParentRef: "absent",
    }),
    row("dup-a", { provider: "codex", slot: 2, status: "working", originKind: "paseo", originRef: "dup" }),
    row("dup-b", { provider: "kimi", slot: 3, status: "working", originKind: "paseo", originRef: "dup" }),
    row("ambiguous", {
      provider: "pi",
      slot: 4,
      status: "working",
      originKind: "paseo",
      originRef: "ambiguous-child",
      originSubagent: 1,
      originParentRef: "dup",
    }),
    row("cycle-a", {
      provider: "omp",
      slot: 5,
      status: "working",
      originKind: "paseo",
      originRef: "cycle-a",
      originSubagent: 1,
      originParentRef: "cycle-b",
    }),
    row("cycle-b", {
      provider: "qwen",
      slot: 6,
      status: "working",
      originKind: "paseo",
      originRef: "cycle-b",
      originSubagent: 1,
      originParentRef: "cycle-a",
    }),
  ]);
  for (const id of ["missing", "ambiguous", "cycle-a", "cycle-b"]) {
    expect(agents.find((node) => node.sessionId === id)?.parent).toBeNull();
  }
});

test("legacy sessions and duplicate graph roots agree", () => {
  const result = projectSnapshotRows([
    row("root", { status: "idle", unreadSince: null }),
    row("child", { parent: "root", status: "waiting", model: "child-model" }),
  ]);
  const legacy = result.sessions[0];
  const graphRoot = result.agents.find((node) => node.sessionId === "root");
  expect(graphRoot).toMatchObject({
    provider: legacy?.provider,
    sessionId: legacy?.sessionId,
    status: legacy?.status,
    title: legacy?.title,
    project: legacy?.project,
    model: legacy?.model,
    logicalSlot: legacy?.logicalSlot,
  });
  expect(legacy?.descendantCount).toBe(1);
});
```

Add one equal-timestamp sibling test whose expected order is provider then session ID, and retain every existing native corruption assertion against `projectRows`.

- [ ] **Step 3: Run the projection test and verify the new API is red**

```sh
bun test test/projection.test.ts
```

Expected: FAIL because `projectSnapshotRows`, `openedAt`, and graph nodes do not exist.

- [ ] **Step 4: Refactor native validation into node results and compute every native subtree bottom-up**

Introduce these internal shapes and helpers in `src/core/projection.ts`:

```ts
type NodeResult = {
  row: ProjectionRow;
  effectiveStatus: SessionStatus;
  descendantCount: number;
};

type RootResult = NodeResult & { slot: number };

export type ProjectedRows = {
  sessions: ProjectedSession[];
  agents: ProjectedAgentNode[];
};

const isPaseoSubagent = (row: ProjectionRow): boolean =>
  row.originKind === "paseo" && row.originSubagent === 1;

const childStatus = (row: ProjectionRow): SessionStatus => (row.status === "idle" ? "working" : row.status);
```

Keep the current identity, role, slot, parent, reachability, cycle, and traversal-bound checks. During each root traversal, append every visited row to `nativeOrder`. After all rows are proven reachable, compute bottom-up:

```ts
const results = new Map<string, NodeResult>();
for (const current of [...nativeOrder].reverse()) {
  const key = identityKey(current.provider, current.sessionId);
  let effectiveStatus = current.parentSessionId === null ? current.status : childStatus(current);
  let descendantCount = 0;
  for (const child of childrenOf.get(key) ?? []) {
    const childResult = results.get(identityKey(child.provider, child.sessionId));
    if (childResult === undefined) {
      throw new ProjectionError("corrupt-row");
    }
    effectiveStatus = maxStatus(effectiveStatus, childResult.effectiveStatus);
    descendantCount += childResult.descendantCount + 1;
  }
  results.set(key, { row: current, effectiveStatus, descendantCount });
}
```

Use each root’s `NodeResult` as the single intermediate for legacy and graph output.

- [ ] **Step 5: Resolve Paseo parents, clear every cycle-participant edge, and roll statuses upward**

Build unique root refs exactly once:

```ts
const rootByOriginRef = new Map<string, string>();
const ambiguousOriginRefs = new Set<string>();
for (const root of roots) {
  if (root.row.originKind !== "paseo" || root.row.originRef === null) {
    continue;
  }
  const ref = root.row.originRef;
  if (ambiguousOriginRefs.has(ref)) {
    continue;
  }
  if (rootByOriginRef.has(ref)) {
    rootByOriginRef.delete(ref);
    ambiguousOriginRefs.add(ref);
  } else {
    rootByOriginRef.set(ref, identityKey(root.row.provider, root.row.sessionId));
  }
}
```

Create a functional parent map only for Paseo subagent roots with a unique parent ref. Detect cycles iteratively; for every repeated key in the current path, collect every member from the first occurrence through the path end, then delete each member’s parent edge:

```ts
const paseoParent = new Map<string, string>();
for (const root of roots) {
  if (!isPaseoSubagent(root.row) || root.row.originParentRef === null) {
    continue;
  }
  const parentKey = rootByOriginRef.get(root.row.originParentRef);
  if (parentKey !== undefined) {
    paseoParent.set(identityKey(root.row.provider, root.row.sessionId), parentKey);
  }
}

const done = new Set<string>();
const cycleMembers = new Set<string>();
for (const start of paseoParent.keys()) {
  const path: string[] = [];
  const indexInPath = new Map<string, number>();
  let current: string | undefined = start;
  while (current !== undefined && !done.has(current)) {
    const cycleStart = indexInPath.get(current);
    if (cycleStart !== undefined) {
      for (const member of path.slice(cycleStart)) {
        cycleMembers.add(member);
      }
      break;
    }
    indexInPath.set(current, path.length);
    path.push(current);
    current = paseoParent.get(current);
  }
  for (const member of path) {
    done.add(member);
  }
}
for (const member of cycleMembers) {
  paseoParent.delete(member);
}
```

After deleting cycle edges, roll every root’s current native-subtree status through all remaining Paseo ancestors. A source walk carries the running maximum, so the result is independent of root iteration order:

```ts
for (const result of rootResults) {
  let carried = result.effectiveStatus;
  let parentKey = paseoParent.get(identityKey(result.row.provider, result.row.sessionId));
  const visited = new Set<string>();
  while (parentKey !== undefined && !visited.has(parentKey)) {
    visited.add(parentKey);
    const ancestor = rootResultsByIdentity.get(parentKey);
    if (ancestor === undefined) {
      throw new ProjectionError("corrupt-row");
    }
    const combined = maxStatus(carried, ancestor.effectiveStatus);
    ancestor.effectiveStatus = combined;
    carried = combined;
    parentKey = paseoParent.get(parentKey);
  }
}
```

`rootResultsByIdentity` is built from the same `NodeResult` objects used for legacy and graph materialization; the loop mutates only `effectiveStatus`, never a stored row or timer.

- [ ] **Step 6: Materialize legacy sessions and sanitized graph nodes from the same results**

Apply visibility only after native and Paseo status rollup, with the existing admission rule shared by both arrays:

```ts
const rootVisible = (result: RootResult): boolean =>
  result.effectiveStatus !== "idle" ||
  (result.row.unreadSince !== null && !isPaseoSubagent(result.row));

const visibleRoots = rootResults.filter(rootVisible);
```

An idle Paseo subagent therefore stays absent even when unread, unless a live native or Paseo descendant lifted its effective status. Every native row under a visible root is included because native rows exist only while live; a live native row necessarily lifts its ancestor root to at least `working`. Hidden childless roots remain part of validation but produce neither a legacy session nor an agent node.

Create one root-facts helper and use it in both arrays. For native children, narrow `parentSessionId` before construction and publish the invariant surface explicitly:

```ts
const nativeNode = (result: NodeResult, parentSessionId: string): ProjectedAgentNode => ({
  provider: result.row.provider,
  sessionId: result.row.sessionId,
  role: "subagent",
  lineage: "native",
  parent: { provider: result.row.provider, sessionId: parentSessionId },
  status: result.effectiveStatus,
  title: result.row.title,
  project: result.row.project,
  model: result.row.model,
  openedAt: result.row.openedAt,
  statusSince: result.row.statusSince,
  activityLine: result.row.activityLine,
  unreadSince: null,
  logicalSlot: null,
  ghosttyTerminalId: null,
  transcriptPath: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  originParentRef: null,
});
```

For each root, derive the graph role and resolved parent from the already-sanitized Paseo parent map:

```ts
const rootNode = (result: RootResult): ProjectedAgentNode => {
  const key = identityKey(result.row.provider, result.row.sessionId);
  const parentKey = paseoParent.get(key);
  const parentResult = parentKey === undefined ? undefined : rootResultsByIdentity.get(parentKey);
  const paseoSubagent = isPaseoSubagent(result.row);
  return {
    provider: result.row.provider,
    sessionId: result.row.sessionId,
    role: paseoSubagent ? "subagent" : "primary",
    lineage: paseoSubagent ? "paseo" : null,
    parent:
      paseoSubagent && parentResult !== undefined
        ? { provider: parentResult.row.provider, sessionId: parentResult.row.sessionId }
        : null,
    status: result.effectiveStatus,
    title: result.row.title,
    project: result.row.project,
    model: result.row.model,
    openedAt: result.row.openedAt,
    statusSince: result.row.statusSince,
    activityLine: result.row.activityLine,
    unreadSince: result.row.unreadSince,
    logicalSlot: result.slot,
    ghosttyTerminalId: result.row.ghosttyTerminalId,
    transcriptPath: result.row.transcriptPath,
    originKind: result.row.originKind,
    originRef: result.row.originRef,
    originSubagent: paseoSubagent,
    originParentRef: result.row.originParentRef,
  };
};
```

Build each `RootResult` as `{ ...nodeResult, slot }`, where `slot` is the already-validated positive logical slot. The legacy session mapper and `rootNode` read that same object, which is what makes duplicate root facts agree.

Order graph output deterministically: primary roots by positive slot; immediate children by `openedAt`, provider, session ID; depth-first pre-order; then parentless Paseo roots by that same child comparator with each safe subtree immediately after it.

Rename the current validated implementation to `projectSnapshotRows`, change its final return from the legacy array to both materialized arrays, and keep the compatibility wrapper:

```ts
return { sessions: projectedSessions, agents: orderedAgents };
};

export const projectRows = (rows: readonly ProjectionRow[]): ProjectedSession[] =>
  projectSnapshotRows(rows).sessions;
```

`orderedAgents` is built from one unified child map (native edges plus sanitized Paseo edges): primary roots by positive slot, immediate children by `openedAt`, provider, session ID, depth-first pre-order, followed by parentless Paseo roots and each safe subtree. Assert `orderedAgents.length` equals the number of visible graph nodes before returning; a mismatch is `ProjectionError("corrupt-row")`, not partial output.

- [ ] **Step 7: Map and validate `opened_at`, then run the projection suite**

In `toProjectionRow`, require canonical UTC rather than only a string, then return `openedAt: row.opened_at`:

```ts
const isCanonicalUtcInstant = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 256) {
    return false;
  }
  const epoch = Date.parse(value);
  return !Number.isNaN(epoch) && new Date(epoch).toISOString() === value;
};

if (!isCanonicalUtcInstant(row.opened_at)) {
  throw new ProjectionError("corrupt-row");
}
```

Add a `readProjection` corruption test that writes a root with `opened_at = 'not-a-time'`, expects `ProjectionError("corrupt-row")`, and proves the read transaction rolls back. Keep `readProjection` returning only `sessions` through `projectRows` for this task; Task 4 wires `agents` without duplicating the pass.

Run:

```sh
bun test test/projection.test.ts
bun run typecheck
```

Expected: both commands exit 0; all old root-only tests remain green and the new graph tests prove mixed hierarchy, per-node status, invariants, orphaning, order, and root agreement.

- [ ] **Step 8: Commit the pure projection graph**

```sh
git add src/protocol.ts src/core/projection.ts test/projection.test.ts
git commit -m "feat: project unified live agent graph"
```

---

### Task 4: Publish and Validate the Additive Snapshot Graph

**Files:**
- Modify: `src/protocol.ts:122-299`
- Modify: `src/core/projection.ts:421-439`
- Modify: `src/core/daemon.ts:324-330`
- Modify: `src/plugin/snapshot-reader.ts:42-46`
- Modify: `app/src/snapshot-view.ts:19-27,62-68`
- Modify: `test/protocol.test.ts:1-332`
- Modify: `test/projection.test.ts:617-1040`
- Modify: `test/daemon.test.ts:139-163,239-313`
- Modify: `test/layout.test.ts` snapshot helpers and plugin compatibility test
- Modify: `test/controller.test.ts:35-37`
- Modify: `test/strip-snapshot-view.test.ts:1-110`

**Interfaces:**
- Consumes: Task 3’s `projectSnapshotRows` and `ProjectedAgentNode`.
- Produces: normalized `SessionSnapshotV2.agents: ProjectedAgentNode[] | null`; raw omission maps to null, new daemon output maps to an array.

- [ ] **Step 1: Add protocol fixtures for absent, valid, and invalid graphs**

Set the typed `valid` fixture in `test/protocol.test.ts` to `agents: []`. Add a helper:

```ts
const agent = (overrides: Partial<ProjectedAgentNode> = {}): ProjectedAgentNode => ({
  provider: "claude",
  sessionId: "agent-root",
  role: "primary",
  lineage: null,
  parent: null,
  status: "working",
  title: "Agent root",
  project: "stream-deck-agents",
  model: "claude-opus-4.1",
  openedAt: "2026-08-26T05:00:00.000Z",
  statusSince: "2026-08-26T05:00:00.000Z",
  activityLine: null,
  unreadSince: null,
  logicalSlot: 1,
  ghosttyTerminalId: null,
  transcriptPath: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  originParentRef: null,
  ...overrides,
});
```

Add tests:

```ts
test("normalizes an absent agents field to null", () => {
  const { agents: _agents, ...oldDaemon } = valid;
  expect(parseSessionSnapshot(oldDaemon).agents).toBeNull();
});

test("parses a valid mixed graph without changing legacy sessions", () => {
  const root = agent();
  const child = agent({
    provider: "claude",
    sessionId: "native-child",
    role: "subagent",
    lineage: "native",
    parent: { provider: "claude", sessionId: "agent-root" },
    logicalSlot: null,
    ghosttyTerminalId: null,
    transcriptPath: null,
    originKind: null,
    originRef: null,
    originSubagent: false,
    originParentRef: null,
    unreadSince: null,
  });
  const parsed = parseSessionSnapshot({ ...valid, agents: [root, child] });
  expect(parsed.sessions).toEqual(valid.sessions);
  expect(parsed.agents).toEqual([root, child]);
});
```

Add table-driven rejection cases for: empty/duplicate identity, unknown provider/status, non-canonical `openedAt`, invalid role/lineage, native null/cross-provider/missing parent, Paseo parent targeting a native node, missing any non-null parent, native non-null slot, primary/Paseo null slot, duplicate root slots, native terminal/transcript/origin/unread facts, non-Claude terminal binding, and a two-node parent cycle.

- [ ] **Step 2: Add last-good and Stream Deck compatibility tests**

In `test/strip-snapshot-view.test.ts`, feed a cyclic graph after a healthy graph and assert the reducer returns the exact last-good snapshot with `degraded: true`.

In `test/layout.test.ts`, add `agents` containing a native child to a healthy `SnapshotView` and assert `reduceLayout` still emits only the legacy `sessions` tile and retains its `descendantCount`. This locks the temporary Stream Deck path to `sessions`.

Keep `countUnreadSessions` based on `snapshot.sessions`; add a test that native graph nodes do not change the count. This preserves the existing exact root unread ledger and avoids counting display-only children.

- [ ] **Step 3: Run protocol/snapshot tests and verify the normalized field is red**

```sh
bun test test/protocol.test.ts test/strip-snapshot-view.test.ts test/layout.test.ts
```

Expected: FAIL because `SessionSnapshotV2` and `parseSessionSnapshot` do not expose or validate `agents`.

- [ ] **Step 4: Add graph parsing with shape, role, parent, slot, and cycle validation**

Change the normalized snapshot type:

```ts
export type SessionSnapshotV2 = {
  schemaVersion: 2;
  health: SnapshotHealth;
  sessions: ProjectedSession[];
  agents: ProjectedAgentNode[] | null;
};
```

Add a canonical UTC check:

```ts
const isCanonicalUtcInstant = (value: unknown): value is string => {
  if (!isBoundedString(value) || value.length === 0) {
    return false;
  }
  const epoch = Date.parse(value);
  return !Number.isNaN(epoch) && new Date(epoch).toISOString() === value;
};
```

Parse identities with a dedicated helper so node and parent identities use identical non-empty bounds:

```ts
const parseAgentIdentity = (value: unknown, field: string): AgentIdentity => {
  if (!isRecord(value)) {
    return invalid(`${field} must be an object`);
  }
  if (typeof value["provider"] !== "string" || !PROVIDERS.has(value["provider"])) {
    return invalid(`${field}.provider is not a known provider`);
  }
  if (!isBoundedString(value["sessionId"]) || value["sessionId"].length === 0) {
    return invalid(`${field}.sessionId must be a non-empty bounded string`);
  }
  return { provider: value["provider"] as Provider, sessionId: value["sessionId"] };
};
```

In `parseAgent`, reject a non-object first, then validate every field before constructing the node:

| Field | Exact accepted shape |
|---|---|
| `provider` | member of `PROVIDER_KEYS` |
| `sessionId` | non-empty string, at most 256 code points |
| `role` | `"primary"` or `"subagent"` |
| `lineage` | `"native"`, `"paseo"`, or null |
| `parent` | null or `parseAgentIdentity(value, "agent.parent")` |
| `status` | member of `SESSION_STATUSES` |
| `title`, `project`, `model`, `statusSince`, `activityLine`, `unreadSince`, `transcriptPath`, `originRef`, `originParentRef` | null or string at most 256 code points; terminal/transcript/origin role invariants below further restrict them |
| `openedAt` | `isCanonicalUtcInstant` |
| `logicalSlot` | null or integer; role invariants below require positive roots and null native children |
| `ghosttyTerminalId` | null or non-empty string at most 256 code points |
| `originKind` | `"paseo"`, `"terminal"`, or null |
| `originSubagent` | boolean |

Return a newly constructed `ProjectedAgentNode`; never return the input record or coerce a value. After field validation, enforce these exact role combinations:

```ts
if (role === "primary") {
  if (lineage !== null || parent !== null || !isPositiveInteger(logicalSlot) || originSubagent) {
    return invalid("agent primary role invariants are invalid");
  }
} else if (lineage === "native") {
  if (
    parent === null ||
    parent.provider !== provider ||
    logicalSlot !== null ||
    ghosttyTerminalId !== null ||
    transcriptPath !== null ||
    originKind !== null ||
    originRef !== null ||
    originSubagent ||
    originParentRef !== null ||
    unreadSince !== null
  ) {
    return invalid("agent native role invariants are invalid");
  }
} else if (lineage === "paseo") {
  if (!isPositiveInteger(logicalSlot) || originKind !== "paseo" || !originSubagent) {
    return invalid("agent Paseo role invariants are invalid");
  }
} else {
  return invalid("agent subagent lineage is invalid");
}
if (ghosttyTerminalId !== null && provider !== "claude") {
  return invalid("agent.ghosttyTerminalId is only valid for Claude");
}
```

After mapping the array, index and validate it with the same composite identity everywhere:

```ts
const parseAgents = (values: unknown[]): ProjectedAgentNode[] => {
  const agents = values.map(parseAgent);
  const byIdentity = new Map<string, ProjectedAgentNode>();
  const seenSlots = new Set<number>();
  for (const agent of agents) {
    const key = `${agent.provider}\u0000${agent.sessionId}`;
    if (byIdentity.has(key)) return invalid(`duplicate agent identity ${key}`);
    byIdentity.set(key, agent);
    if (agent.logicalSlot !== null) {
      if (seenSlots.has(agent.logicalSlot)) return invalid(`duplicate agent logicalSlot ${agent.logicalSlot}`);
      seenSlots.add(agent.logicalSlot);
    }
  }
  for (const agent of agents) {
    if (agent.parent === null) continue;
    const parentKey = `${agent.parent.provider}\u0000${agent.parent.sessionId}`;
    const parent = byIdentity.get(parentKey);
    if (parent === undefined) return invalid("agent parent does not exist");
    if (agent.lineage === "native" && agent.parent.provider !== agent.provider) {
      return invalid("native agent parent must use the same provider");
    }
    if (agent.lineage === "paseo" && parent.logicalSlot === null) {
      return invalid("Paseo agent parent must be a registry root");
    }
  }
  const done = new Set<string>();
  for (const agent of agents) {
    const path = new Set<string>();
    let current: ProjectedAgentNode | undefined = agent;
    while (current !== undefined) {
      const key = `${current.provider}\u0000${current.sessionId}`;
      if (done.has(key)) break;
      if (path.has(key)) return invalid("agent graph must be acyclic");
      path.add(key);
      current =
        current.parent === null
          ? undefined
          : byIdentity.get(`${current.parent.provider}\u0000${current.parent.sessionId}`);
    }
    for (const key of path) done.add(key);
  }
  return agents;
};
```

The parent-existence loop runs before cycle detection, so an undefined lookup during the cycle walk can only mean the chain reached null, not a silently accepted dangling edge.

In `parseSessionSnapshot`, distinguish absence from present invalid values:

```ts
let agents: ProjectedAgentNode[] | null = null;
if ("agents" in value) {
  if (!Array.isArray(value["agents"])) {
    return invalid("agents must be an array when present");
  }
  agents = parseAgents(value["agents"]);
}
return {
  schemaVersion: 2,
  health: parseHealth(value["health"]),
  sessions,
  agents,
};
```

- [ ] **Step 5: Wire one projection call into healthy snapshots and explicit compatibility values elsewhere**

In `readProjection`, call Task 3 once:

```ts
const projected = projectSnapshotRows(rows.map(toProjectionRow));
const snapshot: SessionSnapshotV2 = {
  schemaVersion: 2,
  health: { status: "ok" },
  sessions: projected.sessions,
  agents: projected.agents,
};
```

Add `agents: []` to `ProjectionDaemon`’s bounded unhealthy snapshot. Add `agents: null` to the plugin and app in-memory empty degraded snapshots because they represent no parsed daemon graph.

Update typed test constructors:

- `test/protocol.test.ts`: `agents: []`.
- `test/layout.test.ts` and `test/controller.test.ts`: `agents: null` unless the test explicitly exercises graph presence.
- `test/strip-snapshot-view.test.ts`: helper accepts an `agents` argument defaulting to null.
- `test/projection.test.ts` atomic-write fixtures: `agents: []`; `readProjection` expectations assert a populated array.
- `test/daemon.test.ts`: unhealthy snapshots include `agents: []`; `HEALTHY_S1` includes one primary `ProjectedAgentNode` with `openedAt: NOW` and facts matching its legacy session.

- [ ] **Step 6: Run protocol, projection, daemon, plugin, and snapshot regression tests**

```sh
bun test test/protocol.test.ts test/projection.test.ts test/daemon.test.ts test/layout.test.ts test/controller.test.ts test/strip-snapshot-view.test.ts
bun run typecheck
```

Expected: both commands exit 0. The parser rejects corrupt graphs, old-daemon omission normalizes to null, new daemon snapshots carry arrays, last-good degradation survives graph rejection, and Stream Deck remains sessions-only.

- [ ] **Step 7: Commit the additive snapshot contract**

```sh
git add src/protocol.ts src/core/projection.ts src/core/daemon.ts src/plugin/snapshot-reader.ts app/src/snapshot-view.ts test/protocol.test.ts test/projection.test.ts test/daemon.test.ts test/layout.test.ts test/controller.test.ts test/strip-snapshot-view.test.ts
git commit -m "feat: publish additive Xeneon agent graph"
```

---

### Task 5: Make Card Rendering and Interaction Display-Only Safe

**Files:**
- Modify: `app/src/board.ts:16-24,71-100`
- Modify: `app/src/cards.ts:65-108,118-194`
- Modify: `app/src/tile-identity.ts:15-35`
- Modify: `app/src/main.ts:82-100,323-359,489-503`
- Modify: `app/src/press.ts:8-43`
- Modify: `app/styles.css:66-82,160-180`
- Modify: `test/strip-board.test.ts:92-100`
- Modify: `test/strip-cards.test.ts:37-48,99-160`
- Modify: `test/strip-tile-identity.test.ts:35-69`
- Modify: `test/press.test.ts:1-109`

**Interfaces:**
- Consumes: existing `ProjectedSession` fallback cards; graph nodes do not enter the board until Task 6.
- Produces: every `BoardCardSeed` carries `displayOnly: boolean` and `descendantBadge: number | null`; immediate/deferred interaction resolvers return null for display-only cards.

- [ ] **Step 1: Add explicit card fields to test fixtures and write failing safety tests**

Add to every board/card seed fixture:

```ts
displayOnly: false,
descendantBadge: session.descendantCount,
```

In `test/strip-cards.test.ts`, add:

```ts
test("a graph-backed display-only child has no unread dot or descendant badge", () => {
  const model = cardViewModel(
    placed(
      { displayOnly: true, descendantBadge: null, subagent: true, indent: true },
      {
        model: "gpt-5.6-terra",
        status: "waiting",
        statusSince: "2026-08-25T00:08:00.000Z",
        unreadSince: "2026-08-25T00:09:00.000Z",
        descendantCount: 9,
      },
    ),
    NOW_MS,
  );
  expect(model).toMatchObject({
    displayOnly: true,
    modelLabel: "gpt-5.6-terra",
    status: "waiting",
    timer: "waiting 2m",
    unread: false,
    badge: null,
  });
  expect(cardClassName(model)).toContain("display-only");
});

test("fallback cards retain the legacy descendant badge", () => {
  expect(cardViewModel(placed({ descendantBadge: 3 }), NOW_MS).badge).toBe(3);
});
```

In `test/strip-tile-identity.test.ts`, add:

```ts
test("display-only cards are rejected immediately and after identity re-resolution", () => {
  const before = placedCard(session("evener", "child", "Child"));
  const identity = identityOf(before.session);
  const native = { ...before, displayOnly: true };
  expect(interactiveBoardCard(native)).toBeNull();
  expect(resolveInteractiveBoardCard([native], identity)).toBeNull();
});

test("root and Paseo cards remain interactive", () => {
  const root = placedCard(session("evener", "root", "Root"));
  const paseo = placedCard(
    session("codex", "paseo", "Paseo", {
      originKind: "paseo",
      originRef: "agent-1",
      originSubagent: true,
    }),
  );
  expect(interactiveBoardCard(root)).toBe(root);
  expect(interactiveBoardCard(paseo)).toBe(paseo);
});
```

Adjust the local `session` helper to accept `Partial<ProjectedSession>` for the Paseo case.

In `test/press.test.ts`, import `pressBoardCard` and prove the safety boundary invokes no bridge dependency at all:

```ts
test("a display-only card schedules no ack, route, or flash", async () => {
  const { deps, calls } = makeDeps();
  await pressBoardCard({ session: session({ provider: "evener" }), displayOnly: true }, deps);
  expect(calls).toEqual([]);
});
```

The existing root and Paseo `pressSessionTile` tests remain unchanged and green.

- [ ] **Step 2: Run card and identity tests and verify the explicit contract is red**

```sh
bun test test/strip-board.test.ts test/strip-cards.test.ts test/strip-tile-identity.test.ts
```

Expected: FAIL because seeds, view models, class names, and interaction resolvers lack the new fields.

- [ ] **Step 3: Carry display-only and badge policy through fallback seeds and card rendering**

Extend `BoardCardSeed`:

```ts
export type BoardCardSeed = {
  session: ProjectedSession;
  label: string;
  subagent: boolean;
  parentProject: string | null;
  displayOnly: boolean;
  descendantBadge: number | null;
};
```

Every existing `groupedOrder` seed must set:

```ts
displayOnly: false,
descendantBadge: session.descendantCount,
```

Extend `CardViewModel` with `displayOnly` and change `badge` to `number | null`. Derive:

```ts
displayOnly: card.displayOnly,
unread: !card.displayOnly && session.unreadSince !== null,
badge: card.descendantBadge,
```

Extract and use a pure class helper:

```ts
export const cardClassName = (model: CardViewModel): string =>
  [
    "card",
    `status-${model.status}`,
    model.subagent ? "sub" : "primary",
    model.indent ? "indented" : "",
    model.spine !== "none" ? `spine-${model.spine}` : "",
    model.displayOnly ? "display-only" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
```

Render a badge only when `model.badge !== null && model.badge > 0`. Do not infer graph mode from `session.descendantCount`.

Add the minimal style without changing geometry or pointer event delivery needed for page swipes:

```css
.card.display-only {
  cursor: default;
}
```

- [ ] **Step 4: Add immediate and deferred interaction resolvers**

Change `resolveBoardCard` to return the actual card:

```ts
export const resolveBoardCard = (
  cards: readonly PlacedCard[],
  identity: SessionIdentity,
): { index: number; card: PlacedCard } | null => {
  for (const [index, card] of cards.entries()) {
    if (card.session.provider === identity.provider && card.session.sessionId === identity.sessionId) {
      return { index, card };
    }
  }
  return null;
};
```

Add:

```ts
export const interactiveBoardCard = (card: PlacedCard | undefined): PlacedCard | null =>
  card === undefined || card.displayOnly ? null : card;

export const resolveInteractiveBoardCard = (
  cards: readonly PlacedCard[],
  identity: SessionIdentity,
): { index: number; card: PlacedCard } | null => {
  const resolved = resolveBoardCard(cards, identity);
  return resolved === null || resolved.card.displayOnly ? null : resolved;
};
```

- [ ] **Step 5: Guard tap, pointerdown, and deferred sheet resolution in event wiring**

In `onBoardClick` and `cardFromPointerEvent`, replace direct indexing with:

```ts
const currentCard = interactiveBoardCard(currentCards[index]);
if (currentCard === null) {
  return;
}
```

Add a defense-in-depth press entry point in `app/src/press.ts` and use it from `main.ts` after the immediate resolver:

```ts
export type BoardPressTarget = {
  session: ProjectedSession;
  displayOnly: boolean;
};

export const pressBoardCard = async (card: BoardPressTarget, deps: PressDeps): Promise<void> => {
  if (card.displayOnly) {
    return;
  }
  await pressSessionTile(card.session, deps);
};
```

In `onBoardClick`, call `pressBoardCard(currentCard, deps)` only after `interactiveBoardCard` returned the card. In `openActionSheetFor`, use `resolveInteractiveBoardCard`; read `ref.card.session` and `ref.card.label`. This rejects a card that disappeared or became display-only during the hold before `openActionSheet`, `buildSheetModel`, or any sheet action exists.

The handler-level resolver is the primary “before action construction” boundary; `pressBoardCard` independently proves that even a future mistaken caller cannot schedule ack, route, or flash. Keep the gesture recognizer unchanged so swipes still work across every card.

- [ ] **Step 6: Run card, identity, gesture, press, and action-sheet regressions**

```sh
bun test test/strip-board.test.ts test/strip-cards.test.ts test/strip-tile-identity.test.ts test/strip-gestures.test.ts test/press.test.ts test/strip-action-sheet.test.ts
bun run typecheck
```

Expected: both commands exit 0. Display-only cards reject immediate and deferred actions; root/Paseo press, sheet, gesture, and routing behavior remains green.

- [ ] **Step 7: Commit the interaction-safe card contract**

```sh
git add app/src/board.ts app/src/cards.ts app/src/tile-identity.ts app/src/main.ts app/src/press.ts app/styles.css test/strip-board.test.ts test/strip-cards.test.ts test/strip-tile-identity.test.ts test/press.test.ts
git commit -m "feat: make native child cards display only"
```

---

### Task 6: Reduce and Render the Graph on Xeneon

**Files:**
- Modify: `app/src/board.ts:8-100,187-218`
- Modify: `src/plugin/layout.ts:73-82`
- Modify: `app/src/cards.ts:9-11`
- Modify: `app/src/tile-identity.ts:12-35`
- Modify: `app/src/routing.ts:8-40`
- Modify: `app/src/press.ts:8-43`
- Modify: `app/src/action-sheet.ts:8-77`
- Modify: `app/src/main.ts:20-33,82-100`
- Modify: `test/strip-board.test.ts:1-216`
- Modify: `test/strip-cards.test.ts:1-160`
- Modify: `test/press.test.ts`, `test/strip-action-sheet.test.ts`, `test/strip-tile-identity.test.ts` type fixtures as required

**Interfaces:**
- Consumes: Task 4’s normalized `snapshot.agents` and Task 5’s safe `BoardCardSeed`.
- Produces: `BoardSession = ProjectedSession | ProjectedAgentNode`, `groupedAgentOrder(agents)`, and `reduceBoard` graph/fallback selection.

- [ ] **Step 1: Add graph-node fixtures and failing reducer tests**

In `test/strip-board.test.ts`, import `ProjectedAgentNode` and add:

```ts
const node = (sessionId: string, overrides: Partial<ProjectedAgentNode> = {}): ProjectedAgentNode => ({
  provider: "evener",
  sessionId,
  role: "primary",
  lineage: null,
  parent: null,
  status: "working",
  title: sessionId,
  project: "repo",
  model: null,
  openedAt: "2026-08-26T05:00:00.000Z",
  statusSince: "2026-08-26T05:00:00.000Z",
  activityLine: null,
  unreadSince: null,
  logicalSlot: 1,
  ghosttyTerminalId: null,
  transcriptPath: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  originParentRef: null,
  ...overrides,
});
```

Add graph tests:

```ts
test("graph groups primaries by slot and mixed children depth-first", () => {
  const root = node("root", { logicalSlot: 2 });
  const first = node("paseo", {
    provider: "codex",
    role: "subagent",
    lineage: "paseo",
    parent: { provider: "evener", sessionId: "root" },
    logicalSlot: 3,
    openedAt: "2026-08-26T05:00:01.000Z",
    originKind: "paseo",
    originRef: "paseo-ref",
    originSubagent: true,
  });
  const firstChild = node("paseo-native", {
    provider: "codex",
    role: "subagent",
    lineage: "native",
    parent: { provider: "codex", sessionId: "paseo" },
    logicalSlot: null,
    openedAt: "2026-08-26T05:00:02.000Z",
  });
  const second = node("native", {
    role: "subagent",
    lineage: "native",
    parent: { provider: "evener", sessionId: "root" },
    logicalSlot: null,
    openedAt: "2026-08-26T05:00:03.000Z",
  });
  const earlierPrimary = node("earlier", { provider: "claude", logicalSlot: 1 });

  const groups = groupedAgentOrder([second, firstChild, root, first, earlierPrimary]);
  expect(groups.map(ids)).toEqual([["earlier"], ["root", "paseo", "paseo-native", "native"]]);
  expect(groups[1]?.cards.map((card) => [card.session.sessionId, card.displayOnly])).toEqual([
    ["root", false],
    ["paseo", false],
    ["paseo-native", true],
    ["native", true],
  ]);
  expect(packBoard([groups[1]!], false)[0]?.cards.map((card) => [card.session.sessionId, card.indent])).toEqual([
    ["root", false],
    ["paseo", true],
    ["paseo-native", true],
    ["native", true],
  ]);
});

test("equal child timestamps use provider then session identity", () => {
  const root = node("root");
  const child = (provider: ProjectedAgentNode["provider"], sessionId: string): ProjectedAgentNode =>
    node(sessionId, {
      provider,
      role: "subagent",
      lineage: "paseo",
      parent: { provider: "evener", sessionId: "root" },
      logicalSlot: provider === "claude" ? (sessionId === "a" ? 2 : 3) : 4,
      openedAt: "2026-08-26T05:00:01.000Z",
      originKind: "paseo",
      originRef: `${provider}-${sessionId}`,
      originSubagent: true,
    });
  expect(ids(groupedAgentOrder([child("codex", "z"), root, child("claude", "b"), child("claude", "a")])[0]!)).toEqual([
    "root",
    "a",
    "b",
    "z",
  ]);
});

test("orphan roots keep safe descendants in one full-width atomic tail", () => {
  const orphanB = node("orphan-b", {
    provider: "codex",
    role: "subagent",
    lineage: "paseo",
    logicalSlot: 3,
    openedAt: "2026-08-26T05:00:02.000Z",
    originKind: "paseo",
    originRef: "b",
    originSubagent: true,
  });
  const orphanA = node("orphan-a", {
    role: "subagent",
    lineage: "paseo",
    logicalSlot: 2,
    openedAt: "2026-08-26T05:00:01.000Z",
    originKind: "paseo",
    originRef: "a",
    originSubagent: true,
  });
  const native = node("orphan-child", {
    role: "subagent",
    lineage: "native",
    parent: { provider: "evener", sessionId: "orphan-a" },
    logicalSlot: null,
    openedAt: "2026-08-26T05:00:03.000Z",
  });
  const groups = groupedAgentOrder([orphanB, native, orphanA]);
  expect(groups.map(ids)).toEqual([["orphan-a", "orphan-child", "orphan-b"]]);
  const placed = packBoard(groups, false)[0]?.cards ?? [];
  expect(placed.every((card) => !card.indent && card.spine === "none")).toBe(true);
});
```

Add `reduceBoard` tests proving:

- `agents: []` ignores non-empty legacy `sessions` and renders one empty page;
- `agents: null` retains current Paseo grouping and descendant badges;
- `agents` present suppresses every `descendantBadge` with null;
- disappearing graph children clamp the persisted page exactly as current session removal does.

- [ ] **Step 2: Run board tests and verify graph mode is red**

```sh
bun test test/strip-board.test.ts
```

Expected: FAIL because `groupedAgentOrder`, `BoardSession`, and graph selection do not exist.

- [ ] **Step 3: Generalize the board session type without weakening action safety**

In `app/src/board.ts`:

```ts
export type BoardSession = ProjectedSession | ProjectedAgentNode;
```

Change `BoardCardSeed.session` to `BoardSession`. In `src/plugin/layout.ts`, narrow `labelForSession` to the fields it actually consumes:

```ts
export type SessionLabelSource = Pick<ProjectedSession, "provider" | "sessionId" | "title" | "project">;

export const labelForSession = (session: SessionLabelSource): string => {
  if (session.title !== null && session.title.length > 0) return session.title;
  if (session.project !== null && session.project.length > 0) return session.project;
  return `${session.provider} ${session.sessionId.slice(0, SHORT_SESSION_ID_LENGTH)}`;
};
```

Use `BoardSession` through `import type` in `cards.ts`, `tile-identity.ts`, `routing.ts`, `press.ts`, `action-sheet.ts`, and `main.ts` where the code accepts either legacy sessions or graph nodes. In particular, change `BoardPressTarget.session` and `SheetContext.session` to `BoardSession`. Do not add casts. `routeForSession`, `pressSessionTile`, `buildSheetModel`, and `transcriptPathOf` use fields present on both types. Task 5’s `displayOnly` checks remain the mandatory boundary that prevents native nodes from reaching these functions.

- [ ] **Step 4: Implement one graph grouping path for both native and Paseo edges**

Add identity and comparator helpers:

```ts
const agentKey = (identity: AgentIdentity): string => `${identity.provider}\u0000${identity.sessionId}`;

const compareOpenedIdentity = (a: ProjectedAgentNode, b: ProjectedAgentNode): number =>
  a.openedAt.localeCompare(b.openedAt) ||
  a.provider.localeCompare(b.provider) ||
  a.sessionId.localeCompare(b.sessionId);
```

Implement `groupedAgentOrder` from graph parents only:

```ts
export const groupedAgentOrder = (agents: readonly ProjectedAgentNode[]): BoardGroup[] => {
  const childrenOf = new Map<string, ProjectedAgentNode[]>();
  const primaries = agents
    .filter((node): node is ProjectedAgentNode & { logicalSlot: number } =>
      node.role === "primary" && node.logicalSlot !== null,
    )
    .sort((a, b) => a.logicalSlot - b.logicalSlot);

  for (const node of agents) {
    if (node.parent === null) continue;
    const key = agentKey(node.parent);
    const children = childrenOf.get(key) ?? [];
    children.push(node);
    childrenOf.set(key, children);
  }
  for (const children of childrenOf.values()) children.sort(compareOpenedIdentity);

  const seed = (
    node: ProjectedAgentNode,
    parentProject: string | null,
  ): BoardCardSeed => ({
    session: node,
    label: labelForSession(node),
    subagent: node.role === "subagent",
    parentProject,
    displayOnly: node.lineage === "native",
    descendantBadge: null,
  });

  const appendChildren = (cards: BoardCardSeed[], parent: ProjectedAgentNode, parentProject: string | null): void => {
    for (const child of childrenOf.get(agentKey(parent)) ?? []) {
      cards.push(seed(child, parentProject));
      appendChildren(cards, child, parentProject);
    }
  };

  const groups = primaries.map((primary): BoardGroup => {
    const cards = [seed(primary, null)];
    appendChildren(cards, primary, primary.project);
    return { cards, orphanTail: false };
  });

  const orphans = agents
    .filter((node) => node.role === "subagent" && node.parent === null)
    .sort(compareOpenedIdentity);
  if (orphans.length > 0) {
    const cards: BoardCardSeed[] = [];
    for (const orphan of orphans) {
      cards.push(seed(orphan, null));
      appendChildren(cards, orphan, null);
    }
    groups.push({ cards, orphanTail: true });
  }
  return groups;
};
```

The graph parser already guarantees existence and acyclicity. Do not reconstruct origin-ref lineage or add a second native/Paseo grouping branch.

- [ ] **Step 5: Select graph or fallback before unchanged packing**

Change `reduceBoard` to:

```ts
const groups =
  view.snapshot.agents === null
    ? groupedOrder(view.snapshot.sessions)
    : groupedAgentOrder(view.snapshot.agents);
const packed = packBoard(groups, view.degraded);
```

Leave `packBoard`, `withSpines`, page-count derivation, settings validation, clamping, and `jumpBoard` unchanged. Because graph seeds carry `descendantBadge: null`, graph-backed roots and children render no count; fallback seeds retain the old count.

- [ ] **Step 6: Run the complete strip regression set and app build**

```sh
bun test test/strip-board.test.ts test/strip-cards.test.ts test/strip-tile-identity.test.ts test/press.test.ts test/strip-routing.test.ts test/strip-action-sheet.test.ts test/strip-gestures.test.ts test/strip-snapshot-view.test.ts
bun run typecheck
bun run build:app
```

Expected: all three commands exit 0. Graph mode shows mixed child types depth-first, nested descendants share one indent, orphans retain safe descendants, graph badges disappear, native cards remain inert, fallback and packing remain unchanged, and the browser bundle builds.

- [ ] **Step 7: Commit the Xeneon graph reducer**

```sh
git add app/src/board.ts src/plugin/layout.ts app/src/cards.ts app/src/tile-identity.ts app/src/routing.ts app/src/press.ts app/src/action-sheet.ts app/src/main.ts test/strip-board.test.ts test/strip-cards.test.ts test/strip-tile-identity.test.ts test/press.test.ts test/strip-action-sheet.test.ts
git commit -m "feat: render live subagent tree on Xeneon"
```

---

### Task 7: Update Living Contracts and Run the Full Gate

**Files:**
- Modify: `docs/design.md:305-448,531-564`
- Modify: `AGENTS.md` Xeneon strip, projection, Evener-model, and interaction summary paragraphs
- Verify only: all production and test files changed in Tasks 1-6

**Interfaces:**
- Consumes: the verified implementation and approved spec.
- Produces: current living documentation plus a zero-exit repository gate.

- [ ] **Step 1: Rewrite the Xeneon snapshot and grouping contract in `docs/design.md`**

Replace the stale “same projection/no protocol change/Paseo-only join” text with these facts:

- snapshot v2 has additive optional-on-wire `agents`; absence means old-daemon fallback, presence means graph-exclusive board reduction;
- the daemon validates native topology and resolves safe composite Paseo parents before publication;
- primary groups sort by logical slot; all immediate children sort by `openedAt`, provider, ID and traverse depth-first; native and Paseo edges use the same graph reducer;
- missing/ambiguous/cyclic Paseo roots form the full-width orphan tail with safe descendants;
- all descendants flatten to one 44px indent in resolved groups;
- group packing and page clamping are unchanged.

Keep the historical dated spec links intact and add the authoritative live-tree spec link beside the existing board-redesign link.

- [ ] **Step 2: Rewrite card and interaction text in `docs/design.md`**

State explicitly:

- graph-backed cards show no descendant badge; only old-daemon fallback can show the legacy count;
- each child uses its own provider, model, title, effective status, and own `statusSince` timer;
- native children never show unread and are display-only with no tap flash/ack/route or long-press sheet;
- Paseo subagents retain independent tap and action-sheet behavior;
- native child completion removes the card; no history or collapse behavior exists.

Keep colors, dimensions, rail, animation, packing, and degraded-view text unchanged.

- [ ] **Step 3: Synchronize `AGENTS.md` without editing dated records**

Update the Xeneon summary to name `agents`, graph/fallback selection, mixed native/Paseo depth-first grouping, deterministic orphan tail, graph badge removal, and native display-only interaction. Update the Evener summary to state that child starts and model-change events retain heterogeneous child models. Preserve the legacy Stream Deck `sessions`/`descendantCount` statement and every unrelated provider/quota/token rule.

- [ ] **Step 4: Format-check documentation and review the exact diff**

```sh
git diff --check
git diff -- docs/design.md AGENTS.md
git status --short
```

Expected: `git diff --check` exits 0; the diff changes only living documentation and accurately matches the implemented behavior; dated specs and verification records are absent from status. Biome deliberately ignores these Markdown files, so do not treat `biome check docs/design.md AGENTS.md` as a gate.

- [ ] **Step 5: Commit the living documentation**

```sh
git add docs/design.md AGENTS.md
git commit -m "docs: describe Xeneon live subagent tree"
```

- [ ] **Step 6: Run the required full gate from a clean process state**

First confirm no source daemon was left running by this work:

```sh
ps -ef | rg "[c]li\.ts daemon" || true
```

If this plan did not start a source daemon, do not kill unrelated processes; record the output. Then run:

```sh
bun run check
```

Expected: `biome ci .`, `bun run build`, and `bun test` all run and the command exits 0. A timeout, skipped phase, or non-zero exit is not a pass.

- [ ] **Step 7: Verify repository state and acceptance criteria**

```sh
git status --short --branch
git log -7 --oneline --decorate
```

Confirm explicitly:

1. provider-native and Paseo live children are present in `agents`;
2. Evener siblings retain distinct models and child model changes;
3. per-node status rolls up native then Paseo while each timer remains own-row;
4. invalid native topology fails atomically and uncertain Paseo lineage orphans;
5. Xeneon graph groups depth-first, single-indent, with deterministic orphan tail;
6. graph cards have no count badge and native cards have no unread or interaction;
7. old-daemon fallback and Stream Deck legacy sessions remain green;
8. full `bun run check` exited 0;
9. no dated spec/verification file changed and the workspace has no uncommitted implementation artifacts.
