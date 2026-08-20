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

  test("a malformed daily entry is a failed poll, never a legitimate zero", () => {
    expect(normalizeAgentsviewDaily(JSON.stringify({ schema_version: 4, daily: [null] }), DAY)).toBeNull();
    expect(normalizeAgentsviewDaily(JSON.stringify({ schema_version: 4, daily: [{ date: 123 }] }), DAY)).toBeNull();
    expect(
      normalizeAgentsviewDaily(JSON.stringify({ schema_version: 4, daily: [{ date: "garbage" }] }), DAY),
    ).toBeNull();
  });

  test("a valid non-matching row is skipped without field validation", () => {
    const foreign = JSON.stringify({ schema_version: 4, daily: [{ date: "2026-08-19", inputTokens: "junk" }] });
    expect(normalizeAgentsviewDaily(foreign, DAY)).toBe(0);
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
    await collector.pollNow(); // a cold failure never logs — there was no good state to leave
    const cold = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(cold).toMatchObject({ totalTokens: 0, unavailable: true, fetchedAt: null, samples: [] });
    expect(harness.diagnostics.filter((record) => record.code === "token_usage_failed").length).toBe(0);
    harness.respond(FULL);
    await collector.pollNow();
    const recovered = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(recovered).toMatchObject({ totalTokens: 1000, unavailable: false, fetchedAt: NOW });
    harness.fail();
    await collector.pollNow();
    const failures = harness.diagnostics.filter((record) => record.code === "token_usage_failed");
    expect(failures.length).toBe(1); // the first good→failed transition only
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
