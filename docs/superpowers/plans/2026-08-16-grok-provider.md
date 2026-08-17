# Grok Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `grok` (xAI Grok Build CLI) as the eighth session provider — hook ingest, decoder, title/model resolver, chip, schema widen — per the approved spec `docs/superpowers/specs/2026-08-16-grok-provider-design.md`.

**Architecture:** A managed JSON hook file in `~/.grok/hooks/` (installed by `scripts/install-local.ts`) pipes grok's camelCase hook envelopes to `stream-deck-agents event grok`; a grok branch in `src/core/providers.ts` maps grok's snake_case event values onto the existing canonical `RegistryEvent`s; titles/models are pulled from `~/.grok/sessions/*/<id>/summary.json` by the daemon's facts resolver; the provider CHECK widen is a schema v10 table rebuild.

**Tech Stack:** Bun + TypeScript (strict, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`), `bun:test`, `bun:sqlite`, Biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-16-grok-provider-design.md` — read it first.

**Schema numbering note (check before starting Task 2):** this plan is written against a tree where `LATEST_SCHEMA_VERSION = 9` (`src/core/schema.ts:16`) and the pi/omp-ghostty v10 rebuild has NOT landed. Grok therefore takes **v10**. If the ghostty change has landed (`LATEST_SCHEMA_VERSION = 10`), renumber this plan's v10→v11 throughout: clone the v10 DDL instead of the v9 DDL, name the archive `active_sessions_v10_archived`, and the version pins in tests move to 11.

## Global Constraints

- Gate before done: `bun run check` (= `biome ci . && bun run build && bun test`) green.
- Biome: 2-space indent, double quotes, semicolons, 120 columns; `noExplicitAny`, `noEvolvingTypes`, `noConsole`, `noProcessEnv` (env enters via `src/core/cli.ts` DI only), `noDefaultExport`, `noNonNullAssertion` (relaxed in `test/**`), nursery `noFloatingPromises`. `useLiteralKeys` is off — use bracket access for index signatures.
- tsconfig strictness: `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax` (use `import type` for type-only imports), `erasableSyntaxOnly`, `noUncheckedIndexedAccess`.
- Privacy contract: the decoder reads only `SAFE_FIELDS`-allowlisted keys; `cwd` survives only as its basename; strings capped at 256 code points. No new classified fields in this change.
- The schema rebuild is **not** a `MIGRATIONS` entry (the loop runs in one transaction; `PRAGMA foreign_keys` is a no-op inside one). It runs strictly last in `initializeDatabase`, manages its own FK-off transaction, and runs `PRAGMA foreign_key_check` before commit.
- The new table DDL must be a verbatim clone of the post-v9 shape (all columns including `model`, `origin_kind`, `origin_ref`, `origin_subagent`, `unread_since`, `acked_at`; `WITHOUT ROWID`; composite PK; self-FK `ON DELETE CASCADE`; slot/parent CHECK), changing only the provider CHECK list.
- Do not edit dated files under `docs/superpowers/` or `docs/verification/` — create new dated files.
- Never touch Linear. Never commit unless the task step says to (each commit step is an explicit instruction).

---

### Task 1: Live payload-capture probe (gates Task 4's fixtures)

The spec's decoder contract comes from the bundled grok 1.0.4 user guide; this task captures real envelopes on stdin before any decoder fixture is frozen. It also proves grok tolerates an unknown top-level key in a hook file (the installer's ownership marker relies on that).

**Files:**
- Create (outside repo, removed at the end): `/Users/drewritter/.grok/hooks/zz-sda-capture.json`, `/tmp/grok-hook-capture/`
- Create: `test/fixtures/grok/*.json` (one file per event, redacted)
- Create: `docs/verification/<today>-grok-payload-probe.md` (use `date +%F`)

**Interfaces:**
- Produces: `test/fixtures/grok/session-start.json`, `user-prompt-submit.json`, `pre-tool-use.json`, `post-tool-use.json`, `stop-end-turn.json`, `session-end.json` captured verbatim; `stop-cancelled.json`, `stop-failure.json`, `notification-permission-prompt.json`, `notification-idle-prompt.json`, `stop-session-teardown.json`, `subagent-activity.json` captured when reachable, otherwise synthesized from the §10 doc envelope and marked `synthesized: true` in the probe note. Task 4 transcribes these files into inline test literals.

- [ ] **Step 1: Install the capture hook**

```bash
mkdir -p /tmp/grok-hook-capture
```

Write `/Users/drewritter/.grok/hooks/zz-sda-capture.json` (the `x-capture-probe` key is deliberate — it doubles as the marker-tolerance probe):

```json
{
  "x-capture-probe": "stream-deck-agents probe v1",
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "tee -a /tmp/grok-hook-capture/session-start.jsonl", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "tee -a /tmp/grok-hook-capture/user-prompt-submit.jsonl", "timeout": 5 }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "tee -a /tmp/grok-hook-capture/pre-tool-use.jsonl", "timeout": 5 }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "tee -a /tmp/grok-hook-capture/post-tool-use.jsonl", "timeout": 5 }] }],
    "PostToolUseFailure": [{ "hooks": [{ "type": "command", "command": "tee -a /tmp/grok-hook-capture/post-tool-use-failure.jsonl", "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "tee -a /tmp/grok-hook-capture/stop.jsonl", "timeout": 5 }] }],
    "StopFailure": [{ "hooks": [{ "type": "command", "command": "tee -a /tmp/grok-hook-capture/stop-failure.jsonl", "timeout": 5 }] }],
    "StopCancelled": [{ "hooks": [{ "type": "command", "command": "tee -a /tmp/grok-hook-capture/stop-cancelled.jsonl", "timeout": 5 }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "tee -a /tmp/grok-hook-capture/notification.jsonl", "timeout": 5 }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "tee -a /tmp/grok-hook-capture/subagent-start.jsonl", "timeout": 5 }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "tee -a /tmp/grok-hook-capture/subagent-stop.jsonl", "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "tee -a /tmp/grok-hook-capture/session-end.jsonl", "timeout": 5 }] }]
  }
}
```

- [ ] **Step 2: Run scripted headless turns**

Run from a scratch directory so `cwd`/`workspaceRoot` are disposable:

```bash
mkdir -p /tmp/grok-probe-cwd && cd /tmp/grok-probe-cwd
grok -p "Reply with the single word pong."
grok -p "Use the terminal to run: echo sda-probe-ok — then tell me what it printed."
grok -p "Use the terminal to run: exit 3 — then report what happened."
```

The second prompt forces `PreToolUse`/`PostToolUse`; the third may yield `PostToolUseFailure`. Session teardown (`SessionEnd`, plus the session-end observe `Stop` with `reason: "channel_closed"`/`"shutdown"`) fires when the headless run exits.

- [ ] **Step 3: Assert the minimum capture set landed**

```bash
for f in session-start user-prompt-submit pre-tool-use post-tool-use stop session-end; do
  test -s "/tmp/grok-hook-capture/$f.jsonl" && echo "OK $f" || echo "MISSING $f"
done
```

Expected: all OK. If `session-start` is MISSING, hooks do not fire headless — STOP and report back; the design's Paseo path depends on this and the failure must go to the user before any further task. Record in the probe note whether headless hooks fired at all (this is the ACP-fidelity signal).

- [ ] **Step 4: Try for the interactive-only events**

`StopCancelled` (Esc mid-turn), `Notification permission_prompt`, and `StopFailure` need interactivity or specific failures. If a scripted trigger is available (e.g. an interactive `grok` session you can drive, or a permission-gated tool call in default mode), capture them. Otherwise synthesize their fixtures from the §10 envelope (common fields plus the documented per-event fields: `reason`/`cancelledBy`/`cancelTrigger` for stop-cancelled, `error`/`errorDetails` for stop-failure, `notificationType` for notification) and mark them `synthesized: true` in the probe note. If any captured `Stop` payload carries `reason: "channel_closed"` or `"shutdown"` (session teardown), keep it as `stop-session-teardown.json`.

