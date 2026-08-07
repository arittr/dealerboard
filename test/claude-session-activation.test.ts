import { describe, expect, test } from "bun:test";
import {
  createClaudeSessionActivator,
  type ProcessExecutor,
} from "../src/plugin/claude-session-activation";

describe("Claude Ghostty session activation", () => {
  test("passes one stable terminal ID to fixed no-shell osascript", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const execute: ProcessExecutor = (file, args) => {
      calls.push({ file, args: [...args] });
      return Promise.resolve();
    };
    const activate = createClaudeSessionActivator(execute);

    await activate("terminal/one?two space;ü$HOME&`");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/usr/bin/osascript");
    expect(calls[0]?.args[0]).toBe("-e");
    expect(calls[0]?.args.slice(-2)).toEqual(["--", "terminal/one?two space;ü$HOME&`"]);
    expect(calls[0]?.args[1]).toContain('application "Ghostty" is not running');
    expect(calls[0]?.args[1]).toContain("focus matchedTerminal");
  });

  test("propagates native focus rejection", async () => {
    const failure = new Error("focus failed");
    const activate = createClaudeSessionActivator(() => Promise.reject(failure));
    await expect(activate("terminal-id")).rejects.toBe(failure);
  });
});
