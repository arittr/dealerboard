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

import { readFileSync } from "node:fs";
import {
  type ProviderQuota,
  parseQuotaSnapshot,
  QUOTA_HISTORY_LIMIT,
  QUOTA_PROVIDER_KEYS,
  type QuotaProviderKey,
  type QuotaSnapshot,
} from "../quota-snapshot";
import type { DiagnosticRecord } from "./diagnostics";
import { writeFileAtomically } from "./snapshot";

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
  // TimeClip maps any ms beyond ±8.64e15 to NaN (ECMA-262), so a non-finite
  // getTime() covers both overflow modes (multiplication to Infinity and
  // finite-but-out-of-range) — and toISOString() would throw on it.
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return date.toISOString();
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

/** Quota endpoints rate-limit (Anthropic 429s aggressive pollers) and the windows move slowly. */
export const QUOTA_POLL_INTERVAL_MS = 120_000;
/** After a 429, skip that provider for this long before retrying. */
export const QUOTA_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;
export const QUOTA_FETCH_TIMEOUT_MS = 15_000;

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DIAGNOSTIC_COMPONENT = "quota";

export type QuotaFetchResponse = { status: number; body: string };

export type QuotaFetch = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<QuotaFetchResponse>;

/** Same shape as the daemon's DaemonScheduler: arms a recurring tick, returns a disarm callback. */
export type QuotaScheduler = (tick: () => void, intervalMs: number) => () => void;

export type QuotaCollectorDependencies = {
  claudeCredentialsPath: string;
  codexAuthPath: string;
  quotaSnapshotPath: string;
  fetch?: QuotaFetch;
  readFile?: (path: string) => string | null;
  now?: () => string;
  nowMs?: () => number;
  writeFile?: (path: string, payload: string) => void;
  schedule?: QuotaScheduler;
  diagnostics?: (record: DiagnosticRecord) => void;
};

export type QuotaCollector = {
  /** Poll immediately, then arm the interval. */
  start: () => void;
  /** Disarm the interval; an in-flight fetch settles on its own. */
  stop: () => void;
  /** One collection pass; reentrancy-guarded, never throws. */
  pollNow: () => Promise<void>;
};

type FetchOutcome =
  | { kind: "ok"; reading: ProviderQuotaReading }
  /** No usable credentials on disk — the provider is omitted (the panel disappears). */
  | { kind: "absent" }
  | { kind: "failed"; rateLimited: boolean };

type ProviderState = { quota: ProviderQuota; cooldownUntilMs: number | null };

const emptyQuota = (): ProviderQuota => ({
  percentRemaining: null,
  resetAt: null,
  weeklyPercentRemaining: null,
  weeklyResetAt: null,
  unavailable: true,
  fetchedAt: null,
  history: [],
});

const defaultReadFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const defaultFetch: QuotaFetch = async (url, headers, timeoutMs) => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, body: await response.text() };
};

const defaultSchedule: QuotaScheduler = (tick, intervalMs) => {
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
};

