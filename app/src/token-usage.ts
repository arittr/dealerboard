/**
 * Pure view-model for the rail's token-usage block: reduce the token-usage
 * snapshot read to a rail model — today's total plus rolling /hr and /10m
 * rates with trend arrows, the day-over-day sparkline, and the
 * compact token formatting. Kept DOM-free so the logic is unit-testable; the
 * rendering layer is app/src/rail.ts.
 */

import {
  parseTokenUsageSnapshot,
  type TokenUsageDayCurve,
  type TokenUsageSnapshot,
} from "../../src/token-usage-snapshot";
import type { SnapshotPayload } from "./bridge";

/** Three missed 30s collector passes without a success marks the block stale. */
export const STALE_TOKEN_USAGE_AGE_MS = 3 * 30_000;

const TEN_MINUTES_MS = 10 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

export type TokenUsageTrend = "up" | "down" | "flat";

export type TokenUsageRateLine = { tokens: number; trend: TokenUsageTrend };

export type TokenUsageRailModel =
  | { state: "hidden" }
  | {
      state: "ok" | "stale";
      totalTokens: number;
      hour: TokenUsageRateLine;
      tenMin: TokenUsageRateLine;
      sparkline: SparklineModel | null;
    };

export const ACTIVITY_BOUNDARY_MAX_AGE_MS = 30 * 60_000;

export type HourlyActivityBucket =
  | { hour: number; state: "measured" | "current"; tokens: number }
  | { hour: number; state: "future" | "unmeasured" | "nonexistent"; tokens: null };

export type TokenActivityChartModel = {
  today: HourlyActivityBucket[];
  yesterday: HourlyActivityBucket[] | null;
  yMax: number;
};

type NumberedCurvePoint = { atMs: number; totalTokens: number };
type IntervalActivity =
  | { state: "measured" | "current"; tokens: number }
  | { state: "future" | "unmeasured"; tokens: null };

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

/** A rolling-window rate: current window minus its start, trended against the previous equal-width window with a deadband. */
const rateLine = (samples: readonly NumberedSample[], anchorMs: number, windowMs: number): TokenUsageRateLine => {
  const newest = samples[samples.length - 1]?.totalTokens ?? 0;
  const current = Math.max(0, newest - totalAsOf(samples, anchorMs - windowMs));
  const previous = Math.max(0, totalAsOf(samples, anchorMs - windowMs) - totalAsOf(samples, anchorMs - 2 * windowMs));
  const threshold = Math.max(1000, 0.1 * previous);
  // Warm-up guard: without a sample at or before the previous window's start,
  // the comparison is against an unmeasured window — report flat, per spec.
  const covered = samples[0] !== undefined && samples[0].atMs <= anchorMs - 2 * windowMs;
  const trend: TokenUsageTrend = !covered
    ? "flat"
    : current > previous + threshold
      ? "up"
      : current < previous - threshold
        ? "down"
        : "flat";
  return { tokens: current, trend };
};

const formatScaled = (scaled: number, suffix: string): string => `${scaled.toFixed(1).replace(/\.0$/u, "")}${suffix}`;

const LA_TIME_ZONE = "America/Los_Angeles";

const laWallClockFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: LA_TIME_ZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const laHourFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: LA_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

const laClockHour = (atMs: number): number => {
  const hour = Number(laHourFormat.formatToParts(new Date(atMs)).find((part) => part.type === "hour")?.value ?? "0");
  return hour % 24;
};

/** Offset of LA wall clock from UTC at an instant, in ms (negative west of UTC). */
const laOffsetMs = (atMs: number): number => {
  const parts = laWallClockFormat.formatToParts(new Date(atMs));
  const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour") % 24,
    field("minute"),
    field("second"),
  );
  return asUtc - Math.floor(atMs / 1000) * 1000;
};

/** Epoch of LA midnight for a YYYY-MM-DD day; the second pass settles DST transitions. */
const laMidnightMs = (day: string): number => {
  const guess = Date.parse(`${day}T00:00:00.000Z`);
  const once = guess - laOffsetMs(guess);
  return guess - laOffsetMs(once);
};

