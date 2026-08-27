# Claude Quota One-Source & Per-Layer Staleness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the strip's Claude account rows from greying during normal operation: grouped Claude quota comes from exactly one source per situation (cswap when it reports ≥2 accounts, codexbar otherwise), and each dimming layer keys off a timestamp its own collector writes.

**Architecture:** The collector (`src/core/quota.ts`) reads cswap *before* the codexbar probe loop. A successful read with ≥2 accounts serves the claude snapshot entry itself — null ambient windows, `fetchedAt` stamped at the read — and skips the codexbar claude probe (and its widget-snapshot rescue) for that pass. A failed read with ≥2 retained accounts keeps the group and starves the stamp (no fallback probe, no restamp). The strip view-model (`app/src/quota.ts`) collapses an account row's state to `ok | unavailable` (reading age never dims), and the rail (`app/src/rail.ts`) sets `data-state` on the grouped section from the ambient panel state so the group dims when dealerboard's own collector misses three 120s passes.

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

## Interpretations (implementation decisions resolved from spec + code)

1. **Failed cswap read with <2 retained accounts falls back to the codexbar probe.** The spec's starvation requirement is explicitly scoped to failure "with ≥2 retained accounts"; a group cannot exist with fewer, and the one-source principle says codexbar is the claude source whenever cswap does not report ≥2 accounts. Cold-start failure (0 retained) and failure-after-one-account (1 retained) therefore run today's fallback path.
2. **The grouped entry carries the prior claude history ring frozen (no appends).** Spec: "The ambient claude history ring stops accumulating in grouped mode" — stops accumulating, not deleted; the ring is rendered nowhere, and carrying it costs nothing for a later return to the probe path. A cold-start grouped entry publishes `history: []`.
3. **Test surface (the spec's open question, tagged impl-detail):** extend the three existing files — `test/quota.test.ts` (collector harness), `test/strip-quota.test.ts` (view-model), `test/strip-rail.test.ts` (rail rendering). No new test files. `test/quota-claude-swap.test.ts` and `test/quota-snapshot.test.ts` are untouched (parser and schema unchanged).
4. **The dead `.quota-account[data-state="stale"]` CSS selectors are removed** as part of collapsing the per-account state space (Task 1). Group-level dimming already exists via `.rail-quota[data-state=…]` and is untouched.

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `app/src/quota.ts` | View-model: account meter state collapses to `ok \| unavailable` | 1 |
| `app/styles.css` | Remove dead per-account `stale` selectors | 1 |
| `test/strip-quota.test.ts` | View-model tests | 1 |
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

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/strip-quota.test.ts`
Expected: FAIL — the first account renders `"stale"` (its `fetchedAt` is older than `STALE_QUOTA_AGE_MS`), so the array is `["stale", "unavailable"]`.

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
- Test: `test/strip-rail.test.ts`

**Interfaces:**
- Consumes: `QuotaPanelModel.state` (unchanged `QuotaPanelState`) — for grouped claude this is the ambient meter's state derived from the claude snapshot entry's own `unavailable`/`fetchedAt` (the collector's stamp after Task 3).
- Produces: `section.dataset["state"]` on `.rail-quota.quota-group`; CSS `.rail-quota[data-state="stale"], .rail-quota[data-state="unavailable"] { opacity: 0.45 }` already dims the whole group. `railRenderSignature` already includes `panel.state` for every panel, so render-skip correctness is preserved.

- [ ] **Step 1: Write the failing test**

In `test/strip-rail.test.ts`, add after the `"maps grouped Claude to one provider and two stable account meters"` test:

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

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/strip-rail.test.ts`
Expected: FAIL — the grouped branch never sets `data-state`, so `group?.dataset["state"]` is `undefined`, not `"ok"`.

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
git add app/src/rail.ts test/strip-rail.test.ts
git commit -m "fix(app): render ambient panel state on the grouped claude quota section"
```

---

### Task 3: A successful cswap read with ≥2 accounts serves claude and skips the codexbar probe

**Goal:** grouped Claude quota has one source — the collector reads cswap before the probe loop, skips the codexbar claude probe and its widget-snapshot rescue when the read succeeds with ≥2 accounts, publishes the claude entry with null ambient windows stamped at the read, and leaves the <2/absent fallback byte-identical to today.

**Files:**
- Modify: `src/core/quota.ts` (new `ClaudeSwapRead` type near `FetchOutcome` at line 354; `pollClaudeAccounts` at lines 512–536 becomes `readClaudeSwap`; `pollNow` at lines 612–669)
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

- [ ] **Step 1: Write the failing tests**

Add these inside `describe("createQuotaCollector", …)` in `test/quota.test.ts` (all fixtures/helpers they use already exist in the file):

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

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/quota.test.ts`
Expected: FAIL — the four new tests fail (claude entry today carries the codexbar ambient windows, the probe runs 5 calls in provider order with the cswap read last). Some pre-existing tests also begin to fail once the implementation lands; they are updated in Step 3.

- [ ] **Step 3: Implement source selection in the collector**

In `src/core/quota.ts`:

**(a)** Add the read-result type beside `FetchOutcome` (line 354):

```ts
type ClaudeSwapRead =
  | { kind: "ok"; accounts: ProviderQuota["accounts"]; at: string }
  | { kind: "failed"; accounts: ProviderQuota["accounts"] }
  | { kind: "absent" };
```

**(b)** Replace `pollClaudeAccounts` (lines 512–536) with `readClaudeSwap` — identical retention/diagnostic behavior, plus the discriminated result and the stamp taken at the successful read:

```ts
  const readClaudeSwap = async (exec: QuotaExec | null): Promise<ClaudeSwapRead> => {
    if (exec === null) {
      claudeAccounts = { accounts: [], failed: false };
      return { kind: "absent" };
    }
    let result: QuotaExecResult;
    try {
      result = await exec([...CLAUDE_SWAP_ARGS], CLAUDE_SWAP_EXEC_TIMEOUT_MS);
    } catch {
      result = { exitCode: -1, stdout: "" };
    }
    const parsed = result.exitCode === 0 ? parseClaudeSwapAccounts(result.stdout) : ({ kind: "invalid" } as const);
    if (parsed.kind === "ok") {
      claudeAccounts = { accounts: parsed.accounts, failed: false };
      return { kind: "ok", accounts: parsed.accounts, at: now() };
    }
    if (!claudeAccounts.failed) {
      reportAccountFailure();
    }
    claudeAccounts = {
      accounts: claudeAccounts.accounts.map((account) => ({ ...account, unavailable: true })),
      failed: true,
    };
    return { kind: "failed", accounts: claudeAccounts.accounts };
  };
```

**(c)** In `pollNow`, replace everything from `const providers: …` through the existing claude merge block (`const accounts = await pollClaudeAccounts(...)` … `providers["claude"] = { ...emptyQuota(), accounts };`) with:

```ts
      // Claude quota has one source per situation: the cswap read runs before
      // the probe loop, and a successful read with ≥2 accounts serves the
      // grouped entry and skips the codexbar claude probe for this pass.
      const swapRead = await readClaudeSwap(resolveClaudeSwapExec());
      const providers: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
      for (const provider of QUOTA_PROVIDER_KEYS) {
        if (provider === "claude" && swapRead.kind === "ok" && swapRead.accounts.length >= 2) {
          continue;
        }
        const quota = await pollProvider(exec, provider, widget);
        if (quota !== null) {
          providers[provider] = quota;
        }
      }
      if (swapRead.kind === "ok" && swapRead.accounts.length >= 2) {
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
        const accounts = swapRead.kind === "absent" ? [] : swapRead.accounts;
        const ambientClaude = providers["claude"];
        if (ambientClaude !== undefined) {
          providers["claude"] = { ...ambientClaude, accounts };
        } else if (accounts.length > 0) {
          providers["claude"] = { ...emptyQuota(), accounts };
        }
      }
```

Leave the `orderedProviders` rebuild, JSON publication, catch, and finally blocks of `pollNow` exactly as they are. Note the failure path intentionally still flows through the `else` merge in this task (probe runs, today's behavior) — Task 4 changes it.

**(d)** Update the pre-existing tests in `test/quota.test.ts` that the new grouped shape breaks (exact replacements):

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

**Goal:** when the cswap read fails with ≥2 retained accounts, the collector keeps the group — rows dim via the existing unavailable marking, the claude entry keeps its last successful stamp (no restamp), and neither the codexbar claude probe nor the widget-snapshot rescue runs; with fewer than two retained accounts the fallback probe runs as today.

**Files:**
- Modify: `src/core/quota.ts` (`pollNow` only)
- Test: `test/quota.test.ts`

**Interfaces:**
- Consumes: `readClaudeSwap` / the grouped entry / `states` from Task 3.
- Produces: the starved-pass claude entry — the previous pass's claude entry verbatim plus retained accounts marked `unavailable: true` (same `fetchedAt`, same `unavailable: false`, no widget rescue). This is what ages the group into `stale` via the view-model's existing `panelState` after three missed passes.

- [ ] **Step 1: Write the failing tests**

In `test/quota.test.ts`, replace the whole `"widget fallback is ambient-only"` test (its premise — a widget rescue for claude while accounts are retained — is the behavior this task removes) with:

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
    await collector.pollNow();
    const claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(claude).toMatchObject({ percentRemaining: null, unavailable: false, fetchedAt: NOW });
    expect(claude?.accounts.every((account) => account.unavailable)).toBe(true);
    expect(harness.calls.length).toBe(callsAfterFirstPass + 4); // codex, kimi, zai, qwen only
    expect(harness.diagnostics.filter((record) => record.code === "quota_failed")).toEqual([]);
    expect(harness.diagnostics.filter((record) => record.code === "quota_accounts_failed")).toHaveLength(1);

    current = "2026-08-19T18:04:00.000Z";
    harness.healClaudeSwap();
    await collector.pollNow();
    const healed = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
    expect(healed?.unavailable).toBe(false);
    expect(healed?.fetchedAt).toBe("2026-08-19T18:04:00.000Z");
    expect(healed?.accounts.every((account) => account.unavailable)).toBe(false);
  });