- [ ] **Step 5: Copy fixtures into the repo, redacted, and remove the probe**

For each event take the LAST line of its `.jsonl` (the richest, post-warmup), pretty-print it, and redact path values (`cwd`, `workspaceRoot`, any `CLAUDE_PROJECT_DIR`-style fields) to `/Users/you/project` — keep key casing verbatim. Save as `test/fixtures/grok/<event>.json` per the Interfaces list. Then:

```bash
rm /Users/drewritter/.grok/hooks/zz-sda-capture.json
rm -rf /tmp/grok-hook-capture /tmp/grok-probe-cwd
```

- [ ] **Step 6: Write the probe note and commit**

`docs/verification/<today>-grok-payload-probe.md`: which events were captured vs synthesized (with the exact trigger used per event), the exact `hookEventName` values observed (confirm snake_case), whether `session_start` carries `model`/`source`, the `stop` `reason` values seen, `notificationType` values seen, whether any payload carried `subagentType`, marker-key tolerance result, and whether headless hooks fire. Commit:

```bash
git add test/fixtures/grok docs/verification/<today>-grok-payload-probe.md
git commit -m "test(grok): captured hook payload fixtures from live probe"
```

---

### Task 2: Registry schema v10 (provider CHECK widen)

Lands green on its own: the CHECK accepts `grok` before any code can emit it, and the lockstep test (`test/schema.test.ts:382`) only inserts `PROVIDER_KEYS` providers, so it stays green until Task 3. Includes the `migrateToV8` gate — the moment `LATEST_SCHEMA_VERSION` exceeds 9, an ungated `migrateToV8` re-stamps v9 databases to 8 mid-flight and a failed rebuild then bricks init (analysis: ghostty spec §Registry schema v10).

**Files:**
- Modify: `src/core/schema.ts` (LATEST bump, gate, new rebuild, comment)
- Test: `test/schema.test.ts`

**Interfaces:**
- Produces: `LATEST_SCHEMA_VERSION = 10`; a v10 `active_sessions` whose provider CHECK is `('claude', 'codex', 'kimi', 'pi', 'omp', 'zcode', 'deepseek', 'grok')`. Task 3 relies on it.

- [ ] **Step 1: Write the failing tests**

Add to `test/schema.test.ts`, after the v5-era rebuild tests. (Note: the `migrates a v9 database` test below is final copy-pasteable code — two clean connection blocks, each with its own try/finally.) First a v9 fixture factory (post-v9 shape with the 7-provider CHECK — a real v9 database):

```ts
const createVersion9Database = (path: string, options?: { orphan?: boolean }): void => {
  const legacy = new Database(path, { create: true, readwrite: true });
  try {
    legacy.exec("PRAGMA foreign_keys = OFF");
    legacy.exec(`
      CREATE TABLE active_sessions (
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'kimi', 'pi', 'omp', 'zcode', 'deepseek')),
        session_id TEXT NOT NULL,
        parent_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('idle', 'working', 'waiting', 'error')),
        title TEXT,
        project TEXT,
        logical_slot INTEGER,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ghostty_terminal_id TEXT
          CHECK (
            ghostty_terminal_id IS NULL
            OR (provider = 'claude' AND parent_session_id IS NULL AND length(ghostty_terminal_id) BETWEEN 1 AND 256)
          ),
        background_outstanding INTEGER NOT NULL DEFAULT 0
          CHECK (background_outstanding IN (0, 1)),
        transcript_path TEXT
          CHECK (transcript_path IS NULL OR length(transcript_path) BETWEEN 1 AND 256),
        model TEXT
          CHECK (model IS NULL OR length(model) BETWEEN 1 AND 256),
        origin_kind TEXT
          CHECK (origin_kind IS NULL OR origin_kind IN ('paseo', 'terminal')),
        origin_ref TEXT
          CHECK (origin_ref IS NULL OR length(origin_ref) BETWEEN 1 AND 256),
        origin_subagent INTEGER NOT NULL DEFAULT 0
          CHECK (origin_subagent IN (0, 1)),
        unread_since TEXT,
        acked_at TEXT,
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
      PRAGMA user_version = 9;
    `);
    // Every nullable/defaulted column carries a non-default value so a value
    // lost on the rebuild path cannot pass as a default.
    legacy.run(
      `INSERT INTO active_sessions
         (provider, session_id, parent_session_id, status, title, project, logical_slot,
          opened_at, updated_at, ghostty_terminal_id, background_outstanding, transcript_path,
          model, origin_kind, origin_ref, origin_subagent, unread_since, acked_at)
       VALUES
         ('claude', 'root', NULL, 'working', 'Root session', 'proj-root', 1,
          '2026-08-06T01:00:00.000Z', '2026-08-06T02:00:00.000Z', 'ghostty-a1', 1, '/transcripts/root.jsonl',
          'claude-fable-5', 'paseo', 'agent-1', 0,
          '2026-08-06T02:30:00.000Z', '2026-08-06T02:45:00.000Z'),
         ('claude', 'child', 'root', 'waiting', 'Child session', 'proj-child', NULL,
          '2026-08-06T03:00:00.000Z', '2026-08-06T04:00:00.000Z', NULL, 1, '/transcripts/child.jsonl',
          'claude-fable-5', 'terminal', 'ghostty', 1,
          '2026-08-06T04:30:00.000Z', '2026-08-06T04:45:00.000Z')`,
    );
    if (options?.orphan === true) {
      legacy.run(
        `INSERT INTO active_sessions
           (provider, session_id, parent_session_id, status, opened_at, updated_at)
         VALUES ('claude', 'orphan', 'gone', 'idle', '2026-08-06T05:00:00.000Z', '2026-08-06T05:00:00.000Z')`,
      );
    }
    legacy.exec("PRAGMA foreign_keys = ON");
  } finally {
    legacy.close();
  }
};
```

Then the tests:

