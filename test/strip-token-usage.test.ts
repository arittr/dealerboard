import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_BOUNDARY_MAX_AGE_MS,
  formatTokensCompact,
  type HourlyActivityBucket,
  laDayBoundsMs,
  reduceSparkline,
  reduceTokenActivity,
  reduceTokenUsageRead,
  SPARKLINE_VIEWBOX,
  STALE_TOKEN_USAGE_AGE_MS,
  sparklineEndpoint,
  sparklineFillPoints,
  sparklinePolylinePoints,
  TOKEN_ACTIVITY_TIME_LABELS,
  TOKEN_ACTIVITY_VIEWBOX,
  tokenActivityBarRects,
  tokenActivityLineEndpoint,
  tokenActivityLineSegments,
} from "../app/src/token-usage";
import type { TokenUsageDayCurve, TokenUsageSample, TokenUsageSnapshot } from "../src/token-usage-snapshot";

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
  test("formats compactly with one decimal, .0 stripped, and k/M/B suffixes", () => {
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

const curve = (providerDay: string, points: Array<[string, number]>): TokenUsageDayCurve => ({
  providerDay,
  points: points.map(([fetchedAt, totalTokens]) => ({ fetchedAt, totalTokens })),
});

const measured = (hour: number, tokens: number) => ({ hour, state: "measured" as const, tokens });
const absent = (hour: number, state: "future" | "unmeasured" | "nonexistent") => ({
  hour,
  state,
  tokens: null,
});

describe("reduceTokenActivity", () => {
  test("differences today and adjacent yesterday by LA clock hour and marks the partial current hour", () => {
    const today = curve(DAY, [
      ["2026-08-20T07:00:00.000Z", 0], // LA midnight
      ["2026-08-20T08:00:00.000Z", 10],
      ["2026-08-20T09:00:00.000Z", 30],
      ["2026-08-20T18:00:00.000Z", 80], // 11:00
      ["2026-08-20T18:30:00.000Z", 100],
    ]);
    const yesterday = curve("2026-08-19", [
      ["2026-08-19T07:00:00.000Z", 0],
      ["2026-08-19T08:00:00.000Z", 5],
      ["2026-08-19T09:00:00.000Z", 20],
    ]);

    const activity = reduceTokenActivity(snapshot({ dayCurves: { today, yesterday } }));

    expect(activity?.today).toHaveLength(24);
    expect(activity?.today[0]).toEqual(measured(0, 10));
    expect(activity?.today[1]).toEqual(measured(1, 20));
    expect(activity?.today[2]).toEqual(absent(2, "unmeasured"));
    expect(activity?.today[11]).toEqual({ hour: 11, state: "current", tokens: 20 });
    expect(activity?.today[12]).toEqual(absent(12, "future"));
    expect(activity?.yesterday?.slice(0, 3)).toEqual([measured(0, 5), measured(1, 15), absent(2, "unmeasured")]);
    expect(activity?.yMax).toBe(20);
  });

  test("accepts a boundary observation at 30 minutes old and rejects one at 30 minutes plus one millisecond", () => {
    expect(ACTIVITY_BOUNDARY_MAX_AGE_MS).toBe(30 * 60_000);
    const start = Date.parse("2026-08-20T07:00:00.000Z");
    const modelFor = (firstOffsetMs: number) =>
      reduceTokenActivity(
        snapshot({
          dayCurves: {
            today: curve(DAY, [
              [iso(start + firstOffsetMs), 10],
              [iso(start + 2 * 60 * 60_000), 30],
            ]),
            yesterday: null,
          },
        }),
      );

    expect(modelFor(30 * 60_000)?.today[0]).toEqual(measured(0, 10));
    expect(modelFor(30 * 60_000 - 1)?.today[0]).toEqual(absent(0, "unmeasured"));
  });

  test("does not interpolate across a collector gap", () => {
    const activity = reduceTokenActivity(
      snapshot({
        dayCurves: {
          today: curve(DAY, [
            ["2026-08-20T07:00:00.000Z", 0],
            ["2026-08-20T08:00:00.000Z", 10],
            ["2026-08-20T12:00:00.000Z", 90],
            ["2026-08-20T12:30:00.000Z", 100],
          ]),
          yesterday: null,
        },
      }),
    );

    expect(activity?.today[1]).toEqual(absent(1, "unmeasured"));
    expect(activity?.today[2]).toEqual(absent(2, "unmeasured"));
    expect(activity?.today[3]).toEqual(absent(3, "unmeasured"));
    expect(activity?.today[5]).toEqual({ hour: 5, state: "current", tokens: 10 });
  });

  test("drops non-adjacent and isolated yesterday overlays", () => {
    const today = curve(DAY, [
      ["2026-08-20T07:00:00.000Z", 0],
      ["2026-08-20T08:00:00.000Z", 10],
    ]);
    const nonAdjacent = reduceTokenActivity(
      snapshot({
        dayCurves: {
          today,
          yesterday: curve("2026-08-18", [
            ["2026-08-18T07:00:00.000Z", 0],
            ["2026-08-18T08:00:00.000Z", 5],
            ["2026-08-18T09:00:00.000Z", 10],
          ]),
        },
      }),
    );
    const isolated = reduceTokenActivity(
      snapshot({
        dayCurves: {
          today,
          yesterday: curve("2026-08-19", [
            ["2026-08-19T07:00:00.000Z", 0],
            ["2026-08-19T08:00:00.000Z", 5],
          ]),
        },
      }),
    );

    expect(nonAdjacent?.yesterday).toBeNull();
    expect(isolated?.yesterday).toBeNull();
  });

  test("keeps measured zero distinct and uses a finite one-token scale", () => {
    const activity = reduceTokenActivity(
      snapshot({
        dayCurves: {
          today: curve(DAY, [
            ["2026-08-20T07:00:00.000Z", 0],
            ["2026-08-20T08:00:00.000Z", 0],
            ["2026-08-20T08:30:00.000Z", 0],
          ]),
          yesterday: null,
        },
      }),
    );

    expect(activity?.today[0]).toEqual(measured(0, 0));
    expect(activity?.today[1]).toEqual({ hour: 1, state: "current", tokens: 0 });
    expect(activity?.today[2]).toEqual(absent(2, "future"));
    expect(activity?.yMax).toBe(1);
  });

  test("returns null without day curves or any reducible activity", () => {
    expect(reduceTokenActivity(snapshot())).toBeNull();
    expect(
      reduceTokenActivity(
        snapshot({
          dayCurves: { today: curve(DAY, [["2026-08-20T18:45:00.000Z", 50]]), yesterday: null },
        }),
      ),
    ).toBeNull();
  });

  test("spring DST leaves the nonexistent 02:00 clock position empty", () => {
    const activity = reduceTokenActivity(
      snapshot({
        providerDay: "2026-03-08",
        dayCurves: {
          today: curve("2026-03-08", [
            ["2026-03-08T08:00:00.000Z", 0], // 00:00 PST
            ["2026-03-08T09:00:00.000Z", 10], // 01:00 PST
            ["2026-03-08T10:00:00.000Z", 20], // 03:00 PDT
            ["2026-03-08T10:30:00.000Z", 25],
          ]),
          yesterday: null,
        },
      }),
    );

    expect(activity?.today[0]).toEqual(measured(0, 10));
    expect(activity?.today[1]).toEqual(measured(1, 10));
    expect(activity?.today[2]).toEqual(absent(2, "nonexistent"));
    expect(activity?.today[3]).toEqual({ hour: 3, state: "current", tokens: 5 });
  });

  test("fall DST folds both 01:00 intervals and rejects an incompletely measured fold", () => {
    const complete = reduceTokenActivity(
      snapshot({
        providerDay: "2026-11-01",
        dayCurves: {
          today: curve("2026-11-01", [
            ["2026-11-01T07:00:00.000Z", 0], // 00:00 PDT
            ["2026-11-01T08:00:00.000Z", 10], // first 01:00
            ["2026-11-01T09:00:00.000Z", 30], // second 01:00
            ["2026-11-01T10:00:00.000Z", 35], // 02:00 PST
            ["2026-11-01T10:30:00.000Z", 45],
          ]),
          yesterday: null,
        },
      }),
    );
    const incomplete = reduceTokenActivity(
      snapshot({
        providerDay: "2026-11-01",
        dayCurves: {
          today: curve("2026-11-01", [
            ["2026-11-01T07:00:00.000Z", 0],
            ["2026-11-01T08:00:00.000Z", 10],
            ["2026-11-01T10:00:00.000Z", 35],
            ["2026-11-01T10:30:00.000Z", 45],
          ]),
          yesterday: null,
        },
      }),
    );

    expect(complete?.today[1]).toEqual(measured(1, 25));
    expect(complete?.today[2]).toEqual({ hour: 2, state: "current", tokens: 10 });
    expect(incomplete?.today[1]).toEqual(absent(1, "unmeasured"));
  });
});

const activityBuckets = (
  values: Partial<Record<number, { state: "measured" | "current"; tokens: number }>>,
): HourlyActivityBucket[] =>
  Array.from({ length: 24 }, (_, hour) => {
    const value = values[hour];
    return value === undefined ? absent(hour, "unmeasured") : { hour, ...value };
  });

describe("token activity SVG geometry", () => {
  test("maps measured and current buckets into stable centered bar slots", () => {
    const bars = tokenActivityBarRects({
      today: activityBuckets({
        0: { state: "measured", tokens: 10 },
        1: { state: "current", tokens: 20 },
        2: { state: "measured", tokens: 0 },
      }),
      yesterday: null,
      yMax: 20,
    });

    expect(TOKEN_ACTIVITY_VIEWBOX).toEqual({ width: 500, height: 84 });
    expect(bars.map(({ hour, current }) => ({ hour, current }))).toEqual([
      { hour: 0, current: false },
      { hour: 1, current: true },
      { hour: 2, current: false },
    ]);
    expect(bars[0]?.height).toBeCloseTo(28, 5);
    expect(bars[1]?.height).toBeCloseTo(56, 5);
    expect(bars[2]?.height).toBe(0);
    expect(bars[0]?.x).toBeGreaterThanOrEqual(0);
    expect(bars[1]?.x).toBeGreaterThan(bars[0]?.x ?? 0);
  });

  test("future, unmeasured, and nonexistent today buckets emit no rectangle", () => {
    const today = Array.from(
      { length: 24 },
      (_, hour): HourlyActivityBucket =>
        absent(hour, hour === 0 ? "future" : hour === 1 ? "nonexistent" : "unmeasured"),
    );
    expect(tokenActivityBarRects({ today, yesterday: null, yMax: 1 })).toEqual([]);
  });

  test("splits yesterday at missing buckets and places points at slot centers", () => {
    const yesterday = activityBuckets({
      0: { state: "measured", tokens: 10 },
      1: { state: "measured", tokens: 20 },
      3: { state: "measured", tokens: 5 },
      4: { state: "measured", tokens: 15 },
    });
    const segments = tokenActivityLineSegments({
      today: Array.from({ length: 24 }, (_, hour) => absent(hour, "future")),
      yesterday,
      yMax: 20,
    });

    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.map((point) => point.hour))).toEqual([
      [0, 1],
      [3, 4],
    ]);
    expect(segments[0]?.[0]?.x).toBeCloseTo(500 / 48, 5);
    expect(segments[0]?.[1]?.y).toBe(4);
    expect(tokenActivityLineEndpoint(segments)).toEqual(segments[1]?.[1] ?? null);
  });

  test("publishes the fixed sparse time labels", () => {
    expect(TOKEN_ACTIVITY_TIME_LABELS).toEqual([
      { text: "12a", x: 0, anchor: "start" },
      { text: "12p", x: 250, anchor: "middle" },
      { text: "12a", x: 500, anchor: "end" },
    ]);
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
  test("polyline points map to the 500x84 viewBox: x*500, baseline 78 minus y*74", () => {
    expect(
      sparklinePolylinePoints([
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ]),
    ).toBe("0.00,78.00 250.00,41.00 500.00,4.00");
  });

  test("fill closes today's curve along the baseline at both ends; no points → null", () => {
    expect(
      sparklineFillPoints([
        { x: 0.25, y: 0 },
        { x: 0.75, y: 1 },
      ]),
    ).toBe("125.00,78.00 375.00,4.00 375.00,78.00 125.00,78.00");
    expect(sparklineFillPoints([])).toBeNull();
  });

  test("endpoint is the mapped last point; none when empty", () => {
    expect(
      sparklineEndpoint([
        { x: 0, y: 1 },
        { x: 0.5, y: 0.5 },
      ]),
    ).toEqual({ cx: 250, cy: 41 });
    expect(sparklineEndpoint([])).toBeNull();
  });

  test("the viewBox matches the fixed 500x84 box", () => {
    expect(SPARKLINE_VIEWBOX).toEqual({ width: 500, height: 84 });
  });
});
