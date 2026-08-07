import { execFile } from "node:child_process";

const FOCUS_GHOSTTY_TERMINAL_SCRIPT = `
on run argv
  set targetId to item 1 of argv
  if application "Ghostty" is not running then error "ghostty_not_running"
  tell application "Ghostty"
    set matchingTerminals to {}
    repeat with candidateWindow in windows
      repeat with candidateTerminal in terminals of candidateWindow
        if (id of candidateTerminal) is targetId then
          set end of matchingTerminals to candidateTerminal
        end if
      end repeat
    end repeat
    if (count of matchingTerminals) is not 1 then error "ghostty_terminal_match_count"
    set matchedTerminal to item 1 of matchingTerminals
    focus matchedTerminal
  end tell
end run`;

export type ActivateClaudeSession = (ghosttyTerminalId: string) => Promise<void>;

export type ProcessExecutor = (file: string, args: readonly string[]) => Promise<void>;

export const createClaudeSessionActivator = (
  execute: ProcessExecutor,
): ActivateClaudeSession =>
  (ghosttyTerminalId) =>
    execute("/usr/bin/osascript", [
      "-e",
      FOCUS_GHOSTTY_TERMINAL_SCRIPT,
      "--",
      ghosttyTerminalId,
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

export const activateClaudeSession = createClaudeSessionActivator(executeFile);
