# Claude Quota One-Source & Per-Layer Staleness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the strip's Claude account rows from greying during normal operation: grouped Claude quota comes from exactly one source per situation (cswap when it reports ≥2 accounts, codexbar otherwise), and each dimming layer keys off a timestamp its own collector writes.

**Architecture:** The collector (`src/core/quota.ts`) reads cswap *before* the codexbar probe loop. A successful read with ≥2 accounts serves the claude snapshot entry itself — null ambient windows, `fetchedAt` stamped at the read — and skips the codexbar claude probe (and its widget-snapshot rescue) for that pass. A failed read with ≥2 retained accounts keeps the group and starves the stamp (no fallback probe, no restamp); with 0 or 1 retained accounts the codexbar fallback probe runs unchanged (settled contract, decisions.md 2026-08-27 01:43). The retained grouped accounts and their collector stamp are one atomic state — committed together only on a successful grouped read after the pass's last await, and populated by the legacy-snapshot seeding at daemon restart — so an aborted pass can never leave retained accounts without a published stamp. The strip view-model (`app/src/quota.ts`) collapses an account row's state to `ok | unavailable` (reading age never dims), and the rail (`app/src/rail.ts`) sets `data-state` on the grouped section from the ambient panel state so the group dims when dealerboard's own collector misses three 120s passes.

**Tech Stack:** TypeScript on Bun (`bun test`), no new dependencies. Strip webview is plain DOM (tests use `test/support/fake-dom`). Gates: `bun run typecheck` (root + app tsconfigs), biome, and CI's `bun run check`.

**Working directory:** all commands run from the worktree root `/Users/drewritter/projects/dealerboard/.worktrees/quota-account-staleness` (branch `wip/quota-account-staleness`). Pre-commit hooks (lefthook) run `biome check --write` on staged files plus `bun run typecheck` — let them run; never bypass.

**Spec authority:** `docs/superpowers/specs/2026-08-27-quota-account-staleness/spec.md` (ratified). Decisions log: `decisions.md` in the same directory. When in doubt, the spec wins over this plan.

## Global Constraints

Copied from the spec — every task implicitly obeys these:

- No change to non-claude providers (codex, kimi, zai, qwen): their collection path and `STALE_QUOTA_AGE_MS` semantics stay as they are.
- No change to the single-account / cswap-absent claude path: the ungrouped ambient panel keeps its codexbar probe and existing semantics.
- No upstream cswap or codexbar changes; no reading of cswap's private cache (`~/.claude-swap-backup/cache/usage.json`).
- No quota snapshot schema change — `src/quota-snapshot.ts` is untouched; `test/quota-snapshot.test.ts` stays green unchanged.
- No redesign of the account rows' layout, marker, or note text beyond what the state model requires.
- `usageStatus != "ok"` maps to `unavailable: true` via the existing parse in `src/core/claude-swap-quota.ts` — that file is untouched.
- `usageFetchedAt` is the authoritative per-account timestamp; `usageAgeSeconds` is ignored. Age affects only the note text on unavailable rows, never state.
- One failed `cswap list` pass dims rows immediately; one success clears it. No debounce.
- View-model logic stays DOM-free in `app/src/quota.ts`; rendering in `app/src/rail.ts`; collector in `src/core/quota.ts`.
- Existing failure-transition diagnostics (`quota_failed`, `quota_accounts_failed`) keep their codes, cadence, and payload-free contract.
- 0/1/≥2-retained failure contract (decisions.md 2026-08-27 01:43, folded into the spec's edge cases): failure with 0 or 1 retained accounts stays in fallback mode (codexbar probe runs, ungrouped panel, unchanged behavior); grouped starvation (no fallback probe, no restamp) applies only from ≥2 retained.
- Retained grouped accounts and their collector stamp are one atomic state: written together only on a successful grouped read, and populated by the legacy-snapshot seeding at daemon restart (the seeding block at `src/core/quota.ts:454`, unchanged). `readClaudeSwap` never mutates retention state.

## Interpretations (implementation decisions resolved from spec + code)

1. **[Settled by the notebook — cited for implementer context, not an open interpretation]** 0/1/≥2-retained failure contract: failure with 0 or 1 retained accounts stays in fallback mode (codexbar probe runs, ungrouped panel, unchanged behavior); grouped starvation (no fallback probe, no restamp) applies only from ≥2 retained accounts. Settled in decisions.md entry "2026-08-27 01:43 — Plan review round 1: NOT READY; 0/1/≥2-retained failure contract settled" and folded into the spec's edge cases. Task 4's tests implement this contract exactly. The same entry settles that retained accounts and their collector stamp are one atomic state, also populated by legacy-snapshot seeding at restart (see Task 3/4 design and the two abort/seed tests).
2. **The grouped entry carries the prior claude history ring frozen (no appends).** Spec: "The ambient claude history ring stops accumulating in grouped mode" — stops accumulating, not deleted; the ring is rendered nowhere, and carrying it costs nothing for a later return to the probe path. A cold-start grouped entry publishes `history: []`. (Endorsed in plan review round 1; pinned by Task 3's frozen-ring test.)
3. **Test surface (the spec's open question, tagged impl-detail):** extend the three existing files — `test/quota.test.ts` (collector harness), `test/strip-quota.test.ts` (view-model), `test/strip-rail.test.ts` (rail rendering). No new test files. `test/quota-claude-swap.test.ts` and `test/quota-snapshot.test.ts` are untouched (parser and schema unchanged). (Endorsed in plan review round 1.)
4. **The dead `.quota-account[data-state="stale"]` CSS selectors are removed** as part of collapsing the per-account state space (Task 1). Group-level dimming already exists via `.rail-quota[data-state=…]` and is untouched. (Endorsed in plan review round 1.)

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `app/src/quota.ts` | View-model: account meter state collapses to `ok \| unavailable` | 1 |
| `app/styles.css` | Remove dead per-account `stale` selectors | 1 |
| `test/strip-quota.test.ts` | View-model tests; layer-1 group-stale pin | 1, 2 |
| `app/src/rail.ts` | Rendering: grouped section carries `data-state` | 2 |
| `test/strip-rail.test.ts` | Rail rendering tests | 2 |
| `src/core/quota.ts` | Collector: cswap-first source selection, stamping, starvation | 3, 4 |
| `test/quota.test.ts` | Collector harness tests | 3, 4 |
| `src/core/claude-swap-quota.ts`, `src/quota-snapshot.ts` | Untouched (verified sufficient) | — |

Tasks 1–2 (strip app) and 3–4 (collector) are independent tracks; the listed order keeps the suite green after every task.

---

### Task 1: An account row dims only when cswap says its data is not good

**Goal:** a Claude account row's state is cswap's fetch health alone — its reading age (cswap's probe timestamp) never dims it.

**Files:**
- Modify: `app/src/quota.ts` (`QuotaAccountMeterModel` at line 41, `panelModel` at line 111)
- Modify: `app/styles.css` (the `.quota-account[data-state=…]` block, lines 789–794)
- Test: `test/strip-quota.test.ts`

**Interfaces:**
- Consumes: `ProviderQuotaAccount.unavailable` / `.fetchedAt` from `src/quota-snapshot.ts` (unchanged).
- Produces: `QuotaAccountMeterModel` with `state: QuotaAccountState` (`"ok" | "unavailable"`) — consumed by `quotaRenderModel`/`railRenderSignature` in `app/src/rail.ts` and by fixtures in `test/strip-rail.test.ts`. Both already use only `"ok"`/`"unavailable"` literals, so the narrowing is source-compatible.

- [ ] **Step 1: Write the failing test (and one pin)**

In `test/strip-quota.test.ts`, replace the existing test `"derives each account state from its own source instant"` (it asserts the age-based `"stale"` this task removes) with:

```ts
  test("an account row's state is cswap's fetch health — reading age never dims", () => {
    const oldFetch = new Date(NOW - STALE_QUOTA_AGE_MS - 1).toISOString();
    const panel = reduceQuotaRead(
      read({
        claude: quota({
          accounts: [
            quotaAccount({ fetchedAt: oldFetch }),
            quotaAccount({ id: "claude-swap:2", label: "2", active: true, unavailable: true }),
          ],
        }),
      }),
      NOW,
    )[0];
    expect(panel?.accounts.map((account) => account.state)).toEqual(["ok", "unavailable"]);
  });
```

Also add this pin in the same `describe("reduceQuotaRead", …)` block — it passes pre-change and must stay green (it locks the decision that exhaustion is quota truth, not a data-health state, so the collapsed state space never invents a dim for it):

```ts
  test("an exhausted seat (0% remaining, cswap healthy) stays bright", () => {
    const panel = reduceQuotaRead(
      read({
        claude: quota({
          accounts: [
            quotaAccount({ percentRemaining: 0 }),
            quotaAccount({ id: "claude-swap:2", label: "2", active: true }),
          ],
        }),
      }),
      NOW,
    )[0];
    expect(panel?.accounts.map((account) => account.state)).toEqual(["ok", "ok"]);
    expect(panel?.accounts[0]?.windows[0]?.percentRemaining).toBe(0);
  });
```

- [ ] **Step 2: Run tests to verify the red phase**

Run: `bun test test/strip-quota.test.ts`
Expected: `"an account row's state is cswap's fetch health…"` FAILS — the first account renders `"stale"` (its `fetchedAt` is older than `STALE_QUOTA_AGE_MS`), so the array is `["stale", "unavailable"]`. The exhausted-seat pin PASSES pre-change and must keep passing.

- [ ] **Step 3: Implement the collapsed state**

In `app/src/quota.ts`, replace the `QuotaAccountMeterModel` declaration:

```ts
export type QuotaAccountState = "ok" | "unavailable";

export type QuotaAccountMeterModel = Omit<QuotaMeterModel, "state"> & {
  id: string;
  label: string;
  active: boolean;
  /** cswap's fetch health only — the account's reading age never dims its row. */
  state: QuotaAccountState;
};
```

In `panelModel`, replace the accounts mapping (the `[...quota.accounts].sort(...).map(...)` chain) with:

```ts
          .map((account) => {
            const meter = meterModel(account, now);
            const state: QuotaAccountState = account.unavailable ? "unavailable" : "ok";
            return { id: account.id, label: account.label, active: account.active, ...meter, state };
          });
```

(`meterModel` keeps computing the account's `windows`, `bindingIndex`, and `fetchedAtMs` — the age still feeds the note text on unavailable rows via `formatBindingNote`; only `state` is overridden.)

In `app/styles.css`, delete the two now-unreachable stale selectors from the account dimming block, leaving:

```css
.quota-account[data-state="unavailable"] .quota-right,
.quota-account[data-state="unavailable"] .quota-bar {
  opacity: 0.45;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/strip-quota.test.ts test/strip-rail.test.ts`
Expected: PASS (strip-rail included — it consumes the narrowed type through fixtures that already use `"ok"`/`"unavailable"`).

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bunx biome check app/src/quota.ts app/styles.css test/strip-quota.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/quota.ts app/styles.css test/strip-quota.test.ts
git commit -m "fix(app): dim claude account rows only on cswap fetch failure"
```

---

### Task 2: The grouped section renders the ambient panel state

**Goal:** the grouped Claude section dims when dealerboard's collector goes quiet — `rail.ts` sets `data-state` on the grouped section from the panel state (today only the non-grouped branch does).

**Files:**
- Modify: `app/src/rail.ts` (`quotaSection`, lines 280–292)
- Test: `test/strip-rail.test.ts`, plus one layer-1 pin in `test/strip-quota.test.ts`

**Interfaces:**
- Consumes: `QuotaPanelModel.state` (unchanged `QuotaPanelState`) — for grouped claude this is the ambient meter's state derived from the claude snapshot entry's own `unavailable`/`fetchedAt` (the collector's stamp after Task 3).
- Produces: `section.dataset["state"]` on `.rail-quota.quota-group`; CSS `.rail-quota[data-state="stale"], .rail-quota[data-state="unavailable"] { opacity: 0.45 }` already dims the whole group. `railRenderSignature` already includes `panel.state` for every panel, so render-skip correctness is preserved.

- [ ] **Step 1: Write the failing test (and one pin)**

First, in `test/strip-quota.test.ts`, add the layer-1 pin inside `describe("reduceQuotaRead", …)` — it passes pre-change (`panelState` already implements the three-pass threshold) and locks the grouped-entry shape Tasks 3–4 will publish: the group goes stale exactly when the collector's stamp ages past `STALE_QUOTA_AGE_MS`, with an injected `now` (`NOW` is the clock argument to `reduceQuotaRead`):

```ts
  test("a grouped stamp older than three passes dims the group; a fresh stamp does not", () => {
    const groupedEntry = (fetchedAt: string) =>
      quota({
        percentRemaining: null,
        resetAt: null,
        weeklyPercentRemaining: null,
        weeklyResetAt: null,
        unavailable: false,
        fetchedAt,
        accounts: [quotaAccount(), quotaAccount({ id: "claude-swap:2", label: "2", active: true })],
      });
    const starved = reduceQuotaRead(
      read({ claude: groupedEntry(new Date(NOW - STALE_QUOTA_AGE_MS - 1).toISOString()) }),
      NOW,
    )[0];
    expect(starved?.state).toBe("stale");
    expect(starved?.accounts).toHaveLength(2);
    const fresh = reduceQuotaRead(read({ claude: groupedEntry(new Date(NOW).toISOString()) }), NOW)[0];
    expect(fresh?.state).toBe("ok");
  });
```

Then the red test — in `test/strip-rail.test.ts`, add after the `"maps grouped Claude to one provider and two stable account meters"` test:

```ts
test("the grouped section carries the ambient panel state", () => {
  withFakeDocument((root) => {
    renderRail(root as unknown as HTMLElement, model({ quota: [groupedClaude()] }), { onJumpToPage: () => {} });
    const group = descendants(root).find((node) => hasClass(node, "quota-group"));
    expect(group?.dataset["state"]).toBe("ok");
  });
  withFakeDocument((root) => {
    const stale = quotaPanel({ state: "stale", accounts: groupedClaude().accounts });
    renderRail(root as unknown as HTMLElement, model({ quota: [stale] }), { onJumpToPage: () => {} });
    const group = descendants(root).find((node) => hasClass(node, "quota-group"));
    expect(group?.dataset["state"]).toBe("stale");
    // The render-skip signature must see the group-level dim, or it would not rebuild.
    expect(railRenderSignature(model({ quota: [stale] }))).not.toBe(railRenderSignature(model({ quota: [groupedClaude()] })));
  });
});
```

- [ ] **Step 2: Run tests to verify the red phase**

Run: `bun test test/strip-rail.test.ts test/strip-quota.test.ts`
Expected: `"the grouped section carries the ambient panel state"` FAILS — the grouped branch never sets `data-state`, so `group?.dataset["state"]` is `undefined`, not `"ok"`. The layer-1 pin PASSES pre-change and must keep passing.

- [ ] **Step 3: Implement**

In `quotaSection` in `app/src/rail.ts`, move the state assignment out of the non-grouped branch so both branches carry it:

```ts
export const quotaSection = (panel: QuotaPanelModel, nowMs: number): HTMLElement => {
  const render = quotaRenderModel(panel);
  const section = document.createElement("section");
  section.className = render.grouped ? "rail-quota quota-group" : "rail-quota";
  section.dataset["provider"] = panel.provider;
  section.dataset["state"] = panel.state;
  if (!render.grouped) {
    section.append(quotaMeter(render.meter, nowMs, quotaProviderIdentity(panel.provider)));
    return section;
  }
  // … grouped branch unchanged below …
```

(i.e. delete the `section.dataset["state"] = panel.state;` line that currently sits inside the `if (!render.grouped)` block.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/strip-rail.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bunx biome check app/src/rail.ts test/strip-rail.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/rail.ts test/strip-rail.test.ts test/strip-quota.test.ts
git commit -m "fix(app): render ambient panel state on the grouped claude quota section"
```

---

### Task 3: A successful cswap read with ≥2 accounts serves claude and skips the codexbar probe

**Goal:** grouped Claude quota has one source — the collector reads cswap before the probe loop, skips the codexbar claude probe and its widget-snapshot rescue when the read succeeds with ≥2 accounts, publishes the claude entry with null ambient windows stamped at the read, and leaves the <2/absent fallback byte-identical to today.

**Files:**
- Modify: `src/core/quota.ts` (module-header comment lines 1–24; new `ClaudeSwapRead` type near `FetchOutcome` at line 354; `pollClaudeAccounts` at lines 512–536 becomes `readClaudeSwap`; `pollNow` at lines 612–669)
- Test: `test/quota.test.ts`

**Interfaces:**
- Consumes: `parseClaudeSwapAccounts`, `CLAUDE_SWAP_ARGS`, `CLAUDE_SWAP_EXEC_TIMEOUT_MS` from `src/core/claude-swap-quota.ts` (unchanged); the existing `claudeAccounts` retention state, `states` map, `reportAccountFailure`, `emptyQuota` (all unchanged).
- Produces: the grouped claude snapshot entry shape relied on by the app and by Task 4's starvation branch —

```ts
{
  percentRemaining: null, resetAt: null, weeklyPercentRemaining: null, weeklyResetAt: null,
  unavailable: false, fetchedAt: <collector stamp at the successful cswap read>,
  history: <prior claude ring, frozen>, extraWindows: [], accounts: <cswap rows>,
}
```

plus the **atomic-state contract** Task 4's starvation branch relies on: `readClaudeSwap` is a pure read — it never mutates the retention state (`claudeAccounts`). Retention rows and `states.get("claude")` are committed together in one synchronous block inside the grouped branch, after the pass's last await, so an aborted pass (exception contained by `pollNow`) can never leave ≥2 retained accounts without a published claude entry and stamp. The daemon-restart seeding block (`src/core/quota.ts:454`, unchanged) is the only other writer of this pair. This supersedes the round-1 design, which mutated retention inside `readClaudeSwap` before the grouped entry existed.

- [ ] **Step 1: Write the tests (four red, one abort-safety guard, one characterization pin)**

Add these inside `describe("createQuotaCollector", …)` in `test/quota.test.ts` (all fixtures/helpers they use already exist in the file). Each test is labeled with its expected red-phase status.

**RED — golden grouped entry, probe skip, and no widget rescue:**

```ts
  test("a successful cswap read with two accounts serves the claude entry and skips the codexbar claude probe", async () => {
    // A fresh claude widget entry proves the rescue path is not consulted either —
    // if it were, percentRemaining would be 90 instead of null.
    const widgetWithClaude = JSON.stringify({
      generatedAt: NOW,
      entries: [
        {
          provider: "claude",
          primary: { windowMinutes: 300, usedPercent: 10, resetsAt: null },
          secondary: { windowMinutes: 10080, usedPercent: 20, resetsAt: null },
          tertiary: null,
        },
      ],
    });
    const harness = makeHarness({ files: { [widgetPath(tempDir)]: widgetWithClaude } });
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    const expected = parseClaudeSwapAccounts(fixture("claude-swap-accounts.json"));
    if (expected.kind !== "ok") throw new Error("fixture must parse");
    expect(snapshot.providers["claude"]).toEqual({
      percentRemaining: null,
      resetAt: null,
      weeklyPercentRemaining: null,
      weeklyResetAt: null,
      unavailable: false,
      fetchedAt: NOW,
      history: [],
      extraWindows: [],
      accounts: expected.accounts,
    });
    expect(harness.calls.some((call) => call[2] === "claude")).toBe(false);
    expect(harness.claudeSwapCalls).toEqual([["list", "--json"]]);
  });
```

**RED — the cswap read precedes the probe loop (the stamp cadence tracks pass starts):**

```ts
  test("the cswap read precedes the provider probe loop", async () => {
    const sequence: string[] = [];
    const harness = makeHarness(
      {},
      {
        exec: (args) => {
          sequence.push(`codexbar:${args[2]}`);
          const name = FIXTURE_BY_PROVIDER[args[2] ?? ""];
          return Promise.resolve({ exitCode: 0, stdout: name === undefined ? "[]" : fixture(name) });
        },
        claudeSwapExec: () => {
          sequence.push("cswap");
          return Promise.resolve({ exitCode: 0, stdout: fixture("claude-swap-accounts.json") });
        },
      },
    );
    await createQuotaCollector(harness.deps).pollNow();
    expect(sequence[0]).toBe("cswap");
    expect(sequence.slice(1)).toEqual(["codexbar:codex", "codexbar:kimi", "codexbar:zai", "codexbar:alibabatokenplan"]);
  });
```

**RED — the stamp tracks each successful read, and the cold-start ring never grows:**

```ts
  test("each successful cswap read restamps the grouped entry; the history ring does not grow", async () => {
    let current = NOW;
    const harness = makeHarness({}, { now: () => current });
    const collector = createQuotaCollector(harness.deps);
    await collector.pollNow();
    let claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(claude?.fetchedAt).toBe(NOW);
    expect(claude?.history).toEqual([]);
    current = "2026-08-19T18:02:00.000Z";
    await collector.pollNow();
    claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(claude?.fetchedAt).toBe("2026-08-19T18:02:00.000Z");
    expect(claude?.history).toEqual([]);
  });
```

**RED — Interpretation 2 pin: a non-empty prior ring is carried through grouped publication, frozen (main appends to it, so this fails pre-change):**

```ts
  test("grouped publication carries the prior claude history ring frozen", async () => {
    const seeded = JSON.stringify({
      schemaVersion: 2,
      providers: {
        claude: {
          percentRemaining: 62.5,
          resetAt: "2026-08-19T22:00:00.000Z",
          weeklyPercentRemaining: 88,
          weeklyResetAt: "2026-08-24T00:00:00.000Z",
          unavailable: false,
          fetchedAt: "2026-08-19T17:58:00.000Z",
          history: [{ fetchedAt: "2026-08-19T17:58:00.000Z", fractionRemaining: 0.625 }],
          extraWindows: [],
          accounts: [],
        },
      },
    });
    const harness = makeHarness({ files: { [quotaPath]: seeded } });
    const collector = createQuotaCollector(harness.deps);
    await collector.pollNow();
    let claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(claude?.history).toEqual([{ fetchedAt: "2026-08-19T17:58:00.000Z", fractionRemaining: 0.625 }]);
    await collector.pollNow();
    claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(claude?.history).toEqual([{ fetchedAt: "2026-08-19T17:58:00.000Z", fractionRemaining: 0.625 }]);
  });
```

**GUARD — abort safety of the atomic state (expected PASS pre-change; must STAY PASS).** Main also passes it (its post-loop cswap read never runs in an aborted pass), and any implementation that commits retention before the pass's awaits settle will fail it — the aborted first pass would leave ≥2 retained rows with no claude entry, and the subsequent failure would vanish claude from the snapshot instead of falling back:

```ts
  test("an aborted first grouped pass leaves nothing retained — a later cswap failure falls back", async () => {
    let nowCalls = 0;
    const harness = makeHarness(
      {},
      {
        now: () => {
          nowCalls += 1;
          // Pass 1: the widget parse (call 1) and the cswap stamp (call 2)
          // succeed; the probe loop's first stamp (codex) explodes and the
          // pass aborts before the grouped commit.
          if (nowCalls === 3 || nowCalls === 4) {
            throw new Error("clock exploded");
          }
          return NOW;
        },
      },
    );
    const collector = createQuotaCollector(harness.deps);
    await collector.pollNow(); // aborts after the cswap read, before any commit
    expect(harness.writes().length).toBe(0);

    harness.failClaudeSwap();
    await collector.pollNow();
    const claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(harness.calls.some((call) => call[2] === "claude")).toBe(true);
    expect(claude).toMatchObject({ percentRemaining: 80, unavailable: false });
    expect(claude?.accounts).toEqual([]);
  });
```

(Call 4 is the contained-catch diagnostic's `now()`, which must also land in the throw window so the containment path itself is exercised.)

**CHARACTERIZATION PIN — expected PASS before AND after the change.** It records today's fallback bytes so the refactor preserves them; it is not a failing test:

```ts
  test("below two accounts the claude entry stays byte-identical to today's codexbar shape", async () => {
    const harness = makeHarness();
    const collector = createQuotaCollector(harness.deps);

    harness.setClaudeSwap(JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: [] }));
    await collector.pollNow();
    let claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(harness.calls.filter((call) => call[2] === "claude")).toHaveLength(1);
    expect(claude).toEqual({
      percentRemaining: 80,
      resetAt: "2030-01-01T05:00:00.000Z",
      weeklyPercentRemaining: 40,
      weeklyResetAt: "2030-01-08T00:00:00.000Z",
      unavailable: false,
      fetchedAt: NOW,
      history: [{ fetchedAt: NOW, fractionRemaining: 0.8 }],
      extraWindows: [
        {
          id: "claude-weekly-scoped-fable",
          label: "Fable only",
          percentRemaining: 70,
          resetAt: "2030-01-15T00:00:00.000Z",
        },
      ],
      accounts: [],
    });

    harness.setClaudeSwap(
      JSON.stringify({
        schemaVersion: 1,
        activeAccountNumber: 1,
        accounts: [
          {
            number: 1,
            usageStatus: "ok",
            usageFetchedAt: "2026-08-19T17:00:00Z",
            usage: {
              fiveHour: { pct: 30, resetsAt: "2026-08-19T22:00:00Z" },
              sevenDay: { pct: 60, resetsAt: "2026-08-24T00:00:00Z" },
            },
          },
        ],
      }),
    );
    await collector.pollNow();
    claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(harness.calls.filter((call) => call[2] === "claude")).toHaveLength(2);
    expect(claude?.percentRemaining).toBe(80);
    expect(claude?.fetchedAt).toBe(NOW);
    expect(claude?.accounts).toEqual([
      {
        id: "claude-swap:1",
        label: "1",
        active: true,
        percentRemaining: 70,
        resetAt: "2026-08-19T22:00:00.000Z",
        weeklyPercentRemaining: 40,
        weeklyResetAt: "2026-08-24T00:00:00.000Z",
        unavailable: false,
        fetchedAt: "2026-08-19T17:00:00.000Z",
        extraWindows: [],
      },
    ]);
  });
```

- [ ] **Step 2: Run tests to verify the red phase**

Run: `bun test test/quota.test.ts`
Expected, exactly:
- FAIL: the four RED tests. The golden test fails because the claude entry today carries the codexbar ambient windows (`percentRemaining: 80`) and the probe runs; the ordering test fails because main spawns `codexbar:claude` first and reads cswap last; the restamp test fails on the history ring (main appends one point per claude probe success); the frozen-ring test fails because main appends to the seeded ring.
- PASS: the abort-safety guard and the fallback characterization pin — both characterize behavior main already has; they exist to catch regressions in the new implementation (the guard pins the atomic-state contract, the pin freezes today's fallback bytes).

Some pre-existing tests also begin to fail once the implementation lands; they are updated in Step 3.

- [ ] **Step 3: Implement source selection in the collector**

In `src/core/quota.ts`:

**(a)** Add the read-result type beside `FetchOutcome` (line 354). A failed read carries no accounts — retention is not the reader's business:

```ts
type ClaudeSwapRead =
  | { kind: "ok"; accounts: ProviderQuota["accounts"]; at: string }
  | { kind: "failed" }
  | { kind: "absent" };
```

**(b)** Replace `pollClaudeAccounts` (lines 512–536) with `readClaudeSwap` — a **pure read**: unlike the round-1 design it never touches `claudeAccounts`; all retention mutation moves into `pollNow`'s synchronous assembly (step (c)), which is what makes the atomic-state contract hold. If `now()` throws while taking the stamp, nothing has been mutated yet and `pollNow`'s containment sees a clean state:

```ts
  /** Pure read — pollNow commits the retention state, never this function. */
  const readClaudeSwap = async (exec: QuotaExec | null): Promise<ClaudeSwapRead> => {
    if (exec === null) {
      return { kind: "absent" };
    }
    let result: QuotaExecResult;
    try {
      result = await exec([...CLAUDE_SWAP_ARGS], CLAUDE_SWAP_EXEC_TIMEOUT_MS);
    } catch {
      result = { exitCode: -1, stdout: "" };
    }
    if (result.exitCode !== 0) {
      return { kind: "failed" };
    }
    const parsed = parseClaudeSwapAccounts(result.stdout);
    if (parsed.kind !== "ok") {
      return { kind: "failed" };
    }
    return { kind: "ok", accounts: parsed.accounts, at: now() };
  };
```

**(c)** In `pollNow`, replace everything from `const providers: …` through the existing claude merge block (`const accounts = await pollClaudeAccounts(...)` … `providers["claude"] = { ...emptyQuota(), accounts };`) with the block below. The atomicity rule (spec, edge cases): claude's two state halves — `claudeAccounts` and `states["claude"]` — commit with no `await` between computing them and writing them. The cswap read stays FIRST (its stamp tracks pass starts), but claude's state resolution moves to AFTER every other provider's await: an abort in the four-provider loop then leaves both halves exactly as the previous pass did, and in the fallback branch the claude probe is the pass's final await with a purely synchronous continuation (`reportAccountFailure` contains its own exceptions):

```ts
      // Claude quota has one source per situation: the cswap read runs before
      // the probe loop, and a successful read with ≥2 accounts serves the
      // grouped entry and skips the codexbar claude probe for this pass.
      // Claude's STATE resolves after every other await — nothing may abort
      // between computing claude's next state and committing both its halves.
      const swapRead = await readClaudeSwap(resolveClaudeSwapExec());
      const providers: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
      for (const provider of QUOTA_PROVIDER_KEYS) {
        if (provider === "claude") {
          continue; // resolved below, after the other providers' awaits
        }
        const quota = await pollProvider(exec, provider, widget);
        if (quota !== null) {
          providers[provider] = quota;
        }
      }
      if (swapRead.kind === "ok" && swapRead.accounts.length >= 2) {
        // Atomic commit — retained rows and the entry carrying their collector
        // stamp land together, after the pass's last await, so an aborted pass
        // can never leave the two halves inconsistent.
        claudeAccounts = { accounts: swapRead.accounts, failed: false };
        const quota: ProviderQuota = {
          percentRemaining: null,
          resetAt: null,
          weeklyPercentRemaining: null,
          weeklyResetAt: null,
          unavailable: false,
          fetchedAt: swapRead.at,
          // The ambient history ring stops accumulating in grouped mode; the
          // carried ring stays frozen for a later return to the probe path.
          history: states.get("claude")?.quota.history ?? [],
          extraWindows: [],
          accounts: swapRead.accounts,
        };
        states.set("claude", { quota, failed: false });
        providers["claude"] = quota;
      } else {
        // Not grouped this pass — cswap absent, <2 accounts reported, or a
        // failed read (any retention count in this task): claude stays on the
        // codexbar probe. The probe is the final await; everything from its
        // return to the paired retention update is synchronous.
        const ambient = await pollProvider(exec, "claude", widget);
        if (swapRead.kind === "failed") {
          if (!claudeAccounts.failed) {
            reportAccountFailure();
          }
          claudeAccounts = {
            accounts: claudeAccounts.accounts.map((account) => ({ ...account, unavailable: true })),
            failed: true,
          };
        } else {
          claudeAccounts = { accounts: swapRead.kind === "absent" ? [] : swapRead.accounts, failed: false };
        }
        if (ambient !== null) {
          providers["claude"] = { ...ambient, accounts: claudeAccounts.accounts };
        } else if (claudeAccounts.accounts.length > 0) {
          providers["claude"] = { ...emptyQuota(), accounts: claudeAccounts.accounts };
        }
      }
```

Leave the `orderedProviders` rebuild, JSON publication, catch, and finally blocks of `pollNow` exactly as they are — snapshot publication order is unchanged (the rebuild walks `QUOTA_PROVIDER_KEYS`), even though claude now PROBES last; any existing test pinning the order of `harness.calls` entries gets its expectation updated in (e) (counts are unchanged). Also leave the daemon-restart seeding block (line 454 area) untouched — it already seeds `claudeAccounts` and `states` together from the same snapshot, which is the second writer of the atomic state. Note the failure path intentionally still flows through the `else` (probe runs, today's behavior) — Task 4 carves out grouped starvation.

**(d)** Update the module-header comment (lines 1–24), which currently says all five providers are probed through CodexBar every pass — after this task that is false for claude while grouped. Replace:

```ts
 * All five providers are read through the locally installed CodexBar CLI:
 * `codexbar usage --provider <arg> --format json --log-level critical`,
 * spawned once per provider per pass (serialized — CodexBar's app-support
 * directory carries lock files). The provider argument is the contract key
```

with:

```ts
 * All five providers are read through the locally installed CodexBar CLI:
 * `codexbar usage --provider <arg> --format json --log-level critical`,
 * spawned once per provider per pass (serialized — CodexBar's app-support
 * directory carries lock files). Claude is excepted while claude-swap serves
 * the grouped two-account view: cswap is then claude's only source and the
 * CodexBar claude probe is skipped for that pass (readClaudeSwap). The
 * provider argument is the contract key
```

**(e)** Update the pre-existing tests in `test/quota.test.ts` that the new grouped shape breaks (exact replacements):

In `"publishes all five providers in contract order after successful runs"`:

```ts
    expect(snapshot.providers["claude"]).toMatchObject({
      percentRemaining: null,
      weeklyPercentRemaining: null,
      unavailable: false,
      fetchedAt: NOW,
    });
    expect(snapshot.providers["claude"]?.history).toEqual([]);
```

and (same test) replace the `harness.calls` expectation:

```ts
    // Grouped claude is served by the cswap read — no codexbar claude probe.
    expect(harness.calls).toEqual(
      (["codex", "kimi", "zai", "qwen"] as const).map((provider) => [
        "usage",
        "--provider",
        CODEXBAR_PROVIDER_ARGS[provider],
        "--format",
        "json",
        "--log-level",
        "critical",
      ]),
    );
```

Rename `"publishes claude-swap accounts without changing the five CodexBar calls"` to `"publishes claude-swap accounts without touching the codexbar claude probe"` and replace its call assertions:

```ts
    expect(harness.calls.length).toBe(4);
    expect(harness.calls.some((call) => call[2] === "claude")).toBe(false);
```

Replace the whole `"account success survives ambient Claude failure and ambient success survives account failure"` test with:

```ts
  test("a grouped claude entry ignores the ambient probe; a failed cswap read still dims the rows", async () => {
    const harness = makeHarness();
    const collector = createQuotaCollector(harness.deps);
    harness.fail("claude"); // the grouped pass never runs this probe
    await collector.pollNow();
    let claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(claude?.unavailable).toBe(false);
    expect(claude?.fetchedAt).toBe(NOW);
    expect(claude?.accounts.length).toBe(2);

    harness.heal("claude");
    harness.failClaudeSwap();
    await collector.pollNow();
    claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(claude?.unavailable).toBe(false);
    expect(claude?.accounts.every((account) => account.unavailable)).toBe(true);
  });
```

Replace the whole `"synthesizes ambient Claude only when accounts exist and CodexBar omits Claude"` test with (the synthesis path now only exists below two accounts):

```ts
  test("synthesizes ambient Claude only when fewer than two accounts exist and CodexBar omits Claude", async () => {
    const harness = makeHarness();
    harness.omit("claude");
    harness.setClaudeSwap(
      JSON.stringify({
        schemaVersion: 1,
        activeAccountNumber: 1,
        accounts: [{ number: 1, usageStatus: "token_expired" }],
      }),
    );
    await createQuotaCollector(harness.deps).pollNow();
    const claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(claude).toMatchObject({ percentRemaining: null, unavailable: true });
    expect(claude?.accounts).toHaveLength(1);
  });
```

In `"a failed run keeps last-good data, marks unavailable, and logs only the transition"`, retarget from claude to codex (claude no longer fails through the probe loop while grouped):

```ts
    harness.fail("codex", "zai");
    await collector.pollNow();
    await collector.pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? ""));
    expect(snapshot.providers["codex"]).toMatchObject({ percentRemaining: 70, unavailable: true, fetchedAt: NOW });
    expect(snapshot.providers["codex"]?.history.length).toBe(1);
    expect(snapshot.providers["kimi"]?.unavailable).toBe(false);
    const failures = harness.diagnostics.filter((record) => record.code === "quota_failed");
    expect(failures.map((record) => record.provider).sort()).toEqual(["codex", "zai"]);
    expect(failures.every((record) => record.component === "quota")).toBe(true);
```

In `"a cold-start failure emits quota_failed once per provider, not per pass, and again after recovery"`, probe-fail the four non-claude providers and assert claude stays out of the diagnostics:

```ts
    // Grouped claude is served by cswap and never fails through the probe loop.
    const PROBING_PROVIDERS = ["codex", "kimi", "zai", "qwen"] as const;
    harness.fail(...PROBING_PROVIDERS);
    await collector.pollNow(); // first pass from cold start
    await collector.pollNow(); // repeated failure — no new records
    expect(failures().length).toBe(4);
    expect(new Set(failures().map((record) => record.provider))).toEqual(new Set(PROBING_PROVIDERS));
    expect(failures().every((record) => record.provider !== "claude")).toBe(true);
    harness.heal(...PROBING_PROVIDERS);
    await collector.pollNow(); // recovery emits nothing
    expect(failures().length).toBe(4);
    harness.fail(...PROBING_PROVIDERS);
    await collector.pollNow(); // recovery → failure is a new transition
    expect(failures().length).toBe(8);
```

In `"a nonzero exit and unparseable stdout degrade to unavailable without escaping pollNow"`, point the garbage response at kimi instead of claude:

```ts
    harness.respondRaw("kimi", { exitCode: 0, stdout: "garbage" });
    await collector.pollNow();
    const second = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? ""));
    expect(second.providers["kimi"]?.unavailable).toBe(true);
    expect(second.providers["codex"]?.unavailable).toBe(false);
```

In `"concurrent pollNow calls collapse into one pass"`: `expect(harness.calls.length).toBe(4);`

In `"seeding from an existing file preserves last-good data across a restart"`, make cswap absent so the test keeps exercising the fallback-probe failure path it was written for:

```ts
    const harness = makeHarness({ binaryPresent: true, claudeSwapBinaryPresent: false, files: { [quotaPath]: seeded } });
```

In `"extra rate windows publish with provider-stripped labels; selected windows stay out"`, replace the claude extra-windows expectation:

```ts
    // Grouped claude is served by the cswap read; its ambient windows don't publish.
    expect(snapshot.providers["claude"]?.extraWindows).toEqual([]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/quota.test.ts`
Expected: PASS — all new and updated tests green. Then run `bun test` to confirm the rest of the suite (including `test/quota-claude-swap.test.ts`, `test/quota-snapshot.test.ts`, `test/strip-quota.test.ts`, `test/strip-rail.test.ts`) is untouched and green.

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bunx biome check src/core/quota.ts test/quota.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/quota.ts test/quota.test.ts
git commit -m "feat(quota): serve grouped claude from cswap and skip the codexbar probe"
```

---

### Task 4: A failed cswap read keeps the group and starves the stamp

**Goal:** when the cswap read fails with ≥2 retained accounts, the collector keeps the group — rows dim via the existing unavailable marking, the claude entry keeps its last successful stamp (no restamp), and neither the codexbar claude probe nor the widget-snapshot rescue runs; with 0 or 1 retained accounts the fallback probe runs as today (settled 0/1/≥2 contract, decisions.md 2026-08-27 01:43).

**Files:**
- Modify: `src/core/quota.ts` (`pollNow` only)
- Test: `test/quota.test.ts`

**Interfaces:**
- Consumes: `readClaudeSwap` / the grouped entry / `states` / the atomic-state contract from Task 3 — retention reaches ≥2 only via the grouped commit or the restart seeding, both of which populate `states.get("claude")`, so the starvation branch's `previous` lookup is type-guarded but never empty in practice.
- Produces: the starved-pass claude entry — the previous pass's claude entry verbatim plus retained accounts marked `unavailable: true` (same `fetchedAt`, same `unavailable: false`, no widget rescue). This is what ages the group into `stale` via the view-model's existing `panelState` after three missed passes.

- [ ] **Step 1: Write the tests (two red, one characterization guard)**

In `test/quota.test.ts`, replace the whole `"widget fallback is ambient-only"` test (its premise — a widget rescue for claude while accounts are retained — is the behavior this task removes) with the RED starvation test. Note the setup fails the claude codexbar probe too: pre-change, that is exactly what makes the widget rescue fire (the probe fails, so the rescue is consulted), which is the behavior under test:

```ts
  test("a failed cswap read keeps the group and starves the stamp — no probe, no widget rescue", async () => {
    // A fresh claude widget entry proves the rescue is not consulted — if it
    // were, percentRemaining would be 90 instead of null.
    const widget = JSON.stringify({
      generatedAt: NOW,
      entries: [
        {
          provider: "claude",
          primary: { windowMinutes: 300, usedPercent: 10, resetsAt: null },
          secondary: null,
          tertiary: null,
        },
      ],
    });
    let current = NOW;
    const harness = makeHarness({ files: { [widgetPath(tempDir)]: widget } }, { now: () => current });
    const collector = createQuotaCollector(harness.deps);
    await collector.pollNow();
    const callsAfterFirstPass = harness.calls.length;

    current = "2026-08-19T18:02:00.000Z";
    harness.failClaudeSwap();
    harness.fail("claude"); // pre-change this sends the pass into the widget rescue
    await collector.pollNow();
    const claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(claude).toMatchObject({ percentRemaining: null, unavailable: false, fetchedAt: NOW });
    expect(claude?.accounts.every((account) => account.unavailable)).toBe(true);
    expect(harness.calls.length).toBe(callsAfterFirstPass + 4); // codex, kimi, zai, qwen only
    expect(harness.diagnostics.filter((record) => record.code === "quota_failed")).toEqual([]);
    expect(harness.diagnostics.filter((record) => record.code === "quota_accounts_failed")).toHaveLength(1);

    current = "2026-08-19T18:04:00.000Z";
    harness.healClaudeSwap();
    harness.heal("claude");
    await collector.pollNow();
    const healed = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    const expected = parseClaudeSwapAccounts(fixture("claude-swap-accounts.json"));
    if (expected.kind !== "ok") throw new Error("fixture must parse");
    expect(healed?.unavailable).toBe(false);
    expect(healed?.fetchedAt).toBe("2026-08-19T18:04:00.000Z");
    // The blanket command-failure marking clears: the rows return exactly to
    // the parser's per-seat health — seat 2's own usageStatus "unavailable"
    // in the fixture stays unavailable, seat 1 becomes available again.
    expect(healed?.accounts).toEqual(expected.accounts);
  });
```

**RED — a legacy grouped seed whose first new read fails enters starvation with the seeded stamp** (the seeding half of the atomic state; pre-change the fallback probe runs and restamps, so this fails):

```ts
  test("a legacy grouped seed whose first new read fails starves with the seeded stamp", async () => {
    const seedStamp = "2026-08-19T17:50:00.000Z";
    const seededAccounts = parseClaudeSwapAccounts(fixture("claude-swap-accounts.json"));
    if (seededAccounts.kind !== "ok") throw new Error("fixture must parse");
    const seeded = parseQuotaSnapshot({
      schemaVersion: 2,
      providers: {
        claude: {
          percentRemaining: 62.5,
          resetAt: "2026-08-19T22:00:00.000Z",
          weeklyPercentRemaining: 88,
          weeklyResetAt: "2026-08-24T00:00:00.000Z",
          unavailable: false,
          fetchedAt: seedStamp,
          history: [],
          extraWindows: [],
          accounts: seededAccounts.accounts,
        },
      },
    });
    const harness = makeHarness(
      { files: { [quotaPath]: JSON.stringify(seeded) } },
      { claudeSwapExec: () => Promise.resolve({ exitCode: 1, stdout: "private failure text" }) },
    );
    await createQuotaCollector(harness.deps).pollNow();
    const claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(claude?.fetchedAt).toBe(seedStamp);
    expect(claude?.percentRemaining).toBe(62.5);
    expect(claude?.unavailable).toBe(false);
    expect(claude?.accounts).toEqual(seededAccounts.accounts.map((account) => ({ ...account, unavailable: true })));
    expect(harness.calls.some((call) => call[2] === "claude")).toBe(false);
    expect(harness.diagnostics.filter((record) => record.code === "quota_accounts_failed")).toHaveLength(1);
  });
```

**RED — a legacy seed persisted with `unavailable: true` starves with the flag canonicalized false** (same seed shape as the previous test but `unavailable: true` and the same valid stamp; pre-change the fallback probe restamps, and a naive starvation would republish `unavailable: true`, dimming the group forever):

```ts
  test("a legacy unavailable seed starves with unavailable canonicalized false", async () => {
    // Seed exactly as in the previous test, but with unavailable: true.
    ...
    await createQuotaCollector(harness.deps).pollNow();
    const claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(claude?.fetchedAt).toBe(seedStamp);
    expect(claude?.unavailable).toBe(false); // canonicalized — group health rides the stamp's age
    expect(claude?.accounts.every((account) => account.unavailable)).toBe(true);
    expect(harness.calls.some((call) => call[2] === "claude")).toBe(false);
  });
```

**GUARD — a null-stamp legacy seed takes the fallback probe, not starvation** (a pre-change snapshot merged over `emptyQuota()` can persist ≥2 accounts with `fetchedAt: null`; expected PASS after Task 3 alone AND after Task 4 — it exists to fail a Task 4 implementation that omits the usable-stamp condition):

```ts
  test("a legacy seed without a usable stamp falls back to the codexbar probe", async () => {
    // Seed ≥2 accounts under an emptyQuota()-shaped claude entry: fetchedAt
    // null, unavailable true, null windows.
    ...
    harness.failClaudeSwap();
    await createQuotaCollector(harness.deps).pollNow();
    const claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(harness.calls.some((call) => call[2] === "claude")).toBe(true); // probe ran
    expect(claude?.percentRemaining).toBe(80); // honest ambient data under the retained rows
    expect(claude?.fetchedAt).toBe(NOW);
    expect(claude?.accounts.every((account) => account.unavailable)).toBe(true);
  });
```

**RED — an aborted de-grouping pass cannot desync retention from the published group** (the round-2 review's regression: pre-Task-3-restructure, claude probed first, so a pass that de-groups and then aborts left `states["claude"]` ambient while retention stayed grouped; the claude-last structure must make the abort leave both halves untouched). Requires a small harness affordance: make ONE designated provider exec reject (throw) — a thrown exec models the unexpected abort `pollNow`'s catch contains, which a plain failure outcome does not:

```ts
  test("an aborted de-grouping pass cannot desync retention from the published group", async () => {
    const harness = makeHarness();
    const collector = createQuotaCollector(harness.deps);
    await collector.pollNow(); // pass 1: grouped from the fixture's two accounts
    const grouped = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    harness.setClaudeSwap(/* one-account response, as in the fallback guard test */);
    harness.throwOnce("kimi"); // pass 2 aborts inside the four-provider loop, before claude resolution
    await collector.pollNow(); // contained by pollNow's catch; nothing published, claude untouched
    const passThreeStart = harness.calls.length;
    harness.failClaudeSwap();
    await collector.pollNow(); // pass 3: failed read against still-consistent grouped state
    const claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(claude?.fetchedAt).toBe(grouped?.fetchedAt); // starvation, no restamp
    expect(claude?.accounts.map((account) => account.id)).toEqual(grouped?.accounts.map((account) => account.id));
    expect(claude?.accounts.every((account) => account.unavailable)).toBe(true);
    expect(harness.calls.slice(passThreeStart).some((call) => call[2] === "claude")).toBe(false);
  });
```

**CHARACTERIZATION GUARD — expected PASS before AND after the change** (it pins the 0/1-retained fallback half of the settled contract; both main and the Task 3 implementation already behave this way):

```ts
  test("a failed cswap read with fewer than two retained accounts falls back to the codexbar claude probe", async () => {
    const harness = makeHarness();
    const collector = createQuotaCollector(harness.deps);
    harness.failClaudeSwap();
    await collector.pollNow(); // cold start: nothing retained
    let claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(harness.calls.some((call) => call[2] === "claude")).toBe(true);
    expect(claude).toMatchObject({ percentRemaining: 80, unavailable: false });
    expect(claude?.accounts).toEqual([]);

    harness.healClaudeSwap();
    harness.setClaudeSwap(
      JSON.stringify({
        schemaVersion: 1,
        activeAccountNumber: 1,
        accounts: [
          {
            number: 1,
            usageStatus: "ok",
            usageFetchedAt: "2026-08-19T17:00:00Z",
            usage: { fiveHour: { pct: 30 } },
          },
        ],
      }),
    );
    await collector.pollNow(); // one account: fallback territory
    harness.failClaudeSwap();
    await collector.pollNow(); // failed with one retained account: still fallback
    claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(harness.calls.filter((call) => call[2] === "claude").length).toBe(3);
    expect(claude?.percentRemaining).toBe(80);
    expect(claude?.accounts).toHaveLength(1);
    expect(claude?.accounts[0]?.unavailable).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify the red phase**

Run: `bun test test/quota.test.ts`
Expected, exactly:
- FAIL: `"a failed cswap read keeps the group and starves the stamp…"` — pre-change (with Task 3 landed) the failed pass still runs the claude probe; the test fails that probe on purpose, so the widget rescue fires and the claude entry reads `percentRemaining: 90` with `fetchedAt` restamped to 18:02, where the test expects `null` and the original stamp. The call count (5 instead of +4) also fails.
- FAIL: `"a legacy grouped seed whose first new read fails starves with the seeded stamp"` — pre-change the fallback probe runs and restamps (`fetchedAt` becomes `NOW`, `percentRemaining` becomes 80 from the probe fixture instead of the seeded 62.5).
- FAIL: `"a legacy unavailable seed starves with unavailable canonicalized false"` — pre-change the fallback probe restamps, same as above.
- FAIL: `"an aborted de-grouping pass cannot desync retention from the published group"` — with Task 3 landed this red-phase claim holds only for the STARVATION expectations (pass 3 probes and restamps pre-Task-4); the abort-consistency half is already guaranteed by Task 3's claude-last structure.
- PASS: the 0/1-retained fallback characterization guard — it pins the settled contract against over-skipping and must stay green.
- PASS: `"a legacy seed without a usable stamp falls back to the codexbar probe"` — green after Task 3 alone; it exists to fail a Task 4 that omits the usable-stamp condition, so it MUST still be green after Step 3.

- [ ] **Step 3: Implement starvation**

In `pollNow` in `src/core/quota.ts`, make two changes. Retention counts for a FAILED read come from `claudeAccounts` (the read itself carries no accounts — `readClaudeSwap` is pure):

**(a)** The probe loop needs no change — Task 3 already removed claude from it unconditionally. Starvation is carved into the claude resolution step instead. Its condition (settled contract, decisions.md): a FAILED read with ≥2 retained accounts AND a usable stamp — `states.get("claude")?.quota.fetchedAt` non-null. A legacy seed without a usable stamp (a pre-change snapshot merged over `emptyQuota()` can persist ≥2 accounts with `fetchedAt: null`) takes the fallback probe instead: with nothing to age, starvation would render a permanently null-stamped group, while the probe at least serves honest ambient data under the retained rows.

**(b)** Insert the starvation branch between Task 3's grouped branch and its fallback `else` (which still handles absence, <2 reported, and failure below the starvation conditions, exactly as in Task 3 — including its awaited claude probe; the starvation branch itself contains no await):

```ts
      } else if (
        swapRead.kind === "failed" &&
        claudeAccounts.accounts.length >= 2 &&
        states.get("claude")?.quota.fetchedAt != null
      ) {
        // Grouped starvation — settled contract (decisions.md 2026-08-27
        // 01:43): from ≥2 retained with a usable stamp, no fallback probe
        // runs and the stamp is not restamped, so a persistent failure ages
        // the group stale while a transient one only dims the rows for one
        // pass. unavailable is canonicalized false — group health rides the
        // stamp's age, and a legacy seed persisted with unavailable: true
        // must not dim the group forever.
        if (!claudeAccounts.failed) {
          reportAccountFailure();
        }
        claudeAccounts = {
          accounts: claudeAccounts.accounts.map((account) => ({ ...account, unavailable: true })),
          failed: true,
        };
        // The stamp condition above guarantees the entry exists; the guard
        // satisfies the Map lookup's type.
        const previous = states.get("claude");
        if (previous !== undefined) {
          const quota: ProviderQuota = {
            ...previous.quota,
            unavailable: false,
            accounts: claudeAccounts.accounts,
          };
          states.set("claude", { quota, failed: previous.failed });
          providers["claude"] = quota;
        }
      } else {
```

The failure-marking lines duplicate the fallback branch's deliberately — both branches own their retention transition, and no shared helper is worth the coupling for two call sites.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/quota.test.ts`
Expected: PASS. Notably, `"preserves last-good accounts and logs only healthy-to-failed transitions"` and `"seeds last-good accounts across daemon restart"` stay green unchanged (they assert accounts and diagnostics, which starvation preserves). Then run `bun test` for the full suite.

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bunx biome check src/core/quota.ts test/quota.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/quota.ts test/quota.test.ts
git commit -m "fix(quota): keep the claude group and starve its stamp when cswap fails"
```

---

### Task 5: Full verification against the spec's state rendering contract

**Goal:** prove the whole change with the repository's own gates and hand Drew a physical-strip checklist for the parts tests cannot see.

**Files:** none (verification only — no code changes; if anything fails, fix within the owning task's files and re-run).

- [ ] **Step 1: Run the CI gate**

Run: `bun run check`
Expected: PASS (biome ci, full build including typecheck, entire `bun test` suite).

- [ ] **Step 2: Build the app bundle**

Run: `bun run build:app`
Expected: PASS — the strip webview bundle compiles with the rail/quota changes.

- [ ] **Step 3: Walk the state rendering contract**

Verify each code path against the spec's contract table (rows 1–6 map to tests as noted; row 7 is the untouched fallback):

| Contract row | Covered by |
| --- | --- |
| Healthy, readings on cswap's schedule → group bright, rows bright | Task 3 golden test + Task 1 test (`ok` despite age) |
| One seat failing (`usageStatus != "ok"`) → row dims + age note | `test/quota-claude-swap.test.ts` (unchanged mapping) + Task 1 test + existing `formatBindingNote` tests |
| Whole `cswap list` failing this pass → group bright, both rows dim | Task 4 starvation test (stamp ≤3 passes old) |
| `cswap list` failing ≥3 passes / collector dead → group dims | Task 2 (data-state) + Task 2 layer-1 pin (starved stamp ages past `STALE_QUOTA_AGE_MS` → `stale`) |
| Seat exhausted → bright, bar says it | Task 1 exhausted-seat pin (0% remaining, `usageStatus ok` → state `ok`) |
| cswap failing from the very first pass (nothing ever retained) → codexbar fallback, ungrouped panel | Task 4 fallback characterization guard (0 and 1 retained) + existing cold-start tests |
| <2 accounts → ungrouped, unchanged | Task 3 byte-identity pin test |

- [ ] **Step 4: Physical-strip acceptance receipt — REQUIRED**

The spec's golden-question checklist mandates on-device verification of the dimmed-group vs dimmed-row treatments; tests cannot see them. This step is an acceptance receipt, not a suggestion. Install the ACTUAL changed artifacts first — the daemon and the app install separately (README "Install"):

```bash
bun run check                    # source gate
bun scripts/install-local.ts     # daemon + LaunchAgent (reinstalls the agent)
bun run install:app              # builds and installs the Tauri app
open -a Dealerboard
```

Confirm the running daemon is the fresh build before recording anything (the LaunchAgent reinstall restarts it — verify via a new write to the quota snapshot after the install timestamp); a receipt recorded against stale installed artifacts is void. Fault injection must be reversible and restored between checks: for "cswap failing", temporarily replace `~/.local/bin/cswap` with a stub script that exits 1 (`printf '#!/bin/sh\nexit 1\n'`, `chmod +x`), keeping the real binary as `cswap.real` to restore; for "cswap absent", rename the binary away and back. Record **pass/fail plus a one-line observation per check**, and include the completed receipt in the completion report. If the strip hardware is unavailable, say so explicitly in the report and leave the receipt incomplete — do not mark this step done.

1. Normal operation with two seats: both rows stay bright through cswap's 3–10 min cadence (and through a 429 backoff window up to ~30 min).
2. Kill cswap's ability to fetch for one seat (or wait for a real `usageStatus != ok`): only that row dims, with the "Xm/Xh+ old" note; the group stays bright.
3. One whole-pass `cswap list` failure (transient): both rows dim for ~one pass, the group stays bright, and one success clears it.
4. Stop the daemon (kill the collector): after ~6 minutes the whole Claude group dims (stale), rows dimmed within it.
5. Remove/rename the cswap binary: the panel returns to the single ungrouped claude meter exactly as before.

No commit for this task.

---

## Spec coverage map

| Spec requirement | Task(s) |
| --- | --- |
| Source selection — cswap read before the probe loop; skip the codexbar claude probe when grouped | 3 (ordering test, skip assertions) |
| Source selection — widget-snapshot rescue not consulted for claude in grouped operation | 3 (widget entry in golden test), 4 (widget entry + failed claude probe in starvation test) |
| Source selection — claude entry carries account rows, `unavailable: false`, null ambient windows, collector-stamped `fetchedAt` | 3 (golden `toEqual` test, restamp test) |
| Fallback — cswap absent or <2 accounts: probe runs as today, ungrouped panel unchanged | 3 (byte-identity characterization pin; pre-existing absence tests stay green) |
| cswap read failure keeps the group and starves the stamp — no fallback probe, no restamp, rows unavailable, `unavailable` canonicalized false | 4 (starvation test with healing compared against the parser's per-seat health; legacy-seed starvation test; unavailable-seed canonicalization test; null-stamp fallback guard) |
| Settled 0/1/≥2-retained failure contract (decisions.md 2026-08-27 01:43) | 4 (fallback characterization guard: 0 and 1 retained run the probe) |
| Atomic state — claude resolves after every other await; an aborted pass leaves both halves untouched; legacy seeding populates the pair | 3 (abort-safety guard test), 4 (abort de-grouping regression; legacy-seed starvation test); seeding block at `src/core/quota.ts:454` untouched |
| Grouped section renders the ambient panel state (`data-state`) | 2 (red render test) |
| Group dims when the collector misses three 120s passes | 2 (layer-1 pin: starved stamp ages past `STALE_QUOTA_AGE_MS` → `stale`, injected clock) |
| Account row state ignores reading age — collapses to ok \| unavailable | 1 (red state test) |
| Account row dims exactly when cswap says its data is not good, with the existing age note | 1 (state) + unchanged `formatBindingNote` (existing tests) |
| Exhausted seat (0% remaining) stays bright — quota truth, not health | 1 (exhausted-seat pin) |
| Ambient claude history ring stops accumulating in grouped mode | 3 (frozen-ring test with a seeded non-empty ring) |
| On-device verification of dimmed-group vs dimmed-row treatments | 5 (REQUIRED physical-strip acceptance receipt) |
| Non-goals honored: non-claude providers, single-account path, cswap/codexbar upstream, snapshot schema, layout | All tasks — `src/quota-snapshot.ts`, `src/core/claude-swap-quota.ts`, `test/quota-snapshot.test.ts`, `test/quota-claude-swap.test.ts` untouched; fallback pinned byte-identical |
