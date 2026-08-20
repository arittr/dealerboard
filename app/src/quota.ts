/**
 * Pure view-model for the rail's quota panels: reduce the quota-snapshot read
 * to per-provider panel models, plus the formatting and sparkline geometry.
 * Kept DOM-free so the logic is unit-testable; the rendering layer is
 * app/src/rail.ts.
 */

import {
  type ProviderQuota,
  parseQuotaSnapshot,
  QUOTA_PROVIDER_KEYS,
  type QuotaHistoryPoint,
  type QuotaProviderKey,
  type QuotaSnapshot,
} from "../../src/quota-snapshot";
import type { SnapshotPayload } from "./bridge";

/** Three missed 120s collector passes without a success marks the panel stale. */
export const STALE_QUOTA_AGE_MS = 3 * 120_000;

export type QuotaPanelState = "ok" | "stale" | "unavailable";

export type QuotaPanelModel = {
  provider: QuotaProviderKey;
  /** Session-window percent remaining (last-good when unavailable); null when never fetched. */
  percentRemaining: number | null;
  resetAtMs: number | null;
  weeklyPercentRemaining: number | null;
  weeklyResetAtMs: number | null;
  state: QuotaPanelState;
  fetchedAtMs: number | null;
  history: readonly QuotaHistoryPoint[];
};

const parseInstant = (value: string | null): number | null => (value === null ? null : Date.parse(value));

const panelState = (quota: ProviderQuota, fetchedAtMs: number | null, now: number): QuotaPanelState => {
  if (quota.unavailable || fetchedAtMs === null) {
    return "unavailable";
  }
  return now - fetchedAtMs > STALE_QUOTA_AGE_MS ? "stale" : "ok";
};

const panelModel = (provider: QuotaProviderKey, quota: ProviderQuota, now: number): QuotaPanelModel => {
  const fetchedAtMs = parseInstant(quota.fetchedAt);
  return {
    provider,
    percentRemaining: quota.percentRemaining,
    resetAtMs: parseInstant(quota.resetAt),
    weeklyPercentRemaining: quota.weeklyPercentRemaining,
    weeklyResetAtMs: parseInstant(quota.weeklyResetAt),
    state: panelState(quota, fetchedAtMs, now),
    fetchedAtMs,
    history: quota.history,
  };
};

export const reduceQuotaRead = (read: SnapshotPayload | null, now: number): QuotaPanelModel[] => {
  if (read === null) {
    return [];
  }
  let snapshot: QuotaSnapshot;
  try {
    snapshot = parseQuotaSnapshot(JSON.parse(read.contents));
  } catch {
    return [];
  }
  const models: QuotaPanelModel[] = [];
  for (const provider of QUOTA_PROVIDER_KEYS) {
    const quota = snapshot.providers[provider];
    if (quota !== undefined) {
      models.push(panelModel(provider, quota, now));
    }
  }
  return models;
};

export const formatPercentRemaining = (percent: number): string => `${Math.round(percent)}%`;

export const formatResetCountdown = (resetAtMs: number, now: number): string => {
  const remainingMs = resetAtMs - now;
  if (remainingMs <= 0) {
    return "resetting…";
  }
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) {
    return `${Math.round(hours / 24)}d`;
  }
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
};

export const formatWeeklyLine = (percent: number | null, resetAtMs: number | null, now: number): string | null => {
  if (percent === null) {
    return null;
  }
  const base = `week ${Math.round(percent)}% left`;
  return resetAtMs === null ? base : `${base} · ${formatResetCountdown(resetAtMs, now)}`;
};

/** Fill hue follows remaining headroom on the strip's existing status palette. */
export const quotaBarColor = (percentRemaining: number): string => {
  if (percentRemaining > 25) {
    return "#4ade80";
  }
  if (percentRemaining >= 10) {
    return "#ffb020";
  }
  return "#ff4d67";
};

export const quotaStatusText = (model: QuotaPanelModel, now: number): string => {
  if (model.state === "unavailable") {
    if (model.fetchedAtMs === null || model.percentRemaining === null) {
      return "unavailable";
    }
    const ageMinutes = Math.max(0, Math.round((now - model.fetchedAtMs) / 60_000));
    return ageMinutes < 1 ? "updated just now" : `updated ${ageMinutes}m ago`;
  }
  if (model.resetAtMs === null) {
    return "";
  }
  if (model.resetAtMs <= now) {
    return "resetting…";
  }
  return `resets in ${formatResetCountdown(model.resetAtMs, now)}`;
};

export type SparkPoint = { x: number; y: number };

/**
 * Map the history ring onto a canvas of the given CSS size: oldest sample at
 * x=0, newest at x=width, full remaining at y=0 (canvas y grows downward).
 */
export const sparklinePoints = (history: readonly QuotaHistoryPoint[], width: number, height: number): SparkPoint[] => {
  if (history.length < 2 || width <= 0 || height <= 0) {
    return [];
  }
  const firstMs = Date.parse(history[0]?.fetchedAt ?? "");
  const lastMs = Date.parse(history[history.length - 1]?.fetchedAt ?? "");
  if (Number.isNaN(firstMs) || Number.isNaN(lastMs)) {
    return [];
  }
  const span = Math.max(1, lastMs - firstMs);
  return history.map((point) => ({
    x: ((Date.parse(point.fetchedAt) - firstMs) / span) * width,
    y: height - point.fractionRemaining * height,
  }));
};
