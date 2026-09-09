# Multi-account Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect independent Codex and Claude account readings and display their reset countdowns and remaining quota in the approved inline rail, with honest health states and two explicit density presets.

**Architecture:** Keep the collector → shared snapshot → pure view model → DOM renderer boundaries. Add a Codex account adapter, reuse the existing window normalizer, and reconcile account inventories without mutating published state during an in-flight pass. Ship the schema-v3 writer and reader together; rendering and read-only details consume the same account/window model.

**Tech Stack:** TypeScript, Bun, plain DOM/CSS, existing Tauri shell, Bun tests and `test/support/fake-dom.ts`. SHA-256 uses `node:crypto` in the collector only. No new dependencies.

**Spec:** [Multiple-account quota collection and inline rail](../specs/2026-09-08-multi-account-quota-design.md). Visual authority: [comfortable/compact inline mockup](../mockups/2026-09-08-inline-density-presets.html).

**Status:** Implementation plan drafted after Drew's approval to proceed from the spec. Checkboxes describe future work, not completed implementation or installed acceptance. Work from the existing task checkout; follow current session authorization for execution, delegation, commits, and installation. The present request is to draft this plan.

## Global Constraints

- “Keep the existing 120-second polling cadence and reentrancy guard.” CodexBar deadline: 90 seconds; cswap deadline: 5 seconds. Retain serialized CodexBar calls and the bounded widget read.
- “Respect source caching and backoff; do not add refresh-on-tap, retry loops, forced refresh flags, or provider model calls.”
- “The proposed coordinated writer and reader use quota schema version 3 only.” Reject v1/v2 for both reading and startup seeding; no migration, dual writer, or compatibility shim.
- “Use numeric labels on the strip.” Codex IDs are `codexbar:` plus the full SHA-256 digest of `codex\0` followed by the trimmed source label. Claude IDs remain `claude-swap:<slot>`.
- “Publish no emails, organization names, raw source labels, credentials, raw subprocess output, or raw error messages in snapshots, logs, or detail views.”
- “Represent activity as `true`, `false`, or `null` (unknown).” Codex is `null`; only `true` draws a dot. Preserve source slot ordering for Claude and retained numeric label ordering for Codex.
- Required account health: `issue: null | auth_required | rate_limited | unavailable`, with `unavailable === (issue !== null)`. Account timestamps always describe source measurements.
- Codex account stale age: 6 minutes. Claude account stale age: 45 minutes. These are named UI limits, not polling intervals; verify Claude's limit against normal source pacing before shipping.
- Wire limits remain eight accounts and eight extra windows per provider. Validate unique IDs/labels, provider-specific identities, at most one known-active account, canonical nullable timestamps, and percentages in `0..100`.
- “Every numerical readout uses **reset countdown · remaining percentage**.” Binding selection remains lowest remaining, ties session → weekly → extras in source order.
- “Define one internal setting, `QUOTA_DENSITY: "comfortable" | "compact"`, defaulting to `comfortable`.” No settings screen or automatic density selection.
- Native geometry: 2560 × 720 strip, 638 × 720 rail. Comfortable must fit five providers/seven accounts; compact must fit five providers/eleven accounts.
- Countdown `#94a3b8`, percentage `#e8eef7`, normal weight, note-to-percentage ratio `0.875`, shared baseline. Keep provider colors and the token/unread blocks.
- “Do not change `src/protocol.ts`, session identity, board packing, provider model invocation, or token-usage collection for this feature.” Keep Kimi, GLM (`zai`), and Qwen collection behavior.
- No credentials, switching, authentication actions, upstream patches, or Linear tickets. Preserve existing pre-commit hooks.

## Source facts and implementation decisions

These are verified against this checkout and the local source trees; they avoid inventing an upstream API:

1. CodexBar's `ProviderPayload` serializes `account`, `usage.updatedAt`, and `error: {code, kind, message}`. `cacheAccountKey` is deliberately absent from `CodingKeys`. `CLIErrorReporting.swift`/`CLIHelpers.swift` expose broad exit categories, not reliable Codex auth/rate-limit categories. Normalize current Codex errors to `unavailable`; never inspect `message` to classify them. Add more specific mappings only when a structured source contract supports them.
2. cswap's `json_output.py` exposes `ok`, `relogin_required`, `token_expired`, `api_key`, `keychain_unavailable`, `foreign_credential`, `no_credentials`, and `unavailable`. Only `relogin_required` means `auth_required`; the other failures mean `unavailable`. Its installed JSON does not separately expose HTTP 429. The v3 `rate_limited` state is still supported and tested through synthetic normalized data, without claiming the current source emits it.
3. Retain existing zero/one-account Claude ambient probing. When exactly one identified account exists, render that account's own values and health in the single-provider form; keep the ambient result separate. When two or more are retained and discovery fails or the binary disappears, retain the group without an ambient Claude probe. Only a valid complete inventory permits removal.
4. Codex has exactly one `--all-accounts` invocation per pass. A lone anonymous successful Codex record is an ambient fallback only with no retained identified group. An anonymous/widget value never repairs an identified account. Empty successful inventory removes account grouping; an empty response with a nonzero exit does not.
5. Provider `fetchedAt` remains the account-inventory collection stamp when accounts are present; per-account `fetchedAt` is always the measurement stamp. A complete decoded inventory can advance collection liveness even if an account needs sign-in. An incomplete inventory cannot make omitted accounts look refreshed. Group liveness decorates the heading; it must not apply parent opacity to successful account rows.
6. Treat a failed or duplicate observation as unable to replace a good measurement. A failed observation may carry valid source last-good data; retain the newer valid measurement between it and the previously published row. Preserve an actionable retained issue through a generic transport failure; a valid success for that ID clears it.
7. Keep reset-crossed but otherwise healthy values as a visibly old reading with `resetting…`. Once the account is stale/unavailable and its binding reset is not still ahead, hide both percentage and fill/ticks. For stale/unavailable data with unknown reset, use the same conservative suppression rule. Details retain historical windows.
8. Invalid/old snapshot input returns unavailable provider models without reading its provider contents. Missing snapshots can retain the existing empty-panel behavior. This makes the v3 transition visibly unavailable without converting v1/v2 data.

