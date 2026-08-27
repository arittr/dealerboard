import { execFile } from "node:child_process";

const DISCOVERY_TIMEOUT_MS = 300;
const MAX_OUTPUT_BYTES = 4_096;

const DISCOVER_GHOSTTY_TERMINAL_SCRIPT = `
on run argv
  set targetPid to (item 1 of argv) as integer
  if application "Ghostty" is not running then error "ghostty_not_running"
  tell application "Ghostty"
    set matchingTerminals to {}
    repeat with candidateWindow in windows
      repeat with candidateTerminal in terminals of candidateWindow
        if (pid of candidateTerminal) is targetPid then
          set end of matchingTerminals to candidateTerminal
        end if
      end repeat
    end repeat
    if (count of matchingTerminals) is not 1 then error "ghostty_terminal_match_count"
    set matchedTerminal to item 1 of matchingTerminals
    return (id of matchedTerminal) & "|" & (tty of matchedTerminal)
  end tell
end run`;

export type ClaudeGhosttyBindingContext = {
  termProgram: string | undefined;
  tmux: string | undefined;
  parentPid: number;
};

export type TextProcessExecutor = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;

export type DiscoverClaudeGhosttyTerminal = (context: ClaudeGhosttyBindingContext) => Promise<string | null>;

export const createClaudeGhosttyTerminalDiscoverer =
  (execute: TextProcessExecutor): DiscoverClaudeGhosttyTerminal =>
  async (context) => {
    if (
      context.termProgram !== "ghostty" ||
      context.tmux !== undefined ||
      !Number.isInteger(context.parentPid) ||
      context.parentPid <= 1
    ) {
      return null;
    }
    try {
      const output = await execute(
        "/usr/bin/osascript",
        ["-e", DISCOVER_GHOSTTY_TERMINAL_SCRIPT, "--", String(context.parentPid)],
        DISCOVERY_TIMEOUT_MS,
      );
      const line = output.replace(/\r?\n$/u, "");
      if (line.includes("\n") || line.includes("\r")) {
        return null;
      }
      const parts = line.split("|");
      if (parts.length !== 2) {
        return null;
      }
      const terminalId = parts[0];
      const tty = parts[1];
      if (
        terminalId === undefined ||
        tty === undefined ||
        Array.from(terminalId).length < 1 ||
        Array.from(terminalId).length > 256 ||
        !/^\/dev\/tty[^/\s]*$/u.test(tty)
      ) {
        return null;
      }
      return terminalId;
    } catch {
      return null;
    }
  };

const executeFileText: TextProcessExecutor = (file, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        reject(error);
      },
    );
  });

export const discoverClaudeGhosttyTerminal = createClaudeGhosttyTerminalDiscoverer(executeFileText);
