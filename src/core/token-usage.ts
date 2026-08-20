/**
 * Token-usage collection for the strip's rail block.
 *
 * Shells out to the local `agentsview` helper (the same reporter glorp uses)
 * for the America/Los_Angeles day's cumulative token totals, and keeps a
 * bounded ring of cumulative samples so the strip can difference rolling
 * windows. The total contract is tokenmaxxing_total_v1: input + output +
 * cacheCreation + cacheRead (cache reads count fully; reasoning output is
 * excluded).
 *
 * agentsview's output and error text are never logged or written anywhere.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseTokenUsageSnapshot, TOKEN_USAGE_SAMPLE_LIMIT, type TokenUsageSnapshot } from "../token-usage-snapshot";
import type { TextProcessExecutor } from "./claude-ghostty-binding";
import type { DiagnosticRecord } from "./diagnostics";
import { writeFileAtomically } from "./snapshot";

export { TOKEN_USAGE_SAMPLE_LIMIT };

export const TOKEN_USAGE_POLL_INTERVAL_MS = 30_000;
export const TOKEN_USAGE_RUN_TIMEOUT_MS = 15_000;
/** agentsview embeds a pricing table in its JSON; the daily row we need is small. */
const AGENTSVIEW_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TOKEN_USAGE_TIMEZONE = "America/Los_Angeles";
const HOMEBREW_AGENTSVIEW_BIN = "/opt/homebrew/bin/agentsview";
const DIAGNOSTIC_COMPONENT = "token-usage";

export type TokenUsageRunner = TextProcessExecutor;

/** Same shape as the daemon's DaemonScheduler: arms a recurring tick, returns a disarm callback. */
export type TokenUsageScheduler = (tick: () => void, intervalMs: number) => () => void;

export type TokenUsageCollectorDependencies = {
  agentsviewBin: string;
  tokenUsageSnapshotPath: string;
  run?: TokenUsageRunner;
  readFile?: (path: string) => string | null;
  now?: () => string;
  nowMs?: () => number;
  writeFile?: (path: string, payload: string) => void;
  schedule?: TokenUsageScheduler;
  diagnostics?: (record: DiagnosticRecord) => void;
};

export type TokenUsageCollector = {
  /** Poll immediately, then arm the interval. Idempotent while started. */
  start: () => void;
  /** Disarm the interval; an in-flight run settles on its own. */
  stop: () => void;
  /** One collection pass; reentrancy-guarded, never throws. */
  pollNow: () => Promise<void>;
};

const laDayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TOKEN_USAGE_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The America/Los_Angeles calendar date (YYYY-MM-DD) for an instant, assembled part-wise so locale ordering can't leak in. */
export const laProviderDay = (date: Date): string => {
  const parts = laDayFormat.formatToParts(date);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

/** Where the collector looks for the helper: env override, the homebrew default, then PATH. */
export const resolveAgentsviewBin = (
  environment: Record<string, string | undefined>,
  existsFile: (path: string) => boolean = existsSync,
): string => {
  const override = environment["AGENTSVIEW_BIN"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return existsFile(HOMEBREW_AGENTSVIEW_BIN) ? HOMEBREW_AGENTSVIEW_BIN : "agentsview";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const tokenCount = (row: Record<string, unknown>, key: string): number | null => {
  const value = row[key];
  return isTokenCount(value) ? value : null;
};

/**
 * Parse one agentsview `usage daily --json` report down to the providerDay
 * row's tokenmaxxing_total_v1. A report with no row for the day is a
 * legitimate zero (nothing burned yet); any contract violation — wrong
 * schema, malformed JSON, a present row with bad fields — is null (a failed
 * poll).
 */
export const normalizeAgentsviewDaily = (body: string, providerDay: string): number | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["schema_version"] !== 4 || !Array.isArray(parsed["daily"])) {
    return null;
  }
  for (const entry of parsed["daily"]) {
    if (!isRecord(entry) || entry["date"] !== providerDay) {
      continue;
    }
    const input = tokenCount(entry, "inputTokens");
    const output = tokenCount(entry, "outputTokens");
    const cacheCreation = tokenCount(entry, "cacheCreationTokens");
    const cacheRead = tokenCount(entry, "cacheReadTokens");
    if (input === null || output === null || cacheCreation === null || cacheRead === null) {
      return null;
    }
    return input + output + cacheCreation + cacheRead;
  }
  return 0;
};

const emptySnapshot = (providerDay: string): TokenUsageSnapshot => ({
  schemaVersion: 1,
  providerDay,
  totalTokens: 0,
  unavailable: true,
  fetchedAt: null,
  samples: [],
});

const defaultRunner: TokenUsageRunner = (file, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: AGENTSVIEW_MAX_OUTPUT_BYTES },
      (error, stdout) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        reject(error);
      },
    );
  });

const defaultReadFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const defaultSchedule: TokenUsageScheduler = (tick, intervalMs) => {
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
};

type CollectorState = { snapshot: TokenUsageSnapshot; failed: boolean };

export const createTokenUsageCollector = (dependencies: TokenUsageCollectorDependencies): TokenUsageCollector => {
  const run = dependencies.run ?? defaultRunner;
  const readFile = dependencies.readFile ?? defaultReadFile;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const nowMs = dependencies.nowMs ?? (() => Date.now());
  const writeFile = dependencies.writeFile ?? writeFileAtomically;
  const schedule = dependencies.schedule ?? defaultSchedule;
  const diagnostics = dependencies.diagnostics ?? (() => {});

  let state: CollectorState = { snapshot: emptySnapshot(laProviderDay(new Date(nowMs()))), failed: false };
  let lastWrittenJson: string | null = null;
  let polling = false;
  let started = false;
  let cancelSchedule: (() => void) | null = null;

  const reportFailure = (): void => {
    try {
      diagnostics({ timestamp: now(), component: DIAGNOSTIC_COMPONENT, code: "token_usage_failed" });
    } catch {
      // Diagnostics must never break the collector.
    }
  };

  // Seed last-good state from the previous publication so a daemon restart
  // never blanks the block (or its rate windows).
  try {
    const existing = readFile(dependencies.tokenUsageSnapshotPath);
    if (existing !== null) {
      const seeded = parseTokenUsageSnapshot(JSON.parse(existing));
      // A seeded unavailable snapshot is already in the failed state — its
      // continuation must not re-log, only a good→failed transition may.
      state = { snapshot: seeded, failed: seeded.unavailable };
      lastWrittenJson = `${JSON.stringify(seeded)}\n`;
    }
  } catch {
    // An unreadable or unparseable file is simply rewritten on the first pass.
  }

  const pollNow = async (): Promise<void> => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      const providerDay = laProviderDay(new Date(nowMs()));
      let total: number | null = null;
      try {
        const output = await run(
          dependencies.agentsviewBin,
          ["usage", "daily", "--json", "--timezone", TOKEN_USAGE_TIMEZONE, "--since", providerDay],
          TOKEN_USAGE_RUN_TIMEOUT_MS,
        );
        total = normalizeAgentsviewDaily(output, providerDay);
      } catch {
        total = null;
      }
      if (total === null) {
        if (!state.failed) {
          reportFailure();
        }
        state = { snapshot: { ...state.snapshot, unavailable: true }, failed: true };
      } else {
        const fetchedAt = now();
        const samples = [...state.snapshot.samples, { fetchedAt, totalTokens: total, providerDay }].slice(
          -TOKEN_USAGE_SAMPLE_LIMIT,
        );
        state = {
          snapshot: { schemaVersion: 1, providerDay, totalTokens: total, unavailable: false, fetchedAt, samples },
          failed: false,
        };
      }
      const json = `${JSON.stringify(state.snapshot)}\n`;
      if (json !== lastWrittenJson) {
        try {
          writeFile(dependencies.tokenUsageSnapshotPath, json);
          lastWrittenJson = json;
        } catch {
          // A publication I/O failure retries on the next pass.
        }
      }
    } catch {
      // The exported contract promises pollNow never throws. An unexpected
      // dependency/runtime exception is contained here — one fixed diagnostic,
      // never error text — and the next pass retries.
      reportFailure();
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
      }, TOKEN_USAGE_POLL_INTERVAL_MS);
    },
    stop: () => {
      started = false;
      cancelSchedule?.();
      cancelSchedule = null;
    },
    pollNow,
  };
};