The source files inspected are under `/Users/drewritter/projects/CodexBar/Sources/CodexBarCLI/` and `/Users/drewritter/.local/share/uv/tools/claude-swap/lib/python3.14/site-packages/claude_swap/`. They are reference material, not files to modify.

## File structure and dependency order

| File | Responsibility | Tasks |
| --- | --- | --- |
| `src/quota-snapshot.ts` | v3 account types and provider-aware wire validation | 1 |
| `src/core/claude-swap-quota.ts` | Normalize source health without losing measurement timestamps | 1 |
| `src/core/codexbar-usage.ts` (new) | Existing CodexBar record/window normalization extracted from `quota.ts` | 2 |
| `src/core/codexbar-accounts.ts` (new) | Identified Codex batches, opaque IDs, display label assignment | 2 |
| `src/core/quota-accounts.ts` (new) | Pure shared account reconciliation and bounded retention | 3 |
| `src/core/quota.ts` | Source selection, v3 seeding, staged state, atomic publication | 1–3 |
| `app/src/quota.ts` | Generic account models, freshness, shared readout decisions | 1, 4 |
| `app/src/quota-density.ts` (new) | One default and one preset table | 5 |
| `app/src/rail.ts`, `app/styles.css` | Activity type plumbing (rail only), inline rows, density and button targets | 1, 5–6 |
| `app/src/quota-details.ts` (new) | Detail model, read-only overlay and shared interaction controller | 6 |
| `app/src/main.ts` | Density selection, clock updates, detail lifecycle and stable targeting | 4–6 |
| `test/quota-snapshot.test.ts`, `test/quota-claude-swap.test.ts` | Contract and source status regression coverage | 1 |
| `test/quota-codexbar.test.ts`, `test/quota-codexbar-accounts.test.ts` (new) | Shared window parsing and Codex inventories | 2 |
| `test/quota-accounts.test.ts` (new), `test/quota.test.ts` | Reconciliation, subprocess boundary, restart/abort/privacy | 1–3 |
| `test/strip-quota.test.ts`, `test/strip-rail.test.ts` | Honest view states, grouping, signatures, DOM structure | 1, 4–5 |
| `test/strip-quota-details.test.ts` (new) | Correct account/window detail selection | 6 |
| `test/fixtures/quota/` | Synthetic upstream and v3 snapshot fixtures | 1–3, 7 |
| `scripts/quota-preview.ts` (new), `docs/assets/dealerboard-strip.png`, `README.md` | Reproducible real-renderer acceptance and current documentation | 7 |

Execute 1 → 2 → 3 → 4 → 5 → 6 → 7. Each task has an independently inspectable/testable result; none is a standalone release because v3 is a coordinated change. Extract only the existing CodexBar parser block, not the entire collector. Keep `parseCodexbarUsage` exported from `src/core/quota.ts` for existing callers/tests while moving its implementation.

Before execution, inspect `git status --short --branch` and run the focused baseline once:

```sh
bun test test/quota-snapshot.test.ts test/quota-claude-swap.test.ts test/quota-codexbar.test.ts test/quota.test.ts test/strip-quota.test.ts test/strip-rail.test.ts
```

Record pre-existing failures separately. For the steps below, add behavioral coverage first, confirm the intended failure, implement, then rerun the named gate. Update assertions intentionally superseded by v3/freshness requirements; preserve regression coverage for behavior that remains supported. Commit boundaries are the task deliverables when execution authorization includes commits; never bypass hooks.

### Task 1: Introduce the v3 contract and Claude issue normalization

**Files:** `src/quota-snapshot.ts`, `src/core/claude-swap-quota.ts`, `src/core/quota.ts`, `app/src/quota.ts`, `app/src/rail.ts`, account fixtures/builders in `test/quota-snapshot.test.ts`, `test/quota-claude-swap.test.ts`, `test/quota.test.ts`, `test/strip-quota.test.ts`, and `test/fixtures/quota/quota-snapshot.json`.

**Interfaces:** Preserve `parseQuotaSnapshot(value: unknown): QuotaSnapshot` and `parseClaudeSwapAccounts(body: string): ClaudeSwapAccountsParse`. Change the shared account and snapshot types as follows; retain their other existing fields:

```ts
export const QUOTA_SNAPSHOT_SCHEMA_VERSION = 3;
export type QuotaAccountIssue = "auth_required" | "rate_limited" | "unavailable";
// ProviderQuotaAccount: active: boolean | null; issue: QuotaAccountIssue | null;
// QuotaSnapshot: schemaVersion: 3;
```

- [ ] Add v3 round-trip and rejection cases: both ID namespaces under the correct provider, duplicate ID/label, invalid positive-decimal labels, two `active: true` rows, nullable activity/timestamps, absent issue, and disagreement between issue/unavailable. An account with any measurement/reset/extra window needs a valid measurement timestamp; a never-measured account has all measurement fields null and `extraWindows: []`. Non-account providers cannot accept Claude/Codex account IDs.

  Use the existing `claudeQuota()` builder for this focused legacy rejection test:

  ```ts
  test.each([1, 2])("rejects quota schema %s instead of migrating", (schemaVersion) => {
    expect(() => parseQuotaSnapshot({ schemaVersion, providers: { claude: claudeQuota() } })).toThrow("schemaVersion");
  });
  ```

