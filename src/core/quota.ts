/**
 * Quota collection for the strip's rail panels (claude, codex, kimi, GLM/zai,
 * Qwen).
 *
 * All five providers are read through the locally installed CodexBar CLI:
 * `codexbar usage --provider <arg> --format json --log-level critical`,
 * spawned once per provider per pass (serialized — CodexBar's app-support
 * directory carries lock files). The provider argument is the contract key
 * itself except qwen, which reads CodexBar's `alibabatokenplan` provider
 * (CODEXBAR_PROVIDER_ARGS). The binary resolves per pass from
 * CODEXBAR_BINARY_CANDIDATES; a missing binary omits every provider. CodexBar's
 * primary/secondary labels are not positional (kimi reports the weekly window
 * as primary), so windows are classified by windowMinutes: weekly = the longest
 * window of at least a day, session = the shortest window under a day, and
 * usage.extraRateWindows always participates: an extra can be selected as the
 * session window (codex reports primary: null, its Spark 5-hour lives there),
 * and unselected extras publish as extraWindows with provider-name-stripped
 * labels. A provider
 * disabled in the CodexBar app prints an empty array and is omitted.
 *
 * Nothing the process prints is ever logged or persisted beyond the derived
 * numbers in the published snapshot.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  capQuotaExtraWindowLabel,
  type ProviderQuota,
  parseQuotaSnapshot,
  QUOTA_EXTRA_WINDOWS_LIMIT,
  QUOTA_HISTORY_LIMIT,
  QUOTA_PROVIDER_KEYS,
  QUOTA_SNAPSHOT_SCHEMA_VERSION,
  type QuotaExtraWindow,
  type QuotaProviderKey,
  type QuotaSnapshot,
} from "../quota-snapshot";
import {
  CLAUDE_SWAP_ARGS,
  CLAUDE_SWAP_EXEC_TIMEOUT_MS,
  claudeSwapBinaryCandidates,
  parseClaudeSwapAccounts,
} from "./claude-swap-quota";
import type { DiagnosticRecord } from "./diagnostics";
import { writeFileAtomically } from "./snapshot";

export type QuotaWindowReading = { percentRemaining: number; resetAt: string | null };

export type ProviderQuotaReading = {
  /** Null when the provider reports no session-class window (e.g. codex weekly-only). */
  session: QuotaWindowReading | null;
  weekly: QuotaWindowReading | null;
  /** Extra windows not selected as session/weekly (claude's fable, codex's spark weekly). */
  extras: QuotaExtraWindow[];
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

type RawCodexbarExtra = { id: string | null; title: string | null; window: RawCodexbarWindow };

const parseCodexbarExtra = (value: unknown): RawCodexbarExtra | null => {
  if (!isRecord(value)) {
    return null;
  }
  const window = parseCodexbarWindow(value["window"]);
  if (window === null) {
    return null;
  }
  const id = value["id"];
  const title = value["title"];
  return {
    id: typeof id === "string" && id.length > 0 ? id : null,
    title: typeof title === "string" && title.length > 0 ? title : null,
    window,
  };
};

/** CodexBar's provider id → the rail's display name, for stripping it out of window titles. */
const CODEXBAR_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  kimi: "Kimi",
  zai: "GLM",
  alibabatokenplan: "Qwen",
};

/** Extra-window tag: title minus the provider's own name, capped at 14 code points with an ellipsis. */
const extraWindowLabel = (title: string, codexbarProvider: string): string => {
  const displayName = CODEXBAR_DISPLAY_NAMES[codexbarProvider] ?? codexbarProvider;
  const stripped = title.replace(new RegExp(`^${displayName}\\s+`, "iu"), "").trim();
  const source = stripped.length === 0 ? title.trim() : stripped;
  return capQuotaExtraWindowLabel(source);
};

type WindowSelection = { session: RawCodexbarWindow | null; weekly: RawCodexbarWindow | null };