const nextProviderDay = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

const previousProviderDay = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);

export const laDayBoundsMs = (day: string): { startMs: number; endMs: number } => ({
  startMs: laMidnightMs(day),
  endMs: laMidnightMs(nextProviderDay(day)),
});

const measuredBucket = (hour: number, tokens: number, current: boolean): HourlyActivityBucket => ({
  hour,
  state: current ? "current" : "measured",
  tokens: Math.max(0, tokens),
});

const absentBucket = (hour: number, state: "future" | "unmeasured" | "nonexistent"): HourlyActivityBucket => ({
  hour,
  state,
  tokens: null,
});

const pointsWithinDay = (curve: TokenUsageDayCurve, startMs: number, endMs: number): NumberedCurvePoint[] =>
  curve.points
    .map((point) => ({ atMs: Date.parse(point.fetchedAt), totalTokens: point.totalTokens }))
    .filter((point) => point.atMs >= startMs && point.atMs < endMs);

const totalAtBoundary = (
  points: readonly NumberedCurvePoint[],
  boundaryMs: number,
  dayStartMs: number,
): number | null => {
  if (boundaryMs === dayStartMs) return 0;
  let latest: NumberedCurvePoint | null = null;
  for (const point of points) {
    if (point.atMs > boundaryMs) break;
    latest = point;
  }
  return latest !== null && boundaryMs - latest.atMs <= ACTIVITY_BOUNDARY_MAX_AGE_MS ? latest.totalTokens : null;
};

const reduceCurveActivity = (curve: TokenUsageDayCurve, today: boolean): HourlyActivityBucket[] => {
  const { startMs, endMs } = laDayBoundsMs(curve.providerDay);
  const points = pointsWithinDay(curve, startMs, endMs);
  const latest = points.at(-1) ?? null;
  const byHour = Array.from({ length: 24 }, () => [] as IntervalActivity[]);

  for (let intervalStart = startMs; intervalStart < endMs; intervalStart += ONE_HOUR_MS) {
    const intervalEnd = Math.min(intervalStart + ONE_HOUR_MS, endMs);
    const hour = laClockHour(intervalStart);
    if (today && (latest === null || latest.atMs < intervalStart)) {
      byHour[hour]?.push({ state: "future", tokens: null });
      continue;
    }

    const current = today && latest !== null && latest.atMs < intervalEnd;
    const effectiveEnd = current && latest !== null ? latest.atMs : intervalEnd;
    const startTotal = totalAtBoundary(points, intervalStart, startMs);
    const endTotal = totalAtBoundary(points, effectiveEnd, startMs);
    byHour[hour]?.push(
      startTotal === null || endTotal === null
        ? { state: "unmeasured", tokens: null }
        : { state: current ? "current" : "measured", tokens: Math.max(0, endTotal - startTotal) },
    );
  }

  return byHour.map((parts, hour) => {
    if (parts.length === 0) return absentBucket(hour, "nonexistent");
    const elapsed = parts.filter((part) => part.state !== "future");
    if (elapsed.length === 0) return absentBucket(hour, "future");
    if (elapsed.some((part) => part.state === "unmeasured")) return absentBucket(hour, "unmeasured");
    const tokens = elapsed.reduce((sum, part) => sum + (part.tokens ?? 0), 0);
    const current = elapsed.some((part) => part.state === "current") || parts.some((part) => part.state === "future");
    return measuredBucket(hour, tokens, current);
  });
};

const bucketIsObserved = (
  bucket: HourlyActivityBucket,
): bucket is Extract<HourlyActivityBucket, { state: "measured" | "current" }> =>
  bucket.state === "measured" || bucket.state === "current";

const hasYesterdaySegment = (buckets: readonly HourlyActivityBucket[]): boolean => {
  let previousMeasured = false;
  for (const bucket of buckets) {
    const measuredNow = bucket.state === "measured";
    if (previousMeasured && measuredNow) return true;
    previousMeasured = measuredNow;
  }
  return false;
};

