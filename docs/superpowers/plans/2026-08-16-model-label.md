# Model Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the session's model id on its Stream Deck tile, right of the provider chip (`[ K ] k3`), for providers with a real data source (Kimi push, Claude/Codex pull).

**Architecture:** Mirrors the existing title architecture exactly: Kimi pushes `model` in its SessionStart hook payload (decoder allowlist); the daemon's maintenance resolver tail-reads Claude transcripts and Codex rollouts for the last `"model":"..."` occurrence (last wins, so mid-session `/model` switches register). Storage is a nullable schema-v6 column; the snapshot parser treats a missing `model` key as null so plugin/daemon versions tolerate each other. Prefix stripping (`claude-fable-5` → `fable-5`) is a pure render-side rule; the registry stores the raw id.

**Tech Stack:** Bun + `bun:sqlite` (core), Node.js Stream Deck plugin (pure SVG string renderer), Biome, lefthook.

Spec: `docs/superpowers/specs/2026-08-16-model-label-design.md` (probe evidence for every data-source claim lives there — trust it, do not re-probe).

## Global Constraints

- Biome strict rules: `noExplicitAny`, `noConsole`, `noProcessEnv` (env enters via `src/core/cli.ts` DI only), `noNonNullAssertion` (relaxed in `test/**`), nursery `noFloatingPromises`. Style: 2 spaces, double quotes, semicolons, 120 columns.
- tsconfig full strictness set, including `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature` (use bracket access for index signatures).
- Privacy contract: the decoder reads only allowlisted payload fields; `model` becomes one of them. Every accepted string is bounded to 256 Unicode code points.
- Null-never-clears: an event or resolver pass with no model value must never erase a stored one (Kimi's UserPromptSubmit carries no `model` field).
- Resolver write-backs never touch `updated_at` — it is the prune lease.
- zcode gets NO model resolution (no data source — spec §Data availability). Do not add one.
- TDD: every task writes its failing test first, watches it fail, implements, watches it pass.
- Commit per task; stage exactly the files the task touched. Lefthook pre-commit runs Biome autofix + typecheck — a red typecheck blocks the commit, so each task must leave the tree green.
- Run tests with `bun test` (whole suite) or `bun test test/<file>` (focused). Typecheck: `bun run typecheck`.
- `docs/superpowers/` dated files are historical records; only the plan file itself may be amended (by the controller, not implementers).

---

### Task 1: Schema v6 — nullable `model` column

**Files:**
- Modify: `src/core/schema.ts`
- Test: `test/schema.test.ts`

**Interfaces:**
- Consumes: nothing (first task; deliberately sequenced before everything so later tasks' tests can insert real `model` values — P0's reorder lesson).
- Produces: `LATEST_SCHEMA_VERSION = 6`; live DBs gain `active_sessions.model TEXT NULL` on next `init`. No TS-visible API change — registry row types land in Task 3.

**Context:** `src/core/schema.ts` owns the registry schema. `LATEST_SCHEMA_VERSION` is currently 5; `MIGRATIONS` holds simple per-version SQL run in one transaction; v5's table rebuild is special-cased in `migrateToV5` (already applied to any v5 database, and part of the chain for older ones). v6 is a plain `ALTER TABLE ... ADD COLUMN`, same shape as v2–v4, so it joins `MIGRATIONS` — no rebuild, and it must run AFTER `migrateToV5` when migrating from ≤4 (the v5 rebuild's `CREATE TABLE` has no `model` column; the loop + `if (version < 5) migrateToV5(db)` ordering already handles this: v2–v4 ALTERs apply to the OLD table, the rebuild copies its explicit column list, then the v6 ALTER applies to the NEW table. Verify the loop runs the v6 migration after `migrateToV5` — it does NOT today: `migrateToV5` runs after the loop. The clean fix: keep the loop for versions 1–4, run `migrateToV5` if due, then apply v6 in a final step.)

- [ ] **Step 1: Write the failing tests**

In `test/schema.test.ts`, mirror the existing migration tests (they build a throwaway DB at a temp path, seed it at an older version, run `initializeDatabase`, assert). Read the file's existing v4→v5 test first and copy its fixture pattern exactly (including its temp-dir helper). Add:

```ts
test("migrates v5 to v6, preserving rows and adding a nullable model column", () => {
  // Seed at v5 with two rows carrying non-default values in every column
  // (copy the seeding pattern from the existing v4->v5 test), run
  // initializeDatabase, then assert:
  //   - PRAGMA user_version is 6
  //   - both rows survive with every pre-v6 value intact
  //   - model is NULL on both
  //   - PRAGMA table_info(active_sessions) contains model TEXT
});

test("openRegistryDatabase accepts v6 and rejects v5", () => {
  // openRegistryDatabase(path, "readonly") on the migrated DB succeeds.
  // A database left at v5 (seed one, skip initializeDatabase) throws
  // UnsupportedSchemaVersion.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/schema.test.ts`
Expected: FAIL — `user_version` comes back 5, not 6 (migration missing).

- [ ] **Step 3: Implement the migration**

In `src/core/schema.ts`:

```ts
export const LATEST_SCHEMA_VERSION = 6;
```

Add after `SCHEMA_VERSION_5`:

```ts
/**
 * v6 adds the nullable model column: the raw provider-reported model id
 * (Kimi hook push, Claude/Codex resolver pull), never user text. Plain ALTER,
 * same shape as v2-v4; no table rebuild.
 */
const SCHEMA_VERSION_6 = `
ALTER TABLE active_sessions
  ADD COLUMN model TEXT
  CHECK (model IS NULL OR length(model) BETWEEN 1 AND 256);
`;
```

Restructure the migration tail of `initializeDatabase` so the v6 ALTER applies after any v5 rebuild:

```ts
    if (version < LATEST_SCHEMA_VERSION) {
      const migrate = db.transaction(() => {
        for (const migration of MIGRATIONS) {
          if (migration.version > version && migration.version <= 4) {
            db.exec(migration.sql);
            db.exec(`PRAGMA user_version = ${migration.version}`);
          }
        }
      });
      migrate();
      if (version < 5) {
        migrateToV5(db);
      }
      if (readUserVersion(db) < 6) {
        db.exec(SCHEMA_VERSION_6);
        db.exec("PRAGMA user_version = 6");
      }
    }
```

Note the `migration.version <= 4` guard: `MIGRATIONS` stays versions 1–4 only, so v5's rebuild never runs through the loop (it manages its own transaction and cannot nest). Update the `MIGRATIONS` doc comment to say it covers versions 1–4 and that v5/v6 are applied by dedicated steps after it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/schema.test.ts && bun test test/registry.test.ts`
Expected: PASS — including the existing full-chain and busy-lock tests (the busy-lock test fails earlier at `journal_mode = WAL` and never reaches the migration path; that is its known, recorded behavior).

- [ ] **Step 5: Update version-pin tests**

Other tests pin version 5 (search: `grep -rn "user_version = 5\|LATEST_SCHEMA_VERSION, 5\|supports 5" test/`). Update each pin to 6 following its existing pattern. Also run the full suite: `bun test` — PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add src/core/schema.ts test/schema.test.ts <any version-pin test files touched>
git commit -m "feat(registry): schema v6 — nullable model column"
```

---

### Task 2: Protocol field, decoder allowlist, projection pass-through

**Files:**
- Modify: `src/protocol.ts`, `src/core/providers.ts`, `src/core/projection.ts`
- Modify (compile unblock, mechanical): `src/core/registry.ts:212-221` (the `applySessionObserved` synthesis only), plus every test fixture the typecheck flags
- Test: `test/protocol.test.ts`, `test/providers.test.ts`, `test/projection.test.ts`

**Interfaces:**
- Consumes: Task 1's `model` column (projection selects it).
- Produces (later tasks rely on these exact shapes):
  - `ProjectedSession` gains `model: string | null` (required — typecheck forces every producer to confront it; fixtures add `model: null`).
  - `SessionStart` / `SessionObserved` events gain `model: string | null` (required).
  - `parseSession` treats a MISSING `model` key as null (cross-version tolerance); a present non-string/non-null or >256-code-point value throws.
  - `ProjectionRow` gains `model: string | null`.

**Context:** `src/protocol.ts` is shared by the Bun core and the Node plugin — no runtime imports. `parseSession` (protocol.ts:125) validates each field by reading known keys only; unknown keys are ignored, which is what makes old-plugin/new-daemon tolerant. `src/core/providers.ts` `SAFE_FIELDS` (line 31) is the privacy allowlist. `src/core/projection.ts`: `PROJECTION_COLUMNS` (line 234), `toProjectionRow` (line 195, defensive validators — add `model` to the `isStringOrNull` bundle plus a ≤256-code-point check mirroring the `ghostty_terminal_id` one), `projectRows` (line 78, emits `ProjectedSession` from the root row at line 161-170).

- [ ] **Step 1: Write the failing tests**

`test/protocol.test.ts` (mirror existing parseSession tests):

```ts
test("parseSession defaults a missing model key to null", () => {
  // Build the minimal valid session object the existing tests use, with NO
  // model key; expect parseSessionSnapshot to succeed and the session's
  // model to be null.
});

