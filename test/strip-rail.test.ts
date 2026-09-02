import { describe, expect, test } from "bun:test";
import type { QuotaAccountMeterModel, QuotaPanelModel } from "../app/src/quota";
import { quotaRenderModel, type RailModel, railRenderSignature, renderRail } from "../app/src/rail";
import type { HourlyActivityBucket, TokenUsageRailModel } from "../app/src/token-usage";
import { descendants, hasClass, renderedText, withFakeDocument } from "./support/fake-dom";

const NOW = Date.parse("2026-08-25T20:00:00Z");

const quotaPanel = (overrides: Partial<QuotaPanelModel> = {}): QuotaPanelModel => ({
  provider: "claude",
  windows: [{ tag: "session", percentRemaining: 55, resetAtMs: NOW + 90_000 }],
  bindingIndex: 0,
  state: "ok",
  fetchedAtMs: NOW - 60_000,
  history: [],
  accounts: [],
  ...overrides,
});

const quotaAccount = (overrides: Partial<QuotaAccountMeterModel> = {}): QuotaAccountMeterModel => ({
  id: "claude-swap:1",
  label: "1",
  active: false,
  windows: [{ tag: "session", percentRemaining: 55, resetAtMs: NOW + 90_000 }],
  bindingIndex: 0,
  state: "ok",
  fetchedAtMs: NOW - 60_000,
  ...overrides,
});

const groupedClaude = (): QuotaPanelModel =>
  quotaPanel({
    accounts: [
      quotaAccount(),
      quotaAccount({
        id: "claude-swap:2",
        label: "2",
        active: true,
        state: "unavailable",
        windows: [
          { tag: "session", percentRemaining: 20, resetAtMs: NOW + 90_000 },
          { tag: "weekly", percentRemaining: 70, resetAtMs: null },
        ],
      }),
    ],
  });

const model = (overrides: Partial<RailModel> = {}): RailModel => ({
  degraded: false,
  unreadCount: 3,
  quota: [quotaPanel()],
  tokens: { state: "hidden" },
  now: new Date(NOW),
  ...overrides,
});

describe("railRenderSignature", () => {
  test("stable across ticks that change no rendered text, so the 1s cadence can skip", () => {
    // 20s later the reset countdown still rounds to the same minute label.
    expect(railRenderSignature(model())).toBe(railRenderSignature(model({ now: new Date(NOW + 20_000) })));
  });

  test("changes when a tick rolls the countdown to a new minute label", () => {
    expect(railRenderSignature(model())).not.toBe(railRenderSignature(model({ now: new Date(NOW + 45_000) })));
  });

  test("changes on unread count and degraded flips", () => {
    const base = railRenderSignature(model());
    expect(railRenderSignature(model({ unreadCount: 4 }))).not.toBe(base);
    expect(railRenderSignature(model({ degraded: true }))).not.toBe(base);
  });

  test("changes when a quota panel's binding percent moves", () => {
    const moved = quotaPanel({ windows: [{ tag: "session", percentRemaining: 54, resetAtMs: NOW + 90_000 }] });
    expect(railRenderSignature(model({ quota: [moved] }))).not.toBe(railRenderSignature(model()));
  });

  test("changes when a non-binding window's marker moves, even with the binding untouched", () => {
    const windows = (weekly: number) => [
      { tag: "session", percentRemaining: 55, resetAtMs: NOW + 90_000 },
      { tag: "weekly", percentRemaining: weekly, resetAtMs: null },
    ];
    const before = model({ quota: [quotaPanel({ windows: windows(90) })] });
    const after = model({ quota: [quotaPanel({ windows: windows(89) })] });
    expect(railRenderSignature(after)).not.toBe(railRenderSignature(before));
  });

  test("tracks account identity, active state, state, fill, ticks, and displayed countdown", () => {
    const base = groupedClaude();
    const first = base.accounts[0];
    const second = base.accounts[1];
    if (first === undefined || second === undefined) throw new Error("grouped fixture must contain two accounts");
    const changed = (account: QuotaAccountMeterModel): string =>
      railRenderSignature(model({ quota: [{ ...base, accounts: [first, account] }] }));
    const signature = railRenderSignature(model({ quota: [base] }));
    expect(changed({ ...second, id: "claude-swap:3", label: "3" })).not.toBe(signature);
    expect(changed({ ...second, active: false })).not.toBe(signature);
    expect(changed({ ...second, state: "ok" })).not.toBe(signature);
    expect(
      changed({ ...second, windows: [{ tag: "session", percentRemaining: 54, resetAtMs: NOW + 90_000 }] }),
    ).not.toBe(signature);
    expect(railRenderSignature(model({ quota: [base], now: new Date(NOW + 20_000) }))).toBe(signature);
  });
});

