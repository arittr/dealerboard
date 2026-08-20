# CodexBar Quota Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Source all four strip-rail quota panels (claude, codex, kimi, GLM/zai) from the locally installed CodexBar CLI, replacing the two direct OAuth HTTP fetchers.

**Architecture:** The daemon's quota collector spawns `codexbar usage --provider <key> --format json --log-level critical` once per provider per 120s pass (serialized), classifies the returned windows by `windowMinutes` (labels are not positional across providers), and publishes the same `quota-snapshot.json` contract as before — the strip's view-model and sparkline machinery are untouched; only the rail's provider label maps and chip colors extend.

**Tech Stack:** Bun (daemon, `Bun.spawn`), TypeScript strict, bun:test, Biome, Tauri strip app (CSS/DOM only for this feature).

**Spec:** `docs/superpowers/specs/2026-08-20-codexbar-quota-panels-design.md` — read it before starting.

## Global Constraints

- `schemaVersion` stays `1`; `src/protocol.ts` and `snapshot-v2.json` are untouched; the Stream Deck plugin is untouched (no manifest version bump).
- No new npm dependencies. Bun builtins only (`Bun.spawn`, `Response`).
- No `process.env` reads (Biome `noProcessEnv`) — configuration enters via dependency injection only.
- Biome style: 2 spaces, double quotes, semicolons, 120 columns; `noExplicitAny`, `noEvolvingTypes`, `noNonNullAssertion` (relaxed in `test/**`), nursery `noFloatingPromises`; bracket access on index signatures (`noPropertyAccessFromIndexSignature`).
- Tests never spawn the real codexbar binary — the exec is always injected.
- Nothing CodexBar prints (stdout or stderr) is ever logged or persisted beyond the derived numbers in the published snapshot. Diagnostics stay transition-only and payload-free.
- `bun run typecheck` must be green at every commit (lefthook runs it pre-commit) — this is why Task 1 bundles the type-union-driven rail changes.
- Commit messages follow repo style: `feat(core): …`, `feat(app): …`, `docs: …`.

---

### Task 1: Extend quota provider keys + the type-union-driven rail changes

The `QuotaProviderKey` union widens to four keys; `rail.ts`'s exhaustive
`Record`s and `styles.css`'s chip colors must change in the same commit or
`bun run typecheck` breaks.

**Files:**
- Modify: `src/quota-snapshot.ts:16`
- Modify: `test/quota-snapshot.test.ts`
- Modify: `test/strip-quota.test.ts`
- Modify: `app/src/rail.ts:36-37`
- Modify: `app/styles.css` (after line 317)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `QUOTA_PROVIDER_KEYS = ["claude", "codex", "kimi", "zai"]` and the widened `QuotaProviderKey` union used by every later task; rail maps `PROVIDER_LABELS` / `PROVIDER_CHIP_LETTERS` covering all four keys.

- [ ] **Step 1: Update the snapshot parser tests (failing)**

In `test/quota-snapshot.test.ts`, replace the "ignores unknown provider keys" test body (`kimi` is about to become a known key, so the unknown-key probe moves to a genuinely unknown key) and add a new test for the two new keys:

```ts
  test("ignores unknown provider keys so a newer daemon never breaks an older app", () => {
    const parsed = parseQuotaSnapshot({
      schemaVersion: 1,
      providers: { futureprovider: claudeQuota(), claude: claudeQuota() },
    });
    expect(parsed.providers["claude"]).toEqual(claudeQuota());
    expect(Object.keys(parsed.providers)).toEqual(["claude"]);
  });

  test("parses the kimi and zai provider keys", () => {
    const parsed = parseQuotaSnapshot({
      schemaVersion: 1,
      providers: { kimi: claudeQuota(), zai: claudeQuota() },
    });
    expect(parsed.providers["kimi"]).toEqual(claudeQuota());
    expect(parsed.providers["zai"]).toEqual(claudeQuota());
  });
```

In `test/strip-quota.test.ts`, add to the `describe("reduceQuotaRead", ...)` block:

```ts
  test("panels follow the contract provider order across all four providers", () => {
    const panels = reduceQuotaRead(read({ zai: quota(), kimi: quota(), codex: quota(), claude: quota() }), NOW);
    expect(panels.map((panel) => panel.provider)).toEqual(["claude", "codex", "kimi", "zai"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/quota-snapshot.test.ts test/strip-quota.test.ts`
Expected: FAIL — "parses the kimi and zai provider keys" (both keys dropped as unknown) and "panels follow the contract provider order" (only claude, codex emitted).

- [ ] **Step 3: Widen the contract keys**

In `src/quota-snapshot.ts`, change line 16:

```ts
export const QUOTA_PROVIDER_KEYS = ["claude", "codex", "kimi", "zai"] as const;
```

- [ ] **Step 4: Extend the rail label maps (required for typecheck)**

In `app/src/rail.ts`, replace lines 36-37:

```ts
const PROVIDER_LABELS: Record<QuotaPanelModel["provider"], string> = {
  claude: "Claude",
  codex: "Codex",
  kimi: "Kimi",
  zai: "GLM",
};
const PROVIDER_CHIP_LETTERS: Record<QuotaPanelModel["provider"], string> = { claude: "C", codex: "X", kimi: "K", zai: "G" };
```

- [ ] **Step 5: Add the chip colors**

In `app/styles.css`, immediately after the `.quota-chip[data-provider="codex"]` rule (ends line 317):

```css
.quota-chip[data-provider="kimi"] {
  background: #3b82f6;
}
.quota-chip[data-provider="zai"] {
  background: #2dd4bf;
}
```

(Kimi reuses the tile palette's Kimi hue; teal is distinct within the rail's chip set. Rail chips are a separate namespace from tile corner chips.)

- [ ] **Step 6: Run tests and typecheck to verify they pass**

Run: `bun test test/quota-snapshot.test.ts test/strip-quota.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/quota-snapshot.ts test/quota-snapshot.test.ts test/strip-quota.test.ts app/src/rail.ts app/styles.css
git commit -m "feat(core): add kimi and zai keys to the quota contract and rail"
```

---

### Task 2: CodexBar usage parser + widened reading type

A pure parser for CodexBar's JSON, with fixtures captured from the real
2026-08-20 output (values trimmed to the fields the parser reads; codex
`usedPercent`s raised from 0 so assertions are meaningful). The
`ProviderQuotaReading.session` field widens to nullable (codex can report
weekly-only), which requires a null-safe patch to the old collector's success
branch in the same commit.

**Files:**
- Create: `test/fixtures/quota/codexbar-claude.json`
- Create: `test/fixtures/quota/codexbar-codex.json`
- Create: `test/fixtures/quota/codexbar-kimi.json`
- Create: `test/fixtures/quota/codexbar-zai.json`
- Create: `test/quota-codexbar.test.ts`
- Modify: `src/core/quota.ts`