const classifyCodexbarWindows = (windows: readonly RawCodexbarWindow[]): WindowSelection | null => {
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
  return { session, weekly };
};

export const parseCodexbarUsage = (body: string, provider?: string): CodexbarUsageParse => {
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
  // CodexBar normally honors --provider with a single entry, but sparse
  // environments (the daemon's launchd context) get the unfiltered
  // all-provider array. Entries carry their provider id, so select on it when
  // ids are present; an id-carrying array without the requested provider means
  // the provider is disabled in the CodexBar app.
  const ids = parsed.map((item) => (isRecord(item) && typeof item["provider"] === "string" ? item["provider"] : null));
  let entry: unknown = parsed[0];
  if (provider !== undefined && ids.some((id) => id !== null)) {
    const index = ids.indexOf(provider);
    if (index === -1) {
      return { kind: "absent" };
    }
    entry = parsed[index];
  }
  if (!isRecord(entry) || !isRecord(entry["usage"])) {
    return { kind: "invalid" };
  }
  const usage = entry["usage"];
  const providerId = provider ?? (typeof entry["provider"] === "string" ? entry["provider"] : "");
  const windows: RawCodexbarWindow[] = [];
  for (const key of ["primary", "secondary", "tertiary"] as const) {
    const window = parseCodexbarWindow(usage[key]);
    if (window !== null) {
      windows.push(window);
    }
  }
  // Extra rate windows always parse: the session/weekly selection draws from
  // them (codex's Spark 5-hour is its session window), and the rest publish.
  const rawExtras: RawCodexbarExtra[] = [];
  if (Array.isArray(usage["extraRateWindows"])) {
    for (const item of usage["extraRateWindows"]) {
      const extra = parseCodexbarExtra(item);
      if (extra !== null) {
        rawExtras.push(extra);
      }
    }
  }
  const selected = classifyCodexbarWindows([...windows, ...rawExtras.map((extra) => extra.window)]);
  if (selected === null) {
    return { kind: "invalid" };
  }
  const extras: QuotaExtraWindow[] = [];
  for (const extra of rawExtras) {
    if (extra.window === selected.session || extra.window === selected.weekly) {
      continue;
    }
    const name = extra.id ?? extra.title;
    if (name === null) {
      continue; // an unnamed window can't be tagged
    }
    extras.push({
      id: name,
      label: extraWindowLabel(extra.title ?? name, providerId),
      ...toWindowReading(extra.window),
    });
    if (extras.length >= QUOTA_EXTRA_WINDOWS_LIMIT) {
      break;
    }
  }
  return {
    kind: "ok",
    reading: {
      session: selected.session === null ? null : toWindowReading(selected.session),
      weekly: selected.weekly === null ? null : toWindowReading(selected.weekly),
      extras,
    },
  };
};

/**
 * Parse the CodexBar widget snapshot into per-provider readings keyed by the
 * CodexBar provider id. Invalid bodies, a stale generatedAt, and windowless
 * entries yield no readings rather than throwing — the fallback must never
 * break a pass.
 */
export const parseCodexbarWidgetSnapshot = (body: string, nowMs: number): Map<string, ProviderQuotaReading> => {
  const readings = new Map<string, ProviderQuotaReading>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return readings;
  }
  if (!isRecord(parsed)) {
    return readings;
  }
  const generatedAt = typeof parsed["generatedAt"] === "string" ? Date.parse(parsed["generatedAt"]) : Number.NaN;
  if (Number.isNaN(generatedAt) || nowMs - generatedAt > WIDGET_SNAPSHOT_MAX_AGE_MS) {
    return readings;
  }
  const entries = parsed["entries"];
  if (!Array.isArray(entries)) {
    return readings;
  }
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry["provider"] !== "string") {
      continue;
    }
    const windows: RawCodexbarWindow[] = [];
    for (const key of ["primary", "secondary", "tertiary"] as const) {
      const window = parseCodexbarWindow(entry[key]);
      if (window !== null) {
        windows.push(window);
      }
    }
    const selection = classifyCodexbarWindows(windows);
    if (selection !== null) {
      readings.set(entry["provider"], {
        session: selection.session === null ? null : toWindowReading(selection.session),
        weekly: selection.weekly === null ? null : toWindowReading(selection.weekly),
        extras: [], // the widget snapshot carries no extraRateWindows
      });
    }
  }
  return readings;
};

