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
  bindingWindow,
  formatBindingTag,
  type QuotaMeterModel,
  type QuotaPanelModel,
  type QuotaTarget,
  quotaBarColor,
  quotaReadout,
  secondaryWindows,
} from "./quota";
import { QUOTA_DENSITY_PRESETS, type QuotaDensity } from "./quota-density";
import {
  formatTokensCompact,
  TOKEN_ACTIVITY_TIME_LABELS,
  TOKEN_ACTIVITY_VIEWBOX,
  type TokenActivityChartModel,
  type TokenActivityPoint,
  type TokenUsageRailModel,
  type TokenUsageRateLine,
  tokenActivityBarRects,
  tokenActivityLineSegments,
} from "./token-usage";

export type RailModel = {
  degraded: boolean;
  unreadCount: number;
  quota: readonly QuotaPanelModel[];
  quotaDensity: QuotaDensity;
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
  if (model.yesterdayTotalTokens !== null) {
    const sep = document.createElement("span");
    sep.className = "tokens-yda-sep";
    sep.textContent = " · ";
    const yda = document.createElement("span");
    yda.className = "tokens-yda";
    yda.textContent = `${formatTokensCompact(model.yesterdayTotalTokens)} yda`;
    today.append(sep, yda);
  }
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
  active: boolean | null;
  meter: QuotaMeterModel;
  target: QuotaTarget;
};

export type QuotaRenderModel =
  | { provider: QuotaProviderKey; grouped: false; meter: QuotaMeterModel; target: QuotaTarget }
  | { provider: QuotaProviderKey; grouped: true; meters: readonly QuotaRenderAccount[] };

export const quotaRenderModel = (panel: QuotaPanelModel): QuotaRenderModel =>
  (panel.provider === "claude" || panel.provider === "codex") && panel.accounts.length >= 2
    ? {
        provider: panel.provider,
        grouped: true,
        meters: panel.accounts.map((account) => ({
          id: account.id,
          label: account.label,
          active: account.active,
          meter: account,
          target: { provider: panel.provider, accountId: account.id },
        })),
      }
    : {
        provider: panel.provider,
        grouped: false,
        meter: panel.accounts[0] ?? panel,
        target: { provider: panel.provider, accountId: panel.accounts[0]?.id ?? null },
      };

const quotaProviderIdentity = (provider: QuotaProviderKey): HTMLElement[] => {
  const chip = document.createElement("span");
  chip.className = "quota-chip";
  chip.dataset["provider"] = provider;
  chip.textContent = PROVIDER_CHIP_LETTERS[provider];
  const name = document.createElement("span");
  name.textContent = PROVIDER_LABELS[provider];
  return [chip, name];
};

const quotaTag = (meter: QuotaMeterModel): HTMLElement | null => {
  const tag = formatBindingTag(meter);
  if (tag === null) {
    return null;
  }
  const pill = document.createElement("span");
  pill.className = "quota-tag";
  pill.textContent = tag;
  return pill;
};

const quotaReadoutElement = (meter: QuotaMeterModel, nowMs: number): HTMLElement => {
  const right = document.createElement("span");
  right.className = "quota-right";
  const readout = quotaReadout(meter, nowMs);
  if (readout.note !== "") {
    const noteSpan = document.createElement("span");
    noteSpan.className = "quota-note";
    noteSpan.textContent = readout.note;
    right.append(noteSpan);
  }
  if (readout.ageCue !== null) {
    const ageCue = document.createElement("span");
    ageCue.className = "quota-age-cue";
    ageCue.textContent = readout.ageCue;
    right.append(ageCue);
  }
  if (readout.percent !== null) {
    const separator = document.createElement("span");
    separator.className = "quota-readout-separator";
    separator.textContent = "·";
    const pct = document.createElement("span");
    pct.className = "quota-pct";
    pct.textContent = readout.percent;
    right.append(separator, pct);
  }
  return right;
};

const quotaBar = (meter: QuotaMeterModel, nowMs: number): HTMLElement => {
  const bar = document.createElement("div");
  bar.className = "quota-bar";
  const binding = bindingWindow(meter);
  const readout = quotaReadout(meter, nowMs);
  if (binding !== null && readout.showFill) {
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
      tick.style.background = "#94a3b8";
      bar.append(tick);
    }
  }
  return bar;
};

const quotaTarget = (button: HTMLButtonElement, target: QuotaTarget): void => {
  button.type = "button";
  button.dataset["quotaProvider"] = target.provider;
  if (target.accountId !== null) {
    button.dataset["quotaAccount"] = target.accountId;
  }
};

const quotaHistoricalState = (button: HTMLButtonElement, meter: QuotaMeterModel, nowMs: number): void => {
  button.dataset["state"] = meter.state;
  button.dataset["historical"] = String(quotaReadout(meter, nowMs).historical);
};

