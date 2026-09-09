/**
 * Quota collection for the strip's rail panels (claude, codex, kimi, GLM/zai,
 * Qwen).
 *
 * All five providers are read through the locally installed CodexBar CLI:
 * `codexbar usage --provider <arg> --format json --log-level critical`,
 * spawned once per provider per pass (serialized — CodexBar's app-support
 * directory carries lock files). Claude is excepted while claude-swap serves
 * the grouped account view: cswap is then claude's only source and the
 * CodexBar claude probe is skipped for that pass (readClaudeSwap). The
 * provider argument is the contract key
 * itself except qwen, which reads CodexBar's `alibabatokenplan` provider
 * (CODEXBAR_PROVIDER_ARGS). Codex uses --all-accounts, retaining each named
 * account independently; anonymous and widget values only serve ambient mode.
 * The binary resolves per pass from CODEXBAR_BINARY_CANDIDATES; missing binaries
 * retain named accounts as unavailable. CodexBar's
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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ProviderQuota,
  parseQuotaSnapshot,
  QUOTA_HISTORY_LIMIT,
  QUOTA_PROVIDER_KEYS,
  QUOTA_SNAPSHOT_SCHEMA_VERSION,
  type QuotaProviderKey,
  type QuotaSnapshot,
} from "../quota-snapshot";
import {
  CLAUDE_SWAP_ARGS,
  CLAUDE_SWAP_EXEC_TIMEOUT_MS,
  claudeSwapBinaryCandidates,
  parseClaudeSwapAccounts,
} from "./claude-swap-quota";
import { type CodexAccountsParse, parseCodexbarAccounts } from "./codexbar-accounts";
import { type ProviderQuotaReading, parseCodexbarUsage, parseCodexbarWidgetSnapshot } from "./codexbar-usage";
import type { DiagnosticRecord } from "./diagnostics";
import { type AccountInventoryRead, reconcileQuotaAccounts } from "./quota-accounts";
import { writeFileAtomically } from "./snapshot";

export {
  type CodexbarUsageParse,
  type ProviderQuotaReading,
  parseCodexbarRecord,
  parseCodexbarUsage,
  parseCodexbarWidgetSnapshot,
  type QuotaWindowReading,
  WIDGET_SNAPSHOT_MAX_AGE_MS,
} from "./codexbar-usage";

/**
 * The CodexBar menu-bar app refreshes on its own cadence with its own
 * Keychain-approved cookie access and publishes this widget snapshot, readable
 * without any TCC grant. The daemon-spawned CLI often lacks that access (cookie
 * auth fails in launchd contexts), so when a CLI probe yields no reading the
 * collector falls back to the snapshot's per-provider windows.
 */
export const codexbarWidgetSnapshotPath = (home: string = homedir()): string =>
  join(home, "Library/Group Containers/Y5PE65HELJ.com.steipete.codexbar/widget-snapshot.json");

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

/** A widget read outlasting this is abandoned for the pass (foreign file; its open() has hung before). */
export const WIDGET_READ_TIMEOUT_MS = 2_000;

const WIDGET_READ_TIMED_OUT = Symbol("widget-read-timed-out");

const DIAGNOSTIC_COMPONENT = "quota";

export type QuotaExecResult = { exitCode: number; stdout: string; timedOut?: boolean };

/** Resolves instead of rejecting; a timeout is distinct from an ordinary nonzero exit. */
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
  readFile?: (path: string) => Promise<string | null>;
  now?: () => string;
  writeFile?: (path: string, payload: string) => void;
  schedule?: QuotaScheduler;
  diagnostics?: (record: DiagnosticRecord) => void;
  /** Test seam for the widget-read race; production uses WIDGET_READ_TIMEOUT_MS. */
  widgetReadTimeoutMs?: number;
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

type ClaudeSwapRead =
  | { kind: "ok"; accounts: ProviderQuota["accounts"]; at: string }
  | { kind: "failed" }
  | { kind: "absent" };

type ProviderState = { quota: ProviderQuota; failed: boolean; accountsFailed: boolean };

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

