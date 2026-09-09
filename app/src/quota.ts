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
  type QuotaAccountIssue,
  type QuotaExtraWindow,
  type QuotaHistoryPoint,
  type QuotaProviderKey,
  type QuotaSnapshot,
} from "../../src/quota-snapshot";
import type { SnapshotPayload } from "./bridge";

/** Three missed 120s collector passes without a success marks the panel stale. */
export const STALE_QUOTA_AGE_MS = 3 * 120_000;

/** Source-measurement freshness for identified provider accounts. */
export const ACCOUNT_STALE_AGE_MS = { codex: 6 * 60_000, claude: 45 * 60_000 } as const;

export type QuotaPanelState = "ok" | "stale" | "unavailable";

/** A rail meter's stable interaction identity; ambient provider readings have no account. */
export type QuotaTarget = { provider: QuotaProviderKey; accountId: string | null };

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
  /** Account failures; ambient provider meters always carry null. */
  issue: QuotaAccountIssue | null;
  fetchedAtMs: number | null;
};

export type QuotaAccountMeterModel = QuotaMeterModel & {
  id: string;
  label: string;
  active: boolean | null;
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
    issue: null,
    fetchedAtMs,
  };
};

const accountMeterModel = (
  provider: "claude" | "codex",
  account: ProviderQuota["accounts"][number],
  now: number,
): QuotaAccountMeterModel => {
  const meter = meterModel(account, now);
  const fetchedAtMs = meter.fetchedAtMs;
  const state: QuotaPanelState =
    account.issue !== null || fetchedAtMs === null
      ? "unavailable"
      : now - fetchedAtMs > ACCOUNT_STALE_AGE_MS[provider]
        ? "stale"
        : "ok";
  return { id: account.id, label: account.label, active: account.active, ...meter, state, issue: account.issue };
};

const panelModel = (provider: QuotaProviderKey, quota: ProviderQuota, now: number): QuotaPanelModel => {
  const ambient = meterModel(quota, now);
  const accounts =
    provider === "claude"
      ? quota.accounts.map((account) => accountMeterModel(provider, account, now))
      : provider === "codex"
        ? [...quota.accounts]
            .sort((a, b) => Number(a.label) - Number(b.label))
            .map((account) => accountMeterModel(provider, account, now))
        : [];
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
    return QUOTA_PROVIDER_KEYS.map((provider) => ({
      provider,
      windows: [],
      bindingIndex: null,
      state: "unavailable",
      issue: null,
      fetchedAtMs: null,
      history: [],
      accounts: [],
    }));
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

const formatDuration = (durationMs: number): string => {
  const minutes = Math.ceil(durationMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) {
    return `${Math.round(hours / 24)}d`;
  }
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
};

export const formatResetCountdown = (resetAtMs: number, now: number): string =>
  resetAtMs <= now ? "resetting…" : formatDuration(resetAtMs - now);

/** The binding window, or null when the provider has never fetched. */
export const bindingWindow = (model: QuotaMeterModel): QuotaWindowModel | null =>
  model.bindingIndex === null ? null : (model.windows[model.bindingIndex] ?? null);

/**
 * True while the binding window's published reset is still ahead — the
 * horizon out to which a stopped probe's last-good numbers stay meaningful.
 */
export const bindingResetPending = (model: QuotaMeterModel, now: number): boolean => {
  const binding = bindingWindow(model);
  return binding !== null && binding.resetAtMs !== null && binding.resetAtMs > now;
};

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

/**
 * The data age, coarse: minutes under an hour, then floored hours or days with
 * a "+" — the plus keeps "at least this stale" without minute precision.
 */
const formatDataAge = (fetchedAtMs: number, now: number): string => {
  const ageMs = Math.max(0, now - fetchedAtMs);
  const minutes = Math.max(1, Math.ceil(ageMs / 60_000));
  if (minutes < 60) {
    return `${minutes}m old`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) {
    return `${Math.floor(hours / 24)}d+ old`;
  }
  return `${hours}h+ old`;
};

/** Muted right text of the head line: unavailable age or countdown, binding reset countdown, or empty. */
export type QuotaReadout = {
  note: string;
  percent: string | null;
  ageCue: string | null;
  showFill: boolean;
  historical: boolean;
};

/** One visibility decision for a quota meter's text and geometry. */
export const quotaReadout = (model: QuotaMeterModel, now: number): QuotaReadout => {
  const binding = bindingWindow(model);
  if (model.issue === "auth_required") {
    return { note: "Sign in again", percent: null, ageCue: null, showFill: false, historical: true };
  }
  if (binding === null) {
    return {
      note: model.fetchedAtMs === null || model.state === "unavailable" ? "unavailable" : "reset unknown",
      percent: null,
      ageCue: null,
      showFill: false,
      historical: model.state !== "ok",
    };
  }
  const resetPending = bindingResetPending(model, now);
  const percent = formatPercentRemaining(binding.percentRemaining);
  if (model.state === "ok") {
    if (binding.resetAtMs === null) {
      return { note: "reset unknown", percent, ageCue: null, showFill: true, historical: false };
    }
    if (!resetPending) {
      return { note: "resetting…", percent, ageCue: null, showFill: true, historical: true };
    }
    return {
      note: formatResetCountdown(binding.resetAtMs, now),
      percent,
      ageCue: null,
      showFill: true,
      historical: false,
    };
  }
  if (resetPending && binding.resetAtMs !== null) {
    return {
      note: formatResetCountdown(binding.resetAtMs, now),
      percent,
      ageCue: model.fetchedAtMs === null ? null : formatDataAge(model.fetchedAtMs, now),
      showFill: true,
      historical: true,
    };
  }
  return {
    note: model.fetchedAtMs === null ? "unavailable" : formatDataAge(model.fetchedAtMs, now),
    percent: null,
    ageCue: null,
    showFill: false,
    historical: true,
  };
};

/** Legacy note helper for callers that only need the primary text. */
export const formatBindingNote = (model: QuotaMeterModel, now: number): string => quotaReadout(model, now).note;

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