```ts
describe("schema v10 rebuild", () => {
  test("migrates a v9 database, preserving every row value", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion9Database(paths.database);

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      const version = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(version.user_version).toBe(10);
      const rows = db
        .query("SELECT * FROM active_sessions ORDER BY session_id ASC")
        .all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      const child = rows[0];
      const root = rows[1];
      expect(root).toMatchObject({
        provider: "claude",
        session_id: "root",
        status: "working",
        title: "Root session",
        logical_slot: 1,
        ghostty_terminal_id: "ghostty-a1",
        background_outstanding: 1,
        transcript_path: "/transcripts/root.jsonl",
        model: "claude-fable-5",
        origin_kind: "paseo",
        origin_ref: "agent-1",
        origin_subagent: 0,
        unread_since: "2026-08-06T02:30:00.000Z",
        acked_at: "2026-08-06T02:45:00.000Z",
      });
      expect(child).toMatchObject({
        parent_session_id: "root",
        logical_slot: null,
        origin_subagent: 1,
        acked_at: "2026-08-06T04:45:00.000Z",
      });
      // The widened CHECK accepts grok and still rejects non-providers.
    } finally {
      db.close();
    }

    const writer = openRegistryDatabase(paths.database, "readwrite");
    try {
      writer.run(
        `INSERT INTO active_sessions (provider, session_id, status, logical_slot, opened_at, updated_at)
         VALUES ('grok', 'g1', 'idle', 2, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
      );
      expect(() =>
        writer.run(
          `INSERT INTO active_sessions (provider, session_id, status, logical_slot, opened_at, updated_at)
           VALUES ('vscode', 'v1', 'idle', 3, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
        ),
      ).toThrow(/CHECK constraint failed/);
      // Partial unique index: duplicate live slot rejected, sibling slots for
      // children (NULL) unaffected.
      expect(() =>
        writer.run(
          `INSERT INTO active_sessions (provider, session_id, status, logical_slot, opened_at, updated_at)
           VALUES ('grok', 'g2', 'idle', 2, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
        ),
      ).toThrow();
      // Self-FK cascade survives the rebuild.
      writer.run(
        `INSERT INTO active_sessions (provider, session_id, parent_session_id, status, opened_at, updated_at)
         VALUES ('grok', 'g1-child', 'g1', 'idle', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
      );
      writer.run("DELETE FROM active_sessions WHERE provider = 'grok' AND session_id = 'g1'");
      expect(
        (writer.query("SELECT COUNT(*) AS n FROM active_sessions WHERE provider = 'grok'").get() as { n: number }).n,
      ).toBe(0);
      // Storage contract preserved, and the archive table is gone.
      const ddl = writer.query("SELECT sql FROM sqlite_master WHERE name = 'active_sessions'").get() as {
        sql: string;
      };
      expect(ddl.sql).toContain("WITHOUT ROWID");
      expect(ddl.sql).toContain("'grok'");
      expect(
        writer.query("SELECT name FROM sqlite_master WHERE name = 'active_sessions_v9_archived'").all(),
      ).toHaveLength(0);
    } finally {
      writer.close();
    }
  });

  test("a failed v10 rebuild keeps user_version = 9 and the original table; a retry converges", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    createVersion9Database(paths.database, { orphan: true });

    // The orphan trips the rebuild's foreign_key_check; the attempt rolls back.
    expect(() => initializeDatabase(paths)).toThrow();
    const peek = new Database(paths.database, { readonly: true, create: false });
    try {
      expect((peek.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(9);
      // The original table is intact, orphan included.
      expect((peek.query("SELECT COUNT(*) AS n FROM active_sessions").get() as { n: number }).n).toBe(3);
    } finally {
      peek.close();
    }

    // Without the version < 8 gate, the failed attempt would have committed
    // user_version = 8 (migrateToV8) and this retry would die re-adding
    // acked_at. With the gate the retry from 9 runs the rebuild alone.
    const fix = new Database(paths.database, { readwrite: true });
    try {
      fix.run("DELETE FROM active_sessions WHERE session_id = 'orphan'");
    } finally {
      fix.close();
    }
    initializeDatabase(paths);
    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
    } finally {
      db.close();
    }
  });

  test("fresh init lands at v10 and repeated init is idempotent", () => {
    const paths = resolveAppPaths(tempHome);
    mkdirSync(paths.root, { recursive: true });
    initializeDatabase(paths);
    initializeDatabase(paths);
    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
      const ddl = db.query("SELECT sql FROM sqlite_master WHERE name = 'active_sessions'").get() as { sql: string };
      expect(ddl.sql).toContain("'grok'");
    } finally {
      db.close();
    }
  });
});
```

Note for the implementer: the `migrates a v9 database` test's first block closes its readonly connection before the writer block — structure it cleanly (two `openRegistryDatabase` blocks; the `try/finally` skeleton above is illustrative, the assertions are not).

Also update every existing pin that assumes latest = 9. Find them with:

```bash
grep -n "user_version" test/schema.test.ts | grep -v "createVersion"
grep -n "LATEST_SCHEMA_VERSION\|UnsupportedSchemaVersion\|toBe(10)\|toBe(9)" test/schema.test.ts
```

Every `user_version` assertion on an initialized database becomes 10, and any "future version" fixture stamped 10 becomes 11 (it must stay ahead of LATEST). Do not touch the fixture-internal `PRAGMA user_version = 4/5/9` stamps — those are starting points.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `bun test test/schema.test.ts`
Expected: FAIL — `toBe(10)` assertions see 9, and the grok insert is rejected by the old CHECK.

- [ ] **Step 3: Implement the v10 rebuild**

In `src/core/schema.ts`:

1. Bump: `export const LATEST_SCHEMA_VERSION = 10;`
2. Add the rebuild SQL after `SCHEMA_VERSION_9`:

```ts
/**
 * v10 widens the provider CHECK for grok. SQLite cannot alter a CHECK, so the
 * table is rebuilt following the v5 pattern: rename aside (the self-FK is
 * rewritten to the archived name by SQLite and dropped with it), create the
 * final table as a verbatim clone of the post-v9 shape with only the provider
 * list changed, copy rows with an explicit full column list, recreate the
 * partial unique index.
 */
const SCHEMA_VERSION_10 = `
ALTER TABLE active_sessions RENAME TO active_sessions_v9_archived;

CREATE TABLE active_sessions (
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'kimi', 'pi', 'omp', 'zcode', 'deepseek', 'grok')),
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('idle', 'working', 'waiting', 'error')),
  title TEXT,
  project TEXT,
  logical_slot INTEGER,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ghostty_terminal_id TEXT
  CHECK (
    ghostty_terminal_id IS NULL
    OR (
      provider = 'claude'
      AND parent_session_id IS NULL
      AND length(ghostty_terminal_id) BETWEEN 1 AND 256
    )
  ),
  background_outstanding INTEGER NOT NULL DEFAULT 0
  CHECK (background_outstanding IN (0, 1)),
  transcript_path TEXT
  CHECK (transcript_path IS NULL OR length(transcript_path) BETWEEN 1 AND 256),
  model TEXT
  CHECK (model IS NULL OR length(model) BETWEEN 1 AND 256),
  origin_kind TEXT
  CHECK (origin_kind IS NULL OR origin_kind IN ('paseo', 'terminal')),
  origin_ref TEXT
  CHECK (origin_ref IS NULL OR length(origin_ref) BETWEEN 1 AND 256),
  origin_subagent INTEGER NOT NULL DEFAULT 0
  CHECK (origin_subagent IN (0, 1)),
  unread_since TEXT,
  acked_at TEXT,
  PRIMARY KEY (provider, session_id),
  FOREIGN KEY (provider, parent_session_id)
    REFERENCES active_sessions(provider, session_id) ON DELETE CASCADE,
  CHECK (
    (parent_session_id IS NULL AND logical_slot IS NOT NULL AND logical_slot > 0)
    OR
    (parent_session_id IS NOT NULL AND logical_slot IS NULL)
  )
) WITHOUT ROWID;

INSERT INTO active_sessions
  (provider, session_id, parent_session_id, status, title, project, logical_slot,
   opened_at, updated_at, ghostty_terminal_id, background_outstanding, transcript_path,
   model, origin_kind, origin_ref, origin_subagent, unread_since, acked_at)
SELECT
  provider, session_id, parent_session_id, status, title, project, logical_slot,
  opened_at, updated_at, ghostty_terminal_id, background_outstanding, transcript_path,
  model, origin_kind, origin_ref, origin_subagent, unread_since, acked_at
FROM active_sessions_v9_archived;

DROP TABLE active_sessions_v9_archived;

CREATE UNIQUE INDEX active_sessions_unique_slot
  ON active_sessions(logical_slot)
  WHERE logical_slot IS NOT NULL;
`;
```

3. Add the rebuild runner next to `migrateToV5`:

```ts
/**
 * The v10 rebuild manages its own BEGIN/COMMIT for the same reason v5 does:
 * `PRAGMA foreign_keys` is a no-op inside a transaction. It runs strictly
 * last in initializeDatabase, after every ALTER migration, so the archive
 * copy always starts from the final post-v9 shape.
 */
const migrateToV10 = (db: Database): void => {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  let committed = false;
  try {
    db.exec(SCHEMA_VERSION_10);
    const violations = db.query("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(`schema v10 rebuild left ${String(violations.length)} foreign key violation(s)`);
    }
    db.exec("PRAGMA user_version = 10");
    db.exec("COMMIT");
    committed = true;
  } finally {
    if (!committed) {
      db.exec("ROLLBACK");
    }
    db.exec("PRAGMA foreign_keys = ON");
  }
};
```

4. In `initializeDatabase`, gate `migrateToV8` and append the v10 step. Replace `migrateToV8(db);` with:

```ts
      // v8 is shape repair for pre-merge v7 databases; a v8-or-later database
      // must never re-enter it — its unconditional stamp would clobber
      // user_version back to 8 mid-pipeline (the v10 bricking hazard).
      if (version < 8) {
        migrateToV8(db);
      }
```

and after the `migratePostV8();` line add:

```ts
      // The v10 rebuild runs strictly last and owns its transaction (see
      // migrateToV10); the MIGRATIONS loop cannot contain it.
      migrateToV10(db);
```

5. Update the `MIGRATIONS` doc comment's last sentences to: "v8 is special-cased too (`migrateToV8`): it is shape-driven repair, not a static SQL string, and it is gated on `version < 8` so post-v8 databases never re-enter it. Entries above v8 and below v10 (v9 acked_at) run in a final transaction after the repair. v10 is special-cased like v5 (`migrateToV10`): a table rebuild that runs strictly last."

- [ ] **Step 4: Run the tests**

Run: `bun test test/schema.test.ts`
Expected: PASS (whole file, including the updated pins).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint`
Expected: clean. Then:

```bash
git add src/core/schema.ts test/schema.test.ts
git commit -m "feat(schema): v10 rebuild widening the provider CHECK for grok"
```

---

### Task 3: Provider key + plugin surface

The compile-gated core: `PROVIDER_KEYS` entry plus every `Record<Provider, …>` and the controller's `never` proof. Typecheck forces completeness; the tests pin behavior.

**Files:**
- Modify: `src/protocol.ts:8`
- Modify: `src/plugin/render.ts:38,55-73`
- Modify: `src/plugin/controller.ts:213-216`
- Test: `test/protocol.test.ts:264`, `test/cli.test.ts:716`, `test/controller.test.ts:681`, `test/render.test.ts:154-185`, `test/projection.test.ts` (new-provider scenario)

**Interfaces:**
- Consumes: Task 2's widened CHECK (the lockstep test at `test/schema.test.ts:382` inserts one row per `PROVIDER_KEYS` member — it goes green only with both tasks landed).
- Produces: `"grok"` as a `Provider`; `PROVIDER_COLORS.grok`, `PROVIDER_LETTERS.grok`.

- [ ] **Step 1: Write the failing test updates**

- `test/protocol.test.ts:264` — extend the list: `test.each(["pi", "omp", "zcode", "deepseek", "grok"] as const)("accepts provider %s", ...)`.
- `test/cli.test.ts:716` — same extension on `test.each(["pi", "omp", "zcode", "deepseek", "grok"] as const)("event %s is accepted", ...)`.
- `test/controller.test.ts:681` — same extension on `"a %s tile press alerts without invoking any activator"`.
- `test/render.test.ts` — in `"renders the provider mark for each provider"` (:154) append:
  ```ts
      expect(textNodesByClass(decode(sessionModel({ provider: "grok" }), 0), "mark")).toEqual(["G"]);
  ```
  in `"colors the provider chip per harness"` (:164) append:
  ```ts
      expect(decode(sessionModel({ provider: "grok" }), 0)).toContain("#F472B6");
  ```
  in `"renders the stripped model label right of the provider chip"` (:174) append:
  ```ts
      expect(textNodesByClass(decode(sessionModel({ provider: "grok", model: "grok-4.6" }), 0), "model")).toEqual([
        "4.6",
      ]);
  ```
- `test/projection.test.ts` — in the new-provider scenario (:440-509), add a grok sibling of the deepseek row: a `SessionStart` with `provider: "grok"`, `sessionId: "g1"` (observedAt `...00:00:05.500Z` ordering is not required — any timestamp consistent with the sequence), a `Stop` for it (so the idle row lands an unread result and stays projected), and extend the final provider list assertion (:503) to `[..., "deepseek", "grok"]`.

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/protocol.test.ts test/cli.test.ts test/controller.test.ts test/render.test.ts test/projection.test.ts`
Expected: FAIL — parser rejects `grok`, CLI rejects the arg, controller/render fail to typecheck (missing Record entry / unhandled case).

- [ ] **Step 3: Implement**

- `src/protocol.ts:8`:
  ```ts
  export const PROVIDER_KEYS = ["claude", "codex", "kimi", "pi", "omp", "zcode", "deepseek", "grok"] as const;
  ```
- `src/plugin/render.ts:38`: `const MODEL_LABEL_PREFIXES = ["claude-", "gpt-", "zai/", "openai/", "grok-"];`
- `src/plugin/render.ts` `PROVIDER_COLORS`: add `grok: "#F472B6",` after `deepseek`.
- `src/plugin/render.ts` `PROVIDER_LETTERS`: add `grok: "G",` after `deepseek`.
- `src/plugin/controller.ts:213-216`: add `case "grok":` to the alert group (`case "pi": / case "omp": / case "zcode": / case "deepseek":`), and update the group's comment to mention grok.

- [ ] **Step 4: Run the full gate**

