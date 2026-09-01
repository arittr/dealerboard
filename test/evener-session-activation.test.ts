import { expect, test } from "bun:test";
import { createEvenerSessionActivator } from "../src/plugin/evener-session-activation";

test("invokes the installed Dealerboard CLI with fixed Evener activation argv", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const activate = createEvenerSessionActivator(async (file, args) => {
    calls.push({ file, args });
  }, "/app/bin/dealerboard");

  await activate("session;still-data");

  expect(calls).toEqual([
    {
      file: "/app/bin/dealerboard",
      args: ["sessions", "activate", "evener", "session;still-data"],
    },
  ]);
});

test("propagates an executor rejection unchanged", async () => {
  const failure = new Error("activation failed");
  const activate = createEvenerSessionActivator(() => Promise.reject(failure), "/app/bin/dealerboard");

  await expect(activate("session-id")).rejects.toBe(failure);
});
