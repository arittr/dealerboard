import { describe, expect, test } from "bun:test";
import type { QuotaAccountMeterModel, QuotaPanelModel } from "../app/src/quota";
import { quotaRenderModel, type RailModel, railRenderSignature, renderRail } from "../app/src/rail";
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
  page: 1,
  pageCount: 2,
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

  test("changes on unread count, page, and degraded flips", () => {
    const base = railRenderSignature(model());
    expect(railRenderSignature(model({ unreadCount: 4 }))).not.toBe(base);
    expect(railRenderSignature(model({ page: 2 }))).not.toBe(base);
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

test("renders one Claude header, two bars, one active marker, and per-account dimming", () => {
  withFakeDocument((root) => {
    renderRail(root as unknown as HTMLElement, model({ quota: [groupedClaude()] }), { onJumpToPage: () => {} });
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

test("groups Claude account meters in one stack after the shared provider header", () => {
  withFakeDocument((root) => {
    renderRail(root as unknown as HTMLElement, model({ quota: [groupedClaude()] }), { onJumpToPage: () => {} });
    const group = descendants(root).find((node) => hasClass(node, "quota-group"));
    expect(group?.children.map((node) => node.className)).toEqual(["quota-provider-head", "quota-account-stack"]);
    expect(group?.children[1]?.children.map((node) => node.dataset["account"])).toEqual([
      "claude-swap:1",
      "claude-swap:2",
    ]);
  });
});