/**
 * The CodexBar menu-bar app refreshes on its own cadence with its own
 * Keychain-approved cookie access and publishes this widget snapshot, readable
 * without any TCC grant. The daemon-spawned CLI often lacks that access (cookie
 * auth fails in launchd contexts), so when a CLI probe yields no reading the
 * collector falls back to the snapshot's per-provider windows.
 */
export const codexbarWidgetSnapshotPath = (home: string = homedir()): string =>
  join(home, "Library/Group Containers/Y5PE65HELJ.com.steipete.codexbar/widget-snapshot.json");

/** The widget snapshot only counts as a source while the app is actually refreshing it. */
export const WIDGET_SNAPSHOT_MAX_AGE_MS = 45 * 60_000;

/** Quota windows move slowly; CodexBar itself polls providers on a similar cadence. */
export const QUOTA_POLL_INTERVAL_MS = 120_000;
/**
 * CodexBarCLI's own per-provider timeout is ~60s, and its slower runs (notably
 * kimi) legitimately exceed a shorter kill while still producing valid results
 * — our kill must sit comfortably above its timeout so it never discards good
 * data. Worst case a serialized pass stretches past the 120s cadence, which
 * pollNow's reentrancy guard absorbs (the next tick skips while a pass runs).
 */
export const QUOTA_EXEC_TIMEOUT_MS = 90_000;

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
  /** Defaults to codexbarWidgetSnapshotPath(); tests point at a temp file. */
  widgetSnapshotPath?: string;
  exec?: QuotaExec;
  /** Injected claude-swap subprocess for tests; production resolves its binary separately. */
  claudeSwapExec?: QuotaExec;
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
  extraWindows: [],
  accounts: [],
});

const defaultReadFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** CodexBar's provider key matches the contract key except for qwen (Alibaba Token Plan). */
export const CODEXBAR_PROVIDER_ARGS: Record<QuotaProviderKey, string> = {
  claude: "claude",
  codex: "codex",
  kimi: "kimi",
  zai: "zai",
  qwen: "alibabatokenplan",
};

