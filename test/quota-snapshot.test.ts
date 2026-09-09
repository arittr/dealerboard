import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ProviderQuota,
  type ProviderQuotaAccount,
  parseQuotaSnapshot,
  QUOTA_ACCOUNTS_LIMIT,
  QUOTA_EXTRA_WINDOWS_LIMIT,
  QUOTA_HISTORY_LIMIT,
  type QuotaSnapshot,
} from "../src/quota-snapshot";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "quota", "quota-snapshot.json");

const claudeQuota = (): ProviderQuota => ({
  percentRemaining: 50,
  resetAt: "2030-01-01T05:00:00.000Z",
  weeklyPercentRemaining: 75,
  weeklyResetAt: "2030-01-08T00:00:00.000Z",
  unavailable: false,
  fetchedAt: "2030-01-01T00:00:00.000Z",
  history: [{ fetchedAt: "2030-01-01T00:00:00.000Z", fractionRemaining: 0.5 }],
  extraWindows: [],
  accounts: [],
});

const accountRows = (): ProviderQuotaAccount[] => [
  {
    id: "claude-swap:1",
    label: "1",
    active: false,
    percentRemaining: 75,
    resetAt: "2026-08-26T02:00:00.000Z",
    weeklyPercentRemaining: 60,
    weeklyResetAt: "2026-08-29T00:00:00.000Z",
    issue: null,
    unavailable: false,
    fetchedAt: "2026-08-25T20:00:00.000Z",
    extraWindows: [],
  },
  {
    id: "claude-swap:2",
    label: "2",
    active: true,
    percentRemaining: null,
    resetAt: null,
    weeklyPercentRemaining: 44,
    weeklyResetAt: "2026-08-30T00:00:00.000Z",
    issue: "unavailable",
    unavailable: true,
    fetchedAt: "2026-08-25T19:00:00.000Z",
    extraWindows: [
      {
        id: "claude-swap:2:scoped:0",
        label: "Fable",
        percentRemaining: 2,
        resetAt: "2026-08-30T00:00:00.000Z",
      },
    ],
  },
];

const snapshot = (): QuotaSnapshot => ({
  schemaVersion: 3,
  providers: { claude: claudeQuota() },
});