- [ ] Run `bun test test/quota-snapshot.test.ts test/quota-claude-swap.test.ts`; confirm the new v3/issue cases fail on the old contract.

- [ ] Pass the provider key into account validation and remove the legacy parsing branch. Require arrays in v3 rather than substituting v1/v2 defaults. Retain existing unknown-provider-key behavior and history/window bounds. The identity checks are:

  ```ts
  const validId = provider === "claude"
    ? value["id"] === `claude-swap:${value["label"]}`
    : provider === "codex" && typeof value["id"] === "string"
      && /^codexbar:[a-f0-9]{64}$/u.test(value["id"]);
  // Reject a nonempty account list when validId cannot hold for its provider.
  // Require active === null || typeof active === "boolean".
  // Require unavailable === (issue !== null), after validating issue's enum.
  ```

- [ ] Add `issue` to Claude normalization and every collector-created failed account. A valid `ok` usage clears issue; invalid/missing `ok` data is unavailable. Keep source last-good windows and timestamps. Normalize failures using a fixed table/switch, including the explicit `relogin_required → auth_required` mapping; all other installed failure statuses map to `unavailable`.

  In `test/quota-claude-swap.test.ts`, clone the existing fixture, set account 2's `usageStatus` to `relogin_required`, and assert `issue: "auth_required"`, `unavailable: true`, and unchanged `lastGoodFetchedAt`/last-good percentages. Repeat with `token_expired` and `keychain_unavailable` expecting `unavailable`, then a valid `ok` response expecting `issue: null`. Assert output excludes the fixture's email/organization/credential sentinels.

- [ ] Update all quota snapshot builders to v3 and all account constructors to explicit issue values. Widen `QuotaAccountMeterModel.active` and `QuotaRenderAccount.active` to `boolean | null` in this task so the v3 propagation type-checks; rendering still draws a marker only for `true`. Leave cswap upstream fixture `schemaVersion: 1` intact: it is a different contract. Convert old-reader acceptance tests into explicit rejection tests, preserving equivalent validation tests on v3. The collector's existing writer uses the shared version constant; startup parsing now rejects old snapshots automatically. Update comments that promise v1/v2 compatibility.

- [ ] Run the focused baseline command above and `bun run typecheck`. Inspect the diff for unintended non-quota schema edits. Deliverable: writer/reader compile against v3, Claude issue survives serialization, and old snapshots cannot seed retained state. Suggested commit: `feat: define quota v3 account health contract`.

### Task 2: Parse Codex account batches without losing identity or partial successes

**Files:** create `src/core/codexbar-usage.ts`, `src/core/codexbar-accounts.ts`, `test/quota-codexbar-accounts.test.ts`; modify `src/core/quota.ts` and `test/quota-codexbar.test.ts` as needed for the extraction.

**Interfaces:** Move `QuotaWindowReading`, `ProviderQuotaReading`, and existing parsing helpers into `codexbar-usage.ts`. Move `parseCodexbarWidgetSnapshot` and its `WIDGET_SNAPSHOT_MAX_AGE_MS` constant there too, because the widget parser shares the private window helpers; leave widget path resolution/I/O in `quota.ts`. Re-export the existing public types/functions/constants from `quota.ts` without an import cycle. Introduce:

```ts
export function parseCodexbarRecord(entry: unknown, provider: string): ProviderQuotaReading | null;

// In codexbar-accounts.ts. All account objects returned here are privacy-safe.
export type CodexAccountsParse =
  | { kind: "invalid" }
  | {
      kind: "ok";
      accounts: ProviderQuotaAccount[];
      completeInventory: boolean;
      inventoryObserved: boolean;
      ambient: { reading: ProviderQuotaReading; fetchedAt: string } | null;
    };
export function codexAccountId(label: string): string;
export function parseCodexbarAccounts(
  body: string,
  exitCode: number,
  previous: readonly ProviderQuotaAccount[],
): CodexAccountsParse;
```

`completeInventory` permits removals only on exit 0 with every relevant row valid, identified, unique, and successful (or a valid empty inventory). `inventoryObserved` means a complete identity inventory was decoded, including identified source errors; it does not imply measurement freshness or permission to remove. An anonymous ambient reading never proves the prior identified inventory is empty.

- [ ] Add a synthetic record helper inside the new test file:

  ```ts
  const codexRecord = (account: string, usedPercent: number) => ({
    provider: "codex", account,
    usage: {
      updatedAt: "2026-09-08T18:00:00Z",
      primary: { windowMinutes: 300, usedPercent, resetsAt: "2026-09-08T23:00:00Z" },
    },
  });
  test("identifies accounts across response order changes", () => {
    const first = parseCodexbarAccounts(JSON.stringify([
      codexRecord("synthetic-a", 20), codexRecord("synthetic-b", 90),
    ]), 0, []);
    if (first.kind !== "ok") throw new Error("expected parsed accounts");
    const next = parseCodexbarAccounts(JSON.stringify([
      codexRecord("synthetic-b", 80), codexRecord("synthetic-a", 30),
    ]), 0, first.accounts);
    if (next.kind !== "ok") throw new Error("expected parsed accounts");
    expect(next.accounts.map(({ id, label }) => ({ id, label })))
      .toEqual(first.accounts.map(({ id, label }) => ({ id, label })));
    expect(next.accounts.find(a => a.id === codexAccountId("synthetic-a")))
      .toMatchObject({ percentRemaining: 70, active: null, fetchedAt: "2026-09-08T18:00:00.000Z" });
  });
  ```

  Additional cases: whitespace trimming; empty label; distinct labels differing internally; duplicate trimmed labels; a source-label rename; unrelated provider records; malformed/truncated root; missing/invalid `usage.updatedAt`; no usable window; extras/scoped windows; empty exit-0 versus empty exit-1; one anonymous record versus multiple anonymous records; mixed named/anonymous rows; success plus identified error on exit 1. Assert an error's raw `message` and `usage.identity` fields never escape the adapter.

