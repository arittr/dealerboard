/**
 * Shared contract for the token-usage snapshot — the aggregate token-throughput
 * file the daemon's token-usage collector publishes next to the session
 * snapshot.
 *
 * This module is imported by both the Bun core (writer) and the strip app's
 * webview (reader), so it must stay free of runtime-specific imports, exactly
 * like src/quota-snapshot.ts. The session snapshot (snapshot-v2.json) and
 * src/protocol.ts are deliberately untouched: token usage rides its own file.
 */

export const TOKEN_USAGE_SNAPSHOT_SCHEMA_VERSION = 1;

/** At the 30s poll cadence, 288 samples cover ~2.4h — the 1h rate window plus its trend-comparison window. */
export const TOKEN_USAGE_SAMPLE_LIMIT = 288;

/** One day-curve point per 15 minutes covers 24h; the collector's running max keeps totals monotone. */
export const TOKEN_USAGE_DAY_CURVE_POINT_LIMIT = 96;

export type TokenUsageSample = {
  /** Canonical UTC ISO instant of the successful poll. */
  fetchedAt: string;
  /** Cumulative LA-day total across all agents (tokenmaxxing_total_v1). */
  totalTokens: number;
  /** America/Los_Angeles calendar date, YYYY-MM-DD. */
  providerDay: string;
};

export type TokenUsageDayCurvePoint = { fetchedAt: string; totalTokens: number };
export type TokenUsageDayCurve = { providerDay: string; points: TokenUsageDayCurvePoint[] };
export type TokenUsageDayCurves = { today: TokenUsageDayCurve; yesterday: TokenUsageDayCurve | null };

export type TokenUsageSnapshot = {
  schemaVersion: 1;
  /** LA calendar date the totals belong to, YYYY-MM-DD. */
  providerDay: string;
  /** Today's cumulative total (input + output + cacheCreation + cacheRead). */
  totalTokens: number;
  /** True when the most recent poll failed; last-good numbers stay populated. */
  unavailable: boolean;
  /** Last successful poll (canonical UTC ISO); null when never polled. */
  fetchedAt: string | null;
  /** Bounded ring of cumulative samples, oldest first. */
  samples: TokenUsageSample[];
  /** Additive under schemaVersion 1 — the parser ignores unknown top-level keys, so an old app is untouched by this key. */
  dayCurves?: TokenUsageDayCurves;
};

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

// A real calendar date in YYYY-MM-DD form only: Date parsing of a date-only
// string tolerates rollover (2026-02-30 becomes March 2), so anchor to a UTC
// midnight instant and compare the serialized form back against the input.
const isProviderDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const invalid = (reason: string): never => {
  throw new Error(`invalid token-usage snapshot: ${reason}`);
};

const parseSample = (value: unknown): TokenUsageSample => {
  if (!isRecord(value)) {
    return invalid("sample must be an object");
  }
  if (!isIsoInstant(value["fetchedAt"])) {
    return invalid("sample fetchedAt must be an ISO instant");
  }
  if (!isTokenCount(value["totalTokens"])) {
    return invalid("sample totalTokens must be a non-negative finite number");
  }
  if (!isProviderDay(value["providerDay"])) {
    return invalid("sample providerDay must be YYYY-MM-DD");
  }
  return { fetchedAt: value["fetchedAt"], totalTokens: value["totalTokens"], providerDay: value["providerDay"] };
};

const parseDayCurvePoint = (value: unknown): TokenUsageDayCurvePoint => {
  if (!isRecord(value) || !isIsoInstant(value["fetchedAt"]) || !isTokenCount(value["totalTokens"])) {
    return invalid("day-curve point must have an ISO fetchedAt and a token count");
  }
  return { fetchedAt: value["fetchedAt"], totalTokens: value["totalTokens"] };
};

const parseDayCurve = (value: unknown): TokenUsageDayCurve => {
  if (!isRecord(value) || !isProviderDay(value["providerDay"])) {
    return invalid("day curve must carry a YYYY-MM-DD providerDay");
  }
  if (!Array.isArray(value["points"]) || value["points"].length > TOKEN_USAGE_DAY_CURVE_POINT_LIMIT) {
    return invalid(`day curve points must be an array of at most ${TOKEN_USAGE_DAY_CURVE_POINT_LIMIT}`);
  }
  const points = value["points"].map(parseDayCurvePoint);
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (current.fetchedAt <= previous.fetchedAt) {
      return invalid("day curve points must be strictly increasing in time");
    }
    if (current.totalTokens < previous.totalTokens) {
      return invalid("day curve totals must be non-decreasing");
    }
  }
  return { providerDay: value["providerDay"], points };
};

const parseDayCurves = (value: unknown): TokenUsageDayCurves => {
  if (!isRecord(value)) {
    return invalid("dayCurves must be an object");
  }
  return {
    today: parseDayCurve(value["today"]),
    yesterday: value["yesterday"] === null ? null : parseDayCurve(value["yesterday"]),
  };
};

/**
 * Validate an unknown value as a token-usage snapshot, returning a newly
 * constructed snapshot. Unknown top-level keys are ignored (not rejected) so a
 * newer daemon adding a field never breaks an older strip app. Throws on any
 * other contract violation; no coercion.
 */
export const parseTokenUsageSnapshot = (value: unknown): TokenUsageSnapshot => {
  if (!isRecord(value)) {
    return invalid("snapshot must be an object");
  }
  if (value["schemaVersion"] !== TOKEN_USAGE_SNAPSHOT_SCHEMA_VERSION) {
    return invalid(`schemaVersion must be ${TOKEN_USAGE_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!isProviderDay(value["providerDay"])) {
    return invalid("providerDay must be YYYY-MM-DD");
  }
  if (!isTokenCount(value["totalTokens"])) {
    return invalid("totalTokens must be a non-negative finite number");
  }
  if (typeof value["unavailable"] !== "boolean") {
    return invalid("unavailable must be a boolean");
  }
  if (!isNullableIsoInstant(value["fetchedAt"])) {
    return invalid("fetchedAt must be null or an ISO instant");
  }
  if (!Array.isArray(value["samples"]) || value["samples"].length > TOKEN_USAGE_SAMPLE_LIMIT) {
    return invalid(`samples must be an array of at most ${TOKEN_USAGE_SAMPLE_LIMIT} points`);
  }
  const rawDayCurves = value["dayCurves"];
  const dayCurves = rawDayCurves === undefined ? undefined : parseDayCurves(rawDayCurves);
  return {
    schemaVersion: TOKEN_USAGE_SNAPSHOT_SCHEMA_VERSION,
    providerDay: value["providerDay"],
    totalTokens: value["totalTokens"],
    unavailable: value["unavailable"],
    fetchedAt: value["fetchedAt"],
    samples: value["samples"].map(parseSample),
    ...(dayCurves === undefined ? {} : { dayCurves }),
  };
};
