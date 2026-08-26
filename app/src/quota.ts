/**
 * Pure view-model for the rail's quota panels: reduce the quota-snapshot read
 * to per-provider window lists (session, weekly, extras), pick the binding
 * window (the lowest percent remaining), and derive the tag pill and headline
 * texts. Kept DOM-free so the logic is unit-testable; the rendering layer is
 * app/src/rail.ts.
 */

import {
  type ProviderQuota,
  parseQuotaSnapshot,
  QUOTA_PROVIDER_KEYS,
  type QuotaExtraWindow,
  type QuotaHistoryPoint,
  type QuotaProviderKey,
  type QuotaSnapshot,
} from "../../src/quota-snapshot";
import type { SnapshotPayload } from "./bridge";

/** Three missed 120s collector passes without a success marks the panel stale. */
export const STALE_QUOTA_AGE_MS = 3 * 120_000;

export type QuotaPanelState = "ok" | "stale" | "unavailable";

export type QuotaWindowModel = {
  /** Pill tag: "session", "weekly", or an extra window's published label. */
  tag: string;
  percentRemaining: number;
  resetAtMs: number | null;
};

export type QuotaMeterModel = {
  /** Session, weekly, then extras in published order; empty when never fetched. */
  windows: readonly QuotaWindowModel[];
  /** Index of the binding (lowest-percent) window; null when windows is empty. */
  bindingIndex: number | null;
  state: QuotaPanelState;
  fetchedAtMs: number | null;
};

export type QuotaAccountMeterModel = QuotaMeterModel & {
  id: string;
  label: string;
  active: boolean;
};

export type QuotaPanelModel = QuotaMeterModel & {
  provider: QuotaProviderKey;
  history: readonly QuotaHistoryPoint[];
  accounts: readonly QuotaAccountMeterModel[];
};

const parseInstant = (value: string | null): number | null => (value === null ? null : Date.parse(value));

type QuotaMeterInput = {
  percentRemaining: number | null;
  resetAt: string | null;
  weeklyPercentRemaining: number | null;
  weeklyResetAt: string | null;
  unavailable: boolean;
  fetchedAt: string | null;
  extraWindows: readonly QuotaExtraWindow[];
};

const panelState = (quota: QuotaMeterInput, fetchedAtMs: number | null, now: number): QuotaPanelState => {
  if (quota.unavailable || fetchedAtMs === null) {
    return "unavailable";
  }
  return now - fetchedAtMs > STALE_QUOTA_AGE_MS ? "stale" : "ok";
};

/** The lowest percent remaining binds; ties keep the earlier window (session > weekly > extras). */
export const selectBindingIndex = (windows: readonly QuotaWindowModel[]): number | null => {
  let best: number | null = null;
  for (const [index, entry] of windows.entries()) {
    if (best === null || entry.percentRemaining < (windows[best]?.percentRemaining ?? Number.POSITIVE_INFINITY)) {
      best = index;
    }
  }
  return best;
};

const meterModel = (quota: QuotaMeterInput, now: number): QuotaMeterModel => {
  const fetchedAtMs = parseInstant(quota.fetchedAt);
  const windows: QuotaWindowModel[] = [];
  if (quota.percentRemaining !== null) {
    windows.push({ tag: "session", percentRemaining: quota.percentRemaining, resetAtMs: parseInstant(quota.resetAt) });
  }
  if (quota.weeklyPercentRemaining !== null) {
    windows.push({
      tag: "weekly",
      percentRemaining: quota.weeklyPercentRemaining,
      resetAtMs: parseInstant(quota.weeklyResetAt),
    });
  }
  for (const extra of quota.extraWindows) {
    windows.push({
      tag: extra.label,
      percentRemaining: extra.percentRemaining,
      resetAtMs: parseInstant(extra.resetAt),
    });
  }
  return {
    windows,
    bindingIndex: selectBindingIndex(windows),
    state: panelState(quota, fetchedAtMs, now),
    fetchedAtMs,
  };
};

const panelModel = (provider: QuotaProviderKey, quota: ProviderQuota, now: number): QuotaPanelModel => {
  const ambient = meterModel(quota, now);
  const accounts =
    provider !== "claude" || quota.accounts.length < 2
      ? []
      : [...quota.accounts]
          .sort((a, b) => Number(a.label) - Number(b.label))
          .map((account) => ({
            id: account.id,
            label: account.label,
            active: account.active,
            ...meterModel(account, now),
          }));
  return {
    provider,
    ...ambient,
    history: quota.history,
    accounts,
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
  if (hours >= 24) {
    return `${Math.round(hours / 24)}d`;
  }
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
};

/** The binding window, or null when the provider has never fetched. */
export const bindingWindow = (model: QuotaMeterModel): QuotaWindowModel | null =>
  model.bindingIndex === null ? null : (model.windows[model.bindingIndex] ?? null);

/** Pill text: the binding window's name; null when no data. */
export const formatBindingTag = (model: QuotaMeterModel): string | null => {
  const binding = bindingWindow(model);
  if (binding === null) {
    return null;
  }
  return binding.tag;
};

/** Bright right text of the head line: binding percent, em dash when never fetched. */
export const formatBindingPercent = (model: QuotaMeterModel): string => {
  const binding = bindingWindow(model);
  return binding === null ? "—" : formatPercentRemaining(binding.percentRemaining);
};

/** Muted right text of the head line: unavailable age or countdown, binding reset countdown, or empty. */
export const formatBindingNote = (model: QuotaMeterModel, now: number): string => {
  const binding = bindingWindow(model);
  if (model.state === "unavailable") {
    if (model.fetchedAtMs === null || binding === null) {
      return "unavailable";
    }
    // A reset schedule stays trustworthy after the probe stops (the percent
    // does not), so a pending reset keeps its countdown; once it passes the
    // last-good numbers are spent and only the data age remains honest.
    if (binding.resetAtMs !== null && binding.resetAtMs > now) {
      return `resets ${formatResetCountdown(binding.resetAtMs, now)}`;
    }
    const ageMinutes = Math.max(0, Math.round((now - model.fetchedAtMs) / 60_000));
    return ageMinutes < 1 ? "updated just now" : `updated ${ageMinutes}m ago`;
  }
  if (binding === null || binding.resetAtMs === null) {
    return "";
  }
  if (binding.resetAtMs <= now) {
    return "resetting…";
  }
  return formatResetCountdown(binding.resetAtMs, now);
};

/**
 * The non-binding windows in published order — the binding window owns the
 * bright percent and the bar fill, and the bar renders a neutral tick at
 * each of these so the other windows stay visible without any text.
 */
export const secondaryWindows = (model: QuotaMeterModel): QuotaWindowModel[] =>
  model.windows.filter((_, index) => index !== model.bindingIndex);

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
