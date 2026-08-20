/**
 * Quota collection for the strip's rail panels (claude, codex, kimi, GLM/zai).
 *
 * All four providers are read through the locally installed CodexBar CLI:
 * `codexbar usage --provider <key> --format json --log-level critical`, spawned
 * once per provider per pass (serialized — CodexBar's app-support directory
 * carries lock files). The binary resolves per pass from
 * CODEXBAR_BINARY_CANDIDATES; a missing binary omits every provider. CodexBar's
 * primary/secondary labels are not positional (kimi reports the weekly window
 * as primary), so windows are classified by windowMinutes: weekly = the longest
 * window of at least a day, session = the shortest window under a day, and
 * usage.extraRateWindows is scanned when the main trio yields no session window
 * (codex reports primary: null with the Spark windows there). A provider
 * disabled in the CodexBar app prints an empty array and is omitted.
 *
 * Nothing the process prints is ever logged or persisted beyond the derived
 * numbers in the published snapshot.
 */

import { existsSync, readFileSync } from "node:fs";
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

/** Quota windows move slowly; CodexBar itself polls providers on a similar cadence. */
export const QUOTA_POLL_INTERVAL_MS = 120_000;
export const QUOTA_EXEC_TIMEOUT_MS = 15_000;

export const CODEXBAR_BINARY_CANDIDATES = [
  "/opt/homebrew/bin/codexbar",
  "/usr/local/bin/codexbar",
  "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI",
] as const;

const DIAGNOSTIC_COMPONENT = "quota";

export type QuotaExecResult = { exitCode: number; stdout: string };

/** Resolves instead of rejecting: spawn failure and timeout surface as a nonzero exit code. */
export type QuotaExec = (args: string[], timeoutMs: number) => Promise<QuotaExecResult>;

/** Same shape as the daemon's DaemonScheduler: arms a recurring tick, returns a disarm callback. */
export type QuotaScheduler = (tick: () => void, intervalMs: number) => () => void;

export type QuotaCollectorDependencies = {
  quotaSnapshotPath: string;
  exec?: QuotaExec;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string | null;
  now?: () => string;
  writeFile?: (path: string, payload: string) => void;
  schedule?: QuotaScheduler;
  diagnostics?: (record: DiagnosticRecord) => void;
};

export type QuotaCollector = {
  /** Poll immediately, then arm the interval. Idempotent while started. */
  start: () => void;
  /** Disarm the interval; an in-flight exec settles on its own. */
  stop: () => void;
  /** One collection pass; reentrancy-guarded, never throws. */
  pollNow: () => Promise<void>;
};

type FetchOutcome =
  | { kind: "ok"; reading: ProviderQuotaReading }
  /** Binary missing or provider disabled in CodexBar — the panel disappears. */
  | { kind: "absent" }
  | { kind: "failed" };

type ProviderState = { quota: ProviderQuota; failed: boolean };

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

const codexbarArgs = (provider: QuotaProviderKey): string[] => [
  "usage",
  "--provider",
  provider,
  "--format",
  "json",
  "--log-level",
  "critical",
];

const spawnExec =
  (binaryPath: string): QuotaExec =>
  async (args, timeoutMs) => {
    try {
      const process = Bun.spawn([binaryPath, ...args], { stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => {
        process.kill();
      }, timeoutMs);
      try {
        const stream = process.stdout;
        const stdout = stream === null ? "" : await new Response(stream).text();
        const exitCode = await process.exited;
        return { exitCode, stdout };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { exitCode: -1, stdout: "" };
    }
  };

const defaultSchedule: QuotaScheduler = (tick, intervalMs) => {
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
};

export const createQuotaCollector = (dependencies: QuotaCollectorDependencies): QuotaCollector => {
  const fileExists = dependencies.fileExists ?? ((path: string): boolean => existsSync(path));
  const readFile = dependencies.readFile ?? defaultReadFile;
  const now = dependencies.now ?? (() => new Date().toISOString());
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
          states.set(key, { quota, failed: quota.unavailable });
        }
      }
      lastWrittenJson = `${JSON.stringify(seeded)}\n`;
    }
  } catch {
    // An unreadable or unparseable file is simply rewritten on the first pass.
  }

  // Resolved per pass so installing or removing CodexBar never needs a daemon
  // restart. An injected exec skips resolution entirely (tests never spawn).
  const resolveExec = (): QuotaExec | null => {
    if (dependencies.exec !== undefined) {
      return dependencies.exec;
    }
    const binaryPath = CODEXBAR_BINARY_CANDIDATES.find((path) => fileExists(path));
    return binaryPath === undefined ? null : spawnExec(binaryPath);
  };

  const probe = async (exec: QuotaExec, provider: QuotaProviderKey): Promise<FetchOutcome> => {
    let result: QuotaExecResult;
    try {
      result = await exec(codexbarArgs(provider), QUOTA_EXEC_TIMEOUT_MS);
    } catch {
      return { kind: "failed" };
    }
    if (result.exitCode !== 0) {
      return { kind: "failed" };
    }
    const parsed = parseCodexbarUsage(result.stdout);
    if (parsed.kind === "absent") {
      return { kind: "absent" };
    }
    return parsed.kind === "ok" ? { kind: "ok", reading: parsed.reading } : { kind: "failed" };
  };

  const pollProvider = async (exec: QuotaExec | null, provider: QuotaProviderKey): Promise<ProviderQuota | null> => {
    // A fresh row displays unavailable (never fetched) but has not yet failed —
    // `failed` tracks the diagnostic transition, separately from that display.
    const state = states.get(provider) ?? { quota: emptyQuota(), failed: false };
    const outcome = exec === null ? ({ kind: "absent" } as const) : await probe(exec, provider);
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
      states.set(provider, { quota, failed: false });
      return quota;
    }
    if (!state.failed) {
      // Log the transition into failure only — never per pass, never output text.
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
      const exec = resolveExec();
      const providers: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
      for (const provider of QUOTA_PROVIDER_KEYS) {
        const quota = await pollProvider(exec, provider);
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
      // fixed diagnostic, never output text — and the next pass retries.
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
