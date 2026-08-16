# Four New Providers — P1 zcode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring zcode sessions onto the grid — config-only hooks documentation, a WAL-safe SQLite title resolver, and a 1-hour stale lease (zcode has no SessionEnd hook) — ending with live verification against the installed ZCode build.

**Architecture:** No shim code: zcode's native Claude-style command hooks POST stdin JSON to the existing helper (`event zcode`), and P0 already landed the decoder rules (`PostToolUseFailure` interrupt → `Stop`, transcript suppression) and registry/projection support. P1 adds the two zcode-specific core behaviors (title pull from `~/.zcode/cli/db/db.sqlite`, per-provider prune TTL) plus user-facing hook docs, then verifies live.

**Tech Stack:** Bun, `bun:sqlite`, `bun:test`, TypeScript strict, Biome. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-15-four-new-providers-design.md` (revision 3). Binding sections: §zcode (P1, config-only), §Docs, §Testing, §Physical verification, §Out of scope.
- Style: 2 spaces, double quotes, semicolons, 120 columns. Biome strict: `noExplicitAny`, `noConsole`, `noProcessEnv` (env enters via `src/core/cli.ts` DI only), `noDefaultExport`, `noNonNullAssertion` (relaxed in `test/**`), nursery `noFloatingPromises`.
- tsconfig strictness includes `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` (bracket access), `verbatimModuleSyntax`, `erasableSyntaxOnly`.
- No new dependencies.
- Privacy contract (landed in P0, binding): the decoder reads only `SAFE_FIELDS` keys plus the `is_interrupt` boolean; `PostToolUseFailure`'s `error` field is never read.
- Stage only the exact files each task lists; never `git add -A`.
- Gate after every task: `bun test` for the touched test file(s); gate at plan end: `bun run check`.
- Do NOT run `bun scripts/install-local.ts`, and do NOT edit `~/.zcode/cli/config.json`, except inside Task 4 (live verification), which runs with the user's explicit go-ahead.
- zcode's SQLite schema is research-derived (`session` table, `id`/`title` columns); Task 4's live probe pins it. Keep the table/column names in exactly one constant so a probe correction is a one-line change.
- Model allocation (standing, AGENTS.md): default implementer `pi/zai/glm-5.3` thinking high; reviewer always `codex/gpt-5.6-sol`; escalation to `claude/claude-fable-5` after a failed review or two NEEDS_CONTEXT.

---

### Task 1: zcode title resolver (WAL-safe, no stat cache)

**Files:**
- Modify: `src/core/titles.ts`
- Modify: `src/core/cli.ts:370-379` (runDaemon wiring)
- Test: `test/titles.test.ts`

**Interfaces:**
- Consumes: the existing `TitleResolverDependencies` / `createTitleResolver` shape; `TitleTarget` rows already carry `provider` and `sessionId` (registry.ts:446).
- Produces: `TitleResolverDependencies` gains a **required** `zcodeDatabasePath: string`. The resolver answers zcode titles from zcode's SQLite database: per-resolve pass, only when ≥1 zcode target exists, open the database read-only, `SELECT title FROM session WHERE id = ?` per live zcode row, close in `finally`. **No (mtime,size) cache** — zcode's database is WAL; committed titles can live in `db.sqlite-wal` without touching the main file's stat. Any error (missing file, `SQLITE_BUSY`, missing table) skips the zcode pass silently — titles retry on the next 2s cadence. Connection lifecycle is pinned: **per-pass open/close** (stateless; no held-handle recovery to get wrong).

- [ ] **Step 1: Write the failing tests**

In `test/titles.test.ts`, first extend the harness: `makeResolver`'s `createTitleResolver` call gains `zcodeDatabasePath: seed?.zcodeDatabasePath ?? "/nonexistent/zcode/db.sqlite"` (add the field to the seed type). Existing tests keep passing unchanged — none use zcode targets.

Then append this describe block (new imports needed: `mkdtempSync`, `rmSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, `Database` from `bun:sqlite`):

```ts
describe("zcode SQLite titles", () => {
  const ZCODE_TABLE_DDL =
    "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)";

  const withFixtureDb = (
    rows: readonly { id: string; title: string | null }[],
    run: (dbPath: string) => void,
  ): void => {
    const dir = mkdtempSync(join(tmpdir(), "stream-deck-agents-zcode-titles-"));
    try {
      const dbPath = join(dir, "db.sqlite");
      const setup = new Database(dbPath, { create: true, readwrite: true });
      try {
        setup.exec(ZCODE_TABLE_DDL);
        for (const row of rows) {
          setup.run("INSERT INTO session (id, title) VALUES (?, ?)", [row.id, row.title]);
        }
      } finally {
        setup.close();
      }
      run(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const zcodeTarget = (sessionId: string, title: string | null = null): TitleTarget => ({
    provider: "zcode",
    sessionId,
    title,
    transcriptPath: null,
  });

  test("resolves titles per live zcode row and bounds to 256 code points", () => {
    withFixtureDb(
      [
        { id: "z1", title: "Fix the widget renderer" },
        { id: "z2", title: null },
      ],
      (dbPath) => {
        const { resolver } = makeResolver({ zcodeDatabasePath: dbPath });
        expect(resolver.resolve([zcodeTarget("z1"), zcodeTarget("z2"), zcodeTarget("ghost")])).toEqual([
          { provider: "zcode", sessionId: "z1", title: "Fix the widget renderer" },
        ]);
      },
    );
  });

  test("proposes nothing when the stored title already matches", () => {
    withFixtureDb([{ id: "z1", title: "Same" }], (dbPath) => {
      const { resolver } = makeResolver({ zcodeDatabasePath: dbPath });
      expect(resolver.resolve([zcodeTarget("z1", "Same")])).toEqual([]);
    });
  });

  test("sees a WAL commit that has not checkpointed (no stat cache)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stream-deck-agents-zcode-titles-"));
    try {
      const dbPath = join(dir, "db.sqlite");
      const writer = new Database(dbPath, { create: true, readwrite: true });
      try {
        writer.exec("PRAGMA journal_mode = WAL");
        writer.exec(ZCODE_TABLE_DDL);
        writer.run("INSERT INTO session (id, title) VALUES ('z1', 'Initial')");
      } catch (error) {
        writer.close();
        throw error;
      }
      // The writer stays OPEN and nothing checkpoints: the title lives only
      // in db.sqlite-wal, and the main file's stat is unchanged. A resolver
      // caching on (mtime, size) would never see this write.
      const { resolver } = makeResolver({ zcodeDatabasePath: dbPath });
      try {
        expect(resolver.resolve([zcodeTarget("z1")])).toEqual([
          { provider: "zcode", sessionId: "z1", title: "Initial" },
        ]);
        writer.run("UPDATE session SET title = 'Renamed mid-stream' WHERE id = 'z1'");
        expect(resolver.resolve([zcodeTarget("z1")])).toEqual([
          { provider: "zcode", sessionId: "z1", title: "Renamed mid-stream" },
        ]);
      } finally {
        writer.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing database or an unexpected schema resolves nothing and never throws", () => {
    const missing = makeResolver();
    expect(missing.resolver.resolve([zcodeTarget("z1")])).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), "stream-deck-agents-zcode-titles-"));
    try {
      const dbPath = join(dir, "db.sqlite");
      const wrong = new Database(dbPath, { create: true, readwrite: true });
      wrong.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
      wrong.close();
      const { resolver } = makeResolver({ zcodeDatabasePath: dbPath });
      expect(resolver.resolve([zcodeTarget("z1")])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/titles.test.ts`
Expected: FAIL — the zcode tests resolve nothing (no zcode branch exists yet). (`bun run typecheck` would also fail on the unknown `zcodeDatabasePath` seed field; the behavioral RED is the gate here.)

- [ ] **Step 3: Implement the zcode resolver**

In `src/core/titles.ts`:

(a) Import and extend the dependency type:

```ts
import { Database } from "bun:sqlite";
```

```ts
export type TitleResolverDependencies = {
  codexIndexPath: string;
  /** zcode's SQLite store; resolved by the caller (ZCODE_HOME override lives in cli.ts). */
  zcodeDatabasePath: string;
  statPath?: (path: string) => FileStat | null;
  readTail?: (path: string, maxBytes: number) => string | null;
  readWhole?: (path: string) => string | null;
};
```

(b) Add the query constant (single source for the live-pinned schema names) and the per-pass reader, above `createTitleResolver`:

```ts
/**
 * zcode stores auto-generated titles in its own SQLite database. The schema
 * names are pinned by live verification (Task 4 of the P1 plan); if that
 * probe finds different names, this constant is the only change.
 */
