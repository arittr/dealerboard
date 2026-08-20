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
 *   ChatGPT-Account-Id header when tokens.account_id is present) and the fixed
 *   `User-Agent: stream-deck-agents` the researched contract prescribes. Windows:
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

export type ProviderQuotaReading = {
  /** Null when the provider reports no session-class window (e.g. codex weekly-only). */
  session: QuotaWindowReading | null;
  weekly: QuotaWindowReading | null;
};

export type CodexbarUsageParse =
  | { kind: "ok"; reading: ProviderQuotaReading }
  /** Valid JSON with no accounts — the provider is disabled in CodexBar. */
  | { kind: "absent" }
  | { kind: "invalid" };

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

/** CodexBar window lengths at or above this classify as the weekly window. */
const DAY_WINDOW_MINUTES = 1440;

type RawCodexbarWindow = { windowMinutes: number; usedPercent: number; resetsAt: string | null };

const parseCodexbarWindow = (value: unknown): RawCodexbarWindow | null => {
  if (!isRecord(value)) {
    return null;
  }
  const minutes = value["windowMinutes"];
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  if (!isPercentUsed(value["usedPercent"])) {
    return null;
  }
  return { windowMinutes: minutes, usedPercent: value["usedPercent"], resetsAt: isoOrNull(value["resetsAt"]) };
};

const toWindowReading = (window: RawCodexbarWindow): QuotaWindowReading => ({
  percentRemaining: 100 - window.usedPercent,
  resetAt: window.resetsAt,
});

const classifyCodexbarWindows = (windows: readonly RawCodexbarWindow[]): ProviderQuotaReading | null => {
  let weekly: RawCodexbarWindow | null = null;
  let session: RawCodexbarWindow | null = null;
  for (const window of windows) {
    if (window.windowMinutes >= DAY_WINDOW_MINUTES) {
      if (weekly === null || window.windowMinutes > weekly.windowMinutes) {
        weekly = window;
      }
    } else if (session === null || window.windowMinutes < session.windowMinutes) {
      session = window;
    }
  }
  if (session === null && weekly === null) {
    return null;
  }
  return {
    session: session === null ? null : toWindowReading(session),
    weekly: weekly === null ? null : toWindowReading(weekly),
  };
};

export const parseCodexbarUsage = (body: string): CodexbarUsageParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "invalid" };
  }
  if (!Array.isArray(parsed)) {
    return { kind: "invalid" };
  }
  if (parsed.length === 0) {
    return { kind: "absent" };
  }
  const entry: unknown = parsed[0];
  if (!isRecord(entry) || !isRecord(entry["usage"])) {
    return { kind: "invalid" };
  }
  const usage = entry["usage"];
  const windows: RawCodexbarWindow[] = [];
  for (const key of ["primary", "secondary", "tertiary"] as const) {
    const window = parseCodexbarWindow(usage[key]);
    if (window !== null) {
      windows.push(window);
    }
  }
  let reading = classifyCodexbarWindows(windows);
  // Codex can report primary: null with the 5-hour data under extraRateWindows.
  if (reading !== null && reading.session === null && Array.isArray(usage["extraRateWindows"])) {
    const extras: RawCodexbarWindow[] = [];
    for (const extra of usage["extraRateWindows"]) {
      const window = parseCodexbarWindow(isRecord(extra) ? extra["window"] : null);
      if (window !== null) {
        extras.push(window);
      }
    }
    reading = classifyCodexbarWindows([...windows, ...extras]);
  }
  return reading === null ? { kind: "invalid" } : { kind: "ok", reading };
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
  /** Poll immediately, then arm the interval. Idempotent while started. */
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

type ProviderState = { quota: ProviderQuota; cooldownUntilMs: number | null; failed: boolean };

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
  let started = false;
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
          // A seeded unavailable row is already in the failed state — its
          // continuation must not re-log, only a good→failed transition may.
          states.set(key, { quota, cooldownUntilMs: null, failed: quota.unavailable });
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
    } else if (provider === "codex") {
      const contents = readFile(dependencies.codexAuthPath);
      const auth = contents === null ? null : parseCodexAuth(contents);
      if (auth === null) {
        return { kind: "absent" };
      }
      url = CODEX_USAGE_URL;
      headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: "application/json",
        "User-Agent": "stream-deck-agents",
      };
      if (auth.accountId !== null) {
        headers["ChatGPT-Account-Id"] = auth.accountId;
      }
    } else {
      // kimi and zai have no direct HTTP fetcher — omit them (the panel
      // disappears) until the codexbar exec rewrite owns their probes.
      return { kind: "absent" };
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
    // A fresh row displays unavailable (never fetched) but has not yet failed —
    // `failed` tracks the diagnostic transition, separately from that display.
    const state = states.get(provider) ?? { quota: emptyQuota(), cooldownUntilMs: null, failed: false };
    const inCooldown = state.cooldownUntilMs !== null && nowMs() < state.cooldownUntilMs;
    const outcome = inCooldown ? ({ kind: "failed", rateLimited: true } as const) : await probe(provider);
    if (outcome.kind === "absent") {
      states.delete(provider);
      return null;
    }
    if (outcome.kind === "ok") {
      const fetchedAt = now();
      // The history ring records the session window only — a weekly-only
      // reading leaves the ring untouched.
      const history =
        outcome.reading.session === null
          ? state.quota.history
          : [
              ...state.quota.history,
              { fetchedAt, fractionRemaining: outcome.reading.session.percentRemaining / 100 },
            ].slice(-QUOTA_HISTORY_LIMIT);
      const quota: ProviderQuota = {
        percentRemaining: outcome.reading.session?.percentRemaining ?? null,
        resetAt: outcome.reading.session?.resetAt ?? null,
        weeklyPercentRemaining: outcome.reading.weekly?.percentRemaining ?? null,
        weeklyResetAt: outcome.reading.weekly?.resetAt ?? null,
        unavailable: false,
        fetchedAt,
        history,
      };
      states.set(provider, { quota, cooldownUntilMs: null, failed: false });
      return quota;
    }
    if (outcome.rateLimited && !inCooldown) {
      // Re-arm only on a 429 from a real fetch — a synthetic cooldown skip
      // must not extend the cooldown.
      state.cooldownUntilMs = nowMs() + QUOTA_RATE_LIMIT_COOLDOWN_MS;
    }
    if (!state.failed) {
      // Log the transition into failure only — never per pass, never error text.
      reportFailure(provider);
    }
    state.failed = true;
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
    } catch {
      // The exported contract promises pollNow never throws. An unexpected
      // dependency/runtime exception is contained here — one provider-less
      // fixed diagnostic, never error text — and the next pass retries.
      try {
        diagnostics({ timestamp: now(), component: DIAGNOSTIC_COMPONENT, code: "quota_failed" });
      } catch {
        // Diagnostics must never break the collector.
      }
    } finally {
      polling = false;
    }
  };

  // Detached polls rely on pollNow's containment: it never rejects, so a
  // fire-and-forget call can never become an unhandled rejection.
  const pollQuietly = (): void => {
    void pollNow();
  };

  return {
    start: () => {
      if (started) {
        return;
      }
      started = true;
      pollQuietly();
      cancelSchedule = schedule(() => {
        pollQuietly();
      }, QUOTA_POLL_INTERVAL_MS);
    },
    stop: () => {
      started = false;
      cancelSchedule?.();
      cancelSchedule = null;
    },
    pollNow,
  };
};
