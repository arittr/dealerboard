# Xeneon Strip Quota Panels (Lane C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-provider quota panels (codex + claude) in the strip's rail — percent-remaining bar, reset countdown, and a burn-rate sparkline — fed by a daemon-side collector that polls the providers' OAuth usage endpoints and publishes a separate `quota-snapshot.json`.

**Architecture:** A new collector (`src/core/quota.ts`) runs inside the daemon process on its own 120s scheduler (wired in `src/core/cli.ts` next to `ProjectionDaemon`, never inside its synchronous poll loop), reads local OAuth credential files fresh each pass, fetches the usage endpoints with a timeout, and atomically publishes `quota-snapshot.json` next to `snapshot-v2.json`. The file's contract lives in `src/quota-snapshot.ts` (pure types + defensive parser, `src/protocol.ts` style, own `schemaVersion: 1`), imported by both the core writer and the app reader. The strip reads it through a new Tauri command `read_quota_snapshot` (same `{ mtimeMs, contents }` shape as `read_snapshot`) and renders rail panels from a pure, unit-tested view-model module (`app/src/quota.ts`). The session snapshot (`snapshot-v2.json`), `src/protocol.ts`, and the Stream Deck plugin are **untouched**.

**Tech Stack:** Bun + TypeScript core (strict tsconfig), Tauri v2 (Rust) + DOM/CSS frontend, bun:test. No new dependencies: `fetch` and `AbortSignal.timeout` are built into Bun.

## Research findings (Task-0 output — already done, recorded here so no executor re-researches)

All endpoint facts below are from CodexBar's source (MIT, steipete/CodexBar) and were cross-checked against the credential files on this machine (key names only via `jq`; no secret values were read).

### Claude