const ZCODE_TITLE_QUERY = "SELECT title FROM session WHERE id = ?";

/**
 * Read zcode titles in one per-pass read-only connection. zcode's database is
 * WAL, so committed titles can live in db.sqlite-wal without touching the main
 * file's stat — the (mtime, size) caching Claude/Codex use would go stale
 * indefinitely here, so every pass re-queries (one indexed lookup per live
 * zcode row on the daemon's 2s cadence). Any failure — missing file,
 * SQLITE_BUSY from zcode's writer, unexpected schema — skips the pass; the
 * next cadence retries.
 */
const readZcodeTitles = (databasePath: string, sessionIds: readonly string[]): Map<string, string> => {
  const titles = new Map<string, string>();
  let db: Database | null = null;
  try {
    db = new Database(databasePath, { readonly: true, create: false });
    const statement = db.query(ZCODE_TITLE_QUERY);
    for (const sessionId of sessionIds) {
      const row = statement.get(sessionId) as { title: unknown } | null;
      if (row !== null && typeof row.title === "string" && row.title.length > 0) {
        titles.set(sessionId, boundTitle(row.title));
      }
    }
  } catch {
    return new Map();
  } finally {
    db?.close();
  }
  return titles;
};
```

(c) Wire it into `createTitleResolver`'s `resolve`, mirroring the lazy Codex pattern:

```ts
  return {
    resolve: (targets) => {
      const updates: SessionTitleUpdate[] = [];
      let codexById: Map<string, string> | null = null;
      let zcodeById: Map<string, string> | null = null;
      for (const target of targets) {
        let resolved: string | null = null;
        if (target.provider === "claude" && target.transcriptPath !== null) {
          resolved = claudeTitle(target.transcriptPath);
        } else if (target.provider === "codex") {
          codexById ??= codexTitles();
          resolved = codexById.get(target.sessionId) ?? null;
        } else if (target.provider === "zcode") {
          zcodeById ??= readZcodeTitles(
            dependencies.zcodeDatabasePath,
            targets.filter((candidate) => candidate.provider === "zcode").map((candidate) => candidate.sessionId),
          );
          resolved = zcodeById.get(target.sessionId) ?? null;
        }
        if (resolved !== null && resolved !== target.title) {
          updates.push({ provider: target.provider, sessionId: target.sessionId, title: resolved });
        }
      }
      return updates;
    },
  };
