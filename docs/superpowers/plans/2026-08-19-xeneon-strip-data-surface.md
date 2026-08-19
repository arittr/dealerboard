# Xeneon Strip Data Surface (Lane A — Feature 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five additive `ProjectedSession` fields — `unreadSince`, `statusSince`, `activityLine`, `transcriptPath`, `originParentRef` (all `string | null`, all parsing to null when the key is absent) — end to end: schema v11, registry stamping, the Paseo overlay, transcript-tail activity extraction, projection export, and strip rendering (unread dot, ticking status timer, activity footer, exact rail unread count), with a protocol test proving old-plugin/new-daemon and new-app/old-daemon interoperability.

**Architecture:** Spec: `docs/superpowers/specs/2026-08-19-xeneon-strip-features-design.md` (Feature 1 only). The daemon's SQLite registry (`active_sessions`) gains three columns in schema v11 (`status_since`, `origin_parent_ref`, `activity_line` — plain additive ALTERs plus a `status_since` backfill from `updated_at`); `unread_since` (v7) and `transcript_path` (v4/v5) already exist and are only re-exported. The registry stamps `status_since` on a row's own status transitions; the Paseo overlay stamps `origin_parent_ref`; the daemon's 2s session-facts pass writes `activity_line` (claude/codex only, from the transcript tails it already reads). `projectRows` exports all five on the root row; `parseSession` defaults them to null when absent. The strip webview renders the three new marks strip-only — `src/plugin/render.ts` (keypad anatomy) is untouched.

**Tech Stack:** Bun + TypeScript (strict), bun:sqlite, Biome, the Tauri strip webview (DOM/CSS, no test DOM tooling — strip tests are pure-helper only, matching existing `tiles.ts` practice).

## Global Constraints

- `bun run check` (biome ci + build + test) is the full gate; every task ends green on `bun test` and `bun run typecheck`.
- Biome/tsconfig: `noExplicitAny`, `noEvolvingTypes`, `noConsole`, `noProcessEnv`, `noNonNullAssertion` (relaxed in `test/**`), nursery `noFloatingPromises`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` (bracket access), `verbatimModuleSyntax`, `erasableSyntaxOnly`. 2-space, double quotes, semicolons, 120 columns.
- Additive-only snapshot evolution: new fields are optional-with-default in `parseSession` (the `model`/`originKind` precedent); no new providers or statuses.
- Daemon write-back discipline: activity-line writes happen only on change and never touch `updated_at` (the prune lease) — same rule as titles/models.
- `statusSince` tracks the row's OWN status transitions: `BackgroundWorkStarted/Cleared` never restamp; the projection's subtree-lifted effective status never restamps.
- `activityLine` is claude + codex only, ≤64 code points, tool name + short target, never full arguments; null never clears a stored line.
- Quota data NEVER touches `snapshot-v2.json` or `src/protocol.ts` (Lane C's separate file) — this lane adds nothing quota-shaped.
- The Stream Deck tile anatomy (`src/plugin/render.ts`) is UNCHANGED; all rendering additions are strip-only (`app/src/tiles.ts` + `app/styles.css` + `app/src/main.ts`).
- Dated files under `docs/superpowers/` and `docs/verification/` are immutable; docs changes land in `docs/design.md` and `AGENTS.md` only.
- Commit style (from `git log`): conventional, scoped — e.g. `feat(schema): v10 rebuild widening the provider CHECK for grok`, `feat(app): rail with health, clock, unread, pager`.

---
### Task 1: Schema v11 — three data-surface columns

**Files:**
- Modify: `src/core/schema.ts` (LATEST at line 16; new migration after `SCHEMA_VERSION_9` block lines 179-188; MIGRATIONS lines 274-282; pipeline lines 402-431)
- Test: `test/schema.test.ts` (version pins at lines 114, 123, 171, 187, 578, 696, 748, 800, 863, 1010, 1056, 1161, 1266, 1272, 1279)
- Test: `test/cli.test.ts:118` (test name), `test/cli.test.ts:125` (pin), `test/cli.test.ts:1226` (restore stamp)
- Test: `test/daemon.test.ts:254` (`setUserVersion(10)`)
- Test: `test/registry.test.ts` (`Row` type lines 96-115; two full-row `toEqual` assertions at lines 135-154 and 225-244)

**Interfaces:**
- Consumes: the existing migration pipeline (`MIGRATIONS` entries ≤ v9, `migrateToV5`/`migrateToV8`/`migrateToV10` special cases).
- Produces: `LATEST_SCHEMA_VERSION = 11`; `active_sessions` columns `status_since TEXT` (backfilled from `updated_at`), `origin_parent_ref TEXT` (CHECK 1-256), `activity_line TEXT` (CHECK 1-64). Tasks 2/3/5 write them; Task 4 reads them.

Context the spec does not mention (verified in `src/core/schema.ts:368-431`): the v11 entry CANNOT simply join the post-v8 loop, because `migrateToV10` runs unconditionally at the end of the pipeline and would rebuild the table WITHOUT the v11 columns (dropping them and re-stamping 10). Three ordering fixes are required: an upper bound on the post-v8 loop, a `version < 10` gate on `migrateToV10` (same hazard pattern as the existing v8 gate), and a new post-v10 loop.

- [ ] **Step 1: Write the failing tests**

In `test/schema.test.ts`, add a new describe block after the `describe("schema v9", ...)` block (after line 1070). It reuses the existing `createVersion9Database` (lines 1072-1148), `resolveAppPaths`, `initializeDatabase`, `openRegistryDatabase`, and `insertSession` helpers:

```ts
describe("schema v11", () => {
  test("migrates a v10 database to v11, backfilling status_since from updated_at", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion9Database(paths.database);
    initializeDatabase(paths); // v9 → v10 rebuild → v11 in one chain

    // Revert to a true v10 shape so the pure v10 → v11 step is exercised:
    // drop the three columns and re-stamp 10.
    const revert = new Database(paths.database, { readwrite: true });
    try {
      revert.exec(`
        ALTER TABLE active_sessions DROP COLUMN status_since;
        ALTER TABLE active_sessions DROP COLUMN origin_parent_ref;
        ALTER TABLE active_sessions DROP COLUMN activity_line;
        PRAGMA user_version = 10;
      `);
    } finally {
      revert.close();
    }

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 11 });
      expect(
        db
          .query(
            `SELECT session_id, updated_at, status_since, origin_parent_ref, activity_line
             FROM active_sessions ORDER BY session_id`,
          )
          .all(),
      ).toEqual([
        {
          session_id: "child",
          updated_at: "2026-08-06T04:00:00.000Z",
          status_since: "2026-08-06T04:00:00.000Z",
          origin_parent_ref: null,
          activity_line: null,
        },
        {
          session_id: "root",
          updated_at: "2026-08-06T02:00:00.000Z",
          status_since: "2026-08-06T02:00:00.000Z",
          origin_parent_ref: null,
          activity_line: null,
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("enforces the new columns' CHECKs and accepts nulls", () => {
    const paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      insertSession(db, "s1", null, 1);
      // Rows inserted after the migration carry nulls (the backfill only
      // covers pre-existing rows; registry stamping lands in Task 2). The new
      // columns accept ordinary values:
      db.run(
        "UPDATE active_sessions SET origin_parent_ref = 'agent-0', activity_line = 'Bash git status', status_since = '2026-08-19T00:00:00.000Z'",
      );
      expect(db.query("SELECT origin_parent_ref, activity_line, status_since FROM active_sessions").get()).toEqual({
        origin_parent_ref: "agent-0",
        activity_line: "Bash git status",
        status_since: "2026-08-19T00:00:00.000Z",
      });
      expect(() => db.run("UPDATE active_sessions SET origin_parent_ref = ''")).toThrow(/CHECK constraint failed/);
      expect(() => db.run(`UPDATE active_sessions SET origin_parent_ref = '${"x".repeat(257)}'`)).toThrow(
        /CHECK constraint failed/,
      );
      expect(() => db.run("UPDATE active_sessions SET activity_line = ''")).toThrow(/CHECK constraint failed/);
      expect(() => db.run(`UPDATE active_sessions SET activity_line = '${"x".repeat(65)}'`)).toThrow(
        /CHECK constraint failed/,
      );
      // status_since is an unconstrained timestamp column like unread_since.
      db.run("UPDATE active_sessions SET status_since = NULL");
      expect(db.query("SELECT status_since FROM active_sessions").get()).toEqual({ status_since: null });
    } finally {
      db.close();
    }
  });

  test("fresh init lands at v11 with the three columns and repeated init is idempotent", () => {
    const paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);
    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 11 });
      const names = (
        db.query("SELECT name FROM pragma_table_info('active_sessions')").all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(names).toContain("status_since");
      expect(names).toContain("origin_parent_ref");
      expect(names).toContain("activity_line");
    } finally {
      db.close();
    }
  });
});
```

(Note: `createVersion9Database`'s seeded rows are `root` with `updated_at` `2026-08-06T02:00:00.000Z` and `child` with `2026-08-06T04:00:00.000Z` — see `test/schema.test.ts:1122-1136`.)

Also update the existing stale version pins so the suite expresses the new latest:

- `test/schema.test.ts:114` — test name `"initializes a WAL database at user_version 10 ..."` → `... at user_version 11 ...`.
- `test/schema.test.ts` lines 123, 171, 187, 696, 748, 800, 863, 1010, 1056: `toEqual({ user_version: 10 })` → `toEqual({ user_version: 11 })`.
- `test/schema.test.ts` lines 578, 1161, 1266, 1279: `expect(version.user_version).toBe(10)` (or `(db.query(...)...).toBe(10)`) → `.toBe(11)`.
- `test/schema.test.ts:1272` — test name `"fresh init lands at v10 and repeated init is idempotent"` → `... lands at v11 ...`.
- `test/schema.test.ts:857-883` ("fresh init runs the full chain...") — add to the `toContain` list: `expect(names).toContain("status_since"); expect(names).toContain("origin_parent_ref"); expect(names).toContain("activity_line");`
- Do NOT touch fixture-internal starting stamps (`PRAGMA user_version = 1/4/5/6/7/8/9` inside `createVersion*` helpers and per-test setups) or the `99` future-version fixtures.
- `test/cli.test.ts:118` — test name `"creates a version 10 database and stays silent on stdout"` → `version 11`; line 125: `toEqual({ user_version: 10 })` → `toEqual({ user_version: 11 })`.
- `test/cli.test.ts:1226` — `restore.exec("PRAGMA user_version = 10")` → `PRAGMA user_version = 11` (it restores a supported stamp after the `99` experiment).
- `test/daemon.test.ts:254` — `setUserVersion(10)` → `setUserVersion(11)` (re-stamps a supported version so the daemon can open the database).
- `test/registry.test.ts` — the `Row` type (lines 96-115) gains three fields after `unread_since: string | null;`:
  ```ts
  status_since: string | null;
  origin_parent_ref: string | null;
  activity_line: string | null;
  ```
  and the two full-row `toEqual` assertions gain the new keys with their pre-Task-2 values (registry stamping does not exist yet):
  - line 135-154 assertion: add `status_since: null, origin_parent_ref: null, activity_line: null,` (inserts do not name the new columns yet, so they default null).
  - line 225-244 assertion: add the same three nulls.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/schema.test.ts test/registry.test.ts` — Expected: FAIL — `PRAGMA user_version` comes back 10, not 11; the new columns do not exist (`no such column: status_since`); the two registry `toEqual` assertions fail because the actual rows (via `SELECT *`) do not yet have the new keys while the expected objects do. (Bun runs tests without typechecking, so the partially-updated suite still executes.)

- [ ] **Step 3: Implement the v11 migration and the pipeline ordering fixes**

In `src/core/schema.ts`:

1. Line 16: `export const LATEST_SCHEMA_VERSION = 11;`

2. Add after the `SCHEMA_VERSION_9` block (after line 188):

```ts
/**
 * v11 adds the strip's data surface: `status_since` (the row's own status
 * transition stamp, backfilled from updated_at), `origin_parent_ref` (the
 * dispatching Paseo agent's id, stamped by the overlay), and `activity_line`
 * (the last tool call, resolved from transcript tails by the daemon's
 * maintenance pass). Three plain additive ALTERs following the v6 precedent,
 * plus the status_since backfill; they run in one of the shared migration
 * transactions, so a retried init never dies on a duplicate column.
 */
const SCHEMA_VERSION_11 = `
ALTER TABLE active_sessions
  ADD COLUMN status_since TEXT;

ALTER TABLE active_sessions
  ADD COLUMN origin_parent_ref TEXT
  CHECK (origin_parent_ref IS NULL OR length(origin_parent_ref) BETWEEN 1 AND 256);

ALTER TABLE active_sessions
  ADD COLUMN activity_line TEXT
  CHECK (activity_line IS NULL OR length(activity_line) BETWEEN 1 AND 64);

