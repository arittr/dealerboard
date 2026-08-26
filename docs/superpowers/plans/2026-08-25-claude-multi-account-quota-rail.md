# Claude Multi-Account Quota Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the claude-swap account collection as stable slot-ordered quota meters under one Claude rail header while preserving the existing ambient Claude fallback and every other provider row.

**Architecture:** Keep CodexBar as the ambient quota source and add a separate read-only claude-swap adapter that runs `cswap list --json` once per 120-second pass. Publish privacy-safe account readings additively inside Claude's schema-v2 quota entry, reduce ambient and account readings through one pure meter model, and let the rail render either today's ambient row or a grouped Claude header with one meter per account.

**Tech Stack:** TypeScript under Bun strict mode, Bun test, Biome, direct subprocess argument arrays, JSON sidecar snapshots, DOM via `document.createElement`, CSS for the 2560×720 Tauri/Xeneon webview.

**Spec:** `docs/superpowers/specs/2026-08-25-claude-multi-account-quota-rail-design.md` — read it first; it is the contract of record for source behavior, privacy, fallback, layout, and physical acceptance.

## Global Constraints

- Never use Linear in this repository.
- Recheck branch, `HEAD`, and `git status` before every task; preserve unrelated concurrent work and stage only the paths named by that task.
- Keep `quota-snapshot.json` at `schemaVersion: 2`; `accounts` is an additive optional wire field and missing input maps to `[]`.
- `QUOTA_ACCOUNTS_LIMIT = 8`; reject over-limit account collections, duplicate slots/ids/labels, and more than one active snapshot row.
- Resolve claude-swap only from `~/.local/bin/cswap`, `/opt/homebrew/bin/cswap`, then `/usr/local/bin/cswap`; no environment variable, PATH lookup, CodexBar-config parsing, or credential fallback.
- Run exactly `cswap list --json`, directly (no shell), once per quota pass with a 5-second timeout.
- Parse only numeric slot, active slot, usage status, current/last-good 5-hour and 7-day windows, scoped windows, and their fetch/reset instants.
- Never persist, render, or diagnose email, organization identity, alias, account plan, credential/token detail, raw stdout, stderr, or caught error text.
- Never run a mutating claude-swap command: no `switch`, `auto`, `run`, `add`, remove, enable/disable, import/export, or purge.
- Multi-account presentation activates only for two or more parsed accounts. Zero or one account renders the existing ambient Claude row.
- Account order is ascending numeric slot and never changes with active state. The active marker is Claude orange `#D97757`, not a status color.
- Each account reuses the existing binding rule, countdown-first right text, 8px fill bar, headroom colors, and 2px neutral non-binding ticks.
- Do not add per-account history; the ambient provider history remains unchanged.
- Do not change rail width, board/card geometry, token usage, pager, session protocol, Stream Deck plugin, keypad, or manifest version.
- Tests must exercise parsed structures, collector state, pure view models, and render inputs. Do not regex-match generated HTML, JSON, shell, or large strings.
- TDD each task: failing focused test → verify RED → minimal implementation → focused GREEN plus typecheck → commit. Never `git add -A`.
- The full code gate is `bun run check`. Local install and physical Xeneon proof are separate gates; neither is implied by tests.

## File and interface map

**Create:**

- `src/core/claude-swap-quota.ts` — claude-swap discovery constants and pure JSON-to-`ProviderQuotaAccount[]` parser.
- `test/quota-claude-swap.test.ts` — focused external-schema tests.
- `test/fixtures/quota/claude-swap-accounts.json` — fake, privacy-safe two-account source fixture.
- `test/support/fake-dom.ts` — minimal typed DOM tree used only for rail structure assertions.

**Modify:**

- `src/quota-snapshot.ts` — account wire type, cap, strict parsing, missing-field default, shared extra-label cap.
- `src/core/quota.ts` — compile-time empty account fields, independent claude-swap execution/state, merge at publication.
- `src/core/diagnostics.ts` — payload-free `quota_accounts_failed` code.
- `app/src/quota.ts` — reusable meter model plus grouped account models.
- `app/src/rail.ts` — one grouped Claude header and reusable ambient/account meter rendering; account-aware render signature.
- `app/styles.css` — compact group/account layout, active marker, and per-account dimming.
- `test/quota-snapshot.test.ts`, `test/quota.test.ts`, `test/strip-quota.test.ts`, `test/strip-rail.test.ts` — contract, collector, view-model, and render-signature coverage.
- `AGENTS.md`, `docs/design.md` — current source/snapshot/visible-contract documentation.

**Do not modify:** `src/protocol.ts`, `snapshot-v2.json`, `src/plugin/**`, `app/src/board.ts`, Stream Deck manifest/bundle, or historical dated specs/verification records.

---

### Task 1: Add the additive account snapshot contract

**Files:**

- Modify: `src/quota-snapshot.ts:11-201`
- Modify: `src/core/quota.ts:28-38, 125-141, 363-372, 529-538`
- Modify: `test/quota-snapshot.test.ts`
- Modify: `test/strip-quota.test.ts:20-30`
- Test: `test/quota-snapshot.test.ts`, `test/quota.test.ts`, `test/strip-quota.test.ts`

**Interfaces:**

- Produces `QUOTA_ACCOUNTS_LIMIT`, `QUOTA_EXTRA_WINDOW_LABEL_MAX_CODE_POINTS`, `capQuotaExtraWindowLabel(label: string): string`, and `ProviderQuotaAccount`.
- Extends `ProviderQuota` with required in-memory `accounts: ProviderQuotaAccount[]`.
- `parseQuotaSnapshot` accepts schema v1/v2 provider objects with no account field and returns `accounts: []`.
- Tasks 2–5 consume these exact names and shapes.

- [ ] **Step 1: Write failing snapshot tests**

Add `accounts: []` to the typed `claudeQuota()` factory, then add runtime tests that do not pre-normalize the input:

~~~ts
const accountRows = (): ProviderQuotaAccount[] => [
  {
    id: "claude-swap:1",
    label: "1",
    active: false,
    percentRemaining: 75,
    resetAt: "2026-08-26T02:00:00.000Z",
    weeklyPercentRemaining: 60,
    weeklyResetAt: "2026-08-29T00:00:00.000Z",
    unavailable: false,
    fetchedAt: "2026-08-25T20:00:00.000Z",
    extraWindows: [],
  },
  {
    id: "claude-swap:2",
    label: "2",
    active: true,
    percentRemaining: null,
    resetAt: null,
    weeklyPercentRemaining: 44,
    weeklyResetAt: "2026-08-30T00:00:00.000Z",
    unavailable: true,
    fetchedAt: "2026-08-25T19:00:00.000Z",
    extraWindows: [
      {
        id: "claude-swap:2:scoped:0",
        label: "Fable",
        percentRemaining: 2,
        resetAt: "2026-08-30T00:00:00.000Z",
      },
    ],
  },
];

test("v1 and v2 providers without accounts normalize to an empty account collection", () => {
  for (const schemaVersion of [1, 2] as const) {
    const value = snapshot();
    const claude = { ...value.providers.claude };
    delete (claude as Partial<ProviderQuota>)["accounts"];
    const parsed = parseQuotaSnapshot({ schemaVersion, providers: { claude } });
    expect(parsed.providers["claude"]?.accounts).toEqual([]);
  }
});

test("v2 round-trips two privacy-safe account rows", () => {
  const accounts = accountRows();
  const parsed = parseQuotaSnapshot({
    schemaVersion: 2,
    providers: { claude: { ...claudeQuota(), accounts } },
  });
  expect(parsed.providers["claude"]?.accounts).toEqual(accounts);
});
~~~

Cover the rejection matrix by mutating the valid account pair:

~~~ts
test("rejects every invalid account collection shape", () => {
  const accounts = accountRows();
  const first = accounts[0];
  const second = accounts[1];
  if (first === undefined || second === undefined) throw new Error("account test fixture must contain two rows");
  const invalidCollections: [string, unknown[]][] = [
    ["nine accounts", Array.from({ length: 9 }, (_, index) => ({ ...first, id: `claude-swap:${index + 1}`, label: `${index + 1}` }))],
    ["duplicate id", [first, { ...second, id: first.id }]],
    ["duplicate label", [first, { ...second, label: first.label }]],
    ["non-numeric label", [first, { ...second, id: "claude-swap:private", label: "private" }]],
    ["id-label mismatch", [first, { ...second, id: "claude-swap:3" }]],
    ["two active", accounts.map((account) => ({ ...account, active: true }))],
    ["invalid percent", [{ ...first, percentRemaining: 101 }, second]],
    ["noncanonical fetchedAt", [{ ...first, fetchedAt: "2026-08-25T20:00:00Z" }, second]],
    ["malformed extras", [{ ...first, extraWindows: [{ id: "x" }] }, second]],
  ];
  for (const [_name, invalidAccounts] of invalidCollections) {
    expect(() =>
      parseQuotaSnapshot({ schemaVersion: 2, providers: { claude: { ...claudeQuota(), accounts: invalidAccounts } } }),
    ).toThrow("invalid quota snapshot");
  }
});

test("ignores unknown account fields", () => {
  const first = accountRows()[0];
  if (first === undefined) throw new Error("account test fixture must contain one row");
  const parsed = parseQuotaSnapshot({
    schemaVersion: 2,
    providers: { claude: { ...claudeQuota(), accounts: [{ ...first, privateFutureField: "ignored" }] } },
  });
  expect(parsed.providers["claude"]?.accounts[0]).toEqual(first);
});
~~~