```

(d) Update the module docstring: the bullet list gains zcode ("zcode: `db.sqlite` under the zcode home, re-queried per pass — WAL makes stat caching unsafe").

(e) In `src/core/cli.ts`, resolve the zcode database path through the env-DI seam. Capture the environment once and use it in `runDaemon` (lines 366-379):

```ts
  environment: process.env,
  parentPid: process.ppid,
  runDaemon: (daemonPaths, diagnostics) => {
    const environment = process.env;
    const zcodeRoot = environment["ZCODE_HOME"] ?? join(daemonPaths.home, ".zcode");
    const resolveTitles = createTitleResolver({
      codexIndexPath: join(daemonPaths.home, ".codex/session_index.jsonl"),
      zcodeDatabasePath: join(zcodeRoot, "cli/db/db.sqlite"),
    }).resolve;
    const daemon = new ProjectionDaemon(daemonPaths, { diagnostics, resolveTitles });
    daemon.start();
    return new Promise<number>(() => {
      // launchd owns the daemon lifetime; the poll timer keeps the process alive.
    });
  },
```

(The `noProcessEnv` lint allows `process.env` in cli.ts only — it is the DI entry point. `environment: process.env` at line 368 stays as-is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/titles.test.ts && bun run typecheck`
Expected: PASS — including the WAL test; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/titles.ts src/core/cli.ts test/titles.test.ts
git commit -m "feat(titles): resolve zcode titles from its SQLite store"
```

---

### Task 2: zcode stale lease — 1 hour instead of 24

**Files:**
- Modify: `src/core/registry.ts:473-489` (`pruneStaleSessions`)
- Modify: `src/core/daemon.ts:45-46` (TTL constants), `src/core/daemon.ts:234-239` (prune pass)
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `pruneStaleSessions(db, cutoffIso, zcodeCutoffIso = cutoffIso)` — the third parameter defaults to the second, so the CLI's `sessions prune [hours]` call site (an explicit operator override) is unchanged and applies one cutoff to all providers. Daemon gains `ZCODE_STALE_SESSION_TTL_MS = 60 * 60 * 1000` and passes both cutoffs. Rationale (spec §zcode): zcode has no SessionEnd hook, so its rows can only die by lease — 24h of stale zcode tiles is dishonest.

- [ ] **Step 1: Write the failing tests**

Append to `test/registry.test.ts` inside the existing prune describe (find it via `pruneStaleSessions`; reuse its helpers `start`/`at` — check the exact local names first and mirror them). Use explicit ISO timestamps rather than `at()` offsets — the lease math needs hours, not seconds:

```ts
  test("zcode rows prune on the 1h lease while other providers keep the 24h one", () => {
    const T0 = "2026-08-06T00:00:00.000Z";
    const nowMs = Date.parse(T0) + 2 * 60 * 60 * 1000; // "now" is 2h after T0
    const thirtyMinutesAgo = new Date(nowMs - 30 * 60 * 1000).toISOString();

    applyRegistryEvents(db, [
      start("z-old", { provider: "zcode", at: T0 }), // 2h stale — past both leases
      start("c-old", { provider: "claude", at: T0 }), // 2h stale — inside the 24h lease
      start("z-fresh", { provider: "zcode", at: thirtyMinutesAgo }), // inside the 1h lease
    ]);

    const defaultCutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    const zcodeCutoff = new Date(nowMs - 60 * 60 * 1000).toISOString();

    expect(pruneStaleSessions(db, defaultCutoff, zcodeCutoff)).toBe(1);
    expect(listSessions(db).map((session) => session.sessionId)).toEqual(["c-old", "z-fresh"]);
  });

  test("a single cutoff applies to every provider (operator override shape)", () => {
    const T0 = "2026-08-06T00:00:00.000Z";
    applyRegistryEvents(db, [start("z-old", { provider: "zcode", at: T0 })]);

    const singleCutoff = new Date(Date.parse(T0) + 60 * 1000).toISOString(); // 1min after T0

    expect(pruneStaleSessions(db, singleCutoff)).toBe(1);
    expect(listSessions(db)).toEqual([]);
  });
