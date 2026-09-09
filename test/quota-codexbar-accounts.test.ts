import { describe, expect, test } from "bun:test";
import { codexAccountId, parseCodexbarAccounts } from "../src/core/codexbar-accounts";

const codexRecord = (account: string, usedPercent: number) => ({
  provider: "codex",
  account,
  usage: {
    updatedAt: "2026-09-08T18:00:00Z",
    primary: { windowMinutes: 300, usedPercent, resetsAt: "2026-09-08T23:00:00Z" },
  },
});

describe("parseCodexbarAccounts", () => {
  test("identifies accounts across response order changes", () => {
    const first = parseCodexbarAccounts(
      JSON.stringify([codexRecord("synthetic-a", 20), codexRecord("synthetic-b", 90)]),
      0,
      [],
    );
    if (first.kind !== "ok") throw new Error("expected parsed accounts");
    const next = parseCodexbarAccounts(
      JSON.stringify([codexRecord("synthetic-b", 80), codexRecord("synthetic-a", 30)]),
      0,
      first.accounts,
    );
    if (next.kind !== "ok") throw new Error("expected parsed accounts");
    expect(next.accounts.map(({ id, label }) => ({ id, label }))).toEqual(
      first.accounts.map(({ id, label }) => ({ id, label })),
    );
    expect(next.accounts.find((account) => account.id === codexAccountId("synthetic-a"))).toMatchObject({
      percentRemaining: 70,
      active: null,
      fetchedAt: "2026-09-08T18:00:00.000Z",
    });
  });

  test("trims source labels while preserving distinct internal labels and treating renames as new accounts", () => {
    const first = parseCodexbarAccounts(
      JSON.stringify([codexRecord("  alpha beta  ", 10), codexRecord("alpha  beta", 20)]),
      0,
      [],
    );
    if (first.kind !== "ok") throw new Error("expected parsed accounts");
    expect(first.accounts.map((account) => account.id)).toEqual(
      [codexAccountId("alpha beta"), codexAccountId("alpha  beta")].sort(),
    );
    const renamed = parseCodexbarAccounts(JSON.stringify([codexRecord("renamed", 10)]), 0, first.accounts);
    if (renamed.kind !== "ok") throw new Error("expected parsed accounts");
    expect(renamed.accounts).toMatchObject([{ id: codexAccountId("renamed"), label: "3" }]);
  });

  test("rejects duplicate, empty, and over-limit identities without inventing account rows", () => {
    const duplicate = parseCodexbarAccounts(
      JSON.stringify([codexRecord(" same ", 10), codexRecord("same", 20)]),
      0,
      [],
    );
    expect(duplicate).toMatchObject({ kind: "ok", accounts: [], completeInventory: false, inventoryObserved: false });
    const empty = parseCodexbarAccounts(JSON.stringify([codexRecord("   ", 10)]), 0, []);
    expect(empty).toMatchObject({ kind: "ok", accounts: [], completeInventory: false, inventoryObserved: false });
    expect(
      parseCodexbarAccounts(
        JSON.stringify(Array.from({ length: 9 }, (_, index) => codexRecord(`account-${index}`, index))),
        0,
        [],
      ),
    ).toEqual({ kind: "invalid" });
  });

  test("keeps only valid, identified Codex successes and ignores unrelated providers", () => {
    const parsed = parseCodexbarAccounts(
      JSON.stringify([
        {
          ...codexRecord("valid", 10),
          usage: {
            ...codexRecord("valid", 10).usage,
            extraRateWindows: [
              { id: "spark", title: "Codex Spark", window: { windowMinutes: 10080, usedPercent: 40, resetsAt: null } },
            ],
          },
        },
        { provider: "qwen", account: "not-codex", usage: { updatedAt: "2026-09-08T18:00:00Z" } },
      ]),
      0,
      [],
    );
    expect(parsed).toMatchObject({
      kind: "ok",
      completeInventory: true,
      inventoryObserved: true,
      accounts: [{ percentRemaining: 90, weeklyPercentRemaining: 60, fetchedAt: "2026-09-08T18:00:00.000Z" }],
    });
  });

  test("does not treat malformed usage or malformed roots as a complete inventory", () => {
    expect(parseCodexbarAccounts("{", 0, [])).toEqual({ kind: "invalid" });
    for (const usage of [
      { primary: { windowMinutes: 300, usedPercent: 10 } },
      { updatedAt: "bad" },
      { updatedAt: "2026-09-08T18:00:00Z" },
    ]) {
      expect(parseCodexbarAccounts(JSON.stringify([{ provider: "codex", account: "a", usage }]), 0, [])).toMatchObject({
        kind: "ok",
        accounts: [],
        completeInventory: false,
        inventoryObserved: false,
      });
    }
  });

  test("distinguishes empty success, failed empty output, and anonymous ambient readings", () => {
    expect(parseCodexbarAccounts("[]", 0, [])).toMatchObject({
      kind: "ok",
      accounts: [],
      completeInventory: true,
      inventoryObserved: true,
      ambient: null,
    });
    expect(parseCodexbarAccounts("[]", 1, [])).toMatchObject({
      kind: "ok",
      accounts: [],
      completeInventory: false,
      inventoryObserved: true,
      ambient: null,
    });
    const anonymous = { ...codexRecord("ignored", 30), account: undefined };
    expect(parseCodexbarAccounts(JSON.stringify([anonymous]), 0, [])).toMatchObject({
      kind: "ok",
      accounts: [],
      completeInventory: false,
      inventoryObserved: false,
      ambient: { reading: { session: { percentRemaining: 70 } }, fetchedAt: "2026-09-08T18:00:00.000Z" },
    });
    expect(parseCodexbarAccounts(JSON.stringify([anonymous, anonymous]), 0, [])).toMatchObject({
      kind: "ok",
      ambient: null,
      completeInventory: false,
      inventoryObserved: false,
    });
    expect(parseCodexbarAccounts(JSON.stringify([codexRecord("named", 10), anonymous]), 0, [])).toMatchObject({
      kind: "ok",
      ambient: null,
      completeInventory: false,
      inventoryObserved: false,
    });
  });

  test("returns identified source errors as unavailable without leaking raw source fields", () => {
    const source = [
      codexRecord("success", 10),
      {
        provider: "codex",
        account: "failed",
        error: { code: 1, kind: "provider", message: "private account failure" },
        usage: { identity: "private identity" },
      },
    ];
    const parsed = parseCodexbarAccounts(JSON.stringify(source), 1, []);
    expect(parsed).toMatchObject({ kind: "ok", completeInventory: false, inventoryObserved: true });
    if (parsed.kind !== "ok") throw new Error("expected parsed accounts");
    expect(parsed.accounts.find((account) => account.id === codexAccountId("success"))).toMatchObject({
      issue: null,
      unavailable: false,
    });
    expect(parsed.accounts.find((account) => account.id === codexAccountId("failed"))).toMatchObject({
      active: null,
      percentRemaining: null,
      issue: "unavailable",
      unavailable: true,
      fetchedAt: null,
    });
    const output = JSON.stringify(parsed);
    expect(output).not.toContain("private account failure");
    expect(output).not.toContain("private identity");
  });

  test("does not accept malformed source errors as successful measurements", () => {
    for (const error of [
      "not a CodexBar error object",
      [],
      { code: 1, kind: "provider" },
      { code: "1", kind: "provider", message: "wrong code type" },
      { code: 1.5, kind: "provider", message: "non-integer code" },
    ]) {
      const parsed = parseCodexbarAccounts(
        JSON.stringify([codexRecord("success", 10), { ...codexRecord("malformed-error", 20), error }]),
        0,
        [],
      );
      expect(parsed).toMatchObject({ kind: "ok", completeInventory: false, inventoryObserved: false });
      if (parsed.kind !== "ok") throw new Error("expected parsed accounts");
      expect(parsed.accounts).toHaveLength(1);
      expect(parsed.accounts[0]).toMatchObject({ id: codexAccountId("success"), percentRemaining: 90 });
    }
  });
});
