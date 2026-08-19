import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeClaudeUsage, normalizeCodexUsage, parseClaudeCredentials, parseCodexAuth } from "../src/core/quota";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "quota", name), "utf8");

describe("parseClaudeCredentials", () => {
  test("reads the captured claudeAiOauth shape", () => {
    expect(parseClaudeCredentials(fixture("claude-credentials.json"))).toEqual({
      accessToken: "sk-ant-oat01-FAKE",
      expiresAtMs: 4_800_000_000_000,
      hasProfileScope: true,
    });
  });

  test("returns null for malformed JSON, missing oauth block, and empty token", () => {
    expect(parseClaudeCredentials("not json")).toBeNull();
    expect(parseClaudeCredentials(JSON.stringify({ mcpOAuth: {} }))).toBeNull();
    expect(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toBeNull();
  });

  test("tolerates a missing expiresAt and missing scopes", () => {
    const parsed = parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
    expect(parsed).toEqual({ accessToken: "tok", expiresAtMs: null, hasProfileScope: false });
  });
});

describe("parseCodexAuth", () => {
  test("reads the captured tokens shape", () => {
    expect(parseCodexAuth(fixture("codex-auth.json"))).toEqual({
      accessToken: "FAKE-ACCESS-TOKEN",
      accountId: "acct_fake",
    });
  });

  test("returns null when only OPENAI_API_KEY is present (no quota surface)", () => {
    expect(parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-fake" }))).toBeNull();
  });

  test("tolerates camelCase token keys and a missing account id", () => {
    expect(parseCodexAuth(JSON.stringify({ tokens: { accessToken: "tok" } }))).toEqual({
      accessToken: "tok",
      accountId: null,
    });
  });

  test("returns null for malformed JSON and empty token", () => {
    expect(parseCodexAuth("nope")).toBeNull();
    expect(parseCodexAuth(JSON.stringify({ tokens: { access_token: "" } }))).toBeNull();
  });
});

describe("normalizeClaudeUsage", () => {
  test("maps five_hour/seven_day utilization to percent remaining", () => {
    expect(normalizeClaudeUsage(fixture("claude-usage.json"))).toEqual({
      session: { percentRemaining: 62.5, resetAt: "2026-08-19T22:00:00.000Z" },
      weekly: { percentRemaining: 88, resetAt: "2026-08-24T00:00:00.000Z" },
    });
  });

  test("returns null when five_hour is missing or utilization is out of range", () => {
    expect(normalizeClaudeUsage(JSON.stringify({ seven_day: { utilization: 1 } }))).toBeNull();
    expect(normalizeClaudeUsage(JSON.stringify({ five_hour: { utilization: 250 } }))).toBeNull();
    expect(normalizeClaudeUsage("junk")).toBeNull();
  });

  test("a missing or malformed seven_day leaves weekly null without failing the session window", () => {
    expect(normalizeClaudeUsage(JSON.stringify({ five_hour: { utilization: 10, resets_at: "bad" } }))).toEqual({
      session: { percentRemaining: 90, resetAt: null },
      weekly: null,
    });
  });
});

describe("normalizeCodexUsage", () => {
  test("maps primary/secondary windows to percent remaining with ISO resets", () => {
    expect(normalizeCodexUsage(fixture("codex-usage.json"))).toEqual({
      session: { percentRemaining: 73, resetAt: new Date(1_787_169_600 * 1000).toISOString() },
      weekly: { percentRemaining: 45, resetAt: new Date(1_787_616_000 * 1000).toISOString() },
    });
  });

  test("returns null when rate_limit.primary_window is missing or malformed", () => {
    expect(normalizeCodexUsage(JSON.stringify({ plan_type: "pro" }))).toBeNull();
    expect(normalizeCodexUsage(JSON.stringify({ rate_limit: { primary_window: { used_percent: 101 } } }))).toBeNull();
    expect(normalizeCodexUsage("junk")).toBeNull();
  });

  test("a missing secondary window leaves weekly null", () => {
    const body = JSON.stringify({ rate_limit: { primary_window: { used_percent: 0, reset_at: 0 } } });
    expect(normalizeCodexUsage(body)).toEqual({ session: { percentRemaining: 100, resetAt: null }, weekly: null });
  });
});