- [ ] Run `bun test test/quota-codexbar-accounts.test.ts` and confirm it fails before the new adapter exists.

- [ ] Extract the current per-record window parsing unchanged and have `parseCodexbarUsage` call it after its existing ambient provider selection. Keep widget normalization and other providers' selection behavior. Reuse the exact parser for every identified Codex success, including Spark session and extra weekly windows.

- [ ] Implement the account adapter in two passes: validate/filter/identify rows and count duplicate labels first, then accept measurements only for unique identities. This prevents the first duplicate from updating an account before the collision is discovered. Hash source labels and assign display labels without mutating `previous`:

  ```ts
  import { createHash } from "node:crypto";

  export const codexAccountId = (label: string): string =>
    `codexbar:${createHash("sha256").update(`codex\0${label.trim()}`, "utf8").digest("hex")}`;
  const labels = new Map(previous.map(account => [account.id, account.label]));
  let nextLabel = Math.max(0, ...previous.map(account => Number(account.label))) + 1;
  // newIds is the set of unique identified IDs absent from labels.
  for (const id of [...newIds].sort()) labels.set(id, String(nextLabel++));
  ```

  Normalize `usage.updatedAt` to canonical ISO; never fall back to collection time. Valid current errors become identified, never-measured unavailable observations. Duplicate IDs produce no successful observation for that ID; retained state is handled in Task 3. Unknown duplicate accounts are not assigned invented identities. Source label changes are new accounts. Return rows sorted by numeric display label.

- [ ] Keep ambiguity explicit: any malformed/unidentified candidate or source error prevents removal; explicit non-Codex provider records are ignored for measurements, and malformed/CLI-level error records must not turn into a successful empty Codex inventory. If more than eight identified accounts are reported, reject the batch as invalid and retain the previous inventory; never slice off accounts silently.

- [ ] Run `bun test test/quota-codexbar.test.ts test/quota-codexbar-accounts.test.ts` and `bun run typecheck`. Deliverable: deterministic sanitized batches retain identifiable successes independently of process exit code. Suggested commit: `feat: parse labeled Codex quota accounts`.

### Task 3: Reconcile retained accounts and publish complete passes atomically

**Files:** create `src/core/quota-accounts.ts`, `test/quota-accounts.test.ts`; modify `src/core/quota.ts`, `test/quota.test.ts`; add synthetic `test/fixtures/quota/codexbar-accounts.json` and `test/fixtures/quota/codexbar-accounts-partial.json`.

**Interfaces:** Consume Task 2's `CodexAccountsParse`, Task 1's Claude account records, and the existing injected `QuotaExec`/`QuotaCollectorDependencies`. Introduce this pure boundary:

```ts
export type AccountInventoryRead = {
  accounts: readonly ProviderQuotaAccount[];
  completeInventory: boolean;
};
export type AccountReconciliation =
  | { kind: "ok"; accounts: ProviderQuotaAccount[] }
  | { kind: "overflow" };
export function reconcileQuotaAccounts(
  previous: readonly ProviderQuotaAccount[],
  read: AccountInventoryRead,
): AccountReconciliation;
```

An invalid/transport read is `{accounts: [], completeInventory: false}`. Claude `completeInventory` is true only for a valid exit-0 inventory with no account errors. A valid inventory containing account failures can still update known active-slot information and successful peers; it cannot remove an omitted account. If retained plus new accounts would exceed eight during a partial inventory, return overflow, retain the prior inventory as unavailable, and emit the fixed account-failure diagnostic.

- [ ] Add reconciliation tests for success/error merging, missing peers during incomplete inventory, duplicate observations already suppressed by Task 2, successful removal, zero/one/two transitions, account-specific issue clearing, cached timestamps, and union overflow. Freeze input objects/arrays in these tests to catch accidental mutation. A failed observation with older or no history cannot replace the previous measurement; compare canonical source timestamps before choosing last-good data.

- [ ] Add collector coverage using the existing `makeHarness`, `respondRaw`, `throwOnce`, and temporary output paths. This partial-result case exercises the actual publication boundary:

  ```ts
  test("publishes a successful Codex peer when the batch exits nonzero", async () => {
    const harness = makeHarness();
    harness.respondRaw("codex", { exitCode: 0, stdout: fixture("codexbar-accounts.json") });
    const collector = createQuotaCollector(harness.deps);
    await collector.pollNow();
    const before = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "null"));
    harness.respondRaw("codex", { exitCode: 1, stdout: fixture("codexbar-accounts-partial.json") });
    await collector.pollNow();
    const after = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "null"));
    const failedId = codexAccountId("synthetic-b");
    const oldFailed = before.providers.codex?.accounts.find(a => a.id === failedId);
    expect(after.providers.codex?.accounts.find(a => a.id === failedId))
      .toEqual({ ...oldFailed, unavailable: true, issue: "unavailable" });
    expect(after.providers.codex?.accounts.find(a => a.id === codexAccountId("synthetic-a")))
      .toMatchObject({ percentRemaining: 60, fetchedAt: "2026-09-08T18:02:00.000Z", issue: null });
  });
  ```

  The initial fixture has `synthetic-a` at 80% remaining, `synthetic-b` at 10%, both measured at `18:00Z`; the partial fixture has A at 60% measured at `18:02Z`, plus B's `{code: 1, kind: "provider", message: "synthetic-private-error"}`. Give both successful records future session/weekly reset windows. Import `codexAccountId` in this test file.

