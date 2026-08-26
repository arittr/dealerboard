import { describe, expect, test } from "bun:test";
import {
  bindingWindow,
  formatBindingNote,
  formatBindingPercent,
  formatBindingTag,
  formatPercentRemaining,
  formatResetCountdown,
  type QuotaPanelModel,
  type QuotaWindowModel,
  quotaBarColor,
  reduceQuotaRead,
  STALE_QUOTA_AGE_MS,
  secondaryWindows,
  selectBindingIndex,
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
  extraWindows: [],
  accounts: [],
  ...overrides,
});

const read = (providers: Record<string, ProviderQuota>): { mtimeMs: number; contents: string } => ({
  mtimeMs: NOW,
  contents: JSON.stringify({ schemaVersion: 1, providers }),
});

const windowModel = (tag: string, percentRemaining: number, resetAtMs: number | null = null): QuotaWindowModel => ({
  tag,
  percentRemaining,
  resetAtMs,
});

const model = (overrides: Partial<QuotaPanelModel> = {}): QuotaPanelModel => ({
  provider: "claude",
  windows: [
    windowModel("session", 62.5, Date.parse("2026-08-19T22:00:00.000Z")),
    windowModel("weekly", 88, Date.parse("2026-08-24T00:00:00.000Z")),
  ],
  bindingIndex: 0,
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

  test("providers present map to ok panels with parsed windows in contract order", () => {
    const panels = reduceQuotaRead(read({ claude: quota() }), NOW);
    expect(panels.length).toBe(1);
    expect(panels[0]).toMatchObject({ provider: "claude", state: "ok", bindingIndex: 0 });
    expect(panels[0]?.windows).toEqual([
      { tag: "session", percentRemaining: 62.5, resetAtMs: Date.parse("2026-08-19T22:00:00.000Z") },
      { tag: "weekly", percentRemaining: 88, resetAtMs: Date.parse("2026-08-24T00:00:00.000Z") },
    ]);
  });

  test("a v2 read maps extra windows after session and weekly, and the minimum binds", () => {
    const contents = JSON.stringify({
      schemaVersion: 2,
      providers: {
        claude: quota({
          percentRemaining: 96,
          weeklyPercentRemaining: 49,
          extraWindows: [
            {
              id: "claude-weekly-scoped-fable",
              label: "Fable only",
              percentRemaining: 99,
              resetAt: "2026-08-28T01:00:00.000Z",
            },
          ],
        }),
      },
    });
    const panels = reduceQuotaRead({ mtimeMs: NOW, contents }, NOW);
    expect(panels[0]?.windows.map((entry) => entry.tag)).toEqual(["session", "weekly", "Fable only"]);
    expect(panels[0]?.bindingIndex).toBe(1);
  });

  test("a failed provider with last-good data is unavailable; an old success is stale", () => {
    expect(reduceQuotaRead(read({ claude: quota({ unavailable: true }) }), NOW)[0]?.state).toBe("unavailable");
    const oldFetch = new Date(NOW - STALE_QUOTA_AGE_MS - 1).toISOString();
    expect(reduceQuotaRead(read({ claude: quota({ fetchedAt: oldFetch }) }), NOW)[0]?.state).toBe("stale");
  });

  test("a provider that never fetched is unavailable with no windows", () => {
    const panel = reduceQuotaRead(
      read({
        codex: quota({
          percentRemaining: null,
          resetAt: null,
          weeklyPercentRemaining: null,
          weeklyResetAt: null,
          fetchedAt: null,
          unavailable: true,
        }),
      }),
      NOW,
    )[0];
    expect(panel).toMatchObject({ provider: "codex", state: "unavailable", fetchedAtMs: null, bindingIndex: null });
    expect(panel?.windows).toEqual([]);
  });

  test("panels follow the contract provider order across all five providers", () => {
    const panels = reduceQuotaRead(
      read({ qwen: quota(), zai: quota(), kimi: quota(), codex: quota(), claude: quota() }),
      NOW,
    );
    expect(panels.map((panel) => panel.provider)).toEqual(["claude", "codex", "kimi", "zai", "qwen"]);
  });
});

describe("selectBindingIndex", () => {
  test("the lowest percent binds and ties keep the earlier window", () => {
    const windows = [windowModel("session", 88), windowModel("weekly", 62.5), windowModel("Fable only", 62.5)];
    expect(selectBindingIndex(windows)).toBe(1);
    expect(selectBindingIndex([windowModel("weekly", 5)])).toBe(0);
    expect(selectBindingIndex([])).toBeNull();
  });
});

describe("formatBindingTag", () => {
  test("multi- and single-window models render the bare binding name; none is null", () => {
    expect(formatBindingTag(model())).toBe("session");
    expect(formatBindingTag(model({ windows: [windowModel("weekly", 88)], bindingIndex: 0 }))).toBe("weekly");
    expect(formatBindingTag(model({ windows: [], bindingIndex: null }))).toBeNull();
  });
});