export const createQuotaCollector = (dependencies: QuotaCollectorDependencies): QuotaCollector => {
  const doFetch = dependencies.fetch ?? defaultFetch;
  const readFile = dependencies.readFile ?? defaultReadFile;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const nowMs = dependencies.nowMs ?? (() => Date.now());
  const writeFile = dependencies.writeFile ?? writeFileAtomically;
  const schedule = dependencies.schedule ?? defaultSchedule;
  const diagnostics = dependencies.diagnostics ?? (() => {});

  const states = new Map<QuotaProviderKey, ProviderState>();
  let lastWrittenJson: string | null = null;
  let polling = false;
  let cancelSchedule: (() => void) | null = null;

  const reportFailure = (provider: QuotaProviderKey): void => {
    try {
      diagnostics({ timestamp: now(), component: DIAGNOSTIC_COMPONENT, code: "quota_failed", provider });
    } catch {
      // Diagnostics must never break the collector.
    }
  };

  // Seed last-good state from the previous publication so a daemon restart
  // never blanks the panels.
  try {
    const existing = readFile(dependencies.quotaSnapshotPath);
    if (existing !== null) {
      const seeded = parseQuotaSnapshot(JSON.parse(existing));
      for (const key of QUOTA_PROVIDER_KEYS) {
        const quota = seeded.providers[key];
        if (quota !== undefined) {
          states.set(key, { quota, cooldownUntilMs: null });
        }
      }
      lastWrittenJson = `${JSON.stringify(seeded)}\n`;
    }
  } catch {
    // An unreadable or unparseable file is simply rewritten on the first pass.
  }

  const probe = async (provider: QuotaProviderKey): Promise<FetchOutcome> => {
    let url: string;
    let headers: Record<string, string>;
    if (provider === "claude") {
      const contents = readFile(dependencies.claudeCredentialsPath);
      const credentials = contents === null ? null : parseClaudeCredentials(contents);
      if (credentials === null) {
        return { kind: "absent" };
      }
      if ((credentials.expiresAtMs !== null && credentials.expiresAtMs <= nowMs()) || !credentials.hasProfileScope) {
        return { kind: "failed", rateLimited: false };
      }
      url = CLAUDE_USAGE_URL;
      headers = {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
      };
    } else {
      const contents = readFile(dependencies.codexAuthPath);
      const auth = contents === null ? null : parseCodexAuth(contents);
      if (auth === null) {
        return { kind: "absent" };
      }
      url = CODEX_USAGE_URL;
      headers = { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" };
      if (auth.accountId !== null) {
        headers["ChatGPT-Account-Id"] = auth.accountId;
      }
    }
    let response: QuotaFetchResponse;
    try {
      response = await doFetch(url, headers, QUOTA_FETCH_TIMEOUT_MS);
    } catch {
      return { kind: "failed", rateLimited: false };
    }
    if (response.status === 429) {
      return { kind: "failed", rateLimited: true };
    }
    if (response.status !== 200) {
      return { kind: "failed", rateLimited: false };
    }
    const reading = provider === "claude" ? normalizeClaudeUsage(response.body) : normalizeCodexUsage(response.body);
    return reading === null ? { kind: "failed", rateLimited: false } : { kind: "ok", reading };
  };

  const pollProvider = async (provider: QuotaProviderKey): Promise<ProviderQuota | null> => {
    const state = states.get(provider) ?? { quota: emptyQuota(), cooldownUntilMs: null };
    const inCooldown = state.cooldownUntilMs !== null && nowMs() < state.cooldownUntilMs;
    const outcome = inCooldown ? ({ kind: "failed", rateLimited: true } as const) : await probe(provider);
    if (outcome.kind === "absent") {
      states.delete(provider);
      return null;
    }
    if (outcome.kind === "ok") {
      const fetchedAt = now();
      const history = [
        ...state.quota.history,
        { fetchedAt, fractionRemaining: outcome.reading.session.percentRemaining / 100 },
      ].slice(-QUOTA_HISTORY_LIMIT);
      const quota: ProviderQuota = {
        percentRemaining: outcome.reading.session.percentRemaining,
        resetAt: outcome.reading.session.resetAt,
        weeklyPercentRemaining: outcome.reading.weekly?.percentRemaining ?? null,
        weeklyResetAt: outcome.reading.weekly?.resetAt ?? null,
        unavailable: false,
        fetchedAt,
        history,
      };
      states.set(provider, { quota, cooldownUntilMs: null });
      return quota;
    }
    if (outcome.rateLimited && state.cooldownUntilMs === null) {
      state.cooldownUntilMs = nowMs() + QUOTA_RATE_LIMIT_COOLDOWN_MS;
    }
    if (!state.quota.unavailable) {
      // Log the transition into failure only — never per pass, never error text.
      reportFailure(provider);
    }
    state.quota = { ...state.quota, unavailable: true };
    states.set(provider, state);
    return state.quota;
  };

  const pollNow = async (): Promise<void> => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      const providers: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
      for (const provider of QUOTA_PROVIDER_KEYS) {
        const quota = await pollProvider(provider);
        if (quota !== null) {
          providers[provider] = quota;
        }
      }
      const snapshot: QuotaSnapshot = { schemaVersion: 1, providers };
      const json = `${JSON.stringify(snapshot)}\n`;
      if (json !== lastWrittenJson) {
        try {
          writeFile(dependencies.quotaSnapshotPath, json);
          lastWrittenJson = json;
        } catch {
          // A publication I/O failure retries on the next pass.
        }
      }
    } finally {
      polling = false;
    }
  };

  return {
    start: () => {
      void pollNow();
      cancelSchedule = schedule(() => {
        void pollNow();
      }, QUOTA_POLL_INTERVAL_MS);
    },
    stop: () => {
      cancelSchedule?.();
      cancelSchedule = null;
    },
    pollNow,
  };
};
