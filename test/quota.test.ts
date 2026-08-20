import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagnosticRecord } from "../src/core/diagnostics";
import {
  createQuotaCollector,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  parseClaudeCredentials,
  parseCodexAuth,
  QUOTA_POLL_INTERVAL_MS,
  QUOTA_RATE_LIMIT_COOLDOWN_MS,
  type QuotaCollectorDependencies,
  type QuotaFetch,
} from "../src/core/quota";
import { parseQuotaSnapshot } from "../src/quota-snapshot";

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

  test("an out-of-range primary reset_at degrades to null instead of throwing", () => {
    const body = JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: Number.MAX_VALUE },
        secondary_window: { used_percent: 25, reset_at: 1_787_616_000 },
      },
    });
    expect(normalizeCodexUsage(body)).toEqual({
      session: { percentRemaining: 90, resetAt: null },
      weekly: { percentRemaining: 75, resetAt: new Date(1_787_616_000 * 1000).toISOString() },
    });
  });

  test("an out-of-range secondary reset_at degrades to null instead of throwing", () => {
    const body = JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: 1_787_169_600 },
        secondary_window: { used_percent: 25, reset_at: 1e300 },
      },
    });
    expect(normalizeCodexUsage(body)).toEqual({
      session: { percentRemaining: 90, resetAt: new Date(1_787_169_600 * 1000).toISOString() },
      weekly: { percentRemaining: 75, resetAt: null },
    });
  });
});

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

  test("a cold-start failure emits quota_failed once per provider, not per pass, and again after recovery", async () => {
    const harness = makeHarness(credsFiles());
    const collector = createQuotaCollector(harness.deps);
    const failures = () => harness.diagnostics.filter((record) => record.code === "quota_failed");
    harness.fail();
    await collector.pollNow(); // first pass from cold start
    await collector.pollNow(); // repeated failure — no new records
    expect(failures().length).toBe(2);
    expect(new Set(failures().map((record) => record.provider))).toEqual(new Set(["claude", "codex"]));
    harness.respond(200, "{}"); // recovery; the "{}" body falls back to the fixtures
    await collector.pollNow();
    expect(failures().length).toBe(2); // success emits nothing
    harness.fail();
    await collector.pollNow(); // recovery → failure is a new transition
    expect(failures().length).toBe(4);
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

  test("a second 429 after cooldown expiry re-arms the cooldown", async () => {
    let clockMs = NOW_MS;
    const harness = makeHarness(credsFiles(), { nowMs: () => clockMs });
    const collector = createQuotaCollector(harness.deps);
    harness.respond(429, "rate limited");
    await collector.pollNow();
    expect(harness.fetches.length).toBe(2); // both providers 429 and arm their cooldowns
    clockMs += QUOTA_RATE_LIMIT_COOLDOWN_MS + 1; // cooldown expires
    await collector.pollNow();
    expect(harness.fetches.length).toBe(4); // a real fetch, which 429s again — re-armed
    await collector.pollNow();
    expect(harness.fetches.length).toBe(4); // suppressed by the new cooldown
  });

  test("concurrent pollNow calls collapse into one pass", async () => {
    const harness = makeHarness(credsFiles());
    const collector = createQuotaCollector(harness.deps);
    await Promise.all([collector.pollNow(), collector.pollNow()]);
    expect(harness.fetches.length).toBe(2);
  });

  test("start is idempotent, stop disarms the one interval, and start-after-stop works", () => {
    const armed: number[] = [];
    const disarmed: number[] = [];
    let nextHandle = 0;
    const harness = makeHarness(credsFiles(), {
      schedule: (_tick, intervalMs) => {
        const handle = ++nextHandle;
        armed.push(handle);
        expect(intervalMs).toBe(QUOTA_POLL_INTERVAL_MS);
        return () => {
          disarmed.push(handle);
        };
      },
    });
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

  test("an unexpected poll rejection is contained at both detached call sites with one fixed diagnostic", async () => {
    const ticks: Array<() => void> = [];
    const harness = makeHarness(credsFiles(), {
      // A throwing reader escapes probe's failure mapping, so the whole pass
      // rejects — the exact shape the detached call sites must contain.
      readFile: (path) => {
        if (path === claudeCredsPath) {
          throw new Error("credentials read exploded");
        }
        return credsFiles()[path] ?? null;
      },
      schedule: (tick) => {
        ticks.push(tick);
        return () => {};
      },
    });
    const collector = createQuotaCollector(harness.deps);
    collector.start(); // the immediate detached poll
    await new Promise((resolve) => setTimeout(resolve, 0));
    const scheduledTick = ticks[0];
    if (scheduledTick === undefined) {
      throw new Error("schedule was never armed");
    }
    scheduledTick(); // the scheduled detached poll
    await new Promise((resolve) => setTimeout(resolve, 0));
    collector.stop();
    const passFailures = harness.diagnostics.filter(
      (record) => record.code === "quota_failed" && record.provider === undefined,
    );
    expect(passFailures.length).toBe(2);
    for (const record of passFailures) {
      expect(Object.keys(record).sort()).toEqual(["code", "component", "timestamp"]);
    }
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
