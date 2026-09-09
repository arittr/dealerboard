import { createHash } from "node:crypto";
import type { ProviderQuotaAccount } from "../quota-snapshot";
import { type ProviderQuotaReading, parseCodexbarRecord } from "./codexbar-usage";

export type CodexAccountsParse =
  | { kind: "invalid" }
  | {
      kind: "ok";
      accounts: ProviderQuotaAccount[];
      completeInventory: boolean;
      inventoryObserved: boolean;
      ambient: { reading: ProviderQuotaReading; fetchedAt: string } | null;
    };

export const codexAccountId = (label: string): string =>
  `codexbar:${createHash("sha256").update(`codex\0${label.trim()}`, "utf8").digest("hex")}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

const emptyAccount = (id: string, label: string): ProviderQuotaAccount => ({
  id,
  label,
  active: null,
  percentRemaining: null,
  resetAt: null,
  weeklyPercentRemaining: null,
  weeklyResetAt: null,
  issue: "unavailable",
  unavailable: true,
  fetchedAt: null,
  extraWindows: [],
});

type IdentifiedCandidate = {
  id: string;
  error: boolean;
  reading: ProviderQuotaReading | null;
  fetchedAt: string | null;
};

/**
 * Parses CodexBar's --all-accounts response into privacy-safe account rows.
 * Collection-time retention is deliberately left to the collector: this
 * adapter only reports observations that are safe to replace a prior row.
 */
export const parseCodexbarAccounts = (
  body: string,
  exitCode: number,
  previous: readonly ProviderQuotaAccount[],
): CodexAccountsParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "invalid" };
  }
  if (!Array.isArray(parsed)) return { kind: "invalid" };

  const candidates: IdentifiedCandidate[] = [];
  const anonymousSuccesses: Array<{ reading: ProviderQuotaReading; fetchedAt: string }> = [];
  let malformed = false;
  let anonymous = false;

  for (const entry of parsed) {
    if (isRecord(entry) && typeof entry["provider"] === "string" && entry["provider"] !== "codex") {
      continue;
    }
    if (!isRecord(entry) || entry["provider"] !== "codex") {
      malformed = true;
      continue;
    }
    const account = entry["account"];
    const label = typeof account === "string" ? account.trim() : "";
    const hasError = isRecord(entry["error"]);
    if (label.length === 0) {
      anonymous = true;
      if (!hasError) {
        const reading = parseCodexbarRecord(entry, "codex");
        const fetchedAt = isRecord(entry["usage"]) ? isoOrNull(entry["usage"]["updatedAt"]) : null;
        if (reading !== null && fetchedAt !== null) anonymousSuccesses.push({ reading, fetchedAt });
        else malformed = true;
      }
      continue;
    }
    const id = codexAccountId(label);
    if (hasError) {
      candidates.push({ id, error: true, reading: null, fetchedAt: null });
      continue;
    }
    const reading = parseCodexbarRecord(entry, "codex");
    const fetchedAt = isRecord(entry["usage"]) ? isoOrNull(entry["usage"]["updatedAt"]) : null;
    if (reading === null || fetchedAt === null) {
      malformed = true;
      candidates.push({ id, error: false, reading: null, fetchedAt: null });
      continue;
    }
    candidates.push({ id, error: false, reading, fetchedAt });
  }

  if (candidates.length > 8) return { kind: "invalid" };
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1);
  const duplicate = [...counts.values()].some((count) => count > 1);
  const unique = candidates.filter((candidate) => counts.get(candidate.id) === 1);

  const labels = new Map(previous.map((account) => [account.id, account.label]));
  let nextLabel = Math.max(0, ...previous.map((account) => Number(account.label))) + 1;
  const newIds = new Set(unique.map((candidate) => candidate.id).filter((id) => !labels.has(id)));
  for (const id of [...newIds].sort()) labels.set(id, String(nextLabel++));

  const accounts: ProviderQuotaAccount[] = [];
  for (const candidate of unique) {
    const label = labels.get(candidate.id);
    if (label === undefined) continue;
    if (candidate.error) {
      accounts.push(emptyAccount(candidate.id, label));
    } else if (candidate.reading !== null && candidate.fetchedAt !== null) {
      accounts.push({
        id: candidate.id,
        label,
        active: null,
        percentRemaining: candidate.reading.session?.percentRemaining ?? null,
        resetAt: candidate.reading.session?.resetAt ?? null,
        weeklyPercentRemaining: candidate.reading.weekly?.percentRemaining ?? null,
        weeklyResetAt: candidate.reading.weekly?.resetAt ?? null,
        issue: null,
        unavailable: false,
        fetchedAt: candidate.fetchedAt,
        extraWindows: candidate.reading.extras,
      });
    }
  }
  accounts.sort((left, right) => Number(left.label) - Number(right.label));

  const inventoryObserved = !malformed && !anonymous && !duplicate;
  const completeInventory =
    exitCode === 0 &&
    inventoryObserved &&
    candidates.every((candidate) => !candidate.error && candidate.reading !== null);
  const ambient =
    candidates.length === 0 && previous.length === 0 && anonymousSuccesses.length === 1 && !malformed
      ? (anonymousSuccesses[0] ?? null)
      : null;
  return { kind: "ok", accounts, completeInventory, inventoryObserved, ambient };
};
