# Board Card Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the board's card-clearing rules so reading a result or finishing work never removes a card — cards leave only by explicit user gestures (dismiss, clear, archive) or a 24h clock that starts when the user views the result.

**Architecture:** Six coordinated changes across the registry (`viewSession` vs `acknowledgeSession`-as-dismiss, Paseo passive-view deletion, ended cards, viewed-expiry sweep, unviewed-aware prune), the projection (Paseo roll-up with `pendingResults` badge and aggregated unread), the CLI (`sessions view`), and the app (tap = view, flick/sheet = dismiss, causal watermarks). SQLite stays the source of truth; the snapshot wire gains two additive fields.

**Tech Stack:** TypeScript on Bun (`bun:sqlite`), Tauri app (TypeScript webview + Rust host), Stream Deck plugin untouched.

**Spec:** `docs/superpowers/specs/2026-08-27-board-card-retention/spec.md` (ratified). **Decisions:** `docs/superpowers/specs/2026-08-27-board-card-retention/decisions.md` — settled, do not re-litigate.

## Global Constraints

- Commands: targeted tests `bun test <file>`; typecheck `bun run typecheck` (checks root **and** `app/tsconfig.json`); lint `biome check .`; full gate `bun run check` (= `biome ci . && bun run build && bun test`).
- **Stream Deck plugin untouched:** no changes under `src/plugin/` or `com.drewritter.dealerboard.sdPlugin/`. `src/protocol.ts` is shared with the plugin bundle — additions there must stay additive (parse tolerates missing keys).
- Registry timestamps are canonical ISO-8601 UTC strings; lexical comparison is chronological. Watermarks traveling over any wire (CLI argv, Tauri invoke) must be validated as canonical instants; never accept arbitrary nonempty text as a timestamp.
- Registry writes never touch `updated_at` except hook events (it is the prune lease); view/dismiss/sweep/archive are maintenance writes.
- **Watermark discipline (R11).** Unconditional and causal gestures are THREE distinct states and must never collapse: (1) unconditional — operator CLI / deck press, no watermark; (2) causal with a stamp — the gesture's snapshot showed `unreadSince = <stamp>`; (3) causal with a null stamp — the gesture's snapshot showed no unread (`unreadSince: null`), which consumes nothing and protects anything that arrives in transit. The registry models this as `watermark: GestureWatermark | null` where `GestureWatermark = { unreadSince: string | null }` and a `null` watermark (not `{ unreadSince: null }`) means unconditional. The CLI argv encodes it as: absent fifth arg = unconditional; a canonical instant = causal stamp; the literal `-` = causal null stamp. The Tauri/bridge layer passes `GestureWatermark | null` the same way.
- **`acked_at` discipline.** `acked_at` advances only to the exact stamp of a result a gesture consumed — never to gesture time. Views that consume an unread stamp advance it too; gestures that consume nothing leave it alone. This keeps the Paseo flag mirror's `? > acked_at` guard from both resurrecting already-viewed flags and suppressing not-yet-synced newer news.
- Biome house style: no unused variables (destructure-rename `const { x: _x } = obj` for intentional omissions), `const`-arrow exports, comments explain *why*, double-quoted strings.
- Every task ends with a commit; match `git log --oneline` conventions (`feat(scope): …`, `docs: …`).
- YAGNI: implement exactly the spec, no more. No new UI surfaces, no decay window, no deck changes.

---

### Task 1: Schema v17 — `viewed_since` + `ended_at`

**Files:**
- Modify: `src/core/schema.ts` (LATEST_SCHEMA_VERSION at :16, SCHEMA_VERSION_15 block at :392-403 as the pattern to follow, `initializeDatabase` migration tail at :780-812)
- Test: `test/schema.test.ts`, `test/registry.test.ts` (exact full-row literals)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: schema version `17` with nullable `active_sessions.viewed_since TEXT` and `active_sessions.ended_at TEXT`; every later task relies on these columns existing after `initializeDatabase`. Each column is repaired independently, so a partially shaped v16 database (either column missing) converges instead of dying on a duplicate column.

- [ ] **Step 1: Write the failing tests**

In `test/schema.test.ts`, append a new top-level describe after the existing `describe("schema v16 rebuild", …)` block (after its closing `});`, at end of file):

```typescript
describe("schema v17 retention columns", () => {
  test("fresh init lands at v17 with the retention columns and repeated init is idempotent", () => {
    const paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);
    initializeDatabase(paths);
    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 17 });
      const names = (
        db.query("SELECT name FROM pragma_table_info('active_sessions')").all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(names).toContain("viewed_since");
      expect(names).toContain("ended_at");
    } finally {
      db.close();
    }
  });

  test("the v17 migration adds the retention columns to a v16 database without losing rows", () => {
    const paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);
    const revert = new Database(paths.database, { readwrite: true });
    try {
      insertFull(revert, "claude", "kept-v16", null, 9);
      revert.exec(`
        ALTER TABLE active_sessions DROP COLUMN viewed_since;
        ALTER TABLE active_sessions DROP COLUMN ended_at;
        PRAGMA user_version = 16;
      `);
    } finally {
      revert.close();
    }

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 17 });
      expect(
        db.query("SELECT provider, viewed_since, ended_at FROM active_sessions WHERE session_id = ?").get("kept-v16"),
      ).toEqual({ provider: "claude", viewed_since: null, ended_at: null });
    } finally {
      db.close();
    }
  });

  test("a partially shaped v16 database converges: each retention column is repaired independently", () => {
    // State one: viewed_since exists, ended_at was dropped.
    let paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);
    let revert = new Database(paths.database, { readwrite: true });
    try {
      insertFull(revert, "claude", "partial-a", null, 9);
      revert.exec(`
        ALTER TABLE active_sessions DROP COLUMN ended_at;
        PRAGMA user_version = 16;
      `);
    } finally {
      revert.close();
    }
    initializeDatabase(paths);
    let db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 17 });
      expect(
        db.query("SELECT viewed_since, ended_at FROM active_sessions WHERE session_id = 'partial-a'").get(),
      ).toEqual({ viewed_since: null, ended_at: null });
    } finally {
      db.close();
    }
    // Re-init on the converged database must not die on a duplicate column.
    initializeDatabase(paths);

    // State two: ended_at exists, viewed_since was dropped.
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = mkdtempSync(join(tmpdir(), "dealerboard-schema-"));
    paths = resolveAppPaths(tempHome);
    initializeDatabase(paths);
    revert = new Database(paths.database, { readwrite: true });
    try {
      insertFull(revert, "claude", "partial-b", null, 9);
      revert.exec(`
        ALTER TABLE active_sessions DROP COLUMN viewed_since;
        PRAGMA user_version = 16;
      `);
    } finally {
      revert.close();
    }
    initializeDatabase(paths);
    db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 17 });
      expect(
        db.query("SELECT viewed_since, ended_at FROM active_sessions WHERE session_id = 'partial-b'").get(),
      ).toEqual({ viewed_since: null, ended_at: null });
    } finally {
      db.close();
    }
  });
});
```

Note: before the source change, `initializeDatabase` lands at v16, so the fresh-init assertion fails and the `DROP COLUMN` statements throw "no such column" — both are the expected red.

Also in `test/registry.test.ts`, the `SELECT *`-backed exact-shape assertions break when the columns land. In the test `"drives one session through idle, working, waiting, idle, error, and absent"` (line ~188), add the two new null fields to the full `getRow("s1")` `toEqual` literal immediately after `done_since: null,`:

```typescript
      viewed_since: null,
      ended_at: null,
```

Do the same for the other full-row `toEqual` literal in the suite (the repeated-SessionStart test around line 300 carries the same exact shape).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/schema.test.ts`
Expected: FAIL — `user_version` is `16`, and the DROP COLUMN statements throw ("no such column") once the fresh-init assertion is the only failure mode.

- [ ] **Step 3: Implement schema v17**

In `src/core/schema.ts`:

1. Bump the version constant:

```typescript
export const LATEST_SCHEMA_VERSION = 17;
```

2. Add the two migration ALTERs immediately after the `SCHEMA_VERSION_16` template string (which ends with `CREATE UNIQUE INDEX …;` and a closing backtick) — one constant per column so each can be applied independently:

```typescript
/**
 * v17 adds the retention ledgers, one additive ALTER per column:
 * `viewed_since` is stamped only by a dealerboard view gesture and is the
 * expiry clock's sole input; `ended_at` is stamped when a SessionEnd
 * retains a row holding an unviewed result as a terminal "ended" card.
 * Both are nullable and unconstrained like unread_since.
 */
const SCHEMA_VERSION_17_VIEWED_SINCE = `
ALTER TABLE active_sessions
  ADD COLUMN viewed_since TEXT;
`;

const SCHEMA_VERSION_17_ENDED_AT = `
ALTER TABLE active_sessions
  ADD COLUMN ended_at TEXT;
`;
```

3. In `initializeDatabase`, after the `if (version < 16) { migrateToV16(db); }` block and before `chmodSync(paths.database, DATABASE_FILE_MODE);`, add:

```typescript
      // v17 adds the retention ledger columns. Shape-driven like the v15
      // repair — the column list, not the version, decides whether each
      // ALTER applies — so a retried or re-stamped init never dies on a
      // duplicate column, and a partially shaped v16 database (either
      // column missing) converges. One transaction, so the ALTERs and the
      // stamp commit together.
      if (version < 17) {
        const migrateToV17 = db.transaction(() => {
          const columns = db.query("SELECT name FROM pragma_table_info('active_sessions')").all() as Array<{
            name: string;
          }>;
          if (!columns.some((column) => column.name === "viewed_since")) {
            db.exec(SCHEMA_VERSION_17_VIEWED_SINCE);
          }
          if (!columns.some((column) => column.name === "ended_at")) {
            db.exec(SCHEMA_VERSION_17_ENDED_AT);
          }
          db.exec("PRAGMA user_version = 17");
        });
        migrateToV17();
      }
```

- [ ] **Step 4: Update every pinned v16 assertion in the schema suite**

Still failing: the pre-existing tests pin `user_version` 16. Apply these mechanical edits throughout `test/schema.test.ts`:

- Replace every occurrence of `{ user_version: 16 }` with `{ user_version: 17 }`.
- Replace every occurrence of `.user_version).toBe(16)` with `.user_version).toBe(17)`.
- Rename the three test titles that name the latest version:
  - `"initializes a WAL database at user_version 15 with foreign keys on every connection"` → `"initializes a WAL database at the latest user_version with foreign keys on every connection"`
  - `"fresh init runs the v11 columns through to v16 and repeated init is idempotent"` → `"fresh init runs the v11 columns through to v17 and repeated init is idempotent"`
  - `"fresh init lands at v16 and repeated init is idempotent"` → `"fresh init lands at v17 and repeated init is idempotent"`

Do **not** touch the `describe("schema v16 rebuild", …)` title or any test that stamps/restores an intermediate version (those describe historical migrations).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/schema.test.ts test/registry.test.ts`
Expected: PASS (the registry literals now carry the two new null columns).

- [ ] **Step 6: Update the CLI init pin**

In `test/cli.test.ts`:
- Rename the init test title `"creates a version 16 database and stays silent on stdout"` → `"creates a version 17 database and stays silent on stdout"`.
- In the test `"sessions clear and clear-all reject an unsupported schema without mutating rows"`, change the restore line:

```typescript
      restore.exec("PRAGMA user_version = 17");
```

Run: `bun test test/cli.test.ts`
Expected: PASS (the init test opens a fresh database through the real schema path).

- [ ] **Step 7: Typecheck + lint**