- **Credentials file:** `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`, `expiresAt` (epoch **milliseconds**, number), `scopes` (string array; must contain `user:profile` — inference-only tokens cannot call usage), `refreshToken`, `subscriptionType`. Verified locally: keys are exactly `accessToken, expiresAt, rateLimitTier, refreshToken, refreshTokenExpiresAt, scopes, subscriptionType`. Source: [ClaudeOAuthCredentialModels.swift](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthCredentialModels.swift).
- **Endpoint:** `GET https://api.anthropic.com/api/oauth/usage`. Headers: `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`, `Accept: application/json`, `User-Agent: claude-code/2.1.0` (CodexBar detects the installed CLI version and falls back to exactly `claude-code/2.1.0`, so the fixed value is a proven-good UA). 30s timeout upstream; we use 15s. Source: [ClaudeOAuthUsageFetcher.swift](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift), [docs/claude.md](https://github.com/steipete/CodexBar/blob/main/docs/claude.md).
- **Response shape:** `{ "five_hour": { "utilization": <number>, "resets_at": "<ISO8601>" }, "seven_day": { ... }, "seven_day_sonnet": { ... }, "seven_day_opus": { ... }, "extra_usage": { ... }, "limits": [ ... ] }`. `utilization` is **percent used, 0–100** (may be fractional, e.g. `37.5`): CodexBar maps these fields straight into its 0–100 `RateWindow.usedPercent` ([ClaudeScopedWeeklyLimitMapper.swift](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Claude/ClaudeScopedWeeklyLimitMapper.swift)), and independent captures show percent-scale values ([pi-usage docs](https://pi.dev/packages/@mtrojnar/pi-usage?name), [openclaw issue #59773](https://github.com/openclaw/openclaw/issues/59773), [Zenn walkthrough](https://zenn.dev/yktsnet/articles/202604-claude-usage-swiftbar?locale=en)). `percentRemaining = 100 - utilization`. `five_hour` = session window, `seven_day` = weekly window.
- **Failures:** 401 → re-auth needed; 429 → Anthropic rate-limits this endpoint (CodexBar ships a dedicated gate, `ClaudeOAuthUsageRateLimitGate.swift`) → back off.
- **Never refresh or write tokens.** Claude Code rotates them; the file is re-read every pass so rotation is picked up for free. An expired `expiresAt` degrades to `unavailable` until Claude Code next refreshes the file.

### Codex

- **Credentials file:** `($CODEX_HOME ?? ~/.codex)/auth.json` → `tokens.access_token` (snake_case; camelCase tolerated), optional `tokens.account_id`, `tokens.refresh_token`, `tokens.id_token`, top-level `last_refresh`. Verified locally: top-level keys `OPENAI_API_KEY, auth_mode, last_refresh, tokens`; token keys `access_token, account_id, id_token, refresh_token`. Source: [CodexOAuthCredentials.swift](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthCredentials.swift). An `auth.json` holding only `OPENAI_API_KEY` (no `tokens`) has no quota surface on this endpoint → treat as **absent**.
- **Endpoint:** `GET https://chatgpt.com/backend-api/wham/usage`. Headers: `Authorization: Bearer <accessToken>`, `Accept: application/json`, `User-Agent: stream-deck-agents` (CodexBar sends `CodexBar`; if manual verification shows the endpoint gating on UA, switch to `CodexBar`), plus `ChatGPT-Account-Id: <accountId>` when `account_id` is present. Source: [CodexOAuthUsageFetcher.swift](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthUsageFetcher.swift), [docs/codex.md](https://github.com/steipete/CodexBar/blob/main/docs/codex.md).
- **Response shape:** `{ "plan_type": "pro"|..., "rate_limit": { "primary_window": { "used_percent": <int 0-100>, "reset_at": <epoch seconds int>, "limit_window_seconds": <int> }, "secondary_window": { ... } }, "credits": { ... }, "additional_rate_limits": [ ... ] }`. `primary_window` = 5-hour session window, `secondary_window` = weekly. `percentRemaining = 100 - used_percent`; `resetAt = new Date(reset_at * 1000).toISOString()`.
- Both endpoints are undocumented-but-stable (they back the CLIs' own `/usage`); either can change without notice — the collector's failure isolation (mark `unavailable`, keep last-good) is the mitigation, and it is tested.

### Cadence justification

`QUOTA_POLL_INTERVAL_MS = 120_000`. CodexBar's fixed refresh options bottom out at 1m with a 5m legacy default, and Anthropic actively 429s aggressive pollers (hence CodexBar's gate). The quota windows are 5h/7d; 2-minute granularity is more than enough for a burn-rate trend, and the 128-sample ring at 120s covers ~4.3h — nearly the full session window. On 429 the provider is skipped for `QUOTA_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000`.

## Global Constraints

- `bun run check` (biome ci + build + test) is the done gate; TDD per task (failing test first).
- Biome/tsconfig: `noExplicitAny`, `noEvolvingTypes`, `noConsole`, `noProcessEnv` (env enters via `src/core/cli.ts` DI only — `CODEX_HOME` is read there, next to the existing `ZCODE_HOME`/`GROK_HOME`), `noNonNullAssertion` (relaxed in `test/**`), `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` (bracket access on `Record`s), `verbatimModuleSyntax` (`import type`), `erasableSyntaxOnly`, nursery `noFloatingPromises` (`void` fire-and-forget promises). 2-space, double quotes, semicolons, 120 cols.
- `snapshot-v2.json` and `src/protocol.ts` are **untouched**. Quota rides `quota-snapshot.json` + `read_quota_snapshot` only.
- No tokens, credential paths' contents, response bodies, or error text are ever logged or written to the snapshot file. Diagnostics carry fixed codes + provider name only.
- No new npm/Rust dependencies.
- Commit style (from `git log --oneline`): conventional, e.g. `feat(core): ...`, `feat(app): ...`, `docs: ...`.
- Dated files under `docs/superpowers/` and `docs/verification/` are immutable; this plan is the only new dated file.

---

### Task 1: Quota snapshot contract module

**Files:**
- Create: `src/quota-snapshot.ts`
- Create: `test/quota-snapshot.test.ts`
- Create: `test/fixtures/quota/quota-snapshot.json`

**Interfaces:**
- Consumes: nothing new (pure module, mirrors `src/protocol.ts:104-242` parser style).
- Produces: `QUOTA_SNAPSHOT_SCHEMA_VERSION` (`= 1`), `QUOTA_HISTORY_LIMIT` (`= 128`), `QUOTA_PROVIDER_KEYS` (`["claude", "codex"] as const`), `QuotaProviderKey`, `QuotaHistoryPoint`, `ProviderQuota`, `QuotaSnapshot`, `parseQuotaSnapshot(value: unknown): QuotaSnapshot` (throws on violation; ignores unknown provider keys).

- [ ] **Step 1: Write the failing test**

Create `test/quota-snapshot.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  QUOTA_HISTORY_LIMIT,
  parseQuotaSnapshot,
  type ProviderQuota,
  type QuotaSnapshot,
} from "../src/quota-snapshot";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "quota", "quota-snapshot.json");

const claudeQuota = (): ProviderQuota => ({
  percentRemaining: 62.5,
  resetAt: "2026-08-19T22:00:00.000Z",
  weeklyPercentRemaining: 88,
  weeklyResetAt: "2026-08-24T00:00:00.000Z",
  unavailable: false,
  fetchedAt: "2026-08-19T18:00:00.000Z",
  history: [{ fetchedAt: "2026-08-19T18:00:00.000Z", fractionRemaining: 0.625 }],
});

const snapshot = (): QuotaSnapshot => ({
  schemaVersion: 1,
  providers: { claude: claudeQuota() },
});

describe("parseQuotaSnapshot", () => {
  test("round-trips the captured fixture", () => {
    const parsed = parseQuotaSnapshot(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.providers["claude"]).toEqual(claudeQuota());
    expect(parsed.providers["codex"]?.percentRemaining).toBe(73);
  });

  test("accepts a snapshot with no providers and one with a single provider", () => {
    expect(parseQuotaSnapshot({ schemaVersion: 1, providers: {} }).providers).toEqual({});
    expect(parseQuotaSnapshot(snapshot()).providers["codex"]).toBeUndefined();
  });

  test("ignores unknown provider keys so a newer daemon never breaks an older app", () => {
    const parsed = parseQuotaSnapshot({ schemaVersion: 1, providers: { kimi: claudeQuota(), claude: claudeQuota() } });
    expect(parsed.providers["claude"]).toEqual(claudeQuota());
    expect(Object.keys(parsed.providers)).toEqual(["claude"]);
  });

  test("rejects a non-object, a wrong schemaVersion, and a non-object providers", () => {
    expect(() => parseQuotaSnapshot(null)).toThrow("invalid quota snapshot");
    expect(() => parseQuotaSnapshot({ schemaVersion: 2, providers: {} })).toThrow("schemaVersion must be 1");
    expect(() => parseQuotaSnapshot({ schemaVersion: 1, providers: [] })).toThrow("providers must be an object");
  });

  test("rejects out-of-range percents, bad instants, and non-boolean unavailable", () => {
    const bad = (patch: Partial<ProviderQuota>): unknown => ({
      schemaVersion: 1,
      providers: { claude: { ...claudeQuota(), ...patch } },
    });
    expect(() => parseQuotaSnapshot(bad({ percentRemaining: 101 }))).toThrow("percentRemaining");
    expect(() => parseQuotaSnapshot(bad({ percentRemaining: -1 }))).toThrow("percentRemaining");
    expect(() => parseQuotaSnapshot(bad({ resetAt: "not-a-date" }))).toThrow("resetAt");
    expect(() => parseQuotaSnapshot(bad({ weeklyPercentRemaining: "88" }))).toThrow("weeklyPercentRemaining");
    expect(() => parseQuotaSnapshot(bad({ unavailable: 1 as unknown as boolean }))).toThrow("unavailable");
    expect(() => parseQuotaSnapshot(bad({ fetchedAt: 0 as unknown as null }))).toThrow("fetchedAt");
  });

  test("rejects a history ring over the bound and out-of-range fractions", () => {
    const point = { fetchedAt: "2026-08-19T18:00:00.000Z", fractionRemaining: 0.5 };
    const over = { ...claudeQuota(), history: Array.from({ length: QUOTA_HISTORY_LIMIT + 1 }, () => point) };
    expect(() => parseQuotaSnapshot({ schemaVersion: 1, providers: { claude: over } })).toThrow("history");
    const badFraction = { ...claudeQuota(), history: [{ ...point, fractionRemaining: 1.5 }] };
    expect(() => parseQuotaSnapshot({ schemaVersion: 1, providers: { claude: badFraction } })).toThrow(
      "fractionRemaining",
    );
  });
});
```

Create `test/fixtures/quota/quota-snapshot.json` (synthetic data, no real account values):

```json
{
  "schemaVersion": 1,
  "providers": {
    "claude": {
      "percentRemaining": 62.5,
      "resetAt": "2026-08-19T22:00:00.000Z",
      "weeklyPercentRemaining": 88,
      "weeklyResetAt": "2026-08-24T00:00:00.000Z",
      "unavailable": false,
      "fetchedAt": "2026-08-19T18:00:00.000Z",
      "history": [{ "fetchedAt": "2026-08-19T18:00:00.000Z", "fractionRemaining": 0.625 }]
    },
    "codex": {
      "percentRemaining": 73,
      "resetAt": "2026-08-19T20:00:00.000Z",
      "weeklyPercentRemaining": 45,
      "weeklyResetAt": "2026-08-25T00:00:00.000Z",
      "unavailable": false,
      "fetchedAt": "2026-08-19T18:00:00.000Z",
      "history": []
    }
  }
}
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bun test test/quota-snapshot.test.ts` — Expected: FAIL (module `../src/quota-snapshot` does not exist).

- [ ] **Step 3: Minimal implementation**

Create `src/quota-snapshot.ts`:

```ts
/**
 * Shared contract for the quota snapshot — the per-provider usage/quota file
 * the daemon's quota collector publishes next to the session snapshot.
 *
 * This module is imported by both the Bun core (writer) and the strip app's
 * webview (reader), so it must stay free of runtime-specific imports, exactly
 * like src/protocol.ts. The session snapshot (snapshot-v2.json) and
 * src/protocol.ts are deliberately untouched: quota rides its own file.
 */

export const QUOTA_SNAPSHOT_SCHEMA_VERSION = 1;

/** Per-provider sample cap: at the 120s poll cadence, 128 samples cover ~4.3 hours. */
export const QUOTA_HISTORY_LIMIT = 128;

export const QUOTA_PROVIDER_KEYS = ["claude", "codex"] as const;

export type QuotaProviderKey = (typeof QUOTA_PROVIDER_KEYS)[number];

export type QuotaHistoryPoint = {
  /** Canonical UTC ISO instant of the successful fetch. */
  fetchedAt: string;
  /** Session-window fraction remaining, 0..1. */
  fractionRemaining: number;
};

export type ProviderQuota = {
  /** Session (5-hour) window percent remaining, 0..100; null when no fetch has succeeded. */
  percentRemaining: number | null;
  /** Session window reset instant (canonical UTC ISO); null when unknown. */
  resetAt: string | null;
  /** Weekly window percent remaining, 0..100; null when unknown. */
  weeklyPercentRemaining: number | null;
  /** Weekly window reset instant (canonical UTC ISO); null when unknown. */
  weeklyResetAt: string | null;
  /** True when the most recent fetch failed; last-good numbers stay populated. */
  unavailable: boolean;
  /** Last successful fetch (canonical UTC ISO); null when never fetched. */
  fetchedAt: string | null;
  /** Bounded ring of session-window samples, oldest first. */
  history: QuotaHistoryPoint[];
};

export type QuotaSnapshot = {
  schemaVersion: 1;
  providers: Partial<Record<QuotaProviderKey, ProviderQuota>>;
};

const QUOTA_PROVIDERS: ReadonlySet<string> = new Set(QUOTA_PROVIDER_KEYS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIsoInstant = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));

const isNullableIsoInstant = (value: unknown): value is string | null => value === null || isIsoInstant(value);

const isPercent = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

const isNullablePercent = (value: unknown): value is number | null => value === null || isPercent(value);

const isFraction = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const invalid = (reason: string): never => {
  throw new Error(`invalid quota snapshot: ${reason}`);
};

const parseHistoryPoint = (value: unknown): QuotaHistoryPoint => {
  if (!isRecord(value)) {
    return invalid("history point must be an object");
  }
  if (!isIsoInstant(value["fetchedAt"])) {
    return invalid("history point fetchedAt must be an ISO instant");
  }
  if (!isFraction(value["fractionRemaining"])) {
    return invalid("history point fractionRemaining must be a 0..1 number");
  }
  return { fetchedAt: value["fetchedAt"], fractionRemaining: value["fractionRemaining"] };
};

const parseProviderQuota = (value: unknown): ProviderQuota => {
  if (!isRecord(value)) {
    return invalid("provider quota must be an object");
  }
  if (!isNullablePercent(value["percentRemaining"])) {
    return invalid("provider percentRemaining must be null or a 0..100 number");
  }
  if (!isNullableIsoInstant(value["resetAt"])) {
    return invalid("provider resetAt must be null or an ISO instant");
  }
  if (!isNullablePercent(value["weeklyPercentRemaining"])) {
    return invalid("provider weeklyPercentRemaining must be null or a 0..100 number");
  }
  if (!isNullableIsoInstant(value["weeklyResetAt"])) {
    return invalid("provider weeklyResetAt must be null or an ISO instant");
  }
  if (typeof value["unavailable"] !== "boolean") {
    return invalid("provider unavailable must be a boolean");
  }
  if (!isNullableIsoInstant(value["fetchedAt"])) {
    return invalid("provider fetchedAt must be null or an ISO instant");
  }
  if (!Array.isArray(value["history"]) || value["history"].length > QUOTA_HISTORY_LIMIT) {
    return invalid(`provider history must be an array of at most ${QUOTA_HISTORY_LIMIT} points`);
  }
  return {
    percentRemaining: value["percentRemaining"],
    resetAt: value["resetAt"],
    weeklyPercentRemaining: value["weeklyPercentRemaining"],
    weeklyResetAt: value["weeklyResetAt"],
    unavailable: value["unavailable"],
    fetchedAt: value["fetchedAt"],
    history: value["history"].map(parseHistoryPoint),
  };
};

/**
 * Validate an unknown value as a quota snapshot, returning a newly constructed
 * snapshot. Unknown provider keys are ignored (not rejected) so a newer daemon
 * adding a provider never breaks an older strip app — a deliberate divergence
 * from src/protocol.ts's provider strictness, this file having exactly one
 * reader shipped in the same repo. Throws on any other contract violation; no
 * coercion.
 */
export const parseQuotaSnapshot = (value: unknown): QuotaSnapshot => {
  if (!isRecord(value)) {
    return invalid("snapshot must be an object");
  }
  if (value["schemaVersion"] !== QUOTA_SNAPSHOT_SCHEMA_VERSION) {
    return invalid(`schemaVersion must be ${QUOTA_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!isRecord(value["providers"])) {
    return invalid("providers must be an object");
  }
  const providers: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
  for (const key of Object.keys(value["providers"])) {
    if (!QUOTA_PROVIDERS.has(key)) {
      continue;
    }
    providers[key as QuotaProviderKey] = parseProviderQuota(value["providers"][key]);
  }
  return { schemaVersion: QUOTA_SNAPSHOT_SCHEMA_VERSION, providers };
};
```

- [ ] **Step 4: Run test to verify it passes**
Run: `bun test test/quota-snapshot.test.ts && bun run typecheck` — Expected: all pass.

- [ ] **Step 5: Commit**
`git add src/quota-snapshot.ts test/quota-snapshot.test.ts test/fixtures/quota/quota-snapshot.json` — message: `feat(core): quota snapshot contract module`

---

### Task 2: Credential readers and usage-response normalizers

**Files:**
- Create: `src/core/quota.ts` (parsers/normalizers only; the collector lands in Task 3)
- Create: `test/quota.test.ts`
- Create: `test/fixtures/quota/claude-credentials.json`, `test/fixtures/quota/codex-auth.json`, `test/fixtures/quota/claude-usage.json`, `test/fixtures/quota/codex-usage.json`

**Interfaces:**
- Consumes: `isRecord`-style guards (local), the endpoint facts in the Research section.
- Produces: `ClaudeCredentials`, `parseClaudeCredentials(contents: string): ClaudeCredentials | null`; `CodexAuth`, `parseCodexAuth(contents: string): CodexAuth | null`; `QuotaWindowReading`, `ProviderQuotaReading`, `normalizeClaudeUsage(body: string): ProviderQuotaReading | null`, `normalizeCodexUsage(body: string): ProviderQuotaReading | null`.

- [ ] **Step 1: Write the failing test**

Create `test/quota.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeClaudeUsage,
  normalizeCodexUsage,
  parseClaudeCredentials,
  parseCodexAuth,
} from "../src/core/quota";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "quota", name), "utf8");

