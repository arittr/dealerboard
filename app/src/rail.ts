/**
 * The strip's fixed right rail: the token block (total over
 * rates beside the hourly activity comparison), the unread row carrying the daemon-health dot (red
 * plus OFFLINE when degraded), the quota zone (per-provider quota panels:
 * binding window, tag pill, bar). Rebuilt
 * wholesale on each render — the rail is small and has no CSS animations to
 * disturb.
 */

import type { QuotaProviderKey } from "../../src/quota-snapshot";
import {
  bindingResetPending,
  bindingWindow,
  formatBindingNote,
  formatBindingPercent,
  formatBindingTag,
  type QuotaMeterModel,
  type QuotaPanelModel,
  quotaBarColor,
  secondaryWindows,
} from "./quota";
import {
  formatTokensCompact,
  TOKEN_ACTIVITY_TIME_LABELS,
  TOKEN_ACTIVITY_VIEWBOX,
  type TokenActivityChartModel,
  type TokenActivityPoint,
  type TokenUsageRailModel,
  type TokenUsageRateLine,
  tokenActivityBarRects,
  tokenActivityLineEndpoint,
  tokenActivityLineSegments,
} from "./token-usage";

export type RailModel = {
  degraded: boolean;
  unreadCount: number;
  quota: readonly QuotaPanelModel[];
  tokens: TokenUsageRailModel;
  now: Date;
};

const PROVIDER_LABELS: Record<QuotaProviderKey, string> = {
  claude: "Claude",
  codex: "Codex",
  kimi: "Kimi",
  zai: "GLM",
  qwen: "Qwen",
};
const PROVIDER_CHIP_LETTERS: Record<QuotaProviderKey, string> = {
  claude: "C",
  codex: "X",
  kimi: "K",
  zai: "G",
  qwen: "Q",
};

/** Unread count with the daemon-health dot inline; degraded adds OFFLINE after the dot. */
const unreadSection = (model: RailModel): HTMLElement => {
  const section = document.createElement("section");
  section.className = model.unreadCount > 0 ? "rail-unread active" : "rail-unread";
  const dot = document.createElement("span");
  dot.className = model.degraded ? "dot bad" : "dot ok";
  section.append(dot);
  if (model.degraded) {
    const offline = document.createElement("span");
    offline.className = "offline-text";
    offline.textContent = "OFFLINE";
    section.append(offline);
  }
  const text = document.createElement("span");
  text.textContent = model.unreadCount === 1 ? "1 unread" : `${model.unreadCount} unread`;
  section.append(text);
  return section;
};

const rateSpan = (line: TokenUsageRateLine, unit: string): HTMLSpanElement => {
  const span = document.createElement("span");
  span.dataset["trend"] = line.trend;
  const arrow = line.trend === "up" ? "↑" : line.trend === "down" ? "↓" : "→";
  span.textContent = `${arrow} ${formatTokensCompact(line.tokens)}/${unit}`;
  return span;
};

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const activityPoints = (points: readonly TokenActivityPoint[]): string =>
  points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");

const tokenActivityBlock = (activity: TokenActivityChartModel): HTMLElement => {
  const block = document.createElement("div");
  block.className = "rail-token-activity";
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", `0 0 ${TOKEN_ACTIVITY_VIEWBOX.width} ${TOKEN_ACTIVITY_VIEWBOX.height}`);

  for (const axis of TOKEN_ACTIVITY_TIME_LABELS) {
    const label = document.createElementNS(SVG_NAMESPACE, "text");
    label.setAttribute("class", "token-activity-axis");
    label.setAttribute("x", String(axis.x));
    label.setAttribute("y", "82");
    label.setAttribute("text-anchor", axis.anchor);
    label.textContent = axis.text;
    svg.append(label);
  }

  const segments = tokenActivityLineSegments(activity);
  for (const segment of segments) {
    const line = document.createElementNS(SVG_NAMESPACE, "polyline");
    line.setAttribute("class", "token-activity-yesterday");
    line.setAttribute("points", activityPoints(segment));
    svg.append(line);
  }

  const endpoint = tokenActivityLineEndpoint(segments);
  if (endpoint !== null) {
    const label = document.createElementNS(SVG_NAMESPACE, "text");
    label.setAttribute("class", "token-activity-yda");
    label.setAttribute("x", "498");
    label.setAttribute("y", String(Math.max(16, endpoint.y - 6)));
    label.setAttribute("text-anchor", "end");
    label.textContent = "yda";
    svg.append(label);
  }

  for (const bar of tokenActivityBarRects(activity)) {
    const rect = document.createElementNS(SVG_NAMESPACE, "rect");
    rect.setAttribute("class", bar.current ? "token-activity-bar current" : "token-activity-bar");
    rect.setAttribute("x", bar.x.toFixed(2));
    rect.setAttribute("y", bar.y.toFixed(2));
    rect.setAttribute("width", bar.width.toFixed(2));
    rect.setAttribute("height", bar.height.toFixed(2));
    svg.append(rect);
  }

  block.append(svg);
  return block;
};

