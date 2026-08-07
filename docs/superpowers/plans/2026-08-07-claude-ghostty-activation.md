# Claude Code Ghostty Terminal Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Stream Deck press on a Claude Code tile focus the exact existing Ghostty terminal that owns that ordinary direct `claude` session, while missing or stale bindings alert and never launch anything.

**Architecture:** Enrich only Claude `SessionStart` inside the trusted local CLI by joining the direct hook's immediate parent PID to Ghostty's native terminal `pid` and `tty`, then persist only Ghostty's stable terminal ID through SQLite schema v2 and strict snapshot v2. The plugin receives that nullable ID in the existing structured key model and focuses exactly one already-running Ghostty terminal through a fixed no-shell AppleScript adapter; null, missing, ambiguous, and rejected targets show one native Stream Deck alert with no fallback or retry.

**Tech Stack:** TypeScript, Bun and `bun:test`, `bun:sqlite`, Stream Deck's Node.js 24 plugin runtime, official `@elgato/streamdeck` SDK 2.1.0, Rollup, macOS `/usr/bin/osascript`, Ghostty's native AppleScript dictionary, and the existing full local installer.

**Spec:** `docs/superpowers/specs/2026-08-07-claude-ghostty-activation-design.md` (approved by Drew and committed as `02461f1`).

## Global Constraints

- Claude must continue to start through the ordinary `claude` command. Do not add or require a wrapper, shim, alias, shell function, launcher, resume command, or changed hook command.
- V1 supports only a Claude process running directly in Ghostty. If `TERM_PROGRAM !== "ghostty"` or `TMUX` is present, store a null binding. Do not add tmux, screen, SSH, or other-terminal support.
- The identity join is the direct hook helper's immediate `process.ppid` to exactly one Ghostty terminal whose native foreground `pid` is equal. Do not walk ancestors or fall back to TTY, cwd, title, project, window, tab, recency, or frontmost state.
- Require Ghostty's native `id`, `pid`, `tty`, and `focus` capabilities. Detect capability through the AppleScript call; do not parse or branch on a version string.
- The binder must use fixed `/usr/bin/osascript`, no shell, one parent-PID argument, a 300 ms process timeout, and bounded output. It must not write to a TTY, send OSC, mutate cwd/title, poll, sleep, or restore terminal state.
- Native hook JSON never supplies `ghosttyTerminalId`. `decodeNativeHook` initializes it to null, and only the trusted CLI may replace it after native discovery.
- Persist only the stable Ghostty terminal ID. Do not persist PID, TTY, app/window IDs, or a provider-neutral activation target.
- SQLite migrates additively from `user_version = 1` to `2`. Existing rows survive with null bindings. Repeated init at v2 is idempotent; unknown future versions remain untouched.
- A top-level Claude `SessionStart` writes or overwrites the binding, including ID-to-null. Status/subagent events preserve it. `SessionEnd`, `sessions clear`, and `clear-all` delete it with the row.
- Publish only `schemaVersion: 2` at canonical `snapshot-v2.json`. The plugin must reject v1 and unknown snapshot versions; old `snapshot-v1.json` is ignored and not deleted.
- The plugin must check that Ghostty is already running before addressing it. Activation may focus exactly one native terminal by stable ID; it may not open Ghostty, create a terminal/window, launch or resume Claude, type text, or use Accessibility UI scripting.
- A null binding, stale ID, zero/multiple native matches, Apple Events denial, or process failure produces one best-effort `showAlert(context)` and no retry, fallback, registry mutation, or settings mutation.
- Codex and Kimi activation, `NEXT`, paging, layout, rendering, animation, and status meanings remain unchanged. Do not modify `src/plugin/render.ts`, `src/plugin/layout.ts`, or `docs/design.md`; only their typed test fixtures may need the new protocol field.
- Keep Node.js 24, Stream Deck 7.1, macOS 12, SDK schema 3, and `@elgato/streamdeck` 2.1.0 unchanged. Add no dependency.
- Bump the plugin manifest from `0.1.8.2` to `0.1.8.3` before packaging or local installation.
- Tests exercise structured behavior and real SQLite state. Do not snapshot or regex-match complete AppleScript programs, generated bundles, SVG, JSON, or shell commands. A minimal assertion for the non-launching guard and native `focus` call is allowed because those are public safety contracts.
- Every code task follows red-green TDD, runs its focused tests plus the stated broader checks, and commits only its exact files. Never skip or disable pre-commit hooks.
- Source, committed, packaged, migrated-installed, running-daemon, installed-plugin, Apple Events authorization, and physical-key evidence are separate gates. Never infer a later gate from an earlier one.
- Dated spec, plan, and verification records are immutable after their commits. Do not edit earlier dated records.

## File and Interface Map

- Modify `src/protocol.ts`: add the nullable trusted target to `SessionStart` and `ProjectedSession`; replace `SessionSnapshotV1` with strict `SessionSnapshotV2`.
- Modify `src/core/providers.ts`: initialize every decoded `SessionStart.ghosttyTerminalId` to null; raw payload fields remain unable to select a terminal.
- Modify `src/core/paths.ts`: change only the canonical session snapshot filename to `snapshot-v2.json`.
- Modify `src/core/schema.ts`: add the v1-to-v2 `ghostty_terminal_id` migration and set `LATEST_SCHEMA_VERSION = 2`.
- Modify `src/core/registry.ts`: persist, overwrite, preserve, list, and delete the target according to lifecycle rules.
- Modify `src/core/projection.ts`: validate stored target invariants and publish the root's exact nullable target.
- Modify `src/core/daemon.ts`, `src/core/snapshot.ts`, and `src/plugin/snapshot-reader.ts`: produce, write, cache, and consume only `SessionSnapshotV2`.
- Create `src/core/claude-ghostty-binding.ts`: own bounded direct-parent discovery through fixed `/usr/bin/osascript`.
- Modify `src/core/cli.ts` and `src/core/diagnostics.ts`: enrich only Claude SessionStart, remain fail-open, and record only a fixed unbound diagnostic.
- Create `src/plugin/claude-session-activation.ts`: own exact no-shell focus-by-stable-ID behavior.
- Modify `src/plugin/controller.ts` and `src/plugin/plugin.ts`: route captured Claude targets and reuse native alert handling.
- Modify focused tests under `test/`: cover strict v2, additive migration, lifecycle, binder, CLI trust boundary, adapter, controller routing, and unchanged Codex/Kimi behavior.
- Modify `scripts/install-local.ts`: update the schema-version comment; its existing dynamic `LATEST_SCHEMA_VERSION` check performs the real v2 verification.
- Modify `docs/hook-configuration.md`: document ordinary direct Claude/Ghostty requirements without changing hook snippets.
- Modify `com.drewritter.stream-deck-agents.sdPlugin/manifest.json`: truthful Claude interaction text and version `0.1.8.3`.
- Create `docs/verification/2026-08-07-claude-ghostty-activation-local.md`: immutable source/install/native/physical evidence receipt after all gates run.

---

### Task 1: Upgrade the Shared Snapshot Contract to Strict V2

