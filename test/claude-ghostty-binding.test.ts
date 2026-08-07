import { expect, test } from "bun:test";
import {
  createClaudeGhosttyTerminalDiscoverer,
  type ClaudeGhosttyBindingContext,
} from "../src/core/claude-ghostty-binding";

type ProcessCall = {
  file: string;
  args: readonly string[];
  timeoutMs: number;
};

const eligible: ClaudeGhosttyBindingContext = {
  termProgram: "ghostty",
  tmux: undefined,
  parentPid: 65095,
};

test("returns one bounded stable ID from the exact direct parent PID", async () => {
  const calls: ProcessCall[] = [];
  const discover = createClaudeGhosttyTerminalDiscoverer((file, args, timeoutMs) => {
    calls.push({ file, args: [...args], timeoutMs });
    return Promise.resolve("BFCA7AF6-12EF-49C8-BF83-BE0438681348|/dev/ttys000\n");
  });

  await expect(discover(eligible)).resolves.toBe("BFCA7AF6-12EF-49C8-BF83-BE0438681348");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.file).toBe("/usr/bin/osascript");
  expect(calls[0]?.args[0]).toBe("-e");
  expect(calls[0]?.args.slice(-2)).toEqual(["--", "65095"]);
  expect(calls[0]?.timeoutMs).toBe(300);
  expect(calls[0]?.args[1]).toContain('application "Ghostty" is not running');
  expect(calls[0]?.args[1]).toContain("pid of candidateTerminal");
  expect(calls[0]?.args[1]).toContain("tty of matchedTerminal");
});

test("does not spawn discovery for ineligible environments or parent PIDs", async () => {
  const calls: ProcessCall[] = [];
  const discover = createClaudeGhosttyTerminalDiscoverer((file, args, timeoutMs) => {
    calls.push({ file, args: [...args], timeoutMs });
    return Promise.resolve("terminal|/dev/ttys000\n");
  });
  const ineligible: ClaudeGhosttyBindingContext[] = [
    { ...eligible, termProgram: undefined },
    { ...eligible, termProgram: "Apple_Terminal" },
    { ...eligible, tmux: "session" },
    { ...eligible, tmux: "" },
    { ...eligible, parentPid: 0 },
    { ...eligible, parentPid: 1 },
    { ...eligible, parentPid: -2 },
    { ...eligible, parentPid: 1.5 },
    { ...eligible, parentPid: Number.NaN },
    { ...eligible, parentPid: Number.POSITIVE_INFINITY },
  ];

  for (const context of ineligible) {
    await expect(discover(context)).resolves.toBeNull();
  }
  expect(calls).toEqual([]);
});

test("rejects malformed native output", async () => {
  const malformed = [
    "",
    "terminal-only\n",
    "|/dev/ttys000\n",
    `${"x".repeat(257)}|/dev/ttys000\n`,
    "terminal|ttys000\n",
    "terminal|/dev/ttys 000\n",
    "terminal|/dev/ttys000|extra\n",
    "terminal|/dev/ttys000\nsecond|/dev/ttys001\n",
  ];

  for (const stdout of malformed) {
    const discover = createClaudeGhosttyTerminalDiscoverer(() => Promise.resolve(stdout));
    await expect(discover(eligible)).resolves.toBeNull();
  }
});

test("returns null when native discovery rejects, including timeout failures", async () => {
  const timeout = createClaudeGhosttyTerminalDiscoverer(() =>
    Promise.reject(new Error("native discovery timeout")),
  );

  await expect(timeout(eligible)).resolves.toBeNull();
});