export const reduceTokenActivity = (snapshot: TokenUsageSnapshot): TokenActivityChartModel | null => {
  const curves = snapshot.dayCurves;
  if (curves === undefined) return null;

  const today = reduceCurveActivity(curves.today, true);
  const candidateYesterday =
    curves.yesterday !== null && curves.yesterday.providerDay === previousProviderDay(curves.today.providerDay)
      ? reduceCurveActivity(curves.yesterday, false)
      : null;
  const yesterday = candidateYesterday !== null && hasYesterdaySegment(candidateYesterday) ? candidateYesterday : null;
  const observed = [...today, ...(yesterday ?? [])].filter(bucketIsObserved);
  if (observed.length === 0) return null;

  return {
    today,
    yesterday,
    yMax: Math.max(1, ...observed.map((bucket) => bucket.tokens)),
  };
};

export const TOKEN_ACTIVITY_VIEWBOX = { width: 500, height: 84 } as const;
const TOKEN_ACTIVITY_PLOT_TOP = 4;
const TOKEN_ACTIVITY_PLOT_BOTTOM = 60;
const TOKEN_ACTIVITY_BAR_WIDTH = 12;
const TOKEN_ACTIVITY_SLOT_WIDTH = TOKEN_ACTIVITY_VIEWBOX.width / 24;

export const TOKEN_ACTIVITY_TIME_LABELS = [
  { text: "12a", x: 0, anchor: "start" },
  { text: "12p", x: TOKEN_ACTIVITY_VIEWBOX.width / 2, anchor: "middle" },
  { text: "12a", x: TOKEN_ACTIVITY_VIEWBOX.width, anchor: "end" },
] as const;

export type TokenActivityPoint = { hour: number; x: number; y: number };
export type TokenActivityBarRect = TokenActivityPoint & {
  width: number;
  height: number;
  current: boolean;
};

const activityHeight = (tokens: number, yMax: number): number =>
  (tokens / Math.max(1, yMax)) * (TOKEN_ACTIVITY_PLOT_BOTTOM - TOKEN_ACTIVITY_PLOT_TOP);

const activityPoint = (hour: number, tokens: number, yMax: number): TokenActivityPoint => {
  const height = activityHeight(tokens, yMax);
  return {
    hour,
    x: (hour + 0.5) * TOKEN_ACTIVITY_SLOT_WIDTH,
    y: TOKEN_ACTIVITY_PLOT_BOTTOM - height,
  };
};

export const tokenActivityBarRects = (model: TokenActivityChartModel): TokenActivityBarRect[] =>
  model.today.flatMap((bucket) => {
    if (!bucketIsObserved(bucket)) return [];
    const point = activityPoint(bucket.hour, bucket.tokens, model.yMax);
    const height = activityHeight(bucket.tokens, model.yMax);
    return [
      {
        ...point,
        x: point.x - TOKEN_ACTIVITY_BAR_WIDTH / 2,
        width: TOKEN_ACTIVITY_BAR_WIDTH,
        height,
        current: bucket.state === "current",
      },
    ];
  });

export const tokenActivityLineSegments = (model: TokenActivityChartModel): TokenActivityPoint[][] => {
  if (model.yesterday === null) return [];
  const segments: TokenActivityPoint[][] = [];
  let current: TokenActivityPoint[] = [];
  const flush = (): void => {
    if (current.length >= 2) segments.push(current);
    current = [];
  };
  for (const bucket of model.yesterday) {
    if (bucket.state === "measured") current.push(activityPoint(bucket.hour, bucket.tokens, model.yMax));
    else flush();
  }
  flush();
  return segments;
};

export const tokenActivityLineEndpoint = (
  segments: readonly (readonly TokenActivityPoint[])[],
): TokenActivityPoint | null => segments.at(-1)?.at(-1) ?? null;

/** Compact token formatting: one decimal, a trailing .0 stripped, k/M/B suffixes (1000.0k rolls up to 1M). */
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