**Files:**
- Modify: `src/protocol.ts`
- Modify: `src/core/providers.ts`
- Modify: `src/core/paths.ts`
- Modify: `src/core/projection.ts`
- Modify: `src/core/daemon.ts`
- Modify: `src/core/snapshot.ts`
- Modify: `src/plugin/snapshot-reader.ts`
- Modify: `test/protocol.test.ts`
- Modify: `test/providers.test.ts`
- Modify: `test/schema.test.ts`
- Modify: `test/projection.test.ts`
- Modify: `test/daemon.test.ts`
- Modify: `test/layout.test.ts`
- Modify: `test/controller.test.ts`
- Modify: `test/render.test.ts`
- Modify: `test/registry.test.ts`

**Interfaces:**
- Produces `SessionStart.ghosttyTerminalId: string | null` with native decoders always setting null.
- Produces `ProjectedSession.ghosttyTerminalId: string | null`.
- Produces `SessionSnapshotV2 = { schemaVersion: 2; health: SnapshotHealth; sessions: ProjectedSession[] }`.
- Preserves `parseSessionSnapshot(value: unknown): SessionSnapshotV2` as the consumer entrypoint, but accepts only v2.
- Preserves `LayoutSettingsV1` and its `schemaVersion: 1`; snapshot versioning and page-settings versioning are independent.

- [ ] **Step 1: Write failing strict-v2 protocol, provider, and path tests**

In `test/protocol.test.ts`, rename the snapshot fixture type and add the required target:

```ts
const valid: SessionSnapshotV2 = {
  schemaVersion: 2,
  health: { status: "ok" },
  sessions: [
    {
      provider: "claude",
      sessionId: "session-1",
      status: "waiting",
      title: "Review",
      project: "stream-deck-agents",
      descendantCount: 2,
      logicalSlot: 1,
      ghosttyTerminalId: "terminal-1",
    },
  ],
};
```

Add focused assertions:

```ts
test("requires a nullable Claude Ghostty terminal ID in schema v2", () => {
  expect(parseSessionSnapshot(withSession({ ghosttyTerminalId: null })).sessions[0]?.ghosttyTerminalId).toBeNull();
  expect(() => parseSessionSnapshot(withSession({ ghosttyTerminalId: "" }))).toThrow();
  expect(() => parseSessionSnapshot(withSession({ ghosttyTerminalId: "x".repeat(257) }))).toThrow();

  const session = { ...firstSession() } as Partial<ProjectedSession>;
  delete session.ghosttyTerminalId;
  expect(() => parseSessionSnapshot({ ...valid, sessions: [session] })).toThrow();
});

test("rejects non-Claude activation targets and every non-v2 schema", () => {
  expect(() => parseSessionSnapshot(withSession({ provider: "codex", ghosttyTerminalId: "terminal-1" }))).toThrow();
  expect(() => parseSessionSnapshot(withSession({ provider: "kimi", ghosttyTerminalId: "terminal-1" }))).toThrow();
  expect(() => parseSessionSnapshot({ ...valid, schemaVersion: 1 })).toThrow();
  expect(() => parseSessionSnapshot({ ...valid, schemaVersion: 3 })).toThrow();
  expect(() => parseSessionSnapshot({ ...valid, schemaVersion: "2" })).toThrow();
});
```

Update the required-property list to include `ghosttyTerminalId`. In `test/providers.test.ts`, require every SessionStart expectation to contain `ghosttyTerminalId: null`, including Claude, Codex, and Kimi. In `test/schema.test.ts`, change only the canonical snapshot assertion:

```ts
expect(paths.snapshot).toBe(join(root, "snapshot-v2.json"));
```

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
bun test test/protocol.test.ts test/providers.test.ts test/schema.test.ts
```

Expected: FAIL because `SessionSnapshotV2` and `ghosttyTerminalId` do not exist, `schemaVersion: 2` is rejected, and the path still ends in `snapshot-v1.json`.

- [ ] **Step 3: Implement the strict shared protocol and trusted null decoder**

In `src/protocol.ts`, make the exact type changes:

```ts
export type RegistryEvent =
  | {
      kind: "SessionStart";
      provider: Provider;
      sessionId: string;
      title: string | null;
      project: string | null;
      ghosttyTerminalId: string | null;
      observedAt: string;
    }
  | {
      kind: "Activity" | "Attention" | "Stop" | "StopFailure";
      provider: Provider;
      sessionId: string;
      observedAt: string;
    }
  | { kind: "SessionEnd"; provider: Provider; sessionId: string; observedAt: string }
  | {
      kind: "SubagentStart";
      provider: Provider;
      sessionId: string;
      parentSessionId: string;
      title: string | null;
      project: string | null;
      observedAt: string;
    }
  | { kind: "SubagentStop"; provider: Provider; sessionId: string; observedAt: string };
```

```ts
export type ProjectedSession = {
  provider: Provider;
  sessionId: string;
  status: SessionStatus;
  title: string | null;
  project: string | null;
  descendantCount: number;
  logicalSlot: number;
  ghosttyTerminalId: string | null;
};

export type SessionSnapshotV2 = {
  schemaVersion: 2;
  health: SnapshotHealth;
  sessions: ProjectedSession[];
};
```

Add one validator that rejects empty target strings while preserving the 256-code-point bound:

```ts
const isNullableNonEmptyBoundedString = (value: unknown): value is string | null =>
  value === null || (isBoundedString(value) && Array.from(value).length > 0);
