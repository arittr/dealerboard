import { capQuotaExtraWindowLabel, QUOTA_EXTRA_WINDOWS_LIMIT, type QuotaExtraWindow } from "../quota-snapshot";

export type QuotaWindowReading = { percentRemaining: number; resetAt: string | null };

export type ProviderQuotaReading = {
  /** Null when the provider reports no session-class window (e.g. codex weekly-only). */
  session: QuotaWindowReading | null;
  weekly: QuotaWindowReading | null;
  /** Extra windows not selected as session/weekly (claude's fable, codex's spark weekly). */
  extras: QuotaExtraWindow[];
};

export type CodexbarUsageParse =
  | { kind: "ok"; reading: ProviderQuotaReading }
  /** Valid JSON with no accounts — the provider is disabled in CodexBar. */
  | { kind: "absent" }
  | { kind: "invalid" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPercentUsed = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

/** Normalize a provider ISO string to canonical UTC; unparseable → null. */
const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/** CodexBar window lengths at or above this classify as the weekly window. */
const DAY_WINDOW_MINUTES = 1440;

type RawCodexbarWindow = { windowMinutes: number; usedPercent: number; resetsAt: string | null };

const parseCodexbarWindow = (value: unknown): RawCodexbarWindow | null => {
  if (!isRecord(value)) return null;
  const minutes = value["windowMinutes"];
  if (
    typeof minutes !== "number" ||
    !Number.isFinite(minutes) ||
    minutes <= 0 ||
    !isPercentUsed(value["usedPercent"])
  ) {
    return null;
  }
  return { windowMinutes: minutes, usedPercent: value["usedPercent"], resetsAt: isoOrNull(value["resetsAt"]) };
};

const toWindowReading = (window: RawCodexbarWindow): QuotaWindowReading => ({
  percentRemaining: 100 - window.usedPercent,
  resetAt: window.resetsAt,
});

type RawCodexbarExtra = { id: string | null; title: string | null; window: RawCodexbarWindow };

const parseCodexbarExtra = (value: unknown): RawCodexbarExtra | null => {
  if (!isRecord(value)) return null;
  const window = parseCodexbarWindow(value["window"]);
  if (window === null) return null;
  const id = value["id"];
  const title = value["title"];
  return {
    id: typeof id === "string" && id.length > 0 ? id : null,
    title: typeof title === "string" && title.length > 0 ? title : null,
    window,
  };
};

/** CodexBar's provider id → the rail's display name, for stripping it out of window titles. */
const CODEXBAR_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  kimi: "Kimi",
  zai: "GLM",
  alibabatokenplan: "Qwen",
};

const extraWindowLabel = (title: string, codexbarProvider: string): string => {
  const displayName = CODEXBAR_DISPLAY_NAMES[codexbarProvider] ?? codexbarProvider;
  const stripped = title.replace(new RegExp(`^${displayName}\\s+`, "iu"), "").trim();
  return capQuotaExtraWindowLabel(stripped.length === 0 ? title.trim() : stripped);
};

type WindowSelection = { session: RawCodexbarWindow | null; weekly: RawCodexbarWindow | null };

const classifyCodexbarWindows = (windows: readonly RawCodexbarWindow[]): WindowSelection | null => {
  let weekly: RawCodexbarWindow | null = null;
  let session: RawCodexbarWindow | null = null;
  for (const window of windows) {
    if (window.windowMinutes >= DAY_WINDOW_MINUTES) {
      if (weekly === null || window.windowMinutes > weekly.windowMinutes) weekly = window;
    } else if (session === null || window.windowMinutes < session.windowMinutes) {
      session = window;
    }
  }
  return session === null && weekly === null ? null : { session, weekly };
};

/** Parse one CodexBar provider row without exposing its source identity fields. */
export const parseCodexbarRecord = (entry: unknown, provider: string): ProviderQuotaReading | null => {
  if (!isRecord(entry) || !isRecord(entry["usage"])) return null;
  const usage = entry["usage"];
  const windows: RawCodexbarWindow[] = [];
  for (const key of ["primary", "secondary", "tertiary"] as const) {
    const window = parseCodexbarWindow(usage[key]);
    if (window !== null) windows.push(window);
  }
  const rawExtras: RawCodexbarExtra[] = [];
  if (Array.isArray(usage["extraRateWindows"])) {
    for (const value of usage["extraRateWindows"]) {
      const extra = parseCodexbarExtra(value);
      if (extra !== null) rawExtras.push(extra);
    }
  }
  const selected = classifyCodexbarWindows([...windows, ...rawExtras.map((extra) => extra.window)]);
  if (selected === null) return null;
  const extras: QuotaExtraWindow[] = [];
  for (const extra of rawExtras) {
    if (extra.window === selected.session || extra.window === selected.weekly) continue;
    const name = extra.id ?? extra.title;
    if (name === null) continue;
    extras.push({
      id: name,
      label: extraWindowLabel(extra.title ?? name, provider),
      ...toWindowReading(extra.window),
    });
    if (extras.length >= QUOTA_EXTRA_WINDOWS_LIMIT) break;
  }
  return {
    session: selected.session === null ? null : toWindowReading(selected.session),
    weekly: selected.weekly === null ? null : toWindowReading(selected.weekly),
    extras,
  };
};

export const parseCodexbarUsage = (body: string, provider?: string): CodexbarUsageParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "invalid" };
  }
  if (!Array.isArray(parsed)) return { kind: "invalid" };
  if (parsed.length === 0) return { kind: "absent" };
  const ids = parsed.map((item) => (isRecord(item) && typeof item["provider"] === "string" ? item["provider"] : null));
  let entry: unknown = parsed[0];
  if (provider !== undefined && ids.some((id) => id !== null)) {
    const index = ids.indexOf(provider);
    if (index === -1) return { kind: "absent" };
    entry = parsed[index];
  }
  const reading = parseCodexbarRecord(
    entry,
    provider ?? (isRecord(entry) && typeof entry["provider"] === "string" ? entry["provider"] : ""),
  );
  return reading === null ? { kind: "invalid" } : { kind: "ok", reading };
};

/** The widget snapshot only counts as a source while the app is actually refreshing it. */
export const WIDGET_SNAPSHOT_MAX_AGE_MS = 45 * 60_000;

export const parseCodexbarWidgetSnapshot = (body: string, nowMs: number): Map<string, ProviderQuotaReading> => {
  const readings = new Map<string, ProviderQuotaReading>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return readings;
  }
  if (!isRecord(parsed)) return readings;
  const generatedAt = typeof parsed["generatedAt"] === "string" ? Date.parse(parsed["generatedAt"]) : Number.NaN;
  if (Number.isNaN(generatedAt) || nowMs - generatedAt > WIDGET_SNAPSHOT_MAX_AGE_MS) return readings;
  if (!Array.isArray(parsed["entries"])) return readings;
  for (const entry of parsed["entries"]) {
    if (!isRecord(entry) || typeof entry["provider"] !== "string") continue;
    const reading = parseCodexbarRecord({ usage: entry }, entry["provider"]);
    if (reading !== null) readings.set(entry["provider"], reading);
  }
  return readings;
};
