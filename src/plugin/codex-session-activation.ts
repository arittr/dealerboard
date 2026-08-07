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

export const createCodexSessionActivator = (
  execute: ProcessExecutor,
): ActivateCodexSession =>
  (sessionId) =>
    execute("/usr/bin/open", [
      "-u",
      `codex://threads/${encodeURIComponent(sessionId)}`,
    ]);

const executeFile: ProcessExecutor = (file, args) =>
  new Promise<void>((resolve, reject) => {
    execFile(file, [...args], (error) => {
      if (error === null) {
        resolve();
        return;
      }
      reject(error);
    });
  });

export const activateCodexSession = createCodexSessionActivator(executeFile);