test("maps grouped Claude to one provider and two stable account meters", () => {
  const render = quotaRenderModel(groupedClaude());
  expect(render.provider).toBe("claude");
  expect(render.grouped).toBe(true);
  if (!render.grouped) throw new Error("expected grouped Claude render model");
  expect(render.meters.map(({ id, label, active }) => ({ id, label, active }))).toEqual([
    { id: "claude-swap:1", label: "1", active: false },
    { id: "claude-swap:2", label: "2", active: true },
  ]);
  expect(quotaRenderModel(quotaPanel())).toMatchObject({ grouped: false, meter: { provider: "claude" } });
});

test("the grouped section carries the ambient panel state", () => {
  withFakeDocument((root) => {
    renderRail(root as unknown as HTMLElement, model({ quota: [groupedClaude()] }));
    const group = descendants(root).find((node) => hasClass(node, "quota-group"));
    expect(group?.dataset["state"]).toBe("ok");
  });
  withFakeDocument((root) => {
    const stale = quotaPanel({ state: "stale", accounts: groupedClaude().accounts });
    renderRail(root as unknown as HTMLElement, model({ quota: [stale] }));
    const group = descendants(root).find((node) => hasClass(node, "quota-group"));
    expect(group?.dataset["state"]).toBe("stale");
    // The render-skip signature must see the group-level dim, or it would not rebuild.
    expect(railRenderSignature(model({ quota: [stale] }))).not.toBe(
      railRenderSignature(model({ quota: [groupedClaude()] })),
    );
  });
});

test("renders one Claude header, two bars, one active marker, and per-account dimming", () => {
  withFakeDocument((root) => {
    renderRail(root as unknown as HTMLElement, model({ quota: [groupedClaude()] }));
    const nodes = descendants(root);
    const headers = nodes.filter((node) => hasClass(node, "quota-provider-head"));
    const accountNodes = nodes.filter((node) => hasClass(node, "quota-account"));
    expect(headers).toHaveLength(1);
    expect(headers[0]?.dataset["state"]).toBeUndefined();
    expect(nodes.filter((node) => node.textContent === "Claude")).toHaveLength(1);
    expect(nodes.filter((node) => node.textContent === "C")).toHaveLength(1);
    expect(accountNodes.map((node) => node.dataset["state"])).toEqual(["ok", "unavailable"]);
    expect(nodes.filter((node) => hasClass(node, "quota-bar"))).toHaveLength(2);
    expect(nodes.filter((node) => hasClass(node, "quota-bar-fill")).map((node) => node.style["width"])).toEqual([
      "55%",
      "20%",
    ]);
    expect(nodes.filter((node) => hasClass(node, "quota-tick")).map((node) => node.style["left"])).toEqual(["70%"]);
    expect(nodes.filter((node) => hasClass(node, "quota-account-active"))).toHaveLength(1);
    expect(accountNodes.filter((node) => node.dataset["state"] === "unavailable")).toHaveLength(1);
    expect(renderedText(root)).not.toContain("@");
    expect(renderedText(root)).not.toContain("organization");
  });
});

test("an unavailable account keeps its dimmed percent while the binding reset is pending", () => {
  withFakeDocument((root) => {
    renderRail(root as unknown as HTMLElement, model({ quota: [groupedClaude()] }));
    const nodes = descendants(root);
    expect(nodes.filter((node) => hasClass(node, "quota-pct")).map((node) => node.textContent)).toEqual(["55%", "20%"]);
    expect(nodes.filter((node) => hasClass(node, "quota-note")).map((node) => node.textContent)).toEqual([
      "2m ·",
      "2m ·",
    ]);
  });
});