Run: `bun run typecheck && biome check .`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/schema.ts test/schema.test.ts test/cli.test.ts test/registry.test.ts
git commit -m "feat(schema): v17 adds viewed_since and ended_at retention ledgers"
```

---

### Task 2: `viewSession` — view ≠ dismiss (R1)

**Files:**
- Modify: `src/core/projection.ts` (extract the Paseo link resolution from `projectSnapshotRows` :227-275 into an exported helper — behavior-preserving refactor pinned by the existing projection suite), `src/core/registry.ts` (applyStop :458-474, applyStopFailure :476-490, exports region :635+)
- Test: `test/registry.test.ts`, `test/projection.test.ts` (new unit tests for the extracted helper)

**Interfaces:**
- Consumes: schema v17 (`viewed_since` column) from Task 1.
- Produces (exact signatures later tasks rely on):
  - `export type GestureWatermark = { unreadSince: string | null }` (registry.ts) — the causal content of a gesture: the unread stamp the gesture's snapshot showed. **A `null` watermark means unconditional; `{ unreadSince: null }` is a causal gesture issued from a snapshot with no unread — it consumes nothing and protects anything that lands in transit.** These three states must never collapse into one another.
  - `export const viewSession = (db: Database, provider: Provider, sessionId: string, viewedAt: string, watermark: GestureWatermark | null = null): MutationResult` — clears `unread_since` and stamps `viewed_since` on the target row and on every *resolved* Paseo-lineage descendant holding a ledger; leaves `done_since` and status untouched; a causal watermark protects stamps newer than it; advances `acked_at` to the exact consumed stamp.
  - `export const resolvePaseoParentLinks = (rows: readonly PaseoLineageRow[]): Map<string, string>` (projection.ts) with `export type PaseoLineageRow = { provider: Provider; sessionId: string; originRef: string | null; originSubagent: number; originParentRef: string | null }` — the exact parent-link resolution the projection publishes: refs shared by more than one root never link (ambiguous), and cycle members lose their parent edge. Keys are `provider\u0000sessionId` composites, child → parent. Task 3 (dismiss), Task 5 (archive), and Task 6 (prune/clear) all reuse it so destructive mutations can never reach rows the projection fail-safes into their own roots.
  - `const paseoSubtreeIdentities = (db: Database, provider: Provider, sessionId: string): Array<{ provider: Provider; sessionId: string }>` — module-private; the seed identity plus its resolved Paseo descendants (BFS over `resolvePaseoParentLinks`). Task 3 and Task 5 reuse it.
  - `applyStop`/`applyStopFailure` now clear `viewed_since` whenever they stamp a fresh result.

- [ ] **Step 1: Write the failing tests**

In `test/registry.test.ts`:

1. Extend the registry import with `viewSession` (add it to the existing import from `../src/core/registry`, alphabetical position after `updateSessionTitles`).
2. Add `viewed_since: string | null;` to the test-local `Row` type (after `done_since`).
3. Append this describe block at the end of the file:

```typescript
describe("viewSession", () => {
  test("clears the unread badge, stamps viewed_since, and leaves done_since and status untouched", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(viewSession(db, "claude", "s1", at(8))).toBe("applied");
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      unread_since: null,
      done_since: at(5),
      viewed_since: at(8),
      updated_at: at(5), // view is a maintenance write: the prune lease stays put
    });
  });

  test("the card stays held by done_since after viewing (view is not a dismissal)", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    const row = getRow("s1");
    expect(row?.done_since).toBe(at(5));
    expect(row).not.toBeNull(); // nothing deletes on view
  });

  test("re-viewing restamps viewed_since (the 24h clock restarts)", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    expect(viewSession(db, "claude", "s1", at(30))).toBe("applied");
    expect(getRow("s1")?.viewed_since).toBe(at(30));
  });

  test("viewing an error card clears the badge but keeps the error status", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    expect(viewSession(db, "claude", "s1", at(8))).toBe("applied");
    expect(getRow("s1")).toMatchObject({ status: "error", unread_since: null, viewed_since: at(8) });
  });

  test("viewing an active card is harmless: badge clears, viewed stamps, status stays", () => {
    applyRegistryEvents(db, [start("s1"), simple("Activity", "s1", { at: at(5) })]);
    expect(viewSession(db, "claude", "s1", at(8))).toBe("applied");
    expect(getRow("s1")).toMatchObject({ status: "working", viewed_since: at(8) });
  });

  test("viewing an unknown session is ignored", () => {
    expect(viewSession(db, "claude", "missing", at(8))).toBe("ignored");
  });

  test("cascades to done/unread descendants along Paseo lineage at the same instant", () => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("child-a"), origin: { kind: "paseo", ref: "agent-a" } },
      { ...start("child-b"), origin: { kind: "paseo", ref: "agent-b" } },
    ]);
    // Overlay-style parent links: children carry the parent's ref.
    db.run(
      "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id IN ('child-a', 'child-b')",
    );
    applyRegistryEvents(db, [
      simple("Stop", "child-a", { at: at(5) }),
      simple("Stop", "child-b", { at: at(6) }),
    ]);

    expect(viewSession(db, "claude", "parent", at(9))).toBe("applied");
    expect(getRow("child-a")).toMatchObject({ unread_since: null, viewed_since: at(9), done_since: at(5) });
    expect(getRow("child-b")).toMatchObject({ unread_since: null, viewed_since: at(9), done_since: at(6) });
  });

  test("the cascade skips descendants holding no ledger", () => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("child"), origin: { kind: "paseo", ref: "agent-c" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'child'");
    viewSession(db, "claude", "parent", at(9));
    expect(getRow("child")?.viewed_since).toBeNull(); // active child: no ledger, no stamp
  });

  test("a causal watermark consumes the seen result and protects a newer one", () => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("old"), origin: { kind: "paseo", ref: "agent-old" } },
      { ...start("new"), origin: { kind: "paseo", ref: "agent-new" } },
    ]);
    db.run(
      "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id IN ('old', 'new')",
    );
    applyRegistryEvents(db, [simple("Stop", "old", { at: at(5) }), simple("Stop", "new", { at: at(9) })]);

    // The gesture was issued from a snapshot whose unread stamp was at(5).
    expect(viewSession(db, "claude", "parent", at(12), { unreadSince: at(5) })).toBe("applied");
    expect(getRow("old")).toMatchObject({ unread_since: null, viewed_since: at(12) });
    // The newer result landed after the snapshot: it survives, unviewed.
    expect(getRow("new")).toMatchObject({ unread_since: at(9), viewed_since: null, done_since: at(9) });
  });

  test("a causal watermark protecting the target leaves it untouched and ignored", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(9) })]);
    expect(viewSession(db, "claude", "s1", at(12), { unreadSince: at(5) })).toBe("ignored");
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), viewed_since: null });
  });

  test("a causal view from a null-unread snapshot protects a result that lands in transit", () => {
    // The gesture's snapshot showed no unread — then a result arrives before
    // the view executes. The null-stamp watermark must not consume it.
    applyRegistryEvents(db, [start("s1")]);
    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(9) })]); // lands in transit
    expect(viewSession(db, "claude", "s1", at(12), { unreadSince: null })).toBe("ignored");
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(9), viewed_since: null });
  });

  test("a causal-null view on a genuinely read row still stamps the clock", () => {
    // No unread at snapshot time and none in transit: the view matches what
    // the user saw, so the expiry clock starts.
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    expect(viewSession(db, "claude", "s1", at(12), { unreadSince: null })).toBe("applied");
    expect(getRow("s1")).toMatchObject({ viewed_since: at(12), done_since: at(5) });
  });

  test("viewing advances acked_at to the exact consumed stamp, not the gesture time", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: at(5) }),
    ]);
    expect(viewSession(db, "claude", "s1", at(12))).toBe("applied");
    expect(getRow("s1")?.acked_at).toBe(at(5)); // the consumed result's stamp

    // A same-stamp flag synced late cannot resurrect the badge (the Paseo
    // mirror's guard is strictly newer-than), but genuinely newer news can.
    const flag = (attentionTimestamp: string) => ({
      provider: "claude" as const,
      sessionId: "s1",
      agentId: "a1",
      requiresAttention: true,
      isSubagent: false,
      parentAgentId: null,
      attentionTimestamp,
      updatedAt: null,
      archivedAt: null,
      lastStatus: null,
      title: null,
    });
    expect(syncPaseoStates(db, [flag(at(5))])).toBe(0);
    expect(getRow("s1")?.unread_since).toBeNull();
    expect(syncPaseoStates(db, [flag(at(15))])).toBe(1);
    expect(getRow("s1")?.unread_since).toBe(at(15));
  });

  test("a view that consumes nothing leaves acked_at alone", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: at(5) }),
    ]);
    viewSession(db, "claude", "s1", at(8));
    const ackedAfterFirstView = getRow("s1")?.acked_at;
    expect(viewSession(db, "claude", "s1", at(20))).toBe("applied"); // restamps the clock
    expect(getRow("s1")?.acked_at).toBe(ackedAfterFirstView); // nothing consumed → no advance
  });

  test("an ambiguous origin ref never links: the alleged child is not mutated through the parent", () => {
    // Projection refuses ambiguous refs (two roots share agent-0), so the
    // destructive walk must refuse them too — the child is its own root (R7).
    applyRegistryEvents(db, [
      { ...start("dup-a"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("dup-b"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("child"), origin: { kind: "paseo", ref: "agent-c" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'child'");
    applyRegistryEvents(db, [simple("Stop", "child", { at: at(5) })]);

    expect(viewSession(db, "claude", "dup-a", at(9))).toBe("applied");
    expect(getRow("child")).toMatchObject({ unread_since: at(5), viewed_since: null }); // untouched
  });

  test("a cyclic lineage is not walked: cycle members keep their own results", () => {
    applyRegistryEvents(db, [
      { ...start("loop-a"), origin: { kind: "paseo", ref: "agent-x" } },
      { ...start("loop-b"), origin: { kind: "paseo", ref: "agent-y" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-y' WHERE session_id = 'loop-a'");
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-x' WHERE session_id = 'loop-b'");
    applyRegistryEvents(db, [simple("Stop", "loop-b", { at: at(5) })]);

    // Projection strips cycle members' parent edges, so loop-b is not a
    // descendant of loop-a for mutation purposes either.
    expect(viewSession(db, "claude", "loop-a", at(9))).toBe("applied");
    expect(getRow("loop-b")).toMatchObject({ unread_since: at(5), viewed_since: null });
  });

  test("a fresh Stop cancels the view clock (the card is unviewed again)", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(12) })]);
    expect(getRow("s1")).toMatchObject({ unread_since: at(12), done_since: at(12), viewed_since: null });
  });

  test("a fresh StopFailure cancels the view clock", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    applyRegistryEvents(db, [simple("StopFailure", "s1", { at: at(12) })]);
    expect(getRow("s1")).toMatchObject({ status: "error", unread_since: at(12), viewed_since: null });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/registry.test.ts`
Expected: FAIL — `viewSession` is not exported (import error).

- [ ] **Step 3: Implement `viewSession` and the clock-cancel**

In `src/core/registry.ts`:

1. `applyStop` — add the viewed-clock reset to the existing UPDATE (the full replacement):

```typescript
const applyStop = (db: Database, event: StatusEvent): MutationResult => {
  const result = db.run(
    `UPDATE active_sessions
     SET status = CASE WHEN background_outstanding = 1 THEN 'working' ELSE 'idle' END,
         unread_since = CASE WHEN background_outstanding = 1 THEN unread_since ELSE ? END,
         done_since = CASE WHEN background_outstanding = 1 THEN done_since ELSE ? END,
         viewed_since = CASE WHEN background_outstanding = 1 THEN viewed_since ELSE NULL END,
         status_since = CASE
           WHEN (background_outstanding = 1 AND status IS NOT 'working')
             OR (background_outstanding = 0 AND status IS NOT 'idle')
           THEN ? ELSE status_since END,
         updated_at = ?
     WHERE provider = ? AND session_id = ?`,
    [event.observedAt, event.observedAt, event.observedAt, event.observedAt, event.provider, event.sessionId],
  );
  return result.changes > 0 ? "applied" : "ignored";
};
```

2. `applyStopFailure` — same reset:

```typescript
const applyStopFailure = (db: Database, event: StatusEvent): MutationResult => {
  const result = db.run(
    `UPDATE active_sessions
     SET status = 'error', unread_since = ?, viewed_since = NULL,
         status_since = CASE WHEN status IS NOT 'error' THEN ? ELSE status_since END,
         updated_at = ?
     WHERE provider = ? AND session_id = ?`,
    [event.observedAt, event.observedAt, event.observedAt, event.provider, event.sessionId],
  );
  return result.changes > 0 ? "applied" : "ignored";
};
```

3. Extract the projection's Paseo link resolution into a shared helper. In `src/core/projection.ts`, add before `projectSnapshotRows`:

```typescript
/** One top-level row's Paseo routing facts, the minimal input for link resolution. */
export type PaseoLineageRow = {
  provider: Provider;
  sessionId: string;
  originRef: string | null;
  originSubagent: number;
  originParentRef: string | null;
};

/**
 * Resolve Paseo parent links with the exact rules the projection publishes:
 * a ref carried by more than one root never links (ambiguous), only rows
 * marked as Paseo subagents are children, and members of a lineage cycle
 * lose their parent edge (they surface as their own roots). Destructive
 * registry operations MUST walk this same resolution — a row the projection
 * fail-safes into its own card may never be mutated through an alleged
 * parent. Keys are `provider NUL sessionId` composites; values are the
 * parent's key.
 */
export const resolvePaseoParentLinks = (rows: readonly PaseoLineageRow[]): Map<string, string> => {
  const keyOf = (row: { provider: Provider; sessionId: string }): string => `${row.provider}\u0000${row.sessionId}`;
  const rootByOriginRef = new Map<string, string>();
  const ambiguousOriginRefs = new Set<string>();
  for (const row of rows) {
    if (row.originRef === null) {
      continue;
    }
    if (ambiguousOriginRefs.has(row.originRef)) {
      continue;
    }
    if (rootByOriginRef.has(row.originRef)) {
      rootByOriginRef.delete(row.originRef);
      ambiguousOriginRefs.add(row.originRef);
    } else {
      rootByOriginRef.set(row.originRef, keyOf(row));
    }
  }
  const paseoParent = new Map<string, string>();
  for (const row of rows) {
    if (row.originSubagent !== 1 || row.originParentRef === null) {
      continue;
    }
    const parentKey = rootByOriginRef.get(row.originParentRef);
    if (parentKey !== undefined) {
      paseoParent.set(keyOf(row), parentKey);
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
  return paseoParent;
};
```

Then inside `projectSnapshotRows`, replace the three inline blocks — the `rootByOriginRef`/`ambiguousOriginRefs` construction, the `paseoParent` construction, and the cycle-removal loop (the region from `const rootByOriginRef = new Map` through the `for (const member of cycleMembers) { paseoParent.delete(member); }` block) — with:

```typescript
  const paseoParent = resolvePaseoParentLinks(
    rootRows.map(({ row }) => ({
      provider: row.provider,
      sessionId: row.sessionId,
      originRef: row.originKind === "paseo" ? row.originRef : null,
      originSubagent: row.originKind === "paseo" ? row.originSubagent : 0,
      originParentRef: row.originKind === "paseo" ? row.originParentRef : null,
    })),
  );
```

This is a behavior-preserving refactor: run `bun test test/projection.test.ts` right here and expect the whole existing suite to PASS before moving on. Then append direct unit coverage of the helper at the end of `test/projection.test.ts`:

```typescript
describe("resolvePaseoParentLinks", () => {
  const row = (
    sessionId: string,
    originRef: string | null,
    originParentRef: string | null,
    originSubagent = 1,
    provider: Provider = "claude",
  ): PaseoLineageRow => ({ provider, sessionId, originRef, originSubagent, originParentRef });

  test("links a subagent to the unique carrier of its parent ref", () => {
    const links = resolvePaseoParentLinks([
      row("p", "agent-0", null, 0),
      row("s", "agent-1", "agent-0"),
    ]);
    expect(links.get("claude\u0000s")).toBe("claude\u0000p");
  });

  test("an ambiguous ref never links", () => {
    const links = resolvePaseoParentLinks([
      row("dup-a", "agent-0", null, 0),
      row("dup-b", "agent-0", null, 0),
      row("s", "agent-1", "agent-0"),
    ]);
    expect(links.size).toBe(0);
  });

  test("cycle members lose their parent edge", () => {
    const links = resolvePaseoParentLinks([
      row("a", "agent-x", "agent-y"),
      row("b", "agent-y", "agent-x"),
      row("p", "agent-0", null, 0),
      row("s", "agent-1", "agent-0"),
    ]);
    expect(links.has("claude\u0000a")).toBe(false);
    expect(links.has("claude\u0000b")).toBe(false);
    expect(links.get("claude\u0000s")).toBe("claude\u0000p");
  });
});
```

(Add `resolvePaseoParentLinks` and the `PaseoLineageRow` type to the projection import at the top of the test file.)

4. In `src/core/registry.ts`, add the watermark type and the subtree helper immediately before `acknowledgeSession` (near :625). Import the projection helper at the top: `import { resolvePaseoParentLinks } from "./projection";` (projection imports only protocol, so there is no cycle).

```typescript
/**
 * The causal content of a view/dismiss gesture: the unread stamp visible in
 * the snapshot the gesture was issued from. `null` (no watermark) is an
 * unconditional operator/deck gesture; `{ unreadSince: null }` is a causal
 * gesture issued from a snapshot with no unread — it consumes nothing and
 * protects anything that lands in transit.
 */
export type GestureWatermark = { unreadSince: string | null };

/**
 * The Paseo-lineage subtree seeded at one identity, walked with the exact
 * resolution the projection publishes (unique refs only, cycle members
 * excluded — see resolvePaseoParentLinks): a row the projection fail-safes
 * into its own root card is never mutated through an alleged parent. The
 * seed itself is always included (even when unknown or non-Paseo — the
 * caller's UPDATE then simply matches nothing). Native children are never
 * members (they publish null ledgers).
 */
const paseoSubtreeIdentities = (
  db: Database,
  provider: Provider,
  sessionId: string,
): Array<{ provider: Provider; sessionId: string }> => {
  const rows = db
    .query(
      `SELECT provider, session_id, origin_ref, origin_subagent, origin_parent_ref
         FROM active_sessions
        WHERE origin_kind = 'paseo' AND parent_session_id IS NULL`,
    )
    .all() as Array<{
    provider: Provider;
    session_id: string;
    origin_ref: string | null;
    origin_subagent: number;
    origin_parent_ref: string | null;
  }>;
  const links = resolvePaseoParentLinks(
    rows.map((row) => ({
      provider: row.provider,
      sessionId: row.session_id,
      originRef: row.origin_ref,
      originSubagent: row.origin_subagent,
      originParentRef: row.origin_parent_ref,
    })),
  );
  const childrenOf = new Map<string, string[]>();
  for (const [childKey, parentKey] of links) {
    const siblings = childrenOf.get(parentKey);
    if (siblings === undefined) {
      childrenOf.set(parentKey, [childKey]);
    } else {
      siblings.push(childKey);
    }
  }
  const identityOf = (key: string): { provider: Provider; sessionId: string } => {
    const separator = key.indexOf("\u0000");
    return { provider: key.slice(0, separator) as Provider, sessionId: key.slice(separator + 1) };
  };
  const seedKey = `${provider}\u0000${sessionId}`;
  const identities: Array<{ provider: Provider; sessionId: string }> = [];
  const visited = new Set<string>([seedKey]);
  const stack = [seedKey];
  for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
    identities.push(identityOf(key));
    for (const childKey of childrenOf.get(key) ?? []) {
      if (!visited.has(childKey)) {
        visited.add(childKey);
        stack.push(childKey);
      }
    }
  }
  return identities;
};
```

5. Add `viewSession` immediately after `paseoSubtreeIdentities`. The statement binds `causal` (1 when a watermark is present, 0 when unconditional) and `wm` (the watermark's stamp, null for a null-stamp watermark). Binding map per statement: `[viewedAt, identity.provider, identity.sessionId, causal, wm, wm]`.

```typescript
/**
 * View one session's result: the user's read gesture. Clears `unread_since`
 * (the badge) and stamps `viewed_since` (the expiry clock's only input);
 * `done_since` and status stay put, so the card remains on the board. Every
 * view restamps — repeated views restart the clock. Cascades to every
 * resolved Paseo-lineage descendant holding a ledger, all stamped at the
 * same instant so the subtree's clocks run together. A causal watermark
 * protects any result newer than the stamp the gesture's snapshot showed;
 * a null-stamp watermark (the snapshot showed no unread) consumes nothing.
 * Viewing advances `acked_at` to the exact consumed stamp — never the
 * gesture time — so the Paseo flag mirror can neither resurrect an
 * already-viewed flag nor swallow news that has not synced yet. Never
 * touches `updated_at`.
 */
export const viewSession = (
  db: Database,
  provider: Provider,
  sessionId: string,
  viewedAt: string,
  watermark: GestureWatermark | null = null,
): MutationResult =>
  inWriteTransaction(db, () => {
    const causal = watermark === null ? 0 : 1;
    const wm = watermark?.unreadSince ?? null;
    let changed = 0;
    for (const identity of paseoSubtreeIdentities(db, provider, sessionId)) {
      const isTarget = identity.provider === provider && identity.sessionId === sessionId;
      // A row is consumable when the gesture is unconditional, when it has
      // no unread (it matches the snapshot the user saw), or when its unread
      // stamp is at or before the watermark. A causal null-stamp watermark
      // therefore consumes nothing: only unread-free rows match it.
      const result = isTarget
        ? db.run(
            `UPDATE active_sessions
             SET unread_since = NULL,
                 viewed_since = ?,
                 acked_at = NULLIF(max(COALESCE(acked_at, ''), COALESCE(unread_since, '')), '')
             WHERE provider = ? AND session_id = ?
               AND (? = 0 OR unread_since IS NULL OR (? IS NOT NULL AND unread_since <= ?))`,
            [viewedAt, identity.provider, identity.sessionId, causal, wm, wm],
          )
        : db.run(
            `UPDATE active_sessions
             SET unread_since = NULL,
                 viewed_since = ?,
                 acked_at = NULLIF(max(COALESCE(acked_at, ''), COALESCE(unread_since, '')), '')
             WHERE provider = ? AND session_id = ?
               AND (done_since IS NOT NULL OR unread_since IS NOT NULL)
               AND (? = 0 OR unread_since IS NULL OR (? IS NOT NULL AND unread_since <= ?))`,
            [viewedAt, identity.provider, identity.sessionId, causal, wm, wm],
          );
      changed += result.changes;
    }
    return changed > 0 ? "applied" : "ignored";
  });
```

(The `acked_at` expression evaluates on pre-update values: matched rows with a non-null unread consume exactly that stamp; matched rows without unread leave `acked_at` where it was. `max` is SQLite's scalar two-argument maximum; `NULLIF(…, '')` restores NULL when nothing was consumed and no ack existed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/registry.test.ts test/projection.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full core suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS (no other suite touches `viewed_since` yet; the extraction kept every projection test green).

- [ ] **Step 6: Commit**

```bash
git add src/core/registry.ts src/core/projection.ts test/registry.test.ts test/projection.test.ts
git commit -m "feat(registry): viewSession clears the badge and starts the viewed clock"
```

---

### Task 3: `acknowledgeSession` = dismiss, cascading, watermark (R2, R11)

**Files:**
- Modify: `src/core/registry.ts` (acknowledgeSession :625-652 — doc comment and body)
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: `paseoSubtreeIdentities` and `GestureWatermark` from Task 2; `viewSession` (used in test setups).
- Produces: `export const acknowledgeSession = (db: Database, provider: Provider, sessionId: string, ackedAt: string, watermark: GestureWatermark | null = null): MutationResult` — dismiss: clears `unread_since`/`done_since`/`viewed_since`, retires `error → idle`, cascades the same semantics to resolved Paseo-lineage descendants (rows are never deleted). `acked_at` advances only to the exact stamp of the stamps consumed (never gesture time). A causal watermark consumes only stamps ≤ its stamp; `{ unreadSince: null }` consumes nothing and protects anything in transit; `null` is unconditional (operator CLI, deck press — today's behavior exactly).

- [ ] **Step 1: Write the failing tests**

Append to `test/registry.test.ts` (after the `describe("viewSession", …)` block):

```typescript
describe("acknowledgeSession as dismiss", () => {
  const paseoFamily = (): void => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("child-a"), origin: { kind: "paseo", ref: "agent-a" } },
      { ...start("child-b"), origin: { kind: "paseo", ref: "agent-b" } },
    ]);
    db.run(
      "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id IN ('child-a', 'child-b')",
    );
    applyRegistryEvents(db, [simple("Stop", "child-a", { at: at(5) }), simple("Stop", "child-b", { at: at(6) })]);
  };

  test("dismissing the parent cascades: whole subtree drops its ledgers, rows remain", () => {
    paseoFamily();
    const rowsBefore = countRows();
    expect(acknowledgeSession(db, "claude", "parent", at(9))).toBe("applied");
    for (const id of ["parent", "child-a", "child-b"]) {
      expect(getRow(id)).toMatchObject({ unread_since: null, done_since: null });
    }
    expect(countRows()).toBe(rowsBefore); // dismiss never deletes
  });

  test("the cascade retires an error descendant with the parent", () => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("child"), origin: { kind: "paseo", ref: "agent-c" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'child'");
    applyRegistryEvents(db, [simple("StopFailure", "child", { at: at(5) })]);

    expect(acknowledgeSession(db, "claude", "parent", at(9))).toBe("applied");
    expect(getRow("child")).toMatchObject({ status: "idle", unread_since: null, background_outstanding: 0 });
  });

  test("dismiss clears viewed_since alongside the ledgers", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    expect(acknowledgeSession(db, "claude", "s1", at(12))).toBe("applied");
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: null, viewed_since: null });
  });

  test("a causal watermark consumes the seen result and protects a newer one", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(7) }), simple("Stop", "s1", { at: at(9) })]);
    // The gesture was issued from a snapshot showing the at(5) stamp.
    expect(acknowledgeSession(db, "claude", "s1", at(12), { unreadSince: at(5) })).toBe("ignored");
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(9) });
  });

  test("a causal-null dismiss consumes nothing and protects a result that lands in transit", () => {
    // The snapshot showed no unread; a result lands before the dismiss runs.
    applyRegistryEvents(db, [start("s1")]);
    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(9) })]); // in transit
    expect(acknowledgeSession(db, "claude", "s1", at(12), { unreadSince: null })).toBe("ignored");
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(9) }); // survives
  });

  test("a watermark at the stamp consumes it (inclusive)", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(acknowledgeSession(db, "claude", "s1", at(12), { unreadSince: at(5) })).toBe("applied");
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: null });
  });

  test("a watermark only retires an error the user actually saw", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    expect(acknowledgeSession(db, "claude", "s1", at(12), { unreadSince: at(3) })).toBe("ignored");
    expect(getRow("s1")?.status).toBe("error");
    expect(acknowledgeSession(db, "claude", "s1", at(12), { unreadSince: at(5) })).toBe("applied");
    expect(getRow("s1")?.status).toBe("idle");
  });

  test("a causal-null dismiss retires a viewed error the snapshot showed", () => {
    // The error was viewed (badge cleared) — the snapshot showed an error
    // card with no unread — so the dismiss still settles it.
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    expect(acknowledgeSession(db, "claude", "s1", at(12), { unreadSince: null })).toBe("applied");
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(12) });
  });

  test("cascade with a watermark: the seen child clears, the newer child holds the board", () => {
    paseoFamily();
    applyRegistryEvents(db, [simple("Activity", "child-b", { at: at(7) }), simple("Stop", "child-b", { at: at(9) })]);
    expect(acknowledgeSession(db, "claude", "parent", at(12), { unreadSince: at(6) })).toBe("applied");
    expect(getRow("child-a")).toMatchObject({ unread_since: null, done_since: null });
    expect(getRow("child-b")).toMatchObject({ unread_since: at(9), done_since: at(9) });
  });

  test("dismiss advances acked_at to the consumed stamp, so a same-stamp flag synced late stays suppressed", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: at(5) }),
    ]);
    expect(acknowledgeSession(db, "claude", "s1", at(12))).toBe("applied");
    expect(getRow("s1")?.acked_at).toBe(at(5)); // the consumed stamp, not at(12)

    const flag = (attentionTimestamp: string) => ({
      provider: "claude" as const,
      sessionId: "s1",
      agentId: "a1",
      requiresAttention: true,
      isSubagent: false,
      parentAgentId: null,
      attentionTimestamp,
      updatedAt: null,
      archivedAt: null,
      lastStatus: null,
      title: null,
    });
    // The delayed sync of the very flag the user dismissed: no resurrection.
    expect(syncPaseoStates(db, [flag(at(5))])).toBe(0);
    expect(getRow("s1")?.unread_since).toBeNull();
    // A flag raised after the consumed result is fresh news and re-badges.
    expect(syncPaseoStates(db, [flag(at(15))])).toBe(1);
    expect(getRow("s1")?.unread_since).toBe(at(15));
  });
});
```

Two pre-existing tests in the suite pin the OLD gesture-time `acked_at` and must be updated to the consumed-stamp rule:

- In `"acknowledgeSession clears unread and stamps acked_at without touching updated_at"` (~line 652), the Stop stamps at(9); change `expect(row?.acked_at).toBe(at(12));` to `expect(row?.acked_at).toBe(at(9));`.
- In `"acknowledgeSession retires an error row to idle (the error is a result; viewing settles it)"` (~line 663), the StopFailure stamps at(9); change `expect(row?.acked_at).toBe(at(12));` to `expect(row?.acked_at).toBe(at(9));` (its `status_since` stays `at(12)` — the retirement itself happens at gesture time).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/registry.test.ts`
Expected: FAIL — the cascade/watermark behaviors do not exist yet (e.g. descendants keep their ledgers; the 5-arg call is a type error).

- [ ] **Step 3: Replace `acknowledgeSession`**