describe("parseQuotaSnapshot", () => {
  test("round-trips the synthetic fixture", () => {
    const parsed = parseQuotaSnapshot(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.providers["claude"]).toEqual(claudeQuota());
    expect(parsed.providers["codex"]?.percentRemaining).toBe(80);
  });

  test("accepts a snapshot with no providers and one with a single provider", () => {
    expect(parseQuotaSnapshot({ schemaVersion: 3, providers: {} }).providers).toEqual({});
    expect(parseQuotaSnapshot(snapshot()).providers["codex"]).toBeUndefined();
  });

  test.each([1, 2])("rejects quota schema %s instead of migrating", (schemaVersion) => {
    expect(() => parseQuotaSnapshot({ schemaVersion, providers: { claude: claudeQuota() } })).toThrow("schemaVersion");
  });

  test("v3 round-trips both provider account ID namespaces", () => {
    const accounts = accountRows();
    const codexAccounts: ProviderQuotaAccount[] = accounts.map((account, index) => ({
      ...account,
      id: `codexbar:${String(index + 1).repeat(64)}`,
      active: null,
      issue: index === 1 ? "rate_limited" : account.issue,
    }));
    const parsed = parseQuotaSnapshot({
      schemaVersion: 3,
      providers: {
        claude: { ...claudeQuota(), accounts },
        codex: { ...claudeQuota(), accounts: codexAccounts },
      },
    });
    expect(parsed.providers["claude"]?.accounts).toEqual(accounts);
    expect(parsed.providers["codex"]?.accounts).toEqual(codexAccounts);
  });

  test("v3 accepts nullable activity and a never-measured account", () => {
    const neverMeasured: ProviderQuotaAccount = {
      id: `codexbar:${"a".repeat(64)}`,
      label: "1",
      active: null,
      percentRemaining: null,
      resetAt: null,
      weeklyPercentRemaining: null,
      weeklyResetAt: null,
      issue: "auth_required",
      unavailable: true,
      fetchedAt: null,
      extraWindows: [],
    };
    const parsed = parseQuotaSnapshot({
      schemaVersion: 3,
      providers: { codex: { ...claudeQuota(), accounts: [neverMeasured] } },
    });
    expect(parsed.providers["codex"]?.accounts).toEqual([neverMeasured]);
  });

  test("rejects account IDs outside the provider namespace and accounts on unsupported providers", () => {
    const claude = accountRows()[0];
    if (claude === undefined) throw new Error("account test fixture must contain one row");
    const codex = { ...claude, id: `codexbar:${"a".repeat(64)}`, active: null };
    const badProviders = [
      { claude: { ...claudeQuota(), accounts: [codex] } },
      { codex: { ...claudeQuota(), accounts: [claude] } },
      { kimi: { ...claudeQuota(), accounts: [claude] } },
      { zai: { ...claudeQuota(), accounts: [codex] } },
      { qwen: { ...claudeQuota(), accounts: [claude] } },
    ];
    for (const providers of badProviders) {
      expect(() => parseQuotaSnapshot({ schemaVersion: 3, providers })).toThrow("account");
    }
  });

  test("rejects every invalid account collection shape", () => {
    const accounts = accountRows();
    const first = accounts[0];
    const second = accounts[1];
    if (first === undefined || second === undefined) throw new Error("account test fixture must contain two rows");
    const invalidCollections: [string, unknown[]][] = [
      [
        "nine accounts",
        Array.from({ length: QUOTA_ACCOUNTS_LIMIT + 1 }, (_, index) => ({
          ...first,
          id: `claude-swap:${index + 1}`,
          label: `${index + 1}`,
        })),
      ],
      ["duplicate id", [first, { ...second, id: first.id }]],
      ["duplicate label", [first, { ...second, label: first.label }]],
      ["non-numeric label", [first, { ...second, id: "claude-swap:private", label: "private" }]],
      ["zero label", [{ ...first, id: "claude-swap:0", label: "0" }, second]],
      ["noncanonical decimal label", [{ ...first, id: "claude-swap:01", label: "01" }, second]],
      ["id-label mismatch", [first, { ...second, id: "claude-swap:3" }]],
      ["two active", accounts.map((account) => ({ ...account, active: true }))],
      ["invalid activity", [{ ...first, active: "yes" }, second]],
      ["missing issue", [{ ...first, issue: undefined }, second]],
      ["invalid issue", [{ ...first, issue: "expired" }, second]],
      ["issue disagrees with available", [{ ...first, issue: "unavailable" }, second]],
      ["issue disagrees with unavailable", [{ ...first, unavailable: true }, second]],
      ["invalid percent", [{ ...first, percentRemaining: 101 }, second]],
      ["noncanonical fetchedAt", [{ ...first, fetchedAt: "2026-08-25T20:00:00Z" }, second]],
      ["measurement without fetchedAt", [{ ...first, fetchedAt: null }, second]],
      [
        "reset without fetchedAt",
        [
          {
            ...first,
            percentRemaining: null,
            weeklyPercentRemaining: null,
            weeklyResetAt: null,
            extraWindows: [],
            fetchedAt: null,
          },
          second,
        ],
      ],
      [
        "extra window without fetchedAt",
        [
          {
            ...first,
            percentRemaining: null,
            resetAt: null,
            weeklyPercentRemaining: null,
            weeklyResetAt: null,
            fetchedAt: null,
            extraWindows: [
              {
                id: "claude-swap:1:scoped:0",
                label: "Fable",
                percentRemaining: 50,
                resetAt: null,
              },
            ],
          },
          second,
        ],
      ],
      ["malformed extras", [{ ...first, extraWindows: [{ id: "x" }] }, second]],
    ];
    for (const [_name, invalidAccounts] of invalidCollections) {
      expect(() =>
        parseQuotaSnapshot({
          schemaVersion: 3,
          providers: { claude: { ...claudeQuota(), accounts: invalidAccounts } },
        }),
      ).toThrow("invalid quota snapshot");
    }
  });

  test("ignores unknown account fields", () => {
    const first = accountRows()[0];
    if (first === undefined) throw new Error("account test fixture must contain one row");
    const parsed = parseQuotaSnapshot({
      schemaVersion: 3,
      providers: {
        claude: { ...claudeQuota(), accounts: [{ ...first, privateFutureField: "ignored" }] },
      },
    });
    expect(parsed.providers["claude"]?.accounts[0]).toEqual(first);
  });

  test("ignores unknown provider keys so a newer daemon never breaks an older app", () => {
    const parsed = parseQuotaSnapshot({
      schemaVersion: 3,
      providers: { futureprovider: claudeQuota(), claude: claudeQuota() },
    });
    expect(parsed.providers["claude"]).toEqual(claudeQuota());
    expect(Object.keys(parsed.providers)).toEqual(["claude"]);
  });

  test("parses the kimi, zai, and qwen provider keys", () => {
    const parsed = parseQuotaSnapshot({
      schemaVersion: 3,
      providers: { kimi: claudeQuota(), zai: claudeQuota(), qwen: claudeQuota() },
    });
    expect(parsed.providers["kimi"]).toEqual(claudeQuota());
    expect(parsed.providers["zai"]).toEqual(claudeQuota());
    expect(parsed.providers["qwen"]).toEqual(claudeQuota());
  });

  test("rejects a non-object, a wrong schemaVersion, and a non-object providers", () => {
    expect(() => parseQuotaSnapshot(null)).toThrow("invalid quota snapshot");
    expect(() => parseQuotaSnapshot({ schemaVersion: 4, providers: {} })).toThrow("schemaVersion must be 3");
    expect(() => parseQuotaSnapshot({ schemaVersion: 3, providers: [] })).toThrow("providers must be an object");
  });

  test("rejects out-of-range percents, bad instants, and non-boolean unavailable", () => {
    const bad = (patch: Partial<ProviderQuota>): unknown => ({
      schemaVersion: 3,
      providers: { claude: { ...claudeQuota(), ...patch } },
    });
    expect(() => parseQuotaSnapshot(bad({ percentRemaining: 101 }))).toThrow("percentRemaining");
    expect(() => parseQuotaSnapshot(bad({ percentRemaining: -1 }))).toThrow("percentRemaining");
    expect(() => parseQuotaSnapshot(bad({ resetAt: "not-a-date" }))).toThrow("resetAt");
    expect(() => parseQuotaSnapshot(bad({ weeklyPercentRemaining: "88" as unknown as number }))).toThrow(
      "weeklyPercentRemaining",
    );
    expect(() => parseQuotaSnapshot(bad({ unavailable: 1 as unknown as boolean }))).toThrow("unavailable");
    expect(() => parseQuotaSnapshot(bad({ fetchedAt: 0 as unknown as null }))).toThrow("fetchedAt");
  });

  test("rejects instants that are not canonical UTC ISO even though Date.parse accepts them", () => {
    const badResetAt = (resetAt: string): unknown => ({
      schemaVersion: 3,
      providers: { claude: { ...claudeQuota(), resetAt } },
    });
    // Nonexistent date (Date.parse rolls it over to March 2).
    expect(() => parseQuotaSnapshot(badResetAt("2026-02-30T00:00:00.000Z"))).toThrow("resetAt");
    // Date-only form.
    expect(() => parseQuotaSnapshot(badResetAt("2026-08-19"))).toThrow("resetAt");
    // Valid instant, but milliseconds omitted — not the canonical shape.
    expect(() => parseQuotaSnapshot(badResetAt("2026-08-19T22:00:00Z"))).toThrow("resetAt");
  });

  test("rejects a history ring over the bound and out-of-range fractions", () => {
    const point = { fetchedAt: "2026-08-19T18:00:00.000Z", fractionRemaining: 0.5 };
    const over = { ...claudeQuota(), history: Array.from({ length: QUOTA_HISTORY_LIMIT + 1 }, () => point) };
    expect(() => parseQuotaSnapshot({ schemaVersion: 3, providers: { claude: over } })).toThrow("history");
    const badFraction = { ...claudeQuota(), history: [{ ...point, fractionRemaining: 1.5 }] };
    expect(() => parseQuotaSnapshot({ schemaVersion: 3, providers: { claude: badFraction } })).toThrow(
      "fractionRemaining",
    );
  });

  describe("extraWindows", () => {
    const fable = {
      id: "claude-weekly-scoped-fable",
      label: "Fable only",
      percentRemaining: 99,
      resetAt: "2026-08-28T01:00:00.000Z",
    };

    test("v3 round-trips extra windows", () => {
      const withExtras = { ...claudeQuota(), extraWindows: [fable] };
      const parsed = parseQuotaSnapshot({ schemaVersion: 3, providers: { claude: withExtras } });
      expect(parsed.schemaVersion).toBe(3);
      expect(parsed.providers["claude"]).toEqual(withExtras);
    });

    test("v3 requires the extraWindows and accounts arrays and bounds them", () => {
      const missing = {
        schemaVersion: 3,
        providers: { claude: { ...claudeQuota(), extraWindows: undefined as unknown as [] } },
      };
      expect(() => parseQuotaSnapshot(missing)).toThrow("extraWindows");
      const missingAccounts = {
        schemaVersion: 3,
        providers: { claude: { ...claudeQuota(), accounts: undefined } },
      };
      expect(() => parseQuotaSnapshot(missingAccounts)).toThrow("accounts");
      const over = {
        schemaVersion: 3,
        providers: {
          claude: {
            ...claudeQuota(),
            extraWindows: Array.from({ length: QUOTA_EXTRA_WINDOWS_LIMIT + 1 }, () => fable),
          },
        },
      };
      expect(() => parseQuotaSnapshot(over)).toThrow("extraWindows");
    });

    test("rejects extras with bad percents, instants, or empty id/label", () => {
      const bad = (extra: unknown): unknown => ({
        schemaVersion: 3,
        providers: { claude: { ...claudeQuota(), extraWindows: [extra] } },
      });
      expect(() => parseQuotaSnapshot(bad({ ...fable, percentRemaining: 101 }))).toThrow("percentRemaining");
      expect(() => parseQuotaSnapshot(bad({ ...fable, resetAt: "soon" }))).toThrow("resetAt");
      expect(() => parseQuotaSnapshot(bad({ ...fable, id: "" }))).toThrow("id");
      expect(() => parseQuotaSnapshot(bad({ ...fable, label: "" }))).toThrow("label");
      expect(() => parseQuotaSnapshot(bad("fable"))).toThrow("extra window");
    });
  });
});