**Interfaces:**
- Consumes: `QuotaProviderKey` (Task 1).
- Produces: `parseCodexbarUsage(body: string): CodexbarUsageParse` where `CodexbarUsageParse = { kind: "ok"; reading: ProviderQuotaReading } | { kind: "absent" } | { kind: "invalid" }`; `ProviderQuotaReading = { session: QuotaWindowReading | null; weekly: QuotaWindowReading | null }` (session newly nullable). Task 3's collector consumes both.

- [ ] **Step 1: Write the four fixtures**

`test/fixtures/quota/codexbar-claude.json`:

```json
[
  {
    "provider": "claude",
    "source": "claude",
    "usage": {
      "updatedAt": "2026-08-20T06:04:43Z",
      "identity": { "providerID": "claude" },
      "primary": {
        "windowMinutes": 300,
        "usedPercent": 2,
        "resetsAt": "2026-08-20T07:00:00Z",
        "resetDescription": "Resets 12am (America/Los_Angeles)"
      },
      "secondary": {
        "windowMinutes": 10080,
        "usedPercent": 63,
        "resetsAt": "2026-08-21T01:00:00Z",
        "resetDescription": "Resets Aug 20 at 6pm (America/Los_Angeles)"
      },
      "tertiary": null,
      "dataConfidence": "percentOnly"
    }
  }
]
```

`test/fixtures/quota/codexbar-codex.json`:

```json
[
  {
    "provider": "codex",
    "source": "oauth",
    "usage": {
      "updatedAt": "2026-08-20T06:04:44Z",
      "identity": { "providerID": "codex", "accountEmail": "drew@example.com", "loginMethod": "pro" },
      "primary": null,
      "secondary": {
        "windowMinutes": 10080,
        "usedPercent": 25,
        "resetsAt": "2026-08-27T06:03:05Z",
        "resetDescription": "Aug 26 at 11:03 PM"
      },
      "tertiary": null,
      "extraRateWindows": [
        {
          "title": "Codex Spark 5-hour",
          "id": "codex-spark",
          "window": {
            "windowMinutes": 300,
            "usedPercent": 40,
            "resetsAt": "2026-08-20T11:04:44Z",
            "resetDescription": "tomorrow, 4:04 AM"
          }
        },
        {
          "title": "Codex Spark Weekly",
          "id": "codex-spark-weekly",
          "window": {
            "windowMinutes": 10080,
            "usedPercent": 10,
            "resetsAt": "2026-08-27T06:04:44Z",
            "resetDescription": "Aug 26 at 11:04 PM"
          }
        }
      ]
    }
  }
]
```

`test/fixtures/quota/codexbar-kimi.json`:

```json
[
  {
    "provider": "kimi",
    "source": "Kimi Code CLI",
    "usage": {
      "updatedAt": "2026-08-20T06:03:52Z",
      "identity": { "providerID": "kimi" },
      "primary": {
        "windowMinutes": 10080,
        "usedPercent": 12,
        "resetsAt": "2026-08-26T20:27:06Z",
        "resetDescription": "12/100 requests"
      },
      "secondary": {
        "windowMinutes": 300,
        "usedPercent": 16,
        "resetsAt": "2026-08-20T07:27:06Z",
        "resetDescription": "Rate: 16/100 per 5 hours"
      },
      "tertiary": null
    }
  }
]
```

`test/fixtures/quota/codexbar-zai.json`:

```json
[
  {
    "provider": "zai",
    "source": "api",
    "usage": {
      "updatedAt": "2026-08-20T06:05:00Z",
      "identity": { "providerID": "zai", "loginMethod": "pro" },
      "primary": {
        "windowMinutes": 300,
        "usedPercent": 6.833333333333333,
        "resetsAt": "2026-08-20T08:20:38Z",
        "resetDescription": "5-hour"
      },
      "secondary": {
        "windowMinutes": 10080,
        "usedPercent": 56.364999999999995,
        "resetsAt": "2026-08-23T06:53:00Z",
        "resetDescription": "1 week window"
      },
      "tertiary": null
    }
  }
]
```

- [ ] **Step 2: Write the failing parser tests**

Create `test/quota-codexbar.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexbarUsage } from "../src/core/quota";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "quota", name), "utf8");

describe("parseCodexbarUsage", () => {
  test("claude: primary 5-hour and secondary weekly map to session and weekly", () => {
    expect(parseCodexbarUsage(fixture("codexbar-claude.json"))).toEqual({
      kind: "ok",
      reading: {
        session: { percentRemaining: 98, resetAt: "2026-08-20T07:00:00.000Z" },
        weekly: { percentRemaining: 37, resetAt: "2026-08-21T01:00:00.000Z" },
      },
    });
  });

  test("kimi: reversed labels — the weekly window arrives as primary, the 5-hour rate window as secondary", () => {
    expect(parseCodexbarUsage(fixture("codexbar-kimi.json"))).toEqual({
      kind: "ok",
      reading: {
        session: { percentRemaining: 84, resetAt: "2026-08-20T07:27:06.000Z" },
        weekly: { percentRemaining: 88, resetAt: "2026-08-26T20:27:06.000Z" },
      },
    });
  });

  test("zai: float percentages carry through the remaining-percent flip", () => {
    expect(parseCodexbarUsage(fixture("codexbar-zai.json"))).toEqual({
      kind: "ok",
      reading: {
        session: { percentRemaining: 100 - 6.833333333333333, resetAt: "2026-08-20T08:20:38.000Z" },
        weekly: { percentRemaining: 100 - 56.364999999999995, resetAt: "2026-08-23T06:53:00.000Z" },
      },
    });
  });

  test("codex: a null primary falls back to extraRateWindows for the session window", () => {
    expect(parseCodexbarUsage(fixture("codexbar-codex.json"))).toEqual({
      kind: "ok",
      reading: {
        session: { percentRemaining: 60, resetAt: "2026-08-20T11:04:44.000Z" },
        weekly: { percentRemaining: 75, resetAt: "2026-08-27T06:03:05.000Z" },
      },
    });
  });

  test("a weekly-only account yields a reading with a null session", () => {
    const body = JSON.stringify([
      {
        usage: {
          primary: null,
          secondary: { windowMinutes: 10080, usedPercent: 63, resetsAt: "2026-08-21T01:00:00Z" },
          tertiary: null,
        },
      },
    ]);
    expect(parseCodexbarUsage(body)).toEqual({
      kind: "ok",
      reading: {
        session: null,
        weekly: { percentRemaining: 37, resetAt: "2026-08-21T01:00:00.000Z" },
      },
    });
  });

  test("a lone sub-day window is the session window with no weekly", () => {
    const body = JSON.stringify([
      { usage: { primary: { windowMinutes: 300, usedPercent: 10, resetsAt: null }, secondary: null, tertiary: null } },
    ]);
    expect(parseCodexbarUsage(body)).toEqual({
      kind: "ok",
      reading: { session: { percentRemaining: 90, resetAt: null }, weekly: null },
    });
  });

  test("invalid windows are skipped before classification", () => {
    const body = JSON.stringify([
      {
        usage: {
          primary: { windowMinutes: 300, usedPercent: 250, resetsAt: "2026-08-20T07:00:00Z" },
          secondary: { windowMinutes: 10080, usedPercent: 63, resetsAt: "2026-08-21T01:00:00Z" },
          tertiary: null,
        },
      },
    ]);
    expect(parseCodexbarUsage(body)).toEqual({
      kind: "ok",
      reading: {
        session: null,
        weekly: { percentRemaining: 37, resetAt: "2026-08-21T01:00:00.000Z" },
      },
    });
  });

  test("an unparseable resetsAt degrades to null instead of failing the window", () => {
    const body = JSON.stringify([
      { usage: { primary: { windowMinutes: 300, usedPercent: 10, resetsAt: "junk" }, secondary: null, tertiary: null } },
    ]);
    expect(parseCodexbarUsage(body)).toEqual({
      kind: "ok",
      reading: { session: { percentRemaining: 90, resetAt: null }, weekly: null },
    });
  });

  test("an empty account array means the provider is disabled in CodexBar", () => {
    expect(parseCodexbarUsage("[]")).toEqual({ kind: "absent" });
  });

  test("garbage, non-arrays, entries without usage, and windowless entries are invalid", () => {
    expect(parseCodexbarUsage("not json")).toEqual({ kind: "invalid" });
    expect(parseCodexbarUsage("{}")).toEqual({ kind: "invalid" });
    expect(parseCodexbarUsage(JSON.stringify([{ provider: "kimi" }]))).toEqual({ kind: "invalid" });
    expect(parseCodexbarUsage(JSON.stringify([{ usage: { primary: null, secondary: null, tertiary: null } }]))).toEqual(
      { kind: "invalid" },
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/quota-codexbar.test.ts`
Expected: FAIL — `parseCodexbarUsage` is not exported from `../src/core/quota`.

