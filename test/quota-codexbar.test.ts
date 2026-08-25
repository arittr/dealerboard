import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexbarUsage, parseCodexbarWidgetSnapshot } from "../src/core/quota";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "quota", name), "utf8");

describe("parseCodexbarUsage", () => {
  test("claude: primary 5-hour and secondary weekly map to session and weekly", () => {
    expect(parseCodexbarUsage(fixture("codexbar-claude.json"))).toEqual({
      kind: "ok",
      reading: {
        session: { percentRemaining: 98, resetAt: "2026-08-20T07:00:00.000Z" },
        weekly: { percentRemaining: 37, resetAt: "2026-08-21T01:00:00.000Z" },
      },
    });
  });

  test("kimi: reversed labels — the weekly window arrives as primary, the 5-hour rate window as secondary", () => {
    expect(parseCodexbarUsage(fixture("codexbar-kimi.json"))).toEqual({
      kind: "ok",
      reading: {
        session: { percentRemaining: 84, resetAt: "2026-08-20T07:27:06.000Z" },
        weekly: { percentRemaining: 88, resetAt: "2026-08-26T20:27:06.000Z" },
      },
    });
  });

  test("zai: float percentages carry through the remaining-percent flip", () => {
    expect(parseCodexbarUsage(fixture("codexbar-zai.json"))).toEqual({
      kind: "ok",
      reading: {
        session: { percentRemaining: 100 - 6.833333333333333, resetAt: "2026-08-20T08:20:38.000Z" },
        weekly: { percentRemaining: 100 - 56.364999999999995, resetAt: "2026-08-23T06:53:00.000Z" },
      },
    });
  });

  test("codex: a null primary falls back to extraRateWindows for the session window", () => {
    expect(parseCodexbarUsage(fixture("codexbar-codex.json"))).toEqual({
      kind: "ok",
      reading: {
        session: { percentRemaining: 60, resetAt: "2026-08-20T11:04:44.000Z" },
        weekly: { percentRemaining: 75, resetAt: "2026-08-27T06:03:05.000Z" },
      },
    });
  });

  test("a weekly-only account yields a reading with a null session", () => {
    const body = JSON.stringify([
      {
        usage: {
          primary: null,
          secondary: { windowMinutes: 10080, usedPercent: 63, resetsAt: "2026-08-21T01:00:00Z" },
          tertiary: null,
        },
      },
    ]);
    expect(parseCodexbarUsage(body)).toEqual({
      kind: "ok",
      reading: {
        session: null,
        weekly: { percentRemaining: 37, resetAt: "2026-08-21T01:00:00.000Z" },
      },
    });
  });

  test("a lone sub-day window is the session window with no weekly", () => {
    const body = JSON.stringify([
      { usage: { primary: { windowMinutes: 300, usedPercent: 10, resetsAt: null }, secondary: null, tertiary: null } },
    ]);
    expect(parseCodexbarUsage(body)).toEqual({
      kind: "ok",
      reading: { session: { percentRemaining: 90, resetAt: null }, weekly: null },
    });
  });

  test("invalid windows are skipped before classification", () => {
    const body = JSON.stringify([
      {
        usage: {
          primary: { windowMinutes: 300, usedPercent: 250, resetsAt: "2026-08-20T07:00:00Z" },
          secondary: { windowMinutes: 10080, usedPercent: 63, resetsAt: "2026-08-21T01:00:00Z" },
          tertiary: null,
        },
      },
    ]);
    expect(parseCodexbarUsage(body)).toEqual({
      kind: "ok",
      reading: {
        session: null,
        weekly: { percentRemaining: 37, resetAt: "2026-08-21T01:00:00.000Z" },
      },
    });
  });

  test("an unparseable resetsAt degrades to null instead of failing the window", () => {
    const body = JSON.stringify([
      {
        usage: { primary: { windowMinutes: 300, usedPercent: 10, resetsAt: "junk" }, secondary: null, tertiary: null },
      },
    ]);
    expect(parseCodexbarUsage(body)).toEqual({
      kind: "ok",
      reading: { session: { percentRemaining: 90, resetAt: null }, weekly: null },
    });
  });

  test("an empty account array means the provider is disabled in CodexBar", () => {
    expect(parseCodexbarUsage("[]")).toEqual({ kind: "absent" });
  });

  test("an unfiltered all-provider array selects the requested provider's entry", () => {
    const body = JSON.stringify([
      {
        provider: "codex",
        usage: {
          primary: null,
          secondary: { windowMinutes: 10080, usedPercent: 25, resetsAt: "2026-08-27T06:03:05Z" },
          tertiary: null,
        },
      },
      {
        provider: "alibabatokenplan",
        usage: {
          primary: { windowMinutes: 300, usedPercent: 40, resetsAt: "2026-08-24T08:00:00Z" },
          secondary: null,
          tertiary: null,
        },
      },
    ]);
    expect(parseCodexbarUsage(body, "alibabatokenplan")).toEqual({
      kind: "ok",
      reading: { session: { percentRemaining: 60, resetAt: "2026-08-24T08:00:00.000Z" }, weekly: null },
    });
  });

  test("an id-carrying array without the requested provider is absent", () => {
    expect(parseCodexbarUsage(fixture("codexbar-claude.json"), "alibabatokenplan")).toEqual({ kind: "absent" });
  });

  test("an error entry for the requested provider is invalid, not absent", () => {
    const body = JSON.stringify([
      { provider: "codex", usage: { primary: null, secondary: null, tertiary: null } },
      { provider: "alibabatokenplan", error: { kind: "provider", code: 1, message: "no cookies" } },
    ]);
    expect(parseCodexbarUsage(body, "alibabatokenplan")).toEqual({ kind: "invalid" });
  });

  test("garbage, non-arrays, entries without usage, and windowless entries are invalid", () => {
    expect(parseCodexbarUsage("not json")).toEqual({ kind: "invalid" });
    expect(parseCodexbarUsage("{}")).toEqual({ kind: "invalid" });
    expect(parseCodexbarUsage(JSON.stringify([{ provider: "kimi" }]))).toEqual({ kind: "invalid" });
    expect(parseCodexbarUsage(JSON.stringify([{ usage: { primary: null, secondary: null, tertiary: null } }]))).toEqual(
      { kind: "invalid" },
    );
  });
});

