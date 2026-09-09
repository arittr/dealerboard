/** Synthetic native boundary for quota-preview; never reads local provider data. */
import type { SnapshotPayload } from "../../../app/src/bridge";
import type { SessionSnapshotV2 } from "../../../src/protocol";
import {
  capQuotaExtraWindowLabel,
  type ProviderQuota,
  type ProviderQuotaAccount,
  type QuotaSnapshot,
} from "../../../src/quota-snapshot";
import type { TokenUsageSnapshot } from "../../../src/token-usage-snapshot";

export const PREVIEW_NOW = Date.parse("2030-01-01T23:00:00.000Z");
export const scenarios = [
  "healthy",
  "exhausted waiting account",
  "auth required",
  "unavailable with future reset",
  "stale after reset",
  "unknown reset",
  "long scoped tags",
] as const;
export type Scenario = (typeof scenarios)[number];
export const preview = {
  now: PREVIEW_NOW,
  scenario: "healthy" as Scenario,
  count: 2,
  calls: [] as { command: string; args: unknown[] }[],
  quota: null as QuotaSnapshot | null,
};
const iso = (offset: number): string => new Date(PREVIEW_NOW + offset).toISOString();
const HOUR = 3_600_000;

export const quotaFixture = (count: number, scenario: Scenario): QuotaSnapshot => {
  const provider = (percent: number, hours: number): ProviderQuota => ({
    percentRemaining: percent,
    resetAt: iso(hours * HOUR),
    weeklyPercentRemaining: 100,
    weeklyResetAt: iso(6 * 24 * HOUR),
    unavailable: false,
    fetchedAt: iso(-120_000),
    history: [],
    extraWindows: [],
    accounts: [],
  });
  const providers = {
    claude: provider(70, 3.5),
    codex: provider(60, 5),
    kimi: provider(100, 5),
    zai: provider(72, 49),
    qwen: provider(83, 72),
  };
  for (const key of ["claude", "codex"] as const) {
    providers[key].accounts = Array.from({ length: count }, (_, index): ProviderQuotaAccount => {
      const {
        history: _history,
        accounts: _accounts,
        ...reading
      } = provider(index === 0 ? 100 : 63, index === 0 ? 3.5 : 96);
      return {
        ...reading,
        id: key === "claude" ? `claude-swap:${index + 1}` : `codexbar:${String(index + 1).padStart(64, "0")}`,
        label: String(index + 1),
        active: key === "codex" ? null : index === 0,
        issue: null,
      };
    });
    const account = providers[key].accounts[1] ?? providers[key].accounts[0];
    if (account === undefined) continue;
    switch (scenario) {
      case "exhausted waiting account":
        account.percentRemaining = 0;
        account.resetAt = iso(-HOUR);
        break;
      case "auth required":
        account.issue = "auth_required";
        account.unavailable = true;
        break;
      case "unavailable with future reset":
        account.issue = "unavailable";
        account.unavailable = true;
        account.fetchedAt = iso(-2 * HOUR);
        break;
      case "stale after reset":
        account.fetchedAt = iso(-48 * HOUR);
        account.resetAt = iso(-HOUR);
        break;
      case "unknown reset":
        account.resetAt = null;
        break;
      case "long scoped tags":
        account.extraWindows = [
          {
            id: "synthetic-scoped",
            label: capQuotaExtraWindowLabel("WWWWWWWWWWWWWWWWWW scoped"),
            percentRemaining: 42,
            resetAt: iso(49 * HOUR),
          },
        ];
        break;
      case "healthy":
        break;
    }
  }
  return { schemaVersion: 3, providers };
};

const sessionFixture = (): Omit<SessionSnapshotV2, "agents"> => ({
  schemaVersion: 2,
  health: { status: "ok" },
  sessions: Array.from({ length: 20 }, (_, i) => ({
    provider: "codex",
    sessionId: `synthetic-${i + 1}`,
    project: ["sample-app", "infra-demo", "plugin-demo"][i % 3] ?? "sample-app",
    title:
      [
        "Review the service architecture",
        "Investigate a deployment failure",
        "Explore the extension interface",
        "Compare provider account quotas",
        "Design compact account meters",
        "Trace session status updates",
      ][i % 6] ?? "Synthetic task",
    model: "gpt-6-astra",
    status: i % 3 === 0 ? "working" : "idle",
    originKind: "paseo",
    originRef: `synthetic-${i + 1}`,
    originSubagent: false,
    unreadSince: i < 6 ? iso(-1000) : null,
    doneSince: null,
    pendingResults: 0,
    endedAt: null,
    statusSince: iso(-(35 + i * 47) * 1000),
    activityLine: "Read · src/example.ts",
    transcriptPath: null,
    originParentRef: null,
    ghosttyTerminalId: null,
    descendantCount: 0,
    logicalSlot: i + 1,
    lastEventAt: iso(-(35 + i * 47) * 1000),
    openedAt: iso(-(180 + i * 500) * 1000),
  })),
});
const tokenFixture = (): TokenUsageSnapshot => {
  const points = (day: string) =>
    Array.from({ length: 31 }, (_, i) => ({
      fetchedAt: new Date(Date.parse(`${day}T08:00:00.000Z`) + (i * HOUR) / 2).toISOString(),
      totalTokens: i * 20_000_000 + (i % 3) * 1_000_000,
    }));
  return {
    schemaVersion: 1,
    providerDay: "2030-01-01",
    totalTokens: 600_000_000,
    unavailable: false,
    fetchedAt: iso(0),
    samples: points("2030-01-01")
      .slice(-5)
      .map((p) => ({ ...p, providerDay: "2030-01-01" })),
    dayCurves: {
      today: { providerDay: "2030-01-01", points: points("2030-01-01") },
      yesterday: { providerDay: "2029-12-31", points: points("2029-12-31") },
    },
  };
};
const payload = (value: unknown): SnapshotPayload => ({ mtimeMs: preview.now, contents: JSON.stringify(value) });
export const readSnapshot = async (): Promise<SnapshotPayload> => payload(sessionFixture());
export const readQuotaSnapshot = async (): Promise<SnapshotPayload> =>
  payload(preview.quota ?? quotaFixture(preview.count, preview.scenario));
export const readTokenUsageSnapshot = async (): Promise<SnapshotPayload> => payload(tokenFixture());
let snapshotHandler: ((value: SnapshotPayload) => void) | null = null;
export const onSnapshotChanged = async (handler: (value: SnapshotPayload) => void): Promise<() => void> => {
  snapshotHandler = handler;
  return () => {
    snapshotHandler = null;
  };
};
export const pushSnapshot = (): void => {
  snapshotHandler?.(payload(sessionFixture()));
};
const record =
  (command: string) =>
  async (...args: unknown[]): Promise<void> => {
    preview.calls.push({ command, args });
  };
export const ackSession = record("ackSession");
export const activateEvenerSession = record("activateEvenerSession");
export const clearSession = record("clearSession");
export const focusGhostty = record("focusGhostty");
export const openUrl = record("openUrl");
export const revealTranscript = record("revealTranscript");
export const viewSession = record("viewSession");
export const readPaseoServerId = async (): Promise<string> => "synthetic-server";
