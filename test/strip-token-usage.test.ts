import { describe, expect, test } from "bun:test";
import {
  formatTokensCompact,
  laDayBoundsMs,
  reduceSparkline,
  reduceTokenUsageRead,
  SPARKLINE_VIEWBOX,
  STALE_TOKEN_USAGE_AGE_MS,
  sparklineEndpoint,
  sparklineFillPoints,
  sparklinePolylinePoints,
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

  test("warm-up windows report flat trends until the previous window is covered by real samples", () => {
    // ~5 minutes of 30s samples, +2k per sample: with no sample at/before the
    // previous window's start, its rate computes as ~0 and a busy partial
    // current window would read as a false "up" — the spec says flat.
    const samples: TokenUsageSample[] = [];
    let total = 0;
    for (let index = 0; index <= 10; index += 1) {
      total += 2000;
      samples.push(sampleAt(NOW - (10 - index) * 30_000, total));
    }
    const model = reduceTokenUsageRead(read(snapshot({ totalTokens: total, samples })), NOW);
    if (model.state === "hidden") {
      throw new Error("expected a rendered model");
    }
    expect(model.tenMin.trend).toBe("flat");
    expect(model.hour.trend).toBe("flat");
  });

  test("a sample exactly at the previous window's start counts as coverage", () => {
    // The first sample sits at anchor − 2×10m exactly: the guard's ≤ keeps
    // the trend computed, and the clearly rising series reads "up".
    const samples = [sampleAt(NOW - 20 * 60_000, 0), sampleAt(NOW - 10 * 60_000, 2000), sampleAt(NOW, 20_000)];
    const model = reduceTokenUsageRead(read(snapshot({ totalTokens: 20_000, samples })), NOW);
    if (model.state === "hidden") {
      throw new Error("expected a rendered model");
    }
    expect(model.tenMin.trend).toBe("up");
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

describe("laDayBoundsMs", () => {
  test("a standard LA day is 24h (UTC-7 in August)", () => {
    const bounds = laDayBoundsMs("2026-08-25");
    expect(bounds.startMs).toBe(Date.parse("2026-08-25T07:00:00.000Z"));
    expect(bounds.endMs - bounds.startMs).toBe(24 * 3_600_000);
  });

  test("DST days are 23h (spring forward) and 25h (fall back)", () => {
    const spring = laDayBoundsMs("2026-03-08");
    expect(spring.endMs - spring.startMs).toBe(23 * 3_600_000);
    const fall = laDayBoundsMs("2026-11-01");
    expect(fall.endMs - fall.startMs).toBe(25 * 3_600_000);
  });
});

describe("reduceSparkline", () => {
  const snapshotWith = (dayCurves: unknown) => ({ ...snapshot(), dayCurves }) as never;

  test("no curves → no sparkline; empty today with no yesterday → no sparkline", () => {
    expect(reduceSparkline(snapshot())).toBeNull();
    expect(
      reduceSparkline(snapshotWith({ today: { providerDay: "2026-08-25", points: [] }, yesterday: null })),
    ).toBeNull();
  });

  test("today normalizes x by elapsed day fraction and y by the shared max", () => {
    const model = reduceSparkline(
      snapshotWith({
        today: {
          providerDay: "2026-08-25",
          points: [
            { fetchedAt: "2026-08-25T07:00:00.000Z", totalTokens: 0 },
            { fetchedAt: "2026-08-25T19:00:00.000Z", totalTokens: 50 },
          ],
        },
        yesterday: {
          providerDay: "2026-08-24",
          points: [{ fetchedAt: "2026-08-25T06:00:00.000Z", totalTokens: 100 }],
        },
      }),
    );
    expect(model).not.toBeNull();
    expect(model?.today.points.at(-1)?.x).toBeCloseTo(0.5, 5); // noon of a 24h day
    expect(model?.today.points.at(-1)?.y).toBeCloseTo(0.5, 5); // shared max is yesterday's 100
    expect(model?.yesterday?.label).toBe("yda 100");
  });

  test("a non-adjacent yesterday is dropped from the model", () => {
    const model = reduceSparkline(
      snapshotWith({
        today: { providerDay: "2026-08-25", points: [{ fetchedAt: "2026-08-25T07:00:00.000Z", totalTokens: 10 }] },
        yesterday: { providerDay: "2026-08-22", points: [{ fetchedAt: "2026-08-22T08:00:00.000Z", totalTokens: 99 }] },
      }),
    );
    expect(model?.yesterday).toBeNull();
  });
});

describe("sparkline SVG geometry", () => {
  test("polyline points map to d6's 436x80 viewBox: x*436, baseline 70 minus y*66", () => {
    expect(
      sparklinePolylinePoints([
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ]),
    ).toBe("0.00,70.00 218.00,37.00 436.00,4.00");
  });

  test("fill closes today's curve along the baseline at both ends; no points → null", () => {
    expect(
      sparklineFillPoints([
        { x: 0.25, y: 0 },
        { x: 0.75, y: 1 },
      ]),
    ).toBe("109.00,70.00 327.00,4.00 327.00,70.00 109.00,70.00");
    expect(sparklineFillPoints([])).toBeNull();
  });

  test("endpoint is the mapped last point; none when empty", () => {
    expect(
      sparklineEndpoint([
        { x: 0, y: 1 },
        { x: 0.5, y: 0.5 },
      ]),
    ).toEqual({ cx: 218, cy: 37 });
    expect(sparklineEndpoint([])).toBeNull();
  });

  test("the viewBox matches d6's 436x80 box", () => {
    expect(SPARKLINE_VIEWBOX).toEqual({ width: 436, height: 80 });
  });
});