Run: `bun run check`
Expected: PASS — this catches every provider-locked site the tests missed (projection derives from `PROVIDER_KEYS`; the paseo overlay too).

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts src/plugin/render.ts src/plugin/controller.ts test/protocol.test.ts test/cli.test.ts test/controller.test.ts test/render.test.ts test/projection.test.ts
git commit -m "feat: register grok as a provider (chip G, #F472B6, alert routing)"
```

---

### Task 4: Grok decoder branch

Grok's envelope keys are camelCase — already readable through the existing `SAFE_FIELDS` aliases (`hookEventName`, `sessionId`, `toolName`, `notificationType`). What is genuinely grok-specific: snake_case event VALUES, the `reason` field on `stop`, and the `subagentType` drop.

**Files:**
- Modify: `src/core/providers.ts` (SAFE_FIELDS `reason`, grok branch, module doc comment)
- Test: `test/providers.test.ts`
- Consumes: `test/fixtures/grok/*.json` from Task 1 (transcribed inline)

**Interfaces:**
- Produces: `decodeNativeHook("grok", payload, now)` mapping per the spec's decoder table. Task 6's hook file feeds it.

- [ ] **Step 1: Write the failing tests**

In `test/providers.test.ts`, widen the helper's provider literal (:7-10) to include `"grok"`:

```ts
const decode = (
  value: unknown,
  provider: "claude" | "codex" | "kimi" | "pi" | "omp" | "zcode" | "deepseek" | "grok" = "claude",
): RegistryEvent[] => decodeNativeHook(provider, value, NOW);
```

Add a `describe("grok native envelopes", ...)` block. Transcribe the Task 1 fixtures into inline literals verbatim (key casing and all); the cases below use trimmed forms for brevity — use the full captured objects:

```ts
describe("grok native envelopes", () => {
  const grok = (value: unknown): RegistryEvent[] => decode(value, "grok");

  test("session_start decodes with project basename and model passthrough", () => {
    // fixture: session-start.json — assert model only if the capture carries it;
    // otherwise assert model: null and note the resolver backfills it.
    expect(
      grok({
        hookEventName: "session_start",
        sessionId: "01a00c8e-d275-75b1-bc98-6bf70e28fcdb",
        cwd: "/Users/you/project",
        workspaceRoot: "/Users/you/project",
        permissionMode: "default",
        timestamp: "2026-08-16T12:00:00Z",
      }),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "grok",
        sessionId: "01a00c8e-d275-75b1-bc98-6bf70e28fcdb",
        title: null,
        project: "project",
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        observedAt: NOW,
      },
    ]);
  });

  test("user_prompt_submit late-joins with SessionObserved + Activity", () => {
    const events = grok({
      hookEventName: "user_prompt_submit",
      sessionId: "g1",
      cwd: "/Users/you/project",
      promptId: "turn-1",
      timestamp: "2026-08-16T12:01:00Z",
    });
    expect(events.map((event) => event.kind)).toEqual(["SessionObserved", "Activity"]);
  });

  test("pre_tool_use and post_tool_use map to Activity", () => {
    for (const hookEventName of ["pre_tool_use", "post_tool_use"]) {
      expect(
        grok({ hookEventName, sessionId: "g1", toolName: "run_terminal_command", toolInput: { command: "ls" } }),
      ).toEqual([{ kind: "Activity", provider: "grok", sessionId: "g1", observedAt: NOW }]);
    }
  });

  test("stop settles only on a genuine turn end", () => {
    expect(grok({ hookEventName: "stop", sessionId: "g1", reason: "end_turn" })).toEqual([
      { kind: "Stop", provider: "grok", sessionId: "g1", observedAt: NOW },
    ]);
    expect(grok({ hookEventName: "stop", sessionId: "g1" })).toEqual([
      { kind: "Stop", provider: "grok", sessionId: "g1", observedAt: NOW },
    ]);
    // Session-teardown observe fires are dropped; SessionEnd owns removal.
    expect(grok({ hookEventName: "stop", sessionId: "g1", reason: "channel_closed" })).toEqual([]);
    expect(grok({ hookEventName: "stop", sessionId: "g1", reason: "shutdown" })).toEqual([]);
  });

  test("stop_cancelled settles idle like Kimi's Interrupt", () => {
    expect(
      grok({ hookEventName: "stop_cancelled", sessionId: "g1", reason: "user_interrupt", cancelledBy: "user" }),
    ).toEqual([{ kind: "Stop", provider: "grok", sessionId: "g1", observedAt: NOW }]);
  });

  test("stop_failure maps to StopFailure", () => {
    expect(grok({ hookEventName: "stop_failure", sessionId: "g1", error: "rate_limit" })).toEqual([
      { kind: "StopFailure", provider: "grok", sessionId: "g1", observedAt: NOW },
    ]);
  });

  test("notification maps only permission_prompt to Attention", () => {
    expect(grok({ hookEventName: "notification", sessionId: "g1", notificationType: "permission_prompt" })).toEqual([
      { kind: "Attention", provider: "grok", sessionId: "g1", observedAt: NOW },
    ]);
    expect(grok({ hookEventName: "notification", sessionId: "g1", notificationType: "idle_prompt" })).toEqual([]);
    expect(grok({ hookEventName: "notification", sessionId: "g1", notificationType: "task_complete" })).toEqual([]);
  });

  test("session_end maps to SessionEnd", () => {
    expect(grok({ hookEventName: "session_end", sessionId: "g1", reason: "quit" })).toEqual([
      { kind: "SessionEnd", provider: "grok", sessionId: "g1", observedAt: NOW },
    ]);
  });

  test("any event carrying subagentType is dropped", () => {
    for (const hookEventName of ["user_prompt_submit", "pre_tool_use", "stop", "session_end"]) {
      expect(grok({ hookEventName, sessionId: "g1-child", subagentType: "explore" })).toEqual([]);
    }
  });

  test("unregistered grok events and non-grok casings decode to zero events", () => {
    expect(grok({ hookEventName: "pre_compact", sessionId: "g1" })).toEqual([]);
    expect(grok({ hookEventName: "post_tool_use_failure", sessionId: "g1" })).toEqual([]);
    expect(grok({ hookEventName: "sessionStart", sessionId: "g1" })).toEqual([]); // Cursor-style casing is config-side only
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/providers.test.ts`
Expected: FAIL — every grok case returns `[]` today (event values unrecognized).

- [ ] **Step 3: Implement the grok branch**

In `src/core/providers.ts`:

1. Add to `SAFE_FIELDS` (after `isInterrupt`):
   ```ts
     reason: ["reason"],
   ```
2. Add the event-name table above `decodeNativeHook`:
   ```ts
   /**
    * Grok's native envelope uses camelCase keys (allowlisted as aliases above)
    * with snake_case event values; this maps the values grok emits to the
    * canonical names the switch handles. `stop_cancelled` rides the Interrupt
    * case: an interrupted turn settles idle either way. `post_tool_use_failure`
    * is deliberately unmapped — a failed grok tool call is not a turn event.
    */
   const GROK_EVENT_NAMES: Readonly<Record<string, string>> = {
     session_start: "SessionStart",
     user_prompt_submit: "UserPromptSubmit",
     pre_tool_use: "PreToolUse",
     post_tool_use: "PostToolUse",
     stop: "Stop",
     stop_failure: "StopFailure",
     stop_cancelled: "Interrupt",
     notification: "Notification",
     session_end: "SessionEnd",
   };
   ```
3. In `decodeNativeHook`, the code currently reads `switch (hookEventName) {` (after the `hookEventName` and `sessionId` extractions). Replace that one line with the following block (which ends by opening the same switch on the renamed value):

   ```ts
     let hookName = hookEventName;
     if (provider === "grok") {
       // grok-native subagent sessions never fire SessionStart, so they never
       // register; every event from inside one carries subagentType, and
       // dropping it keeps a subagent's user_prompt_submit from late-joining a
       // phantom top-level row.
       if ("subagentType" in value) {
         return [];
       }
       const mapped = GROK_EVENT_NAMES[hookEventName];
       if (mapped === undefined) {
         return [];
       }
       // grok fires an observe-only Stop at session teardown; SessionEnd owns
       // the row's removal, so only genuine turn ends settle the tile.
       if (hookEventName === "stop") {
         const reason = firstAllowlistedString(value, SAFE_FIELDS.reason);
         if (reason !== undefined && reason !== "end_turn") {
           return [];
         }
       }
       hookName = mapped;
     }
     switch (hookName) {
   ```
4. Update the module doc comment (:1-24): "the seven canonical providers" → "the eight canonical providers", append grok to the enumeration, and add one sentence: "Grok's native payloads are camelCase-keyed with snake_case event values; a small value-mapping branch (plus its stop-reason and subagentType filters) is its only special case."

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test test/providers.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/providers.ts test/providers.test.ts
git commit -m "feat(providers): decode grok native hook envelopes"
```

---

### Task 5: Titles/models resolver + daemon wiring

**Files:**
- Modify: `src/core/titles.ts` (deps, grok branch, module doc comment)
- Modify: `src/core/cli.ts:408-421` (`GROK_HOME` wiring in `runDaemon`)
- Test: `test/titles.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 2-4 beyond the `Provider` type (already widened).
- Produces: `SessionFactsResolverDependencies.grokSessionsRoot: string` (new required key — the only constructors are `cli.ts` and the test helper) and optional `listDirectories?: (path: string) => string[]`.

- [ ] **Step 1: Write the failing tests**

In `test/titles.test.ts`, extend `makeResolver` (:20-63): add `grokSessionsRoot?: string` and `lists?: Record<string, string[]>` to the seed, extend `FakeFs` with `lists: Map<string, string[]>`, and pass:

```ts
    grokSessionsRoot: seed?.grokSessionsRoot ?? "/nonexistent/grok/sessions",
    listDirectories: (path) => lists.get(path) ?? [],
```

(with `const lists = new Map(Object.entries(seed?.lists ?? {}));` beside the other maps, and `lists` exposed on the returned `fs`.)

Also fix the one other direct `createSessionFactsResolver({...})` construction outside `makeResolver` (`test/titles.test.ts:529`) to pass `grokSessionsRoot: "/nonexistent/grok/sessions"`.

Add the describe block:

```ts
describe("grok summary.json facts", () => {
  const GROK_ROOT = "/fake/grok/sessions";
  const GROK_ID = "01a00c8e-d275-75b1-bc98-6bf70e28fcdb";
  const GROK_SUMMARY = `${GROK_ROOT}/%2FUsers%2Fyou%2Fproject/${GROK_ID}/summary.json`;

  const grokTarget = (overrides: Partial<TitleTarget> = {}): TitleTarget => ({
    provider: "grok",
    sessionId: GROK_ID,
    title: null,
    model: null,
    transcriptPath: null,
    ...overrides,
  });

  const grokSeed = (summary: string) => ({
    grokSessionsRoot: GROK_ROOT,
    lists: { [GROK_ROOT]: ["%2FUsers%2Fyou%2Fproject"] },
    stats: { [GROK_SUMMARY]: { mtimeMs: 100, size: summary.length } },
    wholes: { [GROK_SUMMARY]: summary },
  });

  test("resolves title and model from summary.json found by group glob", () => {
    const { resolver } = makeResolver(
      grokSeed(
        JSON.stringify({
          info: { id: GROK_ID, cwd: "/Users/you/project" },
          session_summary: "Fallback title",
          generated_title: "Pi/OMP Ghostty Activation Spec Review",
          current_model_id: "grok-4.6",
        }),
      ),
    );
    expect(resolver.resolve([grokTarget()])).toEqual({
      titles: [{ provider: "grok", sessionId: GROK_ID, title: "Pi/OMP Ghostty Activation Spec Review" }],
      models: [{ provider: "grok", sessionId: GROK_ID, model: "grok-4.6" }],
    });
  });

  test("falls back to session_summary when generated_title is absent or empty", () => {
    const { resolver } = makeResolver(
      grokSeed(JSON.stringify({ session_summary: "Fallback title", generated_title: "", current_model_id: "grok-4.6" })),
    );
    expect(resolver.resolve([grokTarget()]).titles).toEqual([
      { provider: "grok", sessionId: GROK_ID, title: "Fallback title" },
    ]);
  });

  test("proposes nothing when the stored values already match", () => {
    const { resolver } = makeResolver(
      grokSeed(JSON.stringify({ generated_title: "Same", current_model_id: "grok-4.6" })),
    );
    expect(resolver.resolve([grokTarget({ title: "Same", model: "grok-4.6" })])).toEqual({ titles: [], models: [] });
  });

  test("caches on (mtime, size): an unchanged summary costs one stat, no re-read", () => {
    const { resolver, fs } = makeResolver(
      grokSeed(JSON.stringify({ generated_title: "T", current_model_id: "grok-4.6" })),
    );
    resolver.resolve([grokTarget()]);
    const readsAfterFirst = fs.wholeReads();
    resolver.resolve([grokTarget()]);
    expect(fs.wholeReads()).toBe(readsAfterFirst);
  });

  test("re-reads when the stat identity changes", () => {
    const seed = grokSeed(JSON.stringify({ generated_title: "Before", current_model_id: "grok-4.6" }));
    const { resolver, fs } = makeResolver(seed);
    expect(resolver.resolve([grokTarget()]).titles[0]?.title).toBe("Before");
    fs.wholes.set(GROK_SUMMARY, JSON.stringify({ generated_title: "After", current_model_id: "grok-4.7" }));
    fs.stats.set(GROK_SUMMARY, { mtimeMs: 200, size: 60 });
    expect(resolver.resolve([grokTarget()])).toEqual({
      titles: [{ provider: "grok", sessionId: GROK_ID, title: "After" }],
      models: [{ provider: "grok", sessionId: GROK_ID, model: "grok-4.7" }],
    });
  });

  test("a missing session, missing summary, or malformed JSON resolves nothing and never throws", () => {
    expect(makeResolver().resolver.resolve([grokTarget()])).toEqual({ titles: [], models: [] });
    const emptyGroup = makeResolver({ grokSessionsRoot: GROK_ROOT, lists: { [GROK_ROOT]: [] } });
    expect(emptyGroup.resolver.resolve([grokTarget()])).toEqual({ titles: [], models: [] });
    const malformed = makeResolver({
      ...grokSeed("not json"),
      wholes: { [GROK_SUMMARY]: "not json" },
    });
    expect(malformed.resolver.resolve([grokTarget()])).toEqual({ titles: [], models: [] });
  });

  test("a summary without facts proposes nothing (never clears)", () => {
    const { resolver } = makeResolver(grokSeed(JSON.stringify({ info: { id: GROK_ID } })));
    expect(resolver.resolve([grokTarget()])).toEqual({ titles: [], models: [] });
  });

  test("bounds a stored title to exactly 256 code points, cutting at an astral boundary", () => {
    const longTitle = `${"🔧".repeat(120)}${"y".repeat(125)}${"🛠".repeat(20)}`;
    const expected = Array.from(longTitle).slice(0, 256).join("");
    const { resolver } = makeResolver(grokSeed(JSON.stringify({ generated_title: longTitle })));
    const title = resolver.resolve([grokTarget()]).titles[0]?.title ?? "";
    expect(Array.from(title)).toHaveLength(256);
    expect(title).toBe(expected);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/titles.test.ts`
Expected: FAIL — `createSessionFactsResolver` has no `grokSessionsRoot` key (type error) and grok targets resolve nothing.

- [ ] **Step 3: Implement the resolver branch**

In `src/core/titles.ts`:

1. Imports: add `readdirSync` to the `node:fs` list and add `import { join } from "node:path";`.
2. Deps type (:51-59) — add:
   ```ts
     /** grok's sessions directory; resolved by the caller (GROK_HOME override lives in cli.ts). */
     grokSessionsRoot: string;
   ```
   and after `readHead?`:
   ```ts
     listDirectories?: (path: string) => string[];
   ```
3. Default beside the other fs defaults:
   ```ts
   const defaultListDirectories = (path: string): string[] => {
     try {
       return readdirSync(path);
     } catch {
       return [];
     }
   };
   ```
4. Summary parser beside `ompTitleFromHead`:
   ```ts
   /**
    * grok keeps per-session metadata at sessions/<group>/<id>/summary.json.
    * The generated title is the user-visible one (also what /resume shows);
    * session_summary is the fallback. current_model_id is the live model.
    */
   const grokFactsFromSummary = (content: string): { title: string | null; model: string | null } => {
     try {
       const parsed: unknown = JSON.parse(content);
       if (!isRecord(parsed)) {
         return { title: null, model: null };
       }
       const generated = parsed["generated_title"];
       const summary = parsed["session_summary"];
       const model = parsed["current_model_id"];
       const title =
         typeof generated === "string" && generated.length > 0
           ? generated
           : typeof summary === "string" && summary.length > 0
             ? summary
             : null;
       return {
         title: title === null ? null : boundTitle(title),
         model: typeof model === "string" && model.length > 0 ? model : null,
       };
     } catch {
       return { title: null, model: null };
     }
   };
   ```
5. Inside `createSessionFactsResolver`: bind `const listDirectories = dependencies.listDirectories ?? defaultListDirectories;` with the other dep binds, add the caches beside the others:
   ```ts
     const grokCache = new Map<string, FileStat & { title: string | null; model: string | null }>();
     const grokSummaryPaths = new Map<string, string>();
   ```
   and the readers beside `ompTitle`:
   ```ts
   /**
    * Locate sessions/<group>/<sessionId>/summary.json by scanning group dirs.
    * The group name is the URL-encoded cwd with a slug+hash fallback past 255
    * bytes, so it is never reconstructed — only globbed. A found path is
    * remembered; an unfound session re-scans next pass (the scan is one
    * readdir plus one stat per group, and grok rows are few).
    */
   const grokSummaryPath = (sessionId: string): string | null => {
     const known = grokSummaryPaths.get(sessionId);
     if (known !== undefined) {
       return known;
     }
     for (const group of listDirectories(dependencies.grokSessionsRoot)) {
       const candidate = join(dependencies.grokSessionsRoot, group, sessionId, "summary.json");
       if (statPath(candidate) !== null) {
         grokSummaryPaths.set(sessionId, candidate);
         return candidate;
       }
     }
     return null;
   };

   const grokFacts = (sessionId: string): { title: string | null; model: string | null } => {
     const path = grokSummaryPath(sessionId);
     if (path === null) {
       return { title: null, model: null };
     }
     const stat = statPath(path);
     if (stat === null) {
       return { title: null, model: null };
     }
     const cached = grokCache.get(path);
     if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
       return { title: cached.title, model: cached.model };
     }
     const content = readWhole(path);
     const facts = content === null ? { title: null, model: null } : grokFactsFromSummary(content);
     grokCache.set(path, { ...stat, ...facts });
     return facts;
   };
   ```
6. Resolve branch in the target loop, after the zcode branch:
   ```ts
         } else if (target.provider === "grok") {
           const facts = grokFacts(target.sessionId);
           resolvedTitle = facts.title;
           resolvedModel = facts.model;
         }
   ```
7. Module doc comment (:1-37): add a grok bullet — "- grok: `summary.json` under the session's directory (found by globbing the sessions root), carrying `generated_title` (fallback `session_summary`) and `current_model_id`, (mtime, size)-cached like the other file readers." — and adjust the intro line that says which providers push vs pull.

In `src/core/cli.ts` `runDaemon` (:408-414), add the root and wire it:

```ts
    const grokRoot = environment["GROK_HOME"] ?? join(daemonPaths.home, ".grok");
    const resolveFacts = createSessionFactsResolver({
      codexIndexPath: join(daemonPaths.home, ".codex/session_index.jsonl"),
      zcodeDatabasePath: join(zcodeRoot, "cli/db/db.sqlite"),
      grokSessionsRoot: join(grokRoot, "sessions"),
    }).resolve;
```

- [ ] **Step 4: Run tests and the full gate**

Run: `bun test test/titles.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/titles.ts src/core/cli.ts test/titles.test.ts
git commit -m "feat(titles): resolve grok titles and models from summary.json"
```

---

### Task 6: Installer-managed grok hook file

**Files:**
- Create: `extensions/grok/stream-deck-agents.hook.json`
- Modify: `scripts/install-local.ts` (new managed-artifact step, final message)

**Interfaces:**
- Produces: `~/.grok/hooks/stream-deck-agents.json` at install time, command `<paths.executable> event grok` per event. Feeds Task 4's decoder.

No unit harness exists for `install-local.ts` (the shims are covered by shim-harness tests, not installer tests) — this step is verified live in Task 8, matching how the shim install step is covered.

- [ ] **Step 1: Write the template**

`extensions/grok/stream-deck-agents.hook.json`:

```json
{
  "x-stream-deck-agents": "managed hook v1",
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "\"__STREAM_DECK_AGENTS_EXECUTABLE__\" event grok", "timeout": 5 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "\"__STREAM_DECK_AGENTS_EXECUTABLE__\" event grok", "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "\"__STREAM_DECK_AGENTS_EXECUTABLE__\" event grok", "timeout": 5 }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "\"__STREAM_DECK_AGENTS_EXECUTABLE__\" event grok", "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "\"__STREAM_DECK_AGENTS_EXECUTABLE__\" event grok", "timeout": 5 }] }
    ],
    "StopFailure": [
      { "hooks": [{ "type": "command", "command": "\"__STREAM_DECK_AGENTS_EXECUTABLE__\" event grok", "timeout": 5 }] }
    ],
    "StopCancelled": [
      { "hooks": [{ "type": "command", "command": "\"__STREAM_DECK_AGENTS_EXECUTABLE__\" event grok", "timeout": 5 }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "\"__STREAM_DECK_AGENTS_EXECUTABLE__\" event grok", "timeout": 5 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "\"__STREAM_DECK_AGENTS_EXECUTABLE__\" event grok", "timeout": 5 }] }
    ]
  }
}
```

The quoted executable token keeps a space-bearing install path safe under the shell grok runs commands with. Validate it parses: `bun -e "console.log(JSON.parse(require('fs').readFileSync('extensions/grok/stream-deck-agents.hook.json','utf8')).hooks.SessionStart.length)"` → prints `1`.

- [ ] **Step 2: Add the install step**

In `scripts/install-local.ts`, after the shim constants (:65-71):

```ts
const GROK_HOOK_MARKER = "x-stream-deck-agents";
const GROK_HOOK_TEMPLATE = join("extensions", "grok", "stream-deck-agents.hook.json");
const GROK_HOOK_NAME = "stream-deck-agents.json";
const GROK_HOOK_MODE = 0o600;
```

After `installShims`:

```ts
/**
 * Install the managed grok hook file into ~/.grok/hooks when the grok home
 * exists. Same rules as the shims: skip when the provider dir is absent,
 * refuse to overwrite a same-named file without the managed marker (user
 * content), atomic temp + rename, token substituted at copy time.
 */