- [ ] **Step 4: Widen `ProviderQuotaReading` and add the parser to `src/core/quota.ts`**

Replace the `ProviderQuotaReading` declaration:

```ts
export type ProviderQuotaReading = {
  /** Null when the provider reports no session-class window (e.g. codex weekly-only). */
  session: QuotaWindowReading | null;
  weekly: QuotaWindowReading | null;
};

export type CodexbarUsageParse =
  | { kind: "ok"; reading: ProviderQuotaReading }
  /** Valid JSON with no accounts — the provider is disabled in CodexBar. */
  | { kind: "absent" }
  | { kind: "invalid" };
```

Add after `normalizeCodexUsage` (before the `QUOTA_POLL_INTERVAL_MS` block):

```ts
/** CodexBar window lengths at or above this classify as the weekly window. */
const DAY_WINDOW_MINUTES = 1440;

type RawCodexbarWindow = { windowMinutes: number; usedPercent: number; resetsAt: string | null };

const parseCodexbarWindow = (value: unknown): RawCodexbarWindow | null => {
  if (!isRecord(value)) {
    return null;
  }
  const minutes = value["windowMinutes"];
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  if (!isPercentUsed(value["usedPercent"])) {
    return null;
  }
  return { windowMinutes: minutes, usedPercent: value["usedPercent"], resetsAt: isoOrNull(value["resetsAt"]) };
};

const toWindowReading = (window: RawCodexbarWindow): QuotaWindowReading => ({
  percentRemaining: 100 - window.usedPercent,
  resetAt: window.resetsAt,
});

const classifyCodexbarWindows = (windows: readonly RawCodexbarWindow[]): ProviderQuotaReading | null => {
  let weekly: RawCodexbarWindow | null = null;
  let session: RawCodexbarWindow | null = null;
  for (const window of windows) {
    if (window.windowMinutes >= DAY_WINDOW_MINUTES) {
      if (weekly === null || window.windowMinutes > weekly.windowMinutes) {
        weekly = window;
      }
    } else if (session === null || window.windowMinutes < session.windowMinutes) {
      session = window;
    }
  }
  if (session === null && weekly === null) {
    return null;
  }
  return {
    session: session === null ? null : toWindowReading(session),
    weekly: weekly === null ? null : toWindowReading(weekly),
  };
};

export const parseCodexbarUsage = (body: string): CodexbarUsageParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "invalid" };
  }
  if (!Array.isArray(parsed)) {
    return { kind: "invalid" };
  }
  if (parsed.length === 0) {
    return { kind: "absent" };
  }
  const entry: unknown = parsed[0];
  if (!isRecord(entry) || !isRecord(entry["usage"])) {
    return { kind: "invalid" };
  }
  const usage = entry["usage"];
  const windows: RawCodexbarWindow[] = [];
  for (const key of ["primary", "secondary", "tertiary"] as const) {
    const window = parseCodexbarWindow(usage[key]);
    if (window !== null) {
      windows.push(window);
    }
  }
  let reading = classifyCodexbarWindows(windows);
  // Codex can report primary: null with the 5-hour data under extraRateWindows.
  if (reading !== null && reading.session === null && Array.isArray(usage["extraRateWindows"])) {
    const extras: RawCodexbarWindow[] = [];
    for (const extra of usage["extraRateWindows"]) {
      const window = parseCodexbarWindow(isRecord(extra) ? extra["window"] : null);
      if (window !== null) {
        extras.push(window);
      }
    }
    reading = classifyCodexbarWindows([...windows, ...extras]);
  }
  return reading === null ? { kind: "invalid" } : { kind: "ok", reading };
};
```

Then make the old collector's success branch null-safe (required by the widened
type — the old code dereferences `reading.session` unconditionally). In
`pollProvider`, replace the `outcome.kind === "ok"` block's `history` and
`quota` constructions:

```ts
    if (outcome.kind === "ok") {
      const fetchedAt = now();
      // The history ring records the session window only — a weekly-only
      // reading leaves the ring untouched.
      const history =
        outcome.reading.session === null
          ? state.quota.history
          : [
              ...state.quota.history,
              { fetchedAt, fractionRemaining: outcome.reading.session.percentRemaining / 100 },
            ].slice(-QUOTA_HISTORY_LIMIT);
      const quota: ProviderQuota = {
        percentRemaining: outcome.reading.session?.percentRemaining ?? null,
        resetAt: outcome.reading.session?.resetAt ?? null,
        weeklyPercentRemaining: outcome.reading.weekly?.percentRemaining ?? null,
        weeklyResetAt: outcome.reading.weekly?.resetAt ?? null,
        unavailable: false,
        fetchedAt,
        history,
      };
```

