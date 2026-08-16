/**
 * Compiled-binary entry point and command router.
 *
 * Grammar (exact):
 *   stream-deck-agents init
 *   stream-deck-agents event <claude|codex|kimi|pi|omp|zcode|deepseek>
 *   stream-deck-agents daemon
 *   stream-deck-agents sessions list
 *   stream-deck-agents sessions clear <provider> <session-id>
 *   stream-deck-agents sessions ack <provider> <session-id>
 *   stream-deck-agents sessions clear-all
 *   stream-deck-agents sessions prune [max-age-hours]
 *
 * The event path is fail-open for provider hooks: it reads at most 65,536
 * stdin bytes, parses one JSON object, applies the decoded events in one
 * transaction with a single bounded retry for SQLite contention, logs only
 * fixed diagnostic codes, prints nothing, and always exits zero. The daemon
 * subcommand starts the long-lived projection and maintenance loop and
 * normally runs until the process is terminated. The other subcommands report
 * concise errors on stderr and return nonzero.
 */

import { join } from "node:path";
import { PROVIDER_KEYS, type Provider, type RegistryEvent } from "../protocol";
import { type DiscoverClaudeGhosttyTerminal, discoverClaudeGhosttyTerminal } from "./claude-ghostty-binding";
import { ProjectionDaemon } from "./daemon";
import { createFileDiagnostics, type DiagnosticRecord } from "./diagnostics";
import { detectOrigin } from "./origin";
import { type AppPaths, resolveAppPaths } from "./paths";
import { decodeNativeHook } from "./providers";
import {
  acknowledgeSession,
  applyRegistryEvents,
  clearAllSessions,
  clearSession,
  listSessions,
  pruneStaleSessions,
} from "./registry";
import { initializeDatabase, openRegistryDatabase, UnsupportedSchemaVersion } from "./schema";
import { createTitleResolver } from "./titles";

export const MAX_STDIN_BYTES = 65_536;
const RETRY_DELAY_MS = 25;
const DIAGNOSTIC_COMPONENT = "cli";

export type CliDependencies = {
  paths: AppPaths;
  stdin?: AsyncIterable<Uint8Array>;
  now?: () => string;
  delay?: (milliseconds: number) => Promise<void>;
  diagnostics?: (record: DiagnosticRecord) => void;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  openDatabase?: typeof openRegistryDatabase;
  applyEvents?: typeof applyRegistryEvents;
  discoverClaudeGhosttyTerminal?: DiscoverClaudeGhosttyTerminal;
  environment?: Readonly<Record<string, string | undefined>>;
  parentPid?: number;
  runDaemon?: (paths: AppPaths, diagnostics: (record: DiagnosticRecord) => void) => number | Promise<number>;
};

type ResolvedDependencies = Required<CliDependencies>;

const isProvider = (value: string | undefined): value is Provider =>
  value !== undefined && (PROVIDER_KEYS as readonly string[]).includes(value);

const boundString = (value: string): string => Array.from(value).slice(0, 256).join("");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorCode = (error: unknown): string | undefined => {
  if (isRecord(error) && typeof error["code"] === "string") {
    return error["code"];
  }
  return undefined;
};

/** Only SQLite busy/locked failures qualify for the single bounded retry. */
const isSqliteContention = (error: unknown): boolean => {
  const code = errorCode(error);
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    code?.startsWith("SQLITE_BUSY_") === true ||
    code?.startsWith("SQLITE_LOCKED_") === true
  );
};

const isMissingDatabase = (error: unknown): boolean => errorCode(error) === "SQLITE_CANTOPEN";

/**
 * Consume stdin chunk by chunk, stopping as soon as the byte cap is crossed.
 * Returns null when the input exceeds the cap; trailing chunks are never
 * pulled.
 */
