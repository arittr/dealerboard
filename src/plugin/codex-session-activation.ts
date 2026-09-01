/**
 * Exact Codex desktop navigation behind a small injectable process boundary.
 *
 * The fixed executable and argument array avoid shell parsing; the caller
 * receives only LaunchServices request success or failure, not app-level
 * confirmation that the requested task became visible.
 */

import { execFile } from "node:child_process";

export type ActivateCodexSession = (sessionId: string) => Promise<void>;

export type ProcessExecutor = (file: string, args: readonly string[]) => Promise<void>;

export const createCodexSessionActivator =
  (execute: ProcessExecutor): ActivateCodexSession =>
  (sessionId) =>
    execute("/usr/bin/open", ["-u", `codex://threads/${encodeURIComponent(sessionId)}`]);

const executeFile: ProcessExecutor = (file, args) => {
  // The plugin process is the deliberate boundary where the inherited env is sanitized.
  const environment = Object.fromEntries(
    // biome-ignore lint/style/noProcessEnv: sanitize the environment before the CLI hop
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[0] !== "EVENER_HUB_AUTH_TOKEN" && entry[1] !== undefined,
    ),
  );
  return new Promise<void>((resolve, reject) => {
    execFile(file, [...args], { env: environment }, (error) => {
      if (error === null) {
        resolve();
        return;
      }
      reject(error);
    });
  });
};

/** Shared process boundary for every activation and ack path; one copy, injected. */
export { executeFile };

export const activateCodexSession = createCodexSessionActivator(executeFile);
