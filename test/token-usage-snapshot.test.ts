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

  test("rejects non-canonical instants, bad providerDay strings, and impossible calendar dates", () => {
    expect(() => parseTokenUsageSnapshot(snapshot({ fetchedAt: "2026-08-20" }))).toThrow("fetchedAt");
    expect(() => parseTokenUsageSnapshot(snapshot({ providerDay: "08/20/2026" }))).toThrow("providerDay");
    expect(() => parseTokenUsageSnapshot(snapshot({ samples: [sample({ fetchedAt: "yesterday" })] }))).toThrow(
      "fetchedAt",
    );
    expect(() => parseTokenUsageSnapshot(snapshot({ providerDay: "2026-02-30" }))).toThrow("providerDay");
    expect(() => parseTokenUsageSnapshot(snapshot({ samples: [sample({ providerDay: "2026-02-30" })] }))).toThrow(
      "providerDay",
    );
    expect(() => parseTokenUsageSnapshot(snapshot({ samples: [sample({ providerDay: "2028-02-29" })] }))).not.toThrow();
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