- [ ] **Step 2: Run the snapshot tests to verify RED**

Run: `bun test test/quota-snapshot.test.ts`

Expected: FAIL because `ProviderQuotaAccount`, `accounts`, and account parsing do not exist.

- [ ] **Step 3: Implement the contract and strict parser**

In `src/quota-snapshot.ts`, add:

~~~ts
export const QUOTA_ACCOUNTS_LIMIT = 8;
export const QUOTA_EXTRA_WINDOW_LABEL_MAX_CODE_POINTS = 14;

export const capQuotaExtraWindowLabel = (label: string): string => {
  const codePoints = [...label];
  if (codePoints.length <= QUOTA_EXTRA_WINDOW_LABEL_MAX_CODE_POINTS) {
    return label;
  }
  return `${codePoints
    .slice(0, QUOTA_EXTRA_WINDOW_LABEL_MAX_CODE_POINTS - 1)
    .join("")
    .trimEnd()}…`;
};

export type ProviderQuotaAccount = {
  id: string;
  label: string;
  active: boolean;
  percentRemaining: number | null;
  resetAt: string | null;
  weeklyPercentRemaining: number | null;
  weeklyResetAt: string | null;
  unavailable: boolean;
  fetchedAt: string | null;
  extraWindows: QuotaExtraWindow[];
};
~~~

Add `accounts: ProviderQuotaAccount[]` to `ProviderQuota`. Implement the account parser with the existing validators:

~~~ts
const parseProviderQuotaAccount = (value: unknown): ProviderQuotaAccount => {
  if (!isRecord(value)) return invalid("provider account must be an object");
  if (typeof value["label"] !== "string") {
    return invalid("provider account label must be a decimal slot");
  }
  const slot = Number(value["label"]);
  if (!Number.isSafeInteger(slot) || slot <= 0 || String(slot) !== value["label"]) {
    return invalid("provider account label must be a decimal slot");
  }
  if (value["id"] !== `claude-swap:${value["label"]}`) {
    return invalid("provider account id must match its claude-swap slot");
  }
  if (typeof value["active"] !== "boolean") return invalid("provider account active must be a boolean");
  if (!isNullablePercent(value["percentRemaining"])) {
    return invalid("provider account percentRemaining must be null or a 0..100 number");
  }
  if (!isNullableIsoInstant(value["resetAt"])) {
    return invalid("provider account resetAt must be null or an ISO instant");
  }
  if (!isNullablePercent(value["weeklyPercentRemaining"])) {
    return invalid("provider account weeklyPercentRemaining must be null or a 0..100 number");
  }
  if (!isNullableIsoInstant(value["weeklyResetAt"])) {
    return invalid("provider account weeklyResetAt must be null or an ISO instant");
  }
  if (typeof value["unavailable"] !== "boolean") {
    return invalid("provider account unavailable must be a boolean");
  }
  if (!isNullableIsoInstant(value["fetchedAt"])) {
    return invalid("provider account fetchedAt must be null or an ISO instant");
  }
  return {
    id: value["id"],
    label: value["label"],
    active: value["active"],
    percentRemaining: value["percentRemaining"],
    resetAt: value["resetAt"],
    weeklyPercentRemaining: value["weeklyPercentRemaining"],
    weeklyResetAt: value["weeklyResetAt"],
    unavailable: value["unavailable"],
    fetchedAt: value["fetchedAt"],
    extraWindows: parseExtraWindows(value["extraWindows"]),
  };
};
~~~

Then implement:

~~~ts
const parseProviderQuotaAccounts = (value: unknown): ProviderQuotaAccount[] => {
  if (!Array.isArray(value) || value.length > QUOTA_ACCOUNTS_LIMIT) {
    return invalid(`accounts must be an array of at most ${QUOTA_ACCOUNTS_LIMIT} rows`);
  }
  const accounts = value.map(parseProviderQuotaAccount);
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) {
    return invalid("account ids must be unique");
  }
  if (new Set(accounts.map((account) => account.label)).size !== accounts.length) {
    return invalid("account labels must be unique");
  }
  if (accounts.filter((account) => account.active).length > 1) {
    return invalid("at most one account may be active");
  }
  return accounts;
};
~~~

In `parseProviderQuota`, set:

~~~ts
accounts: value["accounts"] === undefined ? [] : parseProviderQuotaAccounts(value["accounts"]),
~~~

Do not change `QUOTA_SNAPSHOT_SCHEMA_VERSION` or `QuotaSnapshot["schemaVersion"]`.

- [ ] **Step 4: Share the existing 14-code-point label cap and restore typecheck**

Replace `src/core/quota.ts`'s private cap constant/body with:

~~~ts
const extraWindowLabel = (title: string, codexbarProvider: string): string => {
  const displayName = CODEXBAR_DISPLAY_NAMES[codexbarProvider] ?? codexbarProvider;
  const stripped = title.replace(new RegExp(`^${displayName}\\s+`, "iu"), "").trim();
  const source = stripped.length === 0 ? title.trim() : stripped;
  return capQuotaExtraWindowLabel(source);
};
~~~

Import `capQuotaExtraWindowLabel`. Add `accounts: []` to `emptyQuota()`, each successful ambient `ProviderQuota`, and typed test factories in `test/quota-snapshot.test.ts` and `test/strip-quota.test.ts`. Do not otherwise change collector behavior.

- [ ] **Step 5: Run focused GREEN and typecheck**

Run:

~~~bash
bun test test/quota-snapshot.test.ts test/quota.test.ts test/strip-quota.test.ts
bun run typecheck
~~~

Expected: all pass; the existing long-label tests still prove the shared cap includes the ellipsis.

- [ ] **Step 6: Commit**

~~~bash
git add src/quota-snapshot.ts src/core/quota.ts test/quota-snapshot.test.ts test/strip-quota.test.ts
git commit -m "feat(quota): add additive account snapshot contract"
~~~

---

### Task 2: Parse claude-swap accounts without personal data

**Files:**

- Create: `src/core/claude-swap-quota.ts`
- Create: `test/quota-claude-swap.test.ts`
- Create: `test/fixtures/quota/claude-swap-accounts.json`
- Test: `test/quota-claude-swap.test.ts`

**Interfaces:**

- Consumes `ProviderQuotaAccount`, `QuotaExtraWindow`, `QUOTA_ACCOUNTS_LIMIT`, and `capQuotaExtraWindowLabel` from Task 1.
- Produces:

~~~ts
export const CLAUDE_SWAP_EXEC_TIMEOUT_MS = 5_000;
export const CLAUDE_SWAP_ARGS = ["list", "--json"] as const;
export const claudeSwapBinaryCandidates = (home: string): readonly string[];
export type ClaudeSwapAccountsParse =
  | { kind: "ok"; accounts: ProviderQuotaAccount[] }
  | { kind: "invalid" };
export const parseClaudeSwapAccounts = (body: string): ClaudeSwapAccountsParse;
~~~

- Task 3 consumes only these exported interfaces; no collector/import cycle.

- [ ] **Step 1: Add a fake two-account source fixture**

Create `test/fixtures/quota/claude-swap-accounts.json` with fake `.invalid` identities and deliberately reversed slot order:

~~~json
{
  "schemaVersion": 1,
  "activeAccountNumber": 2,
  "accounts": [
    {
      "number": 2,
      "email": "second@example.invalid",
      "organizationName": "Ignored Corp",
      "organizationUuid": "ignored-uuid",
      "usageStatus": "unavailable",
      "lastGoodUsage": {
        "fiveHour": { "pct": 0 },
        "sevenDay": { "pct": 56, "resetsAt": "2026-08-30T00:59:00Z" },
        "scoped": [
          { "name": "Fable", "pct": 98, "resetsAt": "2026-08-30T00:59:00Z" }
        ]
      },
      "lastGoodFetchedAt": "2026-08-25T19:30:00Z"
    },
    {
      "number": 1,
      "email": "first@example.invalid",
      "organizationName": "Ignored Personal",
      "organizationUuid": "ignored-personal-uuid",
      "usageStatus": "ok",
      "usage": {
        "fiveHour": { "pct": 25, "resetsAt": "2026-08-26T02:19:00Z" },
        "sevenDay": { "pct": 40, "resetsAt": "2026-08-30T00:59:00Z" },
        "scoped": [
          { "name": "Fable", "pct": 45, "resetsAt": "2026-08-30T00:59:00Z" }
        ]
      },
      "usageFetchedAt": "2026-08-25T20:00:00Z"
    }
  ]
}
~~~

- [ ] **Step 2: Write failing parser tests**

Create `test/quota-claude-swap.test.ts`. The main assertion is:

~~~ts
const parsed = parseClaudeSwapAccounts(fixture("claude-swap-accounts.json"));
expect(parsed).toEqual({
  kind: "ok",
  accounts: [
    {
      id: "claude-swap:1",
      label: "1",
      active: false,
      percentRemaining: 75,
      resetAt: "2026-08-26T02:19:00.000Z",
      weeklyPercentRemaining: 60,
      weeklyResetAt: "2026-08-30T00:59:00.000Z",
      unavailable: false,
      fetchedAt: "2026-08-25T20:00:00.000Z",
      extraWindows: [
        {
          id: "claude-swap:1:scoped:0",
          label: "Fable",
          percentRemaining: 55,
          resetAt: "2026-08-30T00:59:00.000Z",
        },
      ],
    },
    {
      id: "claude-swap:2",
      label: "2",
      active: true,
      percentRemaining: 100,
      resetAt: null,
      weeklyPercentRemaining: 44,
      weeklyResetAt: "2026-08-30T00:59:00.000Z",
      unavailable: true,
      fetchedAt: "2026-08-25T19:30:00.000Z",
      extraWindows: [
        {
          id: "claude-swap:2:scoped:0",
          label: "Fable",
          percentRemaining: 2,
          resetAt: "2026-08-30T00:59:00.000Z",
        },
      ],
    },
  ],
});
expect(JSON.stringify(parsed)).not.toContain("@");
expect(JSON.stringify(parsed)).not.toContain("organization");
~~~

Add the remaining source-boundary tests with JSON values, never raw personal values:

~~~ts
test("accepts an empty account collection", () => {
  expect(parseClaudeSwapAccounts(JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: [] }))).toEqual({
    kind: "ok",
    accounts: [],
  });
});

test("falls back to last-good and otherwise retains an empty unavailable slot", () => {
  const parsed = parseClaudeSwapAccounts(
    JSON.stringify({
      schemaVersion: 1,
      activeAccountNumber: 1,
      accounts: [
        {
          number: 1,
          usageStatus: "ok",
          usage: { fiveHour: { pct: 10 } },
          usageFetchedAt: "not-an-instant",
          lastGoodUsage: { sevenDay: { pct: 30, resetsAt: "2026-08-30T00:59:00Z" } },
          lastGoodFetchedAt: "2026-08-25T19:30:00Z",
        },
        { number: 2, usageStatus: "token_expired" },
      ],
    }),
  );
  expect(parsed).toMatchObject({
    kind: "ok",
    accounts: [
      { id: "claude-swap:1", unavailable: true, weeklyPercentRemaining: 70, fetchedAt: "2026-08-25T19:30:00.000Z" },
      { id: "claude-swap:2", unavailable: true, percentRemaining: null, fetchedAt: null, extraWindows: [] },
    ],
  });
});

test("drops only malformed scoped rows and nulls invalid reset instants", () => {
  const parsed = parseClaudeSwapAccounts(
    JSON.stringify({
      schemaVersion: 1,
      activeAccountNumber: 1,
      accounts: [
        {
          number: 1,
          usageStatus: "ok",
          usageFetchedAt: "2026-08-25T20:00:00Z",
          usage: {
            fiveHour: { pct: 25, resetsAt: "bad" },
            scoped: [{ name: "Fable", pct: 45 }, { name: "broken", pct: 101 }, null],
          },
        },
      ],
    }),
  );
  expect(parsed).toMatchObject({
    kind: "ok",
    accounts: [{ resetAt: null, extraWindows: [{ label: "Fable", percentRemaining: 55, resetAt: null }] }],
  });
});

test.each([
  ["invalid JSON", "{"],
  ["non-object", "[]"],
  ["wrong schema", JSON.stringify({ schemaVersion: 2, activeAccountNumber: 1, accounts: [] })],
  ["invalid slot", JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: [{ number: 0 }] })],
  [
    "duplicate slot",
    JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: [{ number: 1 }, { number: 1 }] }),
  ],
  ["missing active", JSON.stringify({ schemaVersion: 1, activeAccountNumber: 2, accounts: [{ number: 1 }] })],
  [
    "nine accounts",
    JSON.stringify({
      schemaVersion: 1,
      activeAccountNumber: 1,
      accounts: Array.from({ length: 9 }, (_, index) => ({ number: index + 1 })),
    }),
  ],
])("rejects %s", (_name, body) => {
  expect(parseClaudeSwapAccounts(body)).toEqual({ kind: "invalid" });
});

test("uses only the three approved binary candidates", () => {
  expect(claudeSwapBinaryCandidates("/Users/test")).toEqual([
    "/Users/test/.local/bin/cswap",
    "/opt/homebrew/bin/cswap",
    "/usr/local/bin/cswap",
  ]);
});
~~~

- [ ] **Step 3: Run parser tests to verify RED**

Run: `bun test test/quota-claude-swap.test.ts`

Expected: FAIL because `src/core/claude-swap-quota.ts` does not exist.

- [ ] **Step 4: Implement the pure adapter**

Implement `src/core/claude-swap-quota.ts` with source-specific guards and newly constructed output only:

~~~ts
import { join } from "node:path";
import {
  capQuotaExtraWindowLabel,
  QUOTA_ACCOUNTS_LIMIT,
  type ProviderQuotaAccount,
  type QuotaExtraWindow,
} from "../quota-snapshot";

export const CLAUDE_SWAP_EXEC_TIMEOUT_MS = 5_000;
export const CLAUDE_SWAP_ARGS = ["list", "--json"] as const;

export const claudeSwapBinaryCandidates = (home: string): readonly string[] => [
  join(home, ".local/bin/cswap"),
  "/opt/homebrew/bin/cswap",
  "/usr/local/bin/cswap",
];

export type ClaudeSwapAccountsParse =
  | { kind: "ok"; accounts: ProviderQuotaAccount[] }
  | { kind: "invalid" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPercent = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

type SourceWindow = { pct: number; resetsAt: string | null };

const parseWindow = (value: unknown): SourceWindow | null => {
  if (!isRecord(value) || !isPercent(value["pct"])) {
    return null;
  }
  return { pct: value["pct"], resetsAt: isoOrNull(value["resetsAt"]) };
};

const remaining = (window: SourceWindow | null): {
  percentRemaining: number | null;
  resetAt: string | null;
} => ({
  percentRemaining: window === null ? null : 100 - window.pct,
  resetAt: window?.resetsAt ?? null,
});
~~~

Normalize a usage object with:

~~~ts
type NormalizedUsage = {
  session: ReturnType<typeof remaining>;
  weekly: ReturnType<typeof remaining>;
  extras: QuotaExtraWindow[];
  hasWindow: boolean;
};

const normalizeUsage = (value: unknown, slot: number): NormalizedUsage => {
  const source = isRecord(value) ? value : {};
  const sessionWindow = parseWindow(source["fiveHour"]);
  const weeklyWindow = parseWindow(source["sevenDay"]);
  const extras: QuotaExtraWindow[] = [];
  const scoped = Array.isArray(source["scoped"]) ? source["scoped"] : [];
  for (const [index, entry] of scoped.entries()) {
    if (!isRecord(entry) || typeof entry["name"] !== "string" || entry["name"].trim().length === 0) continue;
    const window = parseWindow(entry);
    if (window === null) continue;
    extras.push({
      id: `claude-swap:${slot}:scoped:${index}`,
      label: capQuotaExtraWindowLabel(entry["name"].trim()),
      ...remaining(window),
    });
  }
  return {
    session: remaining(sessionWindow),
    weekly: remaining(weeklyWindow),
    extras,
    hasWindow: sessionWindow !== null || weeklyWindow !== null || extras.length > 0,
  };
};

const emptyUsage = (): NormalizedUsage => ({
  session: { percentRemaining: null, resetAt: null },
  weekly: { percentRemaining: null, resetAt: null },
  extras: [],
  hasWindow: false,
});

const normalizeAccount = (value: unknown, activeSlot: number): ProviderQuotaAccount | null => {
  if (!isRecord(value) || !isPositiveInteger(value["number"])) return null;
  const slot = value["number"];
  const current = normalizeUsage(value["usage"], slot);
  const currentFetchedAt = isoOrNull(value["usageFetchedAt"]);
  const lastGood = normalizeUsage(value["lastGoodUsage"], slot);
  const lastGoodFetchedAt = isoOrNull(value["lastGoodFetchedAt"]);
  const selected =
    value["usageStatus"] === "ok" && current.hasWindow && currentFetchedAt !== null
      ? { usage: current, fetchedAt: currentFetchedAt, unavailable: false }
      : lastGood.hasWindow && lastGoodFetchedAt !== null
        ? { usage: lastGood, fetchedAt: lastGoodFetchedAt, unavailable: true }
        : { usage: emptyUsage(), fetchedAt: null, unavailable: true };
  return {
    id: `claude-swap:${slot}`,
    label: String(slot),
    active: slot === activeSlot,
    percentRemaining: selected.usage.session.percentRemaining,
    resetAt: selected.usage.session.resetAt,
    weeklyPercentRemaining: selected.usage.weekly.percentRemaining,
    weeklyResetAt: selected.usage.weekly.resetAt,
    unavailable: selected.unavailable,
    fetchedAt: selected.fetchedAt,
    extraWindows: selected.usage.extras,
  };
};

export const parseClaudeSwapAccounts = (body: string): ClaudeSwapAccountsParse => {
  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value) || value["schemaVersion"] !== 1) {
      return { kind: "invalid" };
    }
    const activeSlot = value["activeAccountNumber"];
    if (!isPositiveInteger(activeSlot)) return { kind: "invalid" };
    const sourceAccounts = value["accounts"];
    if (!Array.isArray(sourceAccounts) || sourceAccounts.length > QUOTA_ACCOUNTS_LIMIT) {
      return { kind: "invalid" };
    }
    const accounts: ProviderQuotaAccount[] = [];
    for (const sourceAccount of sourceAccounts) {
      const account = normalizeAccount(sourceAccount, activeSlot);
      if (account === null) return { kind: "invalid" };
      accounts.push(account);
    }
    if (new Set(accounts.map((account) => account.id)).size !== accounts.length) return { kind: "invalid" };
    if (accounts.length > 0 && accounts.filter((account) => account.active).length !== 1) {
      return { kind: "invalid" };
    }
    accounts.sort((a, b) => Number(a.label) - Number(b.label));
    return { kind: "ok", accounts };
  } catch {
    return { kind: "invalid" };
  }
};
~~~

