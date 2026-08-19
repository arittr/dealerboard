import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ProviderQuota, parseQuotaSnapshot, QUOTA_HISTORY_LIMIT, type QuotaSnapshot } from "../src/quota-snapshot";

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
    expect(() => parseQuotaSnapshot(bad({ weeklyPercentRemaining: "88" as unknown as number }))).toThrow(
      "weeklyPercentRemaining",
    );
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