describe("parseCodexbarWidgetSnapshot", () => {
  const NOW_MS = Date.parse("2026-08-19T18:00:00.000Z");

  test("a fresh snapshot yields per-provider readings keyed by provider id", () => {
    const body = JSON.stringify({
      generatedAt: "2026-08-19T17:50:00.000Z",
      entries: [
        {
          provider: "alibabatokenplan",
          primary: null,
          secondary: { windowMinutes: 10080, usedPercent: 55, resetsAt: "2026-08-27T21:36:00Z" },
          tertiary: null,
        },
      ],
    });
    expect(parseCodexbarWidgetSnapshot(body, NOW_MS).get("alibabatokenplan")).toEqual({
      session: null,
      weekly: { percentRemaining: 45, resetAt: "2026-08-27T21:36:00.000Z" },
    });
  });

  test("stale, invalid, and windowless snapshots yield no readings", () => {
    const stale = JSON.stringify({ generatedAt: "2026-08-19T16:00:00.000Z", entries: [] });
    expect(parseCodexbarWidgetSnapshot(stale, NOW_MS).size).toBe(0);
    expect(parseCodexbarWidgetSnapshot("junk", NOW_MS).size).toBe(0);
    const windowless = JSON.stringify({
      generatedAt: "2026-08-19T17:50:00.000Z",
      entries: [{ provider: "alibabatokenplan" }],
    });
    expect(parseCodexbarWidgetSnapshot(windowless, NOW_MS).size).toBe(0);
  });
});