- [ ] Run `bun test test/quota-accounts.test.ts test/quota.test.ts`; confirm failures are in the changed retention/invocation/publication behavior.

- [ ] Implement reconciliation keyed only by opaque ID. Keep old labels, use explicit observed activity, and sort the result numerically. On an incomplete inventory, omitted retained rows keep their own measurement and become unavailable. On a complete inventory, omit removed IDs. If an observed active Claude slot changes, clear any retained `true` on other slots so incomplete retention cannot create two active rows; unknown activity remains null. Preserve a retained specific issue across generic transport failure, and clear it only on a valid success for that account.

- [ ] Generalize collector state to store both providers' accounts alongside each provider quota, eliminating the separate mutable Claude-only inventory. Seed the whole v3 provider/account state from the snapshot. Preserve the diagnostic transition flag from stored availability/issues; never log source payloads. Keep `quota_failed` and `quota_accounts_failed` fixed codes, parameterizing the latter's provider. Invalid/ambiguous batch failures use the latter on transitions, not on every poll.

- [ ] Stage a pass in a fresh provider-state map; all required reads and normalization operate on that candidate state. Make `pollProvider` work against the candidate map rather than closing over committed `states`. Seed labels from the committed snapshot and do not maintain a separately advancing label counter. Publish before swapping retained state:

  ```ts
  // nextStates contains newly constructed values; no shared ProviderState is mutated.
  // snapshot is assembled from nextStates in QUOTA_PROVIDER_KEYS order.
  const json = `${JSON.stringify(snapshot)}\n`;
  if (json !== lastWrittenJson) writeFile(dependencies.quotaSnapshotPath, json);
  states = nextStates;
  lastWrittenJson = json;
  // Emit queued, sanitized transition diagnostics after the successful commit.
  ```

  Keep this synchronous tail after the final await. A write failure or unexpected later-provider exception must leave account IDs, numeric labels, windows, timestamps, and failure-transition state at the previous publication. `pollNow` still contains exceptions and clears its reentrancy guard. Keep the existing atomic-file writer; no new persistence file is needed.

- [ ] Add Codex `--all-accounts` to its existing JSON/critical-log invocation and bypass the ordinary Codex `pollProvider` probe. Feed stdout to the adapter even when exit is nonzero. Keep all other provider calls serialized. Treat missing binary/timeout/malformed responses as failed inventory while named rows are retained. Disable Codex widget rescue whenever identified rows are retained; an eligible anonymous/ambient fallback cannot overwrite any named account. Grouped ambient windows stay null and history is frozen; a single named account is selected only by the view model.

- [ ] Keep Claude's successful single/absent-source ambient path; skip ambient probing for two or more successfully discovered or retained accounts. Reconcile Claude observations independently of ambient readings. A valid complete empty inventory may clear the group; a disappeared binary alone may not. Preserve source `usageFetchedAt`/`lastGoodFetchedAt`, even if cswap returns the same successful cache repeatedly.

- [ ] Extend integration tests to cover: exactly one all-account Codex call; unchanged deadlines/cadence; no grouped Claude ambient call; binary disappearance; malformed/truncated/duplicate/missing-ID inventories; anonymous/widget isolation; valid removal and empty inventory; restart with v3 source timestamps and stable labels; v1/v2 restart rejection; abort after newly discovered Codex IDs; publication failure followed by a failed read; reentrancy; privacy of published JSON and collected diagnostics. Keep the existing widget timeout/non-account provider regressions.

- [ ] Run `bun test test/quota-accounts.test.ts test/quota.test.ts test/quota-codexbar-accounts.test.ts test/quota-claude-swap.test.ts` and `bun run typecheck`. Deliverable: each account retains its own last-good state across failures/restart and publishes only as part of a complete pass. Suggested commit: `feat: retain quota accounts through partial collection failures`.

### Task 4: Derive generic account freshness and honest readouts

**Files:** `app/src/quota.ts`, `app/src/main.ts`, `test/strip-quota.test.ts` and view-model builders in `test/strip-rail.test.ts`.

**Interfaces:** Extend `QuotaAccountMeterModel` with `active: boolean | null` and `issue: QuotaAccountIssue | null`; use `QuotaPanelState` for its state instead of the old `ok | unavailable` restriction. `QuotaPanelModel.accounts` includes zero, one, or many accounts for Claude/Codex. Preserve `bindingWindow`, `selectBindingIndex`, and `secondaryWindows`. Add:

```ts
export const ACCOUNT_STALE_AGE_MS = { codex: 6 * 60_000, claude: 45 * 60_000 } as const;
export type QuotaReadout = {
  note: string;
  percent: string | null;
  ageCue: string | null;
  showFill: boolean;
  historical: boolean;
};
export function quotaReadout(model: QuotaMeterModel, now: number): QuotaReadout;
```

Add `issue: QuotaAccountIssue | null` to the common meter model (ambient meters use null) so single/grouped paths call the same readout function. Keep source-specific state derivation in the pure model, and use the existing six-minute ambient freshness rule for other providers.

