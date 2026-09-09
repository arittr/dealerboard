import { describe, expect, test } from "bun:test";
import type { QuotaAccountMeterModel, QuotaPanelModel } from "../app/src/quota";
import { buildQuotaDetailsOverlay, quotaDetailsModel } from "../app/src/quota-details";
import { quotaRenderModel } from "../app/src/rail";
import { descendants, type FakeElement, hasClass, renderedText, withFakeDocument } from "./support/fake-dom";

const NOW = Date.parse("2026-09-08T18:00:00Z");
const ID = `codexbar:${"a".repeat(64)}`;
const OTHER_ID = `codexbar:${"b".repeat(64)}`;
const target = { provider: "codex", accountId: ID } as const;
const account = (overrides: Partial<QuotaAccountMeterModel> = {}): QuotaAccountMeterModel => ({
  id: ID,
  label: "7",
  active: null,
  windows: [
    { tag: "session", percentRemaining: 35.4, resetAtMs: NOW + 90_000 },
    { tag: "weekly", percentRemaining: 60, resetAtMs: NOW + 2 * 86_400_000 },
    { tag: "monthly", percentRemaining: 88, resetAtMs: null },
  ],
  bindingIndex: 0,
  state: "ok",
  issue: null,
  fetchedAtMs: NOW - 5 * 60_000,
  ...overrides,
});
const panel = (overrides: Partial<QuotaPanelModel> = {}): QuotaPanelModel => ({
  provider: "codex",
  ...account({ fetchedAtMs: NOW }),
  history: [],
  accounts: [account(), account({ id: OTHER_ID, label: "8", windows: [] })],
  ...overrides,
});

describe("quota details targeting and published measurements", () => {
  test("resolves an account by ID after reordering, never its sibling or ambient data", () => {
    const before = panel();
    const details = quotaDetailsModel([before], target, NOW);
    expect(quotaDetailsModel([{ ...before, accounts: [...before.accounts].reverse() }], target, NOW)).toEqual(details);
    expect(details).toEqual({
      target,
      title: "Codex account 7",
      activity: "Active account is not reported",
      measurement: "Last measured 5m ago.",
      guidance: null,
      windows: [
        { tag: "session", percent: "35%", reset: "2m" },
        { tag: "weekly", percent: "60%", reset: "2d" },
        { tag: "monthly", percent: "88%", reset: "reset unknown" },
      ],
    });
  });

  test("a removed account never retargets to another row", () => {
    expect(quotaDetailsModel([], target, NOW)).toBeNull();
    expect(quotaDetailsModel([panel({ accounts: [account({ id: OTHER_ID })] })], target, NOW)).toBeNull();
    expect(quotaDetailsModel([panel({ accounts: [] })], target, NOW)).toBeNull();
    expect(quotaDetailsModel([panel({ provider: "claude" })], target, NOW)).toBeNull();
  });

  test("ambient targets resolve only a visible ambient meter", () => {
    const ambient = { provider: "codex", accountId: null } as const;
    expect(quotaDetailsModel([panel()], ambient, NOW)).toBeNull();
    expect(quotaDetailsModel([panel({ accounts: [account()] })], ambient, NOW)).toBeNull();
    expect(quotaDetailsModel([panel({ accounts: [] })], ambient, NOW)?.title).toBe("Codex quota");
  });

  test("single form preserves the sole account's ID", () => {
    const single = panel({ accounts: [account()] });
    const render = quotaRenderModel(single);
    expect(render.grouped).toBe(false);
    if (render.grouped) throw new Error("expected single form");
    expect(render.target).toEqual(target);
    expect(quotaDetailsModel([single], render.target, NOW)?.target).toEqual(target);
  });

  test("auth failures retain last measured windows and explain Claude renewal", () => {
    const saved = account({
      id: "claude-swap:2",
      label: "2",
      active: true,
      state: "unavailable",
      issue: "auth_required",
    });
    const details = quotaDetailsModel(
      [panel({ provider: "claude", accounts: [saved] })],
      { provider: "claude", accountId: saved.id },
      NOW,
    );
    expect(details?.title).toBe("Claude account 2");
    expect(details?.activity).toBe("Selected in the source switcher; running agents may use other accounts.");
    expect(details?.measurement).toBe("Last measured 5m ago. Historical measurement.");
    expect(details?.guidance).toBe("Renew this saved sign-in through cswap.");
    expect(details?.windows).toHaveLength(3);
  });

  test("rate limits explain source backoff without offering a refresh", () => {
    const details = quotaDetailsModel(
      [panel({ accounts: [account({ state: "unavailable", issue: "rate_limited" })] })],
      target,
      NOW,
    );
    expect(details?.guidance).toBe(
      "Collection is rate limited. Source retry and backoff control the next measurement.",
    );
    expect(details?.measurement).toContain("Historical measurement");
    expect(details?.windows).toHaveLength(3);
  });

  test("generic failures do not prescribe re-login and absent measurements remain unknown", () => {
    const details = quotaDetailsModel(
      [
        panel({
          accounts: [
            account({
              active: false,
              state: "unavailable",
              issue: "unavailable",
              fetchedAtMs: null,
              windows: [],
              bindingIndex: null,
            }),
          ],
        }),
      ],
      target,
      NOW,
    );
    expect(details?.activity).toBe("Not selected in the source switcher; running agents may still use this account.");
    expect(details?.measurement).toBe("No source measurement available.");
    expect(details?.guidance).toBe("Quota collection is unavailable.");
    expect(details?.windows).toEqual([]);
  });

  test("expired resets and stale measurements are historical, with live source age", () => {
    const panels = [
      panel({
        accounts: [
          account({ state: "stale", windows: [{ tag: "session", percentRemaining: 20, resetAtMs: NOW - 1 }] }),
        ],
      }),
    ];
    expect(quotaDetailsModel(panels, target, NOW)?.windows).toEqual([
      { tag: "session", percent: "20%", reset: "resetting…" },
    ]);
    expect(quotaDetailsModel(panels, target, NOW + 60_000)?.measurement).toBe(
      "Last measured 6m ago. Historical measurement.",
    );
  });
});

