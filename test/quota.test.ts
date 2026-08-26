import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeSwapAccounts } from "../src/core/claude-swap-quota";
import type { DiagnosticRecord } from "../src/core/diagnostics";
import {
  CODEXBAR_BINARY_CANDIDATES,
  CODEXBAR_PROVIDER_ARGS,
  createQuotaCollector,
  QUOTA_POLL_INTERVAL_MS,
  type QuotaCollectorDependencies,
  type QuotaExec,
} from "../src/core/quota";
import { parseQuotaSnapshot } from "../src/quota-snapshot";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "quota", name), "utf8");

const NOW = "2026-08-19T18:00:00.000Z";

const widgetSnapshot = (generatedAt: string): string =>
  JSON.stringify({
    generatedAt,
    entries: [
      {
        provider: "alibabatokenplan",
        primary: null,
        secondary: { windowMinutes: 10080, usedPercent: 55, resetsAt: "2026-08-27T21:36:00Z" },
        tertiary: null,
      },
    ],
  });

// Keyed by the CodexBar --provider argument the collector spawns (qwen maps to alibabatokenplan).
const FIXTURE_BY_PROVIDER: Record<string, string> = {
  claude: "codexbar-claude.json",
  codex: "codexbar-codex.json",
  kimi: "codexbar-kimi.json",
  zai: "codexbar-zai.json",
  alibabatokenplan: "codexbar-qwen.json",
};
const ALL_PROVIDERS = ["claude", "codex", "kimi", "zai", "qwen"] as const;