const defaultReadFile = async (path: string): Promise<string | null> => {
  try {
    return await Bun.file(path).text();
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
  ...(provider === "codex" ? ["--all-accounts"] : []),
];

const spawnExec =
  (binaryPath: string): QuotaExec =>
  async (args, timeoutMs) => {
    try {
      const process = Bun.spawn([binaryPath, ...args], { stdout: "pipe", stderr: "ignore" });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        process.kill();
      }, timeoutMs);
      try {
        const stream = process.stdout;
        const stdout = stream === null ? "" : await new Response(stream).text();
        const exitCode = await process.exited;
        return { exitCode, stdout, timedOut };
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
  const widgetReadTimeoutMs = dependencies.widgetReadTimeoutMs ?? WIDGET_READ_TIMEOUT_MS;

  let states = new Map<QuotaProviderKey, ProviderState>();
  let lastWrittenJson: string | null = null;
  let polling = false;
  let started = false;
  let cancelSchedule: (() => void) | null = null;

  const emitDiagnostic = (record: DiagnosticRecord): void => {
    try {
      diagnostics(record);
    } catch {
      // Diagnostics must never break the collector.
    }
  };

  const reportWidgetTimeout = (): void => {
    try {
      diagnostics({ timestamp: now(), component: DIAGNOSTIC_COMPONENT, code: "widget_read_timeout" });
    } catch {
      // Diagnostics must never break the collector.
    }
  };

  let widgetReadPending = false;

  /**
   * The widget file is foreign (CodexBar's group container) and has hung
   * open() on this machine before. The read races a timeout so the pass —
   * and the daemon heartbeat sharing this event loop — can never block on
   * it. At most one underlying read exists: while one is stuck, later
   * passes proceed widget-less immediately, and the stuck read's eventual
   * value is discarded with it.
   */
  const readWidgetSnapshot = async (path: string): Promise<string | null> => {
    if (widgetReadPending) {
      return null;
    }
    widgetReadPending = true;
    const read = readFile(path)
      .catch(() => null)
      .finally(() => {
        widgetReadPending = false;
      });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<typeof WIDGET_READ_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(WIDGET_READ_TIMED_OUT), widgetReadTimeoutMs);
    });
    const winner = await Promise.race([read, timeout]);
    if (winner === WIDGET_READ_TIMED_OUT) {
      reportWidgetTimeout();
      return null;
    }
    if (timer !== null) {
      clearTimeout(timer);
    }
    return winner;
  };

  // Seed last-good state from the previous publication so a daemon restart
  // never blanks the panels. The read is async; the first pass awaits it
  // before computing any state.
  const seeded = (async (): Promise<void> => {
    try {
      const existing = await readFile(dependencies.quotaSnapshotPath);
      if (existing !== null) {
        const parsed = parseQuotaSnapshot(JSON.parse(existing));
        for (const key of QUOTA_PROVIDER_KEYS) {
          const quota = parsed.providers[key];
          if (quota !== undefined) {
            // A seeded unavailable row is already in the failed state — its
            // continuation must not re-log, only a good→failed transition may.
            states.set(key, {
              quota,
              failed: quota.unavailable,
              accountsFailed: quota.unavailable || quota.accounts.some((account) => account.issue !== null),
            });
          }
        }
        lastWrittenJson = `${JSON.stringify(parsed)}\n`;
      }
    } catch {
      // An unreadable or unparseable file is simply rewritten on the first pass.
    }
  })();

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

  /** Pure read — pollNow commits the retention state, never this function. */
  const readClaudeSwap = async (exec: QuotaExec | null): Promise<ClaudeSwapRead> => {
    if (exec === null) {
      return { kind: "absent" };
    }
    let result: QuotaExecResult;
    try {
      result = await exec([...CLAUDE_SWAP_ARGS], CLAUDE_SWAP_EXEC_TIMEOUT_MS);
    } catch {
      result = { exitCode: -1, stdout: "" };
    }
    if (result.exitCode !== 0 || result.timedOut) {
      return { kind: "failed" };
    }
    const parsed = parseClaudeSwapAccounts(result.stdout);
    if (parsed.kind !== "ok") {
      return { kind: "failed" };
    }
    return { kind: "ok", accounts: parsed.accounts, at: now() };
  };

  const probe = async (exec: QuotaExec, provider: QuotaProviderKey): Promise<FetchOutcome> => {
    let result: QuotaExecResult;
    try {
      result = await exec(codexbarArgs(provider), QUOTA_EXEC_TIMEOUT_MS);
    } catch {
      return { kind: "failed" };
    }
    if (result.exitCode !== 0 || result.timedOut) {
      return { kind: "failed" };
    }
    const parsed = parseCodexbarUsage(result.stdout, CODEXBAR_PROVIDER_ARGS[provider]);
    if (parsed.kind === "absent") {
      return { kind: "absent" };
    }
    return parsed.kind === "ok" ? { kind: "ok", reading: parsed.reading } : { kind: "failed" };
  };

  const applyOutcome = (
    nextStates: Map<QuotaProviderKey, ProviderState>,
    queued: DiagnosticRecord[],
    provider: QuotaProviderKey,
    outcome: FetchOutcome,
    widget: ReadonlyMap<string, ProviderQuotaReading>,
    reportProviderFailure = true,
  ): ProviderQuota | null => {
    // A fresh row displays unavailable (never fetched) but has not yet failed —
    // `failed` tracks the diagnostic transition, separately from that display.
    const state = nextStates.get(provider) ?? { quota: emptyQuota(), failed: false, accountsFailed: false };
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
      nextStates.delete(provider);
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
      nextStates.set(provider, { ...state, quota, failed: false });
      return quota;
    }
    if (!state.failed && reportProviderFailure) {
      // Log the transition into failure only — never per pass, never output text.
      queued.push({ timestamp: now(), component: DIAGNOSTIC_COMPONENT, code: "quota_failed", provider });
    }
    const quota = { ...state.quota, unavailable: true };
    nextStates.set(provider, { ...state, quota, failed: true });
    return quota;
  };

  const pollProvider = async (
    nextStates: Map<QuotaProviderKey, ProviderState>,
    queued: DiagnosticRecord[],
    exec: QuotaExec | null,
    provider: QuotaProviderKey,
    widget: ReadonlyMap<string, ProviderQuotaReading>,
  ): Promise<ProviderQuota | null> =>
    applyOutcome(
      nextStates,
      queued,
      provider,
      exec === null ? { kind: "absent" } : await probe(exec, provider),
      widget,
    );

  const readCodex = async (exec: QuotaExec | null): Promise<CodexAccountsParse> => {
    if (exec === null) return { kind: "invalid" };
    let result: QuotaExecResult;
    try {
      result = await exec(codexbarArgs("codex"), QUOTA_EXEC_TIMEOUT_MS);
    } catch {
      return { kind: "invalid" };
    }
    if (result.timedOut || result.exitCode < 0) return { kind: "invalid" };
    return parseCodexbarAccounts(result.stdout, result.exitCode, states.get("codex")?.quota.accounts ?? []);
  };

  const reconcileInventory = (
    nextStates: Map<QuotaProviderKey, ProviderState>,
    queued: DiagnosticRecord[],
    provider: "claude" | "codex",
    read: AccountInventoryRead,
    observed: boolean,
    absent: boolean,
  ): { accounts: ProviderQuota["accounts"]; observed: boolean; failed: boolean } => {
    const previous = nextStates.get(provider);
    const retained = previous?.quota.accounts ?? [];
    const reconciled = reconcileQuotaAccounts(retained, read);
    const overflow = reconciled.kind === "overflow";
    const accounts = overflow
      ? retained.map((account) => ({ ...account, issue: account.issue ?? ("unavailable" as const), unavailable: true }))
      : reconciled.accounts;
    const failed = overflow || (!read.completeInventory && !(absent && retained.length === 0));
    if (failed && !previous?.accountsFailed) {
      queued.push({ timestamp: now(), component: DIAGNOSTIC_COMPONENT, code: "quota_accounts_failed", provider });
    }
    return { accounts, observed: observed && !overflow, failed };
  };

  const groupedQuota = (
    previous: ProviderQuota | undefined,
    inventory: { accounts: ProviderQuota["accounts"]; observed: boolean },
    at: string | null,
  ): ProviderQuota => ({
    ...emptyQuota(),
    unavailable: false,
    fetchedAt: inventory.observed ? at : (previous?.fetchedAt ?? null),
    history: previous?.history ?? [],
    accounts: inventory.accounts,
  });

  const pollNow = async (): Promise<void> => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      await seeded;
      const exec = resolveExec();
      const widget = parseCodexbarWidgetSnapshot(
        (await readWidgetSnapshot(dependencies.widgetSnapshotPath ?? codexbarWidgetSnapshotPath())) ?? "",
        Date.parse(now()),
      );
      const nextStates = new Map(states);
      const queued: DiagnosticRecord[] = [];
      const swapRead = await readClaudeSwap(resolveClaudeSwapExec());
      const codexRead = await readCodex(exec);
      const priorCodex = nextStates.get("codex");
      const codexInventory = reconcileInventory(
        nextStates,
        queued,
        "codex",
        codexRead.kind === "ok" ? codexRead : { accounts: [], completeInventory: false },
        codexRead.kind === "ok" &&
          codexRead.inventoryObserved &&
          (codexRead.completeInventory || codexRead.accounts.length > 0),
        exec === null || (codexRead.kind === "ok" && codexRead.ambient !== null),
      );
      if (codexInventory.accounts.length > 0) {
        nextStates.set("codex", {
          quota: groupedQuota(priorCodex?.quota, codexInventory, codexInventory.observed ? now() : null),
          failed: false,
          accountsFailed: codexInventory.failed,
        });
      } else {
        const outcome: FetchOutcome =
          codexRead.kind === "ok" && codexRead.ambient !== null
            ? { kind: "ok", reading: codexRead.ambient.reading }
            : exec === null || (codexRead.kind === "ok" && codexRead.completeInventory)
              ? { kind: "absent" }
              : { kind: "failed" };
        applyOutcome(nextStates, queued, "codex", outcome, widget, false);
        const ambient = nextStates.get("codex");
        if (ambient !== undefined)
          nextStates.set("codex", {
            ...ambient,
            accountsFailed: codexInventory.failed,
            quota: { ...ambient.quota, accounts: [] },
          });
      }
      for (const provider of QUOTA_PROVIDER_KEYS) {
        if (provider === "claude" || provider === "codex") continue;
        await pollProvider(nextStates, queued, exec, provider, widget);
      }
      const priorClaude = nextStates.get("claude");
      const claudeInventory = reconcileInventory(
        nextStates,
        queued,
        "claude",
        swapRead.kind === "ok"
          ? {
              accounts: swapRead.accounts,
              completeInventory: swapRead.accounts.every((account) => account.issue === null),
            }
          : { accounts: [], completeInventory: false },
        swapRead.kind === "ok",
        swapRead.kind === "absent",
      );
      if (claudeInventory.accounts.length >= 2) {
        nextStates.set("claude", {
          quota: groupedQuota(priorClaude?.quota, claudeInventory, swapRead.kind === "ok" ? swapRead.at : null),
          failed: false,
          accountsFailed: claudeInventory.failed,
        });
      } else {
        const ambient = await pollProvider(nextStates, queued, exec, "claude", widget);
        if (ambient !== null || claudeInventory.accounts.length > 0 || claudeInventory.failed) {
          const quota = ambient ?? emptyQuota();
          nextStates.set("claude", {
            quota: {
              ...quota,
              accounts: claudeInventory.accounts,
              fetchedAt:
                claudeInventory.accounts.length > 0
                  ? claudeInventory.observed && swapRead.kind === "ok"
                    ? swapRead.at
                    : (priorClaude?.quota.fetchedAt ?? null)
                  : quota.fetchedAt,
            },
            failed: nextStates.get("claude")?.failed ?? false,
            accountsFailed: claudeInventory.failed,
          });
        }
      }
      const orderedProviders: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
      for (const provider of QUOTA_PROVIDER_KEYS) {
        const state = nextStates.get(provider);
        if (state !== undefined) orderedProviders[provider] = state.quota;
      }
      const snapshot: QuotaSnapshot = {
        schemaVersion: QUOTA_SNAPSHOT_SCHEMA_VERSION,
        providers: orderedProviders,
      };
      const json = `${JSON.stringify(snapshot)}\n`;
      // No awaits or shared-state mutations: only a successful publication
      // advances retained measurements, labels, and diagnostic transitions.
      if (json !== lastWrittenJson) writeFile(dependencies.quotaSnapshotPath, json);
      states = nextStates;
      lastWrittenJson = json;
      for (const record of queued) emitDiagnostic(record);
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