const readBoundedStdin = async (stdin: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array | null> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stdin) {
    total += chunk.byteLength;
    if (total > limit) {
      return null;
    }
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const USAGE = `usage: stream-deck-agents <command>

commands:
  init
  event <${PROVIDER_KEYS.join("|")}>
  daemon
  sessions list
  sessions clear <provider> <session-id>
  sessions ack <provider> <session-id>
  sessions clear-all
  sessions prune [max-age-hours]
`;

const DEFAULT_PRUNE_MAX_AGE_HOURS = 24;

/** Parse the optional prune age: a positive number of hours, default 24. */
const parsePruneMaxAgeHours = (args: readonly string[]): number | undefined => {
  if (args.length === 0) {
    return DEFAULT_PRUNE_MAX_AGE_HOURS;
  }
  if (args.length === 1) {
    const parsed = Number(args[0]);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "unknown error");

const runEvent = async (args: readonly string[], deps: ResolvedDependencies): Promise<number> => {
  const providerArg = args[0];
  const report = (record: Omit<DiagnosticRecord, "timestamp" | "component">): void => {
    try {
      deps.diagnostics({ timestamp: deps.now(), component: DIAGNOSTIC_COMPONENT, ...record });
    } catch {
      // A failing sink must never break the fail-open event path.
    }
  };

  try {
    if (!isProvider(providerArg)) {
      report({
        code: "unsupported_provider",
        ...(providerArg !== undefined ? { provider: boundString(providerArg) } : {}),
      });
      return 0;
    }
    if (args.length !== 1) {
      report({ code: "invalid_input", provider: providerArg });
      return 0;
    }

    const input = await readBoundedStdin(deps.stdin, MAX_STDIN_BYTES);
    if (input === null) {
      report({ code: "invalid_input", provider: providerArg });
      return 0;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(input));
    } catch {
      report({ code: "invalid_input", provider: providerArg });
      return 0;
    }
    if (!isRecord(payload)) {
      report({ code: "invalid_input", provider: providerArg });
      return 0;
    }

    const events = decodeNativeHook(providerArg, payload, deps.now());
    if (events.length === 0) {
      return 0;
    }
    // Origin evidence is spawn-time state of the hook helper's environment:
    // stamp it on every membership event before any per-provider rewrite.
    const origin = detectOrigin(deps.environment);
    let eventsToApply: RegistryEvent[] = events.map((event) =>
      event.kind === "SessionStart" || event.kind === "SessionObserved" ? { ...event, origin } : event,
    );
    // Every decoded event carries the same payload's session identity; the
    // first one is already bounded by the decoder.
    const sessionId = events[0]?.sessionId;

    let db: ReturnType<typeof openRegistryDatabase>;
    try {
      db = deps.openDatabase(deps.paths.database, "readwrite");
    } catch (error) {
      report({
        code:
          error instanceof UnsupportedSchemaVersion
            ? "unsupported_schema"
            : isMissingDatabase(error)
              ? "missing_database"
              : "internal_error",
        provider: providerArg,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
      return 0;
    }

    try {
      const start = eventsToApply[0];
      if (providerArg === "claude" && start?.kind === "SessionStart") {
        let terminalId: string | null = null;
        try {
          terminalId = await deps.discoverClaudeGhosttyTerminal({
            termProgram: deps.environment["TERM_PROGRAM"],
            tmux: deps.environment["TMUX"],
            parentPid: deps.parentPid,
          });
        } catch {
          terminalId = null;
        }
        if (terminalId === null) {
          report({ code: "claude_terminal_unbound", provider: providerArg, sessionId: start.sessionId });
        }
        // The spread preserves the origin stamped above.
        eventsToApply = [{ ...start, ghosttyTerminalId: terminalId }];
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          deps.applyEvents(db, eventsToApply);
          return 0;
        } catch (error) {
          if (!isSqliteContention(error)) {
            report({
              code: "internal_error",
              provider: providerArg,
              ...(sessionId !== undefined ? { sessionId } : {}),
            });
            return 0;
          }
          if (attempt === 1) {
            report({
              code: "sqlite_busy",
              provider: providerArg,
              ...(sessionId !== undefined ? { sessionId } : {}),
            });
            return 0;
          }
          await deps.delay(RETRY_DELAY_MS);
        }
      }
    } finally {
      db.close();
    }
  } catch {
    report({
      code: "internal_error",
      ...(isProvider(providerArg) ? { provider: providerArg } : {}),
    });
  }
  return 0;
};

const runInit = (args: readonly string[], deps: ResolvedDependencies): number => {
  if (args.length !== 0) {
    deps.stderr(USAGE);
    return 1;
  }
  try {
    initializeDatabase(deps.paths);
    return 0;
  } catch (error) {
    deps.stderr(`init failed: ${errorMessage(error)}\n`);
    return 1;
  }
};

const runSessions = (args: readonly string[], deps: ResolvedDependencies): number => {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list": {
      if (rest.length !== 0) {
        deps.stderr(USAGE);
        return 1;
      }
      try {
        const db = deps.openDatabase(deps.paths.database, "readonly");
        try {
          deps.stdout(`${JSON.stringify(listSessions(db), null, 2)}\n`);
        } finally {
          db.close();
        }
        return 0;
      } catch (error) {
        deps.stderr(`sessions list failed: ${errorMessage(error)}\n`);
        return 1;
      }
    }
    case "clear": {
      const [providerArg, sessionId, ...extra] = rest;
      if (!isProvider(providerArg) || sessionId === undefined || sessionId.length === 0 || extra.length > 0) {
        deps.stderr(USAGE);
        return 1;
      }
      try {
        const db = deps.openDatabase(deps.paths.database, "readwrite");
        try {
          clearSession(db, providerArg, sessionId);
        } finally {
          db.close();
        }
        return 0;
      } catch (error) {
        deps.stderr(`sessions clear failed: ${errorMessage(error)}\n`);
        return 1;
      }
    }
    case "ack": {
      const [providerArg, sessionId, ...extra] = rest;
      if (!isProvider(providerArg) || sessionId === undefined || sessionId.length === 0 || extra.length > 0) {
        deps.stderr(USAGE);
        return 1;
      }
      try {
        const db = deps.openDatabase(deps.paths.database, "readwrite");
        try {
          acknowledgeSession(db, providerArg, sessionId);
        } finally {
          db.close();
        }
        return 0;
      } catch (error) {
        deps.stderr(`sessions ack failed: ${errorMessage(error)}\n`);
        return 1;
      }
    }
    case "clear-all": {
      if (rest.length !== 0) {
        deps.stderr(USAGE);
        return 1;
      }
      try {
        const db = deps.openDatabase(deps.paths.database, "readwrite");
        try {
          clearAllSessions(db);
        } finally {
          db.close();
        }
        return 0;
      } catch (error) {
        deps.stderr(`sessions clear-all failed: ${errorMessage(error)}\n`);
        return 1;
      }
    }
    case "prune": {
      const maxAgeHours = parsePruneMaxAgeHours(rest);
      if (maxAgeHours === undefined) {
        deps.stderr(USAGE);
        return 1;
      }
      try {
        const cutoff = new Date(Date.parse(deps.now()) - maxAgeHours * 3_600_000).toISOString();
        const db = deps.openDatabase(deps.paths.database, "readwrite");
        try {
          const pruned = pruneStaleSessions(db, cutoff);
          deps.stdout(`pruned ${pruned} session${pruned === 1 ? "" : "s"}\n`);
        } finally {
          db.close();
        }
        return 0;
      } catch (error) {
        deps.stderr(`sessions prune failed: ${errorMessage(error)}\n`);
        return 1;
      }
    }
    default:
      deps.stderr(USAGE);
      return 1;
  }
};