const tokensSection = (model: TokenUsageRailModel): HTMLElement | null => {
  if (model.state === "hidden") {
    return null;
  }
  const section = document.createElement("section");
  section.className = "rail-tokens";
  section.dataset["state"] = model.state;
  const today = document.createElement("div");
  today.className = "tokens-today";
  today.textContent = `${formatTokensCompact(model.totalTokens)} today`;
  const flow = document.createElement("div");
  flow.className = "tokens-flow";
  const rates = document.createElement("div");
  rates.className = "tokens-rate";
  rates.append(rateSpan(model.hour, "hr"), rateSpan(model.tenMin, "10m"));
  flow.append(rates);
  if (model.activity !== null) {
    flow.append(tokenActivityBlock(model.activity));
  }
  section.append(today, flow);
  return section;
};

export type QuotaRenderAccount = {
  id: string;
  label: string;
  active: boolean;
  meter: QuotaMeterModel;
};

export type QuotaRenderModel =
  | { provider: QuotaProviderKey; grouped: false; meter: QuotaPanelModel }
  | { provider: "claude"; grouped: true; meters: readonly QuotaRenderAccount[] };

export const quotaRenderModel = (panel: QuotaPanelModel): QuotaRenderModel =>
  panel.provider === "claude" && panel.accounts.length >= 2
    ? {
        provider: "claude",
        grouped: true,
        meters: panel.accounts.map((account) => ({
          id: account.id,
          label: account.label,
          active: account.active,
          meter: account,
        })),
      }
    : { provider: panel.provider, grouped: false, meter: panel };

const quotaProviderIdentity = (provider: QuotaProviderKey): HTMLElement[] => {
  const chip = document.createElement("span");
  chip.className = "quota-chip";
  chip.dataset["provider"] = provider;
  chip.textContent = PROVIDER_CHIP_LETTERS[provider];
  const name = document.createElement("span");
  name.textContent = PROVIDER_LABELS[provider];
  return [chip, name];
};

const quotaMeter = (meter: QuotaMeterModel, nowMs: number, leading: readonly HTMLElement[]): HTMLElement => {
  const container = document.createElement("div");
  container.className = "quota-meter";
  const head = document.createElement("div");
  head.className = "quota-head";
  head.append(...leading);

  const tag = formatBindingTag(meter);
  if (tag !== null) {
    const pill = document.createElement("span");
    pill.className = "quota-tag";
    pill.textContent = tag;
    head.append(pill);
  }
  const right = document.createElement("span");
  right.className = "quota-right";
  // An unavailable meter keeps its last-good percent (dimmed by the state
  // opacity) only while the binding reset is pending; once it passes the
  // number is spent and the muted note stands alone.
  const showPercent = meter.state !== "unavailable" || bindingResetPending(meter, nowMs);
  const note = formatBindingNote(meter, nowMs);
  if (note !== "") {
    const noteSpan = document.createElement("span");
    noteSpan.className = "quota-note";
    noteSpan.textContent = showPercent ? `${note} ·` : note;
    right.append(noteSpan);
  }
  if (showPercent) {
    const pct = document.createElement("span");
    pct.className = "quota-pct";
    pct.textContent = formatBindingPercent(meter);
    right.append(pct);
  }
  head.append(right);

  const bar = document.createElement("div");
  bar.className = "quota-bar";
  const binding = bindingWindow(meter);
  if (binding !== null) {
    const fill = document.createElement("div");
    fill.className = "quota-bar-fill";
    fill.style.width = `${Math.max(0, Math.min(100, binding.percentRemaining))}%`;
    fill.style.background = quotaBarColor(binding.percentRemaining);
    bar.append(fill);
    // A neutral tick per non-binding window at its own percent — the tick is
    // the whole treatment; textual readouts proved too busy for the row.
    for (const secondary of secondaryWindows(meter)) {
      const tick = document.createElement("span");
      tick.className = "quota-tick";
      tick.style.left = `${Math.max(0, Math.min(100, secondary.percentRemaining))}%`;
      bar.append(tick);
    }
  }
  container.append(head, bar);
  return container;
};