- [ ] **Step 5: Run focused GREEN and typecheck**

Run:

~~~bash
bun test test/quota-claude-swap.test.ts
bun run typecheck
~~~

Expected: PASS with no real account identity in fixtures or normalized output.

- [ ] **Step 6: Commit**

~~~bash
git add src/core/claude-swap-quota.ts test/quota-claude-swap.test.ts test/fixtures/quota/claude-swap-accounts.json
git commit -m "feat(quota): parse claude-swap account usage"
~~~

---
### Task 3: Integrate independent claude-swap collection and last-good state

**Files:**

- Modify: `src/core/quota.ts:25-40, 306-585`
- Modify: `src/core/diagnostics.ts:17-33`
- Modify: `test/quota.test.ts`
- Test: `test/quota.test.ts`, `test/quota-claude-swap.test.ts`

**Interfaces:**

- Consumes Task 2's `CLAUDE_SWAP_ARGS`, `CLAUDE_SWAP_EXEC_TIMEOUT_MS`, `claudeSwapBinaryCandidates(home)`, and `parseClaudeSwapAccounts(body)`.
- Adds optional `claudeSwapExec?: QuotaExec` to `QuotaCollectorDependencies`; existing `exec?: QuotaExec` remains CodexBar-only.
- Adds diagnostic code `quota_accounts_failed`.
- Produces a schema-v2 Claude provider entry whose ambient fields and `accounts` are independently sourced and independently failure-contained.

- [ ] **Step 1: Extend the collector harness and write failing integration tests**

Keep existing CodexBar `calls` unchanged. Add separate claude-swap controls:

~~~ts
type Harness = {
  deps: QuotaCollectorDependencies;
  calls: string[][];
  claudeSwapCalls: string[][];
  claudeSwapTimeouts: number[];
  diagnostics: DiagnosticRecord[];
  fail: (...providers: string[]) => void;
  heal: (...providers: string[]) => void;
  omit: (...providers: string[]) => void;
  respondRaw: (provider: string, response: RawResponse) => void;
  failClaudeSwap: () => void;
  healClaudeSwap: () => void;
  setClaudeSwap: (body: string) => void;
  writes: () => string[];
};
~~~

The injected claude-swap exec records its args and returns the fake fixture by default:

~~~ts
const claudeSwapCalls: string[][] = [];
const claudeSwapTimeouts: number[] = [];
let claudeSwapFailed = false;
let claudeSwapBody = fixture("claude-swap-accounts.json");
const claudeSwapExec: QuotaExec = (args, timeoutMs) => {
  claudeSwapCalls.push(args);
  claudeSwapTimeouts.push(timeoutMs);
  return Promise.resolve(
    claudeSwapFailed ? { exitCode: 1, stdout: "private failure text" } : { exitCode: 0, stdout: claudeSwapBody },
  );
};
~~~

Extend `makeHarness` options with `claudeSwapBinaryPresent?: boolean` and make binary resolution independent:

~~~ts
type HarnessOptions = {
  binaryPresent?: boolean;
  claudeSwapBinaryPresent?: boolean;
  files?: Record<string, string>;
};

const makeHarness = (
  options: HarnessOptions = {},
  overrides: Partial<QuotaCollectorDependencies> = {},
): Harness => {
~~~

Inside that existing function, use the following dependency object:

~~~ts
const binaryPresent = options.binaryPresent ?? true;
const claudeSwapBinaryPresent = options.claudeSwapBinaryPresent ?? true;
const deps: QuotaCollectorDependencies = {
  quotaSnapshotPath: quotaPath,
  widgetSnapshotPath: widgetPath(tempDir),
  fileExists: (path) => (path.endsWith("/cswap") ? claudeSwapBinaryPresent : binaryPresent),
  ...(binaryPresent ? { exec: execSpy } : {}),
  ...(claudeSwapBinaryPresent ? { claudeSwapExec } : {}),
  readFile: (path) => options.files?.[path] ?? null,
  now: () => NOW,
  writeFile: (_path, payload) => writes.push(payload),
  diagnostics: (record) => diagnostics.push(record),
  ...overrides,
};
~~~

Add these exact fields to the existing returned `Harness` object:

~~~ts
  claudeSwapCalls,
  claudeSwapTimeouts,
  failClaudeSwap: () => {
    claudeSwapFailed = true;
  },
  healClaudeSwap: () => {
    claudeSwapFailed = false;
  },
  setClaudeSwap: (body) => {
    claudeSwapBody = body;
  },
~~~

Add tests proving:

~~~ts
test("publishes claude-swap accounts without changing the five CodexBar calls", async () => {
  const harness = makeHarness();
  await createQuotaCollector(harness.deps).pollNow();
  const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? ""));
  expect(harness.calls.length).toBe(5);
  expect(harness.claudeSwapCalls).toEqual([["list", "--json"]]);
  expect(harness.claudeSwapTimeouts).toEqual([5_000]);
  expect(snapshot.providers["claude"]?.accounts.map((account) => account.id)).toEqual([
    "claude-swap:1",
    "claude-swap:2",
  ]);
});

test("account success survives ambient Claude failure and ambient success survives account failure", async () => {
  const harness = makeHarness();
  const collector = createQuotaCollector(harness.deps);
  harness.fail("claude");
  await collector.pollNow();
  let claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
  expect(claude?.unavailable).toBe(true);
  expect(claude?.accounts.length).toBe(2);

  harness.heal("claude");
  harness.failClaudeSwap();
  await collector.pollNow();
  claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
  expect(claude?.unavailable).toBe(false);
  expect(claude?.accounts.every((account) => account.unavailable)).toBe(true);
});
~~~

Cover synthesis and supported absence explicitly:

~~~ts
test("synthesizes ambient Claude only when accounts exist and CodexBar omits Claude", async () => {
  const harness = makeHarness();
  harness.omit("claude");
  await createQuotaCollector(harness.deps).pollNow();
  const claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
  expect(claude).toMatchObject({ percentRemaining: null, unavailable: true });
  expect(claude?.accounts).toHaveLength(2);
});

test("missing claude-swap is a supported absence while ambient Claude remains", async () => {
  const harness = makeHarness({ claudeSwapBinaryPresent: false });
  await createQuotaCollector(harness.deps).pollNow();
  const claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
  expect(claude).toMatchObject({ percentRemaining: 98, unavailable: false, accounts: [] });
  expect(harness.diagnostics.filter((record) => record.code === "quota_accounts_failed")).toEqual([]);
});
~~~

Cover transition logging, last-good preservation, and authoritative recovery:

~~~ts
test("preserves last-good accounts and logs only healthy-to-failed transitions", async () => {
  const harness = makeHarness();
  const collector = createQuotaCollector(harness.deps);
  await collector.pollNow();
  harness.failClaudeSwap();
  await collector.pollNow();
  await collector.pollNow();
  let claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
  expect(claude?.accounts).toHaveLength(2);
  expect(claude?.accounts.every((account) => account.unavailable)).toBe(true);
  expect(harness.diagnostics.filter((record) => record.code === "quota_accounts_failed")).toHaveLength(1);

  harness.healClaudeSwap();
  await collector.pollNow();
  harness.failClaudeSwap();
  await collector.pollNow();
  expect(harness.diagnostics.filter((record) => record.code === "quota_accounts_failed")).toHaveLength(2);
  expect(JSON.stringify(harness.diagnostics)).not.toContain("private failure text");
});

test("successful zero and one account results authoritatively disable grouping", async () => {
  const harness = makeHarness();
  const collector = createQuotaCollector(harness.deps);
  await collector.pollNow();
  harness.setClaudeSwap(JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: [] }));
  await collector.pollNow();
  expect(parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"]?.accounts).toEqual([]);

  harness.setClaudeSwap(
    JSON.stringify({
      schemaVersion: 1,
      activeAccountNumber: 1,
      accounts: [{ number: 1, usageStatus: "token_expired" }],
    }),
  );
  await collector.pollNow();
  expect(parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"]?.accounts).toHaveLength(1);
});
~~~

For daemon-restart seeding, build a schema-v2 seed using the normalized fixture accounts, inject it at `quotaSnapshotPath`, fail the first account probe, and assert:

~~~ts
test("seeds last-good accounts across daemon restart", async () => {
const seededAccounts = parseClaudeSwapAccounts(fixture("claude-swap-accounts.json"));
if (seededAccounts.kind !== "ok") throw new Error("fixture must parse");
const seeded = parseQuotaSnapshot({
  schemaVersion: 2,
  providers: {
    claude: {
      percentRemaining: 98,
      resetAt: null,
      weeklyPercentRemaining: 37,
      weeklyResetAt: null,
      unavailable: false,
      fetchedAt: NOW,
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
const latest = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? ""));
expect(latest.providers["claude"]?.accounts).toEqual(
  seededAccounts.accounts.map((account) => ({ ...account, unavailable: true })),
);
});
~~~

Prove the widget can rescue ambient Claude without owning account state:

~~~ts
test("widget fallback is ambient-only", async () => {
  const widget = JSON.stringify({
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
  const harness = makeHarness({ files: { [widgetPath(tempDir)]: widget } });
  const collector = createQuotaCollector(harness.deps);
  await collector.pollNow();
  const successful = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? ""));
  const lastGoodAccounts = successful.providers["claude"]?.accounts ?? [];
  harness.fail("claude");
  harness.failClaudeSwap();
  await collector.pollNow();
  const rescued = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? ""));
  expect(rescued.providers["claude"]).toMatchObject({ percentRemaining: 90, unavailable: false });
  expect(rescued.providers["claude"]?.accounts).toEqual(
    lastGoodAccounts.map((account) => ({ ...account, unavailable: true })),
  );
});
~~~

Extend the existing concurrent-poll test and the first success test with:

~~~ts
expect(harness.calls).toHaveLength(5);
expect(harness.claudeSwapCalls).toEqual([["list", "--json"]]);
expect(harness.writes().join("\n")).not.toContain("@example.invalid");
expect(harness.writes().join("\n")).not.toContain("Ignored Corp");
~~~

These assertions prove one in-flight pass, five unchanged CodexBar calls, one account call, and no source identity fields in serialized derived snapshots.

- [ ] **Step 2: Run collector tests to verify RED**

Run: `bun test test/quota.test.ts`

Expected: FAIL because `claudeSwapExec`, account polling, and `quota_accounts_failed` do not exist.

- [ ] **Step 3: Add the diagnostic code and independent resolver**

Add `"quota_accounts_failed"` to `DiagnosticCode`.

In `QuotaCollectorDependencies`, add:

~~~ts
/** Injected claude-swap subprocess for tests; production resolves its binary separately. */
claudeSwapExec?: QuotaExec;
~~~

Keep `spawnExec` generic. Add:

~~~ts
const resolveClaudeSwapExec = (): QuotaExec | null => {
  if (dependencies.claudeSwapExec !== undefined) {
    return dependencies.claudeSwapExec;
  }
  const binaryPath = claudeSwapBinaryCandidates(homedir()).find((path) => fileExists(path));
  return binaryPath === undefined ? null : spawnExec(binaryPath);
};
~~~

Resolve this per pass, just like CodexBar, so installing/removing claude-swap does not require a daemon restart.

- [ ] **Step 4: Implement account state, seeding, and failure transitions**

Keep account-adapter state separate from the ambient `states` map:

~~~ts
type ClaudeAccountState = {
  accounts: ProviderQuotaAccount[];
  failed: boolean;
};

let claudeAccounts: ClaudeAccountState = { accounts: [], failed: false };
~~~

When seeding a parsed snapshot, split the Claude account state from every ambient provider state while retaining the full seeded publication for the write-deduplication baseline:

~~~ts
claudeAccounts = {
  accounts: seeded.providers["claude"]?.accounts ?? [],
  failed: false,
};
for (const key of QUOTA_PROVIDER_KEYS) {
  const quota = seeded.providers[key];
  if (quota !== undefined) {
    states.set(key, { quota: { ...quota, accounts: [] }, failed: quota.unavailable });
  }
}
lastWrittenJson = `${JSON.stringify(seeded)}\n`;
~~~

Add a payload-free failure reporter that contains failures from a throwing diagnostic sink:

~~~ts
const reportAccountFailure = (): void => {
  try {
    diagnostics({
      timestamp: now(),
      component: DIAGNOSTIC_COMPONENT,
      code: "quota_accounts_failed",
      provider: "claude",
    });
  } catch {
    // Diagnostics must never break the collector.
  }
};
~~~

Implement:

~~~ts
const pollClaudeAccounts = async (exec: QuotaExec | null): Promise<ProviderQuotaAccount[]> => {
  if (exec === null) {
    claudeAccounts = { accounts: [], failed: false };
    return [];
  }
  let result: QuotaExecResult;
  try {
    result = await exec([...CLAUDE_SWAP_ARGS], CLAUDE_SWAP_EXEC_TIMEOUT_MS);
  } catch {
    result = { exitCode: -1, stdout: "" };
  }
  const parsed = result.exitCode === 0 ? parseClaudeSwapAccounts(result.stdout) : { kind: "invalid" as const };
  if (parsed.kind === "ok") {
    claudeAccounts = { accounts: parsed.accounts, failed: false };
    return parsed.accounts;
  }
  if (!claudeAccounts.failed) {
    reportAccountFailure();
  }
  claudeAccounts = {
    accounts: claudeAccounts.accounts.map((account) => ({ ...account, unavailable: true })),
    failed: true,
  };
  return claudeAccounts.accounts;
};
~~~

Never include `result.stdout` or caught errors in diagnostics.

- [ ] **Step 5: Merge accounts only at publication**

After the five existing provider probes, poll claude-swap and merge:

~~~ts
const accounts = await pollClaudeAccounts(resolveClaudeSwapExec());
const ambientClaude = providers["claude"];
if (ambientClaude !== undefined) {
  providers["claude"] = { ...ambientClaude, accounts };
} else if (accounts.length > 0) {
  providers["claude"] = { ...emptyQuota(), accounts };
}
~~~

Every ambient `ProviderQuota` created by `pollProvider` has `accounts: []`; other providers publish empty account collections. The widget path remains untouched. Rebuild contract order before serialization so synthesized Claude does not move to the end:

~~~ts
const orderedProviders: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
for (const provider of QUOTA_PROVIDER_KEYS) {
  const quota = providers[provider];
  if (quota !== undefined) orderedProviders[provider] = quota;
}
const snapshot: QuotaSnapshot = { schemaVersion: QUOTA_SNAPSHOT_SCHEMA_VERSION, providers: orderedProviders };
~~~

- [ ] **Step 6: Run focused GREEN and typecheck**

Run:

~~~bash
bun test test/quota.test.ts test/quota-claude-swap.test.ts test/quota-snapshot.test.ts
bun run typecheck
~~~

Expected: PASS; existing five-provider behavior and ordering remain unchanged.

- [ ] **Step 7: Commit**

~~~bash
git add src/core/quota.ts src/core/diagnostics.ts test/quota.test.ts
git commit -m "feat(quota): collect claude-swap accounts independently"
~~~

---

### Task 4: Reduce ambient and account readings through one meter model

**Files:**

- Modify: `app/src/quota.ts:20-176`
- Modify: `test/strip-quota.test.ts`
- Modify: `test/strip-rail.test.ts:1-30` (typed factory compile fix only)
- Test: `test/strip-quota.test.ts`, `test/strip-rail.test.ts`

**Interfaces:**

- Consumes `ProviderQuotaAccount[]` from the snapshot.
- Produces:

~~~ts
export type QuotaMeterModel = {
  windows: readonly QuotaWindowModel[];
  bindingIndex: number | null;
  state: QuotaPanelState;
  fetchedAtMs: number | null;
};

export type QuotaAccountMeterModel = QuotaMeterModel & {
  id: string;
  label: string;
  active: boolean;
};

export type QuotaPanelModel = QuotaMeterModel & {
  provider: QuotaProviderKey;
  history: readonly QuotaHistoryPoint[];
  accounts: readonly QuotaAccountMeterModel[];
};
~~~

- `bindingWindow`, `formatBindingTag`, `formatBindingPercent`, `formatBindingNote`, and `secondaryWindows` accept `QuotaMeterModel`, so Task 5 can render ambient or account meters identically.
- `QuotaPanelModel.accounts` is empty unless the provider is Claude and the wire collection contains at least two accounts; that is the sole grouped-presentation switch.

- [ ] **Step 1: Write failing multi-account view-model tests**

Import `ProviderQuotaAccount` beside `ProviderQuota`. Extend the typed quota/model factories with `accounts: []`. Add a `quotaAccount` factory:

~~~ts
const quotaAccount = (overrides: Partial<ProviderQuotaAccount> = {}): ProviderQuotaAccount => ({
  id: "claude-swap:1",
  label: "1",
  active: false,
  percentRemaining: 70,
  resetAt: "2026-08-19T22:00:00.000Z",
  weeklyPercentRemaining: 80,
  weeklyResetAt: "2026-08-24T00:00:00.000Z",
  unavailable: false,
  fetchedAt: "2026-08-19T18:00:00.000Z",
  extraWindows: [],
  ...overrides,
});
~~~

Add:

~~~ts
test("two accounts become stable independent meter models", () => {
  const accounts = [
    quotaAccount({
      id: "claude-swap:2",
      label: "2",
      active: true,
      percentRemaining: 90,
      extraWindows: [
        {
          id: "claude-swap:2:scoped:0",
          label: "Fable",
          percentRemaining: 2,
          resetAt: "2026-08-24T00:00:00.000Z",
        },
      ],
    }),
    quotaAccount({ id: "claude-swap:1", label: "1", active: false, percentRemaining: 25 }),
  ];
  const panel = reduceQuotaRead(read({ claude: quota({ accounts }) }), NOW)[0];
  expect(panel?.accounts.map((account) => account.id)).toEqual(["claude-swap:1", "claude-swap:2"]);
  const first = panel?.accounts[0];
  const second = panel?.accounts[1];
  if (first === undefined || second === undefined) throw new Error("expected two account meters");
  expect(first).toMatchObject({ label: "1", active: false, bindingIndex: 0 });
  expect(bindingWindow(second)?.tag).toBe("Fable");
  expect(secondaryWindows(second).map((window) => window.tag)).toEqual(["session", "weekly"]);
});

