import { describe, expect, test } from "bun:test";
import { createCodexSessionActivator, type ProcessExecutor } from "../src/plugin/codex-session-activation";

type ProcessCall = {
  file: string;
  args: string[];
};

describe("Codex session activation", () => {
  test("opens one encoded technical thread ID through the fixed macOS launcher", async () => {
    const calls: ProcessCall[] = [];
    const execute: ProcessExecutor = (file, args) => {
      calls.push({ file, args: [...args] });
      return Promise.resolve();
    };
    const activate = createCodexSessionActivator(execute);

    await activate("thread/one?two space;ü$HOME&`");

    expect(calls).toEqual([
      {
        file: "/usr/bin/open",
        args: ["-u", "codex://threads/thread%2Fone%3Ftwo%20space%3B%C3%BC%24HOME%26%60"],
      },
    ]);
  });

  test("propagates a launcher rejection", async () => {
    const failure = new Error("launch failed");
    const activate = createCodexSessionActivator(() => Promise.reject(failure));

    await expect(activate("thread-id")).rejects.toBe(failure);
  });
});