```

Inside `parseSession`, require `ghosttyTerminalId`, reject a non-null value unless `provider === "claude"`, and return the field unchanged. Inside `parseSessionSnapshot`, require `schemaVersion === 2` and return `SessionSnapshotV2` with `schemaVersion: 2`.

In the SessionStart branch of `src/core/providers.ts`, add exactly:

```ts
ghosttyTerminalId: null,
```

Do not read any terminal-like key from `value` or add one to `SAFE_FIELDS`.

- [ ] **Step 4: Update every snapshot producer, consumer, and typed fixture**

Replace `SessionSnapshotV1` imports/usages with `SessionSnapshotV2` in:

- `src/core/projection.ts`
- `src/core/daemon.ts`
- `src/core/snapshot.ts`
- `src/plugin/snapshot-reader.ts`
- `test/projection.test.ts`
- `test/daemon.test.ts`
- `test/layout.test.ts`

Every session emitted by `projectRows` temporarily includes `ghosttyTerminalId: null`; Task 2 replaces that temporary value with the stored column. Every valid healthy and unhealthy session snapshot literal uses `schemaVersion: 2`. Preserve the deliberate schema-v1 input in the SnapshotCache rejection test so strict-v2 behavior remains covered. Change the canonical filename in `src/core/paths.ts` and snapshot-file test paths to `snapshot-v2.json`.

For each `ProjectedSession` fixture in `test/layout.test.ts`, `test/controller.test.ts`, `test/render.test.ts`, `test/projection.test.ts`, and `test/daemon.test.ts`, add this default before spreading overrides:

```ts
ghosttyTerminalId: null,
```

For every explicitly constructed `RegistryEvent` SessionStart in `test/registry.test.ts` and `test/projection.test.ts`, add:

```ts
ghosttyTerminalId: null,
```

Make the same addition to the SessionStart member of the normalized-union fixture in `test/protocol.test.ts`.

Do not change `LayoutSettingsV1`, layout-settings literals, or their `schemaVersion: 1` assertions.

- [ ] **Step 5: Run focused and full verification to verify GREEN**

Run:

```bash
bun test test/protocol.test.ts test/providers.test.ts test/schema.test.ts test/projection.test.ts test/daemon.test.ts test/layout.test.ts test/controller.test.ts test/render.test.ts test/registry.test.ts
bun test
bun run typecheck
```

Expected: all commands PASS. `rg -n 'SessionSnapshotV1|snapshot-v1.json' src test` returns no matches, while layout settings remain V1.

- [ ] **Step 6: Commit the snapshot-v2 slice**

```bash
git status --short
git add src/protocol.ts src/core/providers.ts src/core/paths.ts src/core/projection.ts src/core/daemon.ts src/core/snapshot.ts src/plugin/snapshot-reader.ts test/protocol.test.ts test/providers.test.ts test/schema.test.ts test/projection.test.ts test/daemon.test.ts test/layout.test.ts test/controller.test.ts test/render.test.ts test/registry.test.ts
git commit -m "core: publish strict session snapshot v2" -m "Add the nullable trusted Claude terminal target to normalized and projected session contracts, move the canonical file to snapshot-v2.json, and reject v1 or non-Claude targets without adding compatibility parsing. Raw provider payloads still initialize the target to null."
```

---

### Task 2: Migrate SQLite and Persist the Claude Terminal Binding

**Files:**
- Modify: `src/core/schema.ts`
- Modify: `src/core/registry.ts`
- Modify: `src/core/projection.ts`
- Modify: `scripts/install-local.ts`
- Modify: `test/schema.test.ts`
- Modify: `test/registry.test.ts`
- Modify: `test/projection.test.ts`
- Modify: `test/cli.test.ts`

**Interfaces:**
- Produces SQLite `user_version = 2` and nullable `active_sessions.ghostty_terminal_id`.
- Produces `ActiveSession.ghosttyTerminalId: string | null` for diagnostics and installed `sessions list` checks.
- Consumes Task 1's `SessionStart.ghosttyTerminalId` and `ProjectedSession.ghosttyTerminalId`.
- Preserves existing transaction, slot, parent, and cascade contracts.

- [ ] **Step 1: Write failing v1-migration and database-invariant tests**

In `test/schema.test.ts`, add a test-local historical v1 fixture using the exact pre-migration schema:

```ts
const createVersion1Database = (path: string): void => {
  const legacy = new Database(path, { create: true, readwrite: true });
  try {
    legacy.exec(`
      CREATE TABLE active_sessions (
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'kimi')),
        session_id TEXT NOT NULL,
        parent_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('idle', 'working', 'waiting', 'error')),
        title TEXT,
        project TEXT,
        logical_slot INTEGER,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, session_id),
        FOREIGN KEY (provider, parent_session_id)
          REFERENCES active_sessions(provider, session_id) ON DELETE CASCADE,
        CHECK (
          (parent_session_id IS NULL AND logical_slot IS NOT NULL AND logical_slot > 0)
          OR
          (parent_session_id IS NOT NULL AND logical_slot IS NULL)
        )
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX active_sessions_unique_slot
        ON active_sessions(logical_slot)
        WHERE logical_slot IS NOT NULL;
      PRAGMA user_version = 1;
    `);
    legacy.run(
      `INSERT INTO active_sessions
         (provider, session_id, parent_session_id, status, title, project, logical_slot, opened_at, updated_at)
       VALUES ('claude', 'legacy', NULL, 'waiting', 'Legacy', 'project', 4, 'opened', 'updated')`,
    );
  } finally {
    legacy.close();
  }
};
```

Add these assertions:

```ts
test("migrates v1 rows additively to v2 with null bindings", () => {
  const paths = resolveAppPaths(tempHome);
  mkdirSync(paths.root, { recursive: true });
  createVersion1Database(paths.database);

  initializeDatabase(paths);

  const db = openRegistryDatabase(paths.database, "readonly");
  try {
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(db.query("SELECT session_id, status, logical_slot, ghostty_terminal_id FROM active_sessions").get()).toEqual({
      session_id: "legacy",
      status: "waiting",
      logical_slot: 4,
      ghostty_terminal_id: null,
    });
  } finally {
    db.close();
  }
});
```

Extend the raw-table contract tests with an exact helper and assertions:

```ts
const insertWithTarget = (
  db: Database,
  provider: "claude" | "codex" | "kimi",
  sessionId: string,
  parentSessionId: string | null,
  logicalSlot: number | null,
  ghosttyTerminalId: string | null,
): void => {
  db.run(
    `INSERT INTO active_sessions
       (provider, session_id, parent_session_id, status, title, project, logical_slot, opened_at, updated_at, ghostty_terminal_id)
     VALUES (?, ?, ?, 'idle', NULL, NULL, ?, 'opened', 'updated', ?)`,
    [provider, sessionId, parentSessionId, logicalSlot, ghosttyTerminalId],
  );
};