test("an unavailable account drops the percent once the binding reset has passed", () => {
  const spent = quotaPanel({
    accounts: [
      quotaAccount(),
      quotaAccount({
        id: "claude-swap:2",
        label: "2",
        active: true,
        state: "unavailable",
        windows: [{ tag: "session", percentRemaining: 20, resetAtMs: null }],
      }),
    ],
  });
  withFakeDocument((root) => {
    renderRail(root as unknown as HTMLElement, model({ quota: [spent] }));
    const nodes = descendants(root);
    expect(nodes.filter((node) => hasClass(node, "quota-pct")).map((node) => node.textContent)).toEqual(["55%"]);
    expect(nodes.filter((node) => hasClass(node, "quota-note")).map((node) => node.textContent)).toEqual([
      "2m ·",
      "1m old",
    ]);
  });
});

test("groups Claude account meters in one stack after the shared provider header", () => {
  withFakeDocument((root) => {
    renderRail(root as unknown as HTMLElement, model({ quota: [groupedClaude()] }));
    const group = descendants(root).find((node) => hasClass(node, "quota-group"));
    expect(group?.children.map((node) => node.className)).toEqual(["quota-provider-head", "quota-account-stack"]);
    expect(group?.children[1]?.children.map((node) => node.dataset["account"])).toEqual([
      "claude-swap:1",
      "claude-swap:2",
    ]);
  });
});

const emptyActivity = (state: "future" | "unmeasured" = "future"): HourlyActivityBucket[] =>
  Array.from({ length: 24 }, (_, hour) => ({ hour, state, tokens: null }));

const activity = (): NonNullable<Extract<TokenUsageRailModel, { state: "ok" | "stale" }>["activity"]> => {
  const today = emptyActivity();
  today[0] = { hour: 0, state: "measured", tokens: 10 };
  today[1] = { hour: 1, state: "current", tokens: 20 };
  const yesterday = emptyActivity("unmeasured");
  yesterday[0] = { hour: 0, state: "measured", tokens: 5 };
  yesterday[1] = { hour: 1, state: "measured", tokens: 15 };
  return { today, yesterday, yMax: 20 };
};

const visibleTokens = (): Extract<TokenUsageRailModel, { state: "ok" | "stale" }> => ({
  state: "ok",
  totalTokens: 562_700_000,
  hour: { tokens: 31_100_000, trend: "up" },
  tenMin: { tokens: 12_200_000, trend: "up" },
  activity: activity(),
});