const installGrokHook = (paths: AppPaths): void => {
  const grokRoot = join(paths.home, ".grok");
  const hooksDir = join(grokRoot, "hooks");
  const destination = join(hooksDir, GROK_HOOK_NAME);
  if (!existsSync(grokRoot)) {
    process.stdout.write(`install-local: skipping grok hook (${grokRoot} does not exist)\n`);
    return;
  }
  const source = readFileSync(join(repositoryRoot, GROK_HOOK_TEMPLATE), "utf8");
  if (!source.includes(GROK_HOOK_MARKER) || !source.includes(EXECUTABLE_TOKEN)) {
    fail("grok-hook", `${GROK_HOOK_TEMPLATE} is missing its marker or token`);
  }
  const rendered = source.split(EXECUTABLE_TOKEN).join(paths.executable);
  if (existsSync(destination)) {
    const installed = readFileSync(destination, "utf8");
    if (!installed.includes(GROK_HOOK_MARKER)) {
      process.stdout.write(`install-local: NOT overwriting ${destination} — no managed marker (user content)\n`);
      return;
    }
    if (installed === rendered) {
      return;
    }
  }
  mkdirSync(hooksDir, { recursive: true });
  const temp = join(hooksDir, `.${GROK_HOOK_NAME}.tmp-${process.pid}`);
  writeFileSync(temp, rendered, { mode: GROK_HOOK_MODE });
  renameSync(temp, destination);
  process.stdout.write(`install-local: installed grok hook → ${destination}\n`);
};
```

Call it in the main sequence right after `installShims(paths);` (:294), with the step comment renumbered/extended:

```ts
  // 11. Install the managed shims and the grok hook file last — managed
  // artifacts must never activate before the compatible daemon and plugin
  // are live.
  installShims(paths);
  installGrokHook(paths);