- [ ] Add clock-controlled tests for each row below. Extend the existing `model()` helper with `issue: null`, then pin the obsolete-fill bug:

  ```ts
  test("stale usage past its binding reset suppresses percentage and fill", () => {
    const reading = model({
      state: "stale", fetchedAtMs: NOW - 10 * 60_000,
      windows: [windowModel("session", 70, NOW - 1)],
    });
    expect(quotaReadout(reading, NOW)).toMatchObject({ percent: null, showFill: false, historical: true });
  });
  ```

  | Input | Required output |
  | --- | --- |
  | Healthy with future reset, including 0% | Countdown first; real remaining percentage and fill |
  | Healthy with unknown reset | `reset unknown`; percentage retained |
  | Healthy measurement whose reset passes | `resetting…`; historical/dimmed meter, no manufactured refill |
  | Stale/unavailable with future reset | Countdown and dimmed last-good percentage/fill plus visible age cue |
  | Stale/unavailable with elapsed or unknown reset | Age/unavailable note; no percentage, fill, or ticks |
  | Never measured | `unavailable`; no percentage/fill |
  | `auth_required`, irrespective of reset | `Sign in again`; no percentage/fill; history retained internally |
  | `rate_limited` | Unavailable presentation rules with specific explanation available to details |

- [ ] Run `bun test test/strip-quota.test.ts`; confirm failures in the new state/readout cases.

- [ ] Build account meter models for both providers, including a sole account. Derive issue failure immediately; otherwise compare the account measurement timestamp with the named provider limit. Keep panel inventory liveness separate. Build invalid-read placeholders from `QUOTA_PROVIDER_KEYS` and empty unavailable models without examining rejected snapshot contents. Update the old tests that intentionally ignored Claude reading age to assert the 45-minute boundary, including exactly-at-boundary and one millisecond beyond.

- [ ] Implement one visibility decision for text and meter geometry. Existing formatting helpers can delegate to this boundary where needed, but avoid a cycle between `quotaReadout` and `formatBindingNote`. Keep the exact binding window even if its reset crossed; no filtering elapsed windows before selecting the minimum. Use `ageCue` as a compact rail fact rather than hiding it in a title attribute.

- [ ] Retain the latest raw quota read in `main.ts` and run `reduceQuotaRead` against the current clock on the existing rail tick, as well as on new reads. This is necessary because current account state is otherwise computed only when the snapshot is read. It also ensures stale/reset transitions advance during repeated cached reads. Continue using `railRenderSignature` to avoid unnecessary DOM replacement.

- [ ] Cover single-account own-reading selection in the model/render interface, scoped-window binding and stable ties, source cache timestamp preservation, unknown Codex activity, and one failed sibling leaving the other healthy. Run `bun test test/strip-quota.test.ts test/strip-rail.test.ts` and `bun run typecheck`. Deliverable: the renderer receives explicit, consistent visibility decisions. Suggested commit: `feat: model account freshness and reset states`.

### Task 5: Render inline accounts with one density preset boundary

**Files:** create `app/src/quota-density.ts`; modify `app/src/rail.ts`, `app/styles.css`, `app/src/main.ts`, `test/strip-rail.test.ts`.

**Interfaces:** Extend `RailModel` with required `quotaDensity: QuotaDensity` and pass the constant from `main.ts`. Generalize `QuotaRenderModel`'s grouped provider type to Claude/Codex. Its ungrouped `meter` accepts either the sole identified account or the ambient panel. Introduce a shared target type in `app/src/quota.ts`:

```ts
export type QuotaTarget = { provider: QuotaProviderKey; accountId: string | null };
```

Render each meter as a native `button type="button"` with `data-quota-provider` and, for identified accounts, `data-quota-account`. Single-account presentation still carries that account ID. Ambient targets carry no account ID; never use source-array indexes as targets.

- [ ] Add DOM tests using the existing fake document: grouped Codex and Claude each have one provider heading/count and one inline row per account; a single named account uses its own measurement/issue; only known `true` draws the active marker. Assert note precedes percentage, secondary ticks remain neutral, auth/obsolete readings omit fill/ticks, and an unavailable sibling does not alter a healthy row. Assert button type, numeric label and target IDs, not complete HTML strings.

- [ ] Run `bun test test/strip-rail.test.ts`; confirm failures before changing renderer structure.

- [ ] Define the preset table in one module and export a single application default:

  ```ts
  export type QuotaDensity = "comfortable" | "compact";
  export const QUOTA_DENSITY: QuotaDensity = "comfortable";
  export const QUOTA_DENSITY_PRESETS = {
    comfortable: { scale: 1.2, rowHeight: 40, providerGap: 16 },
    compact: { scale: 1, rowHeight: 31, providerGap: 10 },
  } as const;
  ```

  `renderRail` writes `--quota-scale`, `--quota-row-height`, and `--quota-provider-gap` on the quota zone. Convert vertical native dimensions through `720px → 100vh`; type and horizontal dimensions through `2560px → 100vw`, matching the existing viewport conventions. Base percentage `25px`, countdown `21.875px`, meter `5px` multiply by the quota scale. The table therefore yields 30/26.25/6px in comfortable. Provider headings, tags, chips, labels, gaps, and readout widths use the same scale. Token sizing remains independent.

- [ ] Replace `space-evenly` in the quota zone with packed preset gaps. Use inline row columns for marker/number, binding tag, flexible meter, and countdown/percentage. Keep the single-provider heading/readout with its meter below. Adapt the selected mockup's geometry; do not transplant its illustrative data logic. Use a separate small age cue inside the fixed row when showing history, preserving the countdown-first numeric readout.

- [ ] Apply `quotaReadout` to both text and bar creation. Keep countdown and percentage at normal weight and shared baseline, with the specified colors. Group collection staleness applies to the heading only; account dimming is local. Replace Claude-only group accents with each provider's existing color. Reset button defaults without removing a visible `:focus-visible` treatment. Long tags may ellipsize within their allotted label area; details preserve the complete published capped tag. Do not clip the countdown or hide rows to fit.

