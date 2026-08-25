import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ProviderQuota,
  parseQuotaSnapshot,
  QUOTA_EXTRA_WINDOWS_LIMIT,
  QUOTA_HISTORY_LIMIT,
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
  extraWindows: [],
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
    const parsed = parseQuotaSnapshot({
      schemaVersion: 1,
      providers: { futureprovider: claudeQuota(), claude: claudeQuota() },
    });
    expect(parsed.providers["claude"]).toEqual(claudeQuota());
    expect(Object.keys(parsed.providers)).toEqual(["claude"]);
  });

  test("parses the kimi, zai, and qwen provider keys", () => {
    const parsed = parseQuotaSnapshot({
      schemaVersion: 1,
      providers: { kimi: claudeQuota(), zai: claudeQuota(), qwen: claudeQuota() },
    });
    expect(parsed.providers["kimi"]).toEqual(claudeQuota());
    expect(parsed.providers["zai"]).toEqual(claudeQuota());
    expect(parsed.providers["qwen"]).toEqual(claudeQuota());
  });

  test("rejects a non-object, a wrong schemaVersion, and a non-object providers", () => {
    expect(() => parseQuotaSnapshot(null)).toThrow("invalid quota snapshot");
    expect(() => parseQuotaSnapshot({ schemaVersion: 3, providers: {} })).toThrow("schemaVersion must be 1 or 2");
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

  test("rejects instants that are not canonical UTC ISO even though Date.parse accepts them", () => {
    const badResetAt = (resetAt: string): unknown => ({
      schemaVersion: 1,
      providers: { claude: { ...claudeQuota(), resetAt } },
    });
    // Nonexistent date (Date.parse rolls it over to March 2).
    expect(() => parseQuotaSnapshot(badResetAt("2026-02-30T00:00:00.000Z"))).toThrow("resetAt");
    // Date-only form.
    expect(() => parseQuotaSnapshot(badResetAt("2026-08-19"))).toThrow("resetAt");
    // Valid instant, but milliseconds omitted — not the canonical shape.
    expect(() => parseQuotaSnapshot(badResetAt("2026-08-19T22:00:00Z"))).toThrow("resetAt");
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

  describe("extraWindows", () => {
    const fable = {
      id: "claude-weekly-scoped-fable",
      label: "Fable only",
      percentRemaining: 99,
      resetAt: "2026-08-28T01:00:00.000Z",
    };

    test("v1 providers default to no extra windows", () => {
      const parsed = parseQuotaSnapshot({ schemaVersion: 1, providers: { claude: claudeQuota() } });
      expect(parsed.providers["claude"]?.extraWindows).toEqual([]);
    });

    test("v2 round-trips extra windows", () => {
      const withExtras = { ...claudeQuota(), extraWindows: [fable] };
      const parsed = parseQuotaSnapshot({ schemaVersion: 2, providers: { claude: withExtras } });
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.providers["claude"]).toEqual(withExtras);
    });

    test("v2 requires the extraWindows array and bounds it", () => {
      const missing = {
        schemaVersion: 2,
        providers: { claude: { ...claudeQuota(), extraWindows: undefined as unknown as [] } },
      };
      expect(() => parseQuotaSnapshot(missing)).toThrow("extraWindows");
      const over = {
        schemaVersion: 2,
        providers: {
          claude: {
            ...claudeQuota(),
            extraWindows: Array.from({ length: QUOTA_EXTRA_WINDOWS_LIMIT + 1 }, () => fable),
          },
        },
      };
      expect(() => parseQuotaSnapshot(over)).toThrow("extraWindows");
    });

    test("rejects extras with bad percents, instants, or empty id/label", () => {
      const bad = (extra: unknown): unknown => ({
        schemaVersion: 2,
        providers: { claude: { ...claudeQuota(), extraWindows: [extra] } },
      });
      expect(() => parseQuotaSnapshot(bad({ ...fable, percentRemaining: 101 }))).toThrow("percentRemaining");
      expect(() => parseQuotaSnapshot(bad({ ...fable, resetAt: "soon" }))).toThrow("resetAt");
      expect(() => parseQuotaSnapshot(bad({ ...fable, id: "" }))).toThrow("id");
      expect(() => parseQuotaSnapshot(bad({ ...fable, label: "" }))).toThrow("label");
      expect(() => parseQuotaSnapshot(bad("fable"))).toThrow("extra window");
    });
  });
});
