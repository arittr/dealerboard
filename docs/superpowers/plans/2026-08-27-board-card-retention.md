# Board Card Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the board's card-clearing rules so reading a result or finishing work never removes a card — cards leave only by explicit user gestures (dismiss, clear, archive) or a 24h clock that starts when the user views the result.

**Architecture:** Six coordinated changes across the registry (`viewSession` vs `acknowledgeSession`-as-dismiss, Paseo passive-view deletion, ended cards, viewed-expiry sweep, unviewed-aware prune), the projection (Paseo roll-up with `pendingResults` badge and aggregated unread), the CLI (`sessions view`), and the app (tap = view, flick/sheet = dismiss, causal watermarks). SQLite stays the source of truth; the snapshot wire gains two additive fields.

**Tech Stack:** TypeScript on Bun (`bun:sqlite`), Tauri app (TypeScript webview + Rust host), Stream Deck plugin untouched.

**Spec:** `docs/superpowers/specs/2026-08-27-board-card-retention/spec.md` (ratified). **Decisions:** `docs/superpowers/specs/2026-08-27-board-card-retention/decisions.md` — settled, do not re-litigate.

## Global Constraints

- Commands: targeted tests `bun test <file>`; typecheck `bun run typecheck` (checks root **and** `app/tsconfig.json`); lint `biome check .`; full gate `bun run check` (= `biome ci . && bun run build && bun test`).
- **Stream Deck plugin untouched:** no changes under `src/plugin/` or `com.drewritter.dealerboard.sdPlugin/`. `src/protocol.ts` is shared with the plugin bundle — additions there must stay additive (parse tolerates missing keys).
- Registry timestamps are canonical ISO-8601 UTC strings; lexical comparison is chronological.
- Registry writes never touch `updated_at` except hook events (it is the prune lease); view/dismiss/sweep/archive are maintenance writes.
- Biome house style: no unused variables (destructure-rename `const { x: _x } = obj` for intentional omissions), `const`-arrow exports, comments explain *why*, double-quoted strings.
- Every task ends with a commit; match `git log --oneline` conventions (`feat(scope): …`, `docs: …`).
- YAGNI: implement exactly the spec, no more. No new UI surfaces, no decay window, no deck changes.

---

### Task 1: Schema v17 — `viewed_since` + `ended_at`

**Files:**
- Modify: `src/core/schema.ts` (LATEST_SCHEMA_VERSION at :16, SCHEMA_VERSION_15 block at :392-403 as the pattern to follow, `initializeDatabase` migration tail at :780-812)
- Test: `test/schema.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: schema version `17` with nullable `active_sessions.viewed_since TEXT` and `active_sessions.ended_at TEXT`; every later task relies on these columns existing after `initializeDatabase`.

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
});
```

Note: `viewed_since`/`ended_at` do not exist yet, so the `DROP COLUMN` statements make this test fail at the first `initializeDatabase` only after the source change lands — before that, the whole file fails differently (the fresh-init test expects v17 but gets v16). That expected failure is the point.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/schema.test.ts`
Expected: FAIL — `user_version` is `16`, and the DROP COLUMN statements throw ("no such column") once the fresh-init assertion is the only failure mode.

- [ ] **Step 3: Implement schema v17**

In `src/core/schema.ts`:

1. Bump the version constant:

```typescript
export const LATEST_SCHEMA_VERSION = 17;
```

2. Add the migration SQL immediately after the `SCHEMA_VERSION_16` template string (which ends with `CREATE UNIQUE INDEX …;` and a closing backtick):

```typescript
/**
 * v17 adds the retention ledgers: `viewed_since` is stamped only by a
 * dealerboard view gesture and is the expiry clock's sole input; `ended_at`
 * is stamped when a SessionEnd retains a row holding an unviewed result as
 * a terminal "ended" card. Plain additive ALTERs, nullable and
 * unconstrained like unread_since.
 */