test("allows a bounded target only on a top-level Claude row", () => {
  const db = openInitialized();
  try {
    insertWithTarget(db, "claude", "parent", null, 1, "terminal-1");
    insertWithTarget(db, "claude", "null-target", null, 2, null);
    expect(() => insertWithTarget(db, "claude", "empty", null, 3, "")).toThrow();
    expect(() => insertWithTarget(db, "claude", "long", null, 3, "x".repeat(257))).toThrow();
    expect(() => insertWithTarget(db, "codex", "codex", null, 3, "terminal-3")).toThrow();
    expect(() => insertWithTarget(db, "kimi", "kimi", null, 3, "terminal-3")).toThrow();
    expect(() => insertWithTarget(db, "claude", "child", "parent", null, "terminal-child")).toThrow();
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: Write failing registry lifecycle and projection tests**

Extend the `start` helper in `test/registry.test.ts`:

```ts
options: {
  provider?: Provider;
  title?: string | null;
  project?: string | null;
  ghosttyTerminalId?: string | null;
  at?: string;
} = {}
```

and include:

```ts
ghosttyTerminalId: options.ghosttyTerminalId ?? null,
```

Add lifecycle tests that prove:

```ts
applyRegistryEvents(db, [start("bound", { ghosttyTerminalId: "terminal-a" })]);
applyRegistryEvents(db, [simple("Activity", "bound", { at: at(2) })]);
expect(listSessions(db)[0]?.ghosttyTerminalId).toBe("terminal-a");

applyRegistryEvents(db, [start("bound", { ghosttyTerminalId: null, at: at(3) })]);
expect(listSessions(db)[0]).toMatchObject({
  sessionId: "bound",
  logicalSlot: 1,
  ghosttyTerminalId: null,
});
```

Also prove a Codex/Kimi SessionStart carrying an unexpected non-null target is normalized to null, subagent/status events preserve the root target, and SessionEnd/repair deletes it with the row.

In `test/projection.test.ts`, add `ghosttyTerminalId` to `ProjectionRow` fixtures. Prove a Claude root publishes its exact value, a null root publishes null, and pure corrupt inputs reject a target on a child or non-Claude row with a fixed projection error code.

- [ ] **Step 3: Run focused tests to verify RED**

Run:

```bash
bun test test/schema.test.ts test/registry.test.ts test/projection.test.ts test/cli.test.ts
```

Expected: FAIL because schema v2, persistence, listing, and projection do not exist.

- [ ] **Step 4: Implement the additive migration and registry lifecycle**

In `src/core/schema.ts`, set `LATEST_SCHEMA_VERSION = 2` and append this ordered migration after v1:

```ts
const SCHEMA_VERSION_2 = `
ALTER TABLE active_sessions
  ADD COLUMN ghostty_terminal_id TEXT
  CHECK (
    ghostty_terminal_id IS NULL
    OR (
      provider = 'claude'
      AND parent_session_id IS NULL
      AND length(ghostty_terminal_id) BETWEEN 1 AND 256
    )
  );
`;

const MIGRATIONS = [
  { version: 1, sql: SCHEMA_VERSION_1 },
  { version: 2, sql: SCHEMA_VERSION_2 },
] as const;
```

Do not rebuild the table or rewrite existing rows. In `scripts/install-local.ts`, update only the step comment from schema version 1 to 2; keep the dynamic `LATEST_SCHEMA_VERSION` assertion.

In `src/core/registry.ts`:

- add `ghosttyTerminalId`/`ghostty_terminal_id` to `ActiveSession`, `SessionRow`, `COLUMNS`, and `toActiveSession`;
- derive `const ghosttyTerminalId = event.provider === "claude" ? event.ghosttyTerminalId : null;` inside `applySessionStart`;
- include that value in both the existing-row `UPDATE` and new-row `INSERT`;
- include explicit null for child inserts; and
- leave every status-update SQL statement unchanged so it cannot clear the binding.

The repeated-start update becomes:

```sql
UPDATE active_sessions
SET status = 'idle', title = ?, project = ?, ghostty_terminal_id = ?, updated_at = ?
WHERE provider = ? AND session_id = ?
```

- [ ] **Step 5: Project the exact stored root binding defensively**

In `src/core/projection.ts`, add `ghosttyTerminalId` to `ProjectionRow`, `StoredRow`, `PROJECTION_COLUMNS`, and `toProjectionRow`. Validate a non-null ID as 1-256 Unicode code points. Add fixed error codes:

```ts
| "child-with-terminal-binding"
| "non-claude-terminal-binding"
```

Before traversal, reject a child with a non-null target and reject a non-Claude root with one. Replace Task 1's temporary `ghosttyTerminalId: null` projection with:

```ts
ghosttyTerminalId: root.ghosttyTerminalId,
```

Update `test/cli.test.ts` expected `sessions list` shapes to include `ghosttyTerminalId: null` until Task 3 supplies a native binding.

- [ ] **Step 6: Run focused and full verification to verify GREEN**

Run:

```bash
bun test test/schema.test.ts test/registry.test.ts test/projection.test.ts test/cli.test.ts
bun test
bun run typecheck
```

Expected: all commands PASS. The migration test proves row/slot preservation, and registry tests prove ID-to-null overwrite plus status-event preservation.

- [ ] **Step 7: Commit the persistence slice**

```bash
git status --short
git add src/core/schema.ts src/core/registry.ts src/core/projection.ts scripts/install-local.ts test/schema.test.ts test/registry.test.ts test/projection.test.ts test/cli.test.ts
git commit -m "core: persist Claude Ghostty terminal bindings" -m "Migrate active_sessions additively to schema v2, constrain stable terminal IDs to top-level Claude rows, overwrite them only on SessionStart, preserve them across status and subagent activity, and project the exact nullable value into snapshot v2."
```

---

### Task 3: Bind Direct Claude SessionStart to the Native Ghostty Terminal

**Files:**
- Create: `src/core/claude-ghostty-binding.ts`
- Modify: `src/core/cli.ts`
- Modify: `src/core/diagnostics.ts`
- Create: `test/claude-ghostty-binding.test.ts`
- Modify: `test/cli.test.ts`

**Interfaces:**
- Produces `ClaudeGhosttyBindingContext = { termProgram: string | undefined; tmux: string | undefined; parentPid: number }`.
- Produces `DiscoverClaudeGhosttyTerminal = (context: ClaudeGhosttyBindingContext) => Promise<string | null>`.
- Produces `createClaudeGhosttyTerminalDiscoverer(execute: TextProcessExecutor): DiscoverClaudeGhosttyTerminal` and production `discoverClaudeGhosttyTerminal`.
- Adds optional `CliDependencies.discoverClaudeGhosttyTerminal`, `environment`, and `parentPid`, resolved to production values.
- Adds fixed diagnostic code `claude_terminal_unbound`; no native output or process detail enters diagnostics.

- [ ] **Step 1: Write the failing native binder tests**

Create `test/claude-ghostty-binding.test.ts` with a fake text executor that records `{ file, args, timeoutMs }`. Cover these exact cases:

```ts
const eligible = {
  termProgram: "ghostty",
  tmux: undefined,
  parentPid: 65095,
};

test("returns one bounded stable ID from the exact direct parent PID", async () => {
  const calls: ProcessCall[] = [];
  const discover = createClaudeGhosttyTerminalDiscoverer((file, args, timeoutMs) => {
    calls.push({ file, args: [...args], timeoutMs });
    return Promise.resolve("BFCA7AF6-12EF-49C8-BF83-BE0438681348|/dev/ttys000\n");
  });

  await expect(discover(eligible)).resolves.toBe("BFCA7AF6-12EF-49C8-BF83-BE0438681348");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.file).toBe("/usr/bin/osascript");
  expect(calls[0]?.args[0]).toBe("-e");
  expect(calls[0]?.args.slice(-2)).toEqual(["--", "65095"]);
  expect(calls[0]?.timeoutMs).toBe(300);
});
```

Add this eligibility table, asserting `calls` remains empty after each case:

```ts
const ineligible: ClaudeGhosttyBindingContext[] = [
  { ...eligible, termProgram: undefined },
  { ...eligible, termProgram: "Apple_Terminal" },
  { ...eligible, tmux: "session" },
  { ...eligible, tmux: "" },
  { ...eligible, parentPid: 0 },
  { ...eligible, parentPid: 1 },
  { ...eligible, parentPid: -2 },
  { ...eligible, parentPid: 1.5 },
  { ...eligible, parentPid: Number.NaN },
  { ...eligible, parentPid: Number.POSITIVE_INFINITY },
];

for (const context of ineligible) {
  await expect(discover(context)).resolves.toBeNull();
}
expect(calls).toEqual([]);
```

Add a malformed-output table using a fresh eligible discoverer for each value:

```ts
const malformed = [
  "",
  "terminal-only\n",
  "|/dev/ttys000\n",
  `${"x".repeat(257)}|/dev/ttys000\n`,
  "terminal|ttys000\n",
  "terminal|/dev/ttys 000\n",
  "terminal|/dev/ttys000|extra\n",
  "terminal|/dev/ttys000\nsecond|/dev/ttys001\n",
];
for (const stdout of malformed) {
  const malformedDiscover = createClaudeGhosttyTerminalDiscoverer(() => Promise.resolve(stdout));
  await expect(malformedDiscover(eligible)).resolves.toBeNull();
}
```

Finally, prove executor rejection—including the timeout error path—returns null. Zero and multiple native matches are represented by executor rejection because the fixed AppleScript rejects before producing stdout.

Do not assert the complete AppleScript string. Assert only that it contains the non-launching Ghostty-running guard and references native `pid` and `tty`, because those are the discovery safety contract.

- [ ] **Step 2: Run the binder test to verify RED**

Run:

```bash
bun test test/claude-ghostty-binding.test.ts
```

Expected: FAIL because `src/core/claude-ghostty-binding.ts` does not exist.

- [ ] **Step 3: Implement the bounded native binder**

Create `src/core/claude-ghostty-binding.ts` around this fixed program:

```ts
import { execFile } from "node:child_process";

const DISCOVERY_TIMEOUT_MS = 300;
const MAX_OUTPUT_BYTES = 4_096;

const DISCOVER_GHOSTTY_TERMINAL_SCRIPT = `
on run argv
  set targetPid to (item 1 of argv) as integer
  if application "Ghostty" is not running then error "ghostty_not_running"
  tell application "Ghostty"
    set matchingTerminals to {}
    repeat with candidateWindow in windows
      repeat with candidateTerminal in terminals of candidateWindow
        if (pid of candidateTerminal) is targetPid then
          set end of matchingTerminals to candidateTerminal
        end if
      end repeat
    end repeat
    if (count of matchingTerminals) is not 1 then error "ghostty_terminal_match_count"
    set matchedTerminal to item 1 of matchingTerminals
    return (id of matchedTerminal) & "|" & (tty of matchedTerminal)
  end tell
end run`;

export type ClaudeGhosttyBindingContext = {
  termProgram: string | undefined;
  tmux: string | undefined;
  parentPid: number;
};

export type TextProcessExecutor = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

export type DiscoverClaudeGhosttyTerminal = (
  context: ClaudeGhosttyBindingContext,
) => Promise<string | null>;
```

`createClaudeGhosttyTerminalDiscoverer` must gate eligibility before spawning, invoke:

```ts
execute("/usr/bin/osascript", [
  "-e",
  DISCOVER_GHOSTTY_TERMINAL_SCRIPT,
  "--",
  String(context.parentPid),
], DISCOVERY_TIMEOUT_MS)
```

Use this exact eligibility and parsing shape:

```ts
export const createClaudeGhosttyTerminalDiscoverer = (
  execute: TextProcessExecutor,
): DiscoverClaudeGhosttyTerminal =>
  async (context) => {
    if (
      context.termProgram !== "ghostty" ||
      context.tmux !== undefined ||
      !Number.isInteger(context.parentPid) ||
      context.parentPid <= 1
    ) {
      return null;
    }
    try {
      const output = await execute(
        "/usr/bin/osascript",
        ["-e", DISCOVER_GHOSTTY_TERMINAL_SCRIPT, "--", String(context.parentPid)],
        DISCOVERY_TIMEOUT_MS,
      );
      const line = output.replace(/\r?\n$/u, "");
      if (line.includes("\n") || line.includes("\r")) {
        return null;
      }
      const parts = line.split("|");
      if (parts.length !== 2) {
        return null;
      }
      const terminalId = parts[0];
      const tty = parts[1];
      if (
        terminalId === undefined ||
        tty === undefined ||
        Array.from(terminalId).length < 1 ||
        Array.from(terminalId).length > 256 ||
        !/^\/dev\/tty[^/\s]*$/u.test(tty)
      ) {
        return null;
      }
      return terminalId;
    } catch {
      return null;
    }
  };
```

This removes at most one final `\r?\n`, then rejects any remaining line break. It does not trim or rewrite the terminal ID. TTY is validation only and never a second search.

The production executor uses:

```ts
const executeFileText: TextProcessExecutor = (file, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        reject(error);
      },
    );
  });

export const discoverClaudeGhosttyTerminal =
  createClaudeGhosttyTerminalDiscoverer(executeFileText);
```

Do not set `shell`, consult `PATH`, or expose caught error text.

- [ ] **Step 4: Write failing CLI enrichment and trust-boundary tests**

In `test/cli.test.ts`, give `makeHarness` a default injected discoverer returning `"test-ghostty-terminal"` so existing Claude SessionStart tests never call the host AppleScript API. Add tests proving:

```ts
test("enriches only Claude SessionStart from the trusted native discoverer", async () => {
  initRegistry();
  const contexts: ClaudeGhosttyBindingContext[] = [];
  const harness = makeHarness({
    stdin: stdinOf(startEvent("bound")),
    environment: { TERM_PROGRAM: "ghostty" },
    parentPid: 4242,
    discoverClaudeGhosttyTerminal: (context) => {
      contexts.push(context);
      return Promise.resolve("terminal-bound");
    },
  });

  expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
  expect(contexts).toEqual([{ termProgram: "ghostty", tmux: undefined, parentPid: 4242 }]);
  expect(listRows()[0]?.ghosttyTerminalId).toBe("terminal-bound");
  expect(harness.diagnostics).toEqual([]);
});
```

Add one test that runs Codex SessionStart, Kimi SessionStart, Claude Activity, and Claude SubagentStart and proves the discoverer is never called. Include `ghosttyTerminalId: "payload-selected-terminal"` in each native JSON object and assert Codex/Kimi starts still store null while non-start events do not create or change a target. Add one test where discovery returns null and one where it rejects; both must still insert the Claude row with a null target, exit zero, and emit exactly:

```ts
[
  {
    timestamp: NOW,
    component: "cli",
    code: "claude_terminal_unbound",
    provider: "claude",
    sessionId: "unbound",
  },
]
```

- [ ] **Step 5: Enrich Claude SessionStart fail-open in the CLI**

In `src/core/diagnostics.ts`, add `"claude_terminal_unbound"` to `DiagnosticCode`.

In `src/core/cli.ts`, add dependency fields:

```ts
discoverClaudeGhosttyTerminal?: DiscoverClaudeGhosttyTerminal;
environment?: Readonly<Record<string, string | undefined>>;
parentPid?: number;
```

Resolve them to `discoverClaudeGhosttyTerminal`, `process.env`, and `process.ppid`. After successful payload decoding and database open, enrich only the single Claude SessionStart:

```ts
let eventsToApply = events;
const start = events[0];
if (providerArg === "claude" && start?.kind === "SessionStart") {
  let terminalId: string | null = null;
  try {
    terminalId = await deps.discoverClaudeGhosttyTerminal({
      termProgram: deps.environment.TERM_PROGRAM,
      tmux: deps.environment.TMUX,
      parentPid: deps.parentPid,
    });
  } catch {
    terminalId = null;
  }
  if (terminalId === null) {
    report({ code: "claude_terminal_unbound", provider: providerArg, sessionId: start.sessionId });
  }
  eventsToApply = [{ ...start, ghosttyTerminalId: terminalId }];
}
```

Pass `eventsToApply` to the existing retry loop. Discovery runs once before the retry, never once per SQLite attempt. Keep the event path silent and exit-zero.

Because `makeHarness` now supplies `"test-ghostty-terminal"` for ordinary Claude SessionStart, update those existing clean-start row expectations from null to that value. Codex and Kimi row expectations remain null. Tests that explicitly inject a null/rejecting discoverer expect `claude_terminal_unbound`; no other existing diagnostic expectation changes.

- [ ] **Step 6: Run focused and full verification to verify GREEN**

Run:

```bash
bun test test/claude-ghostty-binding.test.ts test/cli.test.ts test/providers.test.ts test/registry.test.ts
bun test
bun run typecheck
```

Expected: all commands PASS. The tests prove native JSON cannot select a target, ineligible/failing discovery still creates a null-bound tile, and native discovery occurs only once for Claude SessionStart.

- [ ] **Step 7: Commit the trusted binding slice**

```bash
git status --short
git add src/core/claude-ghostty-binding.ts src/core/cli.ts src/core/diagnostics.ts test/claude-ghostty-binding.test.ts test/cli.test.ts
git commit -m "core: bind direct Claude sessions to Ghostty terminals" -m "Discover one direct Ghostty terminal from the Claude SessionStart hook's immediate parent PID through a fixed 300 ms no-shell AppleScript call. Keep raw hook payloads outside the trust boundary and preserve fail-open null binding on every native failure."
```

---

### Task 4: Add the No-Launch Ghostty Focus Adapter

**Files:**
- Create: `src/plugin/claude-session-activation.ts`
- Create: `test/claude-session-activation.test.ts`

**Interfaces:**
- Produces `ActivateClaudeSession = (ghosttyTerminalId: string) => Promise<void>`.
- Produces `ProcessExecutor = (file: string, args: readonly string[]) => Promise<void>`.
- Produces `createClaudeSessionActivator(execute: ProcessExecutor): ActivateClaudeSession` and production `activateClaudeSession`.
- Consumes only the bounded stable ID from snapshot v2; never session ID, PID, or TTY.

- [ ] **Step 1: Write the failing activation-adapter tests**

Create `test/claude-session-activation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  createClaudeSessionActivator,
  type ProcessExecutor,
} from "../src/plugin/claude-session-activation";

describe("Claude Ghostty session activation", () => {
  test("passes one stable terminal ID to fixed no-shell osascript", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const execute: ProcessExecutor = (file, args) => {
      calls.push({ file, args: [...args] });
      return Promise.resolve();
    };
    const activate = createClaudeSessionActivator(execute);

    await activate("terminal/one?two space;ü$HOME&`");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/usr/bin/osascript");
    expect(calls[0]?.args[0]).toBe("-e");
    expect(calls[0]?.args.slice(-2)).toEqual(["--", "terminal/one?two space;ü$HOME&`"]);
    expect(calls[0]?.args[1]).toContain('application "Ghostty" is not running');
    expect(calls[0]?.args[1]).toContain("focus matchedTerminal");
  });

  test("propagates native focus rejection", async () => {
    const failure = new Error("focus failed");
    const activate = createClaudeSessionActivator(() => Promise.reject(failure));
    await expect(activate("terminal-id")).rejects.toBe(failure);
  });
});
```

These are two minimal semantic smoke assertions, not a snapshot of the generated program.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
bun test test/claude-session-activation.test.ts
```