export type SparklinePoint = { x: number; y: number };
export type SparklineModel = {
  today: { points: SparklinePoint[] };
  yesterday: { points: SparklinePoint[]; label: string } | null;
};

const curveLine = (curve: TokenUsageDayCurve, yMax: number): SparklinePoint[] => {
  const { startMs, endMs } = laDayBoundsMs(curve.providerDay);
  const span = Math.max(1, endMs - startMs);
  return curve.points.map((point) => ({
    x: Math.min(1, Math.max(0, (Date.parse(point.fetchedAt) - startMs) / span)),
    y: Math.min(1, Math.max(0, point.totalTokens / yMax)),
  }));
};

/** Spec "Day-over-day sparkline": adjacent-yesterday only, shared zero-based y-scale, elapsed-fraction x. */
export const reduceSparkline = (snapshot: TokenUsageSnapshot): SparklineModel | null => {
  const curves = snapshot.dayCurves;
  if (curves === undefined) {
    return null;
  }
  const yesterday =
    curves.yesterday !== null &&
    curves.yesterday.providerDay === previousProviderDay(curves.today.providerDay) &&
    curves.yesterday.points.length > 0
      ? curves.yesterday
      : null;
  if (curves.today.points.length === 0 && yesterday === null) {
    return null;
  }
  const yMax = Math.max(1, curves.today.points.at(-1)?.totalTokens ?? 0, yesterday?.points.at(-1)?.totalTokens ?? 0);
  return {
    today: { points: curveLine(curves.today, yMax) },
    yesterday:
      yesterday === null
        ? null
        : {
            points: curveLine(yesterday, yMax),
            label: `yda ${formatTokensCompact(yesterday.points.at(-1)?.totalTokens ?? 0)}`,
          },
  };
};

/* SVG geometry for the sparkline (fixed 500x84 box: curve baseline y=78,
   curve max y=4). Pure and DOM-free so rail.ts stays a thin attribute shell. */

export const SPARKLINE_VIEWBOX = { width: 500, height: 84 } as const;

const SPARKLINE_BASELINE_Y = 78;
const SPARKLINE_CURVE_SPAN = 74;

const sparkCoordinate = (point: SparklinePoint): string => {
  const x = (point.x * SPARKLINE_VIEWBOX.width).toFixed(2);
  const y = (SPARKLINE_BASELINE_Y - point.y * SPARKLINE_CURVE_SPAN).toFixed(2);
  return `${x},${y}`;
};

/** Polyline points attribute for a curve: x*500, 78 − y*74. */
export const sparklinePolylinePoints = (points: readonly SparklinePoint[]): string =>
  points.map(sparkCoordinate).join(" ");

/** Fill polygon points: today's curve closed along the baseline at both ends; null with no points. */
export const sparklineFillPoints = (points: readonly SparklinePoint[]): string | null => {
  const first = points.at(0);
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return null;
  }
  const baselineAt = (x: number): string =>
    `${(x * SPARKLINE_VIEWBOX.width).toFixed(2)},${SPARKLINE_BASELINE_Y.toFixed(2)}`;
  return `${sparklinePolylinePoints(points)} ${baselineAt(last.x)} ${baselineAt(first.x)}`;
};

/** Endpoint circle center for today's last point; null with no points. */
export const sparklineEndpoint = (points: readonly SparklinePoint[]): { cx: number; cy: number } | null => {
  const last = points.at(-1);
  if (last === undefined) {
    return null;
  }
  return {
    cx: last.x * SPARKLINE_VIEWBOX.width,
    cy: SPARKLINE_BASELINE_Y - last.y * SPARKLINE_CURVE_SPAN,
  };
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
    return { state, totalTokens: snapshot.totalTokens, hour: zero, tenMin: zero, sparkline: reduceSparkline(snapshot) };
  }
  return {
    state,
    totalTokens: snapshot.totalTokens,
    hour: rateLine(daySamples, anchor.atMs, ONE_HOUR_MS),
    tenMin: rateLine(daySamples, anchor.atMs, TEN_MINUTES_MS),
    sparkline: reduceSparkline(snapshot),
  };
};
