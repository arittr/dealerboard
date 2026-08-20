import { describe, expect, test } from "bun:test";
import {
  formatPercentRemaining,
  formatResetCountdown,
  formatWeeklyLine,
  type QuotaPanelModel,
  quotaBarColor,
  quotaStatusText,
  reduceQuotaRead,
  STALE_QUOTA_AGE_MS,
  sparklinePoints,
} from "../app/src/quota";
import type { ProviderQuota } from "../src/quota-snapshot";

const NOW = Date.parse("2026-08-19T18:00:00.000Z");

const quota = (overrides: Partial<ProviderQuota> = {}): ProviderQuota => ({
  percentRemaining: 62.5,
  resetAt: "2026-08-19T22:00:00.000Z",
  weeklyPercentRemaining: 88,
  weeklyResetAt: "2026-08-24T00:00:00.000Z",
  unavailable: false,
  fetchedAt: "2026-08-19T18:00:00.000Z",
  history: [],
  ...overrides,
});

const read = (providers: Record<string, ProviderQuota>): { mtimeMs: number; contents: string } => ({
  mtimeMs: NOW,
  contents: JSON.stringify({ schemaVersion: 1, providers }),
});

const model = (overrides: Partial<QuotaPanelModel> = {}): QuotaPanelModel => ({
  provider: "claude",
  percentRemaining: 62.5,
  resetAtMs: Date.parse("2026-08-19T22:00:00.000Z"),
  weeklyPercentRemaining: 88,
  weeklyResetAtMs: Date.parse("2026-08-24T00:00:00.000Z"),
  state: "ok",
  fetchedAtMs: NOW,
  history: [],
  ...overrides,
});

describe("reduceQuotaRead", () => {
  test("a missing or unparseable read yields no panels", () => {
    expect(reduceQuotaRead(null, NOW)).toEqual([]);
    expect(reduceQuotaRead({ mtimeMs: NOW, contents: "junk" }, NOW)).toEqual([]);
  });

  test("providers present map to ok panels with parsed instants", () => {
    const panels = reduceQuotaRead(read({ claude: quota() }), NOW);
    expect(panels.length).toBe(1);
    expect(panels[0]).toMatchObject({ provider: "claude", state: "ok", percentRemaining: 62.5 });
    expect(panels[0]?.resetAtMs).toBe(Date.parse("2026-08-19T22:00:00.000Z"));
  });

  test("a failed provider with last-good data is unavailable; an old success is stale", () => {
    expect(reduceQuotaRead(read({ claude: quota({ unavailable: true }) }), NOW)[0]?.state).toBe("unavailable");
    const oldFetch = new Date(NOW - STALE_QUOTA_AGE_MS - 1).toISOString();
    expect(reduceQuotaRead(read({ claude: quota({ fetchedAt: oldFetch }) }), NOW)[0]?.state).toBe("stale");
  });

  test("a provider that never fetched is unavailable with null instants", () => {
    const panel = reduceQuotaRead(
      read({ codex: quota({ percentRemaining: null, resetAt: null, fetchedAt: null, unavailable: true }) }),
      NOW,
    )[0];
    expect(panel).toMatchObject({ provider: "codex", state: "unavailable", fetchedAtMs: null, resetAtMs: null });
  });

  test("panels follow the contract provider order across all four providers", () => {
    const panels = reduceQuotaRead(read({ zai: quota(), kimi: quota(), codex: quota(), claude: quota() }), NOW);
    expect(panels.map((panel) => panel.provider)).toEqual(["claude", "codex", "kimi", "zai"]);
  });
});

describe("formatResetCountdown", () => {
  const resetAt = NOW + 3 * 3_600_000 + 12 * 60_000;
  test("hours and minutes, bare hours, bare minutes, days, and elapsed", () => {
    expect(formatResetCountdown(resetAt, NOW)).toBe("3h 12m");
    expect(formatResetCountdown(NOW + 2 * 3_600_000, NOW)).toBe("2h");
    expect(formatResetCountdown(NOW + 42 * 60_000, NOW)).toBe("42m");
    expect(formatResetCountdown(NOW + 49 * 3_600_000, NOW)).toBe("2d");
    expect(formatResetCountdown(NOW - 1, NOW)).toBe("resetting…");
  });
});

describe("formatWeeklyLine and formatPercentRemaining", () => {
  test("weekly line combines percent and countdown, or is null without data", () => {
    expect(formatWeeklyLine(88, NOW + 4 * 86_400_000, NOW)).toBe("week 88% left · 4d");
    expect(formatWeeklyLine(88, null, NOW)).toBe("week 88% left");
    expect(formatWeeklyLine(null, null, NOW)).toBeNull();
  });

  test("percent rounds to a whole number", () => {
    expect(formatPercentRemaining(62.5)).toBe("63%");
  });
});

describe("quotaBarColor", () => {
  test("green above 25, amber from 10, red below 10", () => {
    expect(quotaBarColor(26)).toBe("#4ade80");
    expect(quotaBarColor(25)).toBe("#ffb020");
    expect(quotaBarColor(10)).toBe("#ffb020");
    expect(quotaBarColor(9)).toBe("#ff4d67");
  });
});

describe("quotaStatusText", () => {
  test("ok panels count down to the reset", () => {
    expect(quotaStatusText(model(), NOW)).toBe("resets in 4h");
  });

  test("unavailable panels with last-good data show the last-update age", () => {
    const staleModel = model({ state: "unavailable", fetchedAtMs: NOW - 12 * 60_000 });
    expect(quotaStatusText(staleModel, NOW)).toBe("updated 12m ago");
  });

  test("unavailable panels without data say so", () => {
    expect(quotaStatusText(model({ state: "unavailable", fetchedAtMs: null, percentRemaining: null }), NOW)).toBe(
      "unavailable",
    );
  });

  test("ok panels at or past the reset say resetting, not resets in resetting", () => {
    const resetAtMs = NOW + 4 * 3_600_000;
    const exact = model({ resetAtMs });
    expect(quotaStatusText(exact, resetAtMs)).toBe("resetting…");
    expect(quotaStatusText(exact, resetAtMs + 1)).toBe("resetting…");
  });
});

describe("sparklinePoints", () => {
  test("fewer than two samples or a zero-size canvas draws nothing", () => {
    expect(sparklinePoints([], 100, 20)).toEqual([]);
    expect(sparklinePoints([{ fetchedAt: "2026-08-19T18:00:00.000Z", fractionRemaining: 0.5 }], 100, 20)).toEqual([]);
    expect(
      sparklinePoints(
        [
          { fetchedAt: "2026-08-19T17:00:00.000Z", fractionRemaining: 1 },
          { fetchedAt: "2026-08-19T18:00:00.000Z", fractionRemaining: 0 },
        ],
        0,
        20,
      ),
    ).toEqual([]);
  });

  test("samples map time to x and fraction to inverted y across the canvas", () => {
    const points = sparklinePoints(
      [
        { fetchedAt: "2026-08-19T17:00:00.000Z", fractionRemaining: 1 },
        { fetchedAt: "2026-08-19T17:30:00.000Z", fractionRemaining: 0.5 },
        { fetchedAt: "2026-08-19T18:00:00.000Z", fractionRemaining: 0 },
      ],
      100,
      20,
    );
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 10 },
      { x: 100, y: 20 },
    ]);
  });
});
