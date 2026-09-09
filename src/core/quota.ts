/**
 * Quota collection for the strip's rail panels (claude, codex, kimi, GLM/zai,
 * Qwen).
 *
 * All five providers are read through the locally installed CodexBar CLI:
 * `codexbar usage --provider <arg> --format json --log-level critical`,
 * spawned once per provider per pass (serialized — CodexBar's app-support
 * directory carries lock files). Claude is excepted while claude-swap serves
 * the grouped two-account view: cswap is then claude's only source and the
 * CodexBar claude probe is skipped for that pass (readClaudeSwap). The
 * provider argument is the contract key
 * itself except qwen, which reads CodexBar's `alibabatokenplan` provider
 * (CODEXBAR_PROVIDER_ARGS). The binary resolves per pass from
 * CODEXBAR_BINARY_CANDIDATES; a missing binary omits every codexbar-probed provider. CodexBar's
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
import { type ProviderQuotaReading, parseCodexbarUsage, parseCodexbarWidgetSnapshot } from "./codexbar-usage";
import type { DiagnosticRecord } from "./diagnostics";
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
  const widgetReadTimeoutMs = dependencies.widgetReadTimeoutMs ?? WIDGET_READ_TIMEOUT_MS;

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
        claudeAccounts = {
          accounts: parsed.providers["claude"]?.accounts ?? [],
          failed: false,
        };
        for (const key of QUOTA_PROVIDER_KEYS) {
          const quota = parsed.providers[key];
          if (quota !== undefined) {
            // A seeded unavailable row is already in the failed state — its
            // continuation must not re-log, only a good→failed transition may.
            states.set(key, { quota: { ...quota, accounts: [] }, failed: quota.unavailable });
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
    if (result.exitCode !== 0) {
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
      await seeded;
      const exec = resolveExec();
      const widget = parseCodexbarWidgetSnapshot(
        (await readWidgetSnapshot(dependencies.widgetSnapshotPath ?? codexbarWidgetSnapshotPath())) ?? "",
        Date.parse(now()),
      );
      // Claude quota has one source per situation: the cswap read runs before
      // the probe loop, and a successful read with ≥2 accounts serves the
      // grouped entry and skips the codexbar claude probe for this pass.
      // Claude's STATE resolves after every other await — nothing may abort
      // between computing claude's next state and committing both its halves.
      const swapRead = await readClaudeSwap(resolveClaudeSwapExec());
      const providers: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
      for (const provider of QUOTA_PROVIDER_KEYS) {
        if (provider === "claude") {
          continue; // resolved below, after the other providers' awaits
        }
        const quota = await pollProvider(exec, provider, widget);
        if (quota !== null) {
          providers[provider] = quota;
        }
      }
      if (swapRead.kind === "ok" && swapRead.accounts.length >= 2) {
        // Atomic commit — retained rows and the entry carrying their collector
        // stamp land together, after the pass's last await, so an aborted pass
        // can never leave the two halves inconsistent.
        claudeAccounts = { accounts: swapRead.accounts, failed: false };
        const quota: ProviderQuota = {
          percentRemaining: null,
          resetAt: null,
          weeklyPercentRemaining: null,
          weeklyResetAt: null,
          unavailable: false,
          fetchedAt: swapRead.at,
          // The ambient history ring stops accumulating in grouped mode; the
          // carried ring stays frozen for a later return to the probe path.
          history: states.get("claude")?.quota.history ?? [],
          extraWindows: [],
          accounts: swapRead.accounts,
        };
        states.set("claude", { quota, failed: false });
        providers["claude"] = quota;
      } else if (
        swapRead.kind === "failed" &&
        claudeAccounts.accounts.length >= 2 &&
        states.get("claude")?.quota.fetchedAt != null
      ) {
        // Grouped starvation — settled contract (decisions.md 2026-08-27
        // 01:43): from ≥2 retained with a usable stamp, no fallback probe
        // runs and the stamp is not restamped, so a persistent failure ages
        // the group stale while a transient one only dims the rows for one
        // pass. unavailable is canonicalized false — group health rides the
        // stamp's age, and a seed persisted with unavailable: true must not
        // dim the group forever.
        if (!claudeAccounts.failed) {
          reportAccountFailure();
        }
        claudeAccounts = {
          accounts: claudeAccounts.accounts.map((account) => ({
            ...account,
            issue: "unavailable",
            unavailable: true,
          })),
          failed: true,
        };
        // The stamp condition above guarantees the entry exists; the guard
        // satisfies the Map lookup's type.
        const previous = states.get("claude");
        if (previous !== undefined) {
          const quota: ProviderQuota = {
            ...previous.quota,
            unavailable: false,
            accounts: claudeAccounts.accounts,
          };
          states.set("claude", { quota, failed: previous.failed });
          providers["claude"] = quota;
        }
      } else {
        // Not grouped this pass — cswap absent, <2 accounts reported, or a
        // failed read below the starvation conditions: claude stays on the
        // codexbar probe. The probe is the final await; everything from its
        // return to the paired retention update is synchronous.
        const ambient = await pollProvider(exec, "claude", widget);
        if (swapRead.kind === "failed") {
          if (!claudeAccounts.failed) {
            reportAccountFailure();
          }
          claudeAccounts = {
            accounts: claudeAccounts.accounts.map((account) => ({
              ...account,
              issue: "unavailable",
              unavailable: true,
            })),
            failed: true,
          };
        } else {
          claudeAccounts = { accounts: swapRead.kind === "absent" ? [] : swapRead.accounts, failed: false };
        }
        if (ambient !== null) {
          providers["claude"] = { ...ambient, accounts: claudeAccounts.accounts };
        } else if (claudeAccounts.accounts.length > 0) {
          providers["claude"] = { ...emptyQuota(), accounts: claudeAccounts.accounts };
        }
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