test("parseSession accepts a bounded string model", () => {
  // model: "claude-fable-5" round-trips.
});

test("parseSession rejects an invalid model", () => {
  // model: 42 throws; model longer than 256 code points throws.
});
```

`test/providers.test.ts` (mirror existing decodeNativeHook tests):

```ts
test("decodes an allowlisted model field on SessionStart", () => {
  // Kimi-flavored payload: hook_event_name, session_id, session_title, cwd,
  // model: "k3" → the SessionStart event carries model: "k3".
});

test("a payload without a model field decodes model as null", () => {
  // Same shape minus model → model: null.
});
```

`test/projection.test.ts`: the existing tests drive `readProjection` against a real temp DB (writer/reader pattern — read the file's helpers first). Extend or add:

```ts
test("readProjection carries the stored model through to the snapshot", () => {
  // Insert a top-level row with model 'k3' via the file's writer helper
  // (or raw SQL if the helper predates the column), readProjection, expect
  // sessions[0].model === "k3". A row with NULL model projects null.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/protocol.test.ts test/providers.test.ts test/projection.test.ts`
Expected: FAIL — typecheck/runtime: `model` is not a known field (events/parsers/projection unaware).

- [ ] **Step 3: Implement**

`src/protocol.ts`:

- Add `model: string | null;` to the `SessionStart` and `SessionObserved` members of `RegistryEvent` (after `transcriptPath`), each with a `/** Raw provider-reported model id; null when the provider did not report one. */` comment.
- Add `model: string | null;` to `ProjectedSession` (after `ghosttyTerminalId`).
- In `parseSession`: validate with the existing helpers — `value["model"] === undefined ? null : value["model"]` through `isNullableBoundedString`, invalid → `invalid("session.model must be null or a bounded string")`; include `model` in the returned object.

`src/core/providers.ts`:

- Add to `SAFE_FIELDS`: `model: ["model"],` with the module docstring updated: the allowlist now includes the provider-reported model id.
- In `sessionFacts`, add: `model: firstAllowlistedString(value, SAFE_FIELDS.model) ?? null,`

`src/core/projection.ts`:

- `StoredRow` gains `model: unknown`; `toProjectionRow` validates it (isStringOrNull + ≤256 code points, same shape as `ghostty_terminal_id`'s check) and returns it; `ProjectionRow` gains `model: string | null`; `PROJECTION_COLUMNS` gains `model`; `projectRows` passes `model: root.model` through.

`src/core/registry.ts` compile unblock: the `applySessionObserved` synthesis constructs a `SessionStart` (line 212-221) — add `model: event.model` there. Do NOT touch storage yet (Task 3).

Fixture sweep: `bun run typecheck` now errors at every `ProjectedSession`/`SessionStart`/`SessionObserved` literal missing `model`. Add `model: null` to each. Expected sites: `test/layout.test.ts`, `test/render.test.ts` (the `sessionModel` helper), `test/controller.test.ts`, `test/daemon.test.ts`, `test/cli.test.ts`, `test/registry.test.ts`, `test/helpers/event-process.ts`, plus any the compiler lists. Mechanical only — no test expectations change in this step.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run typecheck && bun test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts src/core/providers.ts src/core/projection.ts src/core/registry.ts test/
git commit -m "feat(protocol): model field on session events, snapshot, and projection"
```

---

### Task 3: Registry storage and the null-never-clears rule

**Files:**
- Modify: `src/core/registry.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: Task 1's column, Task 2's event field.
- Produces: `ActiveSession.model: string | null`; `SessionModelUpdate = { provider: Provider; sessionId: string; model: string }`; `updateSessionModels(db, updates: readonly SessionModelUpdate[]): number` (Task 4 consumes both).

**Context:** `src/core/registry.ts` owns all writes. `COLUMNS` (line 55) is the shared column list used by `getRow`, `listSessions`, and both INSERTs — appending `model` to it forces all three INSERT/UPDATE sites to be revisited (good). The null-never-clears rule has two teeth: `applySessionStart`'s existing-row UPDATE must not overwrite a stored model with a null event value (Kimi resume re-fires SessionStart WITH model, but a provider that omits it must not erase), and `applySessionObserved` backfills like it does for `transcript_path` (registry.ts:202-209) but only when the event's model is non-null.

- [ ] **Step 1: Write the failing tests**

`test/registry.test.ts` (the file builds real temp-home SQLite databases per test via `initializeDatabase` + `openRegistryDatabase` — mirror its `applyRegistryEvents` test patterns):

```ts
test("SessionStart stores a reported model", () => {
  // applyRegistryEvents with a kimi SessionStart carrying model: "k3";
  // listSessions row has model "k3".
});

test("a SessionStart with null model does not clear a stored model", () => {
  // SessionStart with model "k3", then a second SessionStart (same identity)
  // with model: null → model stays "k3" (UPDATE uses COALESCE).
});

test("SessionObserved backfills a null model but never overwrites one", () => {
  // SessionStart with model: null → row model null.
  // SessionObserved with model: "k3" → applied, row model "k3".
  // SessionObserved with model: "other" → applied, row model "other"
  //   (mirrors the transcript_path backfill: a non-null different value
  //   overwrites; corrections flow through the same channel).
  // SessionObserved with model: null → ignored, nothing changes.
});
```

The SessionObserved contract mirrors the existing `transcript_path` backfill (registry.ts:202-209 overwrites on difference when the event value is non-null, does nothing on null): a non-null, different event model overwrites the stored one; a null event model is an "ignored" no-op. So the assertions are: SessionObserved with model "other" while "k3" is stored → "applied", row model "other"; SessionObserved with model null → "ignored", nothing changes.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/registry.test.ts`
Expected: FAIL — `model` column not written / `ActiveSession` has no model.

- [ ] **Step 3: Implement**

In `src/core/registry.ts`:

1. `COLUMNS`: append `, model`.
2. `SessionRow` gains `model: string | null;`; `ActiveSession` gains `model: string | null;`; `toActiveSession` maps `model: row.model`.
3. `applySessionStart` — existing-row UPDATE: add `model = COALESCE(?, model)` to the SET list with `event.model` as the parameter (null event value keeps the stored one). INSERT: the `VALUES` list gains one `?` at the end and the parameter array gains `event.model` (model is last in `COLUMNS`).
4. `applySessionObserved` — existing-row branch: extend the backfill condition to mirror transcript_path:

```ts
  if (existing !== null) {
    const backfillModel = event.model !== null && existing.model !== event.model;
    const backfillTranscript = event.transcriptPath !== null && existing.transcript_path !== event.transcriptPath;
    if (backfillModel || backfillTranscript) {
      db.run(
        `UPDATE active_sessions
         SET transcript_path = COALESCE(?, transcript_path), model = COALESCE(?, model)
         WHERE provider = ? AND session_id = ?`,
        [event.transcriptPath, event.model, event.provider, event.sessionId],
      );
      return "applied";
    }
    return "ignored";
  }
```

(The COALESCEs make each side independent: a null event field keeps the stored value; the enclosing condition guarantees at least one side actually changes.)

5. `applySubagentStart`'s INSERT: child rows never carry a model — the VALUES list gains a literal `NULL` at the end (no new parameter).
6. Add after `SessionTitleUpdate`:

```ts
export type SessionModelUpdate = {
  provider: Provider;
  sessionId: string;
  model: string;
};
```

7. Add `updateSessionModels` mirroring `updateSessionTitles` exactly, with the docstring adjusted (model writes likewise never touch `updated_at`):

```ts
export const updateSessionModels = (db: Database, updates: readonly SessionModelUpdate[]): number =>
  inWriteTransaction(db, () => {
    let changed = 0;
    for (const update of updates) {
      const result = db.run(
        "UPDATE active_sessions SET model = ? WHERE provider = ? AND session_id = ? AND model IS NOT ?",
        [update.model, update.provider, update.sessionId, update.model],
      );
      changed += result.changes;
    }
    return changed;
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run typecheck && bun test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/core/registry.ts test/registry.test.ts
git commit -m "feat(registry): store and backfill session model, null never clears"
```

---

### Task 4: Daemon resolver — Claude/Codex model pull

**Files:**
- Modify: `src/core/titles.ts`, `src/core/daemon.ts`, `src/core/cli.ts`, `src/core/registry.ts` (TitleTarget widening + `listTitleTargets` SELECT only — keep minimal)
- Test: `test/titles.test.ts`, `test/daemon.test.ts`

**Interfaces:**
- Consumes: Task 3's `SessionModelUpdate` / `updateSessionModels`; existing `TitleTarget` (already carries `transcriptPath` — sufficient for both providers).
- Produces: renamed factory `createSessionFactsResolver(dependencies: SessionFactsResolverDependencies): SessionFactsResolver` where `SessionFactsResolver.resolve(targets: readonly TitleTarget[]): { titles: SessionTitleUpdate[]; models: SessionModelUpdate[] }`. Daemon dep renamed `resolveTitles` → `resolveFacts` with that return type.

**Context:** `src/core/titles.ts` resolves titles per maintenance pass. Claude: transcript tail (64 KiB, `readTail`) scanned for ai-title lines, cached per path on (mtime, size) in `claudeCache`. Codex: whole-file parse of `session_index.jsonl` (`readWhole`, own cache). zcode: per-pass SQLite. The model scan reuses the SAME tail read for Claude (one read, two facts) and adds a per-path tail read + cache for the Codex rollout at `transcript_path`. Model extraction is a regex over the tail string, NOT per-line JSON.parse — the tail's first line is usually truncated mid-JSON, and a regex is immune: `/"model":"([^"]{1,300})"/g`, last match wins (bounded to 256 code points after). Spec-verified record shapes: Claude transcripts carry `"model":"claude-fable-5"`; Codex rollouts carry `"model":"gpt-5.6-luna"`. A mid-session `/model` switch flips the label because the last occurrence in the growing tail changes.

The rename (`createTitleResolver` → `createSessionFactsResolver`) is deliberate honesty: the factory now resolves two facts. Ripple sites: `src/core/cli.ts:31` (import) and `cli.ts:373-376` (construction — keep the dependency keys, just the new names), `src/core/daemon.ts:34` (import `updateSessionModels` too) and the deps type + `maintain` pass, `test/titles.test.ts` and `test/daemon.test.ts` imports/fakes. File name `titles.ts` stays (renaming files churns history; the module docstring carries the widened scope).

- [ ] **Step 1: Write the failing tests**

`test/titles.test.ts` — the file fakes `statPath`/`readTail`/`readWhole` per test (read its head for the helper shapes). Add:

```ts
test("resolves a claude model from the same transcript tail as the title", () => {
  // readTail returns a tail containing an ai-title line AND
  // '"model":"claude-fable-5"'. resolve returns titles: [..] and
  // models: [{ provider: "claude", sessionId, model: "claude-fable-5" }].
  // Assert readTail was called ONCE per changed path (single read, two facts).
});

test("last model occurrence wins after a mid-session model switch", () => {
  // Tail contains '"model":"claude-fable-5"' then '"model":"claude-k2"'
  // (in that order) → model update is "claude-k2".
});

test("a transcript with no model record proposes no model update", () => {
  // Tail with only ai-title → models: []. (Nothing proposed, so the stored
  // value is never cleared — the registry only applies proposed updates.)
});

test("resolves a codex model from the rollout at transcript_path", () => {
  // Target: codex row with transcriptPath set. readTail(thatPath) returns
  // rollout JSONL containing '"model":"gpt-5.6-luna"' → models: [{ codex, id,
  // "gpt-5.6-luna" }]. readWhole (the session index) is NOT asked for models.
});

test("a stored-equal model proposes no update", () => {
  // TitleTarget needs the stored model for the differs-check → see Step 3:
  // TitleTarget gains `model: string | null`. Target with model already
  // "k3"-equivalent → no update proposed.
});

test("zcode and kimi targets are never model-resolved", () => {
  // zcode/kimi targets with transcriptPath null or set → no model updates,
  // and no reads are issued for them.
});
```

`test/daemon.test.ts` — its `resolveTitles` fake (find it via the imports) becomes `resolveFacts` returning `{ titles: [], models: [] }`; add one test asserting a proposed model update reaches `updateSessionModels` and triggers reprojection (mirror the existing title-pass test if present — read it first).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/titles.test.ts test/daemon.test.ts`
Expected: FAIL — `createSessionFactsResolver` doesn't exist; resolve returns titles-only.

- [ ] **Step 3: Implement**

`src/core/titles.ts`:

1. Module docstring: the resolver now resolves titles AND models; Claude's model comes from the same transcript tail as the title, Codex's from a tail read of the rollout at `transcript_path` (per-path cache); zcode has no model source and Kimi pushes its own — neither is resolved here.
2. `TitleTarget` gains `model: string | null` (defined in registry.ts — add it there, and extend `listTitleTargets`'s SELECT to include `model` and its mapping; that is part of THIS task's edits to registry.ts, keep them minimal).
3. Rename `TitleResolverDependencies` → `SessionFactsResolverDependencies` (same fields), `TitleResolver` → `SessionFactsResolver` with the new resolve return type, `createTitleResolver` → `createSessionFactsResolver`.
4. Add the extractor:

```ts
const MODEL_PATTERN = /"model":"([^"]{1,300})"/g;

/** Last raw model id in the window wins; regex over per-line parse because the tail's first line is usually truncated mid-JSON. */
const modelFromTail = (tail: string): string | null => {
  let found: string | null = null;
  for (const match of tail.matchAll(MODEL_PATTERN)) {
    const value = match[1];
    if (value !== undefined && value.length > 0) {
      found = value;
    }
  }
  return found === null ? null : boundTitle(found);
};
```

5. Claude: extend `claudeCache` entries to `{ title: string | null; model: string | null }`; on a cache miss read the tail once and derive both (`claudeTitleFromTail(tail)`, `modelFromTail(tail)`).
6. Codex: add `codexModelCache = new Map<string, FileStat & { model: string | null }>()` keyed by transcript path, mirroring the claude stat/read/cache flow with `modelFromTail`. Only consulted for codex targets with a non-null `transcriptPath`.
7. `resolve` collects both lists; a model is proposed only when found AND `!== target.model` (the differs-check needs the stored model — that's why step 2 widened `TitleTarget`). Kimi and zcode targets contribute no model updates.
8. Update the re-exports at the top (`SessionModelUpdate` alongside `SessionTitleUpdate`).

`src/core/daemon.ts`:

- Import `updateSessionModels` and the new types; deps type property `resolveTitles` → `resolveFacts` with the pair return type.
- In `maintain`'s title pass:

```ts
        const facts = this.deps.resolveFacts(listTitleTargets(this.connection));
        const titlesChanged = facts.titles.length > 0 && updateSessionTitles(this.connection, facts.titles) > 0;
        const modelsChanged = facts.models.length > 0 && updateSessionModels(this.connection, facts.models) > 0;
        if (titlesChanged || modelsChanged) {
          changed = true;
        }
```

- Update the `maintain` docstring ("titles on the fast cadence" → "session facts (titles, models) on the fast cadence").

`src/core/cli.ts`: import and construction rename (`createTitleResolver` → `createSessionFactsResolver`), and the daemon deps literal uses `resolveFacts: createSessionFactsResolver({ ... }).resolve` (dependency keys `codexIndexPath`/`zcodeDatabasePath` unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run typecheck && bun test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/core/titles.ts src/core/daemon.ts src/core/cli.ts src/core/registry.ts test/titles.test.ts test/daemon.test.ts
git commit -m "feat(daemon): resolve claude/codex session models in the maintenance pass"
```

---

### Task 5: Render the model label

**Files:**
- Modify: `src/plugin/render.ts`
- Test: `test/render.test.ts`

**Interfaces:**
- Consumes: `ProjectedSession.model` (Task 2; the session KeyModel already carries the whole `ProjectedSession`, so layout needs no change).
- Produces: tile contract — `<text class="model" x="56" y="32" text-anchor="start" font-size="12" fill="#94A3B8">label</text>` present on session tiles iff `model !== null`.

**Context:** `src/plugin/render.ts` is pure SVG-string functions. The chip is drawn by `providerMark` (line 165): rect at x=12 y=13 w=38 h=26, letter baseline y=32. The model label sits immediately right of it, sharing the letter's baseline. Label rule (spec): strip the first matching leading prefix from `["claude-", "gpt-", "zai/", "openai/"]` (if stripping would empty the string, keep the raw id), then cap at 10 code points with overflow ending in an ellipsis (9 code points + `…`). `COLOR_NEUTRAL` `#94A3B8` is the fill — chrome, never a status color. Escape via the existing `escapeXml`.

- [ ] **Step 1: Write the failing tests**

`test/render.test.ts` — reuse the `sessionModel({...})` fixture (it takes `ProjectedSession` overrides; `model` arrived in Task 2's sweep) and the `textNodesByClass` helper:

```ts
test("renders the stripped model label right of the provider chip", () => {
  expect(textNodesByClass(decode(sessionModel({ provider: "claude", model: "claude-fable-5" }), 0), "model")).toEqual([
    "fable-5",
  ]);
  expect(textNodesByClass(decode(sessionModel({ provider: "codex", model: "gpt-5.6-luna" }), 0), "model")).toEqual([
    "5.6-luna",
  ]);
  expect(textNodesByClass(decode(sessionModel({ provider: "kimi", model: "k3" }), 0), "model")).toEqual(["k3"]);
  expect(textNodesByClass(decode(sessionModel({ provider: "pi", model: "zai/glm-5.3" }), 0), "model")).toEqual([
    "glm-5.3",
  ]);
});

test("caps the model label at ten code points with an ellipsis", () => {
  expect(
    textNodesByClass(decode(sessionModel({ model: "someverylongmodel" }), 0), "model"),
  ).toEqual(["someveryl…"]);
});

test("omits the model label when the model is unknown", () => {
  expect(textNodesByClass(decode(sessionModel({ model: null }), 0), "model")).toHaveLength(0);
});
```

Also pin the geometry once:

```ts
test("model label geometry and chrome color", () => {
  const svg = decode(sessionModel({ model: "k3" }), 0);
  expect(svg).toContain('<text class="model" x="56" y="32" text-anchor="start" font-size="12" fill="#94A3B8">k3</text>');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/render.test.ts`
Expected: FAIL — no `model` text element exists.

- [ ] **Step 3: Implement**

In `src/plugin/render.ts`:

```ts
const MODEL_LABEL_PREFIXES = ["claude-", "gpt-", "zai/", "openai/"];
const MODEL_LABEL_MAX_CODE_POINTS = 10;

/**
 * Raw id to chip label: strip one vendor prefix (keeping the raw id if
 * stripping would leave nothing), then cap at ten code points with an
 * ellipsis on overflow.
 */
const modelLabel = (model: string): string => {
  let label = model;
  for (const prefix of MODEL_LABEL_PREFIXES) {
    if (label.startsWith(prefix) && label.length > prefix.length) {
      label = label.slice(prefix.length);
      break;
    }
  }
  const points = Array.from(label);
  return points.length > MODEL_LABEL_MAX_CODE_POINTS
    ? `${points.slice(0, MODEL_LABEL_MAX_CODE_POINTS - 1).join("")}…`
    : label;
};

const modelMark = (model: string | null): string =>
  model === null
    ? ""
    : `<text class="model" x="56" y="32" text-anchor="start" font-size="12" fill="${COLOR_NEUTRAL}">${escapeXml(modelLabel(model))}</text>`;
```

Add `modelMark(model.session.model)` to `sessionTile` directly after `providerMark(...)`. Update the module docstring: "a provider-colored corner chip with the one-letter provider mark and, when known, the session's model id label to its right".

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run typecheck && bun test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/plugin/render.ts test/render.test.ts
git commit -m "feat(plugin): render stripped model label right of the provider chip"
```

---

### Task 6: Contract docs and manifest 0.4.0.0

**Files:**
- Modify: `docs/design.md`, `AGENTS.md`, `docs/hook-configuration.md`, `com.drewritter.stream-deck-agents.sdPlugin/manifest.json`

**Interfaces:**
- Consumes: Tasks 1–5 as built.
- Produces: deployable version bump; docs matching the shipped contract.

- [ ] **Step 1: Update `docs/design.md`**

In the tile-features bullet list (the provider chip bullet, currently line ~63): after the chip description add a sibling bullet:

```markdown
- The session's model id as small neutral-chrome text right of the provider chip, when known: vendor prefix stripped (`claude-fable-5` shows as `fable-5`), capped at ten code points with an ellipsis. Kimi pushes its model in SessionStart hooks; the daemon resolves Claude and Codex models from transcript/rollout tails (last occurrence wins, so mid-session model switches register). zcode has no model source; pi/omp/deepseek have no hooks yet — their tiles show the chip alone.
```

- [ ] **Step 2: Update `AGENTS.md`**

- Conventions: extend the provider-chip entry — after the `PROVIDER_LETTERS`/`PROVIDER_COLORS` sentence add: "Session tiles also carry the model id as neutral-chrome text right of the chip (vendor prefix stripped, ten-code-point cap); the registry stores the raw id (schema v6 `model` column), Kimi pushes it via SessionStart, and the daemon resolves Claude/Codex ids in the same maintenance pass as titles (last `\"model\":\"…\"` in the tail wins). Null never clears a stored model."
- Session lifecycle / titles paragraph: note the resolver is now `createSessionFactsResolver` in `src/core/titles.ts` (titles + models), wired in `cli.ts` and driven by the daemon's 2s maintenance pass.

- [ ] **Step 3: Update `docs/hook-configuration.md`**

In the Kimi section: SessionStart payloads also carry `model` (and `profile`); the daemon stores the bounded `model` value and renders it on the tile. UserPromptSubmit carries no model field, so a session whose SessionStart was missed shows no model for its lifetime.

- [ ] **Step 4: Bump the manifest**

`com.drewritter.stream-deck-agents.sdPlugin/manifest.json`: `"Version": "0.3.1.0"` → `"0.4.0.0"` (tabs preserved; new snapshot field + new core = minor feature bump).

- [ ] **Step 5: Verify and commit**

Run: `bun run check`
Expected: PASS (biome ci + build + full suite).

```bash
git add docs/design.md AGENTS.md docs/hook-configuration.md com.drewritter.stream-deck-agents.sdPlugin/manifest.json
git commit -m "docs: model-label contract; manifest 0.4.0.0"
```

---

### Task 7: Final gate (controller-run, no code)

- [ ] **Step 1: Full gate**

Run: `bun run check`
Expected: PASS — biome ci, typecheck+build, entire suite.

- [ ] **Step 2: Final whole-branch review** (controller dispatches; covers cross-task seams: privacy allowlist discipline, null-never-clears enforcement at every write site, snapshot cross-version tolerance, docs accuracy).

- [ ] **Step 3: Merge to main and deploy** with the user's go-ahead: `bun scripts/install-local.ts` migrates the live DB v5→v6 and installs plugin 0.4.0.0, then verify the live grid shows model labels (Kimi immediately via hook push; Claude/Codex within one 2s maintenance pass).
