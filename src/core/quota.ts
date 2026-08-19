/**
 * Quota collection for the strip's rail panels (codex + claude).
 *
 * Endpoint contract (researched from CodexBar's source — docs/superpowers/plans/
 * 2026-08-19-xeneon-strip-quota.md records the citations):
 * - claude: GET https://api.anthropic.com/api/oauth/usage with the OAuth access
 *   token from ~/.claude/.credentials.json (claudeAiOauth.accessToken), headers
 *   `anthropic-beta: oauth-2025-04-20` and a claude-code User-Agent. Windows:
 *   five_hour / seven_day, each { utilization (percent used 0..100), resets_at
 *   (ISO) }. Tokens are never refreshed or written back — Claude Code owns
 *   rotation and the file is re-read every pass.
 * - codex: GET https://chatgpt.com/backend-api/wham/usage with the OAuth access
 *   token from ($CODEX_HOME ?? ~/.codex)/auth.json (tokens.access_token, plus a
 *   ChatGPT-Account-Id header when tokens.account_id is present). Windows:
 *   rate_limit.primary_window / secondary_window, each { used_percent (0..100),
 *   reset_at (epoch seconds) }. An auth.json holding only OPENAI_API_KEY has no
 *   quota surface and is treated as absent.
 *
 * No token, response body, or error text is ever logged or written anywhere.
 */

export type ClaudeCredentials = {
  accessToken: string;
  /** claudeAiOauth.expiresAt, epoch milliseconds; null when absent. */
  expiresAtMs: number | null;
  /** The usage endpoint requires the user:profile scope (inference-only tokens get 403s). */
  hasProfileScope: boolean;
};

export type CodexAuth = { accessToken: string; accountId: string | null };

export type QuotaWindowReading = { percentRemaining: number; resetAt: string | null };

export type ProviderQuotaReading = { session: QuotaWindowReading; weekly: QuotaWindowReading | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPercentUsed = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

/** Normalize a provider ISO string to canonical UTC; unparseable → null. */
const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

const epochSecondsOrNull = (value: unknown): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000).toISOString();
};

export const parseClaudeCredentials = (contents: string): ClaudeCredentials | null => {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isRecord(parsed) || !isRecord(parsed["claudeAiOauth"])) {
      return null;
    }
    const oauth = parsed["claudeAiOauth"];
    if (typeof oauth["accessToken"] !== "string" || oauth["accessToken"].length === 0) {
      return null;
    }
    const expiresAt = oauth["expiresAt"];
    const scopes = oauth["scopes"];
    return {
      accessToken: oauth["accessToken"],
      expiresAtMs: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null,
      hasProfileScope: Array.isArray(scopes) && scopes.includes("user:profile"),
    };
  } catch {
    return null;
  }
};

export const parseCodexAuth = (contents: string): CodexAuth | null => {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isRecord(parsed) || !isRecord(parsed["tokens"])) {
      return null;
    }
    const tokens = parsed["tokens"];
    const accessToken = tokens["access_token"] ?? tokens["accessToken"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      return null;
    }
    const accountId = tokens["account_id"] ?? tokens["accountId"];
    return {
      accessToken,
      accountId: typeof accountId === "string" && accountId.length > 0 ? accountId : null,
    };
  } catch {
    return null;
  }
};

export const normalizeClaudeUsage = (body: string): ProviderQuotaReading | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed["five_hour"]) || !isPercentUsed(parsed["five_hour"]["utilization"])) {
    return null;
  }
  const session: QuotaWindowReading = {
    percentRemaining: 100 - parsed["five_hour"]["utilization"],
    resetAt: isoOrNull(parsed["five_hour"]["resets_at"]),
  };
  let weekly: QuotaWindowReading | null = null;
  const sevenDay = parsed["seven_day"];
  if (isRecord(sevenDay) && isPercentUsed(sevenDay["utilization"])) {
    weekly = { percentRemaining: 100 - sevenDay["utilization"], resetAt: isoOrNull(sevenDay["resets_at"]) };
  }
  return { session, weekly };
};

export const normalizeCodexUsage = (body: string): ProviderQuotaReading | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed["rate_limit"])) {
    return null;
  }
  const rateLimit = parsed["rate_limit"];
  const primary = rateLimit["primary_window"];
  if (!isRecord(primary) || !isPercentUsed(primary["used_percent"])) {
    return null;
  }
  const session: QuotaWindowReading = {
    percentRemaining: 100 - primary["used_percent"],
    resetAt: epochSecondsOrNull(primary["reset_at"]),
  };
  let weekly: QuotaWindowReading | null = null;
  const secondary = rateLimit["secondary_window"];
  if (isRecord(secondary) && isPercentUsed(secondary["used_percent"])) {
    weekly = { percentRemaining: 100 - secondary["used_percent"], resetAt: epochSecondsOrNull(secondary["reset_at"]) };
  }
  return { session, weekly };
};