const SCHEMA_VERSION_17 = `
ALTER TABLE active_sessions
  ADD COLUMN viewed_since TEXT;

ALTER TABLE active_sessions
  ADD COLUMN ended_at TEXT;
`;
```

3. In `initializeDatabase`, after the `if (version < 16) { migrateToV16(db); }` block and before `chmodSync(paths.database, DATABASE_FILE_MODE);`, add:

```typescript
      // v17 adds the retention ledger columns. Shape-driven like the v15
      // repair — the column list, not the version, decides whether the
      // ALTERs apply — so a retried or re-stamped init never dies on a
      // duplicate column. One transaction, so the ALTERs and the stamp
      // commit together.
      if (version < 17) {
        const migrateToV17 = db.transaction(() => {
          const columns = db.query("SELECT name FROM pragma_table_info('active_sessions')").all() as Array<{
            name: string;
          }>;
          if (!columns.some((column) => column.name === "viewed_since")) {
            db.exec(SCHEMA_VERSION_17);
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

Run: `bun test test/schema.test.ts`
Expected: PASS.

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
git add src/core/schema.ts test/schema.test.ts test/cli.test.ts
git commit -m "feat(schema): v17 adds viewed_since and ended_at retention ledgers"
```

---

### Task 2: `viewSession` — view ≠ dismiss (R1)

**Files:**
- Modify: `src/core/registry.ts` (applyStop :458-474, applyStopFailure :476-490, exports region :635+, `Row`/`getRow` in this file are untouched here)
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: schema v17 (`viewed_since` column) from Task 1.
- Produces (exact signatures later tasks rely on):
  - `export const viewSession = (db: Database, provider: Provider, sessionId: string, viewedAt: string, watermark: string | null = null): MutationResult` — clears `unread_since` and stamps `viewed_since` on the target row and on every Paseo-lineage descendant holding a ledger; leaves `done_since` and status untouched; a non-null watermark protects stamps newer than it.
  - `const paseoSubtreeIdentities = (db: Database, provider: Provider, sessionId: string): Array<{ provider: Provider; sessionId: string }>` — module-private; the seed identity plus every top-level row whose `origin_parent_ref` chain reaches the seed's `origin_ref` (cycle-safe via `UNION`). Task 3 reuses it.
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

  test("a watermark consumes the seen result and protects a newer one", () => {
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
    expect(viewSession(db, "claude", "parent", at(12), at(5))).toBe("applied");
    expect(getRow("old")).toMatchObject({ unread_since: null, viewed_since: at(12) });
    // The newer result landed after the snapshot: it survives, unviewed.
    expect(getRow("new")).toMatchObject({ unread_since: at(9), viewed_since: null, done_since: at(9) });
  });

  test("a watermark protecting the target leaves it untouched and ignored", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(9) })]);
    expect(viewSession(db, "claude", "s1", at(12), at(5))).toBe("ignored");
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), viewed_since: null });
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

3. Add the subtree helper immediately before `acknowledgeSession` (near :625):

```typescript
/**
 * The Paseo-lineage subtree seeded at one identity: the seed row plus every
 * top-level row whose `origin_parent_ref` chain reaches the seed's
 * `origin_ref`. `UNION` dedupes identities, so cyclic lineage terminates.
 * Rows are matched by composite identity; native children are never members
 * (they publish null ledgers).
 */
const paseoSubtreeIdentities = (
  db: Database,
  provider: Provider,
  sessionId: string,
): Array<{ provider: Provider; sessionId: string }> => {
  const rows = db
    .query(
      `WITH RECURSIVE paseo_subtree(provider, session_id, origin_ref) AS (
         SELECT provider, session_id, origin_ref FROM active_sessions
          WHERE provider = ? AND session_id = ?
         UNION
         SELECT child.provider, child.session_id, child.origin_ref
           FROM active_sessions AS child
           JOIN paseo_subtree AS sub
             ON sub.origin_ref IS NOT NULL
            AND child.origin_kind = 'paseo'
            AND child.origin_subagent = 1
            AND child.origin_parent_ref = sub.origin_ref
       )
       SELECT provider, session_id FROM paseo_subtree`,
    )
    .all(provider, sessionId) as Array<{ provider: Provider; session_id: string }>;
  return rows.map((row) => ({ provider: row.provider, sessionId: row.session_id }));
};
```

4. Add `viewSession` immediately after `paseoSubtreeIdentities`:

```typescript
/**
 * View one session's result: the user's read gesture. Clears `unread_since`
 * (the badge) and stamps `viewed_since` (the expiry clock's only input);
 * `done_since` and status stay put, so the card remains on the board. Every
 * view restamps — repeated views restart the clock. Cascades to every
 * Paseo-lineage descendant holding a ledger, all stamped at the same
 * instant so the subtree's clocks run together. A non-null watermark (the
 * unread stamp visible in the snapshot the gesture was issued from)
 * protects any newer result: a protected row keeps its unread and receives
 * no clock. Never touches `updated_at`.
 */
export const viewSession = (
  db: Database,
  provider: Provider,
  sessionId: string,
  viewedAt: string,
  watermark: string | null = null,
): MutationResult =>
  inWriteTransaction(db, () => {
    let changed = 0;
    for (const identity of paseoSubtreeIdentities(db, provider, sessionId)) {
      const isTarget = identity.provider === provider && identity.sessionId === sessionId;
      const result = isTarget
        ? db.run(
            `UPDATE active_sessions
             SET unread_since = NULL, viewed_since = ?
             WHERE provider = ? AND session_id = ?
               AND (? IS NULL OR unread_since IS NULL OR unread_since <= ?)`,
            [viewedAt, identity.provider, identity.sessionId, watermark, watermark],
          )
        : db.run(
            `UPDATE active_sessions
             SET unread_since = NULL, viewed_since = ?
             WHERE provider = ? AND session_id = ?
               AND (done_since IS NOT NULL OR unread_since IS NOT NULL)
               AND (? IS NULL OR unread_since IS NULL OR unread_since <= ?)`,
            [viewedAt, identity.provider, identity.sessionId, watermark, watermark],
          );
      changed += result.changes;
    }
    return changed > 0 ? "applied" : "ignored";
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full core suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS (no other suite touches `viewed_since` yet).

- [ ] **Step 6: Commit**

```bash
git add src/core/registry.ts test/registry.test.ts
git commit -m "feat(registry): viewSession clears the badge and starts the viewed clock"
```

---

### Task 3: `acknowledgeSession` = dismiss, cascading, watermark (R2, R11)

**Files:**
- Modify: `src/core/registry.ts` (acknowledgeSession :625-652 — doc comment and body)
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: `paseoSubtreeIdentities` from Task 2; `viewSession` (used in one test setup).
- Produces: `export const acknowledgeSession = (db: Database, provider: Provider, sessionId: string, ackedAt: string, watermark: string | null = null): MutationResult` — dismiss: clears `unread_since`/`done_since`/`viewed_since`, retires `error → idle`, cascades the same semantics to Paseo-lineage descendants (rows are never deleted), stamps `acked_at`, honors an optional watermark (clears apply only to stamps ≤ watermark). The no-watermark call keeps today's behavior exactly (the CLI and deck paths).

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

  test("a watermark consumes the seen result and protects a newer one", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(7) }), simple("Stop", "s1", { at: at(9) })]);
    // The gesture was issued from a snapshot showing the at(5) stamp.
    expect(acknowledgeSession(db, "claude", "s1", at(12), at(5))).toBe("ignored");
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(9) });
  });

  test("a watermark at the stamp consumes it (inclusive)", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(acknowledgeSession(db, "claude", "s1", at(12), at(5))).toBe("applied");
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: null });
  });

  test("a watermark only retires an error the user actually saw", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    expect(acknowledgeSession(db, "claude", "s1", at(12), at(3))).toBe("ignored");
    expect(getRow("s1")?.status).toBe("error");
    expect(acknowledgeSession(db, "claude", "s1", at(12), at(5))).toBe("applied");
    expect(getRow("s1")?.status).toBe("idle");
  });

  test("cascade with a watermark: the seen child clears, the newer child holds the board", () => {
    paseoFamily();
    applyRegistryEvents(db, [simple("Activity", "child-b", { at: at(7) }), simple("Stop", "child-b", { at: at(9) })]);
    expect(acknowledgeSession(db, "claude", "parent", at(12), at(6))).toBe("applied");
    expect(getRow("child-a")).toMatchObject({ unread_since: null, done_since: null });
    expect(getRow("child-b")).toMatchObject({ unread_since: at(9), done_since: at(9) });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/registry.test.ts`
Expected: FAIL — the cascade/watermark behaviors do not exist yet (e.g. descendants keep their ledgers; the 5-arg call is a type error).

- [ ] **Step 3: Replace `acknowledgeSession`**

Replace the doc comment and function (registry.ts :625-652) with:

```typescript
/**
 * Dismiss one session's result: the user's explicit gesture that takes a
 * card off the board. Clears `unread_since`, `done_since`, and any residual
 * `viewed_since`; an error is itself a result, so dismissal retires it to
 * idle — with the background flag disarmed, like every other retirement.
 * Cascades the same semantics to every Paseo-lineage descendant (clears
 * their ledgers, retires their errors; rows are never deleted). The ack
 * time is recorded in `acked_at` so the Paseo overlay can never resurrect
 * unread from a flag raised before the dismiss. A non-null watermark (the
 * unread stamp visible in the snapshot the gesture was issued from) makes
 * the dismiss causal: stamps newer than it survive. No watermark is
 * unconditional (operator CLI, deck press). Never touches updated_at.
 */
export const acknowledgeSession = (
  db: Database,
  provider: Provider,
  sessionId: string,
  ackedAt: string,
  watermark: string | null = null,
): MutationResult =>
  inWriteTransaction(db, () => {
    let changed = 0;
    for (const identity of paseoSubtreeIdentities(db, provider, sessionId)) {
      const result = db.run(
        `UPDATE active_sessions
         SET unread_since = CASE WHEN ? IS NULL OR unread_since <= ? THEN NULL ELSE unread_since END,
             done_since = CASE WHEN ? IS NULL OR done_since <= ? THEN NULL ELSE done_since END,
             viewed_since = NULL,
             acked_at = ?,
             status = CASE
               WHEN status = 'error' AND (? IS NULL OR unread_since IS NULL OR unread_since <= ?)
               THEN 'idle' ELSE status END,
             status_since = CASE
               WHEN status = 'error' AND (? IS NULL OR unread_since IS NULL OR unread_since <= ?)
               THEN ? ELSE status_since END,
             background_outstanding = CASE
               WHEN status = 'error' AND (? IS NULL OR unread_since IS NULL OR unread_since <= ?)
               THEN 0 ELSE background_outstanding END
         WHERE provider = ? AND session_id = ?
           AND (
             (unread_since IS NOT NULL AND (? IS NULL OR unread_since <= ?))
             OR (done_since IS NOT NULL AND (? IS NULL OR done_since <= ?))
             OR (status = 'error' AND (? IS NULL OR unread_since IS NULL OR unread_since <= ?))
           )`,
        [
          watermark,
          watermark,
          watermark,
          watermark,
          ackedAt,
          watermark,
          watermark,
          watermark,
          watermark,
          ackedAt,
          watermark,
          watermark,
          identity.provider,
          identity.sessionId,
          watermark,
          watermark,
          watermark,
          watermark,
          watermark,
          watermark,
        ],
      );
      changed += result.changes;
    }
    return changed > 0 ? "applied" : "ignored";
  });
```

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
    applyRegistryEvents(db, [start("s1", { at: at(12) })]);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      ended_at: null,
      unread_since: null,
      done_since: null,
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

  test("ending retains an error card too (the failure is the unviewed result)", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(9) })]);
    expect(getRow("s1")).toMatchObject({ status: "idle", unread_since: at(5), ended_at: at(9) });
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

3. `applySessionStart` reuse path — add `ended_at = NULL` to the UPDATE (a view and a new life):

```typescript
    db.run(
      `UPDATE active_sessions
       SET status = 'idle',
           title = CASE WHEN origin_kind IS 'paseo' THEN title ELSE ? END,
           project = ?, ghostty_terminal_id = ?, transcript_path = ?,
           background_outstanding = 0, unread_since = NULL, done_since = NULL, ended_at = NULL,
           status_since = CASE WHEN status IS NOT 'idle' THEN ? ELSE status_since END,
           origin_kind = COALESCE(?, origin_kind),
           origin_ref = CASE WHEN ? IS NOT NULL THEN ? ELSE origin_ref END,
           origin_subagent = CASE WHEN ? IS NOT NULL THEN 0 ELSE origin_subagent END,
           origin_parent_ref = CASE WHEN ? IS NOT NULL THEN NULL ELSE origin_parent_ref END,
           updated_at = ?, model = COALESCE(?, model)
       WHERE provider = ? AND session_id = ?`,
```

(the parameter array is unchanged — `ended_at = NULL` binds nothing).

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
  // "ended" card — settle to idle, stamp ended_at, keep the ledgers. Late
  // events still process normally and simply re-stamp.
  db.run(
    `UPDATE active_sessions
     SET status = 'idle', ended_at = ?, background_outstanding = 0,
         status_since = CASE WHEN status IS NOT 'idle' THEN ? ELSE status_since END,
         updated_at = ?
     WHERE provider = ? AND session_id = ?`,
    [event.observedAt, event.observedAt, event.observedAt, event.provider, event.sessionId],
  );
  return "applied";
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS (pre-existing SessionEnd tests seed no unread, so they still delete).

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
- Consumes: `viewed_since` semantics from Tasks 2-3; `paseoSubtreeIdentities` logic (re-expressed as an inline CTE here because `syncPaseoStates` is set-based).
- Produces: (a) non-archived cleared/absent-flag records no longer write ledgers (origin stamping only); (b) archived records clear ledgers under the existing freshness guard and cascade the clear along Paseo lineage; (c) the settled-record repair stamps `unread_since` alongside `done_since` (unless archived), clears `viewed_since`, and respects `acked_at`; (d) rotation cleanup untouched (status-only) — pinned by a new test.

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
  test("an archived record cascades the ledger clear to Paseo descendants", () => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "a1" } },
      { ...start("child"), origin: { kind: "paseo", ref: "a2" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'a1' WHERE session_id = 'child'");
    applyRegistryEvents(db, [simple("Stop", "parent", { at: at(5) }), simple("Stop", "child", { at: at(6) })]);

    const archived = syncPaseoStates(db, [
      paseoState({ sessionId: "parent", requiresAttention: false, updatedAt: at(8), archivedAt: at(9) }),
    ]);
    expect(archived).toBeGreaterThan(0);
    expect(getRow("parent")).toMatchObject({ unread_since: null, done_since: null });
    expect(getRow("child")).toMatchObject({ unread_since: null, done_since: null });
    expect(countRows()).toBe(2); // archive clears ledgers, never deletes rows
  });

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

  test("the settled-record repair honors acked_at on a still-working row", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Activity", "s1", { at: at(2) }),
    ]);
    // A paseo flag raised unread; the user dismissed it at at(6) (the row
    // stays working — nothing else to clear — but acked_at is stamped)…
    syncPaseoStates(db, [paseoState({ attentionTimestamp: at(3) })]);
    expect(acknowledgeSession(db, "claude", "s1", at(6))).toBe("applied");
    // …and the settled record reporting that same turn predates the ack.
    const changed = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: at(5), lastStatus: "idle" }),
    ]);
    expect(getRow("s1")).toMatchObject({ status: "idle", unread_since: null, done_since: null });
    expect(changed).toBe(1); // the retirement applies; the ledgers stay clear
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

1. Replace the entire `else` branch (the block starting `} else {` with the comment `// Cleared, absent flag, or archived:` through its closing `}` before the settled-record comment) with:

```typescript
      } else {
        // Cleared, absent flag, or archived: origin stamping stays
        // unconditional for matched top-level rows. Ledger writes are
        // archive-only — a passive Paseo view (the attention flag clearing,
        // whether by the user or by a parent agent consuming its children)
        // is inert and never touches board ledgers.
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
        if (state.archivedAt !== null) {
          // Archiving is the user's terminal gesture on the agent: under the
          // freshness guard it clears the row's ledgers and cascades the
          // clear along Paseo lineage (rows are never deleted). The later of
          // archivedAt/updatedAt is the proof-of-viewing time; a stale
          // archive never clears news that landed afterwards.
          const clearTime = laterInstant(state.updatedAt, state.archivedAt);
          const archived = db.run(
            `WITH RECURSIVE paseo_subtree(provider, session_id, origin_ref) AS (
               SELECT provider, session_id, origin_ref FROM active_sessions
                WHERE provider = ? AND session_id = ?
               UNION
               SELECT child.provider, child.session_id, child.origin_ref
                 FROM active_sessions AS child
                 JOIN paseo_subtree AS sub
                   ON sub.origin_ref IS NOT NULL
                  AND child.origin_kind = 'paseo'
                  AND child.origin_subagent = 1
                  AND child.origin_parent_ref = sub.origin_ref
             )
             UPDATE active_sessions
             SET unread_since = CASE WHEN unread_since IS NOT NULL AND ? > unread_since THEN NULL ELSE unread_since END,
                 done_since = CASE WHEN done_since IS NOT NULL AND ? > done_since THEN NULL ELSE done_since END
             WHERE (provider, session_id) IN (SELECT provider, session_id FROM paseo_subtree)
               AND (
                 (unread_since IS NOT NULL AND ? > unread_since)
                 OR (done_since IS NOT NULL AND ? > done_since)
               )`,
            [state.provider, state.sessionId, clearTime, clearTime, clearTime, clearTime],
          );
          changed += archived.changes;
        }
      }
```

2. In the settled-record repair UPDATE (the block guarded by `if (state.lastStatus !== null && SETTLED_PASEO_STATUSES.has(state.lastStatus) && state.updatedAt !== null)`), replace the statement and its parameter array with:

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
            state.updatedAt,
            doneStamp,
            doneStamp,
            doneStamp,
            doneStamp,
            doneStamp,
            doneStamp,
            doneStamp,
            doneStamp,
            doneStamp,
            state.provider,
            state.sessionId,
            state.updatedAt,
            backgroundSettleCutoffIso,
            backgroundSettleCutoffIso,
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

### Task 6: Prune respects the unviewed (R9)

**Files:**
- Modify: `src/core/registry.ts` (pruneStaleSessions :1013-1060)
- Test: `test/registry.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `pruneStaleSessions(db, cutoffIso, zcodeCutoffIso?)` skips any tree containing a row with `unread_since` non-null, whether invoked by the daemon or CLI `sessions prune` (shared code path).

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
```

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

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/registry.test.ts test/cli.test.ts`
Expected: FAIL — the stale unviewed rows are pruned.

- [ ] **Step 3: Implement the skip**

In `src/core/registry.ts`, in `pruneStaleSessions`, change the `keepSet` seed (add the `OR unread_since IS NOT NULL` term):

```typescript
    const keepSet = `WITH RECURSIVE keep(provider, session_id) AS (
         SELECT provider, session_id FROM active_sessions
          WHERE (provider = 'zcode' AND updated_at >= ?1) OR (provider != 'zcode' AND updated_at >= ?2)
             OR unread_since IS NOT NULL
         UNION
         SELECT child.provider, child.parent_session_id
           FROM active_sessions AS child
           JOIN keep ON keep.provider = child.provider AND keep.session_id = child.session_id
          WHERE child.parent_session_id IS NOT NULL
       )
       SELECT provider, session_id FROM keep`;
```

Update the function's doc comment — replace the sentence beginning `A row inside its lease keeps every ancestor alive` with:

```
 * A row inside its lease keeps every ancestor alive, and so does any row
 * holding an unviewed result (`unread_since` non-null): prune is liveness
 * cleanup, never a purge of results the user has not seen. The operator's
 * intentional purges are clear/clear-all and dismiss/archive.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/registry.test.ts test/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/registry.ts test/registry.test.ts test/cli.test.ts
git commit -m "feat(registry): prune never touches a tree holding an unviewed result"
```

---

### Task 7: Viewed-expiry sweep (R8) + durability

**Files:**
- Modify: `src/core/registry.ts` (new export after `pruneStaleSessions`), `src/core/daemon.ts` (constants :53-77, imports :43-49, `maintain` prune block :253-262, module header :18-27)
- Test: `test/registry.test.ts`, `test/daemon.test.ts`

**Interfaces:**
- Consumes: `viewed_since` semantics from Task 2; prune from Task 6.
- Produces:
  - `export const sweepExpiredResults = (db: Database, cutoffIso: string): number` — auto-dismisses every row with `viewed_since <= cutoffIso` that holds `done_since` or `error` status (clears ledgers, retires errors); returns rows swept.
  - `export const VIEWED_EXPIRY_TTL_MS = 24 * 60 * 60 * 1000` from `daemon.ts`; the daemon's 60s prune tick runs the sweep first, then prune.

- [ ] **Step 1: Write the failing registry tests**

In `test/registry.test.ts`: add `sweepExpiredResults` to the registry import (alphabetical position after `pruneStaleSessions`), then append:

```typescript
describe("sweepExpiredResults", () => {
  const VIEWED = "2026-08-01T00:00:00.000Z";
  const CUTOFF = "2026-08-02T00:00:00.000Z"; // viewed + 24h

  const seedDoneViewed = (sessionId: string): void => {
    applyRegistryEvents(db, [start(sessionId), simple("Stop", sessionId, { at: at(5) })]);
    viewSession(db, "claude", sessionId, VIEWED);
  };

  test("auto-dismisses a done row viewed older than the cutoff", () => {
    seedDoneViewed("s1");
    expect(sweepExpiredResults(db, CUTOFF)).toBe(1);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      unread_since: null,
      done_since: null,
      viewed_since: null,
    });
  });

  test("retires an error row viewed older than the cutoff", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", VIEWED);
    expect(sweepExpiredResults(db, CUTOFF)).toBe(1);
    expect(getRow("s1")).toMatchObject({ status: "idle", background_outstanding: 0, viewed_since: null });
  });

  test("an unviewed done row of any age is never swept", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(sweepExpiredResults(db, "2027-01-01T00:00:00.000Z")).toBe(0);
    expect(getRow("s1")).toMatchObject({ unread_since: at(5), done_since: at(5) });
  });

  test("a row viewed exactly at the cutoff is swept (inclusive)", () => {
    seedDoneViewed("s1");
    expect(sweepExpiredResults(db, VIEWED)).toBe(1);
  });

  test("a viewed row inside the 24h window is kept", () => {
    seedDoneViewed("s1");
    expect(sweepExpiredResults(db, "2026-08-01T12:00:00.000Z")).toBe(0);
    expect(getRow("s1")?.done_since).toBe(at(5));
  });

  test("working and waiting rows are never swept regardless of viewed_since", () => {
    applyRegistryEvents(db, [start("busy"), simple("Activity", "busy", { at: at(5) })]);
    viewSession(db, "claude", "busy", VIEWED); // an active view is harmless…
    expect(sweepExpiredResults(db, CUTOFF)).toBe(0);
    expect(getRow("busy")?.status).toBe("working");
  });

  test("a new result after the view cancels the sweep (the card is unviewed again)", () => {
    seedDoneViewed("s1");
    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(8) }), simple("Stop", "s1", { at: at(9) })]);
    expect(sweepExpiredResults(db, CUTOFF)).toBe(0);
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(9), viewed_since: null });
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
 * The viewed-expiry sweep: auto-dismiss every row whose most recent view is
 * at or before the caller's cutoff and that still holds a finished result —
 * `done_since` or an `error` status. Clears the ledgers (including any
 * residual unread) and retires errors like a dismissal. The clock runs from
 * the most recent view; wall-clock time counts — sleep and daemon downtime
 * included — because expiry evaluates on the next tick using the cutoff the
 * caller computes from now. Rows never viewed (`viewed_since` null) and
 * rows still working or waiting are never swept. Returns the rows swept.
 */