Replace the doc comment and function (registry.ts :625-652) with the version below. The statement binds `causal` (1 when a watermark is present, 0 when unconditional) and `wm` (the watermark's stamp, null for a null-stamp watermark). Binding map, in order: unread-clear `causal, wm, wm`; done-clear `causal, wm, wm`; acked_at consumed-unread `causal, wm, wm`; acked_at consumed-done `causal, wm, wm`; status-retire `causal, wm, wm`; status_since-retire `causal, wm, wm, ackedAt`; background-retire `causal, wm, wm`; identity `provider, sessionId`; guard-unread `causal, wm, wm`; guard-done `causal, wm, wm`; guard-error `causal, wm, wm` — 33 placeholders, 33 bound values.

```typescript
/**
 * Dismiss one session's result: the user's explicit gesture that takes a
 * card off the board. Clears `unread_since`, `done_since`, and any residual
 * `viewed_since`; an error is itself a result, so dismissal retires it to
 * idle — with the background flag disarmed, like every other retirement.
 * Cascades the same semantics to every resolved Paseo-lineage descendant
 * (clears their ledgers, retires their errors; rows are never deleted).
 * `acked_at` advances to the exact stamp of the result(s) consumed — never
 * the gesture time — so the Paseo flag mirror can neither resurrect an
 * already-viewed flag nor swallow news that has not synced yet; a dismiss
 * that consumes nothing leaves it alone. A causal watermark consumes only
 * stamps at or before the stamp the gesture's snapshot showed; a null-stamp
 * watermark (the snapshot showed no unread) consumes nothing and protects
 * anything in transit; no watermark is unconditional (operator CLI, deck
 * press). The retirement's `status_since` is the gesture time. Never
 * touches updated_at.
 */
export const acknowledgeSession = (
  db: Database,
  provider: Provider,
  sessionId: string,
  ackedAt: string,
  watermark: GestureWatermark | null = null,
): MutationResult =>
  inWriteTransaction(db, () => {
    const causal = watermark === null ? 0 : 1;
    const wm = watermark?.unreadSince ?? null;
    let changed = 0;
    for (const identity of paseoSubtreeIdentities(db, provider, sessionId)) {
      const result = db.run(
        `UPDATE active_sessions
         SET unread_since = CASE WHEN ? = 0 OR (? IS NOT NULL AND unread_since <= ?) THEN NULL ELSE unread_since END,
             done_since = CASE WHEN ? = 0 OR (? IS NOT NULL AND done_since <= ?) THEN NULL ELSE done_since END,
             viewed_since = NULL,
             acked_at = NULLIF(
               max(
                 COALESCE(acked_at, ''),
                 COALESCE(CASE WHEN unread_since IS NOT NULL AND (? = 0 OR (? IS NOT NULL AND unread_since <= ?)) THEN unread_since ELSE NULL END, ''),
                 COALESCE(CASE WHEN done_since IS NOT NULL AND (? = 0 OR (? IS NOT NULL AND done_since <= ?)) THEN done_since ELSE NULL END, '')
               ),
               ''
             ),
             status = CASE
               WHEN status = 'error' AND (? = 0 OR unread_since IS NULL OR (? IS NOT NULL AND unread_since <= ?))
               THEN 'idle' ELSE status END,
             status_since = CASE
               WHEN status = 'error' AND (? = 0 OR unread_since IS NULL OR (? IS NOT NULL AND unread_since <= ?))
               THEN ? ELSE status_since END,
             background_outstanding = CASE
               WHEN status = 'error' AND (? = 0 OR unread_since IS NULL OR (? IS NOT NULL AND unread_since <= ?))
               THEN 0 ELSE background_outstanding END
         WHERE provider = ? AND session_id = ?
           AND (
             (unread_since IS NOT NULL AND (? = 0 OR (? IS NOT NULL AND unread_since <= ?)))
             OR (done_since IS NOT NULL AND (? = 0 OR (? IS NOT NULL AND done_since <= ?)))
             OR (status = 'error' AND (? = 0 OR unread_since IS NULL OR (? IS NOT NULL AND unread_since <= ?)))
           )`,
        [
          causal, wm, wm, // unread clear
          causal, wm, wm, // done clear
          causal, wm, wm, // acked_at: consumed unread stamp
          causal, wm, wm, // acked_at: consumed done stamp
          causal, wm, wm, // error retirement
          causal, wm, wm, ackedAt, // error retirement's status_since
          causal, wm, wm, // error retirement's background disarm
          identity.provider,
          identity.sessionId,
          causal, wm, wm, // guard: consumable unread
          causal, wm, wm, // guard: consumable done
          causal, wm, wm, // guard: consumable error
        ],
      );
      changed += result.changes;
    }
    return changed > 0 ? "applied" : "ignored";
  });
```

(All CASE conditions read pre-update column values within one statement. The `acked_at` maximum covers the existing watermark plus exactly the stamps this statement consumes; `NULLIF(…, '')` restores NULL when there was nothing to advance.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/registry.test.ts`
Expected: PASS (all pre-existing ack tests still pass: the default watermark `null` is unconditional).

- [ ] **Step 5: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/registry.ts test/registry.test.ts
git commit -m "feat(registry): ack is dismiss — cascades along Paseo lineage, honors a watermark"
```

---

### Task 4: Ended cards — `SessionEnd` retention (R10)

**Files:**
- Modify: `src/core/registry.ts` (SessionRow type :69-88, `getRow` SELECT :95-101, applySessionStart reuse UPDATE :203-232, applySessionEnd :501-509)
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: `ended_at` column from Task 1.
- Produces: `SessionEnd` with `unread_since` set retains the row (settles to idle, stamps `ended_at`, keeps ledgers); without it, deletes as today; duplicate/late `SessionEnd` on an ended row is a no-op; a reused `SessionStart` clears `ended_at`. Module-internal `SessionRow.ended_at` is visible to later tasks.

- [ ] **Step 1: Write the failing tests**

In `test/registry.test.ts`: add `ended_at: string | null;` to the test-local `Row` type (after `viewed_since`), then append:

```typescript
describe("SessionEnd retention (ended cards)", () => {
  test("SessionEnd with an unviewed result retains the row as an ended card", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(9) })])).toEqual(["applied"]);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      unread_since: at(5),
      done_since: at(5),
      ended_at: at(9),
      updated_at: at(9),
    });
  });

  test("SessionEnd without an unviewed result deletes the row as today", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8)); // viewed: unread cleared
    expect(applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(9) })])).toEqual(["applied"]);
    expect(getRow("s1")).toBeNull();
  });

  test("a reused SessionStart revives the ended card in place", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(9) })]);
    viewSession(db, "claude", "s1", at(11)); // start the clock before the new life
    applyRegistryEvents(db, [start("s1", { at: at(12) })]);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      ended_at: null,
      unread_since: null,
      done_since: null,
      viewed_since: null, // the new life clears any stale view clock too
    });
  });

  test("a duplicate or late SessionEnd for an ended row is a no-op", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(9) })]);
    expect(applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(15) })])).toEqual(["ignored"]);
    expect(getRow("s1")?.ended_at).toBe(at(9));
  });

  test("SessionEnd → Stop → SessionEnd produces one ended card", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    const results = applyRegistryEvents(db, [
      simple("SessionEnd", "s1", { at: at(9) }),
      simple("Stop", "s1", { at: at(12) }),
      simple("SessionEnd", "s1", { at: at(15) }),
    ]);
    expect(results).toEqual(["applied", "applied", "ignored"]);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      ended_at: at(9),
      unread_since: at(12),
      done_since: at(12),
      viewed_since: null, // the late Stop re-stamped a fresh result
    });
    expect(countRows()).toBe(1);
  });

  test("ending an error-only session stamps a done hold so the ended card survives its view", () => {
    // StopFailure creates unread attention but no done_since. Retention must
    // establish an idle hold, or the card would vanish the moment it is
    // viewed (unread cleared, nothing left to hold it) — R10 keeps it for
    // the full post-view window.
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(9) })]);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      unread_since: at(5),
      done_since: at(9), // stamped at the end stamp
      ended_at: at(9),
    });

    // View: badge off, clock starts — and the done hold keeps the card.
    expect(viewSession(db, "claude", "s1", at(12))).toBe("applied");
    expect(getRow("s1")).toMatchObject({
      unread_since: null,
      done_since: at(9),
      viewed_since: at(12),
      ended_at: at(9),
    });
  });

  test("ending a row that already holds a done stamp keeps that stamp", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(9) })]);
    expect(getRow("s1")?.done_since).toBe(at(5)); // not regressed to the end stamp
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/registry.test.ts`
Expected: FAIL — SessionEnd still deletes (`getRow("s1")` is null in the retention tests); `ended_at` missing from the Row type is a type error under `bun run typecheck`.

- [ ] **Step 3: Implement retention**

In `src/core/registry.ts`:

1. `SessionRow` — add the field after `unread_since`:

```typescript
  unread_since: string | null;
  ended_at: string | null;
  opened_at: string;
```

2. `getRow` — extend the SELECT (the comment above it explains the frozen-COLUMNS precedent):

```typescript
const getRow = (db: Database, provider: Provider, sessionId: string): SessionRow | null =>
  db
    // origin_parent_ref and ended_at postdate COLUMNS (schema v7 and v17)
    // and the INSERT column lists stay frozen — select them here so callers
    // can see the stored values.
    .query(`SELECT ${COLUMNS}, origin_parent_ref, ended_at FROM active_sessions WHERE provider = ? AND session_id = ?`)
    .get(provider, sessionId) as SessionRow | null;
```

3. `applySessionStart` reuse path — add `ended_at = NULL` and `viewed_since = NULL` to the UPDATE (a view and a new life: no stale end mark and no stale view clock survive into the new session):

```typescript
    db.run(
      `UPDATE active_sessions
       SET status = 'idle',
           title = CASE WHEN origin_kind IS 'paseo' THEN title ELSE ? END,
           project = ?, ghostty_terminal_id = ?, transcript_path = ?,
           background_outstanding = 0, unread_since = NULL, done_since = NULL,
           ended_at = NULL, viewed_since = NULL,
           status_since = CASE WHEN status IS NOT 'idle' THEN ? ELSE status_since END,
           origin_kind = COALESCE(?, origin_kind),
           origin_ref = CASE WHEN ? IS NOT NULL THEN ? ELSE origin_ref END,
           origin_subagent = CASE WHEN ? IS NOT NULL THEN 0 ELSE origin_subagent END,
           origin_parent_ref = CASE WHEN ? IS NOT NULL THEN NULL ELSE origin_parent_ref END,
           updated_at = ?, model = COALESCE(?, model)
       WHERE provider = ? AND session_id = ?`,
```

(the parameter array is unchanged — the two `NULL` assignments bind nothing).

4. Replace `applySessionEnd`:

```typescript
const applySessionEnd = (db: Database, event: Extract<RegistryEvent, { kind: "SessionEnd" }>): MutationResult => {
  const existing = getRow(db, event.provider, event.sessionId);
  // Only an existing top-level row ends; children stop via SubagentStop.
  if (existing === null || existing.parent_session_id !== null) {
    return "ignored";
  }
  // Ordering tolerance: a duplicate or late SessionEnd for a row already
  // retained as an ended card is a no-op.
  if (existing.ended_at !== null) {
    return "ignored";
  }
  // Nothing unviewed: delete as today.
  if (existing.unread_since === null) {
    db.run("DELETE FROM active_sessions WHERE provider = ? AND session_id = ?", [event.provider, event.sessionId]);
    return "applied";
  }
  // An unviewed result survives the session: retain the row as a terminal
  // "ended" card — settle to idle, stamp ended_at, keep the ledgers. A row
  // holding only unread (an error/attention result — StopFailure stamps no
  // done) gets a done hold at the end stamp, or viewing it would clear the
  // unread and leave nothing holding the card. Late events still process
  // normally and simply re-stamp.
  db.run(
    `UPDATE active_sessions
     SET status = 'idle', ended_at = ?, background_outstanding = 0,
         done_since = COALESCE(done_since, ?),
         status_since = CASE WHEN status IS NOT 'idle' THEN ? ELSE status_since END,
         updated_at = ?
     WHERE provider = ? AND session_id = ?`,
    [event.observedAt, event.observedAt, event.observedAt, event.observedAt, event.provider, event.sessionId],
  );
  return "applied";
};
```

5. One pre-existing lifecycle test pins the OLD delete-on-end behavior for an unread error and must be updated to retention. In `"drives one session through idle, working, waiting, idle, error, and absent"` (~line 186), the final segment is:

```typescript
    expect(applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(6) })])).toEqual(["applied"]);
    expect(getRow("s1")).toBeNull();
    expect(countRows()).toBe(0);
```

Replace it with (the StopFailure at at(5) left an unviewed result, so the row is retained as an ended card):

```typescript
    // The failure at at(5) is unviewed, so the end retains the row as an
    // ended card instead of deleting it.
    expect(applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(6) })])).toEqual(["applied"]);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      unread_since: at(5),
      done_since: at(6),
      ended_at: at(6),
      updated_at: at(6),
    });
    expect(countRows()).toBe(1);
```

and rename the test title to `"drives one session through idle, working, waiting, idle, error, and ended"`. (`"never recreates an ended session from late non-start events"` still passes: it ends a start-only row with no unread, which deletes.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS (pre-existing SessionEnd tests other than the one updated above seed no unread, so they still delete).

- [ ] **Step 6: Commit**

```bash
git add src/core/registry.ts test/registry.test.ts
git commit -m "feat(registry): SessionEnd keeps unviewed results as ended cards"
```

---

### Task 5: Paseo overlay — passive views inert, archive cascade, repaired settlements badge (R5)

**Files:**
- Modify: `src/core/registry.ts` (syncPaseoStates doc comment :735-800, function body :802-975 — flagged branch :838-862 stays; else branch :863-905 restructured; settled-record repair :906-937)
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: `viewed_since` semantics from Tasks 2-3; `paseoSubtreeIdentities` (resolved lineage) from Task 2.
- Produces: (a) non-archived cleared/absent-flag records no longer write ledgers (origin stamping only — passive views are inert); (b) archived records UNSTAMP the archived row's origin (archiving is terminal: the row stops representing the agent, which breaks the Paseo link so still-active descendants fail-safe into their own orphan roots per R7) and cascade a freshness-guarded ledger clear (`unread_since`, `done_since`, `viewed_since`) over the resolved Paseo subtree; (c) the settled-record repair stamps `unread_since` alongside `done_since` (unless archived, or older than the row's `acked_at`), clears `viewed_since`; (d) rotation cleanup untouched (status-only) — pinned by a new test.

- [ ] **Step 1: Update and add the pinned tests**

In `test/registry.test.ts`, within `describe("syncPaseoStates", …)`:

1. Replace the test `"stamps origin and mirrors attention both ways under the watermark"` with:

```typescript
  test("stamps origin and mirrors attention one way: flags set unread, cleared flags are inert", () => {
    applyRegistryEvents(db, [start("s1")]);

    // Flagged: unread adopts the record's attention timestamp.
    const changed = syncPaseoStates(db, [paseoState({ attentionTimestamp: FLAG_AT })]);
    expect(changed).toBe(1);
    expect(getRow("s1")).toMatchObject({
      origin_kind: "paseo",
      origin_ref: "a1",
      origin_subagent: 0,
      unread_since: FLAG_AT,
    });

    // Cleared with a later record write: a passive Paseo view is inert —
    // board ledgers only clear through dealerboard gestures or archive.
    const cleared = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: "2026-08-06T00:12:00.000Z" }),
    ]);
    expect(cleared).toBe(0);
    expect(getRow("s1")?.unread_since).toBe(FLAG_AT);
  });
```

2. Replace the test `"a stale cleared record does not clear newer local news (Stop → stale false)"` with:

```typescript
  test("a cleared record never touches ledgers — stale or fresh (passive views are inert)", () => {
    const stopAt = at(5);
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: stopAt })]);
    expect(getRow("s1")?.unread_since).toBe(stopAt);

    // Stamp origin first so the cleared passes below have nothing else to write.
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: "2026-08-06T00:00:01.000Z" })])).toBe(1);

    // Stale cleared record: inert.
    expect(syncPaseoStates(db, [paseoState({ requiresAttention: false, updatedAt: "2026-08-06T00:00:02.000Z" })])).toBe(0);
    // Fresh cleared record: still inert — only a dealerboard gesture or an
    // archive clears board ledgers.
    expect(syncPaseoStates(db, [paseoState({ requiresAttention: false, updatedAt: "2026-08-06T00:00:09.000Z" })])).toBe(0);
    expect(getRow("s1")?.unread_since).toBe(stopAt);
    expect(getRow("s1")?.done_since).toBe(stopAt);
  });
```

3. In `"missing timestamps skip the unread write entirely but still stamp origin"`, replace the second half (the cleared-record assertions after the `Stop`) with:

```typescript
    // Cleared with no updatedAt is inert like every cleared record.
    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(5) })]);
    expect(syncPaseoStates(db, [paseoState({ requiresAttention: false })])).toBe(0);
    expect(getRow("s1")?.unread_since).toBe(at(5));
```

4. Replace the test `"a fresh cleared record clears unread but never done_since (the done card outlives the passive view)"` with:

```typescript
  test("a fresh cleared record leaves both ledgers untouched (passive views are inert)", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(syncPaseoStates(db, [paseoState({ requiresAttention: false, updatedAt: at(9) })])).toBe(0);
    expect(getRow("s1")?.unread_since).toBe(at(5));
    expect(getRow("s1")?.done_since).toBe(at(5));
  });
```

5. Replace the test `"the settled-record repair stamps done_since (the missed Stop's result still deserves the board)"` with (the origin is seeded at start so the sync's origin stamp contributes no extra change):

```typescript
  test("the settled-record repair stamps unread+done so the repaired settlement badges", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Activity", "s1", { at: at(2) }),
    ]);
    const changed = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: at(9), lastStatus: "idle" }),
    ]);
    expect(changed).toBe(1); // exactly the settlement repair; origin already matches
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      unread_since: at(9),
      done_since: at(9),
      viewed_since: null,
    });
  });
```

6. Replace the test `"acknowledgeSession applies on a done row a passive view already marked read"` with:

```typescript
  test("dismissal applies on a done row a dealerboard view already marked read", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: at(5) }),
    ]);
    // A dealerboard view clears the badge; the done card stays on the board.
    expect(viewSession(db, "claude", "s1", at(9))).toBe("applied");
    expect(getRow("s1")?.unread_since).toBeNull();
    expect(getRow("s1")?.done_since).toBe(at(5));
    // The explicit dismissal gesture still applies and takes the card off.
    expect(acknowledgeSession(db, "claude", "s1", at(12))).toBe("applied");
    expect(getRow("s1")?.done_since).toBeNull();
    // A second ack with nothing left to clear reports ignored.
    expect(acknowledgeSession(db, "claude", "s1", at(13))).toBe("ignored");
  });
```

7. Append these new tests inside the same describe:

```typescript
  test("an archived record cascades the ledger clear (incl. viewed_since) to Paseo descendants", () => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "a1" } },
      { ...start("child"), origin: { kind: "paseo", ref: "a2" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'a1' WHERE session_id = 'child'");
    applyRegistryEvents(db, [simple("Stop", "parent", { at: at(5) }), simple("Stop", "child", { at: at(6) })]);
    viewSession(db, "claude", "child", at(7)); // child has a live view clock too

    const archived = syncPaseoStates(db, [
      paseoState({ sessionId: "parent", requiresAttention: false, updatedAt: at(8), archivedAt: at(9) }),
    ]);
    expect(archived).toBeGreaterThan(0);
    expect(getRow("parent")).toMatchObject({ unread_since: null, done_since: null, viewed_since: null });
    expect(getRow("child")).toMatchObject({ unread_since: null, done_since: null, viewed_since: null });
    expect(countRows()).toBe(2); // archive clears ledgers, never deletes rows
  });

  test("archiving unlinks the agent: active descendants become orphan roots", () => {
    // Spec edge case "Parent archived with active descendants": the parent's
    // ledgers clear and its card goes; still-active children render as
    // orphan roots instead of promoting the archived parent back onto the
    // board through the status roll-up.
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "a1" } },
      { ...start("child"), origin: { kind: "paseo", ref: "a2" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'a1' WHERE session_id = 'child'");
    applyRegistryEvents(db, [simple("Activity", "child", { at: at(5) })]); // child is working

    const archived = syncPaseoStates(db, [
      paseoState({ sessionId: "parent", requiresAttention: false, updatedAt: at(8), archivedAt: at(9) }),
      // The child's own live record still reports its parent agent.
      {
        ...paseoState({ sessionId: "child", isSubagent: true, parentAgentId: "a1", requiresAttention: false, updatedAt: at(8) }),
        agentId: "a2",
      },
    ]);
    expect(archived).toBeGreaterThan(0);
    // The archived row loses its origin representation entirely — that is
    // what breaks the link (the child's own record still names a1).
    expect(getRow("parent")).toMatchObject({ origin_kind: null, origin_ref: null, origin_subagent: 0 });
    expect(getRow("child")).toMatchObject({ origin_kind: "paseo", origin_ref: "a2", origin_parent_ref: "a1" });
  });
```

8. The integration half of that edge case lives in `test/projection.test.ts` (it already imports `applyRegistryEvents`; add `syncPaseoStates` to the registry import). Append inside the `projectRows` describe — it exercises registry → projection end to end through a real database:

```typescript
  test("archived parent with active descendants: the children surface as orphan roots", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);
      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "parent",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            origin: { kind: "paseo", ref: "a1" },
            observedAt: "2026-08-06T00:00:01.000Z",
          },
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "child",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            origin: { kind: "paseo", ref: "a2" },
            observedAt: "2026-08-06T00:00:02.000Z",
          },
        ]);
        writer.run(
          "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'a1' WHERE session_id = 'child'",
        );
        applyRegistryEvents(writer, [
          { kind: "Activity", provider: "claude", sessionId: "child", observedAt: "2026-08-06T00:00:05.000Z" },
        ]);
        syncPaseoStates(writer, [
          {
            provider: "claude",
            sessionId: "parent",
            agentId: "a1",
            requiresAttention: false,
            isSubagent: false,
            parentAgentId: null,
            attentionTimestamp: null,
            updatedAt: "2026-08-06T00:00:08.000Z",
            archivedAt: "2026-08-06T00:00:09.000Z",
            lastStatus: null,
            title: null,
          },
          {
            provider: "claude",
            sessionId: "child",
            agentId: "a2",
            requiresAttention: false,
            isSubagent: true,
            parentAgentId: "a1",
            attentionTimestamp: null,
            updatedAt: "2026-08-06T00:00:08.000Z",
            archivedAt: null,
            lastStatus: null,
            title: null,
          },
        ]);
      } finally {
        writer.close();
      }
      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        const snapshot = readProjection(reader);
        // The archived parent is gone from the board; the active child is
        // its own card (parentless in the graph), not a promotion of the
        // archived parent.
        expect(snapshot.sessions.map((session) => session.sessionId)).toEqual(["child"]);
        expect(snapshot.sessions[0]).toMatchObject({ status: "working", originSubagent: true });
        expect(snapshot.agents?.find((node) => node.sessionId === "child")?.parent).toBeNull();
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
```

9. One more pre-existing test depends on the deleted passive-view path and must be rewritten. Replace `"acknowledgeSession retires an error row Paseo already marked read"` (~line 1290, inside `describe("syncPaseoStates", …)`) with:

```typescript
  test("acknowledgeSession retires an error row a dealerboard view already marked read", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(9) })]);
    // A dealerboard view clears the badge; the failure stays up.
    expect(viewSession(db, "claude", "s1", "2026-08-06T00:10:00.000Z")).toBe("applied");
    expect(getRow("s1")).toMatchObject({ status: "error", unread_since: null });

    expect(acknowledgeSession(db, "claude", "s1", at(30))).toBe("applied");
    // The dismissal consumes nothing new (the view already consumed the
    // at(9) stamp), so acked_at stays at the consumed stamp.
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(30), acked_at: at(9) });
  });
```

The remaining new tests from item 7 continue in the same registry `describe` block:

```typescript
  test("a stale archive does not clear newer descendant news", () => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "a1" } },
      { ...start("child"), origin: { kind: "paseo", ref: "a2" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'a1' WHERE session_id = 'child'");
    applyRegistryEvents(db, [simple("Stop", "child", { at: at(12) })]);

    const archived = syncPaseoStates(db, [
      paseoState({ sessionId: "parent", requiresAttention: false, updatedAt: at(8), archivedAt: at(9) }),
    ]);
    expect(archived).toBe(0);
    expect(getRow("child")).toMatchObject({ unread_since: at(12), done_since: at(12) });
  });

  test("the settled-record repair never resurrects a result dismissed after the record", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Activity", "s1", { at: at(2) }),
    ]);
    // The record was written at at(5)…
    // …but the user's dismiss lands after it, and the sync processes later.
    applyRegistryEvents(db, [simple("StopFailure", "s1", { at: at(4) })]);
    viewSession(db, "claude", "s1", at(6));
    expect(acknowledgeSession(db, "claude", "s1", at(7))).toBe("applied");
    const changed = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: at(5), lastStatus: "idle" }),
    ]);
    // The row is idle now, so the settle guard (status IN working/waiting)
    // already refuses; this pins that nothing re-stamps either ledger.
    expect(changed).toBe(0);
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: null });
  });

  test("the repair stamps a missed result newer than the consumed stamp (no suppression)", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Activity", "s1", { at: at(2) }),
    ]);
    // A paseo flag raised unread at at(3); the user dismissed it at at(6) —
    // acked_at advances to the consumed stamp at(3), not the gesture time.
    syncPaseoStates(db, [paseoState({ attentionTimestamp: at(3) })]);
    expect(acknowledgeSession(db, "claude", "s1", at(6))).toBe("applied");
    expect(getRow("s1")?.acked_at).toBe(at(3));
    // The settled record reports the turn finished at at(5): newer than the
    // consumed stamp, so the missed result must surface, not be suppressed.
    const changed = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: at(5), lastStatus: "idle" }),
    ]);
    expect(changed).toBe(1);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      unread_since: at(5),
      done_since: at(5),
      viewed_since: null,
    });
  });

  test("the repair retires without stamping when the record is not newer than the ack", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Activity", "s1", { at: at(2) }),
    ]);
    syncPaseoStates(db, [paseoState({ attentionTimestamp: at(3) })]);
    expect(acknowledgeSession(db, "claude", "s1", at(6))).toBe("applied");
    expect(getRow("s1")?.acked_at).toBe(at(3));
    // A record written at at(3) — not strictly newer than the consumed
    // stamp — still proves the turn ended (retirement applies), but its
    // stamp is stale news the user already dismissed: no ledger write.
    const changed = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: at(3), lastStatus: "idle" }),
    ]);
    expect(changed).toBe(1);
    expect(getRow("s1")).toMatchObject({ status: "idle", unread_since: null, done_since: null, viewed_since: null });
  });

  test("the rotation cleanup never clears ledgers (a retired carrier keeps its results)", () => {
    applyRegistryEvents(db, [
      { ...start("old-carrier"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "old-carrier", { at: at(5) }),
    ]);
    // The agent rotated to a new provider session; the old carrier un-stamps.
    const changed = syncPaseoStates(db, [
      {
        provider: "codex",
        sessionId: "new-carrier",
        agentId: "a1",
        requiresAttention: false,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: at(9),
        archivedAt: null,
        lastStatus: null,
        title: null,
      },
    ]);
    expect(changed).toBeGreaterThan(0);
    expect(getRow("old-carrier")).toMatchObject({
      origin_kind: null,
      origin_ref: null,
      status: "idle",
      unread_since: at(5), // the results survive the rotation
      done_since: at(5),
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/registry.test.ts`
Expected: FAIL — cleared records still clear `unread_since`; the repair does not stamp unread; the archive cascade misses the child.

- [ ] **Step 3: Implement the overlay changes**

In `src/core/registry.ts`, inside `syncPaseoStates`:

1. Replace the entire `else` branch (the block starting `} else {` with the comment `// Cleared, absent flag, or archived:` through its closing `}` before the settled-record comment) with two branches — archived first, then inert cleared:

```typescript
      } else if (state.archivedAt !== null) {
        // Resolve the lineage BEFORE un-stamping: the walk follows the
        // archived row's origin_ref, which the un-stamp is about to clear.
        const subtree = paseoSubtreeIdentities(db, state.provider, state.sessionId);
        // Archiving is the user's terminal gesture on the agent — and the
        // row's representation of it ends with it. Un-stamp origin: the
        // archived row stops carrying the agent's ref, which breaks the
        // Paseo link so still-active descendants fail-safe into their own
        // orphan roots (the projection would otherwise keep promoting them
        // into the archived parent). A record that un-archives later
        // re-stamps origin through the flagged/cleared branches.
        const unstamp = db.run(
          `UPDATE active_sessions
           SET origin_kind = NULL, origin_ref = NULL, origin_subagent = 0, origin_parent_ref = NULL
           WHERE provider = ? AND session_id = ? AND parent_session_id IS NULL
             AND origin_kind = 'paseo'`,
          [state.provider, state.sessionId],
        );
        changed += unstamp.changes;
        // The terminal gesture also clears ledgers under the freshness
        // guard, cascading over the RESOLVED Paseo subtree (unique refs,
        // cycle-safe — paseoSubtreeIdentities) and clearing the view clock
        // with them. Rows are never deleted; a stale archive never clears
        // news that landed afterwards.
        const clearTime = laterInstant(state.updatedAt, state.archivedAt);
        for (const identity of subtree) {
          const archived = db.run(
            `UPDATE active_sessions
             SET unread_since = CASE WHEN unread_since IS NOT NULL AND ? > unread_since THEN NULL ELSE unread_since END,
                 done_since = CASE WHEN done_since IS NOT NULL AND ? > done_since THEN NULL ELSE done_since END,
                 viewed_since = CASE WHEN viewed_since IS NOT NULL AND ? > viewed_since THEN NULL ELSE viewed_since END
             WHERE provider = ? AND session_id = ?
               AND (
                 (unread_since IS NOT NULL AND ? > unread_since)
                 OR (done_since IS NOT NULL AND ? > done_since)
                 OR (viewed_since IS NOT NULL AND ? > viewed_since)
               )`,
            [
              clearTime,
              clearTime,
              clearTime,
              identity.provider,
              identity.sessionId,
              clearTime,
              clearTime,
              clearTime,
            ],
          );
          changed += archived.changes;
        }
      } else {
        // Cleared or absent flag: a passive Paseo view — whether by the
        // user or by a parent agent consuming its children — is inert.
        // Origin stamping stays unconditional for matched top-level rows;
        // board ledgers are untouched.
        const origin = db.run(
          `UPDATE active_sessions
           SET origin_kind = 'paseo', origin_ref = ?, origin_subagent = ?, origin_parent_ref = ?
           WHERE provider = ? AND session_id = ? AND parent_session_id IS NULL
             AND (
               origin_kind IS NOT 'paseo' OR origin_ref IS NOT ? OR origin_subagent IS NOT ?
               OR origin_parent_ref IS NOT ?
             )`,
          [
            state.agentId,
            state.isSubagent ? 1 : 0,
            state.parentAgentId,
            state.provider,
            state.sessionId,
            state.agentId,
            state.isSubagent ? 1 : 0,
            state.parentAgentId,
          ],
        );
        changed += origin.changes;
      }
```

2. In the settled-record repair UPDATE (the block guarded by `if (state.lastStatus !== null && SETTLED_PASEO_STATUSES.has(state.lastStatus) && state.updatedAt !== null)`), replace the statement and its parameter array with the version below. The statement has exactly 14 placeholders; the binding map, in order: `status_since` ← `state.updatedAt`; done-stamp CASE ← `doneStamp, doneStamp, doneStamp`; unread-stamp CASE ← `doneStamp, doneStamp, doneStamp`; viewed-clear CASE ← `doneStamp, doneStamp`; identity ← `state.provider, state.sessionId`; freshness guard ← `state.updatedAt`; background cutoff ← `backgroundSettleCutoffIso, backgroundSettleCutoffIso`. (1 + 3 + 3 + 2 + 2 + 1 + 2 = 14.)

```typescript
        const doneStamp = state.archivedAt === null ? state.updatedAt : null;
        const settled = db.run(
          `UPDATE active_sessions
           SET status = 'idle', status_since = ?, background_outstanding = 0,
               done_since = CASE
                 WHEN ? IS NOT NULL AND (acked_at IS NULL OR ? > acked_at) THEN ? ELSE done_since END,
               unread_since = CASE
                 WHEN ? IS NOT NULL AND (acked_at IS NULL OR ? > acked_at) THEN ? ELSE unread_since END,
               viewed_since = CASE
                 WHEN ? IS NOT NULL AND (acked_at IS NULL OR ? > acked_at) THEN NULL ELSE viewed_since END
           WHERE provider = ? AND session_id = ? AND parent_session_id IS NULL
             AND status IN ('working', 'waiting')
             AND ? > updated_at
             AND (background_outstanding = 0 OR (? IS NOT NULL AND updated_at < ?))`,
          [
            state.updatedAt, // status_since: the record's settle time
            doneStamp, doneStamp, doneStamp, // done_since stamp (guard ×2 + value)
            doneStamp, doneStamp, doneStamp, // unread_since stamp (guard ×2 + value)
            doneStamp, doneStamp, // viewed_since clear (guard ×2)
            state.provider, state.sessionId, // identity
            state.updatedAt, // freshness: strictly newer than the last hook
            backgroundSettleCutoffIso, backgroundSettleCutoffIso, // background grace
          ],
        );
        changed += settled.changes;
```

and update the comment above it — replace the existing comment's last sentence (`The repaired turn still landed a result, so the retirement stamps done_since like the Stop it stands in for — unless the record is archived: the terminal gesture already dismissed the card.`) with exactly:

```
      // The repaired turn still landed a result, so the retirement stamps
      // done_since and unread_since like the Stop it stands in for — the
      // settlement badges the card instead of holding it silently — and
      // clears any stale viewed clock. Unless the record is archived (the
      // terminal gesture already dismissed the card) or the stamp predates
      // the row's acked_at (the user already dismissed what the record
      // reports).
```

3. Rewrite the `syncPaseoStates` doc comment bullet for the cleared path. Replace the bullet beginning `- A cleared or absent-flag record clears unread_since only when` with:

```
 * - A cleared or absent-flag record is a passive view and is inert: it
 *   stamps origin but never touches board ledgers — only dealerboard
 *   gestures, archive, session restart, or expiry clear them. An archived
 *   record (`archivedAt` set) is the exception — archiving is the user's
 *   terminal gesture on an agent — and clears ledgers under the freshness
 *   guard with the later of `archivedAt` and `updatedAt` as the
 *   proof-of-viewing time, cascading the clear along Paseo lineage.
```

In the `- A settled record (` bullet, replace the sentence `` `status_since` adopts the record's settle time; unread stays the attention mirror's business. `` with:

```
 *   `status_since` adopts the record's settle time; the repaired turn's
 *   result stamps unread alongside done — unless the record is archived or
 *   older than the row's ack — so the settlement badges the card.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS. (`test/daemon.test.ts`'s paseo-pass tests exercise the flagged path only, which is unchanged — no edits expected there.)

- [ ] **Step 6: Commit**

```bash
git add src/core/registry.ts test/registry.test.ts
git commit -m "feat(registry): Paseo views go inert; archive cascades; repairs badge"
```

---

### Task 6: Prune and clear respect Paseo lineage (R9, lineage-aware destructive ops)

**Files:**
- Modify: `src/core/registry.ts` (clearSession :615-623, pruneStaleSessions :1013-1060)
- Test: `test/registry.test.ts`, `test/cli.test.ts`, `test/daemon.test.ts`

**Interfaces:**
- Consumes: `resolvePaseoParentLinks` and `paseoSubtreeIdentities` from Task 2.
- Produces:
  - `pruneStaleSessions(db, cutoffIso, zcodeCutoffIso?)` skips any tree containing a row with `unread_since` non-null — where "tree" is the NATIVE tree plus the whole RESOLVED Paseo tree: every resolved Paseo ancestor of an unviewed row is kept as well, whether prune is invoked by the daemon or CLI `sessions prune` (shared code path).
  - `clearSession(db, provider, sessionId)` deletes the target row and its descendants — native FK cascade AND resolved Paseo-linked descendants (the clearing contract's manual-clear row). Ambiguous refs are never followed (projection-equivalent resolution).

- [ ] **Step 1: Write the failing tests**

In `test/registry.test.ts`, inside `describe("pruneStaleSessions", …)`, append:

```typescript
  test("skips any tree containing an unviewed row, no matter how stale", () => {
    applyRegistryEvents(db, [
      start("stale-unviewed", { at: "2026-08-01T00:00:00.000Z" }),
      simple("Stop", "stale-unviewed", { at: "2026-08-01T00:00:01.000Z" }),
      start("stale-viewed", { at: "2026-08-01T00:00:00.000Z" }),
      simple("Stop", "stale-viewed", { at: "2026-08-01T00:00:01.000Z" }),
    ]);
    viewSession(db, "claude", "stale-viewed", "2026-08-01T02:00:00.000Z");

    expect(pruneStaleSessions(db, "2026-08-27T00:00:00.000Z")).toBe(1);
    expect(allRows().map((row) => row.session_id)).toEqual(["stale-unviewed"]);
  });

  test("an unviewed zcode row survives its 1h TTL", () => {
    applyRegistryEvents(db, [
      start("z1", { provider: "zcode", at: "2026-08-26T00:00:00.000Z" }),
      simple("Stop", "z1", { provider: "zcode", at: "2026-08-26T00:00:01.000Z" }),
    ]);
    expect(pruneStaleSessions(db, "2026-08-26T03:00:00.000Z", "2026-08-26T01:00:00.000Z")).toBe(0);
    expect(countRows()).toBe(1);
  });

  test("an unviewed child keeps its stale native tree", () => {
    applyRegistryEvents(db, [
      start("parent", { at: "2026-08-01T00:00:00.000Z" }),
      subStart("child", "parent", { at: "2026-08-01T00:00:01.000Z" }),
    ]);
    db.run("UPDATE active_sessions SET unread_since = '2026-08-01T00:00:02.000Z' WHERE session_id = 'child'");
    expect(pruneStaleSessions(db, "2026-08-27T00:00:00.000Z")).toBe(0);
    expect(countRows()).toBe(2);
  });

  test("an unviewed Paseo descendant keeps its whole resolved tree, ancestors included", () => {
    // Paseo descendants are separate root rows; the unviewed one must keep
    // its stale ancestors, not orphan them.
    applyRegistryEvents(db, [
      { ...start("orchestrator", { at: "2026-08-01T00:00:00.000Z" }), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("worker", { at: "2026-08-01T00:00:01.000Z" }), origin: { kind: "paseo", ref: "agent-1" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'worker'");
    applyRegistryEvents(db, [simple("Stop", "worker", { at: "2026-08-01T00:00:02.000Z" })]);

    expect(pruneStaleSessions(db, "2026-08-27T00:00:00.000Z")).toBe(0);
    expect(allRows().map((row) => row.session_id).sort()).toEqual(["orchestrator", "worker"]);

    // Once the result is viewed, nothing unviewed remains and the whole
    // stale tree goes.
    viewSession(db, "claude", "worker", "2026-08-01T01:00:00.000Z");
    expect(pruneStaleSessions(db, "2026-08-27T00:00:00.000Z")).toBe(2);
    expect(countRows()).toBe(0);
  });

  test("an ambiguous ref never links for prune either: the unviewed row keeps only itself", () => {
    applyRegistryEvents(db, [
      { ...start("dup-a", { at: "2026-08-01T00:00:00.000Z" }), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("dup-b", { at: "2026-08-01T00:00:00.000Z" }), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("worker", { at: "2026-08-01T00:00:01.000Z" }), origin: { kind: "paseo", ref: "agent-1" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'worker'");
    applyRegistryEvents(db, [simple("Stop", "worker", { at: "2026-08-01T00:00:02.000Z" })]);

    // agent-0 is ambiguous, so the worker is its own root: it keeps itself
    // (unviewed) but not the two stale alleged parents.
    expect(pruneStaleSessions(db, "2026-08-27T00:00:00.000Z")).toBe(2);
    expect(allRows().map((row) => row.session_id)).toEqual(["worker"]);
  });
```

In `test/daemon.test.ts` (maintenance describe), append the prune entry-point coverage:

```typescript
  test("daemon prune keeps the whole Paseo tree of an unviewed row until it is viewed", () => {
    apply([
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "orchestrator",
        title: null,
        project: null,
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        origin: { kind: "paseo", ref: "agent-0" },
        observedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "worker",
        title: null,
        project: null,
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        origin: { kind: "paseo", ref: "agent-1" },
        observedAt: "2026-08-01T00:00:01.000Z",
      },
      { kind: "Stop", provider: "claude", sessionId: "worker", observedAt: "2026-08-01T00:00:02.000Z" },
    ]);
    const link = openRegistryDatabase(paths.database, "readwrite");
    try {
      link.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'worker'");
    } finally {
      link.close();
    }

    const sessionIds = (): string[] => {
      const db = openRegistryDatabase(paths.database, "readonly");
      try {
        return (
          db.query("SELECT session_id FROM active_sessions ORDER BY session_id").all() as { session_id: string }[]
        ).map((row) => row.session_id);
      } finally {
        db.close();
      }
    };

    // The first daemon's startup tick ran the prune pass: the stale tree
    // survives because one member is unviewed.
    const first = makeHarness();
    first.daemon.start();
    first.daemon.stop();
    expect(sessionIds()).toEqual(["orchestrator", "worker"]);

    // View the result; a later daemon (clock past the TTL) prunes the
    // now-fully-viewed tree — both root rows.
    const view = openRegistryDatabase(paths.database, "readwrite");
    try {
      viewSession(view, "claude", "worker", NOW);
    } finally {
      view.close();
    }
    const second = makeHarness({
      nowMs: () => Date.parse("2026-08-27T00:00:00.000Z"),
      now: () => "2026-08-27T00:00:00.000Z",
    });
    second.daemon.start();
    try {
      expect(sessionIds()).toEqual([]);
    } finally {
      second.daemon.stop();
    }
  });
```

(Add `viewSession` to the daemon test's registry import.)

In `test/cli.test.ts`, inside `describe("sessions commands", …)`, append after the existing prune tests:

```typescript
  test("sessions prune skips trees holding an unviewed result", async () => {
    initRegistry();
    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      applyRegistryEvents(db, [
        {
          kind: "SessionStart",
          provider: "claude",
          sessionId: "unviewed",
          title: null,
          project: null,
          ghosttyTerminalId: null,
          transcriptPath: null,
          model: null,
          observedAt: "2026-08-01T00:00:00.000Z",
        },
        { kind: "Stop", provider: "claude", sessionId: "unviewed", observedAt: "2026-08-01T00:00:01.000Z" },
      ]);
    } finally {
      db.close();
    }
    // A month later: stale by any TTL, but the result was never viewed.
    const harness = makeHarness({ now: () => "2026-09-01T00:00:00.000Z" });
    expect(await runCli(["sessions", "prune", "0.5"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("pruned 0 sessions\n");
    expect(listRows().map((row) => row.sessionId)).toEqual(["unviewed"]);
  });
```

Still in Step 1 — the lineage-aware manual clear tests. In `test/registry.test.ts`, inside `describe("repair commands", …)`, append after the existing `clearSession` test:

```typescript
  test("clearSession deletes resolved Paseo-linked descendants too", () => {
    applyRegistryEvents(db, [
      { ...start("orchestrator"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("worker-a"), origin: { kind: "paseo", ref: "agent-a" } },
      { ...start("worker-b"), origin: { kind: "paseo", ref: "agent-b" } },
      { ...start("unrelated"), origin: { kind: "paseo", ref: "agent-z" } },
    ]);
    db.run(
      "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id IN ('worker-a', 'worker-b')",
    );
    applyRegistryEvents(db, [simple("Stop", "worker-a", { at: at(5) }), simple("Stop", "worker-b", { at: at(6) })]);

    expect(clearSession(db, "claude", "orchestrator")).toBe("applied");
    // The whole Paseo subtree is gone; unrelated roots survive.
    expect(allRows().map((row) => row.session_id)).toEqual(["unrelated"]);
  });

  test("clearSession follows only resolved links: an ambiguous ref keeps the alleged child", () => {
    applyRegistryEvents(db, [
      { ...start("dup-a"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("dup-b"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("worker"), origin: { kind: "paseo", ref: "agent-1" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'worker'");

    expect(clearSession(db, "claude", "dup-a")).toBe("applied");
    expect(allRows().map((row) => row.session_id).sort()).toEqual(["dup-b", "worker"]);
  });
```

In `test/cli.test.ts`, append after the prune test above:

```typescript
  test("sessions clear removes Paseo-linked descendants with the orchestrator", async () => {
    initRegistry();
    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      applyRegistryEvents(db, [
        {
          kind: "SessionStart",
          provider: "claude",
          sessionId: "orchestrator",
          title: null,
          project: null,
          ghosttyTerminalId: null,
          transcriptPath: null,
          model: null,
          observedAt: NOW,
          origin: { kind: "paseo", ref: "agent-0" },
        },
        {
          kind: "SessionStart",
          provider: "claude",
          sessionId: "worker",
          title: null,
          project: null,
          ghosttyTerminalId: null,
          transcriptPath: null,
          model: null,
          observedAt: NOW,
          origin: { kind: "paseo", ref: "agent-1" },
        },
      ]);
      db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'worker'");
    } finally {
      db.close();
    }
    const harness = makeHarness();
    expect(await runCli(["sessions", "clear", "claude", "orchestrator"], harness.deps)).toBe(0);
    expect(listRows()).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/registry.test.ts test/cli.test.ts test/daemon.test.ts`
Expected: FAIL — the stale unviewed rows are pruned, Paseo ancestors are not kept, and clear leaves Paseo descendants behind.

- [ ] **Step 3: Implement lineage-aware prune and clear**

In `src/core/registry.ts`:

1. Replace `clearSession` with the lineage-aware version:

```typescript
/**
 * Repair one selected session: delete that composite identity — cascading
 * to its native descendants by foreign key AND to its resolved Paseo-linked
 * descendants (clearing an orchestrator clears its whole logical tree) —
 * inside one write transaction. Ambiguous refs are never followed
 * (projection-equivalent resolution). Never touches schema or recreates
 * the database.
 */
export const clearSession = (db: Database, provider: Provider, sessionId: string): MutationResult =>
  inWriteTransaction(db, () => {
    if (getRow(db, provider, sessionId) === null) {
      return "ignored";
    }
    // Resolve the lineage BEFORE deleting anything: the walk reads origin
    // rows the deletes are about to remove.
    const subtree = paseoSubtreeIdentities(db, provider, sessionId);
    for (const identity of subtree) {
      db.run("DELETE FROM active_sessions WHERE provider = ? AND session_id = ?", [
        identity.provider,
        identity.sessionId,
      ]);
    }
    return "applied";
  });
```

2. Replace `pruneStaleSessions` with the Paseo-tree-aware version. The resolved Paseo ancestors of every unviewed row are materialized into a temp table that seeds the recursive keep set alongside the lease/unviewed rows; the native recursion then carries protection up native parentage exactly as before:

```typescript
export const pruneStaleSessions = (db: Database, cutoffIso: string, zcodeCutoffIso: string = cutoffIso): number =>
  inWriteTransaction(db, () => {
    // Resolved-Paseo protection: an unviewed row keeps its whole logical
    // tree, so every resolved Paseo ancestor (unique refs, cycles excluded
    // — projection-equivalent) joins the keep set. SQL cannot express that
    // resolution, so compute it here and seed the recursive CTE from a
    // temp table.
    const rows = db
      .query(
        `SELECT provider, session_id, origin_ref, origin_subagent, origin_parent_ref, unread_since
           FROM active_sessions`,
      )
      .all() as Array<{
      provider: Provider;
      session_id: string;
      origin_ref: string | null;
      origin_subagent: number;
      origin_parent_ref: string | null;
      unread_since: string | null;
    }>;
    const links = resolvePaseoParentLinks(
      rows.map((row) => ({
        provider: row.provider,
        sessionId: row.session_id,
        originRef: row.origin_ref,
        originSubagent: row.origin_subagent,
        originParentRef: row.origin_parent_ref,
      })),
    );
    db.exec(
      `CREATE TEMP TABLE IF NOT EXISTS prune_keep_paseo (
         provider TEXT NOT NULL,
         session_id TEXT NOT NULL,
         PRIMARY KEY (provider, session_id)
       )`,
    );
    db.exec("DELETE FROM prune_keep_paseo");
    const protectedKeys = new Set<string>();
    for (const row of rows) {
      if (row.unread_since === null) {
        continue;
      }
      const visited = new Set<string>();
      let current: string | undefined = `${row.provider}\u0000${row.session_id}`;
      while (current !== undefined && !visited.has(current)) {
        visited.add(current);
        current = links.get(current);
      }
      for (const key of visited) {
        protectedKeys.add(key);
      }
    }
    for (const key of protectedKeys) {
      const separator = key.indexOf("\u0000");
      db.run("INSERT OR IGNORE INTO prune_keep_paseo (provider, session_id) VALUES (?, ?)", [
        key.slice(0, separator),
        key.slice(separator + 1),
      ]);
    }
    // Rows inside their lease, rows holding unviewed results, and the
    // protected Paseo identities all seed the keep set; every ancestor of a
    // kept row joins it. A kept top-level row's tree is never deleted, so
    // children only ever go with a fully stale, fully viewed tree via the
    // cascade.
    const keepSet = `WITH RECURSIVE keep(provider, session_id) AS (
         SELECT provider, session_id FROM active_sessions
          WHERE (provider = 'zcode' AND updated_at >= ?1) OR (provider != 'zcode' AND updated_at >= ?2)
             OR unread_since IS NOT NULL
         UNION
         SELECT provider, session_id FROM prune_keep_paseo
         UNION
         SELECT child.provider, child.parent_session_id
           FROM active_sessions AS child
           JOIN keep ON keep.provider = child.provider AND keep.session_id = child.session_id
          WHERE child.parent_session_id IS NOT NULL
       )
       SELECT provider, session_id FROM keep`;
    const stale = db
      .query(
        `SELECT COUNT(*) AS n FROM active_sessions
         WHERE parent_session_id IS NULL
           AND (provider, session_id) NOT IN (${keepSet})`,
      )
      .get(zcodeCutoffIso, cutoffIso) as { n: number } | null;
    const count = stale?.n ?? 0;
    if (count > 0) {
      db.run(
        `DELETE FROM active_sessions
         WHERE parent_session_id IS NULL
           AND (provider, session_id) NOT IN (${keepSet})`,
        [zcodeCutoffIso, cutoffIso],
      );
    }
    return count;
  });
```

3. Update `pruneStaleSessions`'s doc comment — replace the sentence beginning `A row inside its lease keeps every ancestor alive` with:

```
 * A row inside its lease keeps every ancestor alive, and so does any row
 * holding an unviewed result (`unread_since` non-null) — including the
 * unviewed row's whole resolved Paseo tree: prune is liveness cleanup,
 * never a purge of results the user has not seen. The operator's
 * intentional purges are clear/clear-all and dismiss/archive.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/registry.test.ts test/cli.test.ts test/daemon.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/registry.ts test/registry.test.ts test/cli.test.ts test/daemon.test.ts
git commit -m "feat(registry): prune and clear respect Paseo lineage; prune never touches the unviewed"
```

---

### Task 7: Viewed-expiry sweep (R8) + durability

**Files:**
- Modify: `src/core/registry.ts` (new export after `pruneStaleSessions`), `src/core/daemon.ts` (constants :53-77, imports :43-49, `maintain` prune block :253-262, module header :18-27)
- Test: `test/registry.test.ts`, `test/daemon.test.ts`

**Interfaces:**
- Consumes: `viewed_since` semantics from Task 2; prune from Task 6.
- Produces:
  - `export const sweepExpiredResults = (db: Database, cutoffIso: string, sweptAt: string): number` — auto-dismisses every IDLE-or-ERROR row with `viewed_since <= cutoffIso` that holds `done_since` or `error` status (clears ledgers, retires errors with `status_since = sweptAt`, the actual retirement instant — never the cutoff); returns rows swept. Active (`working`/`waiting`) rows are never swept even when they retain a stale done ledger.
  - `export const VIEWED_EXPIRY_TTL_MS = 24 * 60 * 60 * 1000` from `daemon.ts`; the daemon's 60s prune tick runs the sweep first, then prune.

- [ ] **Step 1: Write the failing registry tests**

In `test/registry.test.ts`: add `sweepExpiredResults` to the registry import (alphabetical position after `pruneStaleSessions`), then append:

```typescript
describe("sweepExpiredResults", () => {
  const VIEWED = "2026-08-01T00:00:00.000Z";
  const CUTOFF = "2026-08-02T00:00:00.000Z"; // viewed + 24h
  const SWEPT_AT = "2026-08-02T06:00:00.000Z"; // the sweep's own instant

  const seedDoneViewed = (sessionId: string): void => {
    applyRegistryEvents(db, [start(sessionId), simple("Stop", sessionId, { at: at(5) })]);
    viewSession(db, "claude", sessionId, VIEWED);
  };

  test("auto-dismisses a done row viewed older than the cutoff", () => {
    seedDoneViewed("s1");
    expect(sweepExpiredResults(db, CUTOFF, SWEPT_AT)).toBe(1);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      unread_since: null,
      done_since: null,
      viewed_since: null,
    });
  });

  test("retires an error row viewed older than the cutoff, stamping status_since at the sweep instant", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", VIEWED);
    expect(sweepExpiredResults(db, CUTOFF, SWEPT_AT)).toBe(1);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      background_outstanding: 0,
      viewed_since: null,
      status_since: SWEPT_AT, // the retirement time — not the cutoff
    });
  });

  test("an unviewed done row of any age is never swept", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(sweepExpiredResults(db, "2027-01-01T00:00:00.000Z", SWEPT_AT)).toBe(0);
    expect(getRow("s1")).toMatchObject({ unread_since: at(5), done_since: at(5) });
  });

  test("a row viewed exactly at the cutoff is swept (inclusive)", () => {
    seedDoneViewed("s1");
    expect(sweepExpiredResults(db, VIEWED, SWEPT_AT)).toBe(1);
  });

  test("a viewed row inside the 24h window is kept", () => {
    seedDoneViewed("s1");
    expect(sweepExpiredResults(db, "2026-08-01T12:00:00.000Z", SWEPT_AT)).toBe(0);
    expect(getRow("s1")?.done_since).toBe(at(5));
  });

  test("a working row with a stale viewed done ledger is never swept", () => {
    // Done lands, the session is viewed, then work resumes — Activity leaves
    // the done ledger in place (status transitions don't clear it), so the
    // row carries an expired view clock AND a done stamp while working.
    applyRegistryEvents(db, [start("busy"), simple("Stop", "busy", { at: at(4) })]);
    viewSession(db, "claude", "busy", VIEWED);
    applyRegistryEvents(db, [simple("Activity", "busy", { at: at(6) })]);
    expect(getRow("busy")).toMatchObject({ status: "working", done_since: at(4), viewed_since: VIEWED });
    expect(sweepExpiredResults(db, CUTOFF, SWEPT_AT)).toBe(0);
    expect(getRow("busy")).toMatchObject({ status: "working", done_since: at(4), viewed_since: VIEWED });
  });

  test("a waiting row with a stale viewed done ledger is never swept", () => {
    applyRegistryEvents(db, [start("blocked"), simple("Stop", "blocked", { at: at(4) })]);
    viewSession(db, "claude", "blocked", VIEWED);
    applyRegistryEvents(db, [simple("Attention", "blocked", { at: at(6) })]);
    expect(getRow("blocked")).toMatchObject({ status: "waiting", done_since: at(4), viewed_since: VIEWED });
    expect(sweepExpiredResults(db, CUTOFF, SWEPT_AT)).toBe(0);
    expect(getRow("blocked")).toMatchObject({ status: "waiting", done_since: at(4), viewed_since: VIEWED });
  });

  test("a new result after the view cancels the sweep (the card is unviewed again)", () => {
    seedDoneViewed("s1");
    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(8) }), simple("Stop", "s1", { at: at(9) })]);
    expect(sweepExpiredResults(db, CUTOFF, SWEPT_AT)).toBe(0);
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(9), viewed_since: null });
  });

  test("an ended error card lives out its post-view window, then the sweep dismisses it", () => {
    // The full R10 chain: failure → end (retained with a done hold) → view
    // (clock starts, card stays) → expiry (dismissed after the window).
    const viewedAt = "2026-08-06T01:00:00.000Z";
    const cutoff = "2026-08-07T01:00:00.000Z"; // viewedAt + 24h
    const sweptAt = "2026-08-07T02:00:00.000Z";
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(9) })]);
    expect(viewSession(db, "claude", "s1", viewedAt)).toBe("applied");
    expect(getRow("s1")).toMatchObject({ ended_at: at(9), done_since: at(9), viewed_since: viewedAt });
    // Inside the window the card stays.
    expect(sweepExpiredResults(db, "2026-08-06T12:00:00.000Z", sweptAt)).toBe(0);
    expect(getRow("s1")?.done_since).toBe(at(9));
    // Past it, the sweep dismisses; the row remains for prune at its TTL.
    expect(sweepExpiredResults(db, cutoff, sweptAt)).toBe(1);
    expect(getRow("s1")).toMatchObject({ status: "idle", done_since: null, viewed_since: null, ended_at: at(9) });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/registry.test.ts`
Expected: FAIL — `sweepExpiredResults` is not exported.

- [ ] **Step 3: Implement the sweep**

Append after `pruneStaleSessions` in `src/core/registry.ts`:

```typescript
/**
 * The viewed-expiry sweep: auto-dismiss every idle or error row whose most
 * recent view is at or before the caller's cutoff and that still holds a
 * finished result — `done_since` or an `error` status. Clears the ledgers
 * (including any residual unread) and retires errors like a dismissal,
 * stamping the retirement's `status_since` with `sweptAt` — the sweep's own
 * instant, never the cutoff. The clock runs from the most recent view;
 * wall-clock time counts — sleep and daemon downtime included — because
 * expiry evaluates on the next tick using the cutoff the caller computes
 * from now. Rows never viewed (`viewed_since` null) are never swept, and
 * neither are working or waiting rows: a resumed turn can retain a stale
 * done ledger, and expiry must not delete an active card's result. Returns
 * the rows swept.
 */
export const sweepExpiredResults = (db: Database, cutoffIso: string, sweptAt: string): number =>
  inWriteTransaction(db, () => {
    const result = db.run(
      `UPDATE active_sessions
       SET done_since = NULL, unread_since = NULL, viewed_since = NULL,
           status = CASE WHEN status = 'error' THEN 'idle' ELSE status END,
           status_since = CASE WHEN status = 'error' THEN ? ELSE status_since END,
           background_outstanding = CASE WHEN status = 'error' THEN 0 ELSE background_outstanding END
       WHERE viewed_since IS NOT NULL AND viewed_since <= ?
         AND status IN ('idle', 'error')
         AND (done_since IS NOT NULL OR status = 'error')`,
      [sweptAt, cutoffIso],
    );
    return result.changes;
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing daemon tests**

In `test/daemon.test.ts`:

1. Add `VIEWED_EXPIRY_TTL_MS` to the daemon import and `viewSession` to the registry import:

```typescript
import {
  DAEMON_PASEO_INTERVAL_MS,
  DAEMON_POLL_INTERVAL_MS,
  type DaemonDependencies,
  ProjectionDaemon,
  VIEWED_EXPIRY_TTL_MS,
} from "../src/core/daemon";
```

```typescript
import { applyRegistryEvents, syncPaseoStates, viewSession } from "../src/core/registry";
```

2. Replace the test `"prunes sessions whose last hook is older than the TTL and republishes"` with (the old fixture's `Stop` now stamps unread, which R9 exempts from prune — seed active rows instead):

```typescript
  test("prunes sessions whose last hook is older than the TTL and republishes", () => {
    // Active rows carry no ledgers, so only the TTL decides.
    const activeSession = (sessionId: string, observedAt: string): void => {
      apply([
        {
          kind: "SessionStart",
          provider: "claude",
          sessionId,
          title: `Title for ${sessionId}`,
          project: null,
          ghosttyTerminalId: null,
          transcriptPath: null,
          model: null,
          observedAt,
        },
        { kind: "Activity", provider: "claude", sessionId, observedAt },
      ]);
    };
    activeSession("stale", "2026-08-01T00:00:00.000Z");
    activeSession("fresh", NOW);
    const harness = makeHarness();
    harness.daemon.start();
    try {
      expect(readSnapshotFile().sessions.map((session) => session.sessionId)).toEqual(["fresh"]);
      const rows = (() => {
        const db = openRegistryDatabase(paths.database, "readonly");
        try {
          return db.query("SELECT session_id FROM active_sessions").all() as { session_id: string }[];
        } finally {
          db.close();
        }
      })();
      expect(rows).toEqual([{ session_id: "fresh" }]);
    } finally {
      harness.daemon.stop();
    }
  });
```

3. Append the sweep tests (same describe block, after the prune test):

```typescript
  test("sweeps a done card 24h after its view and republishes", () => {
    startSession("viewed");
    const viewedAt = "2026-08-06T01:00:00.000Z";
    const view = openRegistryDatabase(paths.database, "readwrite");
    try {
      viewSession(view, "claude", "viewed", viewedAt);
    } finally {
      view.close();
    }
    startSession("unviewed", "2026-08-01T00:00:00.000Z"); // five days old, never viewed

    const clock = fakeClock(Date.parse(viewedAt));
    const harness = makeHarness({ nowMs: clock.nowMs });
    harness.daemon.start();
    try {
      // Inside the window: both cards present.
      expect(readSnapshotFile().sessions.map((session) => session.sessionId).sort()).toEqual(["unviewed", "viewed"]);

      // Wall-clock 24h+ later (sleep or daemon downtime included): the
      // viewed card is swept on the first tick after; the unviewed one
      // survives at any age.
      clock.advance(VIEWED_EXPIRY_TTL_MS + 60_000);
      harness.tick();
      expect(readSnapshotFile().sessions.map((session) => session.sessionId)).toEqual(["unviewed"]);
    } finally {
      harness.daemon.stop();
    }
  });

  test("daemon restart with unviewed results: everything is still present", () => {
    startSession("kept", "2026-08-01T00:00:00.000Z"); // old AND unviewed
    const first = makeHarness();
    first.daemon.start();
    first.daemon.stop();

    // A fresh daemon instance reopens the database from disk.
    const second = makeHarness();
    second.daemon.start();
    try {
      expect(readSnapshotFile().sessions.map((session) => session.sessionId)).toEqual(["kept"]);
      const db = openRegistryDatabase(paths.database, "readonly");
      try {
        expect(db.query("SELECT COUNT(*) AS n FROM active_sessions").get()).toEqual({ n: 1 });
      } finally {
        db.close();
      }
    } finally {
      second.daemon.stop();
    }
  });
```

- [ ] **Step 6: Run daemon tests to verify they fail**

Run: `bun test test/daemon.test.ts`
Expected: FAIL — `VIEWED_EXPIRY_TTL_MS` is not exported; the sweep test finds the viewed card still present after the advance.

- [ ] **Step 7: Wire the sweep into the daemon**

In `src/core/daemon.ts`:

1. Add the TTL constant after `ZCODE_STALE_SESSION_TTL_MS`:

```typescript
/** A done or errored row viewed this long ago auto-dismisses; unviewed rows never expire. */
export const VIEWED_EXPIRY_TTL_MS = 24 * 60 * 60 * 1000;
```

2. Extend the registry import:

```typescript
import {
  listTitleTargets,
  pruneStaleSessions,
  sweepExpiredResults,
  updateSessionActivityLines,
  updateSessionModels,
  updateSessionTitles,
} from "./registry";
```

3. In `maintain`, replace the prune-cadence block with (sweep first, then prune — a card swept of its ledgers can leave on the same tick):

```typescript
      if (this.state.lastPrunePassAtMs === null || nowMs - this.state.lastPrunePassAtMs >= DAEMON_PRUNE_INTERVAL_MS) {
        this.state.lastPrunePassAtMs = nowMs;
        const nowIso = new Date(nowMs).toISOString();
        const expiryCutoff = new Date(nowMs - VIEWED_EXPIRY_TTL_MS).toISOString();
        if (sweepExpiredResults(this.connection, expiryCutoff, nowIso) > 0) {
          changed = true;
        }
        const cutoff = new Date(nowMs - STALE_SESSION_TTL_MS).toISOString();
        const zcodeCutoff = new Date(nowMs - ZCODE_STALE_SESSION_TTL_MS).toISOString();
        if (pruneStaleSessions(this.connection, cutoff, zcodeCutoff) > 0) {
          changed = true;
        }
      }
```

4. In the module header, replace the exact sentence

```
 * matching rows) on the same cadence, and a prune pass (delete sessions
```

with

```
 * matching rows) on the same cadence, a viewed-expiry sweep (auto-dismiss
 * done/errored rows viewed more than 24 hours ago — unviewed rows never
 * expire), and a prune pass (delete sessions
```

and in the same header, extend the prune clause — replace

```
 * everyone else — so a live subagent always keeps its thread) every minute.
```

with

```
 * everyone else, skipping any tree that still holds an unviewed result —
 * so a live subagent always keeps its thread) every minute.
```

(Verify the header's line wrapping afterwards — keep the comment block's existing width.)

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test test/daemon.test.ts`
Expected: PASS.

- [ ] **Step 9: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/core/registry.ts src/core/daemon.ts test/registry.test.ts test/daemon.test.ts
git commit -m "feat(daemon): viewed results expire 24h after viewing; unviewed never do"
```

---

### Task 8: Snapshot surface — `pendingResults` and `endedAt` wired end to end (R6 wire, R10 wire)

**Files:**
- Modify: `src/protocol.ts` (ProjectedSession :104-133, ProjectedAgentNode :139-167, parseAgent :198-330, parseSession :356-480), `src/core/projection.ts` (ProjectionRow :24-46, StoredRow :533-555, toProjectionRow :570-660, PROJECTION_COLUMNS :662-663, rootFacts :307-328, nativeNode :351-376)
- Test: `test/protocol.test.ts`, `test/projection.test.ts`, plus mechanical factory updates enumerated in Step 4

**Interfaces:**
- Consumes: `ended_at` column from Task 4.
- Produces: `ProjectedSession.pendingResults: number`, `ProjectedSession.endedAt: string | null`, `ProjectedAgentNode.pendingResults: number`, `ProjectedAgentNode.endedAt: string | null`; parsers tolerate missing keys (old daemons) with defaults `0`/`null`; native agent nodes validate both as `0`/`null`. The projection carries `ended_at` from the stored row end to end and publishes it, and populates `pendingResults` with the placeholder `0` — Task 9 replaces the placeholder with the real roll-up. Both producers are populated HERE so this task's green checkpoint typechecks the whole repository.

- [ ] **Step 1: Write the failing protocol tests**

In `test/protocol.test.ts`:

1. Add the new fields to the `valid` snapshot's session literal (after `doneSince: null,`):

```typescript
      pendingResults: 0,
      endedAt: null,
```

and to the `agent` factory (after `doneSince: null,`):

```typescript
  pendingResults: 0,
  endedAt: null,
```

2. Append these tests at the end of the `describe("parseSessionSnapshot", …)` block (after the `doneSince` test):

```typescript
  test("pendingResults parses when present, defaults to 0 when the key is absent, and rejects non-integers", () => {
    expect(parseSessionSnapshot(withSession({ pendingResults: 2 })).sessions[0]?.pendingResults).toBe(2);
    // Cross-version tolerance: a snapshot written before the field existed
    // carries no key at all and parses to 0.
    const absent = { ...firstSession() } as Partial<ProjectedSession>;
    delete absent.pendingResults;
    expect(parseSessionSnapshot({ ...valid, sessions: [absent] }).sessions[0]?.pendingResults).toBe(0);
    expect(() => parseSessionSnapshot(withSession({ pendingResults: -1 }))).toThrow("session.pendingResults");
    expect(() => parseSessionSnapshot(withSession({ pendingResults: 1.5 }))).toThrow("session.pendingResults");
    expect(() => parseSessionSnapshot(withSession({ pendingResults: "2" as unknown as number }))).toThrow(
      "session.pendingResults",
    );
  });

  test("endedAt parses when present, defaults to null when the key is absent, and rejects non-strings", () => {
    const stamp = "2026-08-27T05:00:00.000Z";
    expect(parseSessionSnapshot(withSession({ endedAt: stamp })).sessions[0]?.endedAt).toBe(stamp);
    const absent = { ...firstSession() } as Partial<ProjectedSession>;
    delete absent.endedAt;
    expect(parseSessionSnapshot({ ...valid, sessions: [absent] }).sessions[0]?.endedAt).toBeNull();
    const malformed = { ...valid, sessions: [{ ...firstSession(), endedAt: 12 }] };
    expect(() => parseSessionSnapshot(malformed)).toThrow("session.endedAt");
  });

  test("native agent nodes reject pendingResults and endedAt (display-only rows carry no retention facts)", () => {
    const native = agent({
      sessionId: "native-child",
      role: "subagent",
      lineage: "native",
      parent: { provider: "claude", sessionId: "agent-root" },
      logicalSlot: null,
    });
    expect(
      parseSessionSnapshot({ ...valid, agents: [agent(), native] }).agents?.map((node) => node.sessionId),
    ).toEqual(["agent-root", "native-child"]);
    expect(() =>
      parseSessionSnapshot({ ...valid, agents: [agent(), { ...native, pendingResults: 1 }] }),
    ).toThrow("agent native role invariants are invalid");
    expect(() =>
      parseSessionSnapshot({ ...valid, agents: [agent(), { ...native, endedAt: "2026-08-27T05:00:00.000Z" }] }),
    ).toThrow("agent native role invariants are invalid");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/protocol.test.ts`
Expected: FAIL — the literals are type errors (`pendingResults`/`endedAt` missing from the types) and the parser rejects/ignores the new keys incorrectly.

- [ ] **Step 3: Implement the protocol additions and the projection plumbing**

The projection must populate the new required fields in this same task, or the repository does not typecheck. In `src/core/projection.ts`:

1. `ProjectionRow` — add after `doneSince`:

```typescript
  endedAt: string | null;
```

2. `StoredRow` — add after `done_since`:

```typescript
  ended_at: unknown;
```

3. `toProjectionRow` — extend the corruption guard that currently checks `unread_since`/`done_since`/`status_since`:

```typescript
  if (
    !isBinary(row.origin_subagent) ||
    !isStringOrNull(row.unread_since) ||
    !isStringOrNull(row.done_since) ||
    !isStringOrNull(row.status_since) ||
    !isStringOrNull(row.ended_at)
  ) {
    throw new ProjectionError("corrupt-row");
  }
```

and add `endedAt: row.ended_at,` to the returned object (after `doneSince`).

4. `PROJECTION_COLUMNS` — append `, ended_at`:

```typescript
const PROJECTION_COLUMNS =
  "provider, session_id, parent_session_id, status, title, project, logical_slot, ghostty_terminal_id, model, opened_at, origin_kind, origin_ref, origin_subagent, unread_since, done_since, status_since, activity_line, transcript_path, origin_parent_ref, updated_at, ended_at";
```

5. `rootFacts` — add the two published fields (`pendingResults` is the placeholder `0` until Task 9 computes the real roll-up; `endedAt` is already wired end to end):

```typescript
    unreadSince: result.row.unreadSince,
    doneSince: result.row.doneSince,
    pendingResults: 0,
    endedAt: result.row.endedAt,
```

6. `nativeNode` — native children are display-only and carry no retention facts:

```typescript
    unreadSince: null,
    doneSince: null,
    pendingResults: 0,
    endedAt: null,
```

Then in `src/protocol.ts`:

1. `ProjectedSession` — add after `doneSince`:

```typescript
  /** Count of Paseo-lineage descendants holding an unviewed result (rolled-up pending results). */
  pendingResults: number;
  /** ISO-8601 UTC when the session ended holding an unviewed result and was retained; null otherwise. */
  endedAt: string | null;
```

2. `ProjectedAgentNode` — add after `doneSince`:

```typescript
  /** Count of Paseo-lineage descendants holding an unviewed result (rolled-up pending results). */
  pendingResults: number;
  /** ISO-8601 UTC when the session ended holding an unviewed result and was retained; null otherwise. */
  endedAt: string | null;
```

3. `parseAgent` — after the `doneSince` validation block, add:

```typescript
  const pendingResults = "pendingResults" in value ? value["pendingResults"] : 0;
  if (!isNonNegativeInteger(pendingResults)) {
    return invalid("agent.pendingResults must be a non-negative integer");
  }
  const endedAt = "endedAt" in value ? value["endedAt"] : null;
  if (!isNullableBoundedString(endedAt)) {
    return invalid("agent.endedAt must be null or a bounded string");
  }
```

and extend the native-role invariant condition (the `if` inside `else if (lineage === "native")`) by appending to its disjunction:

```typescript
      unreadSince !== null ||
      doneSince !== null ||
      pendingResults !== 0 ||
      endedAt !== null
```

and add `pendingResults, endedAt` to the returned object (after `doneSince`).

4. `parseSession` — after the `doneSince` validation block, add:

```typescript
  const pendingResults = "pendingResults" in value ? value["pendingResults"] : 0;
  if (!isNonNegativeInteger(pendingResults)) {
    return invalid("session.pendingResults must be a non-negative integer");
  }
  const endedAt = "endedAt" in value ? value["endedAt"] : null;
  if (!isNullableBoundedString(endedAt)) {
    return invalid("session.endedAt must be null or a bounded string");
  }
```

and add `pendingResults, endedAt` to the returned object (after `doneSince`).

- [ ] **Step 4: Update the projection suite for the wired fields**

In `test/projection.test.ts`:

1. `row()` helper — add `endedAt?: string | null;` to the options type and `endedAt: options.endedAt ?? null,` to the returned object (next to `doneSince`).

2. Update the full-literal assertions in `"projects one consistent snapshot from a separately committed writer"`: add `pendingResults: 0, endedAt: null` to the single session object (after `doneSince: null,`) and to all three agent objects (after each `doneSince: null,`).

3. Append to the `readProjection` describe:

```typescript
  test("an ended root publishes endedAt through the snapshot", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);
      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "ended",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-26T05:00:00.000Z",
          },
          { kind: "Stop", provider: "claude", sessionId: "ended", observedAt: "2026-08-26T05:01:00.000Z" },
          { kind: "SessionEnd", provider: "claude", sessionId: "ended", observedAt: "2026-08-26T05:02:00.000Z" },
        ]);
      } finally {
        writer.close();
      }
      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        const snapshot = readProjection(reader);
        expect(snapshot.sessions[0]).toMatchObject({
          sessionId: "ended",
          endedAt: "2026-08-26T05:02:00.000Z",
          pendingResults: 0,
        });
        expect(snapshot.agents?.[0]).toMatchObject({
          sessionId: "ended",
          endedAt: "2026-08-26T05:02:00.000Z",
          pendingResults: 0,
        });
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("rejects a corrupt ended_at and rolls back the read transaction", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);
      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "bad-ended-at",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-26T05:00:00.000Z",
          },
        ]);
        writer.run("UPDATE active_sessions SET ended_at = x'00' WHERE session_id = 'bad-ended-at'");
      } finally {
        writer.close();
      }
      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        expect(() => readProjection(reader)).toThrow(new ProjectionError("corrupt-row"));
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 5: Update every typed factory/literal across the suites**

Add `pendingResults: 0, endedAt: null` to each `ProjectedSession` factory body (next to `doneSince`) and to each `ProjectedAgentNode` factory body, in:

- `test/strip-snapshot-view.test.ts` (session factory; also the `ProjectedAgentNode` literals — the `cycle` array entries and the `native` literal)
- `test/strip-routing.test.ts` (session factory)
- `test/layout.test.ts` (session factory; the `native` node literal)
- `test/strip-cards.test.ts` (session factory)
- `test/strip-tile-identity.test.ts` (session factory)
- `test/render.test.ts` (session factory)
- `test/strip-dismissals.test.ts` (session and node factories)
- `test/strip-board.test.ts` (session factory and node factory)
- `test/controller.test.ts` (session factory)
- `test/strip-action-sheet.test.ts` (session factory)
- `test/press.test.ts` (session factory)
- `test/daemon.test.ts` (the `HEALTHY_S1` literal — its one session object and its one agent object)

Add only these two fields; do not reorder existing fields. (The `PlacedCard`/`BoardCardSeed` literals in strip-cards, strip-tile-identity, and strip-board are NOT touched here — `BoardCardSeed.pendingResults` arrives in Task 13.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/protocol.test.ts test/projection.test.ts && bun test`
Expected: PASS (`pendingResults` publishes the placeholder `0` until Task 9 computes it).

- [ ] **Step 7: Typecheck + lint**

Run: `bun run typecheck && biome check .`
Expected: PASS — the whole repository compiles because projection populates both new required fields.

- [ ] **Step 8: Commit**

```bash
git add src/protocol.ts src/core/projection.ts test/
git commit -m "feat(protocol): snapshot roots carry pendingResults and endedAt"
```

---

### Task 9: Projection roll-up + fail-safe promotion (R6, R7)

**Files:**
- Modify: `src/core/projection.ts` (the region between the Paseo status roll-up loop and `rootVisible` :277-302, `rootFacts` :307-328)
- Test: `test/projection.test.ts`

**Interfaces:**
- Consumes: the Task 8 wiring (`ProjectionRow.endedAt` carried; `pendingResults: 0` placeholder published; `resolvePaseoParentLinks` shared helper from Task 2, which `projectSnapshotRows` already uses since the Task 2 extraction).
- Produces: finished Paseo subagents with a resolvable parent are hidden and roll their ledgers up to the root ancestor; unresolvable ancestry (dangling ref, ambiguous ref, cycle, missing parent row) promotes the subagent to its own root card (fail-safe); published roots carry the REAL `pendingResults` (count of Paseo descendants with `unreadSince`) and an aggregated `unreadSince` (the latest of own + descendants') — replacing Task 8's placeholder and per-row stamp; active subagent cards unchanged.

- [ ] **Step 1: Write the failing tests**

In `test/projection.test.ts`:

1. Replace the test `"an idle paseo subagent with only a done stamp stays hidden (mirrors the unread rule)"` with:

```typescript
  test("an idle paseo subagent with a done stamp stays hidden while its parent holds the roll-up", () => {
    const sessions = projectRows([
      row("parent", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
      row("sub", {
        status: "idle",
        unreadSince: null,
        doneSince: "2026-08-16T00:05:00.000Z",
        originKind: "paseo",
        originRef: "a1",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["parent"]);
  });
```

2. Replace the test `"an idle paseo subagent is hidden even when its result is unread"` with:

```typescript
  test("an idle paseo subagent is hidden even when its result is unread — the parent carries it", () => {
    // Subagent results are consumed by the orchestrating parent agent, so a
    // finished paseo subagent must not hold the grid as an unread tile; the
    // roll-up holds the root ancestor with a badge instead.
    const sessions = projectRows([
      row("parent", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
      row("sub", {
        status: "idle",
        unreadSince: "2026-08-16T00:00:00.000Z",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["parent"]);
    expect(sessions[0]).toMatchObject({ pendingResults: 1, unreadSince: "2026-08-16T00:00:00.000Z" });
  });
```

3. Replace the test `"an idle paseo subagent retains neither itself nor its read-idle parent; losing the last active descendant hides the parent again"` with:

```typescript
  test("a finished subagent's ledger holds its read-idle parent; viewing empties the badge but done keeps the card", () => {
    const parent = () =>
      row("parent", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      });
    const sub = (status: SessionStatus, unreadSince: string | null, doneSince: string | null = null) =>
      row("sub", {
        status,
        unreadSince,
        doneSince,
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      });

    // An unread finished subagent holds the parent with a badge.
    const rolled = projectRows([parent(), sub("idle", "2026-08-25T00:00:09.000Z", "2026-08-25T00:00:09.000Z")]);
    expect(rolled.map((session) => session.sessionId)).toEqual(["parent"]);
    expect(rolled[0]).toMatchObject({ pendingResults: 1, unreadSince: "2026-08-25T00:00:09.000Z" });

    // Viewed (unread cleared) but done: the badge empties, the card stays.
    const viewed = projectRows([parent(), sub("idle", null, "2026-08-25T00:00:09.000Z")]);
    expect(viewed.map((session) => session.sessionId)).toEqual(["parent"]);
    expect(viewed[0]).toMatchObject({ pendingResults: 0, unreadSince: null });

    // While the subagent works, both show (active cards unchanged).
    expect(projectRows([parent(), sub("working", null)]).map((session) => session.sessionId)).toEqual([
      "parent",
      "sub",
    ]);

    // No ledger anywhere: the parent hides again.
    expect(projectRows([parent()])).toEqual([]);
  });
```

4. Append the new coverage block inside the same describe:

```typescript
  test("an idle parent with two finished idle subagents stays visible with pendingResults and aggregated unread", () => {
    const sessions = projectRows([
      row("parent", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
      row("sub-a", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:05.000Z",
        doneSince: "2026-08-25T00:00:05.000Z",
        originKind: "paseo",
        originRef: "agent-a",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      }),
      row("sub-b", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:09.000Z",
        doneSince: "2026-08-25T00:00:09.000Z",
        originKind: "paseo",
        originRef: "agent-b",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 3,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["parent"]);
    expect(sessions[0]).toMatchObject({ pendingResults: 2, unreadSince: "2026-08-25T00:00:09.000Z" });
  });

  test("roll-up reaches the root ancestor at nested depth", () => {
    const sessions = projectRows([
      row("grand", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-g",
        originSubagent: 0,
        slot: 1,
      }),
      row("mid", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-m",
        originSubagent: 1,
        originParentRef: "agent-g",
        slot: 2,
      }),
      row("leaf", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:09.000Z",
        doneSince: "2026-08-25T00:00:09.000Z",
        originKind: "paseo",
        originRef: "agent-l",
        originSubagent: 1,
        originParentRef: "agent-m",
        slot: 3,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["grand"]);
    expect(sessions[0]).toMatchObject({ pendingResults: 1, unreadSince: "2026-08-25T00:00:09.000Z" });
  });

  test("aggregated root unread takes the latest stamp across own and descendants", () => {
    const sessions = projectRows([
      row("parent", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:01.000Z",
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
      row("sub", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:09.000Z",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      }),
    ]);
    // The resolvable idle subagent is hidden by this task's own rule —
    // only the parent card publishes, and the child's newer stamp is what
    // the parent's aggregated unread reports.
    expect(sessions.map((session) => session.sessionId)).toEqual(["parent"]);
    expect(sessions[0]).toMatchObject({ pendingResults: 1, unreadSince: "2026-08-25T00:00:09.000Z" });
  });

  test("fail-safe promotion: a finished subagent with a dangling parent ref renders as its own card", () => {
    const sessions = projectRows([
      row("orphan", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:09.000Z",
        doneSince: "2026-08-25T00:00:09.000Z",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "ghost",
        slot: 1,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["orphan"]);
    expect(sessions[0]).toMatchObject({ pendingResults: 0, unreadSince: "2026-08-25T00:00:09.000Z" });
  });

  test("fail-safe promotion: cyclic lineage surfaces every result-bearing row", () => {
    const sessions = projectRows([
      row("loop-a", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:01.000Z",
        doneSince: "2026-08-25T00:00:01.000Z",
        originKind: "paseo",
        originRef: "agent-x",
        originSubagent: 1,
        originParentRef: "agent-y",
        slot: 1,
      }),
      row("loop-b", {
        status: "idle",
        unreadSince: null,
        doneSince: "2026-08-25T00:00:02.000Z",
        originKind: "paseo",
        originRef: "agent-y",
        originSubagent: 1,
        originParentRef: "agent-x",
        slot: 2,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId).sort()).toEqual(["loop-a", "loop-b"]);
  });

  test("fail-safe promotion: a done subagent whose parent row was deleted renders as its own card", () => {
    // The parent's origin_ref no longer exists in the registry.
    const sessions = projectRows([
      row("sub", {
        status: "idle",
        unreadSince: null,
        doneSince: "2026-08-25T00:00:09.000Z",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-gone",
        slot: 1,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["sub"]);
  });

  test("an ended root publishes endedAt and stays visible by its ledgers", () => {
    const sessions = projectRows([
      row("ended", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:09.000Z",
        doneSince: "2026-08-25T00:00:09.000Z",
        endedAt: "2026-08-25T00:01:00.000Z",
        slot: 1,
      }),
    ]);
    expect(sessions[0]).toMatchObject({ sessionId: "ended", endedAt: "2026-08-25T00:01:00.000Z" });
  });
```

(The full-literal updates and the corrupt-`ended_at` test already landed with the Task 8 wiring.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/projection.test.ts`
Expected: FAIL — hidden-subagent expectations invert, `pendingResults` still the placeholder `0`, aggregated unread still the row's own stamp.

- [ ] **Step 3: Implement the roll-up**

In `src/core/projection.ts` (the Task 8 plumbing — `StoredRow.ended_at`, the `toProjectionRow` guard, `PROJECTION_COLUMNS`, `ProjectionRow.endedAt` — is already in place):

1. Replace the `rootVisible` definition and insert the roll-up machinery immediately before it (after the Paseo status roll-up loop that ends with the `for (const result of rootResults) { let carried = … }` block):

```typescript
  // Ledger roll-up along Paseo lineage. A finished subagent's done/unread
  // holds its root ancestor's card: walk each ledger-holding row up its
  // parent chain marking every ancestor. Rows whose lineage cannot resolve
  // (dangling ref, ambiguous ref, cycle — cycle members lost their
  // paseoParent entry above) are their own root, so the walk never reaches
  // them and their own ledger speaks for them (fail-safe promotion:
  // "cannot associate" never means "discard").
  const holdsLedgerKey = new Set<string>();
  for (const result of rootResults) {
    if (result.row.unreadSince !== null || result.row.doneSince !== null) {
      holdsLedgerKey.add(identityKey(result.row.provider, result.row.sessionId));
    }
  }
  const hasDescendantLedger = new Set<string>();
  for (const result of rootResults) {
    const key = identityKey(result.row.provider, result.row.sessionId);
    if (!holdsLedgerKey.has(key)) {
      continue;
    }
    const visited = new Set<string>();
    let parentKey = paseoParent.get(key);
    while (parentKey !== undefined && !visited.has(parentKey)) {
      visited.add(parentKey);
      hasDescendantLedger.add(parentKey);
      parentKey = paseoParent.get(parentKey);
    }
  }

  // Per-root published facts: pendingResults counts Paseo descendants with
  // an unviewed result; the published unreadSince aggregates the root's own
  // stamp with its descendants' (the latest wins), so the rail count stays
  // coherent without double-counting hidden children.
  const paseoChildren = new Map<string, string[]>();
  for (const [childKey, parentKey] of paseoParent) {
    const siblings = paseoChildren.get(parentKey);
    if (siblings === undefined) {
      paseoChildren.set(parentKey, [childKey]);
    } else {
      siblings.push(childKey);
    }
  }
  const pendingResultsOf = new Map<string, number>();
  const aggregatedUnreadOf = new Map<string, string | null>();
  for (const result of rootResults) {
    const key = identityKey(result.row.provider, result.row.sessionId);
    let pending = 0;
    let aggregatedUnread = result.row.unreadSince;
    const visited = new Set<string>([key]);
    const stack = [...(paseoChildren.get(key) ?? [])];
    for (let childKey = stack.pop(); childKey !== undefined; childKey = stack.pop()) {
      if (visited.has(childKey)) {
        continue;
      }
      visited.add(childKey);
      const descendant = rootResultsByIdentity.get(childKey);
      if (descendant === undefined) {
        throw new ProjectionError("corrupt-row");
      }
      if (descendant.row.unreadSince !== null) {
        pending += 1;
        if (aggregatedUnread === null || descendant.row.unreadSince > aggregatedUnread) {
          aggregatedUnread = descendant.row.unreadSince;
        }
      }
      for (const grandchildKey of paseoChildren.get(childKey) ?? []) {
        stack.push(grandchildKey);
      }
    }
    pendingResultsOf.set(key, pending);
    aggregatedUnreadOf.set(key, aggregatedUnread);
  }

  const rootVisible = (result: RootResult): boolean => {
    if (result.effectiveStatus !== "idle") {
      return true;
    }
    const key = identityKey(result.row.provider, result.row.sessionId);
    // A finished Paseo subagent with a resolvable parent stays hidden; its
    // ledger holds the root ancestor instead. Active subagents keep their
    // own cards (the effective-status clause above); idle subagent cards
    // never appear.
    if (isPaseoSubagent(result.row) && paseoParent.has(key)) {
      return false;
    }
    return holdsLedgerKey.has(key) || hasDescendantLedger.has(key);
  };
```

2. `rootFacts` — replace the whole function (its Task 8 shape carries `unreadSince: result.row.unreadSince` and the `pendingResults: 0` placeholder) with the computed version:

```typescript
  const rootFacts = (result: RootResult) => {
    const key = identityKey(result.row.provider, result.row.sessionId);
    return {
      provider: result.row.provider,
      sessionId: result.row.sessionId,
      status: result.effectiveStatus,
      title: result.row.title,
      project: result.row.project,
      model: result.row.model,
      statusSince: result.row.statusSince,
      activityLine: result.row.activityLine,
      unreadSince: aggregatedUnreadOf.get(key) ?? null,
      doneSince: result.row.doneSince,
      pendingResults: pendingResultsOf.get(key) ?? 0,
      endedAt: result.row.endedAt,
      logicalSlot: result.slot,
      ghosttyTerminalId: result.row.ghosttyTerminalId,
      transcriptPath: result.row.transcriptPath,
      originKind: result.row.originKind,
      originRef: result.row.originRef,
      originSubagent: isPaseoSubagent(result.row),
      originParentRef: result.row.originParentRef,
      lastEventAt: result.row.lastEventAt,
    };
  };
```

(`nativeNode` already carries `pendingResults: 0, endedAt: null` from Task 8 — no change here.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/projection.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS. (If `test/strip-snapshot-view.test.ts` pins `countUnreadSessions` behavior with rolled-up shapes, its existing factory-based cases still pass; no change expected.)

- [ ] **Step 6: Commit**

```bash
git add src/core/projection.ts test/projection.test.ts
git commit -m "feat(projection): subagent results roll up to the root card with a pending badge"
```

---

### Task 10: CLI — `sessions view` and watermarks (R4)

**Files:**
- Modify: `src/core/cli.ts` (grammar comment :1-12, USAGE :120-133, `runSessions` :300-390, registry import :36-45)
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `viewSession` and the watermark parameter of `acknowledgeSession` (Tasks 2-3).
- Produces: `dealerboard sessions view <provider> <session-id> [watermark]` (bare invocation = no watermark = unconditional) and `dealerboard sessions ack <provider> <session-id> [watermark]`. The deck plugin's fixed 4-arg `sessions ack` argv is untouched and keeps dismiss semantics.

- [ ] **Step 1: Write the failing tests**

In `test/cli.test.ts`, inside `describe("sessions commands", …)`, append:

```typescript
  test("sessions view clears the badge, keeps the card, and stamps viewed_since", async () => {
    initRegistry();
    const startHarness = makeHarness({ stdin: stdinOf(startEvent("v1")) });
    expect(await runCli(["event", "claude"], startHarness.deps)).toBe(0);
    const stop = makeHarness({ stdin: stdinOf(JSON.stringify({ hook_event_name: "Stop", session_id: "v1" })) });
    expect(await runCli(["event", "claude"], stop.deps)).toBe(0);

    const harness = makeHarness();
    expect(await runCli(["sessions", "view", "claude", "v1"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toBe("");
    // The card stays: done_since holds it; the badge is gone; the clock runs.
    expect(listRows()[0]).toMatchObject({ status: "idle", unreadSince: null });

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      const row = db
        .query("SELECT done_since, viewed_since FROM active_sessions WHERE session_id = 'v1'")
        .get() as { done_since: string | null; viewed_since: string | null };
      expect(row.done_since).toBe(NOW);
      expect(row.viewed_since).toBe(NOW);
    } finally {
      db.close();
    }
  });

  test("sessions view validates args", async () => {
    initRegistry();
    for (const args of [
      ["sessions", "view", "bogus", "x"],
      ["sessions", "view", "claude"],
      ["sessions", "view", "claude", ""],
      ["sessions", "view", "claude", "s1", "2026-08-06T00:00:00.000Z", "extra"],
    ]) {
      const harness = makeHarness();
      expect(await runCli(args, harness.deps)).toBe(1);
      expect(harness.stderr()).toContain("usage: dealerboard <command>");
      expect(harness.stdout()).toBe("");
    }
  });

  test("sessions ack accepts an optional watermark and protects newer results", async () => {
    initRegistry();
    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      applyRegistryEvents(db, [
        {
          kind: "SessionStart",
          provider: "claude",
          sessionId: "w1",
          title: null,
          project: null,
          ghosttyTerminalId: null,
          transcriptPath: null,
          model: null,
          observedAt: NOW,
        },
        { kind: "Stop", provider: "claude", sessionId: "w1", observedAt: LATER },
      ]);
    } finally {
      db.close();
    }
    // The watermark equals the stamp the gesture's snapshot showed (NOW-era);
    // the LATER result is newer and survives.
    const harness = makeHarness();
    expect(await runCli(["sessions", "ack", "claude", "w1", NOW], harness.deps)).toBe(0);
    expect(listRows()[0]).toMatchObject({ unreadSince: LATER });

    // The "-" token is a causal-null watermark: it consumes nothing.
    expect(await runCli(["sessions", "ack", "claude", "w1", "-"], harness.deps)).toBe(0);
    expect(listRows()[0]).toMatchObject({ unreadSince: LATER }); // still protected

    // No watermark (the deck/bare-CLI shape) dismisses unconditionally.
    expect(await runCli(["sessions", "ack", "claude", "w1"], harness.deps)).toBe(0);
    expect(listRows()[0]).toMatchObject({ unreadSince: null });
  });

  test("sessions view honors the same watermark discipline", async () => {
    initRegistry();
    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      applyRegistryEvents(db, [
        {
          kind: "SessionStart",
          provider: "claude",
          sessionId: "v2",
          title: null,
          project: null,
          ghosttyTerminalId: null,
          transcriptPath: null,
          model: null,
          observedAt: NOW,
        },
        { kind: "Stop", provider: "claude", sessionId: "v2", observedAt: LATER },
      ]);
    } finally {
      db.close();
    }
    // A causal-null view protects the result it never saw.
    expect(await runCli(["sessions", "view", "claude", "v2", "-"], makeHarness().deps)).toBe(0);
    expect(listRows()[0]).toMatchObject({ unreadSince: LATER });
    const viewedRow = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(viewedRow.query("SELECT viewed_since FROM active_sessions WHERE session_id = 'v2'").get()).toEqual({
        viewed_since: null,
      });
    } finally {
      viewedRow.close();
    }
  });

  test("a watermark must be a canonical instant or the '-' token", async () => {
    initRegistry();
    for (const args of [
      ["sessions", "ack", "claude", "s1", "extra"], // the pre-existing pin: still rejected, now as a non-canonical watermark
      ["sessions", "ack", "claude", "s1", "2026-08-06"], // date only — not canonical
      ["sessions", "ack", "claude", "s1", "not-a-time"],
      ["sessions", "view", "claude", "s1", "extra"],
    ]) {
      const harness = makeHarness();
      expect(await runCli(args, harness.deps)).toBe(1);
      expect(harness.stdout()).toBe("");
      expect(harness.stderr()).not.toBe("");
    }
  });
```

Also extend the malformed-usage list in the test `"sessions commands reject malformed usage with nonzero and stderr"` — add these entries to the `args` array (note the pre-existing `["sessions", "ack", "claude", "s1", "extra"]` entry at ~line 1189 stays valid: "extra" is now rejected as a non-canonical watermark rather than as an extra argument):

```typescript
      ["sessions", "view"],
      ["sessions", "view", "bogus", "s1"],
      ["sessions", "view", "claude", "s1", "2026-08-06T00:00:00.000Z", "extra"],
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/cli.test.ts`
Expected: FAIL — `sessions view` prints usage and exits 1; the 5-arg ack is rejected.

- [ ] **Step 3: Implement**

In `src/core/cli.ts`:

1. Registry import — add `viewSession` and the watermark type:

```typescript
import {
  acknowledgeSession,
  applyRegistryEvents,
  clearAllSessions,
  clearSession,
  type GestureWatermark,
  listSessions,
  pruneStaleSessions,
  syncPaseoStates,
  viewSession,
} from "./registry";
```

1b. Add the wire decoder next to the other parse helpers (`parsePruneMaxAgeHours` region). It distinguishes the THREE wire states and rejects everything non-canonical — arbitrary nonempty text is never accepted as a timestamp:

```typescript
/** The causal-null watermark token: the gesture's snapshot showed no unread. */
const CAUSAL_NULL_WATERMARK = "-";

/**
 * Decode the optional watermark argument: absent = unconditional (null);
 * the `-` token = causal with a null stamp; a canonical UTC instant = causal
 * with that stamp. Anything else is a usage error (undefined).
 */
const parseGestureWatermark = (arg: string | undefined): GestureWatermark | null | undefined => {
  if (arg === undefined) {
    return null;
  }
  if (arg === CAUSAL_NULL_WATERMARK) {
    return { unreadSince: null };
  }
  const epoch = Date.parse(arg);
  if (Number.isNaN(epoch) || new Date(epoch).toISOString() !== arg) {
    return undefined;
  }
  return { unreadSince: arg };
};
```

2. Grammar header comment — add after the `sessions ack` line:

```
 *   dealerboard sessions view <provider> <session-id> [watermark]
```

and change the ack line to:

```
 *   dealerboard sessions ack <provider> <session-id> [watermark]
```

3. USAGE — replace the two relevant lines with:

```
  sessions clear <provider> <session-id>
  sessions ack <provider> <session-id> [watermark]
  sessions view <provider> <session-id> [watermark]
```

4. `runSessions` — replace the `ack` case with the watermark-aware version and add the `view` case immediately after it:

```typescript
    case "ack": {
      const [providerArg, sessionId, watermarkArg, ...extra] = rest;
      const watermark = parseGestureWatermark(watermarkArg);
      if (
        !isProvider(providerArg) ||
        sessionId === undefined ||
        sessionId.length === 0 ||
        extra.length > 0 ||
        watermark === undefined
      ) {
        deps.stderr(USAGE);
        return 1;
      }
      try {
        const db = deps.openDatabase(deps.paths.database, "readwrite");
        try {
          acknowledgeSession(db, providerArg, sessionId, deps.now(), watermark);
        } finally {
          db.close();
        }
        return 0;
      } catch (error) {
        deps.stderr(`sessions ack failed: ${errorMessage(error)}\n`);
        return 1;
      }
    }
    case "view": {
      const [providerArg, sessionId, watermarkArg, ...extra] = rest;
      const watermark = parseGestureWatermark(watermarkArg);
      if (
        !isProvider(providerArg) ||
        sessionId === undefined ||
        sessionId.length === 0 ||
        extra.length > 0 ||
        watermark === undefined
      ) {
        deps.stderr(USAGE);
        return 1;
      }
      try {
        const db = deps.openDatabase(deps.paths.database, "readwrite");
        try {
          viewSession(db, providerArg, sessionId, deps.now(), watermark);
        } finally {
          db.close();
        }
        return 0;
      } catch (error) {
        deps.stderr(`sessions view failed: ${errorMessage(error)}\n`);
        return 1;
      }
    }
```

(Note `watermarkArg === ""` decodes to `undefined` — neither canonical nor the token — so the pre-existing empty-string rejection is preserved by the decoder.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/cli.test.ts && bun test test/session-ack.test.ts`
Expected: PASS (the deck-path test's 4-arg argv still exits 0).

- [ ] **Step 5: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/cli.ts test/cli.test.ts
git commit -m "feat(cli): sessions view, and optional watermarks on view/ack"
```

---

### Task 11: Tauri commands + bridge (R3 wiring)

**Files:**
- Modify: `app/src-tauri/src/main.rs` (`ack_session` :179-184, the `#[cfg(test)] mod tests` block at the file tail, `invoke_handler` list :370-381), `app/src/bridge.ts`
- Test: `app/src-tauri/src/main.rs` (unit tests for the argv builder), webview typecheck for the bridge

**Interfaces:**
- Consumes: CLI `sessions view|ack … [watermark]` from Task 10, including the `-` causal-null token and canonical-stamp rule.
- Produces:
  - `struct GestureWatermark { unread_since: Option<String> }` (serde camelCase) and `fn session_gesture_args(verb: &str, provider: &str, session_id: &str, watermark: Option<GestureWatermark>) -> Vec<String>` in main.rs — the argv encoding of the three watermark states: `None` → no fifth arg (unconditional); `Some(stamp)` → the stamp; `Some(None)` → the literal `-`.
  - Tauri commands `view_session(provider, session_id, watermark: Option<GestureWatermark>)` and `ack_session(provider, session_id, watermark: Option<GestureWatermark>)`.
  - Bridge `export type GestureWatermark = { unreadSince: string | null }` and `viewSession`/`ackSession` taking `watermark: GestureWatermark | null` for Task 12.

- [ ] **Step 1: Write the failing Rust tests**

In `app/src-tauri/src/main.rs`, inside the existing `#[cfg(test)] mod tests` block, append:

```rust
    #[test]
    fn gesture_args_unconditional_omit_the_watermark() {
        // The deck/bare-CLI shape: four args, no fifth.
        assert_eq!(
            session_gesture_args("ack", "claude", "s1", None),
            vec!["sessions", "ack", "claude", "s1"]
        );
        assert_eq!(
            session_gesture_args("view", "kimi", "session 1", None),
            vec!["sessions", "view", "kimi", "session 1"]
        );
    }

    #[test]
    fn gesture_args_carry_a_causal_stamp() {
        let watermark = GestureWatermark {
            unread_since: Some("2026-08-06T00:00:00.000Z".into()),
        };
        assert_eq!(
            session_gesture_args("ack", "claude", "s1", Some(watermark)),
            vec!["sessions", "ack", "claude", "s1", "2026-08-06T00:00:00.000Z"]
        );
    }

    #[test]
    fn gesture_args_encode_a_null_stamp_watermark_as_the_causal_null_token() {
        // The snapshot showed no unread: the gesture is still causal and
        // must not collapse into the unconditional four-arg shape.
        let watermark = GestureWatermark { unread_since: None };
        assert_eq!(
            session_gesture_args("view", "claude", "s1", Some(watermark)),
            vec!["sessions", "view", "claude", "s1", "-"]
        );
    }
```

- [ ] **Step 2: Run the Rust tests to verify they fail**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: FAIL — `session_gesture_args` and `GestureWatermark` do not exist yet (compile error).

- [ ] **Step 3: Implement the Rust commands**

In `app/src-tauri/src/main.rs`, replace the `ack_session` command and add the shared pieces above it:

```rust
/// The causal content of a view/dismiss gesture: the unread stamp visible
/// when the gesture was issued. `None` inside means the snapshot showed no
/// unread — still causal, encoded as the CLI's `-` token. A missing
/// watermark (`Option::None`) is the unconditional operator/deck shape.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GestureWatermark {
    unread_since: Option<String>,
}

/// Encode the three watermark states into the CLI argv: no fifth argument
/// (unconditional), the canonical stamp, or the `-` causal-null token.
fn session_gesture_args(
    verb: &str,
    provider: &str,
    session_id: &str,
    watermark: Option<GestureWatermark>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "sessions".into(),
        verb.into(),
        provider.into(),
        session_id.into(),
    ];
    if let Some(watermark) = watermark {
        args.push(watermark.unread_since.unwrap_or_else(|| "-".into()));
    }
    args
}

/// The app's only write paths back to the daemon, mirroring the plugin's
/// session-ack: the installed binary, fixed subcommand argv, no shell. The
/// watermark makes the dismiss causal — results newer than the snapshot's
/// stamp survive the gesture.
#[tauri::command]
async fn ack_session(provider: &str, session_id: &str, watermark: Option<GestureWatermark>) -> Result<(), String> {
    let executable = app_support_root()?.join("bin/dealerboard");
    let path = executable.to_string_lossy().to_string();
    let args = session_gesture_args("ack", provider, session_id, watermark);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(&path, &refs)
}

/// View gesture: clears the unread badge and starts the viewed-expiry
/// clock; the card stays on the board (dismiss is `ack_session`).
#[tauri::command]
async fn view_session(provider: &str, session_id: &str, watermark: Option<GestureWatermark>) -> Result<(), String> {
    let executable = app_support_root()?.join("bin/dealerboard");
    let path = executable.to_string_lossy().to_string();
    let args = session_gesture_args("view", provider, session_id, watermark);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(&path, &refs)
}
```

Register the new command — in `invoke_handler(tauri::generate_handler![…])`, insert `view_session,` immediately after `ack_session,`.

- [ ] **Step 4: Run the Rust tests to verify they pass**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS (the pre-existing watcher tests stay green).

- [ ] **Step 5: Extend the bridge**

In `app/src/bridge.ts`, add the watermark type near the top (after the `SnapshotPayload` type) and replace the `ackSession` definition, adding `viewSession` directly above it:

```typescript
/** The causal content of a gesture: the unread stamp the rendered snapshot
 * showed. `null` (absent watermark) is the unconditional operator shape;
 * `{ unreadSince: null }` is a causal gesture issued from a snapshot with
 * no unread. These two states must never collapse into each other. */
export type GestureWatermark = { unreadSince: string | null };

/** View gesture: clears the unread badge and starts the viewed-expiry clock; the card stays. */
export const viewSession = (
  provider: Provider,
  sessionId: string,
  watermark: GestureWatermark | null,
): Promise<void> => invoke<void>("view_session", { provider, sessionId, watermark });

/** Dismiss gesture: takes the card off the board. The watermark makes it causal — newer results survive. */
export const ackSession = (
  provider: Provider,
  sessionId: string,
  watermark: GestureWatermark | null,
): Promise<void> => invoke<void>("ack_session", { provider, sessionId, watermark });
```

(The invoke payload serializes `watermark: null` to JSON null → Rust `None` (unconditional), and `{ unreadSince: null }` → `Some(GestureWatermark { unread_since: None })` → the `-` token. The three states stay distinct across the wire.)

- [ ] **Step 6: Verify both sides**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/main.rs app/src/bridge.ts
git commit -m "feat(app): view_session command and watermark-carrying gestures"
```

---

### Task 12: App gestures — tap views, flick/sheet dismiss (R3, R11)

**Files:**
- Modify: `app/src/press.ts` (whole file), `app/src/main.ts` (imports :35-47, onBoardClick :413-432, runSheetAction "open"/"ack" cases :545-560, flickAway :589-620), `app/src/action-sheet.ts` (buildSheetModel label :55), `app/src/dismissals.ts` (flickRemoves :17-19 and header comment)
- Test: `test/press.test.ts`, `test/strip-action-sheet.test.ts`, `test/strip-dismissals.test.ts`

**Interfaces:**
- Consumes: `viewSession`/`ackSession` with watermarks from Task 11; `endedAt` on `BoardSession` from Task 8.
- Produces: `PressDeps.view: (provider: Provider, sessionId: string, watermark: string | null) => Promise<void>`; tap = view (watermark = the session's `unreadSince`) + route, except ended cards which never route; flick and sheet-Dismiss pass the same watermark to ack; action-sheet label "Dismiss".

- [ ] **Step 1: Write the failing press tests**

Replace `test/press.test.ts` contents with:

```typescript
import { describe, expect, test } from "bun:test";
import { type PressDeps, pressBoardCard, pressSessionTile } from "../app/src/press";
import { FOCUS_GHOSTTY_TERMINAL_SCRIPT } from "../src/plugin/ghostty-focus";
import type { ProjectedSession } from "../src/protocol";

const session = (overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: "session-1",
  status: "idle",
  title: "A session",
  project: "dealerboard",
  descendantCount: 0,
  logicalSlot: 1,
  ghosttyTerminalId: null,
  model: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  unreadSince: null,
  doneSince: null,
  pendingResults: 0,
  endedAt: null,
  statusSince: null,
  activityLine: null,
  transcriptPath: null,
  originParentRef: null,
  lastEventAt: null,
  ...overrides,
});

type RecordedCall = { fn: string; args: unknown[] };

type DepsOptions = { failView?: boolean; failOpenUrl?: boolean };

/** Fake bridge deps: every call is recorded (flashes included) in order. */
const makeDeps = (options: DepsOptions = {}) => {
  const calls: RecordedCall[] = [];
  const deps: PressDeps = {
    view: (provider, sessionId, watermark) => {
      calls.push({ fn: "view", args: [provider, sessionId, watermark] });
      return options.failView === true ? Promise.reject(new Error("view down")) : Promise.resolve();
    },

    openUrl: (url) => {
      calls.push({ fn: "openUrl", args: [url] });
      return options.failOpenUrl === true ? Promise.reject(new Error("open_url failed")) : Promise.resolve();
    },
    focusGhostty: (script, terminalId) => {
      calls.push({ fn: "focusGhostty", args: [script, terminalId] });
      return Promise.resolve();
    },
    readPaseoServerId: () => {
      calls.push({ fn: "readPaseoServerId", args: [] });
      return Promise.resolve("server/one two");
    },
    flash: () => {
      calls.push({ fn: "flash", args: [] });
    },
  };
  return { deps, calls };
};

const callNames = (calls: RecordedCall[]): string[] => calls.map((call) => call.fn);

const flashCount = (calls: RecordedCall[]): number => calls.filter((call) => call.fn === "flash").length;

describe("pressSessionTile", () => {
  test("a rejected view is fire-and-forget: routing still runs and nothing flashes", async () => {
    const { deps, calls } = makeDeps({ failView: true });
    await pressSessionTile(session({ provider: "codex" }), deps);
    expect(callNames(calls)).toEqual(["view", "openUrl"]);
    expect(flashCount(calls)).toBe(0);
  });

  test("views the session with its unread watermark before any routing call", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(
      session({ provider: "claude", ghosttyTerminalId: "term-9", unreadSince: "2026-08-26T05:00:00.000Z" }),
      deps,
    );
    expect(calls[0]).toEqual({
      fn: "view",
      args: ["claude", "session-1", { unreadSince: "2026-08-26T05:00:00.000Z" }],
    });
    expect(callNames(calls)).toEqual(["view", "focusGhostty"]);
  });

  test("a read session views with a causal null-stamp watermark — never the unconditional shape", async () => {
    // The tap is always a causal gesture issued from the rendered snapshot;
    // a snapshot with no unread is { unreadSince: null }, NOT a bare null
    // (which would be unconditional and could consume a result in transit).
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ provider: "kimi" }), deps);
    expect(calls[0]).toEqual({ fn: "view", args: ["kimi", "session-1", { unreadSince: null }] });
  });

  test("viewing does not dismiss: the tap never calls ack", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ doneSince: "2026-08-26T05:00:00.000Z" }), deps);
    expect(callNames(calls)).not.toContain("ack");
  });

  test("paseo route resolves the server id and opens the url-encoded agent deep link", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ originKind: "paseo", originRef: "agent 42/x" }), deps);
    expect(callNames(calls)).toEqual(["view", "readPaseoServerId", "openUrl"]);
    expect(calls[2]?.args).toEqual(["paseo://h/server%2Fone%20two/agent/agent%2042%2Fx"]);
  });

  test("ghostty route focuses the exact shared AppleScript on the terminal id", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ provider: "claude", ghosttyTerminalId: "term-9" }), deps);
    expect(calls[1]?.args).toEqual([FOCUS_GHOSTTY_TERMINAL_SCRIPT, "term-9"]);
  });

  test("url route opens the routed url", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ provider: "kimi" }), deps);
    expect(calls[1]?.args).toEqual(["http://127.0.0.1:58627/sessions/session-1"]);
  });

  test("a routing failure flashes exactly once", async () => {
    const { deps, calls } = makeDeps({ failOpenUrl: true });
    await pressSessionTile(session({ provider: "codex" }), deps);
    expect(callNames(calls)).toEqual(["view", "openUrl", "flash"]);
    expect(flashCount(calls)).toBe(1);
  });

  test("an unroutable session flashes without any activation call", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ provider: "grok" }), deps);
    expect(callNames(calls)).toEqual(["view", "flash"]);
    expect(flashCount(calls)).toBe(1);
  });

  test("an ended card views but never routes (and does not flash)", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(
      session({ endedAt: "2026-08-26T05:00:00.000Z", unreadSince: "2026-08-26T04:00:00.000Z" }),
      deps,
    );
    expect(callNames(calls)).toEqual(["view"]);
    expect(calls[0]).toEqual({
      fn: "view",
      args: ["claude", "session-1", { unreadSince: "2026-08-26T04:00:00.000Z" }],
    });
  });
});