const codexbarArgs = (provider: QuotaProviderKey): string[] => [
  "usage",
  "--provider",
  CODEXBAR_PROVIDER_ARGS[provider],
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
  type ClaudeAccountState = {
    accounts: ProviderQuota["accounts"];
    failed: boolean;
  };
  let claudeAccounts: ClaudeAccountState = { accounts: [], failed: false };
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
      claudeAccounts = {
        accounts: seeded.providers["claude"]?.accounts ?? [],
        failed: false,
      };
      for (const key of QUOTA_PROVIDER_KEYS) {
        const quota = seeded.providers[key];
        if (quota !== undefined) {
          // A seeded unavailable row is already in the failed state — its
          // continuation must not re-log, only a good→failed transition may.
          states.set(key, { quota: { ...quota, accounts: [] }, failed: quota.unavailable });
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

  // Resolved per pass so installing or removing claude-swap never needs a
  // daemon restart. The injected exec is for tests only and remains
  // independent from the CodexBar dependency above.
  const resolveClaudeSwapExec = (): QuotaExec | null => {
    if (dependencies.claudeSwapExec !== undefined) {
      return dependencies.claudeSwapExec;
    }
    const binaryPath = claudeSwapBinaryCandidates(homedir()).find((path) => fileExists(path));
    return binaryPath === undefined ? null : spawnExec(binaryPath);
  };

  const reportAccountFailure = (): void => {
    try {
      diagnostics({
        timestamp: now(),
        component: DIAGNOSTIC_COMPONENT,
        code: "quota_accounts_failed",
        provider: "claude",
      });
    } catch {
      // Diagnostics must never break the collector.
    }
  };

  const pollClaudeAccounts = async (exec: QuotaExec | null): Promise<ProviderQuota["accounts"]> => {
    if (exec === null) {
      claudeAccounts = { accounts: [], failed: false };
      return [];
    }
    let result: QuotaExecResult;
    try {
      result = await exec([...CLAUDE_SWAP_ARGS], CLAUDE_SWAP_EXEC_TIMEOUT_MS);
    } catch {
      result = { exitCode: -1, stdout: "" };
    }
    const parsed = result.exitCode === 0 ? parseClaudeSwapAccounts(result.stdout) : { kind: "invalid" as const };
    if (parsed.kind === "ok") {
      claudeAccounts = { accounts: parsed.accounts, failed: false };
      return parsed.accounts;
    }
    if (!claudeAccounts.failed) {
      reportAccountFailure();
    }
    claudeAccounts = {
      accounts: claudeAccounts.accounts.map((account) => ({ ...account, unavailable: true })),
      failed: true,
    };
    return claudeAccounts.accounts;
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
    const parsed = parseCodexbarUsage(result.stdout, CODEXBAR_PROVIDER_ARGS[provider]);
    if (parsed.kind === "absent") {
      return { kind: "absent" };
    }
    return parsed.kind === "ok" ? { kind: "ok", reading: parsed.reading } : { kind: "failed" };
  };

  const pollProvider = async (
    exec: QuotaExec | null,
    provider: QuotaProviderKey,
    widget: ReadonlyMap<string, ProviderQuotaReading>,
  ): Promise<ProviderQuota | null> => {
    // A fresh row displays unavailable (never fetched) but has not yet failed —
    // `failed` tracks the diagnostic transition, separately from that display.
    const state = states.get(provider) ?? { quota: emptyQuota(), failed: false };
    let outcome: FetchOutcome = exec === null ? { kind: "absent" } : await probe(exec, provider);
    // The widget snapshot rescues providers whose CLI auth fails in this
    // context (notably qwen's cookie auth under launchd) — the app behind the
    // widget has its own approved access and keeps the file fresh.
    if (outcome.kind !== "ok") {
      const reading = widget.get(CODEXBAR_PROVIDER_ARGS[provider]);
      if (reading !== undefined) {
        outcome = { kind: "ok", reading };
      }
    }
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
        extraWindows: outcome.reading.extras,
        accounts: [],
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
      const widget = parseCodexbarWidgetSnapshot(
        readFile(dependencies.widgetSnapshotPath ?? codexbarWidgetSnapshotPath()) ?? "",
        Date.parse(now()),
      );
      const providers: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
      for (const provider of QUOTA_PROVIDER_KEYS) {
        const quota = await pollProvider(exec, provider, widget);
        if (quota !== null) {
          providers[provider] = quota;
        }
      }
      const accounts = await pollClaudeAccounts(resolveClaudeSwapExec());
      const ambientClaude = providers["claude"];
      if (ambientClaude !== undefined) {
        providers["claude"] = { ...ambientClaude, accounts };
      } else if (accounts.length > 0) {
        providers["claude"] = { ...emptyQuota(), accounts };
      }
      const orderedProviders: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
      for (const provider of QUOTA_PROVIDER_KEYS) {
        const quota = providers[provider];
        if (quota !== undefined) {
          orderedProviders[provider] = quota;
        }
      }
      const snapshot: QuotaSnapshot = {
        schemaVersion: QUOTA_SNAPSHOT_SCHEMA_VERSION,
        providers: orderedProviders,
      };
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
