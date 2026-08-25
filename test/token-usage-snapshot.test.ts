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

  const curves = {
    today: {
      providerDay: "2026-08-25",
      points: [
        { fetchedAt: "2026-08-25T15:00:00.000Z", totalTokens: 10 },
        { fetchedAt: "2026-08-25T15:00:30.000Z", totalTokens: 20 },
      ],
    },
    yesterday: { providerDay: "2026-08-24", points: [{ fetchedAt: "2026-08-24T20:00:00.000Z", totalTokens: 5 }] },
  };

  test("accepts a snapshot with dayCurves and preserves them", () => {
    const parsed = parseTokenUsageSnapshot({ ...snapshot(), dayCurves: curves });
    expect(parsed.dayCurves).toEqual(curves);
  });

  test("a snapshot without dayCurves stays legal (old daemon)", () => {
    expect(parseTokenUsageSnapshot(snapshot()).dayCurves).toBeUndefined();
  });

  test("an old reader's behavior: unknown top-level keys are still ignored", () => {
    expect(() => parseTokenUsageSnapshot({ ...snapshot(), someFutureKey: 1 })).not.toThrow();
  });

  test("rejects malformed dayCurves: out-of-order times, decreasing totals, oversize, bad day", () => {
    const bad = (dayCurves: unknown) => () => parseTokenUsageSnapshot({ ...snapshot(), dayCurves });
    expect(
      bad({
        today: { providerDay: "2026-08-25", points: [curves.today.points[1], curves.today.points[0]] },
        yesterday: null,
      }),
    ).toThrow();
    expect(
      bad({
        today: {
          providerDay: "2026-08-25",
          points: [
            { fetchedAt: "2026-08-25T15:00:00.000Z", totalTokens: 20 },
            { fetchedAt: "2026-08-25T15:00:30.000Z", totalTokens: 10 },
          ],
        },
        yesterday: null,
      }),
    ).toThrow();
    const oversized = Array.from({ length: 97 }, (_, i) => ({
      fetchedAt: new Date(Date.UTC(2026, 7, 25, 10, 0, i)).toISOString(),
      totalTokens: i,
    }));
    expect(bad({ today: { providerDay: "2026-08-25", points: oversized }, yesterday: null })).toThrow();
    expect(bad({ today: { providerDay: "2026-13-99", points: [] }, yesterday: null })).toThrow();
  });
});