(The trailing `states.set(provider, { quota, cooldownUntilMs: null, failed: false }); return quota;` stays as-is in this task.)

- [ ] **Step 5: Run tests and typecheck to verify they pass**

Run: `bun test test/quota-codexbar.test.ts test/quota.test.ts && bun run typecheck`
Expected: PASS — new parser tests green; the old collector tests stay green (their readings always carry a session window).

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/quota/codexbar-*.json test/quota-codexbar.test.ts src/core/quota.ts
git commit -m "feat(core): parse CodexBar usage payloads"
```

---

### Task 3: Collector rewrite — exec probes replace the HTTP fetchers

The fetch machinery (`QuotaFetch`, credential parsers, both old normalizers,
the 429 cooldown) is deleted; one exec probe per provider behind an injected
`QuotaExec` replaces it. `cli.ts` drops the credential-path dependencies (and
the then-unused `codexRoot` local). The old fixture files die with the old
code.

**Files:**
- Modify: `src/core/quota.ts` (wholesale rewrite; final content below)
- Modify: `src/core/cli.ts:415` and `src/core/cli.ts:435-440`
- Modify: `test/quota.test.ts` (wholesale rewrite; final content below)
- Delete: `test/fixtures/quota/claude-credentials.json`, `test/fixtures/quota/codex-auth.json`, `test/fixtures/quota/claude-usage.json`, `test/fixtures/quota/codex-usage.json` (keep `quota-snapshot.json` — `test/quota-snapshot.test.ts` still round-trips it)

**Interfaces:**
- Consumes: `parseCodexbarUsage`, `CodexbarUsageParse`, widened `ProviderQuotaReading` (Task 2); `QUOTA_PROVIDER_KEYS` (Task 1).
- Produces: `CODEXBAR_BINARY_CANDIDATES: readonly string[]`; `QuotaExecResult = { exitCode: number; stdout: string }`; `QuotaExec = (args: string[], timeoutMs: number) => Promise<QuotaExecResult>`; `QUOTA_EXEC_TIMEOUT_MS = 15_000` (renamed from `QUOTA_FETCH_TIMEOUT_MS`, no other consumers); `QuotaCollectorDependencies` without `claudeCredentialsPath`/`codexAuthPath`/`fetch`/`nowMs`, with `exec?`/`fileExists?` added. `createQuotaCollector`'s signature and `QuotaCollector` shape are unchanged — `cli.ts` keeps injecting the factory and `test/cli.test.ts`'s `collectorStub` keeps working untouched.

- [ ] **Step 1: Rewrite the collector tests (failing)**

Replace `test/quota.test.ts` wholesale:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagnosticRecord } from "../src/core/diagnostics";
import {
  CODEXBAR_BINARY_CANDIDATES,
  createQuotaCollector,
  QUOTA_POLL_INTERVAL_MS,
  type QuotaCollectorDependencies,
  type QuotaExec,
} from "../src/core/quota";
import { parseQuotaSnapshot } from "../src/quota-snapshot";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "quota", name), "utf8");

const NOW = "2026-08-19T18:00:00.000Z";

const FIXTURE_BY_PROVIDER: Record<string, string> = {
  claude: "codexbar-claude.json",
  codex: "codexbar-codex.json",
  kimi: "codexbar-kimi.json",
  zai: "codexbar-zai.json",
};
const ALL_PROVIDERS = ["claude", "codex", "kimi", "zai"] as const;

describe("createQuotaCollector", () => {
  let tempDir: string;
  let quotaPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "stream-deck-agents-quota-"));
    quotaPath = join(tempDir, "quota-snapshot.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  type RawResponse = { exitCode: number; stdout: string };

  type Harness = {
    deps: QuotaCollectorDependencies;
    calls: string[][];
    diagnostics: DiagnosticRecord[];
    fail: (...providers: string[]) => void;
    heal: (...providers: string[]) => void;
    omit: (...providers: string[]) => void;
    respondRaw: (provider: string, response: RawResponse) => void;
    writes: () => string[];
  };

  const makeHarness = (
    options: { binaryPresent?: boolean; files?: Record<string, string> } = {},
    overrides: Partial<QuotaCollectorDependencies> = {},
  ): Harness => {
    const calls: string[][] = [];
    const diagnostics: DiagnosticRecord[] = [];
    const writes: string[] = [];
    const failures = new Set<string>();
    const omissions = new Set<string>();
    const raw = new Map<string, RawResponse>();
    const execSpy: QuotaExec = (args) => {
      calls.push(args);
      const provider = args[2] ?? "";
      const override = raw.get(provider);
      if (override !== undefined) {
        return Promise.resolve(override);
      }
      if (failures.has(provider)) {
        return Promise.resolve({ exitCode: 1, stdout: "" });
      }
      if (omissions.has(provider)) {
        return Promise.resolve({ exitCode: 0, stdout: "[]" });
      }
      const name = FIXTURE_BY_PROVIDER[provider];
      return Promise.resolve({ exitCode: 0, stdout: name === undefined ? "[]" : fixture(name) });
    };
    const binaryPresent = options.binaryPresent ?? true;
    const deps: QuotaCollectorDependencies = {
      quotaSnapshotPath: quotaPath,
      fileExists: () => binaryPresent,
      // No binary → no injected exec either: resolution must report "absent"
      // without ever spawning.
      ...(binaryPresent ? { exec: execSpy } : {}),
      readFile: (path) => options.files?.[path] ?? null,
      now: () => NOW,
      writeFile: (_path, payload) => {
        writes.push(payload);
      },
      diagnostics: (record) => {
        diagnostics.push(record);
      },
      ...overrides,
    };
    return {
      deps,
      calls,
      diagnostics,
      fail: (...providers) => {
        for (const provider of providers) {
          failures.add(provider);
        }
      },
      heal: (...providers) => {
        for (const provider of providers) {
          failures.delete(provider);
        }
      },
      omit: (...providers) => {
        for (const provider of providers) {
          omissions.add(provider);
        }
      },
      respondRaw: (provider, response) => {
        raw.set(provider, response);
      },
      writes: () => writes,
    };
  };

  test("publishes all four providers in contract order after successful runs", async () => {
    const harness = makeHarness();
    await createQuotaCollector(harness.deps).pollNow();
    const writes = harness.writes();
    expect(writes.length).toBe(1);
    const snapshot = parseQuotaSnapshot(JSON.parse(writes[0] ?? ""));
    expect(Object.keys(snapshot.providers)).toEqual([...ALL_PROVIDERS]);
    expect(snapshot.providers["claude"]).toMatchObject({
      percentRemaining: 98,
      weeklyPercentRemaining: 63,
      unavailable: false,
      fetchedAt: NOW,
    });
    expect(snapshot.providers["claude"]?.history).toEqual([{ fetchedAt: NOW, fractionRemaining: 0.98 }]);
    expect(snapshot.providers["codex"]).toMatchObject({ percentRemaining: 60, weeklyPercentRemaining: 75 });
    expect(snapshot.providers["kimi"]).toMatchObject({ percentRemaining: 84, weeklyPercentRemaining: 88 });
    expect(snapshot.providers["zai"]?.percentRemaining).toBe(100 - 6.833333333333333);
    expect(snapshot.providers["zai"]?.weeklyPercentRemaining).toBe(100 - 56.364999999999995);
    expect(harness.calls).toEqual(
      [...ALL_PROVIDERS].map((provider) => [
        "usage",
        "--provider",
        provider,
        "--format",
        "json",
        "--log-level",
        "critical",
      ]),
    );
  });

  test("a failed run keeps last-good data, marks unavailable, and logs only the transition", async () => {
    const harness = makeHarness();
    const collector = createQuotaCollector(harness.deps);
    await collector.pollNow();
    harness.fail("claude", "zai");
    await collector.pollNow();
    await collector.pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? ""));
    expect(snapshot.providers["claude"]).toMatchObject({ percentRemaining: 98, unavailable: true, fetchedAt: NOW });
    expect(snapshot.providers["claude"]?.history.length).toBe(1);
    expect(snapshot.providers["kimi"]?.unavailable).toBe(false);
    const failures = harness.diagnostics.filter((record) => record.code === "quota_failed");
    expect(failures.map((record) => record.provider).sort()).toEqual(["claude", "zai"]);
    expect(failures.every((record) => record.component === "quota")).toBe(true);
  });

  test("a cold-start failure emits quota_failed once per provider, not per pass, and again after recovery", async () => {
    const harness = makeHarness();
    const collector = createQuotaCollector(harness.deps);
    const failures = () => harness.diagnostics.filter((record) => record.code === "quota_failed");
    harness.fail(...ALL_PROVIDERS);
    await collector.pollNow(); // first pass from cold start
    await collector.pollNow(); // repeated failure — no new records
    expect(failures().length).toBe(4);
    expect(new Set(failures().map((record) => record.provider))).toEqual(new Set(ALL_PROVIDERS));
    harness.heal(...ALL_PROVIDERS);
    await collector.pollNow(); // recovery emits nothing
    expect(failures().length).toBe(4);
    harness.fail(...ALL_PROVIDERS);
    await collector.pollNow(); // recovery → failure is a new transition
    expect(failures().length).toBe(8);
  });

  test("a nonzero exit and unparseable stdout degrade to unavailable without escaping pollNow", async () => {
    const harness = makeHarness();
    const collector = createQuotaCollector(harness.deps);
    harness.fail(...ALL_PROVIDERS);
    await collector.pollNow();
    const first = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(first.providers["kimi"]?.unavailable).toBe(true);
    expect(first.providers["kimi"]?.percentRemaining).toBeNull();
    harness.heal(...ALL_PROVIDERS);
    harness.respondRaw("claude", { exitCode: 0, stdout: "garbage" });
    await collector.pollNow();
    const second = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? ""));
    expect(second.providers["claude"]?.unavailable).toBe(true);
    expect(second.providers["codex"]?.unavailable).toBe(false);
  });

  test("a missing binary omits every provider without spawning", async () => {
    const harness = makeHarness({ binaryPresent: false });
    await createQuotaCollector(harness.deps).pollNow();
    expect(harness.calls.length).toBe(0);
    expect(parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? "")).providers).toEqual({});
  });

  test("a provider disabled in CodexBar (empty array) is omitted while the rest publish", async () => {
    const harness = makeHarness();
    harness.omit("kimi");
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(Object.keys(snapshot.providers)).toEqual(["claude", "codex", "zai"]);
  });

  test("a weekly-only reading publishes null session fields and appends no history", async () => {
    const harness = makeHarness();
    harness.respondRaw("codex", {
      exitCode: 0,
      stdout: JSON.stringify([
        {
          usage: {
            primary: null,
            secondary: { windowMinutes: 10080, usedPercent: 25, resetsAt: "2026-08-27T06:03:05Z" },
            tertiary: null,
          },
        },
      ]),
    });
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["codex"]).toMatchObject({
      percentRemaining: null,
      resetAt: null,
      weeklyPercentRemaining: 75,
      weeklyResetAt: "2026-08-27T06:03:05.000Z",
      unavailable: false,
      fetchedAt: NOW,
    });
    expect(snapshot.providers["codex"]?.history).toEqual([]);
  });

  test("concurrent pollNow calls collapse into one pass", async () => {
    const harness = makeHarness();
    const collector = createQuotaCollector(harness.deps);
    await Promise.all([collector.pollNow(), collector.pollNow()]);
    expect(harness.calls.length).toBe(4);
  });

  test("start is idempotent, stop disarms the one interval, and start-after-stop works", () => {
    const armed: number[] = [];
    const disarmed: number[] = [];
    let nextHandle = 0;
    const harness = makeHarness(
      {},
      {
        schedule: (_tick, intervalMs) => {
          const handle = ++nextHandle;
          armed.push(handle);
          expect(intervalMs).toBe(QUOTA_POLL_INTERVAL_MS);
          return () => {
            disarmed.push(handle);
          };
        },
      },
    );
    const collector = createQuotaCollector(harness.deps);
    collector.start();
    collector.start(); // idempotent — no second interval
    expect(armed.length).toBe(1);
    expect(disarmed.length).toBe(0);
    collector.stop();
    expect(disarmed).toEqual([1]);
    collector.start(); // re-arms after stop
    expect(armed.length).toBe(2);
    collector.stop();
    expect(disarmed).toEqual([1, 2]);
  });

  test("a throwing dependency mid-pass is contained: pollNow resolves, nothing publishes, the next pass recovers", async () => {
    let clockBroken = false;
    const harness = makeHarness(
      {},
      {
        now: () => {
          if (clockBroken) {
            throw new Error("clock exploded");
          }
          return NOW;
        },
      },
    );
    const collector = createQuotaCollector(harness.deps);
    await collector.pollNow();
    expect(harness.writes().length).toBe(1);
    clockBroken = true;
    await collector.pollNow(); // resolves instead of rejecting
    expect(harness.writes().length).toBe(1); // the aborted pass publishes nothing
    clockBroken = false;
    await collector.pollNow();
    expect(harness.writes().length).toBe(2);
  });

  test("writes happen only when the snapshot changes", async () => {
    const harness = makeHarness();
    const collector = createQuotaCollector(harness.deps);
    await collector.pollNow();
    await collector.pollNow(); // history appends each success, so this differs
    expect(harness.writes().length).toBe(2);
    harness.fail(...ALL_PROVIDERS);
    await collector.pollNow(); // unavailable flips — a real change
    const afterFailure = harness.writes().length;
    await collector.pollNow(); // converged failure state — nothing new to write
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
    const harness = makeHarness({ files: { [quotaPath]: seeded } });
    harness.fail(...ALL_PROVIDERS);
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["claude"]).toMatchObject({ percentRemaining: 62.5, unavailable: true });
  });

  test("the binary candidates prefer the homebrew symlink, then fall back", () => {
    expect(CODEXBAR_BINARY_CANDIDATES).toEqual([
      "/opt/homebrew/bin/codexbar",
      "/usr/local/bin/codexbar",
      "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI",
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/quota.test.ts`
Expected: FAIL — `CODEXBAR_BINARY_CANDIDATES` is not exported (and the new harness does not match the old fetch-based dependencies).