UPDATE active_sessions SET status_since = updated_at;
`;
```

3. Add to `MIGRATIONS` (after the `{ version: 9, ... }` entry at line 281): `{ version: 11, sql: SCHEMA_VERSION_11 },`

4. Update the MIGRATIONS doc comment (lines 261-273): replace the last three sentences ("Entries above v8 and below v10 (v9 acked_at) run in a final transaction after the repair. v10 is special-cased like v5 (`migrateToV10`): a table rebuild that runs strictly last.") with:

```
 * Entries above v8 and at or below v10 (v9 acked_at) run in a third
 * transaction after the repair; the loop's upper bound keeps v11 out of it.
 * v10 is special-cased like v5 (`migrateToV10`): a table rebuild gated on
 * `version < 10` so a v10-or-later database never re-enters it (its
 * unconditional stamp would clobber user_version back to 10 mid-pipeline —
 * the v8 bricking hazard one level up). Entries above v10 (v11) run in a
 * final transaction after the rebuild.
```

5. In `initializeDatabase`, bound the post-v8 loop (lines 419-427) so v11 cannot apply before the v10 rebuild:

```ts
      // Entries above v8 and below v11 (v9) run after the shape repair, whose
      // stamp would otherwise clobber their version back to 8. v11 must wait
      // for the v10 rebuild: the rebuild recreates the table without the v11
      // columns.
      const migratePostV8 = db.transaction(() => {
        for (const migration of MIGRATIONS) {
          if (migration.version > version && migration.version > 8 && migration.version < 11) {
            db.exec(migration.sql);
            db.exec(`PRAGMA user_version = ${migration.version}`);
          }
        }
      });
      migratePostV8();
```

6. Gate the v10 rebuild and add the post-v10 loop (replacing lines 428-430, the unconditional `migrateToV10(db)` call and its comment):

```ts
      // The v10 rebuild owns its transaction (see migrateToV10) and is gated
      // like v8: a v10-or-later database must never re-enter it, or its
      // unconditional stamp clobbers user_version back to 10 mid-pipeline.
      if (version < 10) {
        migrateToV10(db);
      }
      // Entries above v10 (v11) run strictly after the rebuild, whose stamp
      // would otherwise clobber their version back to 10.
      const migratePostV10 = db.transaction(() => {
        for (const migration of MIGRATIONS) {
          if (migration.version > version && migration.version > 10) {
            db.exec(migration.sql);
            db.exec(`PRAGMA user_version = ${migration.version}`);
          }
        }
      });
      migratePostV10();
```