Expected: FAIL because `src/plugin/claude-session-activation.ts` does not exist.

- [ ] **Step 3: Implement exact focus-by-ID without launching Ghostty**

Create `src/plugin/claude-session-activation.ts` around this fixed AppleScript:

```ts
import { execFile } from "node:child_process";

const FOCUS_GHOSTTY_TERMINAL_SCRIPT = `
on run argv
  set targetId to item 1 of argv
  if application "Ghostty" is not running then error "ghostty_not_running"
  tell application "Ghostty"
    set matchingTerminals to {}
    repeat with candidateWindow in windows
      repeat with candidateTerminal in terminals of candidateWindow
        if (id of candidateTerminal) is targetId then
          set end of matchingTerminals to candidateTerminal
        end if
      end repeat
    end repeat
    if (count of matchingTerminals) is not 1 then error "ghostty_terminal_match_count"
    set matchedTerminal to item 1 of matchingTerminals
    focus matchedTerminal
  end tell
end run`;

export type ActivateClaudeSession = (ghosttyTerminalId: string) => Promise<void>;
export type ProcessExecutor = (file: string, args: readonly string[]) => Promise<void>;

export const createClaudeSessionActivator = (
  execute: ProcessExecutor,
): ActivateClaudeSession =>
  (ghosttyTerminalId) =>
    execute("/usr/bin/osascript", [
      "-e",
      FOCUS_GHOSTTY_TERMINAL_SCRIPT,
      "--",
      ghosttyTerminalId,
    ]);
```