test("zero or one account keeps grouped presentation disabled", () => {
  expect(reduceQuotaRead(read({ claude: quota() }), NOW)[0]?.accounts).toEqual([]);
  expect(
    reduceQuotaRead(read({ claude: quota({ accounts: [quotaAccount()] }) }), NOW)[0]?.accounts,
  ).toEqual([]);
});

test("non-Claude provider account input never enables grouped presentation", () => {
  expect(
    reduceQuotaRead(
      read({ codex: quota({ accounts: [quotaAccount(), quotaAccount({ id: "claude-swap:2", label: "2" })] }) }),
      NOW,
    )[0]?.accounts,
  ).toEqual([]);
});
~~~

Prove source-time staleness, sibling isolation, and ambient preservation:

~~~ts
test("derives each account state from its own source instant", () => {
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
  expect(panel?.accounts.map((account) => account.state)).toEqual(["stale", "unavailable"]);
});

test("grouped account derivation leaves the ambient meter and history unchanged", () => {
  const ambient = quota({
    percentRemaining: 40,
    weeklyPercentRemaining: 70,
    history: [{ fetchedAt: new Date(NOW).toISOString(), fractionRemaining: 0.4 }],
    accounts: [quotaAccount(), quotaAccount({ id: "claude-swap:2", label: "2", active: true })],
  });
  const panel = reduceQuotaRead(read({ claude: ambient }), NOW)[0];
  expect(panel).toMatchObject({ bindingIndex: 0, history: ambient.history });
  expect(panel?.windows.map((window) => window.percentRemaining)).toEqual([40, 70]);
  expect(panel?.accounts.map((account) => account.label)).toEqual(["1", "2"]);
});
~~~

- [ ] **Step 2: Run view-model tests to verify RED**

Run: `bun test test/strip-quota.test.ts test/strip-rail.test.ts`

Expected: FAIL because `QuotaPanelModel` has no account meters and formatter functions require a provider panel.

- [ ] **Step 3: Extract the reusable meter reducer**

Import `QuotaExtraWindow` from `../../src/quota-snapshot`, then introduce an internal common input and one reducer:

~~~ts
type QuotaMeterInput = {
  percentRemaining: number | null;
  resetAt: string | null;
  weeklyPercentRemaining: number | null;
  weeklyResetAt: string | null;
  unavailable: boolean;
  fetchedAt: string | null;
  extraWindows: readonly QuotaExtraWindow[];
};

const meterModel = (quota: QuotaMeterInput, now: number): QuotaMeterModel => {
  const fetchedAtMs = parseInstant(quota.fetchedAt);
  const windows: QuotaWindowModel[] = [];
  if (quota.percentRemaining !== null) {
    windows.push({ tag: "session", percentRemaining: quota.percentRemaining, resetAtMs: parseInstant(quota.resetAt) });
  }
  if (quota.weeklyPercentRemaining !== null) {
    windows.push({
      tag: "weekly",
      percentRemaining: quota.weeklyPercentRemaining,
      resetAtMs: parseInstant(quota.weeklyResetAt),
    });
  }
  for (const extra of quota.extraWindows) {
    windows.push({
      tag: extra.label,
      percentRemaining: extra.percentRemaining,
      resetAtMs: parseInstant(extra.resetAt),
    });
  }
  return {
    windows,
    bindingIndex: selectBindingIndex(windows),
    state: panelState(quota, fetchedAtMs, now),
    fetchedAtMs,
  };
};
~~~

Change `panelState` to accept `QuotaMeterInput`. Build the panel with:

~~~ts
const ambient = meterModel(quota, now);
const accounts =
  provider !== "claude" || quota.accounts.length < 2
    ? []
    : [...quota.accounts]
        .sort((a, b) => Number(a.label) - Number(b.label))
        .map((account) => ({ id: account.id, label: account.label, active: account.active, ...meterModel(account, now) }));
return { provider, history: quota.history, accounts, ...ambient };
~~~

The snapshot parser already guarantees unique numeric claude-swap labels from the writer, but the view model sorts a copy so an externally authored valid v2 file cannot reorder the physical rows.

- [ ] **Step 4: Generalize formatter signatures and restore typed factories**

Change the five meter helpers to accept `QuotaMeterModel`. Add `accounts: []` to `QuotaPanelModel` factories in `test/strip-quota.test.ts` and `test/strip-rail.test.ts`. Do not change formatting, thresholds, or secondary-window order.

- [ ] **Step 5: Run focused GREEN and typecheck**

Run:

~~~bash
bun test test/strip-quota.test.ts test/strip-rail.test.ts
bun run typecheck
~~~

Expected: PASS; all existing ambient quota assertions remain unchanged.

- [ ] **Step 6: Commit**

~~~bash
git add app/src/quota.ts test/strip-quota.test.ts test/strip-rail.test.ts
git commit -m "feat(strip): reduce Claude account quota meters"
~~~

---

### Task 5: Render one Claude header with stacked account meters

**Files:**

- Modify: `app/src/rail.ts:180-286`
- Modify: `app/styles.css:553-635`
- Create: `test/support/fake-dom.ts`
- Modify: `test/strip-rail.test.ts`
- Test: `test/strip-rail.test.ts`, `test/strip-quota.test.ts`

**Interfaces:**

- Consumes Task 4's `QuotaMeterModel`, `QuotaAccountMeterModel`, and `QuotaPanelModel.accounts`.
- Produces a pure `quotaRenderModel(panel: QuotaPanelModel): QuotaRenderModel` seam used by both the DOM renderer and tests:

~~~ts
export type QuotaRenderAccount = {
  id: string;
  label: string;
  active: boolean;
  meter: QuotaMeterModel;
};

export type QuotaRenderModel =
  | { provider: QuotaProviderKey; grouped: false; meter: QuotaPanelModel }
  | { provider: "claude"; grouped: true; meters: readonly QuotaRenderAccount[] };

export const quotaRenderModel = (panel: QuotaPanelModel): QuotaRenderModel;
~~~

- Ambient rendering carries the original panel as `meter`. Grouped Claude rendering carries non-null account identities, one shared provider header, and one meter per account.
- `test/support/fake-dom.ts` provides only the element operations `renderRail` already uses; it is test support, not a production DOM abstraction or dependency.

- [ ] **Step 1: Add a minimal fake DOM test support file**

Create `test/support/fake-dom.ts` with a typed tree that supports the renderer's actual operations:

~~~ts
export class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly listeners: Record<string, Array<() => void>> = {};
  className = "";
  textContent: string | null = null;
  type = "";

  constructor(readonly tagName: string) {}

  get classList(): { add: (...tokens: string[]) => void } {
    return {
      add: (...tokens) => {
        const names = new Set(this.className.split(/\s+/u).filter((name) => name.length > 0));
        for (const token of tokens) names.add(token);
        this.className = [...names].join(" ");
      },
    };
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(type: string, listener: () => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
}

export const descendants = (root: FakeElement): FakeElement[] => [
  root,
  ...root.children.flatMap(descendants),
];

export const hasClass = (element: FakeElement, name: string): boolean =>
  element.className.split(/\s+/u).includes(name);

export const renderedText = (root: FakeElement): string =>
  descendants(root)
    .map((element) => element.textContent ?? "")
    .join(" ");

export const withFakeDocument = <T>(run: (root: FakeElement) => T): T => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const documentValue = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createElementNS: (_namespace: string, tagName: string) => new FakeElement(tagName),
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentValue });
  try {
    return run(new FakeElement("root"));
  } finally {
    if (descriptor === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", descriptor);
  }
};
~~~

- [ ] **Step 2: Write failing render-model, DOM, and signature tests**

Replace the test imports with the account model, renderer, and fake-DOM seams:

~~~ts
import { describe, expect, test } from "bun:test";
import type { QuotaAccountMeterModel, QuotaPanelModel } from "../app/src/quota";
import { type RailModel, quotaRenderModel, railRenderSignature, renderRail } from "../app/src/rail";
import { descendants, hasClass, renderedText, withFakeDocument } from "./support/fake-dom";
~~~

Add `accounts: []` to the existing `quotaPanel` factory and an account factory:

~~~ts
const quotaAccount = (overrides: Partial<QuotaAccountMeterModel> = {}): QuotaAccountMeterModel => ({
  id: "claude-swap:1",
  label: "1",
  active: false,
  windows: [{ tag: "session", percentRemaining: 55, resetAtMs: NOW + 90_000 }],
  bindingIndex: 0,
  state: "ok",
  fetchedAtMs: NOW - 60_000,
  ...overrides,
});

const groupedClaude = (): QuotaPanelModel =>
  quotaPanel({
    accounts: [
      quotaAccount(),
      quotaAccount({
        id: "claude-swap:2",
        label: "2",
        active: true,
        state: "unavailable",
        windows: [
          { tag: "session", percentRemaining: 20, resetAtMs: NOW + 90_000 },
          { tag: "weekly", percentRemaining: 70, resetAtMs: null },
        ],
      }),
    ],
  });
~~~

Test the pure branch consumed by the DOM:

~~~ts
test("maps grouped Claude to one provider and two stable account meters", () => {
  const render = quotaRenderModel(groupedClaude());
  expect(render.provider).toBe("claude");
  expect(render.grouped).toBe(true);
  if (!render.grouped) throw new Error("expected grouped Claude render model");
  expect(render.meters.map(({ id, label, active }) => ({ id, label, active }))).toEqual([
    { id: "claude-swap:1", label: "1", active: false },
    { id: "claude-swap:2", label: "2", active: true },
  ]);
  expect(quotaRenderModel(quotaPanel())).toMatchObject({ grouped: false, meter: { provider: "claude" } });
});
~~~

Test the actual DOM structure without comparing generated HTML:

~~~ts
test("renders one Claude header, two bars, one active marker, and per-account dimming", () => {
  withFakeDocument((root) => {
    renderRail(root as unknown as HTMLElement, model({ quota: [groupedClaude()] }), { onJumpToPage: () => {} });
    const nodes = descendants(root);
    const headers = nodes.filter((node) => hasClass(node, "quota-provider-head"));
    const accountNodes = nodes.filter((node) => hasClass(node, "quota-account"));
    expect(headers).toHaveLength(1);
    expect(headers[0]?.dataset["state"]).toBeUndefined();
    expect(nodes.filter((node) => node.textContent === "Claude")).toHaveLength(1);
    expect(nodes.filter((node) => node.textContent === "C")).toHaveLength(1);
    expect(accountNodes.map((node) => node.dataset["state"])).toEqual(["ok", "unavailable"]);
    expect(nodes.filter((node) => hasClass(node, "quota-bar"))).toHaveLength(2);
    expect(nodes.filter((node) => hasClass(node, "quota-bar-fill")).map((node) => node.style["width"])).toEqual([
      "55%",
      "20%",
    ]);
    expect(nodes.filter((node) => hasClass(node, "quota-tick")).map((node) => node.style["left"])).toEqual(["70%"]);
    expect(nodes.filter((node) => hasClass(node, "quota-account-active"))).toHaveLength(1);
    expect(accountNodes.filter((node) => node.dataset["state"] === "unavailable")).toHaveLength(1);
    expect(renderedText(root)).not.toContain("@");
    expect(renderedText(root)).not.toContain("organization");
  });
});
~~~

Add signature assertions with the same grouped model:

~~~ts
test("tracks account identity, active state, state, fill, ticks, and displayed countdown", () => {
  const base = groupedClaude();
  const first = base.accounts[0];
  const second = base.accounts[1];
  if (first === undefined || second === undefined) throw new Error("grouped fixture must contain two accounts");
  const changed = (account: QuotaAccountMeterModel): string =>
    railRenderSignature(model({ quota: [{ ...base, accounts: [first, account] }] }));
  const signature = railRenderSignature(model({ quota: [base] }));
  expect(changed({ ...second, id: "claude-swap:3", label: "3" })).not.toBe(signature);
  expect(changed({ ...second, active: false })).not.toBe(signature);
  expect(changed({ ...second, state: "ok" })).not.toBe(signature);
  expect(changed({ ...second, windows: [{ tag: "session", percentRemaining: 54, resetAtMs: NOW + 90_000 }] })).not.toBe(
    signature,
  );
  expect(railRenderSignature(model({ quota: [base], now: new Date(NOW + 20_000) }))).toBe(signature);
});
~~~

- [ ] **Step 3: Run the rail tests to verify RED**

Run: `bun test test/strip-rail.test.ts`

Expected: FAIL because `quotaRenderModel`, grouped DOM classes, account bars, and account signature fields do not exist.

- [ ] **Step 4: Implement the pure render model and reusable meter renderer**

In `app/src/rail.ts`, import `QuotaMeterModel` from `./quota`, import `QuotaProviderKey` from `../../src/quota-snapshot`, and add:

~~~ts
export const quotaRenderModel = (panel: QuotaPanelModel): QuotaRenderModel =>
  panel.provider === "claude" && panel.accounts.length >= 2
    ? {
        provider: "claude",
        grouped: true,
        meters: panel.accounts.map((account) => ({
          id: account.id,
          label: account.label,
          active: account.active,
          meter: account,
        })),
      }
    : { provider: panel.provider, grouped: false, meter: panel };
~~~

Extract the current chip/name creation and tag/right/bar logic into these helpers:

~~~ts
const quotaProviderIdentity = (provider: QuotaProviderKey): HTMLElement[] => {
  const chip = document.createElement("span");
  chip.className = "quota-chip";
  chip.dataset["provider"] = provider;
  chip.textContent = PROVIDER_CHIP_LETTERS[provider];
  const name = document.createElement("span");
  name.textContent = PROVIDER_LABELS[provider];
  return [chip, name];
};

const quotaMeter = (meter: QuotaMeterModel, nowMs: number, leading: readonly HTMLElement[]): HTMLElement => {
  const container = document.createElement("div");
  container.className = "quota-meter";
  const head = document.createElement("div");
  head.className = "quota-head";
  head.append(...leading);

  const tag = formatBindingTag(meter);
  if (tag !== null) {
    const pill = document.createElement("span");
    pill.className = "quota-tag";
    pill.textContent = tag;
    head.append(pill);
  }
  const right = document.createElement("span");
  right.className = "quota-right";
  if (meter.state === "unavailable") {
    const note = document.createElement("span");
    note.className = "quota-note";
    note.textContent = formatBindingNote(meter, nowMs);
    right.append(note);
  } else {
    const note = formatBindingNote(meter, nowMs);
    if (note !== "") {
      const noteSpan = document.createElement("span");
      noteSpan.className = "quota-note";
      noteSpan.textContent = `${note} ·`;
      right.append(noteSpan);
    }
    const percent = document.createElement("span");
    percent.className = "quota-pct";
    percent.textContent = formatBindingPercent(meter);
    right.append(percent);
  }
  head.append(right);

  const bar = document.createElement("div");
  bar.className = "quota-bar";
  const binding = bindingWindow(meter);
  if (binding !== null) {
    const fill = document.createElement("div");
    fill.className = "quota-bar-fill";
    fill.style.width = `${Math.max(0, Math.min(100, binding.percentRemaining))}%`;
    fill.style.background = quotaBarColor(binding.percentRemaining);
    bar.append(fill);
    for (const secondary of secondaryWindows(meter)) {
      const tick = document.createElement("span");
      tick.className = "quota-tick";
      tick.style.left = `${Math.max(0, Math.min(100, secondary.percentRemaining))}%`;
      bar.append(tick);
    }
  }
  container.append(head, bar);
  return container;
};
~~~

Replace `quotaSection` with the exact branch shape:

~~~ts
const quotaSection = (panel: QuotaPanelModel, nowMs: number): HTMLElement => {
  const render = quotaRenderModel(panel);
  const section = document.createElement("section");
  section.className = render.grouped ? "rail-quota quota-group" : "rail-quota";
  section.dataset["provider"] = panel.provider;
  if (!render.grouped) {
    section.dataset["state"] = panel.state;
    section.append(quotaMeter(render.meter, nowMs, quotaProviderIdentity(panel.provider)));
    return section;
  }

  const providerHead = document.createElement("div");
  providerHead.className = "quota-provider-head";
  providerHead.append(...quotaProviderIdentity(panel.provider));
  section.append(providerHead);
  for (const entry of render.meters) {
    const account = document.createElement("div");
    account.className = "quota-account";
    account.dataset["account"] = entry.id;
    account.dataset["state"] = entry.meter.state;
    const marker = document.createElement("span");
    marker.className = entry.active ? "quota-account-marker quota-account-active" : "quota-account-marker";
    const label = document.createElement("span");
    label.className = "quota-account-label";
    label.textContent = entry.label;
    account.append(quotaMeter(entry.meter, nowMs, [marker, label]));
    section.append(account);
  }
  return section;
};
~~~

- [ ] **Step 5: Make the render signature account-complete**

Extract one signature tuple:

~~~ts
const meterSignature = (meter: QuotaMeterModel, nowMs: number): readonly unknown[] => [
  meter.state,
  formatBindingTag(meter),
  formatBindingNote(meter, nowMs),
  formatBindingPercent(meter),
  bindingWindow(meter)?.percentRemaining ?? null,
  secondaryWindows(meter),
];
~~~

Replace the quota portion with:

~~~ts
quota: model.quota.map((panel) => [
  panel.provider,
  ...meterSignature(panel, nowMs),
  panel.accounts.map((account) => [account.id, account.label, account.active, ...meterSignature(account, nowMs)]),
]),
~~~

- [ ] **Step 6: Add compact grouped-account styles**

Keep all existing ambient selectors. Add:

~~~css
.quota-group {
  gap: 0.35vh;
}
.quota-meter {
  display: flex;
  flex-direction: column;
  gap: 0.5vh;
}
.quota-provider-head {
  display: flex;
  align-items: center;
  gap: 0.6vw;
  font-size: 1.2vw;
}
.quota-account {
  display: flex;
  flex-direction: column;
}
.quota-account .quota-meter {
  gap: 0.35vh;
}
.quota-account[data-state="stale"],
.quota-account[data-state="unavailable"] {
  opacity: 0.45;
}
.quota-account-marker {
  flex: none;
  width: 0.42vw;
  height: 0.42vw;
  border-radius: 50%;
  background: transparent;
}
.quota-account-active {
  background: #d97757;
}
.quota-account-label {
  flex: none;
  min-width: 0.8vw;
  color: #e8eef7;
  font-variant-numeric: tabular-nums;
}
~~~