Pipeline verification by version (the reasoning the reviewer should check): fresh (0) → preV5 (1-4) → v5 → postV5 (6,7) → v8 → postV8 (9) → v10 → postV10 (11); v9 database → postV8 skipped (9 > 9 false; 11 excluded by `< 11`) → v10 rebuild → v11; v10 database → only postV10 runs; v11 database → outer `version < LATEST` is false, nothing runs.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/schema.test.ts test/cli.test.ts test/daemon.test.ts test/registry.test.ts` — Expected: PASS (all four files).

- [ ] **Step 5: Commit**

```sh
git add src/core/schema.ts test/schema.test.ts test/cli.test.ts test/daemon.test.ts test/registry.test.ts
git commit -m "feat(schema): v11 data-surface columns (status_since, origin_parent_ref, activity_line)"
```

---
### Task 2: Registry — stamp status_since on own-status transitions

**Files:**
- Modify: `src/core/registry.ts` (`applySessionStart` lines 168-231, `applySubagentStart` lines 308-342, `applyStatusUpdate` lines 352-360, `applyStop` lines 369-379, `applyStopFailure` lines 382-388)
- Test: `test/registry.test.ts` (new describe block; update the two `status_since: null` expectations from Task 1)

**Interfaces:**
- Consumes: schema v11's `status_since` column (Task 1); the existing `StatusEvent` union and `at()`/`start()`/`subStart()`/`simple()`/`getRow()` test helpers.
- Produces: the invariant "`status_since` = the row's own last status-change time, initialized at row creation". Read by Task 4's projection. `COLUMNS`, `ActiveSession`, and `listSessions` are deliberately UNCHANGED (the `acked_at` precedent: columns written and read via targeted SQL stay out of the diagnostic shape).

Rules (locked by the spec): Activity→working, Attention→waiting, Stop→idle (or held working), StopFailure→error restamp ONLY when the status value actually changes; `BackgroundWorkStarted/Cleared` never restamp; SessionStart/SessionObserved initialize on insert; a reused SessionStart restamps only if its idle-reset changes the status; SubagentStart gets the same treatment for child rows (invariant completeness — child values are never exported).

- [ ] **Step 1: Write the failing tests**

In `test/registry.test.ts`, first update the two full-row expectations that Task 1 left as `status_since: null`:

- Line 135-154 assertion (fresh `SessionStart` at `at(1)`): `status_since: null` → `status_since: at(1)`.
- Line 225-244 assertion (reused `SessionStart` at `at(4)` resetting working→idle): `status_since: null` → `status_since: at(4)`.

Then add a new describe block at the end of the file (after the `SessionTitleChanged` describe, line 1116):

```ts
describe("status_since", () => {
  test("initializes at SessionStart and restamps on each own-status transition", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) })]);
    expect(getRow("s1")?.status_since).toBe(at(1));

    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(2) })]);
    expect(getRow("s1")).toMatchObject({ status: "working", status_since: at(2) });

    applyRegistryEvents(db, [simple("Attention", "s1", { at: at(3) })]);
    expect(getRow("s1")).toMatchObject({ status: "waiting", status_since: at(3) });

    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(4) })]);
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(4) });

    applyRegistryEvents(db, [simple("StopFailure", "s1", { at: at(5) })]);
    expect(getRow("s1")).toMatchObject({ status: "error", status_since: at(5) });
  });

  test("a repeated same-status event moves updated_at but never status_since", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) }), simple("Activity", "s1", { at: at(2) })]);
    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(3) })]);
    expect(getRow("s1")).toMatchObject({ status: "working", status_since: at(2), updated_at: at(3) });
  });

  test("BackgroundWorkStarted/Cleared never restamp status_since", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) }), simple("Activity", "s1", { at: at(2) })]);
    applyRegistryEvents(db, [
      simple("BackgroundWorkStarted", "s1", { at: at(3) }),
      simple("BackgroundWorkCleared", "s1", { at: at(4) }),
    ]);
    expect(getRow("s1")).toMatchObject({ status: "working", status_since: at(2), updated_at: at(4) });
  });

  test("a Stop held working by background work does not restamp; the later idle Stop does", () => {
    applyRegistryEvents(db, [
      start("s1", { at: at(1) }),
      simple("Activity", "s1", { at: at(2) }),
      simple("BackgroundWorkStarted", "s1", { at: at(3) }),
    ]);
    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(4) })]);
    expect(getRow("s1")).toMatchObject({ status: "working", status_since: at(2) });

    applyRegistryEvents(db, [simple("BackgroundWorkCleared", "s1", { at: at(5) }), simple("Stop", "s1", { at: at(6) })]);
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(6) });
  });

  test("a reused SessionStart restamps only when its idle-reset changes the status", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) }), simple("Activity", "s1", { at: at(2) })]);
    applyRegistryEvents(db, [start("s1", { at: at(3) })]);
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(3) });

    // Already idle: a further reuse keeps the stamp while moving updated_at.
    applyRegistryEvents(db, [start("s1", { at: at(4) })]);
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(3), updated_at: at(4) });
  });

  test("a late-join SessionObserved insert initializes status_since", () => {
    applyRegistryEvents(db, [
      {
        kind: "SessionObserved",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: null,
        transcriptPath: null,
        model: null,
        observedAt: at(2),
      },
    ]);
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(2) });
  });

  test("SubagentStart initializes a child row's status_since and restamps on its idle reset", () => {
    applyRegistryEvents(db, [start("p", { at: at(1) }), subStart("c", "p", { at: at(2) })]);
    expect(getRow("c")?.status_since).toBe(at(2));

    applyRegistryEvents(db, [simple("Activity", "c", { at: at(3) }), subStart("c", "p", { at: at(4) })]);
    expect(getRow("c")).toMatchObject({ status: "idle", status_since: at(4) });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/registry.test.ts` — Expected: FAIL — the new assertions read `status_since` as null (inserts don't set it; updates don't restamp it), and the two updated expectations fail (`at(1)`/`at(4)` vs null).

- [ ] **Step 3: Implement the stamping**

In `src/core/registry.ts` (all changes are SQL-only; no reads of the new column):

1. `applySessionStart`, reused-identity UPDATE (lines 185-208) — add the restamp CASE to the SET clause and one parameter:

```ts
    db.run(
      `UPDATE active_sessions
       SET status = 'idle', title = ?, project = ?, ghostty_terminal_id = ?, transcript_path = ?,
           background_outstanding = 0, unread_since = NULL,
           status_since = CASE WHEN status IS NOT 'idle' THEN ? ELSE status_since END,
           origin_kind = COALESCE(?, origin_kind),
           origin_ref = CASE WHEN ? IS NOT NULL THEN ? ELSE origin_ref END,
           origin_subagent = CASE WHEN ? IS NOT NULL THEN 0 ELSE origin_subagent END,
           updated_at = ?, model = COALESCE(?, model)
       WHERE provider = ? AND session_id = ?`,
      [
        event.title,
        event.project,
        ghosttyTerminalId,
        event.transcriptPath,
        event.observedAt,
        event.origin?.kind ?? null,
        event.origin?.kind ?? null,
        event.origin?.ref ?? null,
        event.origin?.kind ?? null,
        event.observedAt,
        event.model,
        event.provider,
        event.sessionId,
      ],
    );
```

2. `applySessionStart`, INSERT (lines 211-229) — append `status_since` to the column list and one value:

```ts
  db.run(
    `INSERT INTO active_sessions
       (${COLUMNS}, status_since)
     VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, NULL, ?)`,
    [
      event.provider,
      event.sessionId,
      event.title,
      event.project,
      allocateLowestFreeSlot(db),
      event.observedAt,
      event.observedAt,
      ghosttyTerminalId,
      event.transcriptPath,
      event.model,
      event.origin?.kind ?? null,
      event.origin?.ref ?? null,
      event.observedAt,
    ],
  );
```

(`applySessionObserved`'s late-join path delegates to `applySessionStart`, so it initializes through this INSERT; its existing-row refresh UPDATE never touches status, so it never touches `status_since`.)

3. `applySubagentStart`, reused-child UPDATE (lines 319-324):

```ts
    db.run(
      `UPDATE active_sessions
       SET parent_session_id = ?, status = 'idle', title = ?, project = ?,
           status_since = CASE WHEN status IS NOT 'idle' THEN ? ELSE status_since END,
           updated_at = ?
       WHERE provider = ? AND session_id = ?`,
      [event.parentSessionId, event.title, event.project, event.observedAt, event.observedAt, event.provider, event.sessionId],
    );
```

4. `applySubagentStart`, INSERT (lines 327-340):

```ts
  db.run(
    `INSERT INTO active_sessions
       (${COLUMNS}, status_since)
     VALUES (?, ?, ?, 'idle', ?, ?, NULL, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, 0, NULL, ?)`,
    [
      event.provider,
      event.sessionId,
      event.parentSessionId,
      event.title,
      event.project,
      event.observedAt,
      event.observedAt,
      event.observedAt,
    ],
  );
```

5. `applyStatusUpdate` (lines 352-360):

```ts
const applyStatusUpdate = (db: Database, event: StatusEvent, status: SessionStatus): MutationResult => {
  const result = db.run(
    `UPDATE active_sessions
     SET status = ?, updated_at = ?,
         status_since = CASE WHEN status IS NOT ? THEN ? ELSE status_since END
     WHERE provider = ? AND session_id = ?`,
    [status, event.observedAt, status, event.observedAt, event.provider, event.sessionId],
  );
  return result.changes > 0 ? "applied" : "ignored";
};
```

6. `applyStop` (lines 369-379) — the CASE keys off the same `background_outstanding` branch the status takes:

```ts
const applyStop = (db: Database, event: StatusEvent): MutationResult => {
  const result = db.run(
    `UPDATE active_sessions
     SET status = CASE WHEN background_outstanding = 1 THEN 'working' ELSE 'idle' END,
         unread_since = CASE WHEN background_outstanding = 1 THEN unread_since ELSE ? END,
         status_since = CASE
           WHEN (background_outstanding = 1 AND status IS NOT 'working')
             OR (background_outstanding = 0 AND status IS NOT 'idle')
           THEN ? ELSE status_since END,
         updated_at = ?
     WHERE provider = ? AND session_id = ?`,
    [event.observedAt, event.observedAt, event.observedAt, event.provider, event.sessionId],
  );
  return result.changes > 0 ? "applied" : "ignored";
};
```

7. `applyStopFailure` (lines 382-388):

```ts
const applyStopFailure = (db: Database, event: StatusEvent): MutationResult => {
  const result = db.run(
    `UPDATE active_sessions
     SET status = 'error', unread_since = ?,
         status_since = CASE WHEN status IS NOT 'error' THEN ? ELSE status_since END,
         updated_at = ?
     WHERE provider = ? AND session_id = ?`,
    [event.observedAt, event.observedAt, event.observedAt, event.provider, event.sessionId],
  );
  return result.changes > 0 ? "applied" : "ignored";
};
```

`applyBackgroundWork` (lines 395-401) is deliberately untouched: flag events never restamp.

8. Extend the module doc comment's unread-ledger paragraph (lines 20-23) with one sentence:

```
 * `status_since` records the row's own last status change: status events
 * restamp it only when the status value changes, BackgroundWork events never
 * do, and starts initialize it.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/registry.test.ts test/daemon.test.ts test/cli.test.ts` — Expected: PASS (daemon/cli exercise the registry end to end).

- [ ] **Step 5: Commit**

```sh
git add src/core/registry.ts test/registry.test.ts
git commit -m "feat(registry): stamp status_since on own-status transitions"
```

---
### Task 3: Paseo overlay — origin_parent_ref

**Files:**
- Modify: `src/core/paseo.ts` (`PaseoAgentState` lines 40-49, `parseAgentRecord` lines 145-172, module doc bullet lines 17-19)
- Modify: `src/core/registry.ts` (`PaseoSyncState` lines 582-594, `syncPaseoStates` lines 621-696, `applySessionStart` reuse UPDATE, `applySessionObserved` refresh UPDATE lines 256-271)
- Test: `test/paseo.test.ts` (every loader `toEqual` expectation)
- Test: `test/registry.test.ts` (`paseoState` helper lines 779-794; new tests in the `syncPaseoStates` and `origin` describes)
- Test: `test/daemon.test.ts:526-535` (the `syncPaseoStates` literal gains `parentAgentId: null`)

**Interfaces:**
- Consumes: `parentAgentIdFrom` (`src/core/paseo.ts:101-111`) already extracts the dispatching agent's id; it is currently used only for the boolean `isSubagent` and then discarded.
- Produces: `PaseoAgentState.parentAgentId: string | null` and `PaseoSyncState.parentAgentId: string | null`; matched top-level rows get `origin_parent_ref` stamped (null for non-subagents). Task 4 exports it as `originParentRef`. `cli.ts`'s wiring (`loadPaseoStates(paseoDir).filter(isKnownProviderState)` passed straight into `syncPaseoStates`) needs no change — both types gain the field in lockstep.

- [ ] **Step 1: Write the failing tests**

In `test/paseo.test.ts`, every `loader(AGENTS_DIR)` `toEqual` expectation gains one key — `parentAgentId: null` everywhere except the two parentage tests. Exact spots: lines 66-77, 90-101, 111-122, 187-198, 211-222, 232-243, 276-287, 327-338, 371-382, 398-409, 423-434, 450-461, 480-491 gain `parentAgentId: null,` (place it after the `isSubagent` line); line 139-150 gains `parentAgentId: "agent-1",` (top-level `parentAgentId` fallback); line 166-177 gains `parentAgentId: "agent-1",` (the label shape). Also add one bounding test at the end of the describe (after line 491's test):

```ts
  test("bounds an oversized parent agent id to 256 code points", () => {
    const content = agentRecord({ parentAgentId: "a".repeat(300) });
    const { loader } = makeLoader({
      dirs: oneRecordFs(),
      stats: { [join(AGENTS_DIR, "work/agent-1.json")]: { mtimeMs: 100, size: 500 } },
      files: { [join(AGENTS_DIR, "work/agent-1.json")]: content },
    });
    expect(loader(AGENTS_DIR)[0]?.parentAgentId).toBe("a".repeat(256));
  });
```

In `test/registry.test.ts`:

1. The `paseoState` helper (lines 779-794): add `parentAgentId?: string | null;` to the overrides type and `parentAgentId: overrides.parentAgentId ?? null,` to the returned object (after the `isSubagent` line).

2. Add to the `syncPaseoStates` describe (after the subagent scoping test, line 923):

```ts
  test("stamps the dispatching agent's id as origin_parent_ref and clears it when the record goes top-level", () => {
    applyRegistryEvents(db, [start("s1")]);

    expect(
      syncPaseoStates(db, [paseoState({ isSubagent: true, parentAgentId: "agent-0", attentionTimestamp: FLAG_AT })]),
    ).toBe(1);
    expect(getRow("s1")).toMatchObject({ origin_subagent: 1, origin_parent_ref: "agent-0" });

    // Identical state on the next pass: the difference guard covers the new column.
    expect(
      syncPaseoStates(db, [paseoState({ isSubagent: true, parentAgentId: "agent-0", attentionTimestamp: FLAG_AT })]),
    ).toBe(0);

    // The record loses its parent: both subagent marks clear in one write.
    expect(syncPaseoStates(db, [paseoState({ isSubagent: false, attentionTimestamp: FLAG_AT })])).toBe(1);
    expect(getRow("s1")).toMatchObject({ origin_subagent: 0, origin_parent_ref: null });
  });

  test("the cleared-flag branch keeps origin_parent_ref in sync too", () => {
    applyRegistryEvents(db, [start("s1")]);
    expect(
      syncPaseoStates(db, [paseoState({ isSubagent: true, parentAgentId: "agent-0", attentionTimestamp: FLAG_AT })]),
    ).toBe(1);

    // Viewed in Paseo (cleared flag, fresh updatedAt): unread clears and the
    // parent ref is re-stamped (or kept) by the other branch.
    expect(
      syncPaseoStates(db, [
        paseoState({
          requiresAttention: false,
          isSubagent: true,
          parentAgentId: "agent-0",
          updatedAt: "2026-08-06T00:12:00.000Z",
        }),
      ]),
    ).toBe(1);
    expect(getRow("s1")).toMatchObject({ unread_since: null, origin_parent_ref: "agent-0" });
  });
```

3. Add to the `origin` describe (after the same-origin test, line 598):

```ts
  test("fresh SessionStart origin evidence clears a stored origin_parent_ref with the subagent bit", () => {
    applyRegistryEvents(db, [{ ...start("s1"), origin: { kind: "paseo", ref: "a1" } }]);
    db.run(
      "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE provider = 'claude' AND session_id = 's1'",
    );

    applyRegistryEvents(db, [{ ...start("s1", { at: at(30) }), origin: { kind: "terminal", ref: "ghostty" } }]);
    expect(getRow("s1")).toMatchObject({ origin_kind: "terminal", origin_subagent: 0, origin_parent_ref: null });
  });

  test("a fresh observed origin clears origin_parent_ref too", () => {
    applyRegistryEvents(db, [{ ...start("s1"), origin: { kind: "paseo", ref: "a1" } }]);
    db.run(
      "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE provider = 'claude' AND session_id = 's1'",
    );

    expect(applyRegistryEvents(db, [observedWithOrigin("s1", { kind: "terminal", ref: "ghostty" }, 2)])).toEqual([
      "applied",
    ]);
    expect(getRow("s1")).toMatchObject({ origin_kind: "terminal", origin_subagent: 0, origin_parent_ref: null });
  });
```

(The `origin` describe's `observedWithOrigin` helper is at lines 554-564; the SessionStart mirror of the subagent-bit reset is the documented behavior at lines 545-552.)

In `test/daemon.test.ts`, the `syncPaseoStates` literal (lines 526-535) gains `parentAgentId: null,` after `isSubagent: false,`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/paseo.test.ts test/registry.test.ts` — Expected: FAIL — loader outputs lack `parentAgentId` (every updated `toEqual` fails), and the registry assertions read `origin_parent_ref` as null where they now expect `"agent-0"` / observe it not clearing.

- [ ] **Step 3: Implement the parent-ref carry-through and stamping**

1. `src/core/paseo.ts`:
   - `PaseoAgentState` (lines 40-49): add after `isSubagent: boolean;`:
     ```ts
       /** The dispatching agent's id (labels["paseo.parent-agent-id"], top-level parentAgentId fallback), or null. */
       parentAgentId: string | null;
     ```
   - Module doc parentage bullet (lines 17-19): after "a top-level `.parentAgentId` is honored as a fallback;" append " — the id itself is carried as `parentAgentId` so the registry sync can stamp `origin_parent_ref`;".
   - `parseAgentRecord` (lines 161-171): replace the return's `isSubagent` line and add the field:
     ```ts
       const parentAgentId = parentAgentIdFrom(value);
       return {
         provider,
         sessionId: boundString(sessionId),
         agentId: boundString(id),
         requiresAttention: value["requiresAttention"] === true,
         isSubagent: parentAgentId !== null,
         parentAgentId: parentAgentId === null ? null : boundString(parentAgentId),
         attentionTimestamp: isoTimestampFrom(value["attentionTimestamp"]),
         updatedAt: isoTimestampFrom(value["updatedAt"]),
         title: titleFrom(value),
       };
     ```
     (`parentAgentIdFrom` only returns non-empty strings or null, so `parentAgentId !== null` is equivalent to the old `typeof === "string" && length > 0` check.)

2. `src/core/registry.ts`:
   - `PaseoSyncState` (lines 582-594): add after `isSubagent: boolean;`:
     ```ts
       /** The dispatching Paseo agent's id, or null for a top-level agent. */
       parentAgentId: string | null;
     ```
   - `syncPaseoStates` flagged branch (lines 640-665) — new SQL and params:

     ```ts
           const result = db.run(
             `UPDATE active_sessions
              SET origin_kind = 'paseo', origin_ref = ?, origin_subagent = ?, origin_parent_ref = ?,
                  unread_since = CASE
                    WHEN ? IS NOT NULL AND (acked_at IS NULL OR ? > acked_at) THEN COALESCE(unread_since, ?)
                    ELSE unread_since
                  END
              WHERE provider = ? AND session_id = ? AND parent_session_id IS NULL
                AND (
                  origin_kind IS NOT 'paseo' OR origin_ref IS NOT ? OR origin_subagent IS NOT ?
                  OR origin_parent_ref IS NOT ?
                  OR (? IS NOT NULL AND (acked_at IS NULL OR ? > acked_at) AND unread_since IS NULL)
                )`,
             [
               state.agentId,
               state.isSubagent ? 1 : 0,
               state.parentAgentId,
               flagTime,
               flagTime,
               flagTime,
               state.provider,
               state.sessionId,
               state.agentId,
               state.isSubagent ? 1 : 0,
               state.parentAgentId,
               flagTime,
               flagTime,
             ],
           );
     ```
   - `syncPaseoStates` cleared branch (lines 670-692) — new SQL and params:

     ```ts
           const result = db.run(
             `UPDATE active_sessions
              SET origin_kind = 'paseo', origin_ref = ?, origin_subagent = ?, origin_parent_ref = ?,
                  unread_since = CASE WHEN ? IS NOT NULL AND ? > unread_since THEN NULL ELSE unread_since END
              WHERE provider = ? AND session_id = ? AND parent_session_id IS NULL
                AND (
                  origin_kind IS NOT 'paseo' OR origin_ref IS NOT ? OR origin_subagent IS NOT ?
                  OR origin_parent_ref IS NOT ?
                  OR (unread_since IS NOT NULL AND ? IS NOT NULL AND ? > unread_since)
                )`,
             [
               state.agentId,
               state.isSubagent ? 1 : 0,
               state.parentAgentId,
               state.updatedAt,
               state.updatedAt,
               state.provider,
               state.sessionId,
               state.agentId,
               state.isSubagent ? 1 : 0,
               state.parentAgentId,
               state.updatedAt,
               state.updatedAt,
             ],
           );
     ```
   - `syncPaseoStates` doc comment (lines 596-620): in the "Origin stamping" paragraph, after "(kind/ref/subagent)" write "(and now `origin_parent_ref`)".
   - `applySessionStart` reuse UPDATE (Task 2's version): add one clause after the `origin_subagent` line and one parameter after the third `event.origin?.kind ?? null`:
     ```sql
              origin_parent_ref = CASE WHEN ? IS NOT NULL THEN NULL ELSE origin_parent_ref END,
     ```
     with parameter `event.origin?.kind ?? null` — fresh origin evidence clears a stale parent ref exactly like it resets the subagent bit (the overlay re-stamps within one pass when the record still exists). Extend the reuse comment (lines 179-184): after "while resetting the subagent bit" append "and clearing the parent ref".
   - `applySessionObserved` refresh UPDATE (lines 256-271) — same clause and parameter:
     ```ts
          db.run(
            `UPDATE active_sessions
             SET transcript_path = COALESCE(?, transcript_path), model = COALESCE(?, model),
                 origin_kind = COALESCE(?, origin_kind), origin_ref = COALESCE(?, origin_ref),
                 origin_subagent = CASE WHEN ? IS NOT NULL THEN 0 ELSE origin_subagent END,
                 origin_parent_ref = CASE WHEN ? IS NOT NULL THEN NULL ELSE origin_parent_ref END
             WHERE provider = ? AND session_id = ?`,
            [
              event.transcriptPath,
              event.model,
              origin?.kind ?? null,
              origin?.ref ?? null,
              origin?.kind ?? null,
              origin?.kind ?? null,
              event.provider,
              event.sessionId,
            ],
          );
     ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/paseo.test.ts test/registry.test.ts test/daemon.test.ts` — Expected: PASS. Then `bun run typecheck` — Expected: clean (this task widens two exported types; the pre-commit hook typechecks, so do not commit on a red typecheck).

- [ ] **Step 5: Commit**

```sh
git add src/core/paseo.ts src/core/registry.ts test/paseo.test.ts test/registry.test.ts test/daemon.test.ts
git commit -m "feat(paseo): carry the parent agent id through to origin_parent_ref"
```

---
### Task 4: Protocol + projection — the five fields end to end

**Files:**
- Modify: `src/protocol.ts` (`ProjectedSession` lines 73-86, `parseSession` lines 148-213)
- Modify: `src/core/projection.ts` (`ProjectionRow` lines 30-44, `projectRows` emit lines 183-197, `StoredRow` lines 209-223, `toProjectionRow` lines 228-291, `PROJECTION_COLUMNS` lines 293-294)
- Test: `test/protocol.test.ts` (fixture lines 12-31; new tests)
- Test: `test/projection.test.ts` (`row()` helper lines 18-52; full-shape assertions lines 87-101 and 385-400; `snapshotB` lines 617-632; new tests)
- Test: `test/daemon.test.ts` (`HEALTHY_S1` lines 139-158; rework the "unchanged projection" test lines 215-231)
- Test (mechanical — each session factory gains the five fields with null defaults): `test/press.test.ts:6-20`, `test/strip-routing.test.ts:5-19`, `test/layout.test.ts:16-30`, `test/controller.test.ts:10-24`, `test/render.test.ts:8-22`, `test/tiles.test.ts:5-23`

**Interfaces:**
- Consumes: Tasks 1-3 (the projected columns exist and are stamped).
- Produces (locked names, consumed by Task 6 and Lanes B/C): `ProjectedSession.unreadSince`, `.statusSince`, `.activityLine`, `.transcriptPath`, `.originParentRef`, all `string | null`, all parsing to null when the key is absent. `parseSessionSnapshot` round-trips them.

Ordering note (deviation from the spec's suggested outline, forced by code reality): protocol and projection land in ONE task because the fields are required at the type level — `test/daemon.test.ts` compares raw published snapshots (`harness.writes`) against a full literal with `toEqual`, and Bun treats a missing key as unequal to a present null, so the daemon must actually publish the fields in the same commit that adds them to the literal.

- [ ] **Step 1: Protocol — write the failing tests**

In `test/protocol.test.ts`:

1. The `valid` fixture (lines 12-31): add after `originSubagent: false,`:
   ```ts
         unreadSince: null,
         statusSince: null,
         activityLine: null,
         transcriptPath: null,
         originParentRef: null,
   ```

2. Add three tests at the end of the `parseSessionSnapshot` describe (after the provider tests, line 273):

```ts
  test("defaults the five data-surface fields to null when absent (old daemon snapshot still parses)", () => {
    // Cross-version tolerance, same precedent as model/originKind: a snapshot
    // written before these fields existed parses to nulls.
    const session = { ...firstSession() } as Partial<ProjectedSession>;
    delete session.unreadSince;
    delete session.statusSince;
    delete session.activityLine;
    delete session.transcriptPath;
    delete session.originParentRef;
    expect(parseSessionSnapshot({ ...valid, sessions: [session] }).sessions[0]).toMatchObject({
      unreadSince: null,
      statusSince: null,
      activityLine: null,
      transcriptPath: null,
      originParentRef: null,
    });
  });

  test("plugin compat: a snapshot carrying the five fields parses with values intact", () => {
    // The installed Stream Deck plugin parses the same snapshot-v2.json with
    // this exact parser: new-daemon output must round-trip with values, and
    // old-daemon output must default (the previous test) — old-plugin/new-
    // daemon and new-app/old-daemon interoperate.
    const parsed = parseSessionSnapshot(
      withSession({
        unreadSince: "2026-08-19T00:00:00.000Z",
        statusSince: "2026-08-19T00:01:00.000Z",
        activityLine: "Bash git status",
        transcriptPath: "/Users/drew/.claude/projects/p/s1.jsonl",
        originParentRef: "agent-0",
      }),
    );
    expect(parsed.sessions[0]).toMatchObject({
      unreadSince: "2026-08-19T00:00:00.000Z",
      statusSince: "2026-08-19T00:01:00.000Z",
      activityLine: "Bash git status",
      transcriptPath: "/Users/drew/.claude/projects/p/s1.jsonl",
      originParentRef: "agent-0",
    });
  });

  test("rejects wrongly typed or oversized data-surface fields", () => {
    expect(() => parseSessionSnapshot(withSession({ unreadSince: 7 as unknown as string }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ statusSince: false as unknown as string }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ activityLine: "x".repeat(257) }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ transcriptPath: 0 as unknown as string }))).toThrow();
    // A present undefined is an invalid value, not a missing key.
    expect(() => parseSessionSnapshot(withSession({ originParentRef: undefined as unknown as string }))).toThrow();
  });
```

- [ ] **Step 2: Run the protocol tests to verify they fail**

Run: `bun test test/protocol.test.ts` — Expected: FAIL — the parser ignores the new keys today, so the round-trip test's `toMatchObject` finds them missing, and the defaults test finds no null-valued keys. The rejection test passes vacuously for some inputs (unknown keys are ignored) — that is fine; it pins behavior from step 3 onward.

- [ ] **Step 3: Protocol — implement the five fields**

In `src/protocol.ts`:

1. `ProjectedSession` (lines 73-86): add after `originSubagent: boolean;`:

```ts
  /** ISO-8601 UTC when the latest unviewed result landed; null when nothing is unread. */
  unreadSince: string | null;
  /** ISO-8601 UTC of the row's own last status change (subtree lifts never restamp); null when never stamped. */
  statusSince: string | null;
  /** The last tool call as "Tool target" (≤64 code points; claude/codex only); null otherwise. */
  activityLine: string | null;
  /** The provider transcript path when the registry knows it; null otherwise. */
  transcriptPath: string | null;
  /** The dispatching Paseo agent's id for a paseo subagent; null otherwise. */
  originParentRef: string | null;
```

2. `parseSession`: after the `originSubagent` validation (lines 196-198), add:

```ts
  // The data-surface fields follow the model precedent exactly: a missing key
  // is tolerated as null (snapshots written before they existed stay
  // parseable); a present undefined is an invalid value, not a missing key.
  const unreadSince = "unreadSince" in value ? value["unreadSince"] : null;
  if (!isNullableBoundedString(unreadSince)) {
    return invalid("session.unreadSince must be null or a bounded string");
  }
  const statusSince = "statusSince" in value ? value["statusSince"] : null;
  if (!isNullableBoundedString(statusSince)) {
    return invalid("session.statusSince must be null or a bounded string");
  }
  const activityLine = "activityLine" in value ? value["activityLine"] : null;
  if (!isNullableBoundedString(activityLine)) {
    return invalid("session.activityLine must be null or a bounded string");
  }
  const transcriptPath = "transcriptPath" in value ? value["transcriptPath"] : null;
  if (!isNullableBoundedString(transcriptPath)) {
    return invalid("session.transcriptPath must be null or a bounded string");
  }
  const originParentRef = "originParentRef" in value ? value["originParentRef"] : null;
  if (!isNullableBoundedString(originParentRef)) {
    return invalid("session.originParentRef must be null or a bounded string");
  }
```

   and in the return literal (lines 199-212), after `originSubagent: ...`:

```ts
    unreadSince,
    statusSince,
    activityLine,
    transcriptPath,
    originParentRef,
```

3. Run: `bun test test/protocol.test.ts` — Expected: PASS.

- [ ] **Step 4: Projection — write the failing tests**

In `test/projection.test.ts`:

1. The `row()` helper (lines 18-52): add `statusSince?: string | null; activityLine?: string | null; transcriptPath?: string | null; originParentRef?: string | null;` to the options type, and in the returned object after the `unreadSince` line:

```ts
    statusSince: options.statusSince ?? null,
    activityLine: options.activityLine ?? null,
    transcriptPath: options.transcriptPath ?? null,
    originParentRef: options.originParentRef ?? null,
```

2. The full-shape `toEqual` at lines 87-101: add (note `unreadSince` takes the helper's default `"2026-08-16T00:00:00.000Z"`):

```ts
      unreadSince: "2026-08-16T00:00:00.000Z",
      statusSince: null,
      activityLine: null,
      transcriptPath: null,
      originParentRef: null,
```

3. The `readProjection` full-shape `toEqual` at lines 385-400: add (the parent's own last status change is the Activity at `:04`; its effective `error` is subtree-lifted and never restamps — this assertion pins the spec's documented limitation):

```ts
            unreadSince: null,
            statusSince: "2026-08-06T00:00:04.000Z",
            activityLine: null,
            transcriptPath: null,
            originParentRef: null,
```

4. Add a pure-projection test after the origin test (line 155):

```ts
  test("projects the data-surface fields from the root row", () => {
    const sessions = projectRows([
      row("s", {
        status: "working",
        unreadSince: "2026-08-19T00:02:00.000Z",
        statusSince: "2026-08-19T00:00:00.000Z",
        activityLine: "Bash git status",
        transcriptPath: "/t/s1.jsonl",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-0",
      }),
    ]);
    expect(sessions[0]).toMatchObject({
      unreadSince: "2026-08-19T00:02:00.000Z",
      statusSince: "2026-08-19T00:00:00.000Z",
      activityLine: "Bash git status",
      transcriptPath: "/t/s1.jsonl",
      originParentRef: "agent-0",
    });
  });
```

5. Add an end-to-end `readProjection` test at the end of that describe (after line 604's test):

```ts
  test("carries the data-surface columns through to the snapshot end to end", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "stream-deck-agents-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);

      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "s1",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: "/transcripts/s1.jsonl",
            model: null,
            observedAt: "2026-08-06T00:00:01.000Z",
          },
          { kind: "Stop", provider: "claude", sessionId: "s1", observedAt: "2026-08-06T00:00:02.000Z" },
        ]);
        // activity_line and origin_parent_ref are written by the maintenance
        // pass and the Paseo overlay, never by hook events; set them directly.
        writer.run(
          "UPDATE active_sessions SET activity_line = 'Bash git status', origin_parent_ref = 'agent-0' WHERE provider = 'claude' AND session_id = 's1'",
        );
      } finally {
        writer.close();
      }

      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        const snapshot = readProjection(reader);
        expect(snapshot.sessions[0]).toMatchObject({
          unreadSince: "2026-08-06T00:00:02.000Z",
          statusSince: "2026-08-06T00:00:01.000Z",
          activityLine: "Bash git status",
          transcriptPath: "/transcripts/s1.jsonl",
          originParentRef: "agent-0",
        });
        // The snapshot satisfies the published v2 contract.
        expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
```

   (`statusSince` stays `:01`: the Stop at `:02` is idle→idle, no restamp.)

6. `snapshotB` (lines 617-632): add the five fields with null values after `originSubagent: false,`.

In `test/daemon.test.ts`:

7. `HEALTHY_S1` (lines 139-158): add after `originSubagent: false,` (the fixture session starts and Stops at `NOW`):

```ts
      unreadSince: NOW,
      statusSince: NOW,
      activityLine: null,
      transcriptPath: null,
      originParentRef: null,
```

8. Rework the "unchanged projection" test (lines 215-231). The old second commit (`startSession("s1", LATER)`) now changes the projection — the re-Stop moves `unread_since`, which is exported. Replace the whole test with:

```ts
  test("a commit whose projection is unchanged does not replace the snapshot file", () => {
    startSession("s1");
    const harness = makeHarness();
    harness.daemon.start();
    try {
      const before = statSync(paths.snapshot).ino;
      // BackgroundWorkStarted moves only updated_at and the (unprojected)
      // background flag: the commit bumps data_version without changing any
      // projected column — flag events never restamp status_since.
      apply([{ kind: "BackgroundWorkStarted", provider: "claude", sessionId: "s1", observedAt: LATER }]);
      harness.tick();
      expect(harness.readCount()).toBe(2);
      expect(harness.writes).toHaveLength(1);
      expect(statSync(paths.snapshot).ino).toBe(before);
    } finally {
      harness.daemon.stop();
    }
  });
```

9. Mechanical: every session factory gains the five fields with null defaults (placed after `originSubagent: false,`): `test/press.test.ts:6-20`, `test/strip-routing.test.ts:5-19`, `test/layout.test.ts:16-30`, `test/controller.test.ts:10-24`, `test/render.test.ts:8-22`, `test/tiles.test.ts:5-23` (the tiles factory is a `KeyModel` literal — add the fields inside its inline `session` object after `originSubagent: false,`).

- [ ] **Step 5: Run the projection/daemon tests to verify they fail**

Run: `bun test test/projection.test.ts test/daemon.test.ts` — Expected: FAIL — published/projected sessions lack the five keys (`toEqual`/`toMatchObject` mismatches).

- [ ] **Step 6: Projection — implement the export**

In `src/core/projection.ts`:

1. `ProjectionRow` (lines 30-44): after `unreadSince: string | null;` add:

```ts
  statusSince: string | null;
  activityLine: string | null;
  transcriptPath: string | null;
  originParentRef: string | null;
```

2. `projectRows` emit (lines 183-197): after `originSubagent: root.originSubagent === 1,` add:

```ts
        unreadSince: root.unreadSince,
        statusSince: root.statusSince,
        activityLine: root.activityLine,
        transcriptPath: root.transcriptPath,
        originParentRef: root.originParentRef,
```

3. `StoredRow` (lines 209-223): after `model: unknown;` add:

```ts
  status_since: unknown;
  transcript_path: unknown;
  origin_parent_ref: unknown;
  activity_line: unknown;
```

4. `toProjectionRow`: after the `unread_since` check (lines 273-275) add (the bounded checks mirror the `origin_ref` pattern at lines 266-269; `activity_line` is capped at the column's 64; `status_since` is shape-checked only, like `unread_since`):

```ts
  if (!isStringOrNull(row.status_since)) {
    throw new ProjectionError("corrupt-row");
  }
  if (!isStringOrNull(row.transcript_path) || !isStringOrNull(row.origin_parent_ref) || !isStringOrNull(row.activity_line)) {
    throw new ProjectionError("corrupt-row");
  }
  if (
    typeof row.transcript_path === "string" &&
    (row.transcript_path.length === 0 || Array.from(row.transcript_path).length > 256)
  ) {
    throw new ProjectionError("corrupt-row");
  }
  if (
    typeof row.origin_parent_ref === "string" &&
    (row.origin_parent_ref.length === 0 || Array.from(row.origin_parent_ref).length > 256)
  ) {
    throw new ProjectionError("corrupt-row");
  }
  if (
    typeof row.activity_line === "string" &&
    (row.activity_line.length === 0 || Array.from(row.activity_line).length > 64)
  ) {
    throw new ProjectionError("corrupt-row");
  }
```

   and in the return (lines 276-290) after `unreadSince: row.unread_since,`:

```ts
    statusSince: row.status_since,
    activityLine: row.activity_line,
    transcriptPath: row.transcript_path,
    originParentRef: row.origin_parent_ref,
```

5. `PROJECTION_COLUMNS` (lines 293-294):

```ts
const PROJECTION_COLUMNS =
  "provider, session_id, parent_session_id, status, title, project, logical_slot, ghostty_terminal_id, model, origin_kind, origin_ref, origin_subagent, unread_since, status_since, activity_line, transcript_path, origin_parent_ref";
```

- [ ] **Step 7: Run the full suite and typecheck to verify they pass**

Run: `bun test` — Expected: PASS, all files. Then `bun run typecheck` — Expected: clean (this is where the mechanical factory updates prove out). Then `bun run lint` — Expected: clean.

- [ ] **Step 8: Commit**

```sh
git add src/protocol.ts src/core/projection.ts test/protocol.test.ts test/projection.test.ts test/daemon.test.ts test/press.test.ts test/strip-routing.test.ts test/layout.test.ts test/controller.test.ts test/render.test.ts test/tiles.test.ts
git commit -m "feat(protocol): five additive ProjectedSession fields, projected end to end"
```

---
### Task 5: Activity line — resolver extraction, registry write-back, daemon wiring

**Files:**
- Modify: `src/core/registry.ts` (`SessionActivityLineUpdate` + `updateSessionActivityLines` next to `updateSessionModels` lines 698-716; `TitleTarget` lines 551-559; `listTitleTargets` lines 480-497)
- Modify: `src/core/titles.ts` (imports lines 45/51; new constants/extractors; `SessionFacts` lines 68-72; `claudeFacts` lines 361-377; `codexModel` lines 438-451; resolve loop lines 467-508; module doc lines 9-21)
- Modify: `src/core/daemon.ts` (import line 37; default `resolveFacts` line 145; title pass lines 241-255; header comment lines 15-24 and 45-46)
- Test: `test/titles.test.ts` (factories + inline `TitleTarget` literals; whole-result `toEqual`s; new describe)
- Test: `test/registry.test.ts` (new `updateSessionActivityLines` describe)
- Test: `test/daemon.test.ts` (resolveFacts mocks lines 437, 467-470, 501, 644-652; targets assertion line 442-444; new test)

**Interfaces:**
- Consumes: Task 1's `activity_line` column; the existing `(mtime, size)`-cached tail reads (`claudeFacts`, `codexModel`).
- Produces: `SessionFacts.activities: SessionActivityLineUpdate[]`; `updateSessionActivityLines(db, updates): number`; `TitleTarget.activityLine`; `MAX_ACTIVITY_LINE_CODE_POINTS = 64`. The daemon applies activities in the same 2s pass as titles/models.

Record shapes (pinned by fixtures in the tests; any deviation resolves null, never throws):
- Claude: assistant records carry `message.content` arrays; a `{"type":"tool_use","name":...,"input":{...}}` item is a tool call (shape already pinned by the decoy test at `test/titles.test.ts:260-266`).
- Codex: `{"type":"response_item","payload":{...}}` records (the type pinned at `test/titles.test.ts:320-324`); `payload.type === "function_call"` carries `name` + stringified JSON `arguments`; `payload.type === "local_shell_call"` carries `action.command` argv. Both are handled — current codex rollouts use the latter for shell exec, and handling only the former risks an empty footer on real panels.

- [ ] **Step 1: Write the failing tests**

In `test/titles.test.ts`:

1. Mechanical: every `TitleTarget` literal gains `activityLine: null`. The factories `claudeTarget` (72-79), `ompTarget` (525-532), `grokTarget` (607-614), `zcodeTarget` (409-415) centralize most; the inline literals are at lines 176, 189-191, 200, 204, 216-224, 309-311, 333-337, 359-362, 376-378 (add `activityLine: null,` after `model: null,`).

2. Whole-result `toEqual`s gain `activities: []`: lines 634-637, 664-665, 683-686, 690, 697, 702.

3. Add a new describe at the end of the file:

```ts
describe("activity line resolution", () => {
  const toolUseLine = (name: string, input: Record<string, unknown>): string =>
    `${JSON.stringify({ type: "assistant", message: { model: "claude-fable-5", content: [{ type: "tool_use", name, input }] } })}\n`;

  const responseItemLine = (payload: Record<string, unknown>): string =>
    `${JSON.stringify({ type: "response_item", payload })}\n`;

  test("resolves a claude title, model, and activity line from ONE tail read", () => {
    const { resolver, fs } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: {
        "/transcripts/s1.jsonl": `${aiTitle("Fix the widget")}${toolUseLine("Read", { file_path: "/src/core/registry.ts" })}${toolUseLine("Bash", { command: "git status --short" })}`,
      },
    });
    const result = resolver.resolve([claudeTarget()]);
    expect(result.titles).toEqual([{ provider: "claude", sessionId: "s1", title: "Fix the widget" }]);
    expect(result.models).toEqual([{ provider: "claude", sessionId: "s1", model: "claude-fable-5" }]);
    // The newest assistant record's tool call wins.
    expect(result.activities).toEqual([{ provider: "claude", sessionId: "s1", activityLine: "Bash git status --short" }]);
    expect(fs.tailReads()).toBe(1);
  });

  test("prefers the last tool_use item within the newest assistant record", () => {
    const both = `${JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-fable-5",
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", name: "Edit", input: { file_path: "/b.ts" } },
        ],
      },
    })}\n`;
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": both },
    });
    expect(resolver.resolve([claudeTarget()]).activities).toEqual([
      { provider: "claude", sessionId: "s1", activityLine: "Edit /b.ts" },
    ]);
  });

  test("falls back to an older assistant record when the newest carries no tool call", () => {
    const textOnly = `${JSON.stringify({
      type: "assistant",
      message: { model: "claude-fable-5", content: [{ type: "text", text: "Done." }] },
    })}\n`;
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": `${toolUseLine("Grep", { pattern: "TODO" })}${textOnly}` },
    });
    expect(resolver.resolve([claudeTarget()]).activities).toEqual([
      { provider: "claude", sessionId: "s1", activityLine: "Grep TODO" },
    ]);
  });

  test("takes only a command's first line and truncates the target, never the tool name, to 64 code points", () => {
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": toolUseLine("Bash", { command: `${"x".repeat(100)}\necho second` }) },
    });
    const updates = resolver.resolve([claudeTarget()]).activities;
    expect(updates).toHaveLength(1);
    const line = updates[0]?.activityLine ?? "";
    expect(Array.from(line)).toHaveLength(64);
    expect(line.startsWith("Bash ")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(line.includes("second")).toBe(false);
  });

  test("a tool-less transcript proposes no activity; other providers are never read", () => {
    const { resolver, fs } = makeResolver({
      stats: {
        "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 },
        "/transcripts/k1.jsonl": { mtimeMs: 100, size: 500 },
      },
      tails: {
        "/transcripts/s1.jsonl": aiTitle("Only a title"),
        "/transcripts/k1.jsonl": toolUseLine("Bash", { command: "should not be read" }),
      },
    });
    const result = resolver.resolve([
      claudeTarget(),
      { provider: "kimi", sessionId: "k1", title: null, model: null, transcriptPath: "/transcripts/k1.jsonl", activityLine: null },
    ]);
    expect(result.activities).toEqual([]);
    // The kimi transcript is never even read.
    expect(fs.tailReads()).toBe(1);
  });

  test("a stored-equal activity line proposes no update", () => {
    const { resolver } = makeResolver({
      stats: { "/transcripts/s1.jsonl": { mtimeMs: 100, size: 500 } },
      tails: { "/transcripts/s1.jsonl": toolUseLine("Read", { file_path: "/src/core/registry.ts" }) },
    });
    expect(resolver.resolve([claudeTarget({ activityLine: "Read /src/core/registry.ts" })]).activities).toEqual([]);
  });

  test("resolves a codex function_call's name and command head from the rollout tail", () => {
    const call = responseItemLine({
      type: "function_call",
      name: "shell",
      arguments: JSON.stringify({ command: ["bash", "-lc", "git status --short"], timeout: 1000 }),
    });
    const { resolver, fs } = makeResolver({
      stats: {
        [CODEX_INDEX]: { mtimeMs: 100, size: 300 },
        "/rollouts/c1.jsonl": { mtimeMs: 100, size: 400 },
      },
      wholes: { [CODEX_INDEX]: `${JSON.stringify({ id: "c1", thread_name: "Index name" })}\n` },
      tails: { "/rollouts/c1.jsonl": call },
    });
    const result = resolver.resolve([
      { provider: "codex", sessionId: "c1", title: null, model: null, transcriptPath: "/rollouts/c1.jsonl", activityLine: null },
    ]);
    expect(result.activities).toEqual([
      { provider: "codex", sessionId: "c1", activityLine: "shell bash -lc git status --short" },
    ]);
    expect(fs.tailReads()).toBe(1);
  });

  test("resolves a codex local_shell_call as 'shell <argv head>'", () => {
    const call = responseItemLine({
      type: "local_shell_call",
      action: { type: "exec", command: ["git", "diff", "--stat"] },
    });
    const { resolver } = makeResolver({
      stats: {
        [CODEX_INDEX]: { mtimeMs: 100, size: 300 },
        "/rollouts/c1.jsonl": { mtimeMs: 100, size: 400 },
      },
      wholes: { [CODEX_INDEX]: "" },
      tails: { "/rollouts/c1.jsonl": call },
    });
    expect(
      resolver.resolve([
        { provider: "codex", sessionId: "c1", title: null, model: null, transcriptPath: "/rollouts/c1.jsonl", activityLine: null },
      ]).activities,
    ).toEqual([{ provider: "codex", sessionId: "c1", activityLine: "shell git diff --stat" }]);
  });

  test("a codex function_call with unparseable arguments still names the tool, and non-call items are skipped", () => {
    const truncated = responseItemLine({ type: "function_call", name: "apply_patch", arguments: '{"patch":"***' });
    const message = responseItemLine({ type: "message", role: "assistant" });
    const older = responseItemLine({
      type: "function_call",
      name: "shell",
      arguments: JSON.stringify({ command: "ls" }),
    });
    const { resolver } = makeResolver({
      stats: {
        [CODEX_INDEX]: { mtimeMs: 100, size: 300 },
        "/rollouts/c1.jsonl": { mtimeMs: 100, size: 400 },
      },
      wholes: { [CODEX_INDEX]: "" },
      tails: { "/rollouts/c1.jsonl": `${older}${truncated}` },
    });
    // The newest call wins even with unparseable arguments (name only).
    expect(
      resolver.resolve([
        { provider: "codex", sessionId: "c1", title: null, model: null, transcriptPath: "/rollouts/c1.jsonl", activityLine: null },
      ]).activities,
    ).toEqual([{ provider: "codex", sessionId: "c1", activityLine: "apply_patch" }]);

    const { resolver: second } = makeResolver({
      stats: {
        [CODEX_INDEX]: { mtimeMs: 100, size: 300 },
        "/rollouts/c2.jsonl": { mtimeMs: 100, size: 400 },
      },
      wholes: { [CODEX_INDEX]: "" },
      tails: { "/rollouts/c2.jsonl": `${older}${message}` },
    });
    // A non-call newest record falls through to the older function_call.
    expect(
      second.resolve([
        { provider: "codex", sessionId: "c2", title: null, model: null, transcriptPath: "/rollouts/c2.jsonl", activityLine: null },
      ]).activities,
    ).toEqual([{ provider: "codex", sessionId: "c2", activityLine: "shell ls" }]);
  });
});
```

In `test/registry.test.ts`, add a describe after `updateSessionModels` (line 774), and add `updateSessionActivityLines` to the import from `../src/core/registry` (lines 7-17):

```ts
describe("updateSessionActivityLines", () => {
  test("writes only differing activity lines without touching updated_at", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) }), start("s2", { at: at(2) })]);
    db.run("UPDATE active_sessions SET activity_line = 'Bash ls' WHERE provider = 'claude' AND session_id = 's2'");

    expect(
      updateSessionActivityLines(db, [
        { provider: "claude", sessionId: "s1", activityLine: "Read /src/core/registry.ts" },
        { provider: "claude", sessionId: "s2", activityLine: "Bash ls" },
        { provider: "claude", sessionId: "ghost", activityLine: "Nope" },
      ]),
    ).toBe(1);

    expect(getRow("s1")).toMatchObject({ activity_line: "Read /src/core/registry.ts", updated_at: at(1) });
    expect(getRow("s2")).toMatchObject({ activity_line: "Bash ls", updated_at: at(2) });

    // A second identical pass changes nothing.
    expect(
      updateSessionActivityLines(db, [{ provider: "claude", sessionId: "s1", activityLine: "Read /src/core/registry.ts" }]),
    ).toBe(0);
    expect(getRow("s1")).toMatchObject({ activity_line: "Read /src/core/registry.ts", updated_at: at(1) });
  });
});
```

In `test/daemon.test.ts`:

4. The `resolveFacts` mocks gain `activities: []`: line 437 (`return { titles: [...], models: [] };` → add), lines 467-470, 501, 644-652 (both returns).

5. The targets assertion (lines 442-444) gains `activityLine: null`:
```ts
      expect(targets).toEqual([
        { provider: "claude", sessionId: "s1", title: "Title for s1", transcriptPath: null, model: null, activityLine: null },
      ]);
```

6. Add a test after "applies resolved models through updateSessionModels..." (line 491):

```ts
  test("applies resolved activity lines through updateSessionActivityLines and republishes with them", () => {
    startSession("s1");
    const harness = makeHarness({
      resolveFacts: () => ({
        titles: [],
        models: [],
        activities: [{ provider: "claude" as const, sessionId: "s1", activityLine: "Bash git status" }],
      }),
    });
    harness.daemon.start();
    try {
      expect(readSnapshotFile().sessions[0]?.activityLine).toBe("Bash git status");
      const row = (() => {
        const db = openRegistryDatabase(paths.database, "readonly");
        try {
          return db.query("SELECT activity_line, updated_at FROM active_sessions").get() as {
            activity_line: string;
            updated_at: string;
          } | null;
        } finally {
          db.close();
        }
      })();
      // The activity write leaves updated_at — the prune's aging signal — alone.
      expect(row).toEqual({ activity_line: "Bash git status", updated_at: NOW });
    } finally {
      harness.daemon.stop();
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/titles.test.ts test/registry.test.ts test/daemon.test.ts` — Expected: FAIL — `result.activities` is undefined, `updateSessionActivityLines` is not exported, the daemon test's mock shape is missing the key the implementation will read.

- [ ] **Step 3: Implement the registry half**

In `src/core/registry.ts`:

1. After `SessionModelUpdate` (lines 545-549) add:

```ts
export type SessionActivityLineUpdate = {
  provider: Provider;
  sessionId: string;
  activityLine: string;
};
```

2. After `updateSessionModels` (lines 705-716) add:

```ts
/**
 * Refresh resolved activity lines in one transaction, skipping rows that
 * already hold the value. `updated_at` deliberately stays put, matching
 * `updateSessionTitles`/`updateSessionModels`: a daemon-side maintenance
 * write must not extend a dead session's lease. Returns the number of rows
 * actually changed.
 */
export const updateSessionActivityLines = (db: Database, updates: readonly SessionActivityLineUpdate[]): number =>
  inWriteTransaction(db, () => {
    let changed = 0;
    for (const update of updates) {
      const result = db.run(
        "UPDATE active_sessions SET activity_line = ? WHERE provider = ? AND session_id = ? AND activity_line IS NOT ?",
        [update.activityLine, update.provider, update.sessionId, update.activityLine],
      );
      changed += result.changes;
    }
    return changed;
  });
```

3. `TitleTarget` (lines 551-559): after the `model` line add:

```ts
  /** Stored activity line, for the differs-check that skips no-op write-backs. */
  activityLine: string | null;
```

4. `listTitleTargets` (lines 480-497): the SELECT gains `activity_line`:

```ts
export const listTitleTargets = (db: Database): TitleTarget[] =>
  db
    .query(
      `SELECT provider, session_id, title, model, activity_line, transcript_path FROM active_sessions
       WHERE parent_session_id IS NULL
       ORDER BY logical_slot ASC`,
    )
    .all()
    .map((row) => {
      const { provider, session_id, title, model, activity_line, transcript_path } = row as {
        provider: Provider;
        session_id: string;
        title: string | null;
        model: string | null;
        activity_line: string | null;
        transcript_path: string | null;
      };
      return { provider, sessionId: session_id, title, model, activityLine: activity_line, transcriptPath: transcript_path };
    });
```

   Also update the function's doc comment (lines 475-479): "every top-level row's identity, stored title, model, and transcript path" → "every top-level row's identity, stored title, model, activity line, and transcript path".

- [ ] **Step 4: Implement the resolver half**

In `src/core/titles.ts`:

1. Imports: line 45 → `import type { SessionActivityLineUpdate, SessionModelUpdate, SessionTitleUpdate, TitleTarget } from "./registry";` and line 51 → `export type { SessionActivityLineUpdate, SessionModelUpdate, SessionTitleUpdate, TitleTarget } from "./registry";`

2. After `MAX_TITLE_CODE_POINTS` (line 49) add:

```ts
/** The activity footer's cap, mirrored by the activity_line column CHECK (1-64). */
export const MAX_ACTIVITY_LINE_CODE_POINTS = 64;
```

3. `SessionFacts` (lines 68-72) gains the third proposal list:

```ts
/** The facts one pass proposes: title, model, and activity-line updates, applied additively. */
export type SessionFacts = {
  titles: SessionTitleUpdate[];
  models: SessionModelUpdate[];
  activities: SessionActivityLineUpdate[];
};
```

4. After `boundTitle` (line 148) add the extraction machinery:

```ts
const ACTIVITY_TARGET_KEYS = ["file_path", "path", "command", "pattern", "query", "url"] as const;

/** A command's head is its first line; the rest never crosses the wire. */
const firstLine = (value: string): string => value.split("\n", 1)[0] ?? value;

/** Join an all-string argv, or null when the value is not one. */
const stringArrayJoin = (value: unknown): string | null => {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (!value.every((item) => typeof item === "string")) {
    return null;
  }
  return (value as string[]).join(" ");
};

/**
 * A tool call's short target: the first known path/command/pattern-style
 * input key (string, or string array joined), first line only. Never full
 * arguments — matching the payload-minimality posture.
 */
const activityTargetFrom = (input: Record<string, unknown>): string | null => {
  for (const key of ACTIVITY_TARGET_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return firstLine(value);
    }
    const joined = stringArrayJoin(value);
    if (joined !== null && joined.length > 0) {
      return firstLine(joined);
    }
  }
  return null;
};

/**
 * Compose "Tool target", truncating the target (never the tool name) with an
 * ellipsis so the whole line stays within MAX_ACTIVITY_LINE_CODE_POINTS — the
 * registry's activity_line CHECK rejects anything longer.
 */
const composeActivityLine = (toolName: string, target: string | null): string => {
  const name = Array.from(toolName).slice(0, MAX_ACTIVITY_LINE_CODE_POINTS).join("");
  if (target === null) {
    return name;
  }
  const budget = MAX_ACTIVITY_LINE_CODE_POINTS - Array.from(name).length - 1;
  if (budget < 1) {
    return name;
  }
  const points = Array.from(target);
  if (points.length === 0) {
    return name;
  }
  const kept = points.length > budget ? `${points.slice(0, budget - 1).join("")}…` : target;
  return `${name} ${kept}`;
};

/**
 * The last tool call in a Claude transcript tail: assistant records carry
 * content arrays whose tool_use items name the tool and its input. Records
 * scan newest-first and items newest-first within a record, so the result is
 * the most recent call; records without tool use fall through to older ones.
 */
const claudeActivityFromTail = (tail: string): string | null =>
  lastFromTail(tail, "assistant", (record) => {
    const message = record["message"];
    if (!isRecord(message) || !Array.isArray(message["content"])) {
      return null;
    }
    const content: unknown[] = message["content"];
    for (let index = content.length - 1; index >= 0; index -= 1) {
      const item = content[index];
      if (isRecord(item) && item["type"] === "tool_use" && typeof item["name"] === "string" && item["name"].length > 0) {
        const input = isRecord(item["input"]) ? item["input"] : {};
        return composeActivityLine(item["name"], activityTargetFrom(input));
      }
    }
    return null;
  });

/** Lift a short target from a function_call's stringified JSON arguments; null when unparseable. */
const codexArgumentsTarget = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? activityTargetFrom(parsed) : null;
  } catch {
    return null;
  }
};

/**
 * The last tool call in a Codex rollout tail: response_item records whose
 * payload is a function_call (name plus stringified JSON arguments) or a
 * local_shell_call (an exec action's argv, shown as "shell <argv head>").
 * Arguments are parsed only to lift a short target — never carried whole.
 */
const codexActivityFromTail = (tail: string): string | null =>
  lastFromTail(tail, "response_item", (record) => {
    const payload = record["payload"];
    if (!isRecord(payload)) {
      return null;
    }
    if (payload["type"] === "function_call" && typeof payload["name"] === "string" && payload["name"].length > 0) {
      return composeActivityLine(payload["name"], codexArgumentsTarget(payload["arguments"]));
    }
    if (payload["type"] === "local_shell_call") {
      const action = payload["action"];
      const joined = isRecord(action) ? stringArrayJoin(action["command"]) : null;
      return composeActivityLine("shell", joined === null ? null : firstLine(joined));
    }
    return null;
  });
```

5. `claudeFacts` (lines 361-377) returns the third fact, cached together; the `claudeCache` type (line 354) and the function become:

```ts
  const claudeCache = new Map<string, FileStat & { title: string | null; model: string | null; activity: string | null }>();
```

```ts
  const claudeFacts = (path: string): { title: string | null; model: string | null; activity: string | null } => {
    const stat = statPath(path);
    if (stat === null) {
      // A missing transcript is re-statted every pass; the failure is cheap
      // and there is no identity to cache against.
      return { title: null, model: null, activity: null };
    }
    const cached = claudeCache.get(path);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { title: cached.title, model: cached.model, activity: cached.activity };
    }
    const tail = readTail(path, TAIL_BYTES);
    const title = tail === null ? null : claudeTitleFromTail(tail);
    const model = tail === null ? null : claudeModelFromTail(tail);
    const activity = tail === null ? null : claudeActivityFromTail(tail);
    claudeCache.set(path, { ...stat, title, model, activity });
    return { title, model, activity };
  };
```

6. `codexModel` (lines 438-451) becomes `codexRolloutFacts` (same cache, both facts), with the cache type at line 357 widened:

```ts
  const codexModelCache = new Map<string, FileStat & { model: string | null; activity: string | null }>();
```

```ts
  const codexRolloutFacts = (path: string): { model: string | null; activity: string | null } => {
    const stat = statPath(path);
    if (stat === null) {
      return { model: null, activity: null };
    }
    const cached = codexModelCache.get(path);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { model: cached.model, activity: cached.activity };
    }
    const tail = readTail(path, TAIL_BYTES);
    const model = tail === null ? null : codexModelFromTail(tail);
    const activity = tail === null ? null : codexActivityFromTail(tail);
    codexModelCache.set(path, { ...stat, model, activity });
    return { model, activity };
  };
```

7. The resolve loop (lines 467-508): add `let resolvedActivity: string | null = null;` beside `resolvedModel`; the claude branch gains `resolvedActivity = facts.activity;`; the codex branch's model read becomes:

```ts
          if (target.transcriptPath !== null) {
            const facts = codexRolloutFacts(target.transcriptPath);
            resolvedModel = facts.model;
            resolvedActivity = facts.activity;
          }
```

   the proposals gain (after the models push, line 502-504):

```ts
        if (resolvedActivity !== null && resolvedActivity !== target.activityLine) {
          activities.push({ provider: target.provider, sessionId: target.sessionId, activityLine: resolvedActivity });
        }
```

   the `activities` array is declared beside `titles`/`models` (line 469-470) and returned: `return { titles, models, activities };`

8. Module doc (lines 9-21): extend the Claude bullet after "one read serves both facts" → "one read serves all three facts"; add to the Codex bullet after the model sentence: "The same tail read yields the activity line: the last function_call or local_shell_call as `Tool target` (≤64 code points, arguments never carried whole)."; and extend the resolution paragraph (lines 34-39): "Resolution is additive: a found title, model, or activity line is proposed only when it differs from the stored one, and a missing value never clears an existing one."

- [ ] **Step 5: Wire the daemon**

In `src/core/daemon.ts`:

1. Import (line 37) — the one-liner exceeds 120 columns, so use the wrapped form:

```ts
import {
  listTitleTargets,
  pruneStaleSessions,
  updateSessionActivityLines,
  updateSessionModels,
  updateSessionTitles,
} from "./registry";
```

2. Default dep (line 145): `resolveFacts: () => ({ titles: [], models: [], activities: [] }),`

3. The title pass (lines 249-254): after the models write add:

```ts
        if (facts.activities.length > 0 && updateSessionActivityLines(this.connection, facts.activities) > 0) {
          changed = true;
        }
```

4. Comments: line 45-46 "How often session facts (titles, models) are resolved from provider files." → "(titles, models, activity lines)"; header lines 15-17 "a session-facts pass (resolve session titles and models from provider files, update rows that changed)" → "(resolve session titles, models, and activity lines from provider files, ...)".

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test test/titles.test.ts test/registry.test.ts test/daemon.test.ts` — Expected: PASS. Then `bun test && bun run typecheck && bun run lint` — Expected: all clean.

- [ ] **Step 7: Commit**

```sh
git add src/core/registry.ts src/core/titles.ts src/core/daemon.ts test/titles.test.ts test/registry.test.ts test/daemon.test.ts
git commit -m "feat(titles): resolve claude/codex activity lines from transcript tails"
```

---
### Task 6: Strip rendering — unread dot, status timer, activity footer, exact rail count

**Files:**
- Modify: `app/src/tiles.ts` (module doc lines 1-8; `sessionTile` lines 24-56; new exported helpers)
- Modify: `app/src/snapshot-view.ts` (new `countUnreadSessions`)
- Modify: `app/src/main.ts` (header comment lines 1-6; remove `unreadCount` lines 45-54; `renderRailNow` lines 67-84; new ticker; interval line 141)
- Modify: `app/styles.css` (new rules after `.badge` line 147 and after `.title` line 161; compact tier lines 276-305)
- Test: `test/tiles.test.ts` (factory line 5-23 gains an overrides param; new describes)
- Test: `test/strip-snapshot-view.test.ts` (new `countUnreadSessions` describe)

**Interfaces:**
- Consumes: Task 4's `ProjectedSession.unreadSince/.statusSince/.activityLine`; the existing 1s `setInterval(renderRailNow, 1000)` cadence (`app/src/main.ts:141`); the `renderedSignature` skip (`app/src/main.ts:94-110`).
- Produces: `statusLineText(status, statusSince, nowMs): string | null`, `stripTileExtras(session, nowMs): StripTileExtras`, `countUnreadSessions(snapshot): number`. Lane B touches `main.ts`/`tiles.ts` too — sequence or rebase between lanes (spec §Lane structure).

There is no DOM test tooling in this repo (no jsdom/happy-dom; `renderTiles` itself is untested today) — the strip tests pin the pure helpers, and DOM structure is verified by typecheck, `bun run build:app`, and the on-panel checklist.

- [ ] **Step 1: Write the failing tests**

In `test/tiles.test.ts`:

1. The `session` factory (lines 5-23) gains an overrides parameter (its Task 4 form already carries the five nulls):

```ts
const session = (slot: number, overrides: Partial<ProjectedSession> = {}): Extract<KeyModel, { kind: "session" }> => ({
  kind: "session",
  session: {
    provider: "claude",
    sessionId: `s${slot}`,
    project: null,
    title: null,
    model: null,
    status: "idle",
    originKind: null,
    originRef: null,
    originSubagent: false,
    unreadSince: null,
    statusSince: null,
    activityLine: null,
    transcriptPath: null,
    originParentRef: null,
    ghosttyTerminalId: null,
    descendantCount: 0,
    logicalSlot: slot,
    ...overrides,
  },
  label: `Session ${slot}`,
  degraded: false,
});
```

2. Imports (line 2): `import { statusLineText, stripGridLayout, stripTileExtras, visibleStripKeys } from "../app/src/tiles";` and add `import type { ProjectedSession } from "../src/protocol";`.

3. Add at the end of the file:

```ts
describe("statusLineText", () => {
  const NOW_MS = Date.parse("2026-08-19T00:10:00.000Z");

  test("formats compact elapsed labels across the unit boundaries", () => {
    expect(statusLineText("working", "2026-08-19T00:09:18.000Z", NOW_MS)).toBe("working 42s");
    expect(statusLineText("working", "2026-08-19T00:09:00.000Z", NOW_MS)).toBe("working 1m");
    expect(statusLineText("waiting", "2026-08-18T23:58:00.000Z", NOW_MS)).toBe("waiting 12m");
    expect(statusLineText("error", "2026-08-18T22:10:00.000Z", NOW_MS)).toBe("error 2h");
    expect(statusLineText("idle", "2026-08-16T00:10:00.000Z", NOW_MS)).toBe("idle 3d");
  });

  test("clamps a future stamp to 0s and returns null for a missing or unparseable one", () => {
    expect(statusLineText("working", "2026-08-20T00:00:00.000Z", NOW_MS)).toBe("working 0s");
    expect(statusLineText("working", null, NOW_MS)).toBeNull();
    expect(statusLineText("working", "not a timestamp", NOW_MS)).toBeNull();
  });
});

describe("stripTileExtras", () => {
  const NOW_MS = Date.parse("2026-08-19T00:10:00.000Z");

  test("derives the extras from the session's data-surface fields", () => {
    const withNews = session(1, {
      unreadSince: "2026-08-19T00:05:00.000Z",
      status: "working",
      statusSince: "2026-08-19T00:08:00.000Z",
      activityLine: "Bash git status",
    });
    expect(stripTileExtras(withNews.session, NOW_MS)).toEqual({
      unread: true,
      statusLine: "working 2m",
      activityLine: "Bash git status",
    });
  });

  test("a session without the fields shows no extras (old-daemon snapshot)", () => {
    expect(stripTileExtras(session(2).session, NOW_MS)).toEqual({
      unread: false,
      statusLine: null,
      activityLine: null,
    });
  });

  test("the unread flag tracks the ledger stamp, not the status — an acked error tile drops it", () => {
    const ackedError = session(3, { status: "error", unreadSince: null });
    expect(stripTileExtras(ackedError.session, NOW_MS).unread).toBe(false);
    const unreadError = session(4, { status: "error", unreadSince: "2026-08-19T00:01:00.000Z" });
    expect(stripTileExtras(unreadError.session, NOW_MS).unread).toBe(true);
  });
});
```

In `test/strip-snapshot-view.test.ts`:

4. Imports: `import { countUnreadSessions, reduceSnapshotRead, type SnapshotRead } from "../app/src/snapshot-view";` and `import type { ProjectedSession, SessionSnapshotV2 } from "../src/protocol";` (the file currently imports only `SessionSnapshotV2` as a type — extend it).

5. Add at the end of the file:

```ts
const session = (overrides: Partial<ProjectedSession>): ProjectedSession => ({
  provider: "claude",
  sessionId: "s1",
  status: "idle",
  title: null,
  project: null,
  descendantCount: 0,
  logicalSlot: 1,
  ghosttyTerminalId: null,
  model: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  unreadSince: null,
  statusSince: null,
  activityLine: null,
  transcriptPath: null,
  originParentRef: null,
  ...overrides,
});

describe("countUnreadSessions", () => {
  test("counts exactly the sessions carrying an unread stamp", () => {
    const snapshot = healthy([
      session({ sessionId: "idle-unread", unreadSince: "2026-08-19T00:00:00.000Z" }),
      session({ sessionId: "working-unread", status: "working", unreadSince: "2026-08-19T00:01:00.000Z", logicalSlot: 2 }),
      session({ sessionId: "idle-read", logicalSlot: 3 }),
      session({ sessionId: "error-read", status: "error", logicalSlot: 4 }),
    ]);
    // The old approximation (on-grid idle+error) would count 3; the ledger counts 2.
    expect(countUnreadSessions(snapshot)).toBe(2);
  });

  test("an empty or unread-free snapshot counts zero", () => {
    expect(countUnreadSessions(healthy())).toBe(0);
    expect(countUnreadSessions(healthy([session({})]))).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/tiles.test.ts test/strip-snapshot-view.test.ts` — Expected: FAIL — `statusLineText`, `stripTileExtras`, and `countUnreadSessions` are not exported (module resolution/undefined-function failures).

- [ ] **Step 3: Implement the tiles.ts extras**

In `app/src/tiles.ts`:

1. Imports (lines 10-11): add `import type { ProjectedSession, SessionStatus } from "../../src/protocol";`.

2. Module doc (lines 1-8): after "degraded flag." add "Strip-only extras: unread dot, ticking status timer, activity footer (no keypad counterpart)."

3. After `appendText` (line 22) add:

```ts
/** Compact elapsed label for the status timer: 42s, 12m, 3h, 2d. */
const elapsedLabel = (elapsedMs: number): string => {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
};

/**
 * The per-tile status timer text ("working 12m"), or null when the row's own
 * status stamp is absent or unparseable — an old daemon simply shows no line.
 */
export const statusLineText = (status: SessionStatus, statusSince: string | null, nowMs: number): string | null => {
  if (statusSince === null) {
    return null;
  }
  const startedMs = Date.parse(statusSince);
  if (Number.isNaN(startedMs)) {
    return null;
  }
  return `${status} ${elapsedLabel(nowMs - startedMs)}`;
};

/** The strip-only tile extras derived from the session's data-surface fields. */
export type StripTileExtras = {
  /** Unread dot: the exact ledger flag, not the on-grid idle+error proxy. */
  unread: boolean;
  statusLine: string | null;
  activityLine: string | null;
};

export const stripTileExtras = (session: ProjectedSession, nowMs: number): StripTileExtras => ({
  unread: session.unreadSince !== null,
  statusLine: statusLineText(session.status, session.statusSince, nowMs),
  activityLine: session.activityLine,
});
```

4. `sessionTile` (lines 24-56): compute the extras after `const { session } = model;`, render the dot inline in the topband between the model label and the badge (the badge keeps `margin-left: auto` at the far right), and the two bottom lines after the title. The full replacement function:

```ts
const sessionTile = (model: Extract<KeyModel, { kind: "session" }>, index: number): HTMLElement => {
  const { session } = model;
  const extras = stripTileExtras(session, Date.now());
  const tile = document.createElement("div");
  tile.className = `tile session status-${session.status}`;
  tile.dataset["keyIndex"] = String(index);

  const topband = document.createElement("div");
  topband.className = "topband";
  const chip = appendText(topband, "chip", PROVIDER_LETTERS[session.provider]);
  chip.dataset["provider"] = session.provider;
  if (session.model !== null) {
    appendText(topband, "model", modelLabel(session.model, STRIP_MODEL_LABEL_MAX_CODE_POINTS));
  }
  if (extras.unread) {
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    topband.append(dot);
  }
  if (session.descendantCount > 0) {
    appendText(topband, "badge", String(session.descendantCount));
  }
  tile.append(topband);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = model.label;
  tile.append(title);

  if (session.statusSince !== null && extras.statusLine !== null) {
    const line = appendText(tile, "statusline", extras.statusLine);
    // The ticker recomputes textContent from these two dataset values.
    line.dataset["status"] = session.status;
    line.dataset["since"] = session.statusSince;
  }
  if (extras.activityLine !== null) {
    appendText(tile, "activity", extras.activityLine);
  }

  if (session.originKind === "paseo") {
    const pip = document.createElement("span");
    pip.className = session.originSubagent ? "pip subagent" : "pip parent";
    tile.append(pip);
  }
  if (model.degraded) {
    appendText(tile, "flag", "!");
  }
  return tile;
};
```

- [ ] **Step 4: Implement the styles**

In `app/styles.css`:

1. After the `.badge` block (line 147) add:

```css
.unread-dot {
  flex: none;
  width: 1vw;
  height: 1vw;
  border-radius: 50%;
  background: #ffb020;
}
```

2. After the `.title` block (line 161) add:

```css
/* Strip-only bottom lines: status timer and activity footer. The horizontal
   padding keeps them clear of the absolutely positioned flag/pip corners. */
.statusline,
.activity {
  padding: 0 7%;
  color: #94a3b8;
  font-size: 1.2vw;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

3. In the compact tier (`@container (max-height: 40vh)`, lines 278-304), add inside the block (after the `.flag` rule):

```css
  .unread-dot {
    width: 0.8vw;
    height: 0.8vw;
  }
  .statusline,
  .activity {
    font-size: 0.95vw;
  }
```

- [ ] **Step 5: Implement the exact rail count and the ticker**

1. In `app/src/snapshot-view.ts`, after `reduceSnapshotRead` (line 48) add:

```ts
/**
 * Exact unread count: sessions carrying an unviewed-result stamp. Replaces
 * the on-grid idle+error approximation — the wire now carries the ledger
 * field, so an acked tile stops counting immediately.
 */
export const countUnreadSessions = (snapshot: SessionSnapshotV2): number =>
  snapshot.sessions.filter((session) => session.unreadSince !== null).length;
```

2. In `app/src/main.ts`:
   - Imports (line 14): `import { countUnreadSessions, reduceSnapshotRead } from "./snapshot-view";` and line 15: add `statusLineText` to the tiles import: `import { renderTiles, statusLineText, stripGridLayout, visibleStripKeys } from "./tiles";`. Add `import type { SessionStatus } from "../../src/protocol";` (merge with the line-10 import: `import type { SessionSnapshotV2, SessionStatus, SnapshotView } from "../../src/protocol";`).
   - Delete the `unreadCount` function and its now-false comment (lines 45-54).
   - `renderRailNow` (line 77): `unreadCount: unreadCount(currentView),` → `unreadCount: countUnreadSessions(currentView.snapshot),`.
   - Add the ticker (after `renderRailNow`):

```ts
/**
 * Tick every rendered status timer's textContent in place. The DOM nodes and
 * the JSON render signature are untouched, so the renderedSignature skip and
 * the CSS status animations are never disturbed by a tick.
 */
const tickStatusLines = (): void => {
  const nowMs = Date.now();
  for (const line of document.querySelectorAll<HTMLElement>("#tiles .statusline")) {
    const status = line.dataset["status"];
    const since = line.dataset["since"];
    if (status === undefined || since === undefined) {
      continue;
    }
    const text = statusLineText(status as SessionStatus, since, nowMs);
    if (text !== null && line.textContent !== text) {
      line.textContent = text;
    }
  }
};
```

   - `start()` (line 141): `setInterval(renderRailNow, 1000);` →
     ```ts
     setInterval(() => {
       renderRailNow();
       tickStatusLines();
     }, 1000);
     ```
   - Header comment (lines 1-6): after "Page settings persist to localStorage; the reducer validates them on every read." add "A 1s timer ticks the rail clock and the per-tile status timers in place."

- [ ] **Step 6: Run the tests and the app build to verify they pass**

Run: `bun test test/tiles.test.ts test/strip-snapshot-view.test.ts` — Expected: PASS. Then `bun test && bun run typecheck && bun run lint && bun run build:app` — Expected: all clean; the app bundle builds.

- [ ] **Step 7: Commit**

```sh
git add app/src/tiles.ts app/src/snapshot-view.ts app/src/main.ts app/styles.css test/tiles.test.ts test/strip-snapshot-view.test.ts
git commit -m "feat(app): strip unread dot, status timer, activity footer, exact rail count"
```

---
### Task 7: Docs — design.md strip anatomy + AGENTS.md staleness sweep

**Files:**
- Modify: `docs/design.md` (schema sentence line 96; strip tile anatomy lines 313-334; rail lines 336-340)
- Modify: `AGENTS.md` (unread-ledger bullet lines 129-143; origin bullet lines 144-162; status-model bullet lines 104-128; titles bullet lines 188-205; daemon bullet lines 206-210; strip bullet lines 211-229)

**Interfaces:**
- Consumes: Tasks 1-6 (the shipped behavior).
- Produces: documentation matching code reality. No code changes; `bun run lint` covers nothing here, so verification is a read-through plus the full gate.

- [ ] **Step 1: docs/design.md**

1. Line 96 (the unread-ledger sentence inside "Membership, not completion history"): replace

```
Unread is a per-session ledger (`unread_since`, added in schema v7; the current schema is v10 (v10 widens the provider CHECK for grok) — v8 repaired pre-merge v7 databases missing the `model` column, v9 adds the `acked_at` ack watermark).
```

   with

```
Unread is a per-session ledger (`unread_since`, added in schema v7; the current schema is v11 — v8 repaired pre-merge v7 databases missing the `model` column, v9 added the `acked_at` ack watermark, v10 widened the provider CHECK for grok, and v11 added `status_since`, `origin_parent_ref`, and `activity_line` for the strip's data surface).
```

2. In the strip "Tile anatomy" section, add a bullet after the origin-pip bullet (lines 331-333) and before the degraded-tile bullet (line 334):

```
- Strip-only marks, with no keypad counterpart (`src/plugin/render.ts` is
  unchanged): an amber `#FFB020` unread dot in the topband whenever the
  session carries an unviewed-result stamp (the exact `unreadSince` ledger
  field, not a status proxy); a neutral-chrome status timer line at the tile
  bottom ("working 12m" — compact s/m/h/d elapsed against `statusSince`, the
  row's own status stamp, ticking once a second by in-place `textContent`
  updates so the render-signature skip and CSS animations are never
  disturbed); and a neutral-chrome activity footer naming the agent's last
  tool call ("Bash git status" — ≤64 code points, tool name plus a
  path/command head, never full arguments; claude and codex sessions only).
```

3. In the strip "Rail" section (line 339): replace "- A clock and the unread count (the on-grid idle+error tiles)." with "- A clock and the exact unread count (tiles whose session carries an `unreadSince` stamp)."

- [ ] **Step 2: AGENTS.md**

1. Unread-ledger bullet (lines 129-133): replace "stamps `unread_since` (added in schema v7; v8 was a shape-repair stamp; the current latest, v10, widens\n  the provider CHECK for grok (v9 added the `acked_at` watermark));" with "stamps `unread_since` (added in schema v7; v8 was a shape-repair stamp; the current latest, v11, adds `status_since` (backfilled from `updated_at`), `origin_parent_ref`, and `activity_line`; v10 widened the provider CHECK for grok (v9 added the `acked_at` watermark));" (keep the line wrapping consistent with the file's ~110-column style).

2. Status-model bullet: after the sentence ending "...lifts it to at least `working` (`src/core/projection.ts`)." (line 126-128) add:

```
  `status_since` (schema v11) records the row's own last status transition:
  Activity/Attention/Stop/StopFailure restamp it only when the status value
  actually changes, BackgroundWork events never restamp it, starts initialize
  it, and the projection's subtree-lifted effective status never touches it —
  a parent held working by live children shows its own timer.
```

3. Origin bullet (lines 147-156): replace "stamps origin\n  plus the subagent bit (Paseo persists the dispatching agent as\n  `labels[\"paseo.parent-agent-id\"]`; a top-level `parentAgentId` is honored\n  as a fallback), and mirrors" with "stamps origin\n  plus the subagent bit (Paseo persists the dispatching agent as\n  `labels[\"paseo.parent-agent-id\"]`; a top-level `parentAgentId` is honored\n  as a fallback) and the dispatching agent's id as `origin_parent_ref`, and mirrors". (Match the actual line breaks when editing; the sense is: add the origin_parent_ref clause.)

4. Titles bullet (lines 199-201): replace "it resolves model ids\n  alongside titles." with "it resolves model ids and the strip's activity\n  line alongside titles (claude/codex only: the last tool call in the\n  transcript tail as `Tool target`, ≤64 code points, name plus a\n  path/command head — never full arguments; written back only on change)." Also line 203-204 "Titles and models are written back without touching `updated_at`" → "Titles, models, and activity lines are written back without touching `updated_at`".

5. Daemon bullet (line 206-207): "it owns maintenance (titles and models\n  every 2s, ..." → "it owns maintenance (titles, models, and activity lines\n  every 2s, ...".

6. Strip bullet (lines 220-229): after "keep the two in sync via `docs/design.md`." add " Strip-only tile extras (no keypad counterpart): an amber unread dot (the exact `unreadSince` ledger flag), a ticking `statusSince` timer line, and an `activityLine` footer; the timer rewrites `textContent` in place on the 1s rail cadence so the `renderedSignature` skip is never disturbed." And replace "The rail's unread count is an approximation — the on-grid idle+error tiles — so an acked error session lingers as counted until its next lifecycle event." with "The rail's unread count is exact: sessions with a non-null `unreadSince`."

- [ ] **Step 3: Verify**

Run: `bun run check` — Expected: PASS (docs-only change, but this re-proves the whole gate). Read the two edited docs end to end for sentence flow.

- [ ] **Step 4: Commit**

```sh
git add docs/design.md AGENTS.md
git commit -m "docs: strip data-surface anatomy, schema v11 notes"
```

---
## Manual on-panel verification checklist

Prereqs: deploy the core+plugin (`bun scripts/install-local.ts` — full reinstall: daemon, plist, packaged plugin; the plugin's visible contract is unchanged, so no manifest Version bump is needed — the installed plugin's parser ignores the new keys, and `awaitPluginInstall` is satisfied when versions already match) and the strip app (`bun run install:app`). Restart the strip from the Xeneon display.

- [ ] Registry migrated: `/usr/bin/sqlite3 "$HOME/Library/Application Support/com.drewritter.stream-deck-agents/registry.sqlite3" 'PRAGMA user_version;'` prints `11`, and `SELECT session_id, status_since, updated_at FROM active_sessions;` shows `status_since` backfilled equal to `updated_at` for pre-existing rows.
- [ ] Unread dot: a session that finishes a turn (Stop → idle, unread) shows the amber dot in the topband; pressing the tile (ack) removes it on the next snapshot and the rail's unread count drops by exactly one — including for an error tile (the old approximation could not do this).
- [ ] Status timer: a working session shows "working Ns" climbing; at 60s it flips to "1m". An Attention event flips the text to "waiting 0s" and the timer restarts. A parent held working only by a live subagent keeps ITS OWN elapsed time (documented limitation).
- [ ] Timer tick smoothness: the four-second status wash/breathe animations never restart while the timer ticks (only `textContent` changes; the DOM is not rebuilt — watch a waiting tile for ~30s).
- [ ] Activity footer: a claude session running a tool shows e.g. "Bash git status" (name + short target, no long arguments); a codex session shows its last function_call/local_shell_call. kimi/pi/omp/zcode/deepseek/grok tiles show no footer. If codex footers never populate on real rollouts, capture one rollout's tail record shapes and reconcile with `codexActivityFromTail` before declaring done.
- [ ] Old-daemon tolerance (optional, simulates the downgrade path): the five keys are absent → no dot, no timer, no footer, rail count exact-fallback (zero). Covered in code by the parser-default tests; on-panel only if convenient.
- [ ] Stream Deck grid: tiles render and behave exactly as before (no anatomy change); the grid never degrades from the new fields.
- [ ] Degradation: stop the daemon (`launchctl bootout gui/$UID/com.drewritter.stream-deck-agents`); within ~10s the strip shows OFFLINE/degraded with the last-good tiles; restart (`launchctl bootstrap` via re-run of the installer, or reboot-less `launchctl kickstart -k gui/$UID/com.drewritter.stream-deck-agents`) and it recovers.

## Final gate

- [ ] `bun run check` — biome ci + typecheck + build + full test suite, all green.
- [ ] `git log --oneline -8` — seven lane commits in order (schema → registry → paseo → protocol/projection → titles → app → docs).