- [ ] **Step 3: Rewrite `src/core/quota.ts` wholesale**

Replace the entire file:

```ts
/**
 * Quota collection for the strip's rail panels (claude, codex, kimi, GLM/zai).
 *
 * All four providers are read through the locally installed CodexBar CLI:
 * `codexbar usage --provider <key> --format json --log-level critical`, spawned
 * once per provider per pass (serialized — CodexBar's app-support directory
 * carries lock files). The binary resolves per pass from
 * CODEXBAR_BINARY_CANDIDATES; a missing binary omits every provider. CodexBar's
 * primary/secondary labels are not positional (kimi reports the weekly window
 * as primary), so windows are classified by windowMinutes: weekly = the longest
 * window of at least a day, session = the shortest window under a day, and
 * usage.extraRateWindows is scanned when the main trio yields no session window
 * (codex reports primary: null with the Spark windows there). A provider
 * disabled in the CodexBar app prints an empty array and is omitted.
 *
 * Nothing the process prints is ever logged or persisted beyond the derived
 * numbers in the published snapshot.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  type ProviderQuota,
  parseQuotaSnapshot,
  QUOTA_HISTORY_LIMIT,
  QUOTA_PROVIDER_KEYS,
  type QuotaProviderKey,
  type QuotaSnapshot,
} from "../quota-snapshot";
import type { DiagnosticRecord } from "./diagnostics";
import { writeFileAtomically } from "./snapshot";

export type QuotaWindowReading = { percentRemaining: number; resetAt: string | null };

export type ProviderQuotaReading = {
  /** Null when the provider reports no session-class window (e.g. codex weekly-only). */
  session: QuotaWindowReading | null;
  weekly: QuotaWindowReading | null;
};

export type CodexbarUsageParse =
  | { kind: "ok"; reading: ProviderQuotaReading }
  /** Valid JSON with no accounts — the provider is disabled in CodexBar. */
  | { kind: "absent" }
  | { kind: "invalid" };

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

/** CodexBar window lengths at or above this classify as the weekly window. */
const DAY_WINDOW_MINUTES = 1440;

type RawCodexbarWindow = { windowMinutes: number; usedPercent: number; resetsAt: string | null };

const parseCodexbarWindow = (value: unknown): RawCodexbarWindow | null => {
  if (!isRecord(value)) {
    return null;
  }
  const minutes = value["windowMinutes"];
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  if (!isPercentUsed(value["usedPercent"])) {
    return null;
  }
  return { windowMinutes: minutes, usedPercent: value["usedPercent"], resetsAt: isoOrNull(value["resetsAt"]) };
};

const toWindowReading = (window: RawCodexbarWindow): QuotaWindowReading => ({
  percentRemaining: 100 - window.usedPercent,
  resetAt: window.resetsAt,
});

const classifyCodexbarWindows = (windows: readonly RawCodexbarWindow[]): ProviderQuotaReading | null => {
  let weekly: RawCodexbarWindow | null = null;
  let session: RawCodexbarWindow | null = null;
  for (const window of windows) {
    if (window.windowMinutes >= DAY_WINDOW_MINUTES) {
      if (weekly === null || window.windowMinutes > weekly.windowMinutes) {
        weekly = window;
      }
    } else if (session === null || window.windowMinutes < session.windowMinutes) {
      session = window;
    }
  }
  if (session === null && weekly === null) {
    return null;
  }
  return {
    session: session === null ? null : toWindowReading(session),
    weekly: weekly === null ? null : toWindowReading(weekly),
  };
};

export const parseCodexbarUsage = (body: string): CodexbarUsageParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "invalid" };
  }
  if (!Array.isArray(parsed)) {
    return { kind: "invalid" };
  }
  if (parsed.length === 0) {
    return { kind: "absent" };
  }
  const entry: unknown = parsed[0];
  if (!isRecord(entry) || !isRecord(entry["usage"])) {
    return { kind: "invalid" };
  }
  const usage = entry["usage"];
  const windows: RawCodexbarWindow[] = [];
  for (const key of ["primary", "secondary", "tertiary"] as const) {
    const window = parseCodexbarWindow(usage[key]);
    if (window !== null) {
      windows.push(window);
    }
  }
  let reading = classifyCodexbarWindows(windows);
  // Codex can report primary: null with the 5-hour data under extraRateWindows.
  if (reading !== null && reading.session === null && Array.isArray(usage["extraRateWindows"])) {
    const extras: RawCodexbarWindow[] = [];
    for (const extra of usage["extraRateWindows"]) {
      const window = parseCodexbarWindow(isRecord(extra) ? extra["window"] : null);
      if (window !== null) {
        extras.push(window);
      }
    }
    reading = classifyCodexbarWindows([...windows, ...extras]);
  }
  return reading === null ? { kind: "invalid" } : { kind: "ok", reading };
};

/** Quota windows move slowly; CodexBar itself polls providers on a similar cadence. */
export const QUOTA_POLL_INTERVAL_MS = 120_000;
export const QUOTA_EXEC_TIMEOUT_MS = 15_000;

export const CODEXBAR_BINARY_CANDIDATES = [
  "/opt/homebrew/bin/codexbar",
  "/usr/local/bin/codexbar",
  "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI",
] as const;

const DIAGNOSTIC_COMPONENT = "quota";

export type QuotaExecResult = { exitCode: number; stdout: string };

/** Resolves instead of rejecting: spawn failure and timeout surface as a nonzero exit code. */
export type QuotaExec = (args: string[], timeoutMs: number) => Promise<QuotaExecResult>;

/** Same shape as the daemon's DaemonScheduler: arms a recurring tick, returns a disarm callback. */
export type QuotaScheduler = (tick: () => void, intervalMs: number) => () => void;

export type QuotaCollectorDependencies = {
  quotaSnapshotPath: string;
  exec?: QuotaExec;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string | null;
  now?: () => string;
  writeFile?: (path: string, payload: string) => void;
  schedule?: QuotaScheduler;
  diagnostics?: (record: DiagnosticRecord) => void;
};

export type QuotaCollector = {
  /** Poll immediately, then arm the interval. Idempotent while started. */
  start: () => void;
  /** Disarm the interval; an in-flight exec settles on its own. */
  stop: () => void;
  /** One collection pass; reentrancy-guarded, never throws. */
  pollNow: () => Promise<void>;
};

type FetchOutcome =
  | { kind: "ok"; reading: ProviderQuotaReading }
  /** Binary missing or provider disabled in CodexBar — the panel disappears. */
  | { kind: "absent" }
  | { kind: "failed" };

type ProviderState = { quota: ProviderQuota; failed: boolean };

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

const codexbarArgs = (provider: QuotaProviderKey): string[] => [
  "usage",
  "--provider",
  provider,
  "--format",
  "json",
  "--log-level",
  "critical",
];

const spawnExec =
  (binaryPath: string): QuotaExec =>
  async (args, timeoutMs) => {
    try {
      const process = Bun.spawn([binaryPath, ...args], { stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => {
        process.kill();
      }, timeoutMs);
      try {
        const stream = process.stdout;
        const stdout = stream === null ? "" : await new Response(stream).text();
        const exitCode = await process.exited;
        return { exitCode, stdout };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { exitCode: -1, stdout: "" };
    }
  };

const defaultSchedule: QuotaScheduler = (tick, intervalMs) => {
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
};

export const createQuotaCollector = (dependencies: QuotaCollectorDependencies): QuotaCollector => {
  const fileExists = dependencies.fileExists ?? ((path: string): boolean => existsSync(path));
  const readFile = dependencies.readFile ?? defaultReadFile;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const writeFile = dependencies.writeFile ?? writeFileAtomically;
  const schedule = dependencies.schedule ?? defaultSchedule;
  const diagnostics = dependencies.diagnostics ?? (() => {});

  const states = new Map<QuotaProviderKey, ProviderState>();
  let lastWrittenJson: string | null = null;
  let polling = false;
  let started = false;
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
          // A seeded unavailable row is already in the failed state — its
          // continuation must not re-log, only a good→failed transition may.
          states.set(key, { quota, failed: quota.unavailable });
        }
      }
      lastWrittenJson = `${JSON.stringify(seeded)}\n`;
    }
  } catch {
    // An unreadable or unparseable file is simply rewritten on the first pass.
  }

  // Resolved per pass so installing or removing CodexBar never needs a daemon
  // restart. An injected exec skips resolution entirely (tests never spawn).
  const resolveExec = (): QuotaExec | null => {
    if (dependencies.exec !== undefined) {
      return dependencies.exec;
    }
    const binaryPath = CODEXBAR_BINARY_CANDIDATES.find((path) => fileExists(path));
    return binaryPath === undefined ? null : spawnExec(binaryPath);
  };

  const probe = async (exec: QuotaExec, provider: QuotaProviderKey): Promise<FetchOutcome> => {
    let result: QuotaExecResult;
    try {
      result = await exec(codexbarArgs(provider), QUOTA_EXEC_TIMEOUT_MS);
    } catch {
      return { kind: "failed" };
    }
    if (result.exitCode !== 0) {
      return { kind: "failed" };
    }
    const parsed = parseCodexbarUsage(result.stdout);
    if (parsed.kind === "absent") {
      return { kind: "absent" };
    }
    return parsed.kind === "ok" ? { kind: "ok", reading: parsed.reading } : { kind: "failed" };
  };

  const pollProvider = async (exec: QuotaExec | null, provider: QuotaProviderKey): Promise<ProviderQuota | null> => {
    // A fresh row displays unavailable (never fetched) but has not yet failed —
    // `failed` tracks the diagnostic transition, separately from that display.
    const state = states.get(provider) ?? { quota: emptyQuota(), failed: false };
    const outcome = exec === null ? ({ kind: "absent" } as const) : await probe(exec, provider);
    if (outcome.kind === "absent") {
      states.delete(provider);
      return null;
    }
    if (outcome.kind === "ok") {
      const fetchedAt = now();
      // The history ring records the session window only — a weekly-only
      // reading leaves the ring untouched.
      const history =
        outcome.reading.session === null
          ? state.quota.history
          : [
              ...state.quota.history,
              { fetchedAt, fractionRemaining: outcome.reading.session.percentRemaining / 100 },
            ].slice(-QUOTA_HISTORY_LIMIT);
      const quota: ProviderQuota = {
        percentRemaining: outcome.reading.session?.percentRemaining ?? null,
        resetAt: outcome.reading.session?.resetAt ?? null,
        weeklyPercentRemaining: outcome.reading.weekly?.percentRemaining ?? null,
        weeklyResetAt: outcome.reading.weekly?.resetAt ?? null,
        unavailable: false,
        fetchedAt,
        history,
      };
      states.set(provider, { quota, failed: false });
      return quota;
    }
    if (!state.failed) {
      // Log the transition into failure only — never per pass, never output text.
      reportFailure(provider);
    }
    state.failed = true;
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
      const exec = resolveExec();
      const providers: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
      for (const provider of QUOTA_PROVIDER_KEYS) {
        const quota = await pollProvider(exec, provider);
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
    } catch {
      // The exported contract promises pollNow never throws. An unexpected
      // dependency/runtime exception is contained here — one provider-less
      // fixed diagnostic, never output text — and the next pass retries.
      try {
        diagnostics({ timestamp: now(), component: DIAGNOSTIC_COMPONENT, code: "quota_failed" });
      } catch {
        // Diagnostics must never break the collector.
      }
    } finally {
      polling = false;
    }
  };

  // Detached polls rely on pollNow's containment: it never rejects, so a
  // fire-and-forget call can never become an unhandled rejection.
  const pollQuietly = (): void => {
    void pollNow();
  };

  return {
    start: () => {
      if (started) {
        return;
      }
      started = true;
      pollQuietly();
      cancelSchedule = schedule(() => {
        pollQuietly();
      }, QUOTA_POLL_INTERVAL_MS);
    },
    stop: () => {
      started = false;
      cancelSchedule?.();
      cancelSchedule = null;
    },
    pollNow,
  };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/quota.test.ts test/quota-codexbar.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `cli.ts`**

In `src/core/cli.ts`, delete line 415 (the `codexRoot` local becomes unused
once the quota dependency drops — it has no other references):

```ts
    const codexRoot = environment["CODEX_HOME"] ?? join(daemonPaths.home, ".codex");
