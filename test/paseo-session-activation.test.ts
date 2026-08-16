import { describe, expect, test } from "bun:test";
import { type ActivatePaseoSession, createPaseoSessionActivator } from "../src/plugin/paseo-session-activation";

describe("Paseo session activation", () => {
  test("opens the paseo deep link for the agent", async () => {
    const calls: string[][] = [];
    const activate: ActivatePaseoSession = createPaseoSessionActivator(
      async (file, args) => {
        calls.push([file, ...args]);
      },
      () => "srv_abc123",
    );
    await activate("agent-9");
    expect(calls).toEqual([["/usr/bin/open", "-u", "paseo://h/srv_abc123/agent/agent-9"]]);
  });

  test("a missing server id rejects (controller shows the alert)", async () => {
    const activate = createPaseoSessionActivator(
      async () => {},
      () => {
        throw new Error("enoent");
      },
    );
    await expect(activate("agent-9")).rejects.toThrow();
  });
});