Implement the production executor with Node's `execFile(file, [...args], callback)` exactly like the existing Codex adapter. Do not set `shell`, invoke `/usr/bin/open`, call `activate`, or add a fallback query.

- [ ] **Step 4: Run focused and full verification to verify GREEN**

Run:

```bash
bun test test/claude-session-activation.test.ts test/codex-session-activation.test.ts test/kimi-session-activation.test.ts
bun test
bun run typecheck
```

Expected: all commands PASS. Shell-significant ID content remains one opaque argument.

- [ ] **Step 5: Commit the plugin adapter slice**

```bash
git status --short
git add src/plugin/claude-session-activation.ts test/claude-session-activation.test.ts
git commit -m "plugin: focus Claude Ghostty terminals by stable ID" -m "Add a fixed no-shell AppleScript adapter that first proves Ghostty is already running, requires one exact native terminal-ID match, and focuses it without opening an app, creating a terminal, launching Claude, or using fallback identity."
```

---

### Task 5: Route Claude Tiles, Wire the Plugin, and Update Product Copy

**Files:**
- Modify: `src/plugin/controller.ts`
- Modify: `src/plugin/plugin.ts`
- Modify: `test/controller.test.ts`
- Modify: `docs/hook-configuration.md`
- Modify: `com.drewritter.stream-deck-agents.sdPlugin/manifest.json`

**Interfaces:**
- Consumes Task 4's `ActivateClaudeSession` and production `activateClaudeSession`.
- Adds required `SessionGridPorts.activateClaudeSession`.
- Preserves existing Codex/Kimi ports and one shared best-effort alert path.
- Resolves activation against the current `KeyModel` exactly once at key-down.

- [ ] **Step 1: Add a distinct Claude activation fake and failing controller tests**

In `test/controller.test.ts`, add `claudeActivation: FakeActivationPort` to `Harness`, instantiate it in `makeController`, and wire `activateClaudeSession: claudeActivation.activate`. Keep the existing `activation` fake as Codex and `kimiActivation` as Kimi.

Add these focused tests:

```ts
test("a bound Claude tile activates its stable terminal ID, not its session ID", async () => {
  const { controller, claudeActivation, alerts } = makeController({
    view: healthyView([
      session(1, {
        provider: "claude",
        sessionId: "claude-session-id",
        ghosttyTerminalId: "ghostty-terminal-id",
      }),
    ]),
  });
  await controller.willAppear(appear("ctx-claude", 0, 0));

  await controller.keyDown("ctx-claude");

  expect(claudeActivation.sessionIds).toEqual(["ghostty-terminal-id"]);
  expect(alerts.contexts).toEqual([]);
});

test("an unbound Claude tile alerts without invoking any activator", async () => {
  const harness = makeController({ view: healthyView([session(1)]) });
  await harness.controller.willAppear(appear("ctx-claude", 0, 0));

  await harness.controller.keyDown("ctx-claude");

  expect(harness.claudeActivation.sessionIds).toEqual([]);
  expect(harness.activation.sessionIds).toEqual([]);
  expect(harness.kimiActivation.sessionIds).toEqual([]);
  expect(harness.alerts.contexts).toEqual(["ctx-claude"]);
});
```

Add tests proving a rejected Claude activation alerts once with no retry, alert rejection is contained, a degraded bound Claude target remains activatable, a reassigned key uses its new current target, repeated presses repeat exact requests, and Codex/Kimi still receive their session IDs rather than `ghosttyTerminalId`.

Use these exact assertion shapes for the rejection and degraded cases:

```ts
test("a rejected Claude focus alerts once with no retry", async () => {
  const harness = makeController({
    view: healthyView([session(1, { ghosttyTerminalId: "stale-terminal" })]),
  });
  harness.claudeActivation.failure = new Error("missing terminal");
  await harness.controller.willAppear(appear("ctx-claude", 0, 0));

  await harness.controller.keyDown("ctx-claude");

  expect(harness.claudeActivation.sessionIds).toEqual(["stale-terminal"]);
  expect(harness.alerts.contexts).toEqual(["ctx-claude"]);
});

test("a degraded bound Claude tile remains activatable", async () => {
  const view = healthyView([session(1, { ghosttyTerminalId: "exact-terminal" })]);
  view.degraded = true;
  const harness = makeController({ view });
  await harness.controller.willAppear(appear("ctx-claude", 0, 0));

  await harness.controller.keyDown("ctx-claude");

  expect(harness.claudeActivation.sessionIds).toEqual(["exact-terminal"]);
});
```

Set `alerts.failure` in a separate test and await `keyDown` to prove rejection is contained. Reuse the existing paging/reassignment setup, but make both page targets Claude sessions with distinct `ghosttyTerminalId` values and assert only the current page's target is called. Extend the current full-provider routing test so Codex/Kimi expectations remain their complete session IDs.

- [ ] **Step 2: Run the controller test to verify RED**

Run:

```bash
bun test test/controller.test.ts
```

Expected: FAIL because the controller has no Claude activation port and still treats Claude as unsupported.

- [ ] **Step 3: Route Claude through the exact captured target**

In `src/plugin/controller.ts`, import `ActivateClaudeSession`, add it to `SessionGridPorts`, and replace the provider ternary in `keyDown` with an explicit switch:

```ts
let activateSession: ((target: string) => Promise<void>) | undefined;
let activationTarget: string | undefined;
switch (model.session.provider) {
  case "claude":
    if (model.session.ghosttyTerminalId === null) {
      await this.showActivationAlert(context);
      return;
    }
    activateSession = this.ports.activateClaudeSession;
    activationTarget = model.session.ghosttyTerminalId;
    break;
  case "codex":
    activateSession = this.ports.activateCodexSession;
    activationTarget = model.session.sessionId;
    break;
  case "kimi":
    activateSession = this.ports.activateKimiSession;
    activationTarget = model.session.sessionId;
    break;
}
```

Defensively return if either local remains undefined, then await the exact pair once:

```ts
if (activateSession === undefined || activationTarget === undefined) {
  return;
}
try {
  await activateSession(activationTarget);
} catch {
  await this.showActivationAlert(context);
}
```

Extract the current nested alert try/catch into:

```ts
private async showActivationAlert(context: string): Promise<void> {
  try {
    await this.ports.showAlert(context);
  } catch {
    // Native key feedback is best-effort; never retry activation.
  }
}
```

Use that helper for both null targets and rejected adapters. Do not clear the target or write settings.

- [ ] **Step 4: Wire production activation and update truthful user documentation**

In `src/plugin/plugin.ts`, import `activateClaudeSession` and provide it beside the Codex/Kimi ports.

In `com.drewritter.stream-deck-agents.sdPlugin/manifest.json`:

- set `Version` to `0.1.8.3`;
- set the action tooltip to `Shows live agent sessions; press Claude, Codex, or Kimi tiles to focus or open them.`; and
- set the description to `Displays live agent sessions from the local registry on a 15-key grid. Press Claude tiles to focus their Ghostty terminals, Codex tiles to open desktop tasks, and Kimi tiles to open Web sessions.`

In the Claude notes of `docs/hook-configuration.md`, add a short activation subsection stating:

- use ordinary `claude` directly in Ghostty;
- Ghostty must expose native terminal `pid` and `tty` properties;
- tmux and other terminals remain display-only/unbound;
- SessionStart discovery failure leaves the tile visible but pressing it alerts; and
- the existing hook snippets remain unchanged and no wrapper is installed.

- [ ] **Step 5: Run focused, full, and bundle verification to verify GREEN**

Run:

```bash
bun test test/controller.test.ts test/claude-session-activation.test.ts test/codex-session-activation.test.ts test/kimi-session-activation.test.ts
bun test
bun run typecheck
bun run build:plugin
```

Expected: all commands PASS. Inspect the manifest diff and confirm only version and truthful interaction copy changed.

- [ ] **Step 6: Commit the completed source feature**

```bash
git status --short
git add src/plugin/controller.ts src/plugin/plugin.ts test/controller.test.ts docs/hook-configuration.md com.drewritter.stream-deck-agents.sdPlugin/manifest.json
git commit -m "plugin: activate bound Claude sessions in Ghostty" -m "Route Claude keys through their snapshot-v2 stable terminal IDs, alert on null or rejected targets, preserve current Codex/Kimi and paging behavior, wire the production focus adapter, and document the direct-Ghostty no-wrapper requirement."
```

---

### Task 6: Verify, Review, Install, and Prove the Physical Path

**Files:**
- Create: `docs/verification/2026-08-07-claude-ghostty-activation-local.md`
- Read: `docs/superpowers/specs/2026-08-07-claude-ghostty-activation-design.md`
- Read: `docs/superpowers/plans/2026-08-07-claude-ghostty-activation.md`
- Read: installed registry, snapshot, manifest, and Ghostty native terminal state without modifying app bundles.

**Interfaces:**
- Consumes all prior committed slices.
- Produces one immutable receipt separating source, package, migration, daemon, installed plugin, native binding, stale/unbound failure, regression, and physical evidence.
- Produces no push, merge, or remote deployment.

This gate requires Drew for physical Stream Deck and exact-terminal observation. Do not substitute screenshots, process output, or adapter exit status for physical focus proof.

- [ ] **Step 1: Run the complete source and package gate from a clean commit**

Invoke `superpowers:verification-before-completion`, then run:

```bash
git status --short --branch
bun test
bun run typecheck
bun run build
bun run pack:plugin
git diff --check
```

Expected: clean working tree before verification; every command exits zero; test output reports zero failures; exactly one `.streamDeckPlugin` package exists under `dist/`.

- [ ] **Step 2: Run one bounded branch review before installation**

Invoke `superpowers:requesting-code-review` for the current branch against `main`. Require the review to inspect:

- immediate-parent PID trust boundary and raw-payload exclusion;
- 300 ms fail-open behavior;
- SQLite v1-to-v2 migration and target invariants;
- strict snapshot-v2 producer/consumer agreement;
- no-launch AppleScript guard and one-argument execution;
- null/stale alert behavior; and
- unchanged Codex/Kimi/NEXT behavior.

If the review finds an actionable issue, invoke `superpowers:receiving-code-review`, reproduce it with a failing test, make the smallest fix, commit it with its exact files, and rerun every Step 1 command before continuing. Do not install with an open actionable finding.

- [ ] **Step 3: Capture installed pre-migration evidence**

Run read-only checks:

```bash
SDA_APP_ROOT="$HOME/Library/Application Support/com.drewritter.stream-deck-agents"
/usr/bin/sqlite3 "$SDA_APP_ROOT/registry.sqlite3" 'PRAGMA user_version; SELECT provider, session_id, logical_slot FROM active_sessions ORDER BY logical_slot;'
/Applications/Ghostty.app/Contents/MacOS/ghostty +version
rg -n 'name="pid"|name="tty"' /Applications/Ghostty.app/Contents/Resources/Ghostty.sdef
```

