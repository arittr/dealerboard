import { describe, expect, test } from "bun:test";
import { type AckSession, createSessionAck } from "../src/plugin/session-ack";

describe("session ack", () => {
  test("ack invokes the installed binary with sessions ack args", async () => {
    const calls: string[][] = [];
    const ack: AckSession = createSessionAck(async (file, args) => {
      calls.push([file, ...args]);
    }, "/app/bin/dealerboard");
    await ack("kimi", "session_1");
    expect(calls).toEqual([["/app/bin/dealerboard", "sessions", "ack", "kimi", "session_1"]]);
  });

  test("propagates an execution rejection to the caller", async () => {
    const failure = new Error("ack failed");
    const ack = createSessionAck(() => Promise.reject(failure), "/app/bin/dealerboard");

    await expect(ack("kimi", "session_1")).rejects.toBe(failure);
  });
});
