import { describe, expect, test } from "bun:test";
import type { QuotaPanelModel } from "../app/src/quota";
import { type RailModel, railRenderSignature } from "../app/src/rail";

const NOW = Date.parse("2026-08-25T20:00:00Z");

const quotaPanel = (overrides: Partial<QuotaPanelModel> = {}): QuotaPanelModel => ({
  provider: "claude",
  windows: [{ tag: "session", percentRemaining: 55, resetAtMs: NOW + 90_000 }],
  bindingIndex: 0,
  state: "ok",
  fetchedAtMs: NOW - 60_000,
  history: [],
  ...overrides,
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
});