describe("pressBoardCard", () => {
  test("a display-only card schedules no view, route, or flash", async () => {
    const { deps, calls } = makeDeps();
    await pressBoardCard({ session: session({ provider: "evener" }), displayOnly: true }, deps);
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/press.test.ts`
Expected: FAIL — `PressDeps` still has `ack`, not `view` (type error).

- [ ] **Step 3: Implement press.ts**

Replace `app/src/press.ts` with:

```typescript
/**
 * Tile press = view, then route. Viewing clears the unread badge and starts
 * the card's expiry clock; the card itself stays — dismissal is a separate
 * gesture (flick or action sheet). The view is fire-and-forget with the
 * session's unread stamp as the causality watermark (a failed view only
 * means the badge stays until the next lifecycle event — never flash for
 * it). Routing failures flash the tile, matching the plugin's activation
 * alert. An ended card views but never routes: its session is gone, only
 * the result remains.
 */

import { FOCUS_GHOSTTY_TERMINAL_SCRIPT } from "../../src/plugin/ghostty-focus";
import type { Provider } from "../../src/protocol";
import type { BoardSession } from "./board";
import type { GestureWatermark } from "./bridge";
import { routeForSession } from "./routing";

export type PressDeps = {
  view: (provider: Provider, sessionId: string, watermark: GestureWatermark | null) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  focusGhostty: (script: string, terminalId: string) => Promise<void>;
  readPaseoServerId: () => Promise<string>;
  flash: () => void;
};

export type BoardPressTarget = {
  session: BoardSession;
  displayOnly: boolean;
};

export const pressBoardCard = async (card: BoardPressTarget, deps: PressDeps): Promise<void> => {
  if (card.displayOnly) {
    return;
  }
  await pressSessionTile(card.session, deps);
};

export const pressSessionTile = async (session: BoardSession, deps: PressDeps): Promise<void> => {
  // A tap is always a causal gesture issued from the rendered snapshot: the
  // watermark object carries the stamp the user saw — `{ unreadSince: null }`
  // when the card had no badge — never the bare-null unconditional shape.
  void deps.view(session.provider, session.sessionId, { unreadSince: session.unreadSince }).catch(() => {});
  if (session.endedAt !== null) {
    return;
  }
  const route = routeForSession(session);
  try {
    switch (route.kind) {
      case "paseo": {
        const serverId = await deps.readPaseoServerId();
        await deps.openUrl(`paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(route.agentId)}`);
        return;
      }
      case "ghostty":
        await deps.focusGhostty(FOCUS_GHOSTTY_TERMINAL_SCRIPT, route.terminalId);
        return;
      case "url":
        await deps.openUrl(route.url);
        return;
      case "flash":
        deps.flash();
        return;
    }
  } catch {
    deps.flash();
  }
};
```

- [ ] **Step 4: Update the sheet label test and implementation**

In `test/strip-action-sheet.test.ts`, in the label-list assertion (the test that expects `"Ack"` in the item labels), change `"Ack"` to `"Dismiss"`.

In `app/src/action-sheet.ts`, in `buildSheetModel`:

```typescript
      { id: "ack", label: "Dismiss", enabled: !actionsLocked, confirming: false },
```

- [ ] **Step 5: Update the flick-gate tests and implementation**

In `test/strip-dismissals.test.ts`, keep the existing `flickRemoves` tests and append:

```typescript
  test("an active card with a stale unread badge is still not flickable", () => {
    expect(flickRemoves(session("s1", { status: "working", unreadSince: "2026-08-26T05:00:00.000Z" }))).toBe(false);
    expect(flickRemoves(session("s1", { status: "waiting", doneSince: "2026-08-26T05:00:00.000Z" }))).toBe(false);
  });

  test("an ended card holding a result is flickable (dismiss takes it off)", () => {
    expect(
      flickRemoves(
        session("s1", {
          status: "idle",
          doneSince: "2026-08-26T05:00:00.000Z",
          endedAt: "2026-08-26T06:00:00.000Z",
        }),
      ),
    ).toBe(true);
  });
```

`app/src/dismissals.ts` — replace `flickRemoves` and its file header comment with:

```typescript
/**
 * Locally-dismissed slats: a flick fires a dismiss whose settlement travels
 * registry → daemon snapshot → push before the row actually leaves the
 * data. Hiding the flicked identity locally bridges that round-trip so the
 * card never pops back for a beat between the animation and the ingest. An
 * entry expires after DISMISS_TTL_MS, so a row the registry refused to
 * settle honestly returns on a later ingest instead of staying silently
 * hidden.
 */

import type { Provider, SessionSnapshotV2 } from "../../src/protocol";
import type { BoardSession } from "./board";

export const DISMISS_TTL_MS = 5_000;

/** True when a dismiss would take the slat off the board: any card holding
 * done/unread or in error. Active working/waiting cards stay — a dismiss
 * clears their ledgers but their status holds them, so the animation must
 * not promise a removal. */
export const flickRemoves = (session: BoardSession): boolean =>
  session.status === "error" ||
  (session.status === "idle" && (session.unreadSince !== null || session.doneSince !== null));
```

- [ ] **Step 6: Rewire main.ts**

In `app/src/main.ts`:

1. Bridge import — add `viewSession`:

```typescript
import {
  ackSession,
  clearSession,
  focusGhostty,
  onSnapshotChanged,
  openUrl,
  readPaseoServerId,
  readQuotaSnapshot,
  readSnapshot,
  readTokenUsageSnapshot,
  revealTranscript,
  type SnapshotPayload,
  viewSession,
} from "./bridge";
```

2. `onBoardClick` — the `pressBoardCard` deps object:

```typescript
  void pressBoardCard(currentCard, {
    view: viewSession,
    openUrl,
    focusGhostty,
    readPaseoServerId,
    flash: () => flashCard(card),
  });
```

3. `runSheetAction` — the `"open"` case's `pressSessionTile` deps:

```typescript
      void pressSessionTile(session, {
        view: viewSession,
        openUrl,
        focusGhostty,
        readPaseoServerId,
        flash: () => flashCard(tile),
      });
```

4. `runSheetAction` — the `"ack"` case (the sheet's Dismiss action carries the watermark the sheet was opened from):

```typescript
    case "ack":
      return trackSheetAction(
        ackSession(session.provider, session.sessionId, session.unreadSince),
        context,
        generation,
        "Dismiss failed",
      );
```

5. `flickAway` — the ack call:

```typescript
  const { provider, sessionId } = ref.card.session;
  void ackSession(provider, sessionId, ref.card.session.unreadSince).catch(() => {});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test test/press.test.ts test/strip-action-sheet.test.ts test/strip-dismissals.test.ts`
Expected: PASS.

- [ ] **Step 8: Full suite + typecheck + lint**

Run: `bun test && bun run typecheck && biome check .`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add app/src/press.ts app/src/main.ts app/src/action-sheet.ts app/src/dismissals.ts test/press.test.ts test/strip-action-sheet.test.ts test/strip-dismissals.test.ts
git commit -m "feat(app): tap views and routes; flick and sheet dismiss with watermarks"
```

---

### Task 13: Board rendering — pendingResults badge and ended treatment (R6, R10)

**Files:**
- Modify: `app/src/board.ts` (BoardCardSeed :20-29, groupedOrder seeds :77-135, groupedAgentOrder seed :169-177), `app/src/cards.ts` (CardViewModel :41-75, cardViewModel :87-127, cardClassName :139-150), `app/styles.css` (after `.card.sub.status-error::after` region ~:180)
- Test: `test/strip-board.test.ts`, `test/strip-cards.test.ts`

**Interfaces:**
- Consumes: `pendingResults`/`endedAt` on `BoardSession` (Task 8), populated by projection (Task 9).
- Produces: `BoardCardSeed.pendingResults: number`; card view model `ended: boolean`, `word === "ended"` on ended cards, badge shows `pendingResults` when positive (else the descendant badge); `.card.ended` CSS class.

- [ ] **Step 1: Write the failing tests**

In `test/strip-cards.test.ts`, inside `describe("cardViewModel", …)`, append:

```typescript
  test("an ended card reads ended in the corner word and carries the ended class", () => {
    const model = cardViewModel(
      placed({}, { status: "idle", endedAt: "2026-08-25T00:01:00.000Z", statusSince: "2026-08-25T00:00:00.000Z" }),
      NOW_MS,
    );
    expect(model.ended).toBe(true);
    expect(model.word).toBe("ended");
    expect(cardClassName(model).split(" ")).toContain("ended");
  });

  test("a live card is not ended and keeps its status word", () => {
    const model = cardViewModel(placed({}, { status: "idle" }), NOW_MS);
    expect(model.ended).toBe(false);
    expect(model.word).toBe("idle");
  });

  test("the badge shows pending results over the descendant count", () => {
    const pending = cardViewModel(
      placed({ pendingResults: 2, descendantBadge: 3 }, { originKind: "paseo", originRef: "agent-0" }),
      NOW_MS,
    );
    expect(pending.badge).toBe(2);
    const none = cardViewModel(placed({ pendingResults: 0, descendantBadge: 3 }), NOW_MS);
    expect(none.badge).toBe(3);
    const displayOnly = cardViewModel(placed({ pendingResults: 2, displayOnly: true }), NOW_MS);
    expect(displayOnly.badge).toBeNull();
  });
```

Note: `placed()` spreads its first argument over the seed, so `pendingResults` and `descendantBadge` overrides work as written once the seed type carries them.

In `test/strip-board.test.ts`, inside the `groupedOrder` describe, append:

```typescript
  test("seeds carry the session's pendingResults", () => {
    const card = groupedOrder([session(1, { pendingResults: 2 })])[0]?.cards[0];
    expect(card?.pendingResults).toBe(2);
  });
```

and inside the `groupedAgentOrder` describe, append:

```typescript
  test("agent seeds carry the node's pendingResults", () => {
    const root = node("root", { role: "primary", logicalSlot: 1, pendingResults: 3 });
    const card = groupedAgentOrder([root])[0]?.cards[0];
    expect(card?.pendingResults).toBe(3);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/strip-cards.test.ts test/strip-board.test.ts`
Expected: FAIL — `pendingResults` missing from `BoardCardSeed` (type error), `ended` missing from the view model.

- [ ] **Step 3: Implement board.ts seeds**

In `app/src/board.ts`:

1. `BoardCardSeed` — add the field:

```typescript
export type BoardCardSeed = {
  session: BoardSession;
  label: string;
  subagent: boolean;
  /** Anchoring primary's project, for meta-line suppression; null for primaries and orphans. */
  parentProject: string | null;
  displayOnly: boolean;
  descendantBadge: number | null;
  /** Rolled-up unviewed results held by finished Paseo descendants; 0 shows none. */
  pendingResults: number;
};
```

2. In `groupedOrder`, add `pendingResults: primary.pendingResults,` to the primary seed; `pendingResults: child.pendingResults,` to the walk's child seed; and `pendingResults: entry.pendingResults,` to the orphan-tail seed.

3. In `groupedAgentOrder`, add `pendingResults: node.pendingResults,` to the `seed` helper's returned object.

- [ ] **Step 4: Implement the card view model + class**

In `app/src/cards.ts`:

1. `CardViewModel` — add the fields (after `word`):

```typescript
  /** True when the session ended holding an unviewed result — the card outlives its session. */
  ended: boolean;
```

2. `cardViewModel` — compute it and the badge:

```typescript
    word: session.endedAt !== null ? "ended" : statusWord(session.status),
```

(add `ended: session.endedAt !== null,` next to `status`), and replace the badge line with:

```typescript
    badge: card.displayOnly ? null : card.pendingResults > 0 ? card.pendingResults : card.descendantBadge,
```

3. `cardClassName` — add the class:

```typescript
export const cardClassName = (model: CardViewModel): string =>
  [
    "card",
    `status-${model.status}`,
    model.subagent ? "sub" : "primary",
    model.indent ? "indented" : "",
    model.spine !== "none" ? `spine-${model.spine}` : "",
    model.displayOnly ? "display-only" : "",
    model.ended ? "ended" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
```

- [ ] **Step 5: Add the ended treatment to the stylesheet**

In `app/styles.css`, after the `.card.sub.status-error::after { display: none; }` block, add:

```css
/* Ended: the session itself is gone, but an unviewed result holds the card.
   Slate takes the edge and dot — a terminal fact, not a live status. The
   corner word spells "ended" (cardViewModel). */
.card.ended {
  --st: #94a3b8;
  border-left-color: rgb(148 163 184 / 0.9);
}
.card.sub.status-idle.ended {
  border-left-color: rgb(148 163 184 / 0.5);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/strip-cards.test.ts test/strip-board.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/src/board.ts app/src/cards.ts app/styles.css test/strip-cards.test.ts test/strip-board.test.ts
git commit -m "feat(ui): pending-results badge and the ended-card treatment"
```

---

### Task 14: Documentation sweep + final gate

**Files:**
- Modify: `src/core/registry.ts` (module header comment :1-36), `docs/design.md` ("Visibility and unread results" :41-55, "Interaction" :136-142)

**Interfaces:**
- Consumes: everything; produces the rewritten canonical contracts. No behavior change.

- [ ] **Step 1: Rewrite the registry header contract**

Replace the paragraphs of the module header comment in `src/core/registry.ts` beginning `The database holds active state only:` through `Prompts and status events never mark a session read.` and the `The done ledger …` paragraph (lines ~12-34) with:

```typescript
 * The database holds active state only: SubagentStop deletes child rows,
 * and the daemon's age-based prune plus the manual
 * `clearSession`/`clearAllSessions`/`pruneStaleSessions` repairs delete
 * trees — prune skipping any tree that still holds an unviewed result. A
 * Stop or StopFailure always retains its row. SessionEnd deletes a row
 * only when nothing is unviewed; otherwise it
 * retains the row as a terminal "ended" card (idle, `ended_at` stamped)
 * under the normal contract, and a reused SessionStart revives it in
 * place. Slots are never compacted; a new top-level row receives the
 * lowest free positive slot found from the sorted non-null slot list.
 *
 * The unread ledger records results the user has not viewed: a turn ending
 * (Stop settling to idle, StopFailure, or the Paseo missed-completion
 * repair) stamps `unread_since`, and only an explicit view clears it —
 * `viewSession`, a dismissal, or a reused SessionStart. A passive Paseo
 * view never touches it. Prompts and status events never mark a session
 * read; unread is purely cosmetic (badge/styling) and never gates removal.
 *
 * The done ledger records finished results still owed a board slot: a Stop
 * settling to idle stamps `done_since`, and only an explicit dismissal
 * (`acknowledgeSession`), a Paseo archive, a reused SessionStart, or the
 * viewed-expiry sweep clears it. `done_since` (or an `error` status) is
 * what holds a finished card.
 *
 * The viewed ledger starts the expiry clock: only a dealerboard view
 * gesture (`viewSession`) stamps `viewed_since`, and every view restamps
 * it. Any event stamping a fresh result clears it — the card is unviewed
 * again. Done/errored rows auto-dismiss 24h after the most recent view;
 * unviewed rows never expire.
```

- [ ] **Step 2: Rewrite the design doc sections**

In `docs/design.md`, replace the "Visibility and unread results" section (from `## Visibility and unread results` through the paragraph ending `…pruned. Every provider late-joins…` — keep the late-join paragraph) with:

```markdown
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
```

Replace the "Interaction" section's first paragraph (from `A tap acknowledges the card,` through `…double-confirmed Clear actions.`) with:

```markdown
A tap views the card — clearing its unread badge and starting its expiry
clock — then routes Paseo, Claude/Ghostty, Codex, or Kimi when an exact
target exists; an ended card views but never routes. Unsupported or
unbound routes flash. A vertical flick dismisses any card holding
done/unread or in error; a long press opens Open, Dismiss, Reveal
transcript, Copy session ID, and double-confirmed Clear actions. Both
dismiss paths carry the causality watermark of the stamp the gesture was
issued from, so a result landing after the render survives the gesture.
Horizontal flings and rail dots change pages. Native child cards are
excluded from every interaction path.
```

- [ ] **Step 3: Run the full gate**

Run: `bun run check`
Expected: PASS (biome ci + full build incl. typecheck of both tsconfigs + entire test suite).

- [ ] **Step 4: Verify the plugin surface is untouched**

Run: `git status --porcelain src/plugin com.drewritter.dealerboard.sdPlugin`
Expected: empty output (no modifications under either path).

- [ ] **Step 5: Commit**

```bash
git add src/core/registry.ts docs/design.md
git commit -m "docs: retention contract — view vs dismiss, roll-up, expiry, ended cards"
```
