import { join } from "node:path";
import {
  capQuotaExtraWindowLabel,
  type ProviderQuotaAccount,
  QUOTA_ACCOUNTS_LIMIT,
  type QuotaExtraWindow,
} from "../quota-snapshot";

export const CLAUDE_SWAP_EXEC_TIMEOUT_MS = 5_000;
export const CLAUDE_SWAP_ARGS = ["list", "--json"] as const;

export const claudeSwapBinaryCandidates = (home: string): readonly string[] => [
  join(home, ".local/bin/cswap"),
  "/opt/homebrew/bin/cswap",
  "/usr/local/bin/cswap",
];

export type ClaudeSwapAccountsParse = { kind: "ok"; accounts: ProviderQuotaAccount[] } | { kind: "invalid" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPercent = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

type SourceWindow = { pct: number; resetsAt: string | null };

const parseWindow = (value: unknown): SourceWindow | null => {
  if (!isRecord(value) || !isPercent(value["pct"])) {
    return null;
  }
  return { pct: value["pct"], resetsAt: isoOrNull(value["resetsAt"]) };
};

const remaining = (
  window: SourceWindow | null,
): {
  percentRemaining: number | null;
  resetAt: string | null;
} => ({
  percentRemaining: window === null ? null : 100 - window.pct,
  resetAt: window?.resetsAt ?? null,
});

type NormalizedUsage = {
  session: ReturnType<typeof remaining>;
  weekly: ReturnType<typeof remaining>;
  extras: QuotaExtraWindow[];
  hasWindow: boolean;
};

const normalizeUsage = (value: unknown, slot: number): NormalizedUsage => {
  const source = isRecord(value) ? value : {};
  const sessionWindow = parseWindow(source["fiveHour"]);
  const weeklyWindow = parseWindow(source["sevenDay"]);
  const extras: QuotaExtraWindow[] = [];
  const scoped = Array.isArray(source["scoped"]) ? source["scoped"] : [];
  for (const [index, entry] of scoped.entries()) {
    if (!isRecord(entry) || typeof entry["name"] !== "string" || entry["name"].trim().length === 0) continue;
    const window = parseWindow(entry);
    if (window === null) continue;
    extras.push({
      id: `claude-swap:${slot}:scoped:${index}`,
      label: capQuotaExtraWindowLabel(entry["name"].trim()),
      percentRemaining: 100 - window.pct,
      resetAt: window.resetsAt,
    });
  }
  return {
    session: remaining(sessionWindow),
    weekly: remaining(weeklyWindow),
    extras,
    hasWindow: sessionWindow !== null || weeklyWindow !== null || extras.length > 0,
  };
};

const emptyUsage = (): NormalizedUsage => ({
  session: { percentRemaining: null, resetAt: null },
  weekly: { percentRemaining: null, resetAt: null },
  extras: [],
  hasWindow: false,
});

const normalizeAccount = (value: unknown, activeSlot: number): ProviderQuotaAccount | null => {
  if (!isRecord(value) || !isPositiveInteger(value["number"])) return null;
  const slot = value["number"];
  const current = normalizeUsage(value["usage"], slot);
  const currentFetchedAt = isoOrNull(value["usageFetchedAt"]);
  const lastGood = normalizeUsage(value["lastGoodUsage"], slot);
  const lastGoodFetchedAt = isoOrNull(value["lastGoodFetchedAt"]);
  const selected =
    value["usageStatus"] === "ok" && current.hasWindow && currentFetchedAt !== null
      ? { usage: current, fetchedAt: currentFetchedAt, unavailable: false }
      : lastGood.hasWindow && lastGoodFetchedAt !== null
        ? { usage: lastGood, fetchedAt: lastGoodFetchedAt, unavailable: true }
        : { usage: emptyUsage(), fetchedAt: null, unavailable: true };
  return {
    id: `claude-swap:${slot}`,
    label: String(slot),
    active: slot === activeSlot,
    percentRemaining: selected.usage.session.percentRemaining,
    resetAt: selected.usage.session.resetAt,
    weeklyPercentRemaining: selected.usage.weekly.percentRemaining,
    weeklyResetAt: selected.usage.weekly.resetAt,
    unavailable: selected.unavailable,
    fetchedAt: selected.fetchedAt,
    extraWindows: selected.usage.extras,
  };
};

export const parseClaudeSwapAccounts = (body: string): ClaudeSwapAccountsParse => {
  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value) || value["schemaVersion"] !== 1) {
      return { kind: "invalid" };
    }
    const activeSlot = value["activeAccountNumber"];
    if (!isPositiveInteger(activeSlot)) return { kind: "invalid" };
    const sourceAccounts = value["accounts"];
    if (!Array.isArray(sourceAccounts) || sourceAccounts.length > QUOTA_ACCOUNTS_LIMIT) {
      return { kind: "invalid" };
    }
    const accounts: ProviderQuotaAccount[] = [];
    for (const sourceAccount of sourceAccounts) {
      const account = normalizeAccount(sourceAccount, activeSlot);
      if (account === null) return { kind: "invalid" };
      accounts.push(account);
    }
    if (new Set(accounts.map((account) => account.id)).size !== accounts.length) return { kind: "invalid" };
    if (accounts.length > 0 && accounts.filter((account) => account.active).length !== 1) {
      return { kind: "invalid" };
    }
    accounts.sort((a, b) => Number(a.label) - Number(b.label));
    return { kind: "ok", accounts };
  } catch {
    return { kind: "invalid" };
  }
};