describe("parseClaudeCredentials", () => {
  test("reads the captured claudeAiOauth shape", () => {
    expect(parseClaudeCredentials(fixture("claude-credentials.json"))).toEqual({
      accessToken: "sk-ant-oat01-FAKE",
      expiresAtMs: 4_800_000_000_000,
      hasProfileScope: true,
    });
  });

  test("returns null for malformed JSON, missing oauth block, and empty token", () => {
    expect(parseClaudeCredentials("not json")).toBeNull();
    expect(parseClaudeCredentials(JSON.stringify({ mcpOAuth: {} }))).toBeNull();
    expect(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toBeNull();
  });

  test("tolerates a missing expiresAt and missing scopes", () => {
    const parsed = parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
    expect(parsed).toEqual({ accessToken: "tok", expiresAtMs: null, hasProfileScope: false });
  });
});

describe("parseCodexAuth", () => {
  test("reads the captured tokens shape", () => {
    expect(parseCodexAuth(fixture("codex-auth.json"))).toEqual({
      accessToken: "FAKE-ACCESS-TOKEN",
      accountId: "acct_fake",
    });
  });

  test("returns null when only OPENAI_API_KEY is present (no quota surface)", () => {
    expect(parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-fake" }))).toBeNull();
  });

  test("tolerates camelCase token keys and a missing account id", () => {
    expect(parseCodexAuth(JSON.stringify({ tokens: { accessToken: "tok" } }))).toEqual({
      accessToken: "tok",
      accountId: null,
    });
  });

  test("returns null for malformed JSON and empty token", () => {
    expect(parseCodexAuth("nope")).toBeNull();
    expect(parseCodexAuth(JSON.stringify({ tokens: { access_token: "" } }))).toBeNull();
  });
});

describe("normalizeClaudeUsage", () => {
  test("maps five_hour/seven_day utilization to percent remaining", () => {
    expect(normalizeClaudeUsage(fixture("claude-usage.json"))).toEqual({
      session: { percentRemaining: 62.5, resetAt: "2026-08-19T22:00:00.000Z" },
      weekly: { percentRemaining: 88, resetAt: "2026-08-24T00:00:00.000Z" },
    });
  });

  test("returns null when five_hour is missing or utilization is out of range", () => {
    expect(normalizeClaudeUsage(JSON.stringify({ seven_day: { utilization: 1 } }))).toBeNull();
    expect(normalizeClaudeUsage(JSON.stringify({ five_hour: { utilization: 250 } }))).toBeNull();
    expect(normalizeClaudeUsage("junk")).toBeNull();
  });

  test("a missing or malformed seven_day leaves weekly null without failing the session window", () => {
    expect(normalizeClaudeUsage(JSON.stringify({ five_hour: { utilization: 10, resets_at: "bad" } }))).toEqual({
      session: { percentRemaining: 90, resetAt: null },
      weekly: null,
    });
  });
});

describe("normalizeCodexUsage", () => {
  test("maps primary/secondary windows to percent remaining with ISO resets", () => {
    expect(normalizeCodexUsage(fixture("codex-usage.json"))).toEqual({
      session: { percentRemaining: 73, resetAt: new Date(1_787_169_600 * 1000).toISOString() },
      weekly: { percentRemaining: 45, resetAt: new Date(1_787_616_000 * 1000).toISOString() },
    });
  });

  test("returns null when rate_limit.primary_window is missing or malformed", () => {
    expect(normalizeCodexUsage(JSON.stringify({ plan_type: "pro" }))).toBeNull();
    expect(normalizeCodexUsage(JSON.stringify({ rate_limit: { primary_window: { used_percent: 101 } } }))).toBeNull();
    expect(normalizeCodexUsage("junk")).toBeNull();
  });

  test("a missing secondary window leaves weekly null", () => {
    const body = JSON.stringify({ rate_limit: { primary_window: { used_percent: 0, reset_at: 0 } } });
    expect(normalizeCodexUsage(body)).toEqual({ session: { percentRemaining: 100, resetAt: null }, weekly: null });
  });
});
```

Fixtures (all synthetic). `test/fixtures/quota/claude-credentials.json`:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-FAKE",
    "refreshToken": "sk-ant-ort01-FAKE",
    "expiresAt": 4800000000000,
    "scopes": ["user:inference", "user:profile"],
    "rateLimitTier": "default_claude_max_5x",
    "subscriptionType": "claude_max"
  }
}
```

`test/fixtures/quota/codex-auth.json`:

```json
{
  "OPENAI_API_KEY": null,
  "auth_mode": "chatgpt",
  "tokens": {
    "id_token": "FAKE-ID-TOKEN",
    "access_token": "FAKE-ACCESS-TOKEN",
    "refresh_token": "FAKE-REFRESH-TOKEN",
    "account_id": "acct_fake"
  },
  "last_refresh": "2026-08-19T00:00:00.000Z"
}
```

`test/fixtures/quota/claude-usage.json` (shape per ClaudeOAuthUsageFetcher.swift; fractional UTC offsets included on purpose):

```json
{
  "five_hour": { "utilization": 37.5, "resets_at": "2026-08-19T22:00:00.000000+00:00" },
  "seven_day": { "utilization": 12.0, "resets_at": "2026-08-24T00:00:00.000000+00:00" },
  "seven_day_sonnet": { "utilization": 8.0, "resets_at": "2026-08-24T00:00:00.000000+00:00" },
  "extra_usage": { "is_enabled": false, "monthly_limit": null, "used_credits": null, "utilization": null, "currency": null }
}
```

`test/fixtures/quota/codex-usage.json` (shape per CodexOAuthUsageFetcher.swift; `reset_at` values are epoch seconds — 1787169600 = 2026-08-19T20:00:00Z, 1787616000 = 2026-08-25T00:00:00Z):

```json
{
  "plan_type": "pro",
  "rate_limit": {
    "primary_window": { "used_percent": 27, "reset_at": 1787169600, "limit_window_seconds": 18000 },
    "secondary_window": { "used_percent": 55, "reset_at": 1787616000, "limit_window_seconds": 604800 }
  },
  "credits": { "has_credits": false, "unlimited": true, "balance": null }
}
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bun test test/quota.test.ts` — Expected: FAIL (module `../src/core/quota` does not exist).

- [ ] **Step 3: Minimal implementation**

Create `src/core/quota.ts` (the module doc comment records the researched endpoint contract so it never has to be re-derived; the collector is appended in Task 3):

```ts
/**
 * Quota collection for the strip's rail panels (codex + claude).
 *
 * Endpoint contract (researched from CodexBar's source — docs/superpowers/plans/
 * 2026-08-19-xeneon-strip-quota.md records the citations):
 * - claude: GET https://api.anthropic.com/api/oauth/usage with the OAuth access
 *   token from ~/.claude/.credentials.json (claudeAiOauth.accessToken), headers
 *   `anthropic-beta: oauth-2025-04-20` and a claude-code User-Agent. Windows:
 *   five_hour / seven_day, each { utilization (percent used 0..100), resets_at
 *   (ISO) }. Tokens are never refreshed or written back — Claude Code owns
 *   rotation and the file is re-read every pass.
 * - codex: GET https://chatgpt.com/backend-api/wham/usage with the OAuth access
 *   token from ($CODEX_HOME ?? ~/.codex)/auth.json (tokens.access_token, plus a
 *   ChatGPT-Account-Id header when tokens.account_id is present). Windows:
 *   rate_limit.primary_window / secondary_window, each { used_percent (0..100),
 *   reset_at (epoch seconds) }. An auth.json holding only OPENAI_API_KEY has no
 *   quota surface and is treated as absent.
 *
 * No token, response body, or error text is ever logged or written anywhere.
 */

export type ClaudeCredentials = {
  accessToken: string;
  /** claudeAiOauth.expiresAt, epoch milliseconds; null when absent. */
  expiresAtMs: number | null;
  /** The usage endpoint requires the user:profile scope (inference-only tokens get 403s). */
  hasProfileScope: boolean;
};

export type CodexAuth = { accessToken: string; accountId: string | null };

export type QuotaWindowReading = { percentRemaining: number; resetAt: string | null };

export type ProviderQuotaReading = { session: QuotaWindowReading; weekly: QuotaWindowReading | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPercentUsed = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

/** Normalize a provider ISO string to canonical UTC; unparseable → null. */
const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

const epochSecondsOrNull = (value: unknown): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000).toISOString();
};

export const parseClaudeCredentials = (contents: string): ClaudeCredentials | null => {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isRecord(parsed) || !isRecord(parsed["claudeAiOauth"])) {
      return null;
    }
    const oauth = parsed["claudeAiOauth"];
    if (typeof oauth["accessToken"] !== "string" || oauth["accessToken"].length === 0) {
      return null;
    }
    const expiresAt = oauth["expiresAt"];
    const scopes = oauth["scopes"];
    return {
      accessToken: oauth["accessToken"],
      expiresAtMs: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null,
      hasProfileScope: Array.isArray(scopes) && scopes.includes("user:profile"),
    };
  } catch {
    return null;
  }
};

export const parseCodexAuth = (contents: string): CodexAuth | null => {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isRecord(parsed) || !isRecord(parsed["tokens"])) {
      return null;
    }
    const tokens = parsed["tokens"];
    const accessToken = tokens["access_token"] ?? tokens["accessToken"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      return null;
    }
    const accountId = tokens["account_id"] ?? tokens["accountId"];
    return {
      accessToken,
      accountId: typeof accountId === "string" && accountId.length > 0 ? accountId : null,
    };
  } catch {
    return null;
  }
};

export const normalizeClaudeUsage = (body: string): ProviderQuotaReading | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed["five_hour"]) || !isPercentUsed(parsed["five_hour"]["utilization"])) {
    return null;
  }
  const session: QuotaWindowReading = {
    percentRemaining: 100 - parsed["five_hour"]["utilization"],
    resetAt: isoOrNull(parsed["five_hour"]["resets_at"]),
  };
  let weekly: QuotaWindowReading | null = null;
  const sevenDay = parsed["seven_day"];
  if (isRecord(sevenDay) && isPercentUsed(sevenDay["utilization"])) {
    weekly = { percentRemaining: 100 - sevenDay["utilization"], resetAt: isoOrNull(sevenDay["resets_at"]) };
  }
  return { session, weekly };
};

export const normalizeCodexUsage = (body: string): ProviderQuotaReading | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed["rate_limit"])) {
    return null;
  }
  const rateLimit = parsed["rate_limit"];
  const primary = rateLimit["primary_window"];
  if (!isRecord(primary) || !isPercentUsed(primary["used_percent"])) {
    return null;
  }
  const session: QuotaWindowReading = {
    percentRemaining: 100 - primary["used_percent"],
    resetAt: epochSecondsOrNull(primary["reset_at"]),
  };
  let weekly: QuotaWindowReading | null = null;
  const secondary = rateLimit["secondary_window"];
  if (isRecord(secondary) && isPercentUsed(secondary["used_percent"])) {
    weekly = { percentRemaining: 100 - secondary["used_percent"], resetAt: epochSecondsOrNull(secondary["reset_at"]) };
  }
  return { session, weekly };
};
```

- [ ] **Step 4: Run test to verify it passes**
Run: `bun test test/quota.test.ts && bun run typecheck` — Expected: all pass.

- [ ] **Step 5: Commit**
`git add src/core/quota.ts test/quota.test.ts test/fixtures/quota/claude-credentials.json test/fixtures/quota/codex-auth.json test/fixtures/quota/claude-usage.json test/fixtures/quota/codex-usage.json` — message: `feat(core): quota credential readers and usage normalizers`

---

### Task 3: The quota collector (fetch orchestration, failure isolation, atomic publish)

**Files:**
- Modify: `src/core/quota.ts` (append the collector below the Task-2 normalizers)
- Modify: `src/core/snapshot.ts:14-50` (extract a generic atomic writer)
- Modify: `src/core/diagnostics.ts:17-28` (add one diagnostic code)
- Modify: `test/quota.test.ts` (append collector describes)

**Interfaces:**
- Consumes: `parseClaudeCredentials`/`parseCodexAuth`/`normalizeClaudeUsage`/`normalizeCodexUsage` (Task 2); `parseQuotaSnapshot`, `QUOTA_PROVIDER_KEYS`, `QUOTA_HISTORY_LIMIT`, `ProviderQuota`, `QuotaProviderKey`, `QuotaSnapshot` (Task 1); `writeFileAtomically` (this task, from `snapshot.ts`); `DiagnosticRecord` (`src/core/diagnostics.ts:30-36`).
- Produces: `QUOTA_POLL_INTERVAL_MS` (120_000), `QUOTA_RATE_LIMIT_COOLDOWN_MS` (600_000), `QUOTA_FETCH_TIMEOUT_MS` (15_000), `QuotaFetch`, `QuotaFetchResponse`, `QuotaScheduler`, `QuotaCollectorDependencies`, `QuotaCollector` (`{ start, stop, pollNow }`), `createQuotaCollector(dependencies): QuotaCollector`; `writeFileAtomically(path: string, payload: string): void` in `snapshot.ts`; `"quota_failed"` in `DiagnosticCode`.

Behavior contract (all covered by tests below):
- Per pass, per provider, in `QUOTA_PROVIDER_KEYS` order: credentials file unreadable/absent/unparseable (or codex API-key-only) → provider **omitted** from the snapshot (the panel disappears; never claims a broken account). Expired claude token, missing `user:profile` scope, non-200 status, fetch throw, or unparseable body → provider kept with `unavailable: true`, last-good numbers/history untouched. 429 → same, plus a 10-minute per-provider cooldown that skips later fetches.
- Success → replace the window fields, stamp `fetchedAt`, clear `unavailable`, append `{ fetchedAt, fractionRemaining: percentRemaining / 100 }` to the ring capped at `QUOTA_HISTORY_LIMIT`.
- The snapshot file is rewritten (atomically) only when the canonical JSON changed. On startup the existing file is parsed and seeded as last-good state, so a daemon restart never blanks the panels.
- A failure is logged (`component: "quota"`, `code: "quota_failed"`, provider set) only on the transition into failure — never per pass, never with error text.
- `pollNow` is reentrancy-guarded; `start()` polls immediately then arms the interval; `stop()` disarms.

- [ ] **Step 1: Write the failing test**

Append to `test/quota.test.ts` (keep the Task-2 content; merge the new names into the existing `bun:test`, `node:fs`, `node:path`, and `../src/core/quota` imports — one import statement per module — and add the rest):

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach } from "bun:test";
import {
  createQuotaCollector,
  QUOTA_RATE_LIMIT_COOLDOWN_MS,
  type QuotaCollectorDependencies,
  type QuotaFetch,
} from "../src/core/quota";
import type { DiagnosticRecord } from "../src/core/diagnostics";
import { parseQuotaSnapshot } from "../src/quota-snapshot";

const NOW = "2026-08-19T18:00:00.000Z";
const NOW_MS = Date.parse(NOW);

describe("createQuotaCollector", () => {
  let tempDir: string;
  let quotaPath: string;
  let claudeCredsPath: string;
  let codexAuthPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "stream-deck-agents-quota-"));
    quotaPath = join(tempDir, "quota-snapshot.json");
    claudeCredsPath = join(tempDir, "claude-credentials.json");
    codexAuthPath = join(tempDir, "codex-auth.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  type Harness = {
    deps: QuotaCollectorDependencies;
    fetches: { url: string; headers: Record<string, string> }[];
    diagnostics: DiagnosticRecord[];
    respond: (status: number, body: string) => void;
    fail: () => void;
    writes: () => string[];
  };

  const makeHarness = (files: Record<string, string>, overrides: Partial<QuotaCollectorDependencies> = {}): Harness => {
    const fetches: { url: string; headers: Record<string, string> }[] = [];
    const diagnostics: DiagnosticRecord[] = [];
    const writes: string[] = [];
    let status = 200;
    let body = "{}";
    let throws = false;
    const fetchSpy: QuotaFetch = async (url, headers) => {
      fetches.push({ url, headers });
      if (throws) {
        throw new Error("network down");
      }
      const fixtureBody = url.includes("anthropic") ? fixture("claude-usage.json") : fixture("codex-usage.json");
      return { status, body: body === "{}" ? fixtureBody : body };
    };
    return {
      deps: {
        claudeCredentialsPath: claudeCredsPath,
        codexAuthPath: codexAuthPath,
        quotaSnapshotPath: quotaPath,
        fetch: fetchSpy,
        readFile: (path) => files[path] ?? null,
        now: () => NOW,
        nowMs: () => NOW_MS,
        writeFile: (_path, payload) => {
          writes.push(payload);
        },
        diagnostics: (record) => {
          diagnostics.push(record);
        },
        ...overrides,
      },
      fetches,
      diagnostics,
      respond: (nextStatus, nextBody) => {
        status = nextStatus;
        body = nextBody;
        throws = false;
      },
      fail: () => {
        throws = true;
      },
      writes: () => writes,
    };
  };

  const credsFiles = (): Record<string, string> => ({
    [claudeCredsPath]: fixture("claude-credentials.json"),
    [codexAuthPath]: fixture("codex-auth.json"),
  });

  test("publishes both providers after successful fetches", async () => {
    const harness = makeHarness(credsFiles());
    await createQuotaCollector(harness.deps).pollNow();
    const writes = harness.writes();
    expect(writes.length).toBe(1);
    const snapshot = parseQuotaSnapshot(JSON.parse(writes[0] ?? ""));
    expect(snapshot.providers["claude"]).toMatchObject({
      percentRemaining: 62.5,
      resetAt: "2026-08-19T22:00:00.000Z",
      weeklyPercentRemaining: 88,
      unavailable: false,
      fetchedAt: NOW,
    });
    expect(snapshot.providers["claude"]?.history).toEqual([{ fetchedAt: NOW, fractionRemaining: 0.625 }]);
    expect(snapshot.providers["codex"]).toMatchObject({ percentRemaining: 73, weeklyPercentRemaining: 45 });
    const claudeFetch = harness.fetches.find((entry) => entry.url.includes("anthropic"));
    expect(claudeFetch?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(claudeFetch?.headers["Authorization"]).toBe("Bearer sk-ant-oat01-FAKE");
    const codexFetch = harness.fetches.find((entry) => entry.url.includes("chatgpt"));
    expect(codexFetch?.headers["ChatGPT-Account-Id"]).toBe("acct_fake");
  });

  test("a failed fetch keeps last-good data, marks unavailable, and logs only the transition", async () => {
    const harness = makeHarness(credsFiles());
    const collector = createQuotaCollector(harness.deps);
    await collector.pollNow();
    harness.respond(500, "server error");
    await collector.pollNow();
    await collector.pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? ""));
    expect(snapshot.providers["claude"]).toMatchObject({
      percentRemaining: 62.5,
      unavailable: true,
      fetchedAt: NOW,
    });
    expect(snapshot.providers["claude"]?.history.length).toBe(1);
    const failures = harness.diagnostics.filter((record) => record.code === "quota_failed");
    expect(failures.length).toBe(2); // one per provider, on the false→true transition only
    expect(failures.every((record) => record.component === "quota")).toBe(true);
  });

  test("a network throw degrades the same way and never escapes pollNow", async () => {
    const harness = makeHarness(credsFiles());
    harness.fail();
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["claude"]?.unavailable).toBe(true);
    expect(snapshot.providers["claude"]?.percentRemaining).toBeNull();
  });

  test("missing credential files omit the provider entirely", async () => {
    const harness = makeHarness({});
    await createQuotaCollector(harness.deps).pollNow();
    expect(harness.fetches.length).toBe(0);
    expect(parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? "")).providers).toEqual({});
  });

  test("an api-key-only codex auth.json is omitted; an expired claude token is unavailable without a fetch", async () => {
    const harness = makeHarness({
      [claudeCredsPath]: JSON.stringify({
        claudeAiOauth: { accessToken: "tok", expiresAt: NOW_MS - 1, scopes: ["user:profile"] },
      }),
      [codexAuthPath]: JSON.stringify({ OPENAI_API_KEY: "sk-fake" }),
    });
    await createQuotaCollector(harness.deps).pollNow();
    expect(harness.fetches.length).toBe(0);
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["claude"]?.unavailable).toBe(true);
    expect(snapshot.providers["codex"]).toBeUndefined();
  });

  test("a 429 arms the cooldown and the next pass skips the fetch", async () => {
    const harness = makeHarness(credsFiles());
    const collector = createQuotaCollector(harness.deps);
    harness.respond(429, "rate limited");
    await collector.pollNow();
    expect(harness.fetches.length).toBe(2);
    await collector.pollNow();
    expect(harness.fetches.length).toBe(2); // both providers in cooldown, no new fetches
  });

  test("concurrent pollNow calls collapse into one pass", async () => {
    const harness = makeHarness(credsFiles());
    const collector = createQuotaCollector(harness.deps);
    await Promise.all([collector.pollNow(), collector.pollNow()]);
    expect(harness.fetches.length).toBe(2);
  });

  test("writes happen only when the snapshot changes", async () => {
    const harness = makeHarness(credsFiles());
    const collector = createQuotaCollector(harness.deps);
    await collector.pollNow();
    await collector.pollNow(); // history appends each success, so this differs
    const writesAfterTwo = harness.writes().length;
    expect(writesAfterTwo).toBe(2);
    // A failing pass after a failure writes nothing new once state has converged:
    harness.fail();
    await collector.pollNow();
    const afterFailure = harness.writes().length;
    await collector.pollNow();
    expect(harness.writes().length).toBe(afterFailure);
  });

  test("seeding from an existing file preserves last-good data across a restart", async () => {
    const seeded = JSON.stringify({
      schemaVersion: 1,
      providers: {
        claude: {
          percentRemaining: 62.5,
          resetAt: "2026-08-19T22:00:00.000Z",
          weeklyPercentRemaining: 88,
          weeklyResetAt: "2026-08-24T00:00:00.000Z",
          unavailable: false,
          fetchedAt: "2026-08-19T17:00:00.000Z",
          history: [{ fetchedAt: "2026-08-19T17:00:00.000Z", fractionRemaining: 0.625 }],
        },
      },
    });
    const harness = makeHarness(credsFiles(), {
      readFile: (path) => (path === quotaPath ? seeded : (credsFiles()[path] ?? null)),
    });
    harness.fail();
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["claude"]).toMatchObject({ percentRemaining: 62.5, unavailable: true });
  });

  test("the cooldown constant is ten minutes", () => {
    expect(QUOTA_RATE_LIMIT_COOLDOWN_MS).toBe(600_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bun test test/quota.test.ts` — Expected: FAIL (`createQuotaCollector`, `QUOTA_RATE_LIMIT_COOLDOWN_MS`, `QuotaFetch` etc. not exported yet; also `writeFileAtomically` does not exist).

- [ ] **Step 3: Minimal implementation**

3a. In `src/core/snapshot.ts`, replace the body of `writeSnapshotAtomically` (lines 21-50) with an extracted generic plus a thin wrapper (imports gain `basename` from `node:path`):

```ts
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SessionSnapshotV2 } from "../protocol";

const SNAPSHOT_FILE_MODE = 0o600;

/**
 * The atomic-publish primitive behind every file this project owns: serialize
 * to a unique sibling temporary file (mode 0600, fsynced), then rename over
 * the target so readers only ever see a complete file.
 */
export const writeFileAtomically = (path: string, payload: string): void => {
  const tempPath = join(dirname(path), `.${basename(path)}-${process.pid}-${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const fd = openSync(tempPath, "wx", SNAPSHOT_FILE_MODE);
    let closed = false;
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
      chmodSync(tempPath, SNAPSHOT_FILE_MODE);
      closeSync(fd);
      closed = true;
    } finally {
      if (!closed) {
        try {
          closeSync(fd);
        } catch {
          // The original failure is the one worth propagating.
        }
      }
    }
    renameSync(tempPath, path);
    renamed = true;
  } finally {
    if (!renamed) {
      rmSync(tempPath, { force: true });
    }
  }
};

export const writeSnapshotAtomically = (path: string, snapshot: SessionSnapshotV2): void => {
  writeFileAtomically(path, `${JSON.stringify(snapshot)}\n`);
};
```

(Also extend the module doc comment at `src/core/snapshot.ts:1-12` with one sentence: `writeFileAtomically` is the shared primitive, also used by the quota collector for `quota-snapshot.json`.)

3b. In `src/core/diagnostics.ts:17-28`, add one member to the `DiagnosticCode` union (after `"maintenance_failed"`):

```ts
  | "maintenance_failed"
  | "quota_failed";
```

3c. Append the collector to `src/core/quota.ts` (new imports at top: `readFileSync` from `node:fs`; `QUOTA_HISTORY_LIMIT`, `QUOTA_PROVIDER_KEYS`, `parseQuotaSnapshot`, and the quota types via `import type` from `../quota-snapshot`; `DiagnosticRecord` via `import type` from `./diagnostics`; `writeFileAtomically` from `./snapshot`):

```ts
/** Quota endpoints rate-limit (Anthropic 429s aggressive pollers) and the windows move slowly. */
export const QUOTA_POLL_INTERVAL_MS = 120_000;
/** After a 429, skip that provider for this long before retrying. */
export const QUOTA_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;
export const QUOTA_FETCH_TIMEOUT_MS = 15_000;

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DIAGNOSTIC_COMPONENT = "quota";

export type QuotaFetchResponse = { status: number; body: string };

export type QuotaFetch = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<QuotaFetchResponse>;

/** Same shape as the daemon's DaemonScheduler: arms a recurring tick, returns a disarm callback. */
export type QuotaScheduler = (tick: () => void, intervalMs: number) => () => void;

export type QuotaCollectorDependencies = {
  claudeCredentialsPath: string;
  codexAuthPath: string;
  quotaSnapshotPath: string;
  fetch?: QuotaFetch;
  readFile?: (path: string) => string | null;
  now?: () => string;
  nowMs?: () => number;
  writeFile?: (path: string, payload: string) => void;
  schedule?: QuotaScheduler;
  diagnostics?: (record: DiagnosticRecord) => void;
};

export type QuotaCollector = {
  /** Poll immediately, then arm the interval. */
  start: () => void;
  /** Disarm the interval; an in-flight fetch settles on its own. */
  stop: () => void;
  /** One collection pass; reentrancy-guarded, never throws. */
  pollNow: () => Promise<void>;
};

type FetchOutcome =
  | { kind: "ok"; reading: ProviderQuotaReading }
  /** No usable credentials on disk — the provider is omitted (the panel disappears). */
  | { kind: "absent" }
  | { kind: "failed"; rateLimited: boolean };

type ProviderState = { quota: ProviderQuota; cooldownUntilMs: number | null };

const emptyQuota = (): ProviderQuota => ({
  percentRemaining: null,
  resetAt: null,
  weeklyPercentRemaining: null,
  weeklyResetAt: null,
  unavailable: true,
  fetchedAt: null,
  history: [],
});

const defaultReadFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const defaultFetch: QuotaFetch = async (url, headers, timeoutMs) => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, body: await response.text() };
};

const defaultSchedule: QuotaScheduler = (tick, intervalMs) => {
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
};

export const createQuotaCollector = (dependencies: QuotaCollectorDependencies): QuotaCollector => {
  const doFetch = dependencies.fetch ?? defaultFetch;
  const readFile = dependencies.readFile ?? defaultReadFile;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const nowMs = dependencies.nowMs ?? (() => Date.now());
  const writeFile = dependencies.writeFile ?? writeFileAtomically;
  const schedule = dependencies.schedule ?? defaultSchedule;
  const diagnostics = dependencies.diagnostics ?? (() => {});

  const states = new Map<QuotaProviderKey, ProviderState>();
  let lastWrittenJson: string | null = null;
  let polling = false;
  let cancelSchedule: (() => void) | null = null;

  const reportFailure = (provider: QuotaProviderKey): void => {
    try {
      diagnostics({ timestamp: now(), component: DIAGNOSTIC_COMPONENT, code: "quota_failed", provider });
    } catch {
      // Diagnostics must never break the collector.
    }
  };

  // Seed last-good state from the previous publication so a daemon restart
  // never blanks the panels.
  try {
    const existing = readFile(dependencies.quotaSnapshotPath);
    if (existing !== null) {
      const seeded = parseQuotaSnapshot(JSON.parse(existing));
      for (const key of QUOTA_PROVIDER_KEYS) {
        const quota = seeded.providers[key];
        if (quota !== undefined) {
          states.set(key, { quota, cooldownUntilMs: null });
        }
      }
      lastWrittenJson = `${JSON.stringify(seeded)}\n`;
    }
  } catch {
    // An unreadable or unparseable file is simply rewritten on the first pass.
  }

  const probe = async (provider: QuotaProviderKey): Promise<FetchOutcome> => {
    let url: string;
    let headers: Record<string, string>;
    if (provider === "claude") {
      const contents = readFile(dependencies.claudeCredentialsPath);
      const credentials = contents === null ? null : parseClaudeCredentials(contents);
      if (credentials === null) {
        return { kind: "absent" };
      }
      if (
        (credentials.expiresAtMs !== null && credentials.expiresAtMs <= nowMs()) ||
        !credentials.hasProfileScope
      ) {
        return { kind: "failed", rateLimited: false };
      }
      url = CLAUDE_USAGE_URL;
      headers = {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
      };
    } else {
      const contents = readFile(dependencies.codexAuthPath);
      const auth = contents === null ? null : parseCodexAuth(contents);
      if (auth === null) {
        return { kind: "absent" };
      }
      url = CODEX_USAGE_URL;
      headers = { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" };
      if (auth.accountId !== null) {
        headers["ChatGPT-Account-Id"] = auth.accountId;
      }
    }
    let response: QuotaFetchResponse;
    try {
      response = await doFetch(url, headers, QUOTA_FETCH_TIMEOUT_MS);
    } catch {
      return { kind: "failed", rateLimited: false };
    }
    if (response.status === 429) {
      return { kind: "failed", rateLimited: true };
    }
    if (response.status !== 200) {
      return { kind: "failed", rateLimited: false };
    }
    const reading = provider === "claude" ? normalizeClaudeUsage(response.body) : normalizeCodexUsage(response.body);
    return reading === null ? { kind: "failed", rateLimited: false } : { kind: "ok", reading };
  };

  const pollProvider = async (provider: QuotaProviderKey): Promise<ProviderQuota | null> => {
    const state = states.get(provider) ?? { quota: emptyQuota(), cooldownUntilMs: null };
    const inCooldown = state.cooldownUntilMs !== null && nowMs() < state.cooldownUntilMs;
    const outcome = inCooldown ? ({ kind: "failed", rateLimited: true } as const) : await probe(provider);
    if (outcome.kind === "absent") {
      states.delete(provider);
      return null;
    }
    if (outcome.kind === "ok") {
      const fetchedAt = now();
      const history = [
        ...state.quota.history,
        { fetchedAt, fractionRemaining: outcome.reading.session.percentRemaining / 100 },
      ].slice(-QUOTA_HISTORY_LIMIT);
      const quota: ProviderQuota = {
        percentRemaining: outcome.reading.session.percentRemaining,
        resetAt: outcome.reading.session.resetAt,
        weeklyPercentRemaining: outcome.reading.weekly?.percentRemaining ?? null,
        weeklyResetAt: outcome.reading.weekly?.resetAt ?? null,
        unavailable: false,
        fetchedAt,
        history,
      };
      states.set(provider, { quota, cooldownUntilMs: null });
      return quota;
    }
    if (outcome.rateLimited && state.cooldownUntilMs === null) {
      state.cooldownUntilMs = nowMs() + QUOTA_RATE_LIMIT_COOLDOWN_MS;
    }
    if (!state.quota.unavailable) {
      // Log the transition into failure only — never per pass, never error text.
      reportFailure(provider);
    }
    state.quota = { ...state.quota, unavailable: true };
    states.set(provider, state);
    return state.quota;
  };

  const pollNow = async (): Promise<void> => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      const providers: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
      for (const provider of QUOTA_PROVIDER_KEYS) {
        const quota = await pollProvider(provider);
        if (quota !== null) {
          providers[provider] = quota;
        }
      }
      const snapshot: QuotaSnapshot = { schemaVersion: 1, providers };
      const json = `${JSON.stringify(snapshot)}\n`;
      if (json !== lastWrittenJson) {
        try {
          writeFile(dependencies.quotaSnapshotPath, json);
          lastWrittenJson = json;
        } catch {
          // A publication I/O failure retries on the next pass.
        }
      }
    } finally {
      polling = false;
    }
  };

  return {
    start: () => {
      void pollNow();
      cancelSchedule = schedule(() => {
        void pollNow();
      }, QUOTA_POLL_INTERVAL_MS);
    },
    stop: () => {
      cancelSchedule?.();
      cancelSchedule = null;
    },
    pollNow,
  };
};
```

Note on one test/implementation interplay: `QuotaSnapshot["schemaVersion"]` is the literal `1`; writing `schemaVersion: 1` in `pollNow` typechecks. The `weeklyResetAt`/`weeklyPercentRemaining` null-fallbacks satisfy `exactOptionalPropertyTypes` because the fields are declared `| null`, not optional.

- [ ] **Step 4: Run test to verify it passes**
Run: `bun test test/quota.test.ts test/quota-snapshot.test.ts && bun run typecheck && bun run lint` — Expected: all pass. Then run the full `bun test` once to confirm the `snapshot.ts` refactor didn't disturb the daemon/plugin suites.

- [ ] **Step 5: Commit**
`git add src/core/quota.ts src/core/snapshot.ts src/core/diagnostics.ts test/quota.test.ts` — message: `feat(core): quota collector with failure isolation`

---

### Task 4: Wire the collector into the daemon process

**Files:**
- Modify: `src/core/paths.ts:12-21,25-38` (add `quotaSnapshot`)
- Modify: `src/core/cli.ts:408-428` (construct + start the collector in the default `runDaemon`)
- Modify: `test/schema.test.ts:93-111` (extend the `resolveAppPaths` expectation)

**Interfaces:**
- Consumes: `createQuotaCollector` (Task 3); `AppPaths` gains `quotaSnapshot: string` → `join(root, "quota-snapshot.json")`.
- Produces: `AppPaths.quotaSnapshot`; the running daemon process now owns the quota collector.

- [ ] **Step 1: Write the failing test**

In `test/schema.test.ts`, inside `describe("resolveAppPaths")` → the test `"returns the exact canonical per-user paths under the given home"` (lines 94-104), add one expectation after the `paths.snapshot` line (line 101):

```ts
    expect(paths.quotaSnapshot).toBe(join(root, "quota-snapshot.json"));
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bun test test/schema.test.ts` — Expected: FAIL (`undefined` vs the expected path).

- [ ] **Step 3: Minimal implementation**

3a. `src/core/paths.ts` — in the `AppPaths` type (line 18), add after `snapshot: string;`:

```ts
  quotaSnapshot: string;
```

and in `resolveAppPaths` (after line 34's `snapshot: join(root, "snapshot-v2.json"),`):

```ts
    quotaSnapshot: join(root, "quota-snapshot.json"),
```

3b. `src/core/cli.ts` — add the import (with the other `./…` imports near line 43):

```ts
import { createQuotaCollector } from "./quota";
```

In the default `runDaemon` closure (lines 408-428), after the `grokRoot` line (line 411) add:

```ts
    const codexRoot = environment["CODEX_HOME"] ?? join(daemonPaths.home, ".codex");
    const quotaCollector = createQuotaCollector({
      claudeCredentialsPath: join(daemonPaths.home, ".claude/.credentials.json"),
      codexAuthPath: join(codexRoot, "auth.json"),
      quotaSnapshotPath: daemonPaths.quotaSnapshot,
      diagnostics,
    });
```

and after `daemon.start();` (line 424) add:

```ts
    quotaCollector.start();
```

The collector runs on its own scheduler inside the daemon process — deliberately **not** inside `ProjectionDaemon.maintain` (a synchronous loop that cannot await fetches; a fire-and-forget hook there would need reentrancy guards inside the session pipeline). This keeps a quota failure physically incapable of touching session publication.

- [ ] **Step 4: Run test to verify it passes**
Run: `bun test test/schema.test.ts test/cli.test.ts test/daemon.test.ts && bun run typecheck` — Expected: all pass (the cli/daemon suites inject `runDaemon`, so the new closure body is compile-checked here and exercised live in manual verification).

- [ ] **Step 5: Commit**
`git add src/core/paths.ts src/core/cli.ts test/schema.test.ts` — message: `feat(core): wire quota collector into daemon`

---

### Task 5: Tauri command `read_quota_snapshot` + bridge wrapper

**Files:**
- Modify: `app/src-tauri/src/main.rs:20-32,82-88`
- Modify: `app/src/bridge.ts:6-8`

**Interfaces:**
- Consumes: the `SnapshotPayload` struct and `app_support_root()` already in `main.rs`.
- Produces: Tauri command `read_quota_snapshot` → `Result<SnapshotPayload, String>` (`{ mtimeMs, contents }`; missing file → the typed error string `"quota_snapshot_missing"`); `readQuotaSnapshot(): Promise<SnapshotPayload>` in `app/src/bridge.ts`.

- [ ] **Step 1: Write the failing test**
No Rust or IPC unit-test harness exists in this repo (bridge wrappers are one-line `invoke` pass-throughs, untested by convention). The honest substitute gates: `cargo check` (compile) in Step 4 and the on-panel checklist (missing-file → no panels) at the end. The frontend reduction over this command's success/failure is fully unit-tested in Task 6.

- [ ] **Step 2: Run test to verify it fails**
Run: `cargo check --manifest-path app/src-tauri/Cargo.toml` before the change passes; after Step 3a but before registering the handler, the unused-function warning confirms the wiring gap. (This task's red/green is the compile + handler registration.)

- [ ] **Step 3: Minimal implementation**

3a. `app/src-tauri/src/main.rs` — after `read_snapshot` (line 32), add:

```rust
/// The quota snapshot lives next to the session snapshot but is owned by the
/// daemon's quota collector; a missing file simply means "no quota data yet"
/// and is reported as a fixed error string the frontend can branch on.
#[tauri::command]
async fn read_quota_snapshot() -> Result<SnapshotPayload, String> {
    let path = app_support_root()?.join("quota-snapshot.json");
    let metadata = std::fs::metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "quota_snapshot_missing".to_string()
        } else {
            error.to_string()
        }
    })?;
    let mtime_ms = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    let contents = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok(SnapshotPayload { mtime_ms, contents })
}
```

and register it in the handler list (lines 82-88):

```rust
        .invoke_handler(tauri::generate_handler![
            read_snapshot,
            read_quota_snapshot,
            read_paseo_server_id,
            ack_session,
            open_url,
            focus_ghostty
        ])
```

(App-defined `generate_handler!` commands need no capability entry; `app/src-tauri/capabilities/default.json` governs only core/plugin permissions.)

3b. `app/src/bridge.ts` — after `readSnapshot` (line 8):

```ts
export const readQuotaSnapshot = (): Promise<SnapshotPayload> => invoke<SnapshotPayload>("read_quota_snapshot");
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cargo check --manifest-path app/src-tauri/Cargo.toml && bun run build:app` — Expected: clean compile and bundle.

- [ ] **Step 5: Commit**
`git add app/src-tauri/src/main.rs app/src/bridge.ts` — message: `feat(app): read_quota_snapshot command`

---

### Task 6: Frontend quota view-model (pure, unit-tested)

**Files:**
- Create: `app/src/quota.ts`
- Create: `test/strip-quota.test.ts`
- Modify: `app/tsconfig.json:7` (add `"../src/quota-snapshot.ts"` to `include`)

**Interfaces:**
- Consumes: `parseQuotaSnapshot`, `QUOTA_PROVIDER_KEYS`, `ProviderQuota`, `QuotaHistoryPoint`, `QuotaProviderKey` (Task 1); `SnapshotPayload` (`app/src/bridge.ts:6`).
- Produces: `STALE_QUOTA_AGE_MS` (`= 3 * 120_000`), `QuotaPanelState` (`"ok" | "stale" | "unavailable"`), `QuotaPanelModel`, `reduceQuotaRead(read: SnapshotPayload | null, now: number): QuotaPanelModel[]`, `formatPercentRemaining(percent: number): string`, `formatResetCountdown(resetAtMs: number, now: number): string`, `formatWeeklyLine(percent: number | null, resetAtMs: number | null, now: number): string | null`, `quotaBarColor(percentRemaining: number): string`, `quotaStatusText(model: QuotaPanelModel, now: number): string`, `SparkPoint`, `sparklinePoints(history, width, height): SparkPoint[]`.

State semantics: `unavailable` = the collector is running but the provider's last fetch failed (panel keeps last-good numbers, dimmed, with an age line); `stale` = last success is older than three poll intervals (collector/daemon likely down; rail health shows OFFLINE too); `ok` otherwise. A missing/unparseable file yields `[]` (no panels — the "no data yet" rendering).

- [ ] **Step 1: Write the failing test**

Create `test/strip-quota.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  formatPercentRemaining,
  formatResetCountdown,
  formatWeeklyLine,
  quotaBarColor,
  quotaStatusText,
  reduceQuotaRead,
  sparklinePoints,
  STALE_QUOTA_AGE_MS,
  type QuotaPanelModel,
} from "../app/src/quota";
import type { ProviderQuota } from "../src/quota-snapshot";

const NOW = Date.parse("2026-08-19T18:00:00.000Z");

const quota = (overrides: Partial<ProviderQuota> = {}): ProviderQuota => ({
  percentRemaining: 62.5,
  resetAt: "2026-08-19T22:00:00.000Z",
  weeklyPercentRemaining: 88,
  weeklyResetAt: "2026-08-24T00:00:00.000Z",
  unavailable: false,
  fetchedAt: "2026-08-19T18:00:00.000Z",
  history: [],
  ...overrides,
});

const read = (providers: Record<string, ProviderQuota>): { mtimeMs: number; contents: string } => ({
  mtimeMs: NOW,
  contents: JSON.stringify({ schemaVersion: 1, providers }),
});

const model = (overrides: Partial<QuotaPanelModel> = {}): QuotaPanelModel => ({
  provider: "claude",
  percentRemaining: 62.5,
  resetAtMs: Date.parse("2026-08-19T22:00:00.000Z"),
  weeklyPercentRemaining: 88,
  weeklyResetAtMs: Date.parse("2026-08-24T00:00:00.000Z"),
  state: "ok",
  fetchedAtMs: NOW,
  history: [],
  ...overrides,
});

describe("reduceQuotaRead", () => {
  test("a missing or unparseable read yields no panels", () => {
    expect(reduceQuotaRead(null, NOW)).toEqual([]);
    expect(reduceQuotaRead({ mtimeMs: NOW, contents: "junk" }, NOW)).toEqual([]);
  });

  test("providers present map to ok panels with parsed instants", () => {
    const panels = reduceQuotaRead(read({ claude: quota() }), NOW);
    expect(panels.length).toBe(1);
    expect(panels[0]).toMatchObject({ provider: "claude", state: "ok", percentRemaining: 62.5 });
    expect(panels[0]?.resetAtMs).toBe(Date.parse("2026-08-19T22:00:00.000Z"));
  });

  test("a failed provider with last-good data is unavailable; an old success is stale", () => {
    expect(reduceQuotaRead(read({ claude: quota({ unavailable: true }) }), NOW)[0]?.state).toBe("unavailable");
    const oldFetch = new Date(NOW - STALE_QUOTA_AGE_MS - 1).toISOString();
    expect(reduceQuotaRead(read({ claude: quota({ fetchedAt: oldFetch }) }), NOW)[0]?.state).toBe("stale");
  });

  test("a provider that never fetched is unavailable with null instants", () => {
    const panel = reduceQuotaRead(
      read({ codex: quota({ percentRemaining: null, resetAt: null, fetchedAt: null, unavailable: true }) }),
      NOW,
    )[0];
    expect(panel).toMatchObject({ provider: "codex", state: "unavailable", fetchedAtMs: null, resetAtMs: null });
  });
});

describe("formatResetCountdown", () => {
  const resetAt = NOW + 3 * 3_600_000 + 12 * 60_000;
  test("hours and minutes, bare hours, bare minutes, days, and elapsed", () => {
    expect(formatResetCountdown(resetAt, NOW)).toBe("3h 12m");
    expect(formatResetCountdown(NOW + 2 * 3_600_000, NOW)).toBe("2h");
    expect(formatResetCountdown(NOW + 42 * 60_000, NOW)).toBe("42m");
    expect(formatResetCountdown(NOW + 49 * 3_600_000, NOW)).toBe("2d");
    expect(formatResetCountdown(NOW - 1, NOW)).toBe("resetting…");
  });
});

describe("formatWeeklyLine and formatPercentRemaining", () => {
  test("weekly line combines percent and countdown, or is null without data", () => {
    expect(formatWeeklyLine(88, NOW + 4 * 86_400_000, NOW)).toBe("week 88% left · 4d");
    expect(formatWeeklyLine(88, null, NOW)).toBe("week 88% left");
    expect(formatWeeklyLine(null, null, NOW)).toBeNull();
  });

  test("percent rounds to a whole number", () => {
    expect(formatPercentRemaining(62.5)).toBe("63%");
  });
});

describe("quotaBarColor", () => {
  test("green above 25, amber from 10, red below 10", () => {
    expect(quotaBarColor(26)).toBe("#4ade80");
    expect(quotaBarColor(25)).toBe("#ffb020");
    expect(quotaBarColor(10)).toBe("#ffb020");
    expect(quotaBarColor(9)).toBe("#ff4d67");
  });
});

describe("quotaStatusText", () => {
  test("ok panels count down to the reset", () => {
    expect(quotaStatusText(model(), NOW)).toBe("resets in 4h");
  });

  test("unavailable panels with last-good data show the last-update age", () => {
    const staleModel = model({ state: "unavailable", fetchedAtMs: NOW - 12 * 60_000 });
    expect(quotaStatusText(staleModel, NOW)).toBe("updated 12m ago");
  });

  test("unavailable panels without data say so", () => {
    expect(quotaStatusText(model({ state: "unavailable", fetchedAtMs: null, percentRemaining: null }), NOW)).toBe(
      "unavailable",
    );
  });
});

describe("sparklinePoints", () => {
  test("fewer than two samples or a zero-size canvas draws nothing", () => {
    expect(sparklinePoints([], 100, 20)).toEqual([]);
    expect(sparklinePoints([{ fetchedAt: "2026-08-19T18:00:00.000Z", fractionRemaining: 0.5 }], 100, 20)).toEqual([]);
    expect(
      sparklinePoints(
        [
          { fetchedAt: "2026-08-19T17:00:00.000Z", fractionRemaining: 1 },
          { fetchedAt: "2026-08-19T18:00:00.000Z", fractionRemaining: 0 },
        ],
        0,
        20,
      ),
    ).toEqual([]);
  });

  test("samples map time to x and fraction to inverted y across the canvas", () => {
    const points = sparklinePoints(
      [
        { fetchedAt: "2026-08-19T17:00:00.000Z", fractionRemaining: 1 },
        { fetchedAt: "2026-08-19T17:30:00.000Z", fractionRemaining: 0.5 },
        { fetchedAt: "2026-08-19T18:00:00.000Z", fractionRemaining: 0 },
      ],
      100,
      20,
    );
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 10 },
      { x: 100, y: 20 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bun test test/strip-quota.test.ts` — Expected: FAIL (module `../app/src/quota` does not exist).

- [ ] **Step 3: Minimal implementation**

Create `app/src/quota.ts`:

```ts
/**
 * Pure view-model for the rail's quota panels: reduce the quota-snapshot read
 * to per-provider panel models, plus the formatting and sparkline geometry.
 * Kept DOM-free so the logic is unit-testable; the rendering layer is
 * app/src/rail.ts.
 */

import {
  parseQuotaSnapshot,
  type ProviderQuota,
  QUOTA_PROVIDER_KEYS,
  type QuotaHistoryPoint,
  type QuotaProviderKey,
  type QuotaSnapshot,
} from "../../src/quota-snapshot";
import type { SnapshotPayload } from "./bridge";

/** Three missed 120s collector passes without a success marks the panel stale. */
export const STALE_QUOTA_AGE_MS = 3 * 120_000;

export type QuotaPanelState = "ok" | "stale" | "unavailable";

export type QuotaPanelModel = {
  provider: QuotaProviderKey;
  /** Session-window percent remaining (last-good when unavailable); null when never fetched. */
  percentRemaining: number | null;
  resetAtMs: number | null;
  weeklyPercentRemaining: number | null;
  weeklyResetAtMs: number | null;
  state: QuotaPanelState;
  fetchedAtMs: number | null;
  history: readonly QuotaHistoryPoint[];
};

const parseInstant = (value: string | null): number | null => (value === null ? null : Date.parse(value));

const panelState = (quota: ProviderQuota, fetchedAtMs: number | null, now: number): QuotaPanelState => {
  if (quota.unavailable || fetchedAtMs === null) {
    return "unavailable";
  }
  return now - fetchedAtMs > STALE_QUOTA_AGE_MS ? "stale" : "ok";
};

const panelModel = (provider: QuotaProviderKey, quota: ProviderQuota, now: number): QuotaPanelModel => {
  const fetchedAtMs = parseInstant(quota.fetchedAt);
  return {
    provider,
    percentRemaining: quota.percentRemaining,
    resetAtMs: parseInstant(quota.resetAt),
    weeklyPercentRemaining: quota.weeklyPercentRemaining,
    weeklyResetAtMs: parseInstant(quota.weeklyResetAt),
    state: panelState(quota, fetchedAtMs, now),
    fetchedAtMs,
    history: quota.history,
  };
};

export const reduceQuotaRead = (read: SnapshotPayload | null, now: number): QuotaPanelModel[] => {
  if (read === null) {
    return [];
  }
  let snapshot: QuotaSnapshot;
  try {
    snapshot = parseQuotaSnapshot(JSON.parse(read.contents));
  } catch {
    return [];
  }
  const models: QuotaPanelModel[] = [];
  for (const provider of QUOTA_PROVIDER_KEYS) {
    const quota = snapshot.providers[provider];
    if (quota !== undefined) {
      models.push(panelModel(provider, quota, now));
    }
  }
  return models;
};

export const formatPercentRemaining = (percent: number): string => `${Math.round(percent)}%`;

export const formatResetCountdown = (resetAtMs: number, now: number): string => {
  const remainingMs = resetAtMs - now;
  if (remainingMs <= 0) {
    return "resetting…";
  }
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) {
    return `${Math.round(hours / 24)}d`;
  }
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
};

export const formatWeeklyLine = (percent: number | null, resetAtMs: number | null, now: number): string | null => {
  if (percent === null) {
    return null;
  }
  const base = `week ${Math.round(percent)}% left`;
  return resetAtMs === null ? base : `${base} · ${formatResetCountdown(resetAtMs, now)}`;
};

/** Fill hue follows remaining headroom on the strip's existing status palette. */
export const quotaBarColor = (percentRemaining: number): string => {
  if (percentRemaining > 25) {
    return "#4ade80";
  }
  if (percentRemaining >= 10) {
    return "#ffb020";
  }
  return "#ff4d67";
};

export const quotaStatusText = (model: QuotaPanelModel, now: number): string => {
  if (model.state === "unavailable") {
    if (model.fetchedAtMs === null || model.percentRemaining === null) {
      return "unavailable";
    }
    const ageMinutes = Math.max(0, Math.round((now - model.fetchedAtMs) / 60_000));
    return ageMinutes < 1 ? "updated just now" : `updated ${ageMinutes}m ago`;
  }
  if (model.resetAtMs === null) {
    return "";
  }
  return `resets in ${formatResetCountdown(model.resetAtMs, now)}`;
};

export type SparkPoint = { x: number; y: number };

/**
 * Map the history ring onto a canvas of the given CSS size: oldest sample at
 * x=0, newest at x=width, full remaining at y=0 (canvas y grows downward).
 */
export const sparklinePoints = (
  history: readonly QuotaHistoryPoint[],
  width: number,
  height: number,
): SparkPoint[] => {
  if (history.length < 2 || width <= 0 || height <= 0) {
    return [];
  }
  const firstMs = Date.parse(history[0]?.fetchedAt ?? "");
  const lastMs = Date.parse(history[history.length - 1]?.fetchedAt ?? "");
  if (Number.isNaN(firstMs) || Number.isNaN(lastMs)) {
    return [];
  }
  const span = Math.max(1, lastMs - firstMs);
  return history.map((point) => ({
    x: ((Date.parse(point.fetchedAt) - firstMs) / span) * width,
    y: height - point.fractionRemaining * height,
  }));
};
```

And in `app/tsconfig.json`, extend `include` (line 7):

```json
  "include": ["src/**/*.ts", "../src/protocol.ts", "../src/plugin/layout.ts", "../src/plugin/render.ts", "../src/quota-snapshot.ts"]
```

- [ ] **Step 4: Run test to verify it passes**
Run: `bun test test/strip-quota.test.ts && bun run typecheck && bun run lint` — Expected: all pass.

- [ ] **Step 5: Commit**
`git add app/src/quota.ts test/strip-quota.test.ts app/tsconfig.json` — message: `feat(app): quota panel view logic`

---

### Task 7: Rail panels + main.ts wiring + styles

**Files:**
- Modify: `app/src/rail.ts` (whole-file update: `RailModel` gains `quota`, new section builders)
- Modify: `app/src/main.ts:11,21-27,67-84,114-121`
- Modify: `app/styles.css` (append after the `.rail-pager` block, lines 247-262)

**Interfaces:**
- Consumes: everything from Task 6; `readQuotaSnapshot` from Task 5.
- Produces: `RailModel.quota: readonly QuotaPanelModel[]` (required — the sole `renderRail` caller, `app/src/main.ts:72`, is updated in the same task).

- [ ] **Step 1: Write the failing test**
The rail renderer is DOM code with no test harness in this repo (existing strip tests cover only pure modules: `stripGridLayout`, `routeForSession`, `reduceSnapshotRead`). Every decision the renderer makes was pushed into Task 6's tested pure functions. Gates for this task: `bun run typecheck && bun run build:app && bun test` (the full suite catches the `RailModel` shape change) plus the on-panel checklist. No hollow test is added.

- [ ] **Step 2: Run to verify the current state**
Run: `bun run typecheck && bun test` — Expected: green before the change (baseline).

- [ ] **Step 3: Minimal implementation**

3a. Replace `app/src/rail.ts` wholesale (the file is small; the existing sections are preserved verbatim where noted):

```ts
/**
 * The strip's fixed right rail: daemon health (with heartbeat age), clock,
 * unread count, per-provider quota panels, and page dots. Rebuilt wholesale on
 * each render — the rail is small and has no CSS animations to disturb.
 */

import {
  formatPercentRemaining,
  formatWeeklyLine,
  quotaBarColor,
  type QuotaPanelModel,
  quotaStatusText,
  sparklinePoints,
} from "./quota";
import type { QuotaHistoryPoint } from "../../src/quota-snapshot";

export type RailModel = {
  degraded: boolean;
  /** Age of the snapshot file's mtime; null when no read has succeeded. */
  heartbeatAgeMs: number | null;
  unreadCount: number;
  quota: readonly QuotaPanelModel[];
  /** 1-based current page. */
  page: number;
  pageCount: number;
  now: Date;
};

export type RailActions = {
  /** Jump to a 0-based page; the layout reducer validates and clamps it. */
  onJumpToPage: (page: number) => void;
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

const PROVIDER_LABELS: Record<QuotaPanelModel["provider"], string> = { claude: "Claude", codex: "Codex" };
const PROVIDER_CHIP_LETTERS: Record<QuotaPanelModel["provider"], string> = { claude: "C", codex: "X" };

const healthSection = (model: RailModel): HTMLElement => {
  const section = document.createElement("section");
  section.className = "rail-health";
  const dot = document.createElement("span");
  dot.className = model.degraded ? "dot bad" : "dot ok";
  section.append(dot);
  const text = document.createElement("span");
  if (model.degraded) {
    text.className = "offline-text";
    text.textContent = "OFFLINE";
  } else {
    const ageSeconds = model.heartbeatAgeMs === null ? null : Math.max(0, Math.round(model.heartbeatAgeMs / 1000));
    text.textContent = ageSeconds === null ? "daemon ok" : `daemon ok · ${ageSeconds}s ago`;
  }
  section.append(text);
  return section;
};

const pagerSection = (model: RailModel, actions: RailActions): HTMLElement => {
  const section = document.createElement("section");
  section.className = "rail-pager";
  for (let page = 1; page <= model.pageCount; page += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = page === model.page ? "page-dot current" : "page-dot";
    button.textContent = "●";
    const target = page - 1;
    button.addEventListener("click", () => actions.onJumpToPage(target));
    section.append(button);
  }
  return section;
};

const quotaSection = (model: QuotaPanelModel, nowMs: number): HTMLElement => {
  const section = document.createElement("section");
  section.className = "rail-quota";
  section.dataset["provider"] = model.provider;
  section.dataset["state"] = model.state;

  const head = document.createElement("div");
  head.className = "quota-head";
  const chip = document.createElement("span");
  chip.className = "quota-chip";
  chip.dataset["provider"] = model.provider;
  chip.textContent = PROVIDER_CHIP_LETTERS[model.provider];
  const name = document.createElement("span");
  name.textContent = PROVIDER_LABELS[model.provider];
  const pct = document.createElement("span");
  pct.className = "quota-pct";
  pct.textContent = model.percentRemaining === null ? "—" : formatPercentRemaining(model.percentRemaining);
  head.append(chip, name, pct);

  const bar = document.createElement("div");
  bar.className = "quota-bar";
  const fill = document.createElement("div");
  fill.className = "quota-bar-fill";
  if (model.percentRemaining !== null) {
    fill.style.width = `${Math.max(0, Math.min(100, model.percentRemaining))}%`;
    fill.style.background = quotaBarColor(model.percentRemaining);
  }
  bar.append(fill);

  const meta = document.createElement("div");
  meta.className = "quota-meta";
  const status = document.createElement("span");
  status.textContent = quotaStatusText(model, nowMs);
  const spark = document.createElement("canvas");
  spark.className = "quota-spark";
  meta.append(status, spark);

  section.append(head, bar, meta);
  const weekly = formatWeeklyLine(model.weeklyPercentRemaining, model.weeklyResetAtMs, nowMs);
  if (weekly !== null) {
    const weekLine = document.createElement("div");
    weekLine.className = "quota-weekly";
    weekLine.textContent = weekly;
    section.append(weekLine);
  }
  return section;
};

const drawSparkline = (section: HTMLElement, history: readonly QuotaHistoryPoint[]): void => {
  const canvas = section.querySelector<HTMLCanvasElement>(".quota-spark");
  if (canvas === null) {
    return;
  }
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) {
    return;
  }
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext("2d");
  if (context === null) {
    return;
  }
  context.scale(ratio, ratio);
  const points = sparklinePoints(history, width, height);
  const first = points[0];
  if (first === undefined) {
    return;
  }
  context.strokeStyle = "#94a3b8";
  context.lineWidth = 1.5;
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of points.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.stroke();
};

export const renderRail = (root: HTMLElement, model: RailModel, actions: RailActions): void => {
  const clock = document.createElement("section");
  clock.className = "rail-clock";
  clock.textContent = `${pad2(model.now.getHours())}:${pad2(model.now.getMinutes())}`;

  const unread = document.createElement("section");
  unread.className = model.unreadCount > 0 ? "rail-unread active" : "rail-unread";
  unread.textContent = model.unreadCount === 1 ? "1 unread" : `${model.unreadCount} unread`;

  const nowMs = model.now.getTime();
  const quotaSections = model.quota.map((quota) => quotaSection(quota, nowMs));

  root.replaceChildren(healthSection(model), clock, unread, ...quotaSections, pagerSection(model, actions));
  // Canvases only have layout once attached; draw after replaceChildren.
  for (let index = 0; index < quotaSections.length; index += 1) {
    const section = quotaSections[index];
    const quota = model.quota[index];
    if (section !== undefined && quota !== undefined) {
      drawSparkline(section, quota.history);
    }
  }
};
```

(`healthSection` and `pagerSection` above are byte-identical to the current `app/src/rail.ts:25-56`; `renderRail` below keeps its existing clock/unread construction and gains the quota sections.)

3b. `app/src/main.ts`:
- Import line 11 becomes:

```ts
import { ackSession, focusGhostty, openUrl, readPaseoServerId, readQuotaSnapshot, readSnapshot } from "./bridge";
```

add a new import:

```ts
import { type QuotaPanelModel, reduceQuotaRead } from "./quota";
```

- After `let lastReadMtimeMs: number | null = null;` (line 24) add:

```ts
let currentQuota: QuotaPanelModel[] = [];
```

- In `renderRailNow` (lines 67-84), add to the model object after `unreadCount: unreadCount(currentView),`:

```ts
      quota: currentQuota,
```

- In `poll` (lines 114-121), after the `readSnapshot` line add the quota read (the file changes at most every 120s; riding the existing 2s poll keeps one code path and one failure path — a rejection is a missing file, i.e. "no data yet"):

```ts
  const quotaRead = await readQuotaSnapshot().catch(() => null);
  currentQuota = reduceQuotaRead(quotaRead, Date.now());
```

The countdowns tick on the existing 1s `renderRailNow` interval (line 141); no new timer.

3c. Append to `app/styles.css` (after the `.page-dot.current` block, line 262):

```css
/* Quota panels (strip-only; there is no keypad equivalent). */
.rail-quota {
  display: flex;
  flex-direction: column;
  gap: 0.6vh;
}
.rail-quota[data-state="stale"],
.rail-quota[data-state="unavailable"] {
  opacity: 0.45;
}
.quota-head {
  display: flex;
  align-items: center;
  gap: 0.6vw;
}
.quota-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6vw;
  height: 1.6vw;
  border-radius: 22%;
  color: #10151c;
  font-size: 1vw;
  font-weight: 700;
}
.quota-chip[data-provider="claude"] {
  background: #d97757;
}
.quota-chip[data-provider="codex"] {
  background: #d946ef;
}
.quota-pct {
  margin-left: auto;
  color: #e8eef7;
  font-variant-numeric: tabular-nums;
}
.quota-bar {
  height: 0.8vh;
  border-radius: 0.4vh;
  background: #232b38;
  overflow: hidden;
}
.quota-bar-fill {
  height: 100%;
  border-radius: inherit;
}
.quota-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6vw;
  font-size: 1.2vw;
}
.quota-spark {
  width: 6vw;
  height: 2.4vh;
}
.quota-weekly {
  font-size: 1.1vw;
}
```

- [ ] **Step 4: Run to verify it passes**
Run: `bun run typecheck && bun run build:app && bun test` — Expected: clean. (The `RailModel.quota` required-field change would fail typecheck if any caller were missed.)

- [ ] **Step 5: Commit**
`git add app/src/rail.ts app/src/main.ts app/styles.css` — message: `feat(app): quota panels in the rail`

---

### Task 8: Docs sync

**Files:**
- Modify: `docs/design.md:336-341` (Rail section)
- Modify: `AGENTS.md` (the "Quota panels are deliberately deferred" sentence — currently lines ~226-228, inside the Xeneon strip bullet)

**Interfaces:** none (documentation).

- [ ] **Step 1: Edit `docs/design.md`**

In the `### Rail` section (line 336), after the `- Page dots, one per page, tap to jump.` bullet, append:

```md
- Quota panels (strip-only; there is no keypad equivalent): one section per
  quota provider (claude, codex) with the provider chip, the session-window
  percent remaining, a bar filled on the status palette (green `#4ADE80`
  above 25% remaining, amber `#FFB020` from 10%, red `#FF4D67` below), a
  reset countdown ticking on the rail's 1s cadence, a sparkline of the
  daemon-recorded session-window history ring, and a weekly-window summary
  line. Data comes from `quota-snapshot.json` via the `read_quota_snapshot`
  Tauri command — a separate file with its own `schemaVersion`, never the
  session snapshot. A provider whose last fetch failed keeps its last-good
  numbers dimmed with a last-updated age; a provider with no credentials is
  omitted; a missing file renders no panels.
```

- [ ] **Step 2: Edit `AGENTS.md`**

In the Xeneon strip bullet, replace the wrapped sentence

```
  error session lingers as counted until its next lifecycle event. Quota
  panels are deliberately deferred; the rail is a plain section stack so
  they slot in later.
```

with

```
  error session lingers as counted until its next lifecycle event. Quota
  panels (claude + codex) ship in the rail: the daemon's quota collector
  (`src/core/quota.ts`, own 120s scheduler in `cli.ts`, 10-minute 429
  cooldown) reads the providers' local OAuth credential files and publishes
  `quota-snapshot.json` (own `schemaVersion`, bounded history ring; contract
  in `src/quota-snapshot.ts`) via the `writeFileAtomically` primitive; the
  strip reads it through the `read_quota_snapshot` Tauri command and renders
  from the pure view-model in `app/src/quota.ts`. `snapshot-v2.json` and
  `src/protocol.ts` stay untouched, and no token or response body is ever
  logged or persisted.
```

- [ ] **Step 3: Verify**
Run: `bun run lint` (Biome lints root `*.md`? — no, only json/mjs/ts; this step is a diff review: `git diff docs/design.md AGENTS.md` to confirm only the intended lines changed).

- [ ] **Step 4: Commit**
`git add docs/design.md AGENTS.md` — message: `docs: quota panels on the strip rail`

---

## Manual on-panel verification checklist

Core changes under `src/core/` require a full reinstall (`bun scripts/install-local.ts` — accept the Stream Deck plugin confirmation dialog if asked), and the app requires `bun run install:app`. Then, on the Xeneon strip:

- [ ] Within ~2 minutes of daemon start, `quota-snapshot.json` exists next to `snapshot-v2.json` in `~/Library/Application Support/com.drewritter.stream-deck-agents/` and contains both providers with plausible percentages.
- [ ] The rail shows a Claude and a Codex panel: chip + name + whole-percent remaining, a filled bar, a `resets in Xh Ym` line that visibly ticks down on the 1s cadence, and (after a few passes) a sparkline that extends with each new sample.
- [ ] `week N% left · Xd` appears under each panel.
- [ ] Failure isolation: temporarily rename `~/.claude/.credentials.json` → the Claude panel disappears and session tiles/health are completely unaffected. Restore it; within 2 minutes the panel returns.
- [ ] Unavailable state: with credentials present but the network offline, panels keep their last-good numbers, dim, and show `updated Xm ago`; the rail health section and session tiles stay live.
- [ ] Stale state: stop the launchd daemon; after ~6 minutes the quota panels dim (and the rail shows OFFLINE after 10s).
- [ ] Persistence: quit and relaunch the strip app — the sparkline history is intact (it lives in the file).
- [ ] Confirm no token material anywhere it shouldn't be: `grep -c "sk-ant" ~/Library/Application\ Support/com.drewritter.stream-deck-agents/quota-snapshot.json` prints `0`, and the daemon log (`logs/quota.log`) contains only fixed-code records.

## Final gate

- [ ] Run `bun run check` — biome ci + build + full test suite, all green.