- [ ] Include density, issue, age cue, historical flag, and fill visibility in `railRenderSignature`, alongside identity/window/active information already tracked. Preserve the signature's stability between visible changes. Add assertions that stale-age and reset crossings change it without a source update.

- [ ] Run `bun test test/strip-quota.test.ts test/strip-rail.test.ts` and `bun run typecheck`. Deliverable: the real renderer uses the approved layout and one preset setting. Native-size fit is verified in Task 7, not inferred from fake-DOM tests. Suggested commit: `feat: render condensed quota accounts with density presets`.

### Task 6: Add account-specific, read-only details and safe tap handling

**Files:** create `app/src/quota-details.ts`, `test/strip-quota-details.test.ts`; modify `app/src/main.ts`, `app/styles.css` and, only as required for stable tap/focus handling, `app/src/rail.ts`. Consult existing `app/src/action-sheet.ts`; do not rewrite session actions. Keep the small quota interaction controller in the new quota-details module so the app and synthetic browser preview exercise identical lifecycle/event code.

**Interfaces:** Consume `QuotaTarget`, `QuotaPanelModel`, window formatting, and normalized issue fields. Define:

```ts
export type QuotaDetailsModel = {
  target: QuotaTarget;
  title: string;
  activity: string;
  measurement: string;
  guidance: string | null;
  windows: readonly { tag: string; percent: string; reset: string }[];
};
export function quotaDetailsModel(
  panels: readonly QuotaPanelModel[], target: QuotaTarget, now: number,
): QuotaDetailsModel | null;
export function buildQuotaDetailsOverlay(
  model: QuotaDetailsModel, onDismiss: () => void,
): HTMLElement;
export type QuotaDetailsController = {
  isPressing: () => boolean;
  refresh: () => void;
  dismiss: () => void;
  dispose: () => void;
};
export function createQuotaDetailsController(options: {
  rail: HTMLElement;
  getPanels: () => readonly QuotaPanelModel[];
  now: () => number;
  beforeOpen: () => void;
  afterPress: () => void;
}): QuotaDetailsController;
```

- [ ] Add pure tests showing that `{provider: "codex", accountId: ID}` resolves that ID after reordering, never a sibling; missing IDs return null; an ambient target resolves only an ambient meter; one identified account preserves its ID in single form. Construct models using synthetic windows and normalized issues. Assert all windows/reset values, numeric title, source measurement age, and `Active account is not reported` for Codex null activity. Include `auth_required`, `rate_limited`, historical windows, and unknown resets.

  ```ts
  test("a removed account never retargets to another row", () => {
    expect(quotaDetailsModel([], {
      provider: "codex", accountId: `codexbar:${"a".repeat(64)}`,
    }, Date.parse("2026-09-08T18:00:00Z"))).toBeNull();
  });
  ```

- [ ] Run `bun test test/strip-quota-details.test.ts` and confirm failures before implementing details.

- [ ] Implement the model from published fields only. Display every window's percentage/reset together and label history as last measured. For Claude auth use guidance such as `Renew this saved sign-in through cswap.` For generic failure explain that collection is unavailable without prescribing re-login. For rate limit explain that source retry/backoff controls the next measurement. Activity copy means source switcher selection, not every running agent. Use `textContent` for all DOM output.

- [ ] Build an overlay following `.sheet-overlay`/`.action-sheet` conventions, with `role="dialog"`, `aria-modal="true"`, title, close button, and outside-tap dismissal. Include no refresh, switch, login, shell, or credential action. Bound the detail body within the viewport; scrolling here is acceptable for all windows and must not page the board.

- [ ] Implement the controller's detail lifecycle and instantiate it from `main.ts` beside the action sheet lifecycle. `beforeOpen` dismisses the session action sheet; opening a session action sheet calls the quota controller's `dismiss`. Only one overlay is open at once. Escape dismisses the current overlay; focus enters the close button, stays inside the dialog, and returns to the originating meter resolved by provider/ID after any rail rerender. If the account disappeared, restore to a safe focusable rail root. Clear the detail target on dismissal so a later source update cannot reopen it. `refresh` re-resolves the open target and updates changed content; `dispose` removes listeners and closes the overlay.

- [ ] The controller wires rail events on `#rail`, which is outside `#paging-region` and `#pager`. Capture the provider/account target on pointer-down and resolve it again when the tap settles; cancel if a different/removed target is under the release or the stroke is canceled. `main.ts` skips rail DOM replacement while `isPressing()` is true, leaving the render signature uncommitted; `afterPress` reruns `renderRailNow` after click/cancel settlement. Keyboard-generated button clicks resolve directly. Keep the newest data by target while a detail view is open and dismiss if that target is removed. Do not modify the board gesture recognizer or invoke its paging functions.

- [ ] Run `bun test test/strip-quota-details.test.ts test/strip-rail.test.ts test/strip-action-sheet.test.ts test/strip-gesture-target.test.ts` and `bun run typecheck`. Test pure targeting and DOM content in Bun; verify real event propagation, Escape/outside-tap/focus, and pointer-update races in the browser in Task 7. Deliverable: each meter opens its own safe details without affecting sessions. Suggested commit: `feat: add read-only quota account details`.

### Task 7: Verify integrated rendering, document behavior, and record installed acceptance

**Files:** create `scripts/quota-preview.ts`; update `README.md`, `docs/assets/dealerboard-strip.png`, and synthetic fixtures under `test/fixtures/quota/`; add a concise implementation verification record at `docs/superpowers/plans/2026-09-08-multi-account-quota-verification.md` when executing.

