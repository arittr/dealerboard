# Strip Rail Token-Usage Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Xeneon strip rail's clock with glorp-style token metrics (total tokens today, tokens/hour, tokens/10-minutes, with trend arrows), fed by a new daemon collector that shells out to the local `agentsview` helper.

**Architecture:** Mirrors the quota-panel precedent exactly: a daemon-side collector (`src/core/token-usage.ts`) publishes a sidecar snapshot (`token-usage-snapshot.json`, own `schemaVersion`, strict shared parser in `src/token-usage-snapshot.ts`); the strip reads it through a new `read_token_usage_snapshot` Tauri command and renders from a pure view-model (`app/src/token-usage.ts`). Rates are rolling trailing windows computed by differencing a persisted ring of cumulative samples — glorp's bucket-smearing is deliberately not ported.

**Spec:** `docs/superpowers/specs/2026-08-20-strip-token-usage-design.md`

**Tech Stack:** Bun + TypeScript (core daemon, strip webview), Rust/Tauri (strip host), bun:test.

## Global Constraints

- `bun test` runs the suite; `bun run typecheck` type-checks; `bun run check` is the full gate (`biome ci . && bun run build && bun test`) — run it before considering work done.
- Biome style: 2 spaces, double quotes, semicolons, 120 columns. Strict rules include `noExplicitAny`, `noEvolvingTypes`, `noConsole`, `noProcessEnv` (env enters via `src/core/cli.ts` DI only), `noDefaultExport`, `noNonNullAssertion` (relaxed in `test/**`), nursery `noFloatingPromises`; `useLiteralKeys` is off, and `noPropertyAccessFromIndexSignature` requires bracket access for index signatures.
- tsconfig strictness: `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `erasableSyntaxOnly`.
- agentsview's stdout/stderr is never logged or persisted anywhere; diagnostics carry fixed codes only (see `src/core/diagnostics.ts` header).
- `snapshot-v2.json` and `src/protocol.ts` stay untouched.
- "Today" is the America/Los_Angeles calendar day — hardcoded, matching glorp.
- Total-token contract (`tokenmaxxing_total_v1`): `inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens`; reasoning output excluded.
- Tests live in `test/` and import app code directly (e.g. `test/strip-quota.test.ts` imports `../app/src/quota`); mirror the quota test files' harness idioms.

---

### Task 1: Token-usage snapshot contract

**Files:**
- Create: `src/token-usage-snapshot.ts`
- Test: `test/token-usage-snapshot.test.ts`

**Interfaces:**
- Consumes: nothing (runtime-free shared module, like `src/quota-snapshot.ts`).
- Produces: `TOKEN_USAGE_SNAPSHOT_SCHEMA_VERSION` (1), `TOKEN_USAGE_SAMPLE_LIMIT` (288), `TokenUsageSample`, `TokenUsageSnapshot`, `parseTokenUsageSnapshot(value: unknown): TokenUsageSnapshot` — used by Tasks 2, 5.

- [ ] **Step 1: Write the failing test**

`test/token-usage-snapshot.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  parseTokenUsageSnapshot,
  TOKEN_USAGE_SAMPLE_LIMIT,
  type TokenUsageSample,
  type TokenUsageSnapshot,
} from "../src/token-usage-snapshot";

const sample = (overrides: Partial<TokenUsageSample> = {}): TokenUsageSample => ({
  fetchedAt: "2026-08-20T17:00:00.000Z",
  totalTokens: 842_100,
  providerDay: "2026-08-20",
  ...overrides,
});

const snapshot = (overrides: Partial<TokenUsageSnapshot> = {}): TokenUsageSnapshot => ({
  schemaVersion: 1,
  providerDay: "2026-08-20",
  totalTokens: 842_100,
  unavailable: false,
  fetchedAt: "2026-08-20T17:00:00.000Z",
  samples: [sample()],
  ...overrides,
});