```

Then add:

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

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/quota.test.ts`
Expected: FAIL — the starvation test fails because the failed pass currently runs the claude probe and rescues from the widget snapshot (`percentRemaining: 90`, `fetchedAt` restamped). The fallback-with-<2-retained test already passes and is a guard against over-skipping.

- [ ] **Step 3: Implement starvation**

In `pollNow` in `src/core/quota.ts`, make two changes:

**(a)** Widen the probe-loop skip from successful reads to any read that retains a group (replace the Task 3 condition):

```ts
        if (provider === "claude" && swapRead.kind !== "absent" && swapRead.accounts.length >= 2) {
          continue;
        }
```

**(b)** Insert the starvation branch between the grouped branch and the `else` merge:

```ts
      } else if (swapRead.kind === "failed" && swapRead.accounts.length >= 2) {
        // A failed read keeps the group: rows dim via unavailable, and the
        // entry keeps its last successful stamp so a persistent failure ages
        // it stale while a transient one only dims the rows for one pass.
        const previous = states.get("claude");
        if (previous !== undefined) {
          const quota: ProviderQuota = { ...previous.quota, accounts: swapRead.accounts };
          states.set("claude", { quota, failed: previous.failed });
          providers["claude"] = quota;
        }
      } else {
```

(`previous` is always present when ≥2 accounts are retained — retention requires an earlier successful read or a seeded snapshot, both of which populate `states` — the guard is belt-and-braces, matching the file's defensive style.)

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
| `cswap list` failing ≥3 passes / collector dead → group dims | Task 2 (data-state) + existing `panelState` stale test in `test/strip-quota.test.ts` |
| Seat exhausted → bright, bar says it | Task 1 (state ignores everything but `unavailable`) |
| Never fetched → unavailable group | Existing `panelState` unavailable branch + Task 2 rendering |
| <2 accounts → ungrouped, unchanged | Task 3 byte-identity pin test |

- [ ] **Step 4: Manual verification checklist for Drew (physical strip)**

Tests cannot see the physical dim treatments. Suggested live checks after installing the build:
1. Normal operation with two seats: both rows stay bright through cswap's 3–10 min cadence (and through a 429 backoff window up to ~30 min).
2. Kill cswap's ability to fetch for one seat (or wait for a real `usageStatus != ok`): only that row dims, with the "Xm/Xh+ old" note.
3. Stop the daemon (kill the collector): after ~6 minutes the whole Claude group dims.
4. Remove/rename the cswap binary: the panel returns to the single ungrouped claude meter exactly as before.

No commit for this task.

---

## Spec coverage map

| Spec requirement | Task(s) |
| --- | --- |
| Source selection — cswap read before the probe loop; skip the codexbar claude probe when grouped | 3 (ordering test, skip assertions) |
| Source selection — widget-snapshot rescue not consulted for claude in grouped operation | 3 (widget entry in golden test), 4 (widget entry in starvation test) |
| Source selection — claude entry carries account rows, `unavailable: false`, null ambient windows, collector-stamped `fetchedAt` | 3 (golden `toEqual` test, restamp test) |
| Fallback — cswap absent or <2 accounts: probe runs as today, ungrouped panel unchanged | 3 (byte-identity pin test; pre-existing absence tests stay green) |
| cswap read failure keeps the group and starves the stamp — no fallback probe, no restamp, rows unavailable | 4 (starvation test) |
| Grouped section renders the ambient panel state (`data-state`) | 2 |
| Account row state ignores reading age — collapses to ok \| unavailable | 1 |
| Account row dims exactly when cswap says its data is not good, with the existing age note | 1 (state) + unchanged `formatBindingNote` (existing tests) |
| Non-goals honored: non-claude providers, single-account path, cswap/codexbar upstream, snapshot schema, layout | All tasks — `src/quota-snapshot.ts`, `src/core/claude-swap-quota.ts`, `test/quota-snapshot.test.ts`, `test/quota-claude-swap.test.ts` untouched; fallback pinned byte-identical |
