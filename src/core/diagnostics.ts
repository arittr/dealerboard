/**
 * Bounded, payload-free local diagnostics.
 *
 * Every component appends one JSON line per incident to
 * `<logsDirectory>/<component>.log`. A record carries only a timestamp, the
 * fixed component name, a fixed internal code, and optionally the provider
 * and a bounded session ID — never raw payloads, prompts, tool data, or
 * caught error text. Before an append would push the log past 256 KiB, the
 * current file rotates to `<component>.log.1`, replacing any previous
 * rotation. Diagnostics are best-effort: a logging failure never breaks the
 * caller.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export type DiagnosticCode =
  | "invalid_input"
  | "unsupported_provider"
  | "missing_database"
  | "unsupported_schema"
  | "sqlite_busy"
  | "claude_terminal_unbound"
  | "internal_error";

export type DiagnosticRecord = {
  timestamp: string;
  component: string;
  code: DiagnosticCode;
  provider?: string;
  sessionId?: string;
};

const MAX_LOG_BYTES = 256 * 1024;
const LOGS_DIRECTORY_MODE = 0o700;

/**
 * A diagnostics sink writing one bounded JSON line per incident. The logs
 * directory is created on demand so event-path failures before `init` still
 * record. All filesystem errors are swallowed.
 */
export const createFileDiagnostics = (logsDirectory: string): ((record: DiagnosticRecord) => void) => {
  return (record) => {
    try {
      mkdirSync(logsDirectory, { recursive: true, mode: LOGS_DIRECTORY_MODE });
      const line = `${JSON.stringify(record)}\n`;
      const logFile = join(logsDirectory, `${record.component}.log`);
      let currentSize = 0;
      try {
        currentSize = statSync(logFile).size;
      } catch {
        // No log yet; it starts empty.
      }
      if (currentSize + Buffer.byteLength(line) > MAX_LOG_BYTES) {
        renameSync(logFile, join(logsDirectory, `${record.component}.log.1`));
      }
      appendFileSync(logFile, line);
    } catch {
      // Diagnostics must never break a fail-open caller.
    }
  };
};