```

(If the existing `start` helper lacks a `provider` option, add it the way the P0 registry tests did — check `start`'s signature in this file first. `listSessions` returns rows in slot order, which follows insertion order here.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/registry.test.ts`
Expected: FAIL — the first test prunes nothing (both old rows survive the single 24h cutoff), and the file may not yet typecheck if `start` lacks `provider`.

- [ ] **Step 3: Implement the per-provider lease**

In `src/core/registry.ts`, replace `pruneStaleSessions`:

```ts
/**
 * Remove every top-level row whose last hook predates its provider's cutoff,
 * cascading to children. zcode has no SessionEnd hook, so its rows lease out
 * on a shorter cutoff supplied by the caller; `zcodeCutoffIso` defaults to
 * `cutoffIso` so operator-driven single-cutoff prunes (`sessions prune`)
 * apply one age to every provider. `updated_at` holds an ISO-8601 UTC
 * timestamp, so the lexical comparison is chronological. Returns the number
 * of stale top-level rows (SQLite's own change count would also include
 * cascade-deleted children).
 */
export const pruneStaleSessions = (db: Database, cutoffIso: string, zcodeCutoffIso: string = cutoffIso): number =>
  inWriteTransaction(db, () => {
    const stale = db
      .query(
        `SELECT COUNT(*) AS n FROM active_sessions
         WHERE parent_session_id IS NULL AND (
           (provider = 'zcode' AND updated_at < ?) OR (provider != 'zcode' AND updated_at < ?)
         )`,
      )
      .get(zcodeCutoffIso, cutoffIso) as { n: number } | null;
    const count = stale?.n ?? 0;
    if (count > 0) {
      db.run(
        `DELETE FROM active_sessions
         WHERE parent_session_id IS NULL AND (
           (provider = 'zcode' AND updated_at < ?) OR (provider != 'zcode' AND updated_at < ?)
         )`,
        [zcodeCutoffIso, cutoffIso],
      );
    }
    return count;
  });
```

In `src/core/daemon.ts`, next to `STALE_SESSION_TTL_MS` (line 45-46):

```ts
/** A zcode session with no hook event for this long is presumed dead (zcode has no SessionEnd hook). */
export const ZCODE_STALE_SESSION_TTL_MS = 60 * 60 * 1000;
```

and in `maintain`'s prune branch (lines 234-239):

```ts
      if (this.state.lastPrunePassAtMs === null || nowMs - this.state.lastPrunePassAtMs >= DAEMON_PRUNE_INTERVAL_MS) {
        this.state.lastPrunePassAtMs = nowMs;
        const cutoff = new Date(nowMs - STALE_SESSION_TTL_MS).toISOString();
        const zcodeCutoff = new Date(nowMs - ZCODE_STALE_SESSION_TTL_MS).toISOString();
        if (pruneStaleSessions(this.connection, cutoff, zcodeCutoff) > 0) {
          changed = true;
        }
      }
```