```

and replace the collector construction (lines 435-440):

```ts
      const quotaCollector = createCollector({
        quotaSnapshotPath: daemonPaths.quotaSnapshot,
        diagnostics,
      });
```

- [ ] **Step 6: Delete the obsolete fixtures and sweep for stale references**

```bash
rm test/fixtures/quota/claude-credentials.json test/fixtures/quota/codex-auth.json \
   test/fixtures/quota/claude-usage.json test/fixtures/quota/codex-usage.json
```

Run: `grep -rn "normalizeClaudeUsage\|normalizeCodexUsage\|parseClaudeCredentials\|parseCodexAuth\|QuotaFetch\|QUOTA_RATE_LIMIT_COOLDOWN_MS\|QUOTA_FETCH_TIMEOUT_MS\|claudeCredentialsPath\|codexAuthPath" src/ test/ app/src/`
Expected: no matches.

- [ ] **Step 7: Run the full gate**

Run: `bun run typecheck && bun test`
Expected: PASS (all suites, including `test/cli.test.ts`'s untouched collector boundary tests).

- [ ] **Step 8: Commit**

```bash
git add src/core/quota.ts src/core/cli.ts test/quota.test.ts test/fixtures/quota
git commit -m "feat(core): source all quota providers from the CodexBar CLI"
```

---

### Task 4: Documentation updates

**Files:**
- Modify: `AGENTS.md` (the "Quota panels (claude + codex) ship in the rail" bullet under Conventions)
- Modify: `docs/design.md:352-362` (the rail quota bullet)

**Interfaces:**
- Consumes: Tasks 1-3 (the implemented behavior).
- Produces: nothing code-facing.

- [ ] **Step 1: Rewrite the AGENTS.md quota bullet**

Find the bullet beginning `- Quota panels (claude + codex) ship in the rail:` (one bullet, ~10 wrapped lines, ending "…never logged or persisted."). Replace the whole bullet with:

```
- Quota panels (claude, codex, kimi, GLM/zai) ship in the rail: the daemon's
  quota collector (`src/core/quota.ts`, started from `cli.ts`, own 120s
  cadence) shells out to the locally installed CodexBar CLI for every
  provider (`codexbar usage --provider <key> --format json`, binary resolved
  per pass from `CODEXBAR_BINARY_CANDIDATES`, serialized spawns), classifies
  the returned windows by `windowMinutes` — weekly = the longest window of at
  least a day, session = the shortest under a day, with
  `usage.extraRateWindows` scanned when the main trio has no session window
  (codex reports `primary: null`, Spark windows live there) — and publishes
  `quota-snapshot.json` (own `schemaVersion`, bounded history ring of
  session-window samples; contract in `src/quota-snapshot.ts`) via the
  `writeFileAtomically` primitive; the strip reads it through the
  `read_quota_snapshot` Tauri command and renders from the pure view-model in
  `app/src/quota.ts`. A missing CodexBar binary or a provider disabled in the
  CodexBar app omits that provider entirely. `snapshot-v2.json` and
  `src/protocol.ts` stay untouched, and nothing CodexBar prints is ever
  logged or persisted.
