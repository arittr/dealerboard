import { describe, expect, test } from "bun:test";
import { reconcileQuotaAccounts } from "../src/core/quota-accounts";
import type { ProviderQuotaAccount } from "../src/quota-snapshot";

const account = (slot: number, overrides: Partial<ProviderQuotaAccount> = {}): ProviderQuotaAccount => ({
  id: `claude-swap:${slot}`,
  label: String(slot),
  active: false,
  percentRemaining: 80,
  resetAt: "2030-01-01T05:00:00.000Z",
  weeklyPercentRemaining: 70,
  weeklyResetAt: "2030-01-08T00:00:00.000Z",
  fetchedAt: "2026-09-08T18:00:00.000Z",
  issue: null,
  unavailable: false,
  extraWindows: [],
  ...overrides,
});
const frozen = (accounts: ProviderQuotaAccount[]): readonly ProviderQuotaAccount[] => {
  for (const row of accounts) {
    Object.freeze(row.extraWindows);
    Object.freeze(row);
  }
  return Object.freeze(accounts);
};
const reconcile = (previous: ProviderQuotaAccount[], observed: ProviderQuotaAccount[], completeInventory = false) =>
  reconcileQuotaAccounts(frozen(previous), Object.freeze({ accounts: frozen(observed), completeInventory }));

describe("reconcileQuotaAccounts", () => {
  test("merges successful peers and preserves newer measurements on failed peers", () => {
    const a = account(1);
    const b = account(2);
    expect(
      reconcile(
        [a, b],
        [
          account(1, { percentRemaining: 60 }),
          account(2, {
            percentRemaining: 10,
            fetchedAt: "2026-09-08T17:00:00.000Z",
            issue: "auth_required",
            unavailable: true,
          }),
        ],
      ),
    ).toEqual({
      kind: "ok",
      accounts: [account(1, { percentRemaining: 60 }), { ...b, issue: "auth_required", unavailable: true }],
    });
  });
  test("failed observations with no history retain measurement; newer source history wins", () => {
    const old = account(1);
    for (const fetchedAt of [null, "2026-09-08T18:00:00.000Z"]) {
      expect(
        reconcile([old], [account(1, { fetchedAt, percentRemaining: null, issue: "unavailable", unavailable: true })]),
      ).toEqual({ kind: "ok", accounts: [{ ...old, issue: "unavailable", unavailable: true }] });
    }
    const newer = account(1, {
      fetchedAt: "2026-09-08T18:02:00.000Z",
      percentRemaining: 60,
      issue: "rate_limited",
      unavailable: true,
    });
    expect(reconcile([old], [newer])).toEqual({ kind: "ok", accounts: [newer] });
  });
  test("omitted or adapter-suppressed duplicate rows retain their own history and specific issues", () => {
    const a = account(1, { issue: "auth_required", unavailable: true });
    const b = account(2);
    expect(reconcile([a, b], [])).toEqual({
      kind: "ok",
      accounts: [a, { ...b, issue: "unavailable", unavailable: true }],
    });
    expect(reconcile([a], [account(1, { issue: "unavailable", unavailable: true })])).toEqual({
      kind: "ok",
      accounts: [a],
    });
    expect(reconcile([a], [account(1)], true)).toEqual({ kind: "ok", accounts: [account(1)] });
  });
  test("complete inventories authorize zero, one, two, and removed account transitions", () => {
    expect(reconcile([], [], true)).toEqual({ kind: "ok", accounts: [] });
    expect(reconcile([], [account(1)], true)).toEqual({ kind: "ok", accounts: [account(1)] });
    expect(reconcile([account(1)], [account(2), account(1)], true)).toEqual({
      kind: "ok",
      accounts: [account(1), account(2)],
    });
    expect(reconcile([account(1), account(2)], [account(2)], true)).toEqual({ kind: "ok", accounts: [account(2)] });
    expect(reconcile([account(2)], [], true)).toEqual({ kind: "ok", accounts: [] });
  });
  test("keeps retained labels, numeric order, explicit activity, and cached timestamps", () => {
    const a = account(1, { label: "10", active: true });
    const b = account(2, { active: null });
    expect(reconcile([a, b], [account(3, { active: true }), account(1, { active: false })])).toEqual({
      kind: "ok",
      accounts: [
        { ...b, issue: "unavailable", unavailable: true },
        account(3, { active: true }),
        { ...a, active: false },
      ],
    });
    expect(reconcile([account(1, { active: true })], [account(2, { active: true })])).toEqual({
      kind: "ok",
      accounts: [account(1, { active: false, issue: "unavailable", unavailable: true }), account(2, { active: true })],
    });
  });
  test("reports partial union overflow without mutating the prior inventory", () => {
    const previous = Array.from({ length: 8 }, (_, index) => account(index + 1));
    expect(reconcile(previous, [account(9)])).toEqual({ kind: "overflow" });
    expect(reconcile(previous, [account(9)], true)).toEqual({ kind: "ok", accounts: [account(9)] });
  });
});