Also update the `STALE_SESSION_TTL_MS` docblock if it claims to be the only TTL, and the module header's prune sentence to mention the zcode lease.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/registry.test.ts test/daemon.test.ts && bun run typecheck`
Expected: PASS; typecheck clean (the default parameter keeps `cli.ts` and existing call sites compiling unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/core/registry.ts src/core/daemon.ts test/registry.test.ts
git commit -m "feat(registry): prune zcode sessions on a 1h lease"
```

---

### Task 3: Docs — ZCode hook configuration + zcode conventions

**Files:**
- Modify: `docs/hook-configuration.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: Tasks 1-2 behavior (title source, lease); P0's decoder rules.
- Produces: the user-facing config ritual for zcode hooks; the ZCODE_HOME override documented; conventions current.

- [ ] **Step 1: Add the ZCode section to `docs/hook-configuration.md`**

Insert a `## ZCode` section between `## Codex Desktop`'s last subsection and the `## After all three providers` heading, following the existing per-provider ritual shape (1. Back up → 2. Edit → 3. Validate → 4. Compare before replace, and restore). Content requirements:

- **Back up:** `cp ~/.zcode/cli/config.json ~/.zcode/cli/config.json.bak` (create an empty `{}` first if the file doesn't exist).
- **Edit:** merge this exact shape into `~/.zcode/cli/config.json` (replace `<helper>` with the installed executable path, `~/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents`):

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart":      [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "UserPromptSubmit":  [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "PreToolUse":        [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "PostToolUse":       [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "PostToolUseFailure":[{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "PermissionRequest": [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "Stop":              [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }]
    }
  }
}
```

- Warnings, verbatim in spirit (these are the traps the research and review found):
  - The matcher-group wrapper (`events.<Event>` is a list of `{ "hooks": [...] }` objects, optionally with a `matcher`) is required — a flat executor list is silently ignored.
  - `timeoutMs` is **milliseconds**; `timeout` is **seconds** — never write `timeout`.
  - Hooks are snapshotted at session start: existing zcode sessions never pick the hooks up; start a new session to test.
  - Some 2026-06/07 builds reject the `args` array (validation bug). If zcode refuses to start or logs a config error, fall back to one shell string: `{ "type": "command", "command": "\"<helper>\" event zcode", "timeoutMs": 2000 }` — quote the path, it contains a space.
  - If hooks seem inert after a zcode update, re-check this file: older builds silently dropped the whole section on one unknown key.
- **Validate:** `bun -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' ~/.zcode/cli/config.json` (the repo's other sections use an equivalent JSON-parse check — match their exact command shape if it differs), then start a NEW zcode session and confirm the tile appears.
- **Compare/restore:** `diff ~/.zcode/cli/config.json.bak ~/.zcode/cli/config.json`; restore with `cp` back.
- One behavior-to-expect list: tile appears on session start; working on prompt/tool activity; waiting on permission prompts; idle when the turn ends; interrupt between tool calls maps to idle via `PostToolUseFailure`; **quitting zcode leaves the tile until the 1-hour lease prunes it** (zcode has no SessionEnd hook); titles arrive from zcode's own database a few seconds after zcode generates them.

- [ ] **Step 2: Privacy note + plural fixes in the same file**

- Where the doc describes what the helper reads (the privacy note near the top), add: `is_interrupt` is a third signal classified in place (boolean, never stored); `PostToolUseFailure`'s `error` payload is never read.
- Rename the `## After all three providers` heading to `## After every provider` and fix its intro sentence's count wording.
- The helper USAGE text is generated from the provider tuple (P0); if the doc quotes a hardcoded `claude|codex|kimi` usage line anywhere, update the quote to `claude|codex|kimi|pi|omp|zcode|deepseek`.

- [ ] **Step 3: AGENTS.md conventions**