const resolveDependencies = (dependencies: CliDependencies): ResolvedDependencies => ({
  stdin: (async function* () {
    // An absent stdin reads as empty input.
  })(),
  now: () => new Date().toISOString(),
  delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  diagnostics: () => {},
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  openDatabase: openRegistryDatabase,
  applyEvents: applyRegistryEvents,
  discoverClaudeGhosttyTerminal,
  environment: process.env,
  parentPid: process.ppid,
  runDaemon: (daemonPaths, diagnostics) => {
    const environment = process.env;
    const zcodeRoot = environment["ZCODE_HOME"] ?? join(daemonPaths.home, ".zcode");
    const resolveTitles = createTitleResolver({
      codexIndexPath: join(daemonPaths.home, ".codex/session_index.jsonl"),
      zcodeDatabasePath: join(zcodeRoot, "cli/db/db.sqlite"),
    }).resolve;
    const daemon = new ProjectionDaemon(daemonPaths, { diagnostics, resolveTitles });
    daemon.start();
    return new Promise<number>(() => {
      // launchd owns the daemon lifetime; the poll timer keeps the process alive.
    });
  },
  ...dependencies,
});

export const runCli = async (args: readonly string[], dependencies: CliDependencies): Promise<number> => {
  const deps = resolveDependencies(dependencies);
  const [command, ...rest] = args;
  switch (command) {
    case "init":
      return runInit(rest, deps);
    case "event":
      return runEvent(rest, deps);
    case "daemon": {
      if (rest.length !== 0) {
        deps.stderr(USAGE);
        return 1;
      }
      return deps.runDaemon(deps.paths, deps.diagnostics);
    }
    case "sessions":
      return runSessions(rest, deps);
    default:
      deps.stderr(USAGE);
      return 1;
  }
};

/** Incremental stdin chunks for the compiled binary entry point. */
const stdinChunks = async function* (): AsyncGenerator<Uint8Array> {
  const reader = Bun.stdin.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined && value.byteLength > 0) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
};

if (import.meta.main) {
  process.umask(0o077);
  const paths = resolveAppPaths();
  const exitCode = await runCli(process.argv.slice(2), {
    paths,
    stdin: stdinChunks(),
    diagnostics: createFileDiagnostics(paths.logsDirectory),
  });
  process.exit(exitCode);
}
