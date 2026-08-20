/**
 * Shared contract for the quota snapshot — the per-provider usage/quota file
 * the daemon's quota collector publishes next to the session snapshot.
 *
 * This module is imported by both the Bun core (writer) and the strip app's
 * webview (reader), so it must stay free of runtime-specific imports, exactly
 * like src/protocol.ts. The session snapshot (snapshot-v2.json) and
 * src/protocol.ts are deliberately untouched: quota rides its own file.
 */

export const QUOTA_SNAPSHOT_SCHEMA_VERSION = 1;

/** Per-provider sample cap: at the 120s poll cadence, 128 samples cover ~4.3 hours. */
export const QUOTA_HISTORY_LIMIT = 128;

export const QUOTA_PROVIDER_KEYS = ["claude", "codex", "kimi", "zai"] as const;

export type QuotaProviderKey = (typeof QUOTA_PROVIDER_KEYS)[number];

export type QuotaHistoryPoint = {
  /** Canonical UTC ISO instant of the successful fetch. */
  fetchedAt: string;
  /** Session-window fraction remaining, 0..1. */
  fractionRemaining: number;
};

export type ProviderQuota = {
  /** Session (5-hour) window percent remaining, 0..100; null when no fetch has succeeded. */
  percentRemaining: number | null;
  /** Session window reset instant (canonical UTC ISO); null when unknown. */
  resetAt: string | null;
  /** Weekly window percent remaining, 0..100; null when unknown. */
  weeklyPercentRemaining: number | null;
  /** Weekly window reset instant (canonical UTC ISO); null when unknown. */
  weeklyResetAt: string | null;
  /** True when the most recent fetch failed; last-good numbers stay populated. */
  unavailable: boolean;
  /** Last successful fetch (canonical UTC ISO); null when never fetched. */
  fetchedAt: string | null;
  /** Bounded ring of session-window samples, oldest first. */
  history: QuotaHistoryPoint[];
};

export type QuotaSnapshot = {
  schemaVersion: 1;
  providers: Partial<Record<QuotaProviderKey, ProviderQuota>>;
};

const QUOTA_PROVIDERS: ReadonlySet<string> = new Set(QUOTA_PROVIDER_KEYS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Canonical UTC ISO (exactly what Date#toISOString emits) only: the round-trip
// check rejects date-only forms, omitted milliseconds, nonzero offsets, and
// rollover dates like 2026-02-30 that Date.parse tolerates in JavaScriptCore.
const isIsoInstant = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const isNullableIsoInstant = (value: unknown): value is string | null => value === null || isIsoInstant(value);

const isPercent = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

const isNullablePercent = (value: unknown): value is number | null => value === null || isPercent(value);

const isFraction = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const invalid = (reason: string): never => {
  throw new Error(`invalid quota snapshot: ${reason}`);
};

const parseHistoryPoint = (value: unknown): QuotaHistoryPoint => {
  if (!isRecord(value)) {
    return invalid("history point must be an object");
  }
  if (!isIsoInstant(value["fetchedAt"])) {
    return invalid("history point fetchedAt must be an ISO instant");
  }
  if (!isFraction(value["fractionRemaining"])) {
    return invalid("history point fractionRemaining must be a 0..1 number");
  }
  return { fetchedAt: value["fetchedAt"], fractionRemaining: value["fractionRemaining"] };
};

const parseProviderQuota = (value: unknown): ProviderQuota => {
  if (!isRecord(value)) {
    return invalid("provider quota must be an object");
  }
  if (!isNullablePercent(value["percentRemaining"])) {
    return invalid("provider percentRemaining must be null or a 0..100 number");
  }
  if (!isNullableIsoInstant(value["resetAt"])) {
    return invalid("provider resetAt must be null or an ISO instant");
  }
  if (!isNullablePercent(value["weeklyPercentRemaining"])) {
    return invalid("provider weeklyPercentRemaining must be null or a 0..100 number");
  }
  if (!isNullableIsoInstant(value["weeklyResetAt"])) {
    return invalid("provider weeklyResetAt must be null or an ISO instant");
  }
  if (typeof value["unavailable"] !== "boolean") {
    return invalid("provider unavailable must be a boolean");
  }
  if (!isNullableIsoInstant(value["fetchedAt"])) {
    return invalid("provider fetchedAt must be null or an ISO instant");
  }
  if (!Array.isArray(value["history"]) || value["history"].length > QUOTA_HISTORY_LIMIT) {
    return invalid(`provider history must be an array of at most ${QUOTA_HISTORY_LIMIT} points`);
  }
  return {
    percentRemaining: value["percentRemaining"],
    resetAt: value["resetAt"],
    weeklyPercentRemaining: value["weeklyPercentRemaining"],
    weeklyResetAt: value["weeklyResetAt"],
    unavailable: value["unavailable"],
    fetchedAt: value["fetchedAt"],
    history: value["history"].map(parseHistoryPoint),
  };
};

/**
 * Validate an unknown value as a quota snapshot, returning a newly constructed
 * snapshot. Unknown provider keys are ignored (not rejected) so a newer daemon
 * adding a provider never breaks an older strip app — a deliberate divergence
 * from src/protocol.ts's provider strictness, this file having exactly one
 * reader shipped in the same repo. Throws on any other contract violation; no
 * coercion.
 */
export const parseQuotaSnapshot = (value: unknown): QuotaSnapshot => {
  if (!isRecord(value)) {
    return invalid("snapshot must be an object");
  }
  if (value["schemaVersion"] !== QUOTA_SNAPSHOT_SCHEMA_VERSION) {
    return invalid(`schemaVersion must be ${QUOTA_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!isRecord(value["providers"])) {
    return invalid("providers must be an object");
  }
  const providers: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
  for (const key of Object.keys(value["providers"])) {
    if (!QUOTA_PROVIDERS.has(key)) {
      continue;
    }
    providers[key as QuotaProviderKey] = parseProviderQuota(value["providers"][key]);
  }
  return { schemaVersion: QUOTA_SNAPSHOT_SCHEMA_VERSION, providers };
};
