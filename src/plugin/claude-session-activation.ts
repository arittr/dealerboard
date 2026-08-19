import { execFile } from "node:child_process";
import { FOCUS_GHOSTTY_TERMINAL_SCRIPT } from "./ghostty-focus";

export type ActivateClaudeSession = (ghosttyTerminalId: string) => Promise<void>;

export type ProcessExecutor = (file: string, args: readonly string[]) => Promise<void>;

export const createClaudeSessionActivator =
  (execute: ProcessExecutor): ActivateClaudeSession =>
  (ghosttyTerminalId) =>
    execute("/usr/bin/osascript", ["-e", FOCUS_GHOSTTY_TERMINAL_SCRIPT, "--", ghosttyTerminalId]);

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

export const activateClaudeSession = createClaudeSessionActivator(executeFile);