test("details overlay is a read-only modal with every reset before its percentage and a close button", () => {
  withFakeDocument(() => {
    let dismissed = false;
    const model = quotaDetailsModel([panel()], target, NOW)!;
    const overlay = buildQuotaDetailsOverlay(model, () => {
      dismissed = true;
    }) as unknown as FakeElement;
    const nodes = descendants(overlay);
    const dialog = nodes.find((node) => node.attributes["role"] === "dialog");
    expect(dialog?.attributes["aria-modal"]).toBe("true");
    expect(dialog?.attributes["aria-label"]).toBe("Codex account 7");
    expect(hasClass(overlay, "sheet-overlay")).toBe(true);
    expect(dialog && hasClass(dialog, "action-sheet")).toBe(true);
    expect(
      nodes.filter((node) => hasClass(node, "quota-detail-readout")).map((node) => renderedText(node).trim()),
    ).toEqual(["2m · 35% remaining", "2d · 60% remaining", "reset unknown · 88% remaining"]);
    const buttons = nodes.filter((node) => node.tagName === "button");
    expect(buttons.map((node) => node.textContent)).toEqual(["Close"]);
    buttons[0]?.listeners["click"]?.[0]?.();
    expect(dismissed).toBe(true);
    expect(renderedText(overlay)).toContain("Last measured windows");
    expect(renderedText(overlay)).not.toContain(ID);
  });
});

test("published window tags are output as text", () => {
  withFakeDocument(() => {
    const details = quotaDetailsModel([panel()], target, NOW)!;
    details.windows = [{ tag: "<b>extra</b>", percent: "70%", reset: "reset unknown" }];
    const overlay = buildQuotaDetailsOverlay(details, () => {}) as unknown as FakeElement;
    expect(descendants(overlay).some((node) => node.textContent === "<b>extra</b>")).toBe(true);
    expect(descendants(overlay).some((node) => node.tagName === "b")).toBe(false);
  });
});