```

Update the final report text (:308-310) — replace:

```ts
      "Managed pi/omp shims were installed where their extension dirs exist (see",
      "above). Claude, Kimi, and Codex hooks are NOT installed — follow",
```

with:

```ts
      "Managed pi/omp shims and the grok hook file were installed where their",
      "provider dirs exist (see above). Claude, Kimi, and Codex hooks are NOT",
      "installed — follow",
```

(adjust the following lines so the sentence still reads correctly: the remaining line is `"docs/hook-configuration.md to add them manually as the final setup step."`.)

- [ ] **Step 3: Lint and build**

Run: `bun run lint && bun run build`
Expected: clean. (Biome may reformat the JSON template — accept its formatting; the token and marker survive as string content. If Biome's formatter would break the file, the check fails visibly here.)

- [ ] **Step 4: Commit**

```bash
git add extensions/grok/stream-deck-agents.hook.json scripts/install-local.ts
git commit -m "feat(install): manage the grok hook file like the pi/omp shims"
```

---

### Task 7: Docs (design.md, hook-configuration.md, AGENTS.md)

**Files:**
- Modify: `docs/design.md:63-64`
- Modify: `docs/hook-configuration.md` (new grok section + prune-lease text)
- Modify: `AGENTS.md` (Conventions bullets)

- [ ] **Step 1: `docs/design.md`**

In the chip bullet (:63), replace:

```text
gold `#EAB308` Z for zcode, and teal `#2DD4BF` D for deepseek.
```

with:

```text
gold `#EAB308` Z for zcode, teal `#2DD4BF` D for deepseek, and pink `#F472B6` G for grok.
```

In the model-label bullet (:64), replace:

```text
omp, zcode, and deepseek have no model source — their tiles show the chip alone.
```

with:

```text
The daemon resolves grok's model (and title) from the session's `summary.json`. omp, zcode, and deepseek have no model source — their tiles show the chip alone.
```

In the title bullet (:66), append after the Codex titles clause:

```text
Grok titles come from the same `summary.json` pull.
```

Also update the schema-version parenthetical in the membership paragraph (:96): "the current schema is v9" → "the current schema is v10 (v10 widens the provider CHECK for grok)".

- [ ] **Step 2: `docs/hook-configuration.md`**

Add a grok section following the established per-provider ritual (backup / what gets installed / behavior notes / restore). Content:

- **What**: the installer manages `~/.grok/hooks/stream-deck-agents.json` (marker `"x-stream-deck-agents": "managed hook v1"`); it is NOT a manual edit like Claude/Kimi/Codex/zcode. To remove: delete the file. The installer refuses to overwrite a same-named file without the marker.
- **Events**: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, StopFailure, StopCancelled, Notification, SessionEnd — all observe-only, `timeout: 5`, command `<installed-binary> event grok`.
- **Payload notes**: grok's stdin envelope is camelCase with snake_case `hookEventName` values; the daemon maps them to canonical events. Session-teardown `Stop` (`reason` `channel_closed`/`shutdown`) is ignored — `SessionEnd` owns removal. Events carrying `subagentType` are ignored (grok-native subagents are invisible in v1). Only `notificationType === "permission_prompt"` raises attention; `idle_prompt` is deliberately unmapped.
- **Compat scanning note**: grok also loads `~/.claude/settings.json` hooks by default, so our Claude hook commands also spawn under grok sessions — with a camelCase payload that fails the claude decode and exits 0. Harmless; leave compat scanning on.
- **Titles/models**: pulled by the daemon from `~/.grok/sessions/*/<id>/summary.json` (`generated_title`, `current_model_id`); `GROK_HOME` is honored.
- Update the after-every-provider prune/lease text (:906-921) to state grok has a real `SessionEnd` and uses the standard 24h prune lease (no special TTL like zcode's).

- [ ] **Step 3: `AGENTS.md`**

In the Conventions section:

1. Chip bullet: append to the letters list "grok G" and to the colors list "grok `#F472B6`". In the model-id sentence, extend the daemon-resolution clause to include grok: replace "and the daemon resolves Claude/Codex ids in the same maintenance pass as titles" with "and the daemon resolves Claude/Codex ids (transcript tails) and grok's id (summary.json) in the same maintenance pass as titles".
2. Status-model bullet: append — "grok fires `StopCancelled` for interrupted/declined turns (mapped to `Stop`, i.e. idle), real `StopFailure` (tiles can show `error`), and `permission_prompt` Notifications (tiles can show `waiting`); grok has no background tracking, no subagent rows (its `subagentType` payloads are dropped), and no `SessionTitleChanged` push (titles are pulled). A grok `Stop` with a non-`end_turn` reason is the session-teardown observe fire and is dropped — `SessionEnd` owns removal."
3. Lifecycle bullet: grok uses the standard 24h prune (it has a real `SessionEnd`); no special lease.
4. Shim bullet: extend to managed artifacts — append "the grok hook file `~/.grok/hooks/stream-deck-agents.json` is managed the same way (marker key `x-stream-deck-agents`, token substitution, atomic 0600 write, refusal without the marker)".
5. Titles bullet: append "grok titles and models come from `summary.json` under the session directory (globbed per target, (mtime,size)-cached, `GROK_HOME` override)".
6. Schema sentence: update "the current latest, v9, adds the `acked_at` watermark" to "the current latest, v10, widens the provider CHECK for grok (v9 added the `acked_at` watermark)".

- [ ] **Step 4: Verify docs render and commit**

Run: `bun run lint` (Biome checks the root JSON/Markdown-adjacent files it owns; AGENTS.md/design.md are prose — this just confirms nothing else broke)
Then:

```bash
git add docs/design.md docs/hook-configuration.md AGENTS.md
git commit -m "docs: grok provider (hook configuration, tile contract, conventions)"
```

---

### Task 8: Deploy + live acceptance

**Files:**
- Modify: `com.drewritter.stream-deck-agents.sdPlugin/manifest.json` (`Version` bump — patch bump, e.g. read current and +0.0.1)
- Create: `docs/verification/<today>-grok-acceptance.md` (use `date +%F`)

- [ ] **Step 1: Full gate**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 2: Bump the plugin version and deploy**

Edit `manifest.json` `Version` (patch bump), then:

```bash
bun scripts/install-local.ts
```

Expected: installer completes; its output includes `installed grok hook → ~/.grok/hooks/stream-deck-agents.json` (or the skip note if `~/.grok` were absent — it is not, on this machine); the Stream Deck app confirms the plugin update (accept the dialog if it appears — the installer waits up to 120s).

- [ ] **Step 3: Verify the managed hook file**

```bash
python3 -m json.tool ~/.grok/hooks/stream-deck-agents.json | head -5
stat -f "%Lp" ~/.grok/hooks/stream-deck-agents.json
```

Expected: valid JSON carrying the `x-stream-deck-agents` marker key and the installed executable path (token substituted); mode `600`.

- [ ] **Step 4: TUI lifecycle probe**

Start an interactive `grok` session in any project, submit one prompt that uses a tool, let it settle, then `/quit`. On the deck (or via `sqlite3` against the registry / the snapshot file):

- tile appears with the G chip and project label on start; working on prompt; idle + unread on stop; gone after `/quit`.
- within one maintenance pass (~2s), the tile shows the grok title and the `4.6` model label.

If a permission prompt is easy to trigger (default permission mode + a gated tool), confirm `waiting`; otherwise replay a fixture: `dist/stream-deck-agents event grok < test/fixtures/grok/notification-permission-prompt.json` against a live-registered session id (start a real session first, edit the fixture's sessionId to match), and confirm the waiting frame. Same replay route for `stop-failure` → error. End the session afterwards (`SessionEnd` removes the row).

- [ ] **Step 5: Paseo dispatch probe**

Dispatch a small grok agent through Paseo (e.g. a one-question review). Confirm: hooks fire under Paseo's launch (tile appears at all), the origin pip stamps (filled disc, or hollow ring if dispatched as a subagent), attention mirrors both ways (view in Paseo clears unread on the deck; a result landing sets Paseo's attention), and pressing the tile opens the `paseo://` deep link. If hooks do NOT fire under Paseo's launch mode, stop and report to the user — per the spec's risk table that pauses launch for redesign, it does not ship silently.

- [ ] **Step 6: Write the acceptance record and commit**

`docs/verification/<today>-grok-acceptance.md`: install log lines, per-probe results (TUI lifecycle, waiting/error replay, title/model timing, Paseo origin + routing), any deviations from the spec found live (e.g. `/rename`'s storage field — check whether a rename rewrites `generated_title` in `summary.json` and record the answer). Then:

```bash
git add com.drewritter.stream-deck-agents.sdPlugin/manifest.json docs/verification/<today>-grok-acceptance.md
git commit -m "chore(grok): deploy and record live acceptance"
```

---

## Self-review notes (plan author)

- Spec coverage: ingest (Task 6 template + Task 4 decoder), resolver (Task 5), schema (Task 2), plugin surface (Task 3), installer (Task 6), tests (per task), docs (Task 7), live verification (Tasks 1 and 8). The spec's payload-capture gate is Task 1 and Task 4's fixtures consume it.
- Ordering constraint: Task 2 (schema) must land before or with Task 3 (protocol key) — the CHECK↔`PROVIDER_KEYS` lockstep test goes red if the key lands without the widened CHECK.
- Known spec deviation: the spec's testing section asks for installer unit tests "if a harness exists"; none does (`test/` has no install-local harness), so the hook-file step is verified live in Task 8 like the shim install step before it.