In the Conventions section, add/adjust:
- The session-status bullet: zcode has no SessionEnd hook (rows age out via the daemon's 1h zcode lease — `ZCODE_STALE_SESSION_TTL_MS`), no StopFailure event (zcode tiles never go `error`), and no interrupt event except `PostToolUseFailure` with `is_interrupt: true` mapping to `Stop`; an interrupt between tool calls can leave a tile `working` until the next event or the lease.
- The titles bullet: zcode titles pull from `~/.zcode/cli/db/db.sqlite` (`ZCODE_HOME` override) via the resolver in `src/core/titles.ts` — re-queried per pass, never stat-cached (WAL).

- [ ] **Step 4: Verify statically and commit**

Run: `bun run typecheck && bun run lint` (docs are outside Biome's scope; this proves no accidental code drift) — then read both edited docs end-to-end for broken JSON or contradictions.

```bash
git add docs/hook-configuration.md AGENTS.md
git commit -m "docs: zcode hook configuration and conventions"
```

---

### Task 4: Live verification against the installed ZCode build (with the user)

**Files:**
- Create: `docs/verification/2026-08-16-zcode-p1.md` (dated record per convention; use the actual run date)

**Interfaces:**
- Consumes: everything above, deployed.
- Produces: the verification record; the ghost-filter decision; the pinned zcode SQLite schema names.

This task touches the user's live environment. **Controller amendment: the user gave blanket go-ahead for Task 4 on 2026-08-16** ("you don't need my approval for task4 or touching any configs") — edit `~/.zcode/cli/config.json`, run `bun scripts/install-local.ts`, and drive zcode sessions autonomously; record everything in the verification file.

- [ ] **Step 1: Pin the SQLite schema (prerequisite for titles)**

Open the user's `~/.zcode/cli/db/db.sqlite` read-only (`bun -e` with `bun:sqlite`, `readonly: true`) and inspect: `.tables` equivalent (`SELECT name FROM sqlite_master WHERE type='table'`), and the columns of the session table (`PRAGMA table_info(session)`). If the names differ from `session`/`id`/`title`, fix `ZCODE_TITLE_QUERY` in `src/core/titles.ts`, re-run `bun test test/titles.test.ts`, and commit that fix (`fix(titles): correct zcode schema names from live probe`) before continuing.

- [ ] **Step 2: Deploy and configure**

Run `bun scripts/install-local.ts` (daemon + plugin restart; DB already on v5 — assert the log line shows no migration error). Then apply the docs' ZCode section to the user's `~/.zcode/cli/config.json` (back up first, per the doc). If the installed build rejects the `args` form, fall back to the `command` form per the doc and record which form worked.

- [ ] **Step 3: Run the probes**

In a NEW zcode session (hooks are snapshotted at session start):

1. Session start → tile appears with the ZC chip.
2. Prompt → tile `working`; turn end → `idle`.
3. A permission-prompting action → tile `waiting`; after answering → `working`/`idle`.
4. Interrupt between tool calls → tile reaches `idle` (via `PostToolUseFailure`); if zcode delivers no failure event on interrupt, record the observed behavior (tile stays `working` until the next event or the lease) — that gap is accepted in v1 but must be recorded as observed, not assumed.
5. Title latency: after zcode auto-generates the session title, the tile picks it up within one title cadence (~2s plus zcode's own write latency).
6. Ghost probe: open a side chat (`/side` or `/btw`) and, if available, a headless/scheduled run; observe whether extra tiles appear. Decision required, recorded in the file: accept (lease covers it) or filter by a payload field (`source`/`agent_type`/`cwd`) — if filtering is needed, that's a follow-up fix task, not part of this file.
7. Quit zcode → the row remains but prunes on the 1h lease (verify by checking `sessions list`, or simulate by running `bun run dist... sessions prune` against a controlled timestamp — record the method used).

- [ ] **Step 4: Record and commit**

Write the dated verification file with: build/version of the installed zcode, which hook form worked, per-probe observed results, the ghost decision, the pinned schema names, and any divergences (each divergence gets a follow-up note in the file).

```bash
git add docs/verification/2026-08-16-zcode-p1.md
git commit -m "docs(verification): zcode P1 live probes"
```

---

## Self-review notes (controller)

- Spec coverage: §zcode config → Task 3; titles pull → Task 1; 1h lease → Task 2; ghost probe + live verification → Task 4; §Docs (zcode parts) → Task 3; §Testing (zcode resolver incl. WAL) → Task 1; §Out of scope items (no subagent rows, no background arming) respected — nothing here builds them.
- P0 already landed: decoder rules, registry event, projection, CLI args, chips, schema v5, installer ordering — P1 correctly contains none of them.
- Type consistency: `zcodeDatabasePath` (required dep), `ZCODE_TITLE_QUERY`, `ZCODE_STALE_SESSION_TTL_MS`, `pruneStaleSessions(db, cutoffIso, zcodeCutoffIso?)` are used identically across tasks.
