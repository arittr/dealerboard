/**
 * Pure view-model for the rail's token-usage block: reduce the token-usage
 * snapshot read to a rail model — today's total plus rolling /hr and /10m
 * rates with glorp-style trend arrows — plus the compact token formatting.
 * Kept DOM-free so the logic is unit-testable; the rendering layer is
 * app/src/rail.ts.
 */

import { parseTokenUsageSnapshot, type TokenUsageSnapshot } from "../../src/token-usage-snapshot";
import type { SnapshotPayload } from "./bridge";

/** Three missed 30s collector passes without a success marks the block stale. */
export const STALE_TOKEN_USAGE_AGE_MS = 3 * 30_000;

const TEN_MINUTES_MS = 10 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

export type TokenUsageTrend = "up" | "down" | "flat";

export type TokenUsageRateLine = { tokens: number; trend: TokenUsageTrend };

export type TokenUsageRailModel =
  | { state: "hidden" }
  | { state: "ok" | "stale"; totalTokens: number; hour: TokenUsageRateLine; tenMin: TokenUsageRateLine };

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

/** A rolling-window rate: current window minus its start, trended against the previous equal-width window with glorp's deadband. */
const rateLine = (samples: readonly NumberedSample[], anchorMs: number, windowMs: number): TokenUsageRateLine => {
  const newest = samples[samples.length - 1]?.totalTokens ?? 0;
  const current = Math.max(0, newest - totalAsOf(samples, anchorMs - windowMs));
  const previous = Math.max(0, totalAsOf(samples, anchorMs - windowMs) - totalAsOf(samples, anchorMs - 2 * windowMs));
  const threshold = Math.max(1000, 0.1 * previous);
  const trend: TokenUsageTrend =
    current > previous + threshold ? "up" : current < previous - threshold ? "down" : "flat";
  return { tokens: current, trend };
};

const formatScaled = (scaled: number, suffix: string): string => `${scaled.toFixed(1).replace(/\.0$/u, "")}${suffix}`;

/** glorp's compact token formatting: one decimal, a trailing .0 stripped, k/M/B suffixes (1000.0k rolls up to 1M). */
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
    return { state, totalTokens: snapshot.totalTokens, hour: zero, tenMin: zero };
  }
  return {
    state,
    totalTokens: snapshot.totalTokens,
    hour: rateLine(daySamples, anchor.atMs, ONE_HOUR_MS),
    tenMin: rateLine(daySamples, anchor.atMs, TEN_MINUTES_MS),
  };
};