**Interfaces:** Use production `reduceQuotaRead`, `renderRail`, `renderBoard`, card rendering, and detail components. The preview script is a synthetic harness with no live provider subprocesses or production-path writes. It builds a temporary browser entry with Bun, serves it on loopback, and imports the real stylesheet; it is not another hand-built HTML quota mockup.

- [ ] Make `bun scripts/quota-preview.ts` serve a full 2560 × 720 synthetic board/rail, print the loopback URL, and clean up its temporary generated assets on shutdown. Expose controls outside the screenshot canvas for density, account count, time advance, and these normalized scenarios: healthy; exhausted waiting account; auth required; unavailable with future reset; stale after reset; unknown reset; long scoped tags. Controls pass `quotaDensity` to the renderer and `now` to the model, without changing the application default.

- [ ] Use a real browser at 2560 × 720 to check comfortable with 2 Claude + 2 Codex + Kimi + GLM + Qwen, and compact with 4 Claude + 4 Codex + the same three singles. Include token chart and unread block. Test both normal and fullscreen rail padding. Assert the quota zone and each row/readout remain inside the rail and do not overlap; inspect screenshots because bounding boxes alone do not establish readability. Check `100%`, hours/minutes and days, maximum capped scoped labels, age cues, and `Sign in again` at both densities. No hidden accounts, rail scrolling, or automatic shrinking.

- [ ] Instantiate `createQuotaDetailsController` in the preview with the same getter, before-open, after-press, and render-deferral wiring as `main.ts`. Verify close/outside-tap/Escape, keyboard focus restoration after rail rerender, touch/mouse opening the correct account, and a countdown/snapshot update between pointer-down/up. While details are open, verify no board paging or session action occurs; after dismissal, existing board gestures still work. Check app bootstrap wiring in the Tauri development shell (`bun run dev:app`); the synthetic preview provides deterministic data and exercises the production controller rather than a second set of mock interaction handlers. Record which environment supplied each proof.

- [ ] Update README quota documentation: CodexBar all-account discovery; cswap saved sign-in recovery; numeric identity limitations and unknown Codex activity; countdown-first readout and source age; `QUOTA_DENSITY` location/default. Explain that v3 ignores old quota snapshots until recollection and the app/daemon must be installed together. Replace the README screenshot from the real renderer using only synthetic session/account data.

- [ ] Run the required repository gates once after the final changes:

  ```sh
  bun run typecheck
  bun run check
  bun run build:app
  cargo test --manifest-path app/src-tauri/Cargo.toml
  bun run bundle:app
  git diff --check
  ```

  `bun run check` includes Biome, the daemon/plugin build, and Bun tests; it does not exercise the Rust host or build the web frontend. The extra app gates above come from README. Record exit results and any concrete outstanding failures; do not claim installed success from these checks.

- [ ] Record the reviewable local result: source revision/diff, focused and required check results, both native-density screenshots, interaction results, and source-contract limitations. Suggested commit: `docs: verify and document multi-account quota rail`. Do not publish or install as part of merely drafting this plan.

- [ ] When installation is authorized, build/install both artifacts using the established commands:

  ```sh
  bun scripts/install-local.ts
  bun run install:app
  launchctl print "gui/$(id -u)/com.drewritter.dealerboard"
  ```

  Inspect the installers immediately before running them; the daemon installer also updates managed adapters, and the app installer replaces `/Applications/Dealerboard.app`. Verify daemon PID/executable path and app executable path against the newly built artifacts, not just successful installer output. Keep a copy of the prior published v3 snapshot for timestamp comparison without exporting raw upstream responses. Do not run a second source daemon against production paths.

- [ ] Observe normal scheduled collection with account selection unchanged. Record only numeric labels, opaque IDs, normalized issue, and per-account source timestamps from `quota-snapshot.json` across successive passes. Both Codex account timestamps must independently advance. Claude cached reads may remain unchanged within normal pacing; verify its 45-minute backstop against observed behavior. If the saved Claude account still requires sign-in, mark auth-state rendering passed and independent Claude refresh **incomplete** until renewed through cswap. Do not force a refresh or switch just to satisfy this test.

- [ ] Check comfortable typography and tap targets on the physical strip. Record integrated refresh and physical readability separately from automated/browser success. Larger account/provider combinations beyond the two accepted examples require another explicit capacity decision. Completion report must list any unresolved credential or physical-validation gate without calling the inactive-account refresh issue fixed.

## Coverage and completion checklist

| Spec requirement | Primary proof |
| --- | --- |
| v3-only contract; IDs/activity/health/timestamp validation | Task 1 contract tests |
| Codex labels/privacy/window normalization; partial exit results | Task 2 adapter tests |
| Independent retention, removals, timeouts, restart and atomic publication | Task 3 reconciliation/collector tests |
| Claude actionable auth and cached measurement preservation | Tasks 1 and 3 |
| Binding window/TTL/percentage consistency and honest stale/reset behavior | Task 4 clock-controlled tests |
| Inline layout, explicit density, color/type hierarchy and no sibling dimming | Task 5 DOM tests + Task 7 real-browser screenshots |
| Correct details, unknown activity, focus and gesture isolation | Task 6 model tests + Task 7 integrated interaction checks |
| No source identity/error leakage | Tasks 1–3 structured-output tests + Task 6 detail tests |
| Existing providers/session board/token behavior preserved | Existing regression suite + Task 7 application checks |
| Independent refresh with selected account unchanged | Task 7 installed observation |
| Physical readability/tap targets | Task 7 physical-strip acceptance |

The implementation is reviewable after local gates and browser evidence pass. Installed refresh and physical-strip acceptance remain separately recorded requirements; neither mockups nor tests with injected provider responses satisfy them.