```

- [ ] **Step 2: Update the design.md rail bullet**

In `docs/design.md` (lines 352-362), make two edits inside the quota bullet:

- `quota provider (claude, codex) with the provider chip` → `quota provider (claude, codex, kimi, GLM/zai) with the provider chip`
- `a provider with no credentials is omitted` → `a provider disabled in CodexBar (or with no CodexBar binary installed) is omitted`

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md docs/design.md
git commit -m "docs: CodexBar quota sourcing in AGENTS.md and design.md"
```

---

### Task 5: Deploy and live verification

Operational task — no TDD cycle. Run every step; do not skip the rollback-restore at the end of step 3.

- [ ] **Step 1: Full gate**

Run: `bun run check`
Expected: Biome clean, typecheck clean, build succeeds, all tests pass.

- [ ] **Step 2: Capture the pre-upgrade snapshot, then deploy**

```bash
cp "$HOME/Library/Application Support/com.drewritter.stream-deck-agents/quota-snapshot.json" /tmp/quota-before.json
bun scripts/install-local.ts
bun run bundle:app && bun run install:app
```

`install-local.ts` is the full daemon reinstall (core change); the strip app
rebuild covers the rail changes. The Stream Deck plugin is untouched.

- [ ] **Step 3: Verify the published snapshot**

