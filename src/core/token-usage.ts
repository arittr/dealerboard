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
import {
  parseTokenUsageSnapshot,
  TOKEN_USAGE_DAY_CURVE_POINT_LIMIT,
  TOKEN_USAGE_SAMPLE_LIMIT,
  type TokenUsageDayCurvePoint,
  type TokenUsageDayCurves,
  type TokenUsageSnapshot,
} from "../token-usage-snapshot";
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

const AGENTSVIEW_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const isDatedRow = (value: unknown): value is Record<string, unknown> & { date: string } =>
  isRecord(value) && typeof value["date"] === "string" && AGENTSVIEW_DATE_PATTERN.test(value["date"]);

const tokenCount = (row: Record<string, unknown>, key: string): number | null => {
  const value = row[key];
  return isTokenCount(value) ? value : null;
};

/**
 * Parse one agentsview `usage daily --json` report down to the providerDay
 * row's tokenmaxxing_total_v1. Every `daily` element is validated for
 * shape before any total is accepted — a well-formed today row followed by
 * a broken entry is still a failed poll, never a partial read. Each element
 * must be a record whose date is YYYY-MM-DD; rows for other days are
 * skipped without field validation; a report with no row for the day is a
 * legitimate zero (nothing burned yet). Any other contract violation —
 * wrong schema, malformed JSON, a present today-row with bad fields — is null.
 */
export const normalizeAgentsviewDaily = (body: string, providerDay: string): number | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const schemaVersion = parsed["schema_version"];
  if ((schemaVersion !== 4 && schemaVersion !== 5) || !Array.isArray(parsed["daily"])) {
    return null;
  }
  // Pass one: every element must be a record with a YYYY-MM-DD date, no
  // matter where it sits relative to the matching row.
  if (!parsed["daily"].every(isDatedRow)) {
    return null;
  }
  // Pass two: only today's row is field-validated.
  for (const entry of parsed["daily"]) {
    if (entry["date"] !== providerDay) {
      continue;
    }
    const input = tokenCount(entry, "inputTokens");
    const output = tokenCount(entry, "outputTokens");
    const cacheCreation = tokenCount(entry, "cacheCreationTokens");
    const cacheRead = tokenCount(entry, "cacheReadTokens");
    if (input === null || output === null || cacheCreation === null || cacheRead === null) {
      return null;
    }
    const total = input + output + cacheCreation + cacheRead;
    // Fail closed on an overflowing sum: four finite maxima add to Infinity,
    // which JSON.stringify would publish as a contract-invalid null.
    return Number.isFinite(total) ? total : null;
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

/** Calendar-day arithmetic on the YYYY-MM-DD string is timezone-free. */
export const previousProviderDay = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);

const downsampleDayPoints = (points: readonly TokenUsageDayCurvePoint[]): TokenUsageDayCurvePoint[] => {
  if (points.length <= TOKEN_USAGE_DAY_CURVE_POINT_LIMIT) {
    return [...points];
  }
  const picked: TokenUsageDayCurvePoint[] = [];
  const last = points.length - 1;
  let previousIndex = -1;
  for (let i = 0; i < TOKEN_USAGE_DAY_CURVE_POINT_LIMIT; i++) {
    const index = Math.round((i * last) / (TOKEN_USAGE_DAY_CURVE_POINT_LIMIT - 1));
    if (index === previousIndex) {
      continue;
    }
    previousIndex = index;
    const entry = points[index];
    if (entry !== undefined) {
      picked.push(entry);
    }
  }
  return picked;
};