describe("createQuotaCollector", () => {
  let tempDir: string;
  let quotaPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dealerboard-quota-"));
    quotaPath = join(tempDir, "quota-snapshot.json");
  });

  // The widget fallback must never read the real machine's CodexBar snapshot.
  const widgetPath = (dir: string): string => join(dir, "widget-snapshot.json");

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  type RawResponse = { exitCode: number; stdout: string };

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

  const makeHarness = (
    options: { binaryPresent?: boolean; claudeSwapBinaryPresent?: boolean; files?: Record<string, string> } = {},
    overrides: Partial<QuotaCollectorDependencies> = {},
  ): Harness => {
    const calls: string[][] = [];
    const claudeSwapCalls: string[][] = [];
    const claudeSwapTimeouts: number[] = [];
    const diagnostics: DiagnosticRecord[] = [];
    const writes: string[] = [];
    const failures = new Set<string>();
    const omissions = new Set<string>();
    const raw = new Map<string, RawResponse>();
    let claudeSwapFailed = false;
    let claudeSwapBody = fixture("claude-swap-accounts.json");
    // Harness controls (fail/heal/omit/respondRaw) speak contract keys; the
    // spawn args carry CodexBar's --provider argument (qwen ≠ alibabatokenplan).
    const contractKeyByArg: Record<string, string> = Object.fromEntries(
      Object.entries(CODEXBAR_PROVIDER_ARGS).map(([key, arg]) => [arg, key]),
    );
    const execSpy: QuotaExec = (args) => {
      calls.push(args);
      const arg = args[2] ?? "";
      const provider = contractKeyByArg[arg] ?? arg;
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
      const name = FIXTURE_BY_PROVIDER[arg];
      return Promise.resolve({ exitCode: 0, stdout: name === undefined ? "[]" : fixture(name) });
    };
    const claudeSwapExec: QuotaExec = (args, timeoutMs) => {
      claudeSwapCalls.push(args);
      claudeSwapTimeouts.push(timeoutMs);
      return Promise.resolve(
        claudeSwapFailed ? { exitCode: 1, stdout: "private failure text" } : { exitCode: 0, stdout: claudeSwapBody },
      );
    };
    const binaryPresent = options.binaryPresent ?? true;
    const claudeSwapBinaryPresent = options.claudeSwapBinaryPresent ?? true;
    const deps: QuotaCollectorDependencies = {
      quotaSnapshotPath: quotaPath,
      widgetSnapshotPath: widgetPath(tempDir),
      fileExists: (path) => (path.endsWith("/cswap") ? claudeSwapBinaryPresent : binaryPresent),
      // No binary → no injected exec either: resolution must report "absent"
      // without ever spawning.
      ...(binaryPresent ? { exec: execSpy } : {}),
      ...(claudeSwapBinaryPresent ? { claudeSwapExec } : {}),
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
      writes: () => writes,
    };
  };

  test("publishes all five providers in contract order after successful runs", async () => {
    const harness = makeHarness();
    await createQuotaCollector(harness.deps).pollNow();
    const writes = harness.writes();
    expect(writes.length).toBe(1);
    const snapshot = parseQuotaSnapshot(JSON.parse(writes[0] ?? ""));
    expect(Object.keys(snapshot.providers)).toEqual([...ALL_PROVIDERS]);
    expect(snapshot.providers["claude"]).toMatchObject({
      percentRemaining: 98,
      weeklyPercentRemaining: 37,
      unavailable: false,
      fetchedAt: NOW,
    });
    expect(snapshot.providers["claude"]?.history).toEqual([{ fetchedAt: NOW, fractionRemaining: 0.98 }]);
    expect(snapshot.providers["codex"]).toMatchObject({ percentRemaining: 60, weeklyPercentRemaining: 75 });
    expect(snapshot.providers["kimi"]).toMatchObject({ percentRemaining: 84, weeklyPercentRemaining: 88 });
    expect(snapshot.providers["zai"]?.percentRemaining).toBe(100 - 6.833333333333333);
    expect(snapshot.providers["zai"]?.weeklyPercentRemaining).toBe(100 - 56.364999999999995);
    expect(snapshot.providers["qwen"]).toMatchObject({ percentRemaining: 60, weeklyPercentRemaining: 90 });
    expect(harness.calls).toEqual(
      [...ALL_PROVIDERS].map((provider) => [
        "usage",
        "--provider",
        CODEXBAR_PROVIDER_ARGS[provider],
        "--format",
        "json",
        "--log-level",
        "critical",
      ]),
    );
    expect(harness.claudeSwapCalls).toEqual([["list", "--json"]]);
    expect(harness.claudeSwapTimeouts).toEqual([5_000]);
    expect(snapshot.providers["claude"]?.accounts.map((account) => account.id)).toEqual([
      "claude-swap:1",
      "claude-swap:2",
    ]);
    expect(writes.join("\n")).not.toContain("@example.invalid");
    expect(writes.join("\n")).not.toContain("Ignored Corp");
  });

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

  test("preserves last-good accounts and logs only healthy-to-failed transitions", async () => {
    const harness = makeHarness();
    const collector = createQuotaCollector(harness.deps);
    await collector.pollNow();
    harness.failClaudeSwap();
    await collector.pollNow();
    await collector.pollNow();
    const claude = parseQuotaSnapshot(JSON.parse(harness.writes().at(-1) ?? "")).providers["claude"];
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

  test("account subprocess errors stay payload-free in diagnostics", async () => {
    const harness = makeHarness(
      {},
      {
        claudeSwapExec: async () => {
          throw new Error("private caught failure text");
        },
      },
    );
    await createQuotaCollector(harness.deps).pollNow();
    expect(harness.diagnostics.filter((record) => record.code === "quota_accounts_failed")).toHaveLength(1);
    expect(JSON.stringify(harness.diagnostics)).not.toContain("private caught failure text");
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
    expect(failures().length).toBe(5);
    expect(new Set(failures().map((record) => record.provider))).toEqual(new Set(ALL_PROVIDERS));
    harness.heal(...ALL_PROVIDERS);
    await collector.pollNow(); // recovery emits nothing
    expect(failures().length).toBe(5);
    harness.fail(...ALL_PROVIDERS);
    await collector.pollNow(); // recovery → failure is a new transition
    expect(failures().length).toBe(10);
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
    const harness = makeHarness({ binaryPresent: false, claudeSwapBinaryPresent: false });
    await createQuotaCollector(harness.deps).pollNow();
    expect(harness.calls.length).toBe(0);
    expect(harness.claudeSwapCalls.length).toBe(0);
    expect(parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? "")).providers).toEqual({});
  });

  test("a provider disabled in CodexBar (empty array) is omitted while the rest publish", async () => {
    const harness = makeHarness();
    harness.omit("kimi");
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(Object.keys(snapshot.providers)).toEqual(["claude", "codex", "zai", "qwen"]);
  });

  test("the widget snapshot rescues a provider whose CLI probe fails", async () => {
    const harness = makeHarness({
      files: { [widgetPath(tempDir)]: widgetSnapshot("2026-08-19T17:50:00.000Z") },
    });
    harness.fail("qwen");
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["qwen"]).toMatchObject({
      percentRemaining: null,
      weeklyPercentRemaining: 45,
      weeklyResetAt: "2026-08-27T21:36:00.000Z",
      unavailable: false,
    });
    expect(harness.diagnostics.filter((record) => record.code === "quota_failed")).toEqual([]);
  });

  test("the widget snapshot also rescues a provider the CLI reports absent", async () => {
    const harness = makeHarness({
      files: { [widgetPath(tempDir)]: widgetSnapshot("2026-08-19T17:50:00.000Z") },
    });
    harness.omit("qwen");
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["qwen"]?.weeklyPercentRemaining).toBe(45);
  });

  test("a stale widget snapshot does not rescue a failed probe", async () => {
    const harness = makeHarness({
      files: { [widgetPath(tempDir)]: widgetSnapshot("2026-08-19T16:00:00.000Z") },
    });
    harness.fail("qwen");
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["qwen"]).toMatchObject({ unavailable: true });
  });

  test("a successful CLI probe wins over the widget snapshot", async () => {
    const harness = makeHarness({
      files: { [widgetPath(tempDir)]: widgetSnapshot("2026-08-19T17:50:00.000Z") },
    });
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    // The qwen fixture carries session 60 / weekly 90; the widget says weekly 45.
    expect(snapshot.providers["qwen"]).toMatchObject({ percentRemaining: 60, weeklyPercentRemaining: 90 });
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
    expect(harness.calls.length).toBe(5);
    expect(harness.claudeSwapCalls).toEqual([["list", "--json"]]);
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

  test("extra rate windows publish with provider-stripped labels; selected windows stay out", async () => {
    const harness = makeHarness();
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["claude"]?.extraWindows).toEqual([
      {
        id: "claude-weekly-scoped-fable",
        label: "Fable only",
        percentRemaining: 99,
        resetAt: "2026-08-28T01:00:00.000Z",
      },
    ]);
    // Codex's Spark 5-hour is selected as its session window; only Spark Weekly publishes.
    expect(snapshot.providers["codex"]?.extraWindows).toEqual([
      { id: "codex-spark-weekly", label: "Spark Weekly", percentRemaining: 90, resetAt: "2026-08-27T06:04:44.000Z" },
    ]);
    expect(snapshot.providers["kimi"]?.extraWindows).toEqual([]);
  });

  test("the widget snapshot rescue publishes no extra windows", async () => {
    const harness = makeHarness({
      files: { [widgetPath(tempDir)]: widgetSnapshot("2026-08-19T17:50:00.000Z") },
    });
    harness.fail("qwen");
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["qwen"]?.extraWindows).toEqual([]);
  });

  test("extra labels cap at 14 code points and unnamed extras drop", async () => {
    const harness = makeHarness();
    harness.respondRaw("kimi", {
      exitCode: 0,
      stdout: JSON.stringify([
        {
          provider: "kimi",
          usage: {
            primary: { windowMinutes: 300, usedPercent: 16, resetsAt: "2026-08-19T19:00:00Z" },
            secondary: { windowMinutes: 10080, usedPercent: 12, resetsAt: "2026-08-26T18:00:00Z" },
            tertiary: null,
            extraRateWindows: [
              {
                id: "kimi-bonus",
                title: "Kimi Bonus Context Window",
                window: { windowMinutes: 1440, usedPercent: 50, resetsAt: "2026-08-20T18:00:00Z" },
              },
              { window: { windowMinutes: 1440, usedPercent: 10, resetsAt: null } },
            ],
          },
        },
      ]),
    });
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["kimi"]?.extraWindows).toEqual([
      { id: "kimi-bonus", label: "Bonus Context…", percentRemaining: 50, resetAt: "2026-08-20T18:00:00.000Z" },
    ]);
  });

  test("an extra label whose cut lands mid-word is 14 code points including the ellipsis", async () => {
    const harness = makeHarness();
    harness.respondRaw("kimi", {
      exitCode: 0,
      stdout: JSON.stringify([
        {
          provider: "kimi",
          usage: {
            primary: { windowMinutes: 300, usedPercent: 16, resetsAt: "2026-08-19T19:00:00Z" },
            secondary: { windowMinutes: 10080, usedPercent: 12, resetsAt: "2026-08-26T18:00:00Z" },
            tertiary: null,
            extraRateWindows: [
              {
                id: "kimi-long",
                title: "Kimi LongBonusWindow",
                window: { windowMinutes: 1440, usedPercent: 50, resetsAt: "2026-08-20T18:00:00Z" },
              },
            ],
          },
        },
      ]),
    });
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    // "LongBonusWindow" has no whitespace at the 14th code point — the ellipsis must be the 14th.
    const label = snapshot.providers["kimi"]?.extraWindows[0]?.label ?? "";
    expect(label).toBe("LongBonusWind…");
    expect([...label].length).toBe(14);
  });
});