/** Two-line compact panel: head (chip, label, binding-window tag, muted countdown then bright percent) over a bar that fills to the binding window. */
const quotaSection = (panel: QuotaPanelModel, nowMs: number): HTMLElement => {
  const render = quotaRenderModel(panel);
  const section = document.createElement("section");
  section.className = render.grouped ? "rail-quota quota-group" : "rail-quota";
  section.dataset["provider"] = panel.provider;
  section.dataset["state"] = panel.state;
  if (!render.grouped) {
    section.append(quotaMeter(render.meter, nowMs, quotaProviderIdentity(panel.provider)));
    return section;
  }

  const providerHead = document.createElement("div");
  providerHead.className = "quota-provider-head";
  providerHead.append(...quotaProviderIdentity(panel.provider));
  const accountStack = document.createElement("div");
  accountStack.className = "quota-account-stack";
  for (const entry of render.meters) {
    const account = document.createElement("div");
    account.className = "quota-account";
    account.dataset["account"] = entry.id;
    account.dataset["state"] = entry.meter.state;
    const marker = document.createElement("span");
    marker.className = entry.active ? "quota-account-marker quota-account-active" : "quota-account-marker";
    const label = document.createElement("span");
    label.className = "quota-account-label";
    label.textContent = entry.label;
    account.append(quotaMeter(entry.meter, nowMs, [marker, label]));
    accountStack.append(account);
  }
  section.append(providerHead, accountStack);
  return section;
};

/**
 * The rail's render-skip signature: every derivation renderRail puts on
 * screen, with wall-clock time folded in only through the formatted strings
 * that actually display it (the reset countdown's minute label). The driver
 * renders on a 1s cadence for those minute rollovers; between them the
 * signature is stable and the rebuild is skipped — a wholesale rebuild every
 * second would churn layout under an in-flight tap.
 */
export const railRenderSignature = (model: RailModel): string => {
  const nowMs = model.now.getTime();
  const meterSignature = (meter: QuotaMeterModel): readonly unknown[] => [
    meter.state,
    formatBindingTag(meter),
    formatBindingNote(meter, nowMs),
    formatBindingPercent(meter),
    bindingWindow(meter)?.percentRemaining ?? null,
    secondaryWindows(meter),
  ];
  return JSON.stringify({
    degraded: model.degraded,
    unreadCount: model.unreadCount,
    tokens: model.tokens,
    quota: model.quota.map((panel) => [
      panel.provider,
      ...meterSignature(panel),
      panel.accounts.map((account) => [account.id, account.label, account.active, ...meterSignature(account)]),
    ]),
  });
};

export const renderRail = (root: HTMLElement, model: RailModel): void => {
  const tokens = tokensSection(model.tokens);
  const nowMs = model.now.getTime();
  const zone = document.createElement("div");
  zone.className = "rail-quota-zone";
  zone.append(...model.quota.map((quota) => quotaSection(quota, nowMs)));

  const sections: HTMLElement[] = [];
  if (tokens !== null) {
    sections.push(tokens);
  }
  sections.push(unreadSection(model), zone);
  root.replaceChildren(...sections);
};