/** Append a sample to the day curves: same day extends with a running max; a new day rotates date-keyed. */
export const appendDayCurvePoint = (
  curves: TokenUsageDayCurves | undefined,
  day: string,
  point: TokenUsageDayCurvePoint,
): TokenUsageDayCurves => {
  if (curves !== undefined && curves.today.providerDay === day) {
    const last = curves.today.points.at(-1);
    // The reader rejects a curve whose timestamps are not strictly
    // increasing, so a sample at a repeated or stepped-back instant is
    // dropped: keeping the last parseable curve beats manufacturing a
    // timestamp (canonical UTC ISO strings compare chronologically).
    if (last !== undefined && point.fetchedAt <= last.fetchedAt) {
      return curves;
    }
    const points = downsampleDayPoints([
      ...curves.today.points,
      { fetchedAt: point.fetchedAt, totalTokens: Math.max(point.totalTokens, last?.totalTokens ?? 0) },
    ]);
    return { today: { providerDay: day, points }, yesterday: curves.yesterday };
  }
  const yesterday =
    curves !== undefined && curves.today.providerDay === previousProviderDay(day) && curves.today.points.length > 0
      ? curves.today
      : null;
  return { today: { providerDay: day, points: [point] }, yesterday };
};

/** Date-key a seeded publication against the current LA day: pass, rotate, or drop — never mislabel. */
export const reconcileSeededDayCurves = (
  curves: TokenUsageDayCurves | undefined,
  currentDay: string,
): TokenUsageDayCurves | undefined => {
  if (curves === undefined) {
    return undefined;
  }
  if (curves.today.providerDay === currentDay) {
    return curves;
  }
  if (curves.today.providerDay === previousProviderDay(currentDay)) {
    return { today: { providerDay: currentDay, points: [] }, yesterday: curves.today };
  }
  return undefined;
};

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

  let state: CollectorState = { snapshot: emptySnapshot(laProviderDay(new Date(nowMs()))), failed: true };
  let lastWrittenJson: string | null = null;
  let polling = false;
  let started = false;
  let cancelSchedule: (() => void) | null = null;

  // Every failure routes through here: log only a good→failed transition — a
  // cold start was never good, so it stays silent — then mark unavailable.
  const markFailed = (): void => {
    if (!state.failed) {
      try {
        diagnostics({ timestamp: now(), component: DIAGNOSTIC_COMPONENT, code: "token_usage_failed" });
      } catch {
        // Diagnostics must never break the collector.
      }
    }
    state = { snapshot: { ...state.snapshot, unavailable: true }, failed: true };
  };

  // Seed last-good state from the previous publication so a daemon restart
  // never blanks the block (or its rate windows).
  try {
    const existing = readFile(dependencies.tokenUsageSnapshotPath);
    if (existing !== null) {
      const seeded = parseTokenUsageSnapshot(JSON.parse(existing));
      // Date-key the seeded curves against the current LA day — a daemon
      // that slept through midnight must never mislabel a stale curve.
      const reconciled = reconcileSeededDayCurves(seeded.dayCurves, laProviderDay(new Date(nowMs())));
      let snapshot: TokenUsageSnapshot = { ...seeded, ...(reconciled === undefined ? {} : { dayCurves: reconciled }) };
      if (reconciled === undefined && seeded.dayCurves !== undefined) {
        // A gapped seed is dropped, not carried — destructure the key away.
        const { dayCurves: _dropped, ...rest } = seeded;
        snapshot = rest;
      }
      // A seeded unavailable snapshot is already in the failed state — its
      // continuation must not re-log, only a good→failed transition may.
      state = { snapshot, failed: seeded.unavailable };
      // The write guard tracks the bytes actually on disk, not the
      // reconciled in-memory state — those were never written, so seeding
      // with them would let a failed first poll suppress publishing the
      // reconciled (rotated or dropped) curve across an outage.
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
        markFailed();
      } else {
        const fetchedAt = now();
        const samples = [...state.snapshot.samples, { fetchedAt, totalTokens: total, providerDay }].slice(
          -TOKEN_USAGE_SAMPLE_LIMIT,
        );
        const dayCurves = appendDayCurvePoint(state.snapshot.dayCurves, providerDay, { fetchedAt, totalTokens: total });
        state = {
          snapshot: {
            schemaVersion: 1,
            providerDay,
            totalTokens: total,
            unavailable: false,
            fetchedAt,
            samples,
            dayCurves,
          },
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
      // dependency/runtime exception is contained here — the same transition
      // gate as a poll failure, never error text — and the next pass retries.
      markFailed();
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
