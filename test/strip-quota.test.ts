import { describe, expect, test } from "bun:test";
import {
  bindingResetPending,
  bindingWindow,
  formatBindingNote,
  formatBindingPercent,
  formatBindingTag,
  formatPercentRemaining,
  formatResetCountdown,
  type QuotaPanelModel,
  type QuotaWindowModel,
  quotaBarColor,
  quotaReadout,
  reduceQuotaRead,
  STALE_QUOTA_AGE_MS,
  secondaryWindows,
  selectBindingIndex,
} from "../app/src/quota";
import { type ProviderQuota, type ProviderQuotaAccount, QUOTA_PROVIDER_KEYS } from "../src/quota-snapshot";

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

const quotaAccount = (overrides: Partial<ProviderQuotaAccount> = {}): ProviderQuotaAccount => ({
  id: "claude-swap:1",
  label: "1",
  active: false,
  percentRemaining: 70,
  resetAt: "2026-08-19T22:00:00.000Z",
  weeklyPercentRemaining: 80,
  weeklyResetAt: "2026-08-24T00:00:00.000Z",
  issue: null,
  unavailable: false,
  fetchedAt: "2026-08-19T18:00:00.000Z",
  extraWindows: [],
  ...overrides,
});

const read = (providers: Record<string, ProviderQuota>): { mtimeMs: number; contents: string } => ({
  mtimeMs: NOW,
  contents: JSON.stringify({ schemaVersion: 3, providers }),
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
  issue: null,
  fetchedAtMs: NOW,
  history: [],
  accounts: [],
  ...overrides,
});