Wait ~30s for the first quota pass, then:

```bash
python3 -m json.tool "$HOME/Library/Application Support/com.drewritter.stream-deck-agents/quota-snapshot.json"
```

Expected: all four providers (`claude`, `codex`, `kimi`, `zai`) with
`unavailable: false` and non-null `percentRemaining`; claude/codex percentages
in the same neighborhood as `/tmp/quota-before.json` (different upstream
source, same account — small divergences are fine; a wild divergence means the
window classification is wrong and must be investigated before proceeding).
`kimi`/`zai` percentages should match what `codexbar usage --provider kimi` /
`--provider zai` print by hand.

- [ ] **Step 4: Verify the binary-absence and restore path**

```bash
mv /opt/homebrew/bin/codexbar /opt/homebrew/bin/codexbar.bak
mv "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI" \
   "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI.bak"
# wait ~150s (one 120s pass + publication), then check the snapshot:
python3 -c "import json; print(json.load(open('$HOME/Library/Application Support/com.drewritter.stream-deck-agents/quota-snapshot.json'))['providers'])"
# Expected: {} (all panels omitted)
mv /opt/homebrew/bin/codexbar.bak /opt/homebrew/bin/codexbar
mv "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI.bak" \
   "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI"
# wait ~150s again → all four providers return (no daemon restart needed).
```

- [ ] **Step 5: Verify the strip visually**

On the Xeneon strip: four quota panels in the rail in the order Claude, Codex,
Kimi, GLM, with the K and G chips colored `#3B82F6` / `#2DD4BF`. Sparklines
need ≥ 2 successful passes (~4 minutes) before a line draws; until then the
percent, bar, reset countdown, and weekly line still render. Optionally also
toggle one provider off inside the CodexBar app and confirm its panel
disappears within ~150s, then re-enable it.

- [ ] **Step 6: Confirm no quota diagnostics fired**

```bash
cat "$HOME/Library/Application Support/com.drewritter.stream-deck-agents/logs/quota.log" 2>/dev/null
```

Expected: no new lines since the deploy (any `quota_failed` records here mean
a provider is silently failing — investigate before declaring done).
