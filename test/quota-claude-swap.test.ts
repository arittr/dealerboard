import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeSwapBinaryCandidates, parseClaudeSwapAccounts } from "../src/core/claude-swap-quota";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "quota", name), "utf8");

describe("parseClaudeSwapAccounts", () => {
  test("normalizes privacy-safe account readings and sorts numeric slots", () => {
    const parsed = parseClaudeSwapAccounts(fixture("claude-swap-accounts.json"));
    expect(parsed).toEqual({
      kind: "ok",
      accounts: [
        {
          id: "claude-swap:1",
          label: "1",
          active: false,
          percentRemaining: 75,
          resetAt: "2026-08-26T02:19:00.000Z",
          weeklyPercentRemaining: 60,
          weeklyResetAt: "2026-08-30T00:59:00.000Z",
          unavailable: false,
          fetchedAt: "2026-08-25T20:00:00.000Z",
          extraWindows: [
            {
              id: "claude-swap:1:scoped:0",
              label: "Fable",
              percentRemaining: 55,
              resetAt: "2026-08-30T00:59:00.000Z",
            },
          ],
        },
        {
          id: "claude-swap:2",
          label: "2",
          active: true,
          percentRemaining: 100,
          resetAt: null,
          weeklyPercentRemaining: 44,
          weeklyResetAt: "2026-08-30T00:59:00.000Z",
          unavailable: true,
          fetchedAt: "2026-08-25T19:30:00.000Z",
          extraWindows: [
            {
              id: "claude-swap:2:scoped:0",
              label: "Fable",
              percentRemaining: 2,
              resetAt: "2026-08-30T00:59:00.000Z",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("@");
    expect(JSON.stringify(parsed)).not.toContain("organization");
    expect(JSON.stringify(parsed)).not.toContain("Ignored");
  });

  test("accepts an empty account collection", () => {
    expect(parseClaudeSwapAccounts(JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: [] }))).toEqual(
      { kind: "ok", accounts: [] },
    );
  });

  test("falls back to last-good and otherwise retains an empty unavailable slot", () => {
    const parsed = parseClaudeSwapAccounts(
      JSON.stringify({
        schemaVersion: 1,
        activeAccountNumber: 1,
        accounts: [
          {
            number: 1,
            usageStatus: "ok",
            usage: { fiveHour: { pct: 10 } },
            usageFetchedAt: "not-an-instant",
            lastGoodUsage: { sevenDay: { pct: 30, resetsAt: "2026-08-30T00:59:00Z" } },
            lastGoodFetchedAt: "2026-08-25T19:30:00Z",
          },
          { number: 2, usageStatus: "token_expired" },
        ],
      }),
    );
    expect(parsed).toMatchObject({
      kind: "ok",
      accounts: [
        { id: "claude-swap:1", unavailable: true, weeklyPercentRemaining: 70, fetchedAt: "2026-08-25T19:30:00.000Z" },
        { id: "claude-swap:2", unavailable: true, percentRemaining: null, fetchedAt: null, extraWindows: [] },
      ],
    });
  });

  test("drops only malformed scoped rows and nulls invalid reset instants", () => {
    const parsed = parseClaudeSwapAccounts(
      JSON.stringify({
        schemaVersion: 1,
        activeAccountNumber: 1,
        accounts: [
          {
            number: 1,
            usageStatus: "ok",
            usageFetchedAt: "2026-08-25T20:00:00Z",
            usage: {
              fiveHour: { pct: 25, resetsAt: "bad" },
              scoped: [{ name: "Fable", pct: 45 }, { name: "broken", pct: 101 }, null],
            },
          },
        ],
      }),
    );
    expect(parsed).toMatchObject({
      kind: "ok",
      accounts: [{ resetAt: null, extraWindows: [{ label: "Fable", percentRemaining: 55, resetAt: null }] }],
    });
  });

  test.each([
    ["invalid JSON", "{"],
    ["non-object", "[]"],
    ["wrong schema", JSON.stringify({ schemaVersion: 2, activeAccountNumber: 1, accounts: [] })],
    ["invalid slot", JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: [{ number: 0 }] })],
    [
      "duplicate slot",
      JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: [{ number: 1 }, { number: 1 }] }),
    ],
    ["missing active", JSON.stringify({ schemaVersion: 1, activeAccountNumber: 2, accounts: [{ number: 1 }] })],
    [
      "nine accounts",
      JSON.stringify({
        schemaVersion: 1,
        activeAccountNumber: 1,
        accounts: Array.from({ length: 9 }, (_, index) => ({ number: index + 1 })),
      }),
    ],
  ])("rejects %s", (_name, body) => {
    expect(parseClaudeSwapAccounts(body)).toEqual({ kind: "invalid" });
  });

  test("uses only the three approved binary candidates", () => {
    expect(claudeSwapBinaryCandidates("/Users/test")).toEqual([
      "/Users/test/.local/bin/cswap",
      "/opt/homebrew/bin/cswap",
      "/usr/local/bin/cswap",
    ]);
  });
});