const quotaAccountRow = (entry: QuotaRenderAccount, provider: QuotaProviderKey, nowMs: number): HTMLButtonElement => {
  const account = document.createElement("button");
  account.className = "quota-account";
  quotaTarget(account, entry.target);
  quotaHistoricalState(account, entry.meter, nowMs);

  const label = document.createElement("span");
  label.className = "quota-account-label";
  const marker = document.createElement("span");
  marker.className = entry.active === true ? "quota-account-marker quota-account-active" : "quota-account-marker";
  marker.dataset["provider"] = provider;
  const number = document.createElement("span");
  number.textContent = entry.label;
  label.append(marker, number);
  const tag = quotaTag(entry.meter);
  account.append(label);
  if (tag !== null) {
    account.append(tag);
  } else {
    const placeholder = document.createElement("span");
    placeholder.className = "quota-tag-placeholder";
    account.append(placeholder);
  }
  account.append(quotaBar(entry.meter, nowMs), quotaReadoutElement(entry.meter, nowMs));
  return account;
};

/** Provider heading plus either one native meter button or a stack of account meter buttons. */
const quotaSection = (panel: QuotaPanelModel, nowMs: number): HTMLElement => {
  const render = quotaRenderModel(panel);
  const section = document.createElement("section");
  section.className = render.grouped ? "rail-quota quota-group" : "rail-quota quota-single";
  section.dataset["provider"] = panel.provider;
  if (!render.grouped) {
    section.dataset["state"] = render.meter.state;
    const meter = document.createElement("button");
    meter.className = "quota-single-reading";
    quotaTarget(meter, render.target);
    quotaHistoricalState(meter, render.meter, nowMs);
    const head = document.createElement("div");
    head.className = "quota-head";
    head.append(...quotaProviderIdentity(panel.provider));
    const tag = quotaTag(render.meter);
    if (tag !== null) {
      head.append(tag);
    }
    head.append(quotaReadoutElement(render.meter, nowMs));
    meter.append(head, quotaBar(render.meter, nowMs));
    section.append(meter);
    return section;
  }

  const providerHead = document.createElement("div");
  providerHead.className = "quota-provider-head";
  providerHead.dataset["state"] = panel.state;
  providerHead.append(...quotaProviderIdentity(panel.provider));
  const count = document.createElement("span");
  count.className = "quota-account-count";
  count.textContent = `${render.meters.length} accounts`;
  providerHead.append(count);
  const accountStack = document.createElement("div");
  accountStack.className = "quota-account-stack";
  for (const entry of render.meters) {
    accountStack.append(quotaAccountRow(entry, panel.provider, nowMs));
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
  const meterSignature = (meter: QuotaMeterModel): readonly unknown[] => {
    const readout = quotaReadout(meter, nowMs);
    return [
      meter.state,
      meter.issue,
      formatBindingTag(meter),
      readout.note,
      readout.percent,
      readout.ageCue,
      readout.historical,
      readout.showFill,
      bindingWindow(meter)?.percentRemaining ?? null,
      readout.showFill ? secondaryWindows(meter) : [],
    ];
  };
  const quotaSignature = (panel: QuotaPanelModel): readonly unknown[] => {
    const render = quotaRenderModel(panel);
    if (!render.grouped) {
      return [panel.provider, "single", render.target.accountId, ...meterSignature(render.meter)];
    }
    return [
      panel.provider,
      "grouped",
      panel.state,
      render.meters.map((entry) => [entry.target.accountId, entry.label, entry.active, ...meterSignature(entry.meter)]),
    ];
  };
  return JSON.stringify({
    degraded: model.degraded,
    unreadCount: model.unreadCount,
    tokens: model.tokens,
    quotaDensity: model.quotaDensity,
    quota: model.quota.map(quotaSignature),
  });
};

export const renderRail = (root: HTMLElement, model: RailModel): void => {
  const tokens = tokensSection(model.tokens);
  const nowMs = model.now.getTime();
  const zone = document.createElement("div");
  zone.className = "rail-quota-zone";
  const density = QUOTA_DENSITY_PRESETS[model.quotaDensity];
  zone.dataset["density"] = model.quotaDensity;
  zone.style.setProperty("--quota-scale", String(density.scale));
  zone.style.setProperty("--quota-row-height", `${(density.rowHeight / 7.2).toString()}vh`);
  zone.style.setProperty("--quota-provider-gap", `${(density.providerGap / 7.2).toString()}vh`);
  zone.append(...model.quota.map((quota) => quotaSection(quota, nowMs)));

  const sections: HTMLElement[] = [];
  if (tokens !== null) {
    sections.push(tokens);
  }
  sections.push(unreadSection(model), zone);
  root.replaceChildren(...sections);
};