Do not modify `.rail`, `.rail-quota` bar height, font scales, token/pager styles, or board/card geometry. The physical gate, not a CSS shrink, decides whether the two-account group fits.

- [ ] **Step 7: Run focused GREEN, app build, and typecheck**

Run:

~~~bash
bun test test/strip-rail.test.ts test/strip-quota.test.ts
bun run build:app
bun run typecheck
~~~

Expected: PASS; the DOM test sees one shared header, two account bars, exactly one active marker, and only the unavailable account dimmed.

- [ ] **Step 8: Commit**

~~~bash
git add app/src/rail.ts app/styles.css test/support/fake-dom.ts test/strip-rail.test.ts
git commit -m "feat(strip): stack Claude account quota meters"
~~~

---

### Task 6: Document the live contract and run the repository gate

**Files:**

- Modify: `AGENTS.md:291-320`
- Modify: `docs/design.md:462-490`
- Test: repository-wide gate

**Interfaces:**

- Consumes the implemented snapshot, collector, and visible behavior from Tasks 1–5.
- Produces the current maintainer contract for account source/discovery, privacy/fallback, grouped rendering, and physical acceptance. No dated spec or verification record is edited.

- [ ] **Step 1: Update `AGENTS.md` with the source and failure contract**

Replace the quota paragraph's Claude-specific portion with prose that states all of these exact facts:

~~~text
The collector still runs CodexBar for all five ambient providers. Once per same 120s pass it also resolves claude-swap from ~/.local/bin/cswap, /opt/homebrew/bin/cswap, then /usr/local/bin/cswap and runs only `list --json` with a 5s timeout. It allowlists numeric slot, active slot, 5-hour/7-day/scoped windows, and source instants into Claude's additive `accounts` field; personal and credential fields and raw process output are never stored or logged. Two or more accounts render as stable numeric-slot meters under one Claude header; zero/one account or no binary uses the ambient row. A failed resolved probe keeps last-good account rows unavailable and is independent of ambient Claude.
~~~

Integrate this into the existing paragraph rather than appending a second contradictory quota description. Keep `schemaVersion` 2 and existing CodexBar/window/history facts unchanged.

- [ ] **Step 2: Update the visible contract in `docs/design.md`**

Extend **Quota rows** with:

~~~text
For Claude only, two or more published claude-swap accounts replace the ambient meter with one shared `[C] Claude` header and one existing-style meter per privacy-safe numeric slot. Slots stay in ascending order; the active slot has a Claude-orange dot and never reorders. Each account independently selects its binding window and owns its reset, fill, ticks, stale/unavailable dimming. Zero or one account keeps the ambient row, and a transient account probe failure keeps the last-good meters visible and dimmed.
~~~

Update the data-plumbing sentence to say the schema-v2 quota sidecar now has an additive Claude `accounts` collection while old/new daemon-app deployment order remains compatible. Preserve all token, provider, rail-width, and keypad text.

- [ ] **Step 3: Run focused source audits**

Run:

~~~bash
rg -n "QuotaPanelModel|QuotaMeterModel|ProviderQuotaAccount|accounts:" app src test
rg -n "cswap|claude-swap|quota_accounts_failed" src test AGENTS.md docs/design.md
rg -n "email|organization|organizationUuid|credential|token" src/core/claude-swap-quota.ts src/core/quota.ts test/fixtures/quota/claude-swap-accounts.json
git diff --check
~~~

Expected: all typed factories carry `accounts`; the only personal fields are fake `.invalid` fixture inputs and negative privacy assertions; production code contains no personal-field access; no whitespace errors.

- [ ] **Step 4: Run the full code gate**

Run: `bun run check`

Expected: PASS for Biome, both TypeScript projects, core/plugin builds, and the full Bun test suite. This proves source behavior only; it does not prove installation or physical layout.

- [ ] **Step 5: Commit documentation**

~~~bash
git add AGENTS.md docs/design.md
git commit -m "docs: document Claude account quota rail"
~~~

After the commit, run `git status --short --branch` and confirm only intentional concurrent user files, if any, remain uncommitted.

---

### Task 7: Install and obtain sanitized live and physical evidence

**Files:**

- No planned source edits.
- Read: installed claude-swap output through an allowlisting filter.
- Read: `~/Library/Application Support/com.drewritter.stream-deck-agents/quota-snapshot.json` through an allowlisting filter.
- Install: daemon/core and `/Applications` strip app using repository scripts.
- Verify: physical 2560×720 Xeneon Edge.

**Interfaces:**

- Consumes a clean Task 6 `bun run check` receipt and the real installed two-account claude-swap state.
- Produces separate sanitized source, installed snapshot, installed app, and Drew-approved physical visual receipts. No source commit is expected unless a defect is found.

- [ ] **Step 1: Capture a sanitized contemporaneous claude-swap reading**

Run only the read-only command and discard stderr before any output reaches the transcript:

~~~bash
"$HOME/.local/bin/cswap" list --json 2>/dev/null | jq '{
  activeAccountNumber,
  accounts: [.accounts[] | {
    number,
    currentEligible: (.usageStatus == "ok"),
    current: {
      fiveHour: (.usage.fiveHour // null),
      sevenDay: (.usage.sevenDay // null),
      scoped: (.usage.scoped // []),
      fetchedAt: (.usageFetchedAt // null)
    },
    lastGood: {
      fiveHour: (.lastGoodUsage.fiveHour // null),
      sevenDay: (.lastGoodUsage.sevenDay // null),
      scoped: (.lastGoodUsage.scoped // []),
      fetchedAt: (.lastGoodFetchedAt // null)
    }
  }]
}'
~~~

Expected: only slot numbers, a current-eligibility boolean, allowlisted usage windows, and instants appear. Stop if the filter fails; never print unfiltered stdout. Apply Task 2's current/last-good selection rules and record the expected slot order, active slot, and remaining percentages (`100 - pct`) for the physical comparison.

- [ ] **Step 2: Install the core and wait for a fresh quota pass**

Run:

~~~bash
lsof "$HOME/Library/Application Support/com.drewritter.stream-deck-agents/registry.sqlite3"
bun scripts/install-local.ts
launchctl print "gui/$(id -u)/com.drewritter.stream-deck-agents" | rg "state =|pid =|last exit code"
~~~

Before installing, confirm exactly one installed daemon owns the registry and no `bun src/core/cli.ts daemon` process is running from a worktree; stop any source daemon before continuing. Accept the Stream Deck confirmation dialog if the installer requests it. The core install is a distinct gate from the prior build.

Wait for the quota sidecar's modification time to advance past the install, polling without printing file contents:

~~~bash
stat -f '%Sm %N' -t '%Y-%m-%dT%H:%M:%S%z' "$HOME/Library/Application Support/com.drewritter.stream-deck-agents/quota-snapshot.json"
~~~

- [ ] **Step 3: Inspect only allowlisted installed snapshot fields**

Run:

~~~bash
jq '{
  schemaVersion,
  providerKeys: (.providers | keys),
  claude: (.providers.claude | {
    percentRemaining, resetAt, weeklyPercentRemaining, weeklyResetAt, unavailable, fetchedAt,
    accounts: [.accounts[] | {
      id, label, active, percentRemaining, resetAt, weeklyPercentRemaining, weeklyResetAt,
      unavailable, fetchedAt,
      extraWindows: [.extraWindows[] | {id, label, percentRemaining, resetAt}]
    }]
  }),
  otherProviders: (.providers | del(.claude) | with_entries(.value |= {
    percentRemaining, resetAt, weeklyPercentRemaining, weeklyResetAt, unavailable, fetchedAt,
    accounts
  }))
}' "$HOME/Library/Application Support/com.drewritter.stream-deck-agents/quota-snapshot.json"
~~~

Expected: `schemaVersion: 2`; all expected provider keys remain; Claude retains ambient fields plus two rows with only `claude-swap:<slot>` ids and numeric labels; other providers carry empty account arrays; percentages and active slot match Step 1; no personal or credential fields can pass the allowlist.

- [ ] **Step 4: Build and install the strip app**

Run:

~~~bash
bun run bundle:app
bun run install:app
open -a "Agent Strip"
~~~

Expected: the bundle and install commands pass and the app opens on/re-pins to the Xeneon Edge. This does not reinstall or change the Stream Deck keypad plugin beyond what `install-local.ts` owns.

- [ ] **Step 5: Perform the physical 2560×720 visual gate with Drew**

Verify every item against the installed display:

1. exactly one `[C] Claude` header and two account meters;
2. slots in ascending numeric order while the Claude-orange dot matches Step 1's active slot;
3. each meter's binding pill, remaining percent, reset text, fill, and neutral ticks match the sanitized source reading;
4. an unavailable last-good account dims only its meter, not the header or healthy sibling;
5. bars remain 8px, text is not clipped, and the pager does not overlap;
6. Codex, Kimi, GLM/zai, Qwen, tokens, unread, pager, and session board are unchanged and unclipped.

Do not mark the feature complete from code receipts alone. Record Drew's explicit physical approval as the final gate.

- [ ] **Step 6: Handle any visual defect through the owning task**

If the physical gate finds a defect, return to Task 4 for derivation bugs or Task 5 for DOM/CSS bugs, add a focused failing test where possible, commit the smallest fix, and rerun Tasks 6 and 7. Do not shrink global rail typography or change board geometry as a workaround.

---