describe("parseTokenUsageSnapshot", () => {
  test("round-trips a valid snapshot and ignores unknown keys", () => {
    const parsed = parseTokenUsageSnapshot({ ...snapshot(), futureField: { nested: true } });
    expect(parsed).toEqual(snapshot());
  });

  test("accepts a never-fetched snapshot", () => {
    const parsed = parseTokenUsageSnapshot(snapshot({ unavailable: true, fetchedAt: null, samples: [] }));
    expect(parsed.fetchedAt).toBeNull();
    expect(parsed.samples).toEqual([]);
  });

  test("rejects a wrong schemaVersion, non-objects, and missing fields", () => {
    expect(() => parseTokenUsageSnapshot(null)).toThrow("invalid token-usage snapshot");
    expect(() => parseTokenUsageSnapshot({ ...snapshot(), schemaVersion: 2 })).toThrow("schemaVersion");
    expect(() =>
      parseTokenUsageSnapshot({
        schemaVersion: 1,
        providerDay: "2026-08-20",
        unavailable: false,
        fetchedAt: null,
        samples: [],
      }),
    ).toThrow("totalTokens");
  });

  test("rejects non-canonical instants and bad providerDay strings", () => {
    expect(() => parseTokenUsageSnapshot(snapshot({ fetchedAt: "2026-08-20" }))).toThrow("fetchedAt");
    expect(() => parseTokenUsageSnapshot(snapshot({ providerDay: "08/20/2026" }))).toThrow("providerDay");
    expect(() => parseTokenUsageSnapshot(snapshot({ samples: [sample({ fetchedAt: "yesterday" })] }))).toThrow(
      "fetchedAt",
    );
  });

  test("rejects negative or non-finite totals and an over-limit ring", () => {
    expect(() => parseTokenUsageSnapshot(snapshot({ totalTokens: -1 }))).toThrow("totalTokens");
    expect(() => parseTokenUsageSnapshot(snapshot({ samples: [sample({ totalTokens: Number.NaN })] }))).toThrow(
      "totalTokens",
    );
    const ring = Array.from({ length: TOKEN_USAGE_SAMPLE_LIMIT + 1 }, () => sample());
    expect(() => parseTokenUsageSnapshot(snapshot({ samples: ring }))).toThrow("samples");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/token-usage-snapshot.test.ts`
Expected: FAIL — module `../src/token-usage-snapshot` does not exist.

- [ ] **Step 3: Implement the contract**

`src/token-usage-snapshot.ts`:

```ts
/**
 * Shared contract for the token-usage snapshot — the aggregate token-throughput
 * file the daemon's token-usage collector publishes next to the session
 * snapshot.
 *
 * This module is imported by both the Bun core (writer) and the strip app's
 * webview (reader), so it must stay free of runtime-specific imports, exactly
 * like src/quota-snapshot.ts. The session snapshot (snapshot-v2.json) and
 * src/protocol.ts are deliberately untouched: token usage rides its own file.
 */

export const TOKEN_USAGE_SNAPSHOT_SCHEMA_VERSION = 1;

/** At the 30s poll cadence, 288 samples cover ~2.4h — the 1h rate window plus its trend-comparison window. */
export const TOKEN_USAGE_SAMPLE_LIMIT = 288;

export type TokenUsageSample = {
  /** Canonical UTC ISO instant of the successful poll. */
  fetchedAt: string;
  /** Cumulative LA-day total across all agents (tokenmaxxing_total_v1). */
  totalTokens: number;
  /** America/Los_Angeles calendar date, YYYY-MM-DD. */
  providerDay: string;
};

export type TokenUsageSnapshot = {
  schemaVersion: 1;
  /** LA calendar date the totals belong to, YYYY-MM-DD. */
  providerDay: string;
  /** Today's cumulative total (input + output + cacheCreation + cacheRead). */
  totalTokens: number;
  /** True when the most recent poll failed; last-good numbers stay populated. */
  unavailable: boolean;
  /** Last successful poll (canonical UTC ISO); null when never polled. */
  fetchedAt: string | null;
  /** Bounded ring of cumulative samples, oldest first. */
  samples: TokenUsageSample[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Canonical UTC ISO (exactly what Date#toISOString emits) only: the round-trip
// check rejects date-only forms, omitted milliseconds, nonzero offsets, and
// rollover dates like 2026-02-30 that Date.parse tolerates in JavaScriptCore.
const isIsoInstant = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const isNullableIsoInstant = (value: unknown): value is string | null => value === null || isIsoInstant(value);

const isProviderDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);

const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const invalid = (reason: string): never => {
  throw new Error(`invalid token-usage snapshot: ${reason}`);
};

const parseSample = (value: unknown): TokenUsageSample => {
  if (!isRecord(value)) {
    return invalid("sample must be an object");
  }
  if (!isIsoInstant(value["fetchedAt"])) {
    return invalid("sample fetchedAt must be an ISO instant");
  }
  if (!isTokenCount(value["totalTokens"])) {
    return invalid("sample totalTokens must be a non-negative finite number");
  }
  if (!isProviderDay(value["providerDay"])) {
    return invalid("sample providerDay must be YYYY-MM-DD");
  }
  return { fetchedAt: value["fetchedAt"], totalTokens: value["totalTokens"], providerDay: value["providerDay"] };
};

/**
 * Validate an unknown value as a token-usage snapshot, returning a newly
 * constructed snapshot. Unknown top-level keys are ignored (not rejected) so a
 * newer daemon adding a field never breaks an older strip app. Throws on any
 * other contract violation; no coercion.
 */
export const parseTokenUsageSnapshot = (value: unknown): TokenUsageSnapshot => {
  if (!isRecord(value)) {
    return invalid("snapshot must be an object");
  }
  if (value["schemaVersion"] !== TOKEN_USAGE_SNAPSHOT_SCHEMA_VERSION) {
    return invalid(`schemaVersion must be ${TOKEN_USAGE_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!isProviderDay(value["providerDay"])) {
    return invalid("providerDay must be YYYY-MM-DD");
  }
  if (!isTokenCount(value["totalTokens"])) {
    return invalid("totalTokens must be a non-negative finite number");
  }
  if (typeof value["unavailable"] !== "boolean") {
    return invalid("unavailable must be a boolean");
  }
  if (!isNullableIsoInstant(value["fetchedAt"])) {
    return invalid("fetchedAt must be null or an ISO instant");
  }
  if (!Array.isArray(value["samples"]) || value["samples"].length > TOKEN_USAGE_SAMPLE_LIMIT) {
    return invalid(`samples must be an array of at most ${TOKEN_USAGE_SAMPLE_LIMIT} points`);
  }
  return {
    schemaVersion: TOKEN_USAGE_SNAPSHOT_SCHEMA_VERSION,
    providerDay: value["providerDay"],
    totalTokens: value["totalTokens"],
    unavailable: value["unavailable"],
    fetchedAt: value["fetchedAt"],
    samples: value["samples"].map(parseSample),
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/token-usage-snapshot.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/token-usage-snapshot.ts test/token-usage-snapshot.test.ts
git commit -m "feat: add token-usage snapshot contract"
```

---

### Task 2: Token-usage collector

**Files:**
- Create: `src/core/token-usage.ts`
- Modify: `src/core/diagnostics.ts:17-30` (add two codes to `DiagnosticCode`)
- Test: `test/token-usage.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseTokenUsageSnapshot`, `TOKEN_USAGE_SAMPLE_LIMIT`, `TokenUsageSnapshot`, `TokenUsageSample`; `writeFileAtomically` from `src/core/snapshot.ts`; `DiagnosticRecord` from `src/core/diagnostics.ts`; `TextProcessExecutor` type from `src/core/claude-ghostty-binding.ts`.
- Produces: `createTokenUsageCollector(deps: TokenUsageCollectorDependencies): TokenUsageCollector` with `{ start, stop, pollNow }`; `normalizeAgentsviewDaily(body: string, providerDay: string): number | null`; `laProviderDay(date: Date): string`; `resolveAgentsviewBin(environment: Record<string, string | undefined>, existsFile?): string`; `TOKEN_USAGE_POLL_INTERVAL_MS` (30_000); `TOKEN_USAGE_RUN_TIMEOUT_MS` (15_000) — wired in Task 3.

- [ ] **Step 1: Add the diagnostic codes**

In `src/core/diagnostics.ts`, extend the `DiagnosticCode` union (lines 17-30) — after `"quota_collector_failed"` add:

```ts
  | "quota_collector_failed"
  | "token_usage_failed"
  | "token_usage_collector_failed";
```

(Keep the existing entries; the diff is the two new lines plus moving the semicolon.)

- [ ] **Step 2: Write the failing test**

`test/token-usage.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { DiagnosticRecord } from "../src/core/diagnostics";
import {
  createTokenUsageCollector,
  laProviderDay,
  normalizeAgentsviewDaily,
  resolveAgentsviewBin,
  TOKEN_USAGE_SAMPLE_LIMIT,
  type TokenUsageCollectorDependencies,
} from "../src/core/token-usage";
import { parseTokenUsageSnapshot } from "../src/token-usage-snapshot";

const NOW = "2026-08-20T17:00:00.000Z"; // 10:00 in Los Angeles (UTC-7)
const NOW_MS = Date.parse(NOW);
const DAY = "2026-08-20";

const report = (total: { input: number; output: number; cacheCreation: number; cacheRead: number }): string =>
  JSON.stringify({
    schema_version: 4,
    daily: [
      {
        date: DAY,
        inputTokens: total.input,
        outputTokens: total.output,
        cacheCreationTokens: total.cacheCreation,
        cacheReadTokens: total.cacheRead,
        totalCost: { microdollars: 1 },
      },
    ],
  });

const FULL = report({ input: 100, output: 200, cacheCreation: 300, cacheRead: 400 });

describe("laProviderDay", () => {
  test("maps instants to the America/Los_Angeles calendar date", () => {
    expect(laProviderDay(new Date("2026-08-20T06:59:59.999Z"))).toBe("2026-08-19"); // 23:59:59 PDT
    expect(laProviderDay(new Date("2026-08-20T07:00:00.000Z"))).toBe(DAY); // 00:00 PDT
    expect(laProviderDay(new Date("2026-01-20T08:00:00.000Z"))).toBe("2026-01-20"); // midnight PST (UTC-8)
  });
});

describe("normalizeAgentsviewDaily", () => {
  test("sums input + output + cacheCreation + cacheRead for the day's row", () => {
    expect(normalizeAgentsviewDaily(FULL, DAY)).toBe(1000);
  });

  test("a report with no row for the day is a legitimate zero", () => {
    expect(normalizeAgentsviewDaily(JSON.stringify({ schema_version: 4, daily: [] }), DAY)).toBe(0);
  });

  test("returns null for malformed JSON, wrong schema, or a row with bad fields", () => {
    expect(normalizeAgentsviewDaily("junk", DAY)).toBeNull();
    expect(normalizeAgentsviewDaily(JSON.stringify({ schema_version: 3, daily: [] }), DAY)).toBeNull();
    const badRow = JSON.stringify({ schema_version: 4, daily: [{ date: DAY, inputTokens: -1 }] });
    expect(normalizeAgentsviewDaily(badRow, DAY)).toBeNull();
  });
});

describe("resolveAgentsviewBin", () => {
  test("prefers AGENTSVIEW_BIN, then the homebrew path, then PATH", () => {
    expect(resolveAgentsviewBin({ AGENTSVIEW_BIN: "/custom/agy" }, () => true)).toBe("/custom/agy");
    expect(resolveAgentsviewBin({}, () => true)).toBe("/opt/homebrew/bin/agentsview");
    expect(resolveAgentsviewBin({}, () => false)).toBe("agentsview");
  });
});

describe("createTokenUsageCollector", () => {
  const makeHarness = (files: Record<string, string> = {}) => {
    const runs: { file: string; args: readonly string[] }[] = [];
    const diagnostics: DiagnosticRecord[] = [];
    const writes: string[] = [];
    let body = FULL;
    let throws = false;
    const deps: TokenUsageCollectorDependencies = {
      agentsviewBin: "agentsview",
      tokenUsageSnapshotPath: "/tmp/token-usage-snapshot.json",
      run: async (file, args) => {
        runs.push({ file, args });
        if (throws) {
          throw new Error("spawn failed");
        }
        return body;
      },
      readFile: (path) => files[path] ?? null,
      now: () => NOW,
      nowMs: () => NOW_MS,
      writeFile: (_path, payload) => {
        writes.push(payload);
      },
      diagnostics: (record) => {
        diagnostics.push(record);
      },
    };
    return {
      deps,
      runs,
      diagnostics,
      writes,
      respond: (nextBody: string) => {
        body = nextBody;
        throws = false;
      },
      fail: () => {
        throws = true;
      },
    };
  };

  test("a successful poll runs agentsview for the LA day and publishes the snapshot with one sample", async () => {
    const harness = makeHarness();
    await createTokenUsageCollector(harness.deps).pollNow();
    expect(harness.runs.length).toBe(1);
    expect(harness.runs[0]?.args).toEqual([
      "usage",
      "daily",
      "--json",
      "--timezone",
      "America/Los_Angeles",
      "--since",
      DAY,
    ]);
    expect(harness.writes.length).toBe(1);
    const snapshot = parseTokenUsageSnapshot(JSON.parse(harness.writes[0] ?? ""));
    expect(snapshot).toEqual({
      schemaVersion: 1,
      providerDay: DAY,
      totalTokens: 1000,
      unavailable: false,
      fetchedAt: NOW,
      samples: [{ fetchedAt: NOW, totalTokens: 1000, providerDay: DAY }],
    });
  });

  test("a failed poll keeps last-good data, marks unavailable, and logs only the transition", async () => {
    const harness = makeHarness();
    const collector = createTokenUsageCollector(harness.deps);
    await collector.pollNow();
    harness.fail();
    await collector.pollNow();
    await collector.pollNow();
    const snapshot = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(snapshot).toMatchObject({ totalTokens: 1000, unavailable: true, fetchedAt: NOW });
    expect(snapshot.samples.length).toBe(1); // failures never append samples
    const failures = harness.diagnostics.filter((record) => record.code === "token_usage_failed");
    expect(failures.length).toBe(1); // good→failed transition only
    expect(failures[0]?.component).toBe("token-usage");
  });

  test("a cold-start failure publishes an unavailable never-fetched snapshot and recovers cleanly", async () => {
    const harness = makeHarness();
    const collector = createTokenUsageCollector(harness.deps);
    harness.fail();
    await collector.pollNow();
    const cold = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(cold).toMatchObject({ totalTokens: 0, unavailable: true, fetchedAt: null, samples: [] });
    harness.respond(FULL);
    await collector.pollNow();
    const recovered = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(recovered).toMatchObject({ totalTokens: 1000, unavailable: false, fetchedAt: NOW });
  });

  test("the ring is capped and seeds from the previous publication", async () => {
    const seeded = {
      schemaVersion: 1,
      providerDay: DAY,
      totalTokens: 500,
      unavailable: false,
      fetchedAt: "2026-08-20T16:59:30.000Z",
      samples: Array.from({ length: TOKEN_USAGE_SAMPLE_LIMIT }, () => ({
        fetchedAt: "2026-08-20T16:00:00.000Z",
        totalTokens: 400,
        providerDay: DAY,
      })),
    };
    const harness = makeHarness({ "/tmp/token-usage-snapshot.json": `${JSON.stringify(seeded)}\n` });
    await createTokenUsageCollector(harness.deps).pollNow();
    const snapshot = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(snapshot.samples.length).toBe(TOKEN_USAGE_SAMPLE_LIMIT); // 288 seeded + 1 new, capped
    expect(snapshot.samples.at(-1)).toEqual({ fetchedAt: NOW, totalTokens: 1000, providerDay: DAY });
  });

  test("an unchanged state is not rewritten", async () => {
    const harness = makeHarness();
    const collector = createTokenUsageCollector(harness.deps);
    harness.fail();
    await collector.pollNow();
    await collector.pollNow(); // identical unavailable snapshot — no second write
    expect(harness.writes.length).toBe(1);
  });
});
```

Note for the implementer: `TOKEN_USAGE_SAMPLE_LIMIT` is re-exported from `src/core/token-usage.ts` (re-export the contract constant) so the test imports from one place. The harness's `body_`/`throws` closure pattern keeps Biome's `noEvolvingTypes` happy — annotate explicitly if it complains.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/token-usage.test.ts`
Expected: FAIL — module `../src/core/token-usage` does not exist.

- [ ] **Step 4: Implement the collector**

`src/core/token-usage.ts`:

```ts
/**
 * Token-usage collection for the strip's rail block.
 *
 * Shells out to the local `agentsview` helper (the same reporter glorp uses)
 * for the America/Los_Angeles day's cumulative token totals, and keeps a
 * bounded ring of cumulative samples so the strip can difference rolling
 * windows. The total contract is tokenmaxxing_total_v1: input + output +
 * cacheCreation + cacheRead (cache reads count fully; reasoning output is
 * excluded).
 *
 * agentsview's output and error text are never logged or written anywhere.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  parseTokenUsageSnapshot,
  TOKEN_USAGE_SAMPLE_LIMIT,
  type TokenUsageSnapshot,
} from "../token-usage-snapshot";
import type { TextProcessExecutor } from "./claude-ghostty-binding";
import type { DiagnosticRecord } from "./diagnostics";
import { writeFileAtomically } from "./snapshot";

export { TOKEN_USAGE_SAMPLE_LIMIT };

export const TOKEN_USAGE_POLL_INTERVAL_MS = 30_000;
export const TOKEN_USAGE_RUN_TIMEOUT_MS = 15_000;
/** agentsview embeds a pricing table in its JSON; the daily row we need is small. */
const AGENTSVIEW_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TOKEN_USAGE_TIMEZONE = "America/Los_Angeles";
const HOMEBREW_AGENTSVIEW_BIN = "/opt/homebrew/bin/agentsview";
const DIAGNOSTIC_COMPONENT = "token-usage";

export type TokenUsageRunner = TextProcessExecutor;

/** Same shape as the daemon's DaemonScheduler: arms a recurring tick, returns a disarm callback. */
export type TokenUsageScheduler = (tick: () => void, intervalMs: number) => () => void;

export type TokenUsageCollectorDependencies = {
  agentsviewBin: string;
  tokenUsageSnapshotPath: string;
  run?: TokenUsageRunner;
  readFile?: (path: string) => string | null;
  now?: () => string;
  nowMs?: () => number;
  writeFile?: (path: string, payload: string) => void;
  schedule?: TokenUsageScheduler;
  diagnostics?: (record: DiagnosticRecord) => void;
};

export type TokenUsageCollector = {
  /** Poll immediately, then arm the interval. Idempotent while started. */
  start: () => void;
  /** Disarm the interval; an in-flight run settles on its own. */
  stop: () => void;
  /** One collection pass; reentrancy-guarded, never throws. */
  pollNow: () => Promise<void>;
};

const laDayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TOKEN_USAGE_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The America/Los_Angeles calendar date (YYYY-MM-DD) for an instant, assembled part-wise so locale ordering can't leak in. */
export const laProviderDay = (date: Date): string => {
  const parts = laDayFormat.formatToParts(date);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

/** Where the collector looks for the helper: env override, the homebrew default, then PATH. */
export const resolveAgentsviewBin = (
  environment: Record<string, string | undefined>,
  existsFile: (path: string) => boolean = existsSync,
): string => {
  const override = environment["AGENTSVIEW_BIN"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return existsFile(HOMEBREW_AGENTSVIEW_BIN) ? HOMEBREW_AGENTSVIEW_BIN : "agentsview";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const tokenCount = (row: Record<string, unknown>, key: string): number | null => {
  const value = row[key];
  return isTokenCount(value) ? value : null;
};

/**
 * Parse one agentsview `usage daily --json` report down to the providerDay
 * row's tokenmaxxing_total_v1. A report with no row for the day is a
 * legitimate zero (nothing burned yet); any contract violation — wrong
 * schema, malformed JSON, a present row with bad fields — is null (a failed
 * poll).
 */
export const normalizeAgentsviewDaily = (body: string, providerDay: string): number | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["schema_version"] !== 4 || !Array.isArray(parsed["daily"])) {
    return null;
  }
  for (const entry of parsed["daily"]) {
    if (!isRecord(entry) || entry["date"] !== providerDay) {
      continue;
    }
    const input = tokenCount(entry, "inputTokens");
    const output = tokenCount(entry, "outputTokens");
    const cacheCreation = tokenCount(entry, "cacheCreationTokens");
    const cacheRead = tokenCount(entry, "cacheReadTokens");
    if (input === null || output === null || cacheCreation === null || cacheRead === null) {
      return null;
    }
    return input + output + cacheCreation + cacheRead;
  }
  return 0;
};

const emptySnapshot = (providerDay: string): TokenUsageSnapshot => ({
  schemaVersion: 1,
  providerDay,
  totalTokens: 0,
  unavailable: true,
  fetchedAt: null,
  samples: [],
});

const defaultRunner: TokenUsageRunner = (file, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: AGENTSVIEW_MAX_OUTPUT_BYTES },
      (error, stdout) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        reject(error);
      },
    );
  });

const defaultReadFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const defaultSchedule: TokenUsageScheduler = (tick, intervalMs) => {
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
};

type CollectorState = { snapshot: TokenUsageSnapshot; failed: boolean };

export const createTokenUsageCollector = (dependencies: TokenUsageCollectorDependencies): TokenUsageCollector => {
  const run = dependencies.run ?? defaultRunner;
  const readFile = dependencies.readFile ?? defaultReadFile;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const nowMs = dependencies.nowMs ?? (() => Date.now());
  const writeFile = dependencies.writeFile ?? writeFileAtomically;
  const schedule = dependencies.schedule ?? defaultSchedule;
  const diagnostics = dependencies.diagnostics ?? (() => {});

  let state: CollectorState = { snapshot: emptySnapshot(laProviderDay(new Date(nowMs()))), failed: false };
  let lastWrittenJson: string | null = null;
  let polling = false;
  let started = false;
  let cancelSchedule: (() => void) | null = null;

  const reportFailure = (): void => {
    try {
      diagnostics({ timestamp: now(), component: DIAGNOSTIC_COMPONENT, code: "token_usage_failed" });
    } catch {
      // Diagnostics must never break the collector.
    }
  };

  // Seed last-good state from the previous publication so a daemon restart
  // never blanks the block (or its rate windows).
  try {
    const existing = readFile(dependencies.tokenUsageSnapshotPath);
    if (existing !== null) {
      const seeded = parseTokenUsageSnapshot(JSON.parse(existing));
      // A seeded unavailable snapshot is already in the failed state — its
      // continuation must not re-log, only a good→failed transition may.
      state = { snapshot: seeded, failed: seeded.unavailable };
      lastWrittenJson = `${JSON.stringify(seeded)}\n`;
    }
  } catch {
    // An unreadable or unparseable file is simply rewritten on the first pass.
  }

  const pollNow = async (): Promise<void> => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      const providerDay = laProviderDay(new Date(nowMs()));
      let total: number | null = null;
      try {
        const output = await run(
          dependencies.agentsviewBin,
          ["usage", "daily", "--json", "--timezone", TOKEN_USAGE_TIMEZONE, "--since", providerDay],
          TOKEN_USAGE_RUN_TIMEOUT_MS,
        );
        total = normalizeAgentsviewDaily(output, providerDay);
      } catch {
        total = null;
      }
      if (total === null) {
        if (!state.failed) {
          reportFailure();
        }
        state = { snapshot: { ...state.snapshot, unavailable: true }, failed: true };
      } else {
        const fetchedAt = now();
        const samples = [...state.snapshot.samples, { fetchedAt, totalTokens: total, providerDay }].slice(
          -TOKEN_USAGE_SAMPLE_LIMIT,
        );
        state = {
          snapshot: { schemaVersion: 1, providerDay, totalTokens: total, unavailable: false, fetchedAt, samples },
          failed: false,
        };
      }
      const json = `${JSON.stringify(state.snapshot)}\n`;
      if (json !== lastWrittenJson) {
        try {
          writeFile(dependencies.tokenUsageSnapshotPath, json);
          lastWrittenJson = json;
        } catch {
          // A publication I/O failure retries on the next pass.
        }
      }
    } catch {
      // The exported contract promises pollNow never throws. An unexpected
      // dependency/runtime exception is contained here — one fixed diagnostic,
      // never error text — and the next pass retries.
      reportFailure();
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
      }, TOKEN_USAGE_POLL_INTERVAL_MS);
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

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/token-usage.test.ts`
Expected: PASS (all tests)

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: clean (the new `DiagnosticCode` entries and the re-export included).

- [ ] **Step 7: Commit**

```bash
git add src/core/token-usage.ts src/core/diagnostics.ts test/token-usage.test.ts
git commit -m "feat: add token-usage collector shelling out to agentsview"
```

---

### Task 3: Daemon wiring

**Files:**
- Modify: `src/core/paths.ts:12-40` (add `tokenUsageSnapshot` to `AppPaths` and `resolveAppPaths`)
- Modify: `src/core/cli.ts:50-65` (CliDependencies) and `src/core/cli.ts:429-452` (runDaemon, after the quota collector block)

**Interfaces:**
- Consumes: Task 2's `createTokenUsageCollector`, `resolveAgentsviewBin`.
- Produces: daemon publishes `token-usage-snapshot.json` in the app-support root (consumed by Task 4's Tauri command).

- [ ] **Step 1: Add the path**

In `src/core/paths.ts`, add to the `AppPaths` type after `quotaSnapshot: string;`:

```ts
  tokenUsageSnapshot: string;
```

and in `resolveAppPaths` after `quotaSnapshot: join(root, "quota-snapshot.json"),`:

```ts
    tokenUsageSnapshot: join(root, "token-usage-snapshot.json"),
```

- [ ] **Step 2: Wire the collector in cli.ts**

In `src/core/cli.ts`:

1. Extend the import at line 33 (`import { createQuotaCollector } from "./quota";`) region with:

```ts
import { createTokenUsageCollector, resolveAgentsviewBin } from "./token-usage";
```

2. In `CliDependencies` (lines 50-65), after `createQuotaCollector?: typeof createQuotaCollector;` add:

```ts
  createTokenUsageCollector?: typeof createTokenUsageCollector;
```

3. In `runDaemon`, immediately after the quota collector's closing `catch` block (after line 452), add a parallel block:

```ts
    // The token-usage collector is optional telemetry on its own scheduler,
    // contained exactly like the quota collector above.
    try {
      const createCollector = dependencies.createTokenUsageCollector ?? createTokenUsageCollector;
      const tokenUsageCollector = createCollector({
        agentsviewBin: resolveAgentsviewBin(environment),
        tokenUsageSnapshotPath: daemonPaths.tokenUsageSnapshot,
        diagnostics,
      });
      tokenUsageCollector.start();
    } catch {
      try {
        diagnostics({
          timestamp: new Date().toISOString(),
          component: "token-usage",
          code: "token_usage_collector_failed",
        });
      } catch {
        // A failing sink must never break daemon startup.
      }
    }
```

(`environment` is already bound at the top of `runDaemon` as `process.env` — line 412.)

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun test`
Expected: clean typecheck; full suite green (existing path/cli tests updated only if they enumerate `AppPaths` keys — check `test/` for `quotaSnapshot` references with `rg -l quotaSnapshot test/` and extend any `resolveAppPaths` expectation to include `tokenUsageSnapshot: join(root, "token-usage-snapshot.json")`).

- [ ] **Step 4: Commit**

```bash
git add src/core/paths.ts src/core/cli.ts test/
git commit -m "feat: wire token-usage collector into the daemon"
```

---

### Task 4: Tauri command + webview bridge

**Files:**
- Modify: `app/src-tauri/src/main.rs:87-108` (add command after `read_quota_snapshot`) and `app/src-tauri/src/main.rs:241` (register in the invoke handler)
- Modify: `app/src/bridge.ts:11` (add `readTokenUsageSnapshot`)

**Interfaces:**
- Consumes: `token-usage-snapshot.json` at the app-support root (Task 3).
- Produces: `readTokenUsageSnapshot(): Promise<SnapshotPayload>` in `app/src/bridge.ts` — used by Task 6.

- [ ] **Step 1: Add the Rust command**

In `app/src-tauri/src/main.rs`, directly after the `read_quota_snapshot` function (ends line 108), add:

```rust
/// The token-usage snapshot lives next to the session snapshot but is owned by
/// the daemon's token-usage collector; a missing file simply means "no token
/// data yet" and is reported as a fixed error string the frontend can branch on.
#[tauri::command]
async fn read_token_usage_snapshot() -> Result<SnapshotPayload, String> {
    let path = app_support_root()?.join("token-usage-snapshot.json");
    let metadata = std::fs::metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "token_usage_snapshot_missing".to_string()
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

Then in the `tauri::generate_handler!` list (around line 241, where `read_quota_snapshot,` appears), add directly after it:

```rust
            read_token_usage_snapshot,
```

- [ ] **Step 2: Check the Rust crate**

Run: `cargo check --manifest-path app/src-tauri/Cargo.toml`
Expected: compiles with no new errors.

- [ ] **Step 3: Add the bridge function**

In `app/src/bridge.ts`, after the `readQuotaSnapshot` line (line 11):

```ts
export const readTokenUsageSnapshot = (): Promise<SnapshotPayload> => invoke<SnapshotPayload>("read_token_usage_snapshot");
```

- [ ] **Step 4: Verify the frontend still type-checks**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/main.rs app/src/bridge.ts
git commit -m "feat: expose the token-usage snapshot to the strip webview"
```

---

### Task 5: Strip token-usage view-model

**Files:**
- Create: `app/src/token-usage.ts`
- Test: `test/strip-token-usage.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseTokenUsageSnapshot`, `TokenUsageSnapshot`; `SnapshotPayload` from `app/src/bridge.ts`.
- Produces: `TokenUsageRailModel` (`{ state: "hidden" } | { state: "ok" | "stale"; totalTokens: number; hour: TokenUsageRateLine; tenMin: TokenUsageRateLine }`), `TokenUsageRateLine` (`{ tokens: number; trend: "up" | "down" | "flat" }`), `reduceTokenUsageRead(read: SnapshotPayload | null, nowMs: number): TokenUsageRailModel`, `formatTokensCompact(value: number): string`, `STALE_TOKEN_USAGE_AGE_MS` (90_000) — used by Task 6.

- [ ] **Step 1: Write the failing test**

`test/strip-token-usage.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  formatTokensCompact,
  reduceTokenUsageRead,
  STALE_TOKEN_USAGE_AGE_MS,
} from "../app/src/token-usage";
import type { TokenUsageSample, TokenUsageSnapshot } from "../src/token-usage-snapshot";

const NOW = Date.parse("2026-08-20T18:00:00.000Z"); // 11:00 in Los Angeles
const DAY = "2026-08-20";

const iso = (ms: number): string => new Date(ms).toISOString();

const sampleAt = (ms: number, totalTokens: number, providerDay: string = DAY): TokenUsageSample => ({
  fetchedAt: iso(ms),
  totalTokens,
  providerDay,
});

const snapshot = (overrides: Partial<TokenUsageSnapshot> = {}): TokenUsageSnapshot => ({
  schemaVersion: 1,
  providerDay: DAY,
  totalTokens: 842_100,
  unavailable: false,
  fetchedAt: iso(NOW),
  samples: [],
  ...overrides,
});

const read = (value: TokenUsageSnapshot): { mtimeMs: number; contents: string } => ({
  mtimeMs: NOW,
  contents: JSON.stringify(value),
});

describe("formatTokensCompact", () => {
  test("formats with glorp's compact rules: one decimal, .0 stripped, k/M/B", () => {
    expect(formatTokensCompact(0)).toBe("0");
    expect(formatTokensCompact(42)).toBe("42");
    expect(formatTokensCompact(999)).toBe("999");
    expect(formatTokensCompact(1000)).toBe("1k");
    expect(formatTokensCompact(12_300)).toBe("12.3k");
    expect(formatTokensCompact(842_100)).toBe("842.1k");
    expect(formatTokensCompact(999_949)).toBe("999.9k");
    expect(formatTokensCompact(999_950)).toBe("1M"); // 1000.0k rolls up
    expect(formatTokensCompact(1_500_000)).toBe("1.5M");
    expect(formatTokensCompact(31_000_000)).toBe("31M");
    expect(formatTokensCompact(2_340_000_000)).toBe("2.3B");
    expect(formatTokensCompact(-5)).toBe("0");
  });
});

describe("reduceTokenUsageRead", () => {
  test("a missing, unparseable, or never-fetched read is hidden", () => {
    expect(reduceTokenUsageRead(null, NOW)).toEqual({ state: "hidden" });
    expect(reduceTokenUsageRead({ mtimeMs: NOW, contents: "junk" }, NOW)).toEqual({ state: "hidden" });
    expect(reduceTokenUsageRead(read(snapshot({ unavailable: true, fetchedAt: null })), NOW)).toEqual({
      state: "hidden",
    });
  });

  test("rates difference the sample ring against the newest-sample anchor", () => {
    // Samples every 10m from 09:00 to 11:00 LA (16:00Z–18:00Z): +6k per 10m
    // through index 6, then +12k — totals 6k,12k,…,42k at index 6, then
    // 54k,66k,…,114k at index 12 (= NOW, the anchor).
    const start = Date.parse("2026-08-20T16:00:00.000Z"); // 09:00 PDT
    const samples: TokenUsageSample[] = [];
    let total = 0;
    for (let index = 0; index <= 12; index += 1) {
      const at = start + index * 10 * 60_000;
      total += index <= 6 ? 6000 : 12_000;
      samples.push(sampleAt(at, total));
    }
    const model = reduceTokenUsageRead(read(snapshot({ totalTokens: total, samples })), NOW);
    if (model.state === "hidden") {
      throw new Error("expected a rendered model");
    }
    expect(model.totalTokens).toBe(total); // 114_000
    expect(model.tenMin.tokens).toBe(12_000); // total(12) − total(11)
    expect(model.tenMin.trend).toBe("flat"); // previous 10m window also gained 12k — inside the deadband
    expect(model.hour.tokens).toBe(72_000); // total(12) − total(6) = 114k − 42k
    expect(model.hour.trend).toBe("up"); // previous hour gained total(6) − total(0) = 36k; 72k > 36k + 3.6k
  });

  const trendFor = (previous: number, current: number): string => {
    const samples = [
      sampleAt(NOW - 20 * 60_000, 0),
      sampleAt(NOW - 10 * 60_000, previous),
      sampleAt(NOW, previous + current),
    ];
    const model = reduceTokenUsageRead(read(snapshot({ totalTokens: previous + current, samples })), NOW);
    if (model.state === "hidden") {
      throw new Error("expected a rendered model");
    }
    return model.tenMin.trend;
  };

  test("trend arrows respect the deadband max(1000, 10% of previous)", () => {
    expect(trendFor(10_000, 12_000)).toBe("up"); // +20% beats the 10% threshold
    expect(trendFor(10_000, 8_000)).toBe("down"); // −20%
    expect(trendFor(10_000, 10_500)).toBe("flat"); // +5% is inside the deadband
    expect(trendFor(500, 800)).toBe("flat"); // +300 is under the 1,000-token floor
  });

  test("the LA-midnight rollover never yields negative rates", () => {
    const yesterday = "2026-08-19";
    const samples = [
      sampleAt(NOW - 30 * 60_000, 900_000, yesterday),
      sampleAt(NOW - 10 * 60_000, 2000),
      sampleAt(NOW, 5000),
    ];
    const model = reduceTokenUsageRead(read(snapshot({ totalTokens: 5000, samples })), NOW);
    if (model.state === "hidden") {
      throw new Error("expected a rendered model");
    }
    expect(model.tenMin.tokens).toBe(3000); // 5000 − 2000; yesterday's 900k sample is ignored
    expect(model.hour.tokens).toBe(3000); // no sample at/before the window start → the day's earliest (2000)
    expect(model.tenMin.tokens).toBeGreaterThanOrEqual(0);
    expect(model.hour.tokens).toBeGreaterThanOrEqual(0);
  });

  test("stale when unavailable or the last success is older than 90s; ok otherwise", () => {
    expect(reduceTokenUsageRead(read(snapshot({ unavailable: true })), NOW)).toMatchObject({ state: "stale" });
    const oldFetch = iso(NOW - STALE_TOKEN_USAGE_AGE_MS - 1);
    expect(reduceTokenUsageRead(read(snapshot({ fetchedAt: oldFetch })), NOW)).toMatchObject({ state: "stale" });
    expect(reduceTokenUsageRead(read(snapshot()), NOW)).toMatchObject({ state: "ok" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/strip-token-usage.test.ts`
Expected: FAIL — module `../app/src/token-usage` does not exist.

- [ ] **Step 3: Implement the view-model**

`app/src/token-usage.ts`:

```ts
/**
 * Pure view-model for the rail's token-usage block: reduce the token-usage
 * snapshot read to a rail model — today's total plus rolling /hr and /10m
 * rates with glorp-style trend arrows — plus the compact token formatting.
 * Kept DOM-free so the logic is unit-testable; the rendering layer is
 * app/src/rail.ts.
 */

import { parseTokenUsageSnapshot, type TokenUsageSnapshot } from "../../src/token-usage-snapshot";
import type { SnapshotPayload } from "./bridge";

/** Three missed 30s collector passes without a success marks the block stale. */
export const STALE_TOKEN_USAGE_AGE_MS = 3 * 30_000;

const TEN_MINUTES_MS = 10 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

export type TokenUsageTrend = "up" | "down" | "flat";

export type TokenUsageRateLine = { tokens: number; trend: TokenUsageTrend };

export type TokenUsageRailModel =
  | { state: "hidden" }
  | { state: "ok" | "stale"; totalTokens: number; hour: TokenUsageRateLine; tenMin: TokenUsageRateLine };

type NumberedSample = { atMs: number; totalTokens: number };

/**
 * The day's cumulative total as of `atMs`: the newest same-day sample at or
 * before it, else the day's earliest sample — early-morning windows then read
 * as "since midnight" rather than dipping into yesterday's larger totals.
 */
const totalAsOf = (samples: readonly NumberedSample[], atMs: number): number => {
  let earliest: NumberedSample | null = null;
  let latest: NumberedSample | null = null;
  for (const sample of samples) {
    if (earliest === null || sample.atMs < earliest.atMs) {
      earliest = sample;
    }
    if (sample.atMs <= atMs && (latest === null || sample.atMs > latest.atMs)) {
      latest = sample;
    }
  }
  return (latest ?? earliest)?.totalTokens ?? 0;
};

/** A rolling-window rate: current window minus its start, trended against the previous equal-width window with glorp's deadband. */
const rateLine = (samples: readonly NumberedSample[], anchorMs: number, windowMs: number): TokenUsageRateLine => {
  const newest = samples[samples.length - 1]?.totalTokens ?? 0;
  const current = Math.max(0, newest - totalAsOf(samples, anchorMs - windowMs));
  const previous = Math.max(0, totalAsOf(samples, anchorMs - windowMs) - totalAsOf(samples, anchorMs - 2 * windowMs));
  const threshold = Math.max(1000, 0.1 * previous);
  const trend: TokenUsageTrend = current > previous + threshold ? "up" : current < previous - threshold ? "down" : "flat";
  return { tokens: current, trend };
};

const formatScaled = (scaled: number, suffix: string): string => `${scaled.toFixed(1).replace(/\.0$/u, "")}${suffix}`;

/** glorp's compact token formatting: one decimal, a trailing .0 stripped, k/M/B suffixes (1000.0k rolls up to 1M). */
export const formatTokensCompact = (value: number): string => {
  const tokens = Math.max(0, value);
  if (tokens < 1000) {
    return String(Math.round(tokens));
  }
  if (tokens < 999_950) {
    return formatScaled(tokens / 1e3, "k");
  }
  if (tokens < 999_950_000) {
    return formatScaled(tokens / 1e6, "M");
  }
  return formatScaled(tokens / 1e9, "B");
};

export const reduceTokenUsageRead = (read: SnapshotPayload | null, nowMs: number): TokenUsageRailModel => {
  if (read === null) {
    return { state: "hidden" };
  }
  let snapshot: TokenUsageSnapshot;
  try {
    snapshot = parseTokenUsageSnapshot(JSON.parse(read.contents));
  } catch {
    return { state: "hidden" };
  }
  const fetchedAtMs = snapshot.fetchedAt === null ? null : Date.parse(snapshot.fetchedAt);
  if (fetchedAtMs === null) {
    return { state: "hidden" };
  }
  const state = snapshot.unavailable || nowMs - fetchedAtMs > STALE_TOKEN_USAGE_AGE_MS ? "stale" : "ok";
  const daySamples: NumberedSample[] = [];
  for (const sample of snapshot.samples) {
    if (sample.providerDay !== snapshot.providerDay) {
      continue;
    }
    const atMs = Date.parse(sample.fetchedAt);
    if (!Number.isNaN(atMs)) {
      daySamples.push({ atMs, totalTokens: sample.totalTokens });
    }
  }
  const anchor = daySamples[daySamples.length - 1];
  if (anchor === undefined) {
    // A success with no usable samples yet — render zeros rather than vanish.
    const zero: TokenUsageRateLine = { tokens: 0, trend: "flat" };
    return { state, totalTokens: snapshot.totalTokens, hour: zero, tenMin: zero };
  }
  return {
    state,
    totalTokens: snapshot.totalTokens,
    hour: rateLine(daySamples, anchor.atMs, ONE_HOUR_MS),
    tenMin: rateLine(daySamples, anchor.atMs, TEN_MINUTES_MS),
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/strip-token-usage.test.ts`
Expected: PASS (all tests; fix the deliberately-marked arithmetic in the second test if the hand-computed values were wrong).

- [ ] **Step 5: Commit**

```bash
git add app/src/token-usage.ts test/strip-token-usage.test.ts
git commit -m "feat: add strip token-usage view-model"
```

---

### Task 6: Rail section, styles, and strip wiring

**Files:**
- Modify: `app/src/rail.ts` (replace clock section; `RailModel` gains `tokens`)
- Modify: `app/styles.css:257-262` (replace `.rail-clock` block)
- Modify: `app/src/main.ts:8-15` (docstring), `app/src/main.ts:39` (bridge import), `app/src/main.ts:54-55` (view-model import), `app/src/main.ts:69` (state), `app/src/main.ts:127-145` (renderRailNow), `app/src/main.ts:269-275` (slowPass)

**Interfaces:**
- Consumes: Task 4's `readTokenUsageSnapshot`; Task 5's `reduceTokenUsageRead`, `formatTokensCompact`, `TokenUsageRailModel`, `TokenUsageRateLine`.
- Produces: the rail renders the token block; `RailModel.tokens: TokenUsageRailModel`.

- [ ] **Step 1: Update `app/src/rail.ts`**

Replace the module docstring's first line:

```ts
 * The strip's fixed right rail: daemon health (with heartbeat age), clock,
```

with:

```ts
 * The strip's fixed right rail: daemon health (with heartbeat age), token
 * usage (today's total with rolling /hr and /10m rates), unread count,
```

Add the import:

```ts
import { formatTokensCompact, type TokenUsageRailModel, type TokenUsageRateLine } from "./token-usage";
```

In `RailModel`, after `quota: readonly QuotaPanelModel[];` add:

```ts
  tokens: TokenUsageRailModel;
```

Delete the `pad2` helper (line 34) — the clock was its only caller — and add, after the `healthSection` function:

```ts
const rateLineElement = (line: TokenUsageRateLine, unit: string): HTMLElement => {
  const row = document.createElement("div");
  row.className = "tokens-rate";
  row.dataset["trend"] = line.trend;
  const arrow = line.trend === "up" ? "↑" : line.trend === "down" ? "↓" : "→";
  row.textContent = `${arrow} ${formatTokensCompact(line.tokens)}/${unit}`;
  return row;
};

const tokensSection = (model: TokenUsageRailModel): HTMLElement | null => {
  if (model.state === "hidden") {
    return null;
  }
  const section = document.createElement("section");
  section.className = "rail-tokens";
  section.dataset["state"] = model.state;
  const today = document.createElement("div");
  today.className = "tokens-today";
  today.textContent = `${formatTokensCompact(model.totalTokens)} today`;
  section.append(today, rateLineElement(model.hour, "hr"), rateLineElement(model.tenMin, "10m"));
  return section;
};
```

Rewrite `renderRail`'s body (lines 154-166) — the clock section goes away:

```ts
export const renderRail = (root: HTMLElement, model: RailModel, actions: RailActions): void => {
  const tokens = tokensSection(model.tokens);

  const unread = document.createElement("section");
  unread.className = model.unreadCount > 0 ? "rail-unread active" : "rail-unread";
  unread.textContent = model.unreadCount === 1 ? "1 unread" : `${model.unreadCount} unread`;

  const nowMs = model.now.getTime();
  const quotaSections = model.quota.map((quota) => quotaSection(quota, nowMs));

  const sections = [healthSection(model)];
  if (tokens !== null) {
    sections.push(tokens);
  }
  sections.push(unread, ...quotaSections, pagerSection(model, actions));
  root.replaceChildren(...sections);
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

- [ ] **Step 2: Update `app/styles.css`**

Replace the `.rail-clock` block (lines 257-262):

```css
.rail-clock {
  color: #e8eef7;
  font-size: 3.4vw;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
```

with:

```css
.rail-tokens {
  display: flex;
  flex-direction: column;
  gap: 0.4vh;
  font-variant-numeric: tabular-nums;
}
.rail-tokens[data-state="stale"] {
  opacity: 0.45;
}
.tokens-today {
  color: #e8eef7;
  font-size: 1.8vw;
  font-weight: 650;
}
.tokens-rate {
  color: #94a3b8;
  font-size: 1.4vw;
}
.tokens-rate[data-trend="up"] {
  color: #4ade80;
}
.tokens-rate[data-trend="down"] {
  color: #ff4d67;
}
```

- [ ] **Step 3: Wire `app/src/main.ts`**

1. Module docstring (lines 8-15): the phrase "the rail clock and the per-tile status timers" becomes "the per-tile status timers" (the clock is gone; the block now rides the slow pass with quota).
2. Bridge import (line 39 area): add `readTokenUsageSnapshot` to the existing `import { ... } from "./bridge";` list.
3. View-model import (after line 54): `import { reduceTokenUsageRead, type TokenUsageRailModel } from "./token-usage";`
4. State (after line 69, `let currentQuota ...`): 

```ts
let currentTokenUsage: TokenUsageRailModel = { state: "hidden" };
```

5. In `renderRailNow` (lines 132-142), add to the model object after `quota: currentQuota,`:

```ts
      tokens: currentTokenUsage,
```

6. In `slowPass` (lines 269-275), after the quota line add — and extend the doc comment above it to mention the token-usage snapshot riding the same pass:

```ts
  currentTokenUsage = reduceTokenUsageRead(await readTokenUsageSnapshot().catch(() => null), Date.now());
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun test && bun run build:app`
Expected: clean typecheck, suite green, frontend bundle builds.

- [ ] **Step 5: Commit**

```bash
git add app/src/rail.ts app/styles.css app/src/main.ts
git commit -m "feat: replace the rail clock with the token-usage block"
```

---

### Task 7: Docs, AGENTS.md, and the full gate

**Files:**
- Modify: `docs/design.md:346-362` (Rail section)
- Modify: `AGENTS.md` (Conventions — the strip/quota paragraph)

**Interfaces:**
- Consumes: all previous tasks.
- Produces: documentation matching the shipped behavior.

- [ ] **Step 1: Update `docs/design.md`**

In the `### Rail` section, replace the bullet:

```markdown
- A clock and the exact unread count (tiles whose session carries an
  `unreadSince` stamp).
```

with:

```markdown
- A token-usage block and the exact unread count (tiles whose session carries
  an `unreadSince` stamp). The block shows today's aggregate token total
  (input + output + cache-creation + cache-read across every agent the local
  `agentsview` helper reports, on the America/Los_Angeles calendar day), plus
  rolling tokens/hour and tokens/10-minute rates differenced from the
  daemon-recorded cumulative-sample ring, with trend arrows against the
  previous equal-width window (↑ green `#4ADE80`, ↓ red `#FF4D67`, → neutral
  `#94A3B8`; deadband the larger of 1,000 tokens or 10% of the previous
  window). Data comes from `token-usage-snapshot.json` via the
  `read_token_usage_snapshot` Tauri command — a separate file with its own
  `schemaVersion`, never the session snapshot. A failed poll keeps last-good
  numbers dimmed; a missing file or a never-successful collector hides the
  block.
```

- [ ] **Step 2: Update `AGENTS.md`**

In the Conventions section, in the long strip paragraph after the quota-panel
sentences (ending "...renders from the pure view-model in `app/src/quota.ts`"),
add:

```markdown
  A token-usage block ships in the rail in place of the old clock: the
  daemon's token-usage collector (`src/core/token-usage.ts`, started from
  `cli.ts`, 30s cadence, 15s run timeout) shells out to the local
  `agentsview` helper (`AGENTSVIEW_BIN` override, else /opt/homebrew/bin,
  else PATH) for the America/Los_Angeles day's cumulative total — input +
  output + cacheCreation + cacheRead across all agents — keeps a 288-sample
  ring (~2.4h), and publishes `token-usage-snapshot.json` (own
  `schemaVersion`; contract in `src/token-usage-snapshot.ts`); the strip
  reads it through the `read_token_usage_snapshot` Tauri command and renders
  today's total plus rolling /hr and /10m rates with trend arrows
  (deadband max(1000, 10% of the previous window)) from the pure view-model
  in `app/src/token-usage.ts`. agentsview output is never logged or
  persisted.
```

- [ ] **Step 3: Run the full gate**

Run: `bun run check`
Expected: `biome ci .` clean, build succeeds, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add docs/design.md AGENTS.md
git commit -m "docs: document the rail token-usage block"
```

---

## Deploy (manual, after the plan lands)

Core daemon changes deploy with `bun scripts/install-local.ts` (full reinstall: daemon, plist, packaged plugin). The strip app deploys with `bun run bundle:app` then `bun run install:app`. Verify on the device: the rail shows the three-line token block in place of the clock; `token-usage-snapshot.json` appears in `~/Library/Application Support/com.drewritter.stream-deck-agents/` within ~30s of daemon start.