export const sweepExpiredResults = (db: Database, cutoffIso: string): number =>
  inWriteTransaction(db, () => {
    const result = db.run(
      `UPDATE active_sessions
       SET done_since = NULL, unread_since = NULL, viewed_since = NULL,
           status = CASE WHEN status = 'error' THEN 'idle' ELSE status END,
           status_since = CASE WHEN status = 'error' THEN ? ELSE status_since END,
           background_outstanding = CASE WHEN status = 'error' THEN 0 ELSE background_outstanding END
       WHERE viewed_since IS NOT NULL AND viewed_since <= ?
         AND (done_since IS NOT NULL OR status = 'error')`,
      [cutoffIso, cutoffIso],
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
        const expiryCutoff = new Date(nowMs - VIEWED_EXPIRY_TTL_MS).toISOString();
        if (sweepExpiredResults(this.connection, expiryCutoff) > 0) {
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

### Task 8: Snapshot surface — `pendingResults` and `endedAt` (R6 wire, R10 wire)

**Files:**
- Modify: `src/protocol.ts` (ProjectedSession :104-133, ProjectedAgentNode :139-167, parseAgent :198-330, parseSession :356-480)
- Test: `test/protocol.test.ts`, plus mechanical factory updates enumerated in Step 4

**Interfaces:**
- Consumes: nothing.
- Produces: `ProjectedSession.pendingResults: number`, `ProjectedSession.endedAt: string | null`, `ProjectedAgentNode.pendingResults: number`, `ProjectedAgentNode.endedAt: string | null`; parsers tolerate missing keys (old daemons) with defaults `0`/`null`; native agent nodes validate both as `0`/`null`.

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

- [ ] **Step 3: Implement the protocol additions**

`src/core/projection.ts` is deliberately NOT touched in this task — `ProjectionRow.endedAt` and its population land in Task 9, which keeps this task compiling.

In `src/protocol.ts`:

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

- [ ] **Step 4: Update every typed factory/literal across the suites**

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

Do **not** touch `test/projection.test.ts` here: its `row()` helper builds `ProjectionRow` (unchanged until Task 9), and its `readProjection` full-literal assertions would fail against a projection that does not populate the new fields yet. Task 9 owns both.

Add only these two fields; do not reorder existing fields.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/protocol.test.ts && bun test`
Expected: PASS (nothing consumes the fields yet).

- [ ] **Step 6: Typecheck + lint**

Run: `bun run typecheck && biome check .`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/protocol.ts test/
git commit -m "feat(protocol): snapshot roots carry pendingResults and endedAt"
```

---

### Task 9: Projection roll-up + fail-safe promotion (R6, R7)

**Files:**
- Modify: `src/core/projection.ts` (StoredRow :533-555, toProjectionRow :570-660, PROJECTION_COLUMNS :662-663, readProjection SELECT :672, rootVisible :299-302, rootFacts :307-328, nativeNode :351-376, region between the Paseo status roll-up and `rootVisible`)
- Test: `test/projection.test.ts`

**Interfaces:**
- Consumes: protocol fields `pendingResults`/`endedAt` from Task 8.
- Produces: `ProjectionRow.endedAt: string | null` (added here, carried end to end by this task); finished Paseo subagents with a resolvable parent are hidden and roll their ledgers up to the root ancestor; unresolvable ancestry (dangling ref, ambiguous ref, cycle, missing parent row) promotes the subagent to its own root card (fail-safe); published roots carry `pendingResults` (count of Paseo descendants with `unreadSince`) and an aggregated `unreadSince` (the latest of own + descendants'); active subagent cards unchanged.

- [ ] **Step 1: Write the failing tests**

In `test/projection.test.ts`:

0. First make the fixture compile against the extended input row: add `endedAt?: string | null;` to the `row()` helper's options type and `endedAt: options.endedAt ?? null,` to its returned object (next to `doneSince`).

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
    expect(sessions).toHaveLength(2); // the parent's own unread keeps it; the sub's rolls up
    const parentEntry = sessions.find((session) => session.sessionId === "parent");
    expect(parentEntry).toMatchObject({ pendingResults: 1, unreadSince: "2026-08-25T00:00:09.000Z" });
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

5. Update the full-literal assertions in `"projects one consistent snapshot from a separately committed writer"`: add `pendingResults: 0, endedAt: null` to the single session object (after `doneSince: null,`) and to all three agent objects (after each `doneSince: null,`).

6. In the same `readProjection` describe, append:

```typescript
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/projection.test.ts`
Expected: FAIL — hidden-subagent expectations invert, `pendingResults` missing from output, `endedAt` not carried.

- [ ] **Step 3: Implement the projection changes**

In `src/core/projection.ts`:

1. `StoredRow` — add after `done_since`:

```typescript
  ended_at: unknown;
```

2. `toProjectionRow` — extend the corruption guard that currently checks `unread_since`/`done_since`/`status_since`:

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

3. `PROJECTION_COLUMNS` — append `, ended_at`:

```typescript
const PROJECTION_COLUMNS =
  "provider, session_id, parent_session_id, status, title, project, logical_slot, ghostty_terminal_id, model, opened_at, origin_kind, origin_ref, origin_subagent, unread_since, done_since, status_since, activity_line, transcript_path, origin_parent_ref, updated_at, ended_at";
```

4. Replace the `rootVisible` definition and insert the roll-up machinery immediately before it (after the Paseo status roll-up loop that ends with the `for (const result of rootResults) { let carried = … }` block):

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

5. `rootFacts` — replace `unreadSince: result.row.unreadSince,` with the aggregated value and add the new fields:

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

6. `nativeNode` — add `pendingResults: 0, endedAt: null,` (after `doneSince: null,`).

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

    // No watermark (the deck/bare-CLI shape) dismisses unconditionally.
    expect(await runCli(["sessions", "ack", "claude", "w1"], harness.deps)).toBe(0);
    expect(listRows()[0]).toMatchObject({ unreadSince: null });
  });
```

Also extend the malformed-usage list in the test `"sessions commands reject malformed usage with nonzero and stderr"` — add these entries to the `args` array:

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

1. Registry import — add `viewSession` (alphabetical position after `syncPaseoStates`… actually after `pruneStaleSessions`):

```typescript
import {
  acknowledgeSession,
  applyRegistryEvents,
  clearAllSessions,
  clearSession,
  listSessions,
  pruneStaleSessions,
  syncPaseoStates,
  viewSession,
} from "./registry";
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

4. `runSessions` — relax the `ack` case's arg validation and add the watermark, then add the `view` case immediately after it:

```typescript
    case "ack": {
      const [providerArg, sessionId, watermark, ...extra] = rest;
      if (
        !isProvider(providerArg) ||
        sessionId === undefined ||
        sessionId.length === 0 ||
        extra.length > 0 ||
        (watermark !== undefined && watermark.length === 0)
      ) {
        deps.stderr(USAGE);
        return 1;
      }
      try {
        const db = deps.openDatabase(deps.paths.database, "readwrite");
        try {
          acknowledgeSession(db, providerArg, sessionId, deps.now(), watermark ?? null);
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
      const [providerArg, sessionId, watermark, ...extra] = rest;
      if (
        !isProvider(providerArg) ||
        sessionId === undefined ||
        sessionId.length === 0 ||
        extra.length > 0 ||
        (watermark !== undefined && watermark.length === 0)
      ) {
        deps.stderr(USAGE);
        return 1;
      }
      try {
        const db = deps.openDatabase(deps.paths.database, "readwrite");
        try {
          viewSession(db, providerArg, sessionId, deps.now(), watermark ?? null);
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
- Modify: `app/src-tauri/src/main.rs` (`ack_session` :179-184, `clear_session` :196-201, `invoke_handler` list :370-381), `app/src/bridge.ts`
- Test: none added (Rust command functions follow the file's convention — only the watcher is unit-tested; the webview exercises these end-to-end)

**Interfaces:**
- Consumes: CLI `sessions view|ack … [watermark]` from Task 10.
- Produces: Tauri commands `view_session(provider, session_id, watermark: Option<String>)` and `ack_session(provider, session_id, watermark: Option<String>)`; bridge functions `viewSession(provider, sessionId, watermark = null)` and `ackSession(provider, sessionId, watermark = null)` for Task 12.

- [ ] **Step 1: Implement the Rust commands**

In `app/src-tauri/src/main.rs`, replace the `ack_session` command with:

```rust
/// The app's only write paths back to the daemon, mirroring the plugin's
/// session-ack: the installed binary, fixed subcommand argv, no shell. The
/// optional watermark is the unread stamp visible when the gesture was
/// issued; stamps newer than it survive the gesture.
#[tauri::command]
async fn ack_session(provider: &str, session_id: &str, watermark: Option<String>) -> Result<(), String> {
    run_session_gesture("ack", provider, session_id, watermark).await
}

/// View gesture: clears the unread badge and starts the viewed-expiry
/// clock; the card stays on the board (dismiss is `ack_session`).
#[tauri::command]
async fn view_session(provider: &str, session_id: &str, watermark: Option<String>) -> Result<(), String> {
    run_session_gesture("view", provider, session_id, watermark).await
}

async fn run_session_gesture(
    verb: &str,
    provider: &str,
    session_id: &str,
    watermark: Option<String>,
) -> Result<(), String> {
    let executable = app_support_root()?.join("bin/dealerboard");
    let path = executable.to_string_lossy().to_string();
    let mut args: Vec<String> = vec!["sessions".into(), verb.into(), provider.into(), session_id.into()];
    if let Some(watermark) = watermark {
        args.push(watermark);
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(&path, &refs)
}
```

Register the new command — in `invoke_handler(tauri::generate_handler![…])`, insert `view_session,` immediately after `ack_session,`.

- [ ] **Step 2: Extend the bridge**

In `app/src/bridge.ts`, replace the `ackSession` definition and add `viewSession` directly above it:

```typescript
/** View gesture: clears the unread badge and starts the viewed-expiry clock; the card stays. */
export const viewSession = (provider: Provider, sessionId: string, watermark: string | null = null): Promise<void> =>
  invoke<void>("view_session", { provider, sessionId, watermark });

/** Dismiss gesture: takes the card off the board. The watermark makes it causal — newer results survive. */
export const ackSession = (provider: Provider, sessionId: string, watermark: string | null = null): Promise<void> =>
  invoke<void>("ack_session", { provider, sessionId, watermark });
```

- [ ] **Step 3: Verify the Rust side compiles**

Run: `cd app && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS. (Return to the repo root afterwards.)

- [ ] **Step 4: Typecheck the webview side**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

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
    expect(calls[0]).toEqual({ fn: "view", args: ["claude", "session-1", "2026-08-26T05:00:00.000Z"] });
    expect(callNames(calls)).toEqual(["view", "focusGhostty"]);
  });

  test("a read session views with a null watermark", async () => {
    const { deps, calls } = makeDeps();
    await pressSessionTile(session({ provider: "kimi" }), deps);
    expect(calls[0]).toEqual({ fn: "view", args: ["kimi", "session-1", null] });
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
    expect(calls[0]).toEqual({ fn: "view", args: ["claude", "session-1", "2026-08-26T04:00:00.000Z"] });
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
import { routeForSession } from "./routing";

export type PressDeps = {
  view: (provider: Provider, sessionId: string, watermark: string | null) => Promise<void>;
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
  void deps.view(session.provider, session.sessionId, session.unreadSince).catch(() => {});
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