describe("token block layout", () => {
  test("stacks the two rates in a column beside the activity chart, no separator", () => {
    withFakeDocument((root) => {
      renderRail(root as unknown as HTMLElement, model({ tokens: visibleTokens() }));
      expect(root.children.map((node) => node.className)).toEqual([
        "rail-tokens",
        "rail-unread active",
        "rail-quota-zone",
      ]);
      const tokens = descendants(root).find((node) => node.className === "rail-tokens");
      expect(tokens?.children.map((node) => node.className)).toEqual(["tokens-today", "tokens-flow"]);
      const flow = tokens?.children[1];
      expect(flow?.children.map((node) => node.className)).toEqual(["tokens-rate", "rail-token-activity"]);
      expect(flow?.children[0]?.children).toHaveLength(2);
      expect(descendants(root).some((node) => node.className === "tokens-rate-sep")).toBe(false);
      expect(renderedText(root)).toContain("562.7M today");
      expect(renderedText(root)).toContain("↑ 31.1M/hr");
      expect(renderedText(root)).toContain("↑ 12.2M/10m");
    });
  });

  test("renders today bars over yesterday segments in the fixed chart box", () => {
    withFakeDocument((root) => {
      renderRail(root as unknown as HTMLElement, model({ tokens: visibleTokens() }));
      const nodes = descendants(root);
      const chart = nodes.find((node) => hasClass(node, "rail-token-activity"));
      const svg = nodes.find((node) => node.tagName === "svg");
      const svgHasClass = (node: (typeof nodes)[number], name: string): boolean =>
        node.attributes["class"]?.split(/\s+/u).includes(name) ?? false;
      const yesterday = nodes.filter((node) => svgHasClass(node, "token-activity-yesterday"));
      const bars = nodes.filter((node) => svgHasClass(node, "token-activity-bar"));
      expect(chart).toBeDefined();
      expect(chart?.listeners).toEqual({});
      expect(svg?.attributes["viewBox"]).toBe("0 0 500 84");
      expect(yesterday).toHaveLength(1);
      expect(bars).toHaveLength(2);
      expect(svgHasClass(bars[1]!, "current")).toBe(true);
      if (svg === undefined || yesterday[0] === undefined || bars[0] === undefined) {
        throw new Error("expected activity SVG, yesterday segment, and today bar");
      }
      expect(svg.children.indexOf(yesterday[0])).toBeLessThan(svg.children.indexOf(bars[0]));
    });
  });

  test("renders sparse clock labels plus yda and omits the chart without activity", () => {
    withFakeDocument((root) => {
      renderRail(root as unknown as HTMLElement, model({ tokens: visibleTokens() }));
      const svgHasClass = (node: ReturnType<typeof descendants>[number], name: string): boolean =>
        node.attributes["class"]?.split(/\s+/u).includes(name) ?? false;
      expect(
        descendants(root)
          .filter((node) => svgHasClass(node, "token-activity-axis"))
          .map((node) => node.textContent),
      ).toEqual(["12a", "12p", "12a"]);
      expect(
        descendants(root)
          .filter((node) => svgHasClass(node, "token-activity-yda"))
          .map((node) => node.textContent),
      ).toEqual(["yda"]);
    });
    withFakeDocument((root) => {
      renderRail(root as unknown as HTMLElement, model({ tokens: { ...visibleTokens(), activity: null } }));
      expect(descendants(root).some((node) => hasClass(node, "rail-token-activity"))).toBe(false);
    });
  });

  test("today-only activity renders no yesterday line or label", () => {
    withFakeDocument((root) => {
      const todayOnly = activity();
      todayOnly.yesterday = null;
      renderRail(root as unknown as HTMLElement, model({ tokens: { ...visibleTokens(), activity: todayOnly } }));
      const svgClasses = descendants(root).map((node) => node.attributes["class"] ?? "");
      expect(svgClasses.some((value) => value.includes("token-activity-yesterday"))).toBe(false);
      expect(svgClasses.some((value) => value.includes("token-activity-yda"))).toBe(false);
    });
  });

  test("the rail signature tracks activity coverage and the current marker", () => {
    const before = visibleTokens();
    const afterActivity = activity();
    afterActivity.today[2] = { hour: 2, state: "current", tokens: 4 };
    afterActivity.today[1] = { hour: 1, state: "measured", tokens: 20 };
    const after = { ...visibleTokens(), activity: afterActivity };
    expect(railRenderSignature(model({ tokens: after }))).not.toBe(railRenderSignature(model({ tokens: before })));
  });
});

test("the rail carries no pager: tokens, unread, quota only", () => {
  withFakeDocument((root) => {
    renderRail(root as unknown as HTMLElement, model({ tokens: visibleTokens() }));
    expect(root.children.map((node) => node.className.split(" ")[0])).toEqual([
      "rail-tokens",
      "rail-unread",
      "rail-quota-zone",
    ]);
  });
});

test("quota sections sit inside one flex zone after unread", () => {
  withFakeDocument((root) => {
    renderRail(root as unknown as HTMLElement, model({ quota: [quotaPanel(), quotaPanel({ provider: "codex" })] }));
    const zone = descendants(root).find((node) => node.className === "rail-quota-zone");
    expect(zone?.children.map((node) => node.className)).toEqual(["rail-quota", "rail-quota"]);
    expect(root.children.map((node) => node.className.split(" ")[0])).toEqual(["rail-unread", "rail-quota-zone"]);
  });
});