Expected: installed schema is 1 before migration; current rows and slots are recorded; Ghostty's installed dictionary contains both terminal properties. If the dictionary path differs, locate the installed `.sdef` under `/Applications/Ghostty.app/Contents` with `rg --files` and record that exact path; do not parse a version string as the capability decision.

- [ ] **Step 4: Run the full local installer and verify every installed plane**

Run:

```bash
bun scripts/install-local.ts
```

Accept any Stream Deck package-install confirmation Drew sees. Then run:

```bash
SDA_APP_ROOT="$HOME/Library/Application Support/com.drewritter.stream-deck-agents"
/usr/bin/sqlite3 "$SDA_APP_ROOT/registry.sqlite3" 'PRAGMA user_version; SELECT provider, session_id, logical_slot, ghostty_terminal_id FROM active_sessions ORDER BY logical_slot;'
jq '{schemaVersion, health, sessions: [.sessions[] | {provider, sessionId, logicalSlot, ghosttyTerminalId}]}' "$SDA_APP_ROOT/snapshot-v2.json"
jq -r '.Version' "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.drewritter.stream-deck-agents.sdPlugin/manifest.json"
/bin/launchctl print "gui/$(id -u)/com.drewritter.stream-deck-agents"
```

Expected: database `user_version` is 2; every pre-existing row/slot remains and has null target; snapshot is healthy schema 2; installed manifest is `0.1.8.3`; LaunchAgent is running. Record any Apple Events prompt separately rather than treating permission approval as source proof.

- [ ] **Step 5: Prove two same-directory ordinary Claude sessions bind distinctly**

In two separate Ghostty terminals, `cd` to the same directory and start the ordinary command manually:

```bash
claude
```

Do not use a wrapper, environment shim, tmux, or a launch script. Wait for both SessionStart hooks, then run:

```bash
SDA_REGISTRY_BIN="$HOME/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents"
"$SDA_REGISTRY_BIN" sessions list | jq '[.[] | select(.provider == "claude" and .parentSessionId == null) | {sessionId, project, logicalSlot, ghosttyTerminalId}]'
/usr/bin/osascript -e 'tell application "Ghostty"' -e 'set output to ""' -e 'repeat with candidateWindow in windows' -e 'repeat with candidateTerminal in terminals of candidateWindow' -e 'set output to output & (id of candidateTerminal) & "|" & (pid of candidateTerminal) & "|" & (tty of candidateTerminal) & linefeed' -e 'end repeat' -e 'end repeat' -e 'return output' -e 'end tell'
```

Expected: the two known new Claude rows have distinct non-null terminal IDs; each ID appears exactly once in Ghostty's native output with a PID and `/dev/tty...` path. Same cwd/project must not collapse or swap them.

- [ ] **Step 6: Perform exact physical focus and regression checks with Drew**

With both sessions running:

1. Put Ghostty behind another app.
2. Press Claude tile A and have Drew confirm Ghostty foregrounds terminal A by its unique visible session content.
3. Press Claude tile B and confirm terminal B.
4. Alternate A/B at least three times; every press must select the corresponding terminal, ruling out frontmost/recency coincidence.
5. If overflow exists, exercise a Claude tile on a later page.
6. Press a Codex tile and a Kimi tile; confirm their existing exact activation routes still work.
7. Press `NEXT`; confirm paging and wrap behavior are unchanged.
8. Observe ordinary status rendering and animation; no new target badge or visual state may appear.

An `osascript` exit code or screen observation without Drew's exact-terminal confirmation is not a physical PASS.

- [ ] **Step 7: Prove null and stale targets alert without launching**

For the null case, start one disposable ordinary `claude` session directly in macOS Terminal rather than Ghostty. Confirm its registry row has `ghosttyTerminalId: null`, press its tile, and confirm one Stream Deck alert with no Ghostty terminal/window creation and no new Claude process.

For the stale case, use one disposable bound Ghostty Claude session only:

1. Resolve its exact session ID, stable terminal ID, and PID from the Step 5 outputs.
2. Read and validate those exact values interactively, display the selected PID with `ps`, require a typed confirmation, and kill only that PID so `SessionEnd` cannot remove the row:

```bash
printf 'Disposable Claude PID: ' >&2
IFS= read -r SDA_DISPOSABLE_CLAUDE_PID
case "$SDA_DISPOSABLE_CLAUDE_PID" in
  ''|*[!0-9]*) printf 'PID must contain digits only\n' >&2; exit 1 ;;
esac
/bin/ps -p "$SDA_DISPOSABLE_CLAUDE_PID" -o pid=,ppid=,tty=,command=
printf 'Type KILL-DISPOSABLE-CLAUDE to continue: ' >&2
IFS= read -r SDA_KILL_CONFIRMATION
test "$SDA_KILL_CONFIRMATION" = "KILL-DISPOSABLE-CLAUDE"
/bin/kill -9 "$SDA_DISPOSABLE_CLAUDE_PID"
```

3. Close only that disposable Ghostty terminal through Ghostty's UI, leaving the other Ghostty terminals/app running.
4. Confirm the registry row remains but its stable ID no longer appears in Ghostty's native terminal list.
5. Record Ghostty window/terminal counts and Claude process count, press the stale tile, and confirm one alert with unchanged counts.
6. Repair the disposable row through the installed helper after reading the exact session ID:

```bash
SDA_REGISTRY_BIN="$HOME/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents"
printf 'Disposable Claude session ID: ' >&2
IFS= read -r SDA_DISPOSABLE_SESSION_ID
test -n "$SDA_DISPOSABLE_SESSION_ID"
"$SDA_REGISTRY_BIN" sessions clear claude "$SDA_DISPOSABLE_SESSION_ID"
```

Never use a glob, name-wide `pkill`, broad process match, or another live session.

- [ ] **Step 8: Write the immutable verification receipt**

Create `docs/verification/2026-08-07-claude-ghostty-activation-local.md` and populate every section with observed values and command results:

- branch and commit under test;
- exact source commands and pass/fail counts;
- review result and any corrective commit;
- Ghostty build string plus native `pid`/`tty` capability evidence;
- pre/post schema versions and row/slot preservation evidence;
- running-daemon and snapshot-v2 evidence;
- installed plugin version;
- both same-directory Claude session IDs, stable terminal IDs, PIDs, and TTYs;
- per-tile physical foreground/exact-terminal observations confirmed by Drew;
- null-target alert/no-launch observation;
- stale-target alert/no-launch observation and cleanup result;
- Codex, Kimi, `NEXT`, rendering, and animation regression results; and
- separate final verdicts for source, package, migration, daemon, plugin install, native binding, and physical gates.

Do not include prompts, transcripts, secrets, full native command errors, or unfilled fields. A failed gate is recorded as FAIL with the actual observation, not softened into partial success.

- [ ] **Step 9: Verify and commit only the evidence receipt**

Run:

```bash
git diff --check
git status --short
```

Expected: only the new verification receipt is uncommitted. Then run:

```bash
git add docs/verification/2026-08-07-claude-ghostty-activation-local.md
git commit -m "docs: record Claude Ghostty activation verification" -m "Separate source, package, schema migration, daemon, installed plugin, native binding, alert/no-launch, provider regression, and Drew-confirmed physical Stream Deck evidence for exact direct Claude terminal activation."
git status --short --branch
```

Expected: clean branch. Do not push, merge, or alter another checkout without Drew's explicit request.