describe("formatBindingPercent and formatBindingNote", () => {
  test("ok panels show the binding percent and its countdown", () => {
    expect(formatBindingPercent(model())).toBe("63%");
    expect(formatBindingNote(model(), NOW)).toBe("4h");
  });

  test("no windows render an em dash and no note", () => {
    const bare = model({ windows: [], bindingIndex: null });
    expect(formatBindingPercent(bare)).toBe("—");
    expect(formatBindingNote(bare, NOW)).toBe("");
  });

  test("the binding window drives both texts", () => {
    const bound = model({
      windows: [windowModel("session", 96, NOW + 35 * 60_000), windowModel("weekly", 49, NOW + 42 * 3_600_000)],
      bindingIndex: 1,
    });
    expect(formatBindingPercent(bound)).toBe("49%");
    // 42h formats as days from 24h out (bd64136); the brief's "42h" predates that landed fix.
    expect(formatBindingNote(bound, NOW)).toBe("2d");
    expect(bindingWindow(bound)?.tag).toBe("weekly");
  });

  test("unavailable panels with last-good data show the last-update age", () => {
    expect(formatBindingNote(model({ state: "unavailable", fetchedAtMs: NOW - 12 * 60_000 }), NOW)).toBe(
      "updated 12m ago",
    );
  });

  test("unavailable panels without data say so", () => {
    expect(
      formatBindingNote(model({ state: "unavailable", fetchedAtMs: null, windows: [], bindingIndex: null }), NOW),
    ).toBe("unavailable");
  });

  test("a binding window without a reset instant has no note; past reset says resetting", () => {
    const noReset = model({ windows: [windowModel("session", 100)], bindingIndex: 0 });
    expect(formatBindingNote(noReset, NOW)).toBe("");
    const resetAtMs = NOW + 4 * 3_600_000;
    const resetting = model({ windows: [windowModel("session", 10, resetAtMs)], bindingIndex: 0 });
    expect(formatBindingNote(resetting, resetAtMs)).toBe("resetting…");
    expect(formatBindingNote(resetting, resetAtMs + 1)).toBe("resetting…");
  });
});

describe("formatResetCountdown", () => {
  const resetAt = NOW + 3 * 3_600_000 + 12 * 60_000;
  test("hours and minutes, bare hours, bare minutes, days, and elapsed", () => {
    expect(formatResetCountdown(resetAt, NOW)).toBe("3h 12m");
    expect(formatResetCountdown(NOW + 2 * 3_600_000, NOW)).toBe("2h");
    expect(formatResetCountdown(NOW + 42 * 60_000, NOW)).toBe("42m");
    expect(formatResetCountdown(NOW + 23 * 3_600_000, NOW)).toBe("23h");
    expect(formatResetCountdown(NOW + 24 * 3_600_000, NOW)).toBe("1d");
    expect(formatResetCountdown(NOW + 43 * 3_600_000, NOW)).toBe("2d");
    expect(formatResetCountdown(NOW + 49 * 3_600_000, NOW)).toBe("2d");
    expect(formatResetCountdown(NOW - 1, NOW)).toBe("resetting…");
  });
});

describe("formatPercentRemaining and quotaBarColor", () => {
  test("percent rounds to a whole number", () => {
    expect(formatPercentRemaining(62.5)).toBe("63%");
  });

  test("green above 25, amber from 10, red below 10", () => {
    expect(quotaBarColor(26)).toBe("#4ade80");
    expect(quotaBarColor(25)).toBe("#ffb020");
    expect(quotaBarColor(10)).toBe("#ffb020");
    expect(quotaBarColor(9)).toBe("#ff4d67");
  });
});

describe("secondaryWindows", () => {
  test("every non-binding window in published order (the bar's tick positions)", () => {
    const panel = model({
      windows: [windowModel("session", 62.5), windowModel("weekly", 88), windowModel("Fable only", 40.4)],
      bindingIndex: 2,
    });
    expect(secondaryWindows(panel)).toEqual([windowModel("session", 62.5), windowModel("weekly", 88)]);
  });

  test("a weekly-binding panel surfaces the session window as the secondary", () => {
    const panel = model({ bindingIndex: 1 });
    expect(secondaryWindows(panel).map((entry) => entry.tag)).toEqual(["session"]);
  });

  test("a lone window has no secondaries; no windows, none either", () => {
    expect(secondaryWindows(model({ windows: [windowModel("session", 10)], bindingIndex: 0 }))).toEqual([]);
    expect(secondaryWindows(model({ windows: [], bindingIndex: null }))).toEqual([]);
  });
});