describe("reduceQuotaRead", () => {
  test("a missing read yields no panels and rejected contents yield empty unavailable placeholders", () => {
    expect(reduceQuotaRead(null, NOW)).toEqual([]);
    expect(reduceQuotaRead({ mtimeMs: NOW, contents: "junk" }, NOW)).toEqual(
      QUOTA_PROVIDER_KEYS.map((provider) => ({
        provider,
        windows: [],
        bindingIndex: null,
        state: "unavailable",
        issue: null,
        fetchedAtMs: null,
        history: [],
        accounts: [],
      })),
    );
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

  test("two accounts become stable independent meter models", () => {
    const accounts = [
      quotaAccount({
        id: "claude-swap:2",
        label: "2",
        active: true,
        percentRemaining: 90,
        extraWindows: [
          {
            id: "claude-swap:2:scoped:0",
            label: "Fable",
            percentRemaining: 2,
            resetAt: "2026-08-24T00:00:00.000Z",
          },
        ],
      }),
      quotaAccount({ id: "claude-swap:1", label: "1", active: false, percentRemaining: 25 }),
    ];
    const panel = reduceQuotaRead(read({ claude: quota({ accounts }) }), NOW)[0];
    expect(panel?.accounts.map((account) => account.id)).toEqual(["claude-swap:2", "claude-swap:1"]);
    const first = panel?.accounts[0];
    const second = panel?.accounts[1];
    if (first === undefined || second === undefined) throw new Error("expected two account meters");
    expect(first).toMatchObject({ label: "2", active: true, bindingIndex: 2 });
    expect(bindingWindow(first)?.tag).toBe("Fable");
    expect(secondaryWindows(first).map((window) => window.tag)).toEqual(["session", "weekly"]);
    expect(second).toMatchObject({ label: "1", active: false, bindingIndex: 0 });
  });

  test("zero or one account stays available to the render model", () => {
    expect(reduceQuotaRead(read({ claude: quota() }), NOW)[0]?.accounts).toEqual([]);
    expect(reduceQuotaRead(read({ claude: quota({ accounts: [quotaAccount()] }) }), NOW)[0]?.accounts).toHaveLength(1);
  });

  test("a non-Claude provider with Claude account IDs rejects the read", () => {
    expect(
      reduceQuotaRead(
        read({ codex: quota({ accounts: [quotaAccount(), quotaAccount({ id: "claude-swap:2", label: "2" })] }) }),
        NOW,
      ),
    ).toEqual(
      QUOTA_PROVIDER_KEYS.map((provider) =>
        expect.objectContaining({ provider, state: "unavailable", windows: [], accounts: [] }),
      ),
    );
  });

  test("Claude account freshness uses its 45-minute measurement boundary", () => {
    const atBoundary = new Date(NOW - 45 * 60_000).toISOString();
    const afterBoundary = new Date(NOW - 45 * 60_000 - 1).toISOString();
    const panel = reduceQuotaRead(
      read({
        claude: quota({
          accounts: [
            quotaAccount({ fetchedAt: atBoundary }),
            quotaAccount({
              id: "claude-swap:2",
              label: "2",
              active: true,
              fetchedAt: afterBoundary,
            }),
          ],
        }),
      }),
      NOW,
    )[0];
    expect(panel?.accounts.map((account) => account.state)).toEqual(["ok", "stale"]);
  });

  test("Codex accounts use their six-minute measurement boundary and preserve unknown activity", () => {
    const codexAccount = (label: string, fetchedAt: string): ProviderQuotaAccount => ({
      ...quotaAccount({ fetchedAt, active: null }),
      id: `codexbar:${label === "1" ? "a".repeat(64) : "b".repeat(64)}`,
      label,
    });
    const panel = reduceQuotaRead(
      read({
        codex: quota({
          accounts: [
            codexAccount("2", new Date(NOW - 6 * 60_000 - 1).toISOString()),
            codexAccount("1", new Date(NOW - 6 * 60_000).toISOString()),
          ],
        }),
      }),
      NOW,
    )[0];
    expect(
      panel?.accounts.map((account) => ({ label: account.label, active: account.active, state: account.state })),
    ).toEqual([
      { label: "1", active: null, state: "ok" },
      { label: "2", active: null, state: "stale" },
    ]);
  });

  test("an account issue fails immediately while a healthy sibling keeps its own source timestamp", () => {
    const accountFetchedAt = new Date(NOW - 10 * 60_000).toISOString();
    const panel = reduceQuotaRead(
      read({
        claude: quota({
          fetchedAt: new Date(NOW).toISOString(),
          accounts: [
            quotaAccount({ fetchedAt: accountFetchedAt }),
            quotaAccount({ id: "claude-swap:2", label: "2", active: true, issue: "unavailable", unavailable: true }),
          ],
        }),
      }),
      NOW,
    )[0];
    expect(panel?.fetchedAtMs).toBe(NOW);
    expect(
      panel?.accounts.map((account) => ({
        state: account.state,
        issue: account.issue,
        fetchedAtMs: account.fetchedAtMs,
      })),
    ).toEqual([
      { state: "ok", issue: null, fetchedAtMs: Date.parse(accountFetchedAt) },
      { state: "unavailable", issue: "unavailable", fetchedAtMs: NOW },
    ]);
  });

  test("an exhausted seat (0% remaining, cswap healthy) stays bright", () => {
    const panel = reduceQuotaRead(
      read({
        claude: quota({
          accounts: [
            quotaAccount({ percentRemaining: 0 }),
            quotaAccount({ id: "claude-swap:2", label: "2", active: true }),
          ],
        }),
      }),
      NOW,
    )[0];
    expect(panel?.accounts.map((account) => account.state)).toEqual(["ok", "ok"]);
    expect(panel?.accounts[0]?.windows[0]?.percentRemaining).toBe(0);
  });

  test("grouped account derivation leaves the ambient meter and history unchanged", () => {
    const ambient = quota({
      percentRemaining: 40,
      weeklyPercentRemaining: 70,
      history: [{ fetchedAt: new Date(NOW).toISOString(), fractionRemaining: 0.4 }],
      accounts: [quotaAccount(), quotaAccount({ id: "claude-swap:2", label: "2", active: true })],
    });
    const panel = reduceQuotaRead(read({ claude: ambient }), NOW)[0];
    expect(panel).toMatchObject({ bindingIndex: 0, history: ambient.history });
    expect(panel?.windows.map((window) => window.percentRemaining)).toEqual([40, 70]);
    expect(panel?.accounts.map((account) => account.label)).toEqual(["1", "2"]);
  });

  test("a v3 read maps extra windows after session and weekly, and the minimum binds", () => {
    const contents = JSON.stringify({
      schemaVersion: 3,
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

  test("a grouped stamp older than three passes dims the group; a fresh stamp does not", () => {
    const groupedEntry = (fetchedAt: string) =>
      quota({
        percentRemaining: null,
        resetAt: null,
        weeklyPercentRemaining: null,
        weeklyResetAt: null,
        unavailable: false,
        fetchedAt,
        accounts: [quotaAccount(), quotaAccount({ id: "claude-swap:2", label: "2", active: true })],
      });
    const starved = reduceQuotaRead(
      read({ claude: groupedEntry(new Date(NOW - STALE_QUOTA_AGE_MS - 1).toISOString()) }),
      NOW,
    )[0];
    expect(starved?.state).toBe("stale");
    expect(starved?.accounts).toHaveLength(2);
    const fresh = reduceQuotaRead(read({ claude: groupedEntry(new Date(NOW).toISOString()) }), NOW)[0];
    expect(fresh?.state).toBe("ok");
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

  test("no windows render an em dash and an unknown-reset note", () => {
    const bare = model({ windows: [], bindingIndex: null });
    expect(formatBindingPercent(bare)).toBe("—");
    expect(formatBindingNote(bare, NOW)).toBe("reset unknown");
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

  test("unavailable panels with a pending reset and fresh last-good data show its countdown alone", () => {
    // The default model's binding session window resets 4h out — a reset
    // schedule stays trustworthy after the probe stops, so it displays,
    // bare like the ok-state countdown.
    expect(formatBindingNote(model({ state: "unavailable", fetchedAtMs: NOW - 60_000 }), NOW)).toBe("4h");
  });

  test("unavailable panels keep the countdown primary while the readout carries its age cue", () => {
    expect(formatBindingNote(model({ state: "unavailable", fetchedAtMs: NOW - 12 * 60_000 }), NOW)).toBe("4h");
  });

  test("unavailable panels whose reset has passed show the data age", () => {
    const passed = model({
      state: "unavailable",
      fetchedAtMs: NOW - 12 * 60_000,
      windows: [windowModel("weekly", 0, NOW - 60_000)],
      bindingIndex: 0,
    });
    expect(formatBindingNote(passed, NOW)).toBe("12m old");
  });

  test("the age drops minute precision at the hour scale and carries a plus", () => {
    const passed = model({
      state: "unavailable",
      fetchedAtMs: NOW - 170 * 60_000,
      windows: [windowModel("weekly", 0, NOW - 60_000)],
      bindingIndex: 0,
    });
    expect(formatBindingNote(passed, NOW)).toBe("2h+ old");
  });

  test("the age keeps minutes under an hour and floors hours with a plus past it", () => {
    const at = (ageMs: number) =>
      model({
        state: "unavailable",
        fetchedAtMs: NOW - ageMs,
        windows: [windowModel("weekly", 0, NOW - 60_000)],
        bindingIndex: 0,
      });
    expect(formatBindingNote(at(0), NOW)).toBe("1m old");
    expect(formatBindingNote(at(30_000), NOW)).toBe("1m old");
    expect(formatBindingNote(at(59 * 60_000), NOW)).toBe("59m old");
    expect(formatBindingNote(at(60 * 60_000), NOW)).toBe("1h+ old");
  });

  test("the age floors to days with a plus past 24 hours", () => {
    const passed = model({
      state: "unavailable",
      fetchedAtMs: NOW - 36 * 3_600_000,
      windows: [windowModel("weekly", 0, NOW - 60_000)],
      bindingIndex: 0,
    });
    expect(formatBindingNote(passed, NOW)).toBe("1d+ old");
  });

  test("unavailable panels without a reset instant show the data age", () => {
    const noReset = model({
      state: "unavailable",
      fetchedAtMs: NOW - 12 * 60_000,
      windows: [windowModel("session", 100)],
      bindingIndex: 0,
    });
    expect(formatBindingNote(noReset, NOW)).toBe("12m old");
  });

  test("unavailable panels without data say so", () => {
    expect(
      formatBindingNote(model({ state: "unavailable", fetchedAtMs: null, windows: [], bindingIndex: null }), NOW),
    ).toBe("unavailable");
  });

  test("a binding window without a reset instant says so; past reset says resetting", () => {
    const noReset = model({ windows: [windowModel("session", 100)], bindingIndex: 0 });
    expect(formatBindingNote(noReset, NOW)).toBe("reset unknown");
    const resetAtMs = NOW + 4 * 3_600_000;
    const resetting = model({ windows: [windowModel("session", 10, resetAtMs)], bindingIndex: 0 });
    expect(formatBindingNote(resetting, resetAtMs)).toBe("resetting…");
    expect(formatBindingNote(resetting, resetAtMs + 1)).toBe("resetting…");
  });
});

describe("bindingResetPending", () => {
  test("true while the binding window's reset is still ahead", () => {
    expect(bindingResetPending(model(), NOW)).toBe(true);
  });

  test("false once the reset has passed, when no reset is published, or with no windows", () => {
    expect(
      bindingResetPending(model({ windows: [windowModel("weekly", 0, NOW - 60_000)], bindingIndex: 0 }), NOW),
    ).toBe(false);
    expect(bindingResetPending(model({ windows: [windowModel("session", 100)], bindingIndex: 0 }), NOW)).toBe(false);
    expect(bindingResetPending(model({ windows: [], bindingIndex: null }), NOW)).toBe(false);
  });
});

describe("quotaReadout", () => {
  test("healthy usage with a future reset, including 0%, keeps the countdown, percent, and fill", () => {
    expect(quotaReadout(model({ windows: [windowModel("session", 0, NOW + 60_000)], bindingIndex: 0 }), NOW)).toEqual({
      note: "1m",
      percent: "0%",
      ageCue: null,
      showFill: true,
      historical: false,
    });
  });

  test("healthy usage with an unknown reset retains its percentage", () => {
    expect(quotaReadout(model({ windows: [windowModel("session", 70)], bindingIndex: 0 }), NOW)).toEqual({
      note: "reset unknown",
      percent: "70%",
      ageCue: null,
      showFill: true,
      historical: false,
    });
  });

  test("a healthy reading whose reset passed is visibly historical without inventing a refill", () => {
    expect(quotaReadout(model({ windows: [windowModel("session", 70, NOW - 1)], bindingIndex: 0 }), NOW)).toEqual({
      note: "resetting…",
      percent: "70%",
      ageCue: null,
      showFill: true,
      historical: true,
    });
  });

  test("stale usage before its reset keeps dimmed last-good data with an age cue", () => {
    expect(
      quotaReadout(
        model({ state: "stale", fetchedAtMs: NOW - 10 * 60_000, windows: [windowModel("session", 70, NOW + 60_000)] }),
        NOW,
      ),
    ).toEqual({ note: "1m", percent: "70%", ageCue: "10m old", showFill: true, historical: true });
  });

  test("stale usage past its binding reset suppresses percentage and fill", () => {
    const reading = model({
      state: "stale",
      fetchedAtMs: NOW - 10 * 60_000,
      windows: [windowModel("session", 70, NOW - 1)],
    });
    expect(quotaReadout(reading, NOW)).toMatchObject({ percent: null, showFill: false, historical: true });
  });

  test("unavailable usage with an unknown reset hides its stale geometry", () => {
    expect(
      quotaReadout(
        model({ state: "unavailable", fetchedAtMs: NOW - 10 * 60_000, windows: [windowModel("session", 70)] }),
        NOW,
      ),
    ).toEqual({ note: "10m old", percent: null, ageCue: null, showFill: false, historical: true });
  });

  test("never measured usage is unavailable without a percentage or fill", () => {
    expect(
      quotaReadout(model({ state: "unavailable", fetchedAtMs: null, windows: [], bindingIndex: null }), NOW),
    ).toEqual({ note: "unavailable", percent: null, ageCue: null, showFill: false, historical: true });
  });

  test("auth-required usage suppresses all stale geometry regardless of reset", () => {
    expect(
      quotaReadout(model({ issue: "auth_required", windows: [windowModel("session", 70, NOW + 60_000)] }), NOW),
    ).toEqual({ note: "Sign in again", percent: null, ageCue: null, showFill: false, historical: true });
  });

  test("rate-limited usage follows unavailable presentation while retaining its issue for details", () => {
    expect(
      quotaReadout(
        model({
          issue: "rate_limited",
          state: "unavailable",
          fetchedAtMs: NOW - 10 * 60_000,
          windows: [windowModel("session", 70, NOW + 60_000)],
        }),
        NOW,
      ),
    ).toMatchObject({ note: "1m", percent: "70%", ageCue: "10m old", showFill: true, historical: true });
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
