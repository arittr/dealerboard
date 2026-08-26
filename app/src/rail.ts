/**
 * The strip's fixed right rail: the token block (total over
 * rates-beside-sparkline), the unread row carrying the daemon-health dot (red
 * plus OFFLINE when degraded), the quota zone (per-provider quota panels:
 * binding window, tag pill, bar), and page dots. Rebuilt
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
  SPARKLINE_VIEWBOX,
  type SparklineModel,
  sparklineEndpoint,
  sparklineFillPoints,
  sparklinePolylinePoints,
  type TokenUsageRailModel,
  type TokenUsageRateLine,
} from "./token-usage";

export type RailModel = {
  degraded: boolean;
  unreadCount: number;
  quota: readonly QuotaPanelModel[];
  tokens: TokenUsageRailModel;
  /** 1-based current page. */
  page: number;
  pageCount: number;
  now: Date;
};

export type RailActions = {
  /** Jump to a 0-based page; the layout reducer validates and clamps it. */
  onJumpToPage: (page: number) => void;
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

const sparkPolyline = (points: string, stroke: string, strokeOpacity?: string): SVGElement => {
  const polyline = document.createElementNS(SVG_NAMESPACE, "polyline");
  polyline.setAttribute("fill", "none");
  polyline.setAttribute("points", points);
  polyline.setAttribute("stroke", stroke);
  if (strokeOpacity !== undefined) {
    polyline.setAttribute("stroke-opacity", strokeOpacity);
  }
  polyline.setAttribute("stroke-width", "2");
  polyline.setAttribute("stroke-linejoin", "round");
  return polyline;
};

/** Day-over-day sparkline: faint fill under today's curve, dim yesterday line with its yda label, bright today line, endpoint dot. */
const sparklineBlock = (sparkline: SparklineModel): HTMLElement => {
  const block = document.createElement("div");
  block.className = "rail-sparkline";
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  // Matched-aspect geometry: the 500x84 viewBox scales uniformly (no
  // preserveAspectRatio) so strokes and the endpoint circle stay true.
  svg.setAttribute("viewBox", `0 0 ${SPARKLINE_VIEWBOX.width} ${SPARKLINE_VIEWBOX.height}`);
  const fill = sparklineFillPoints(sparkline.today.points);
  if (fill !== null) {
    const polygon = document.createElementNS(SVG_NAMESPACE, "polygon");
    polygon.setAttribute("fill", "rgba(232,238,247,0.08)");
    polygon.setAttribute("points", fill);
    svg.append(polygon);
  }
  if (sparkline.yesterday !== null) {
    svg.append(sparkPolyline(sparklinePolylinePoints(sparkline.yesterday.points), "#94A3B8", "0.6"));
  }
  svg.append(sparkPolyline(sparklinePolylinePoints(sparkline.today.points), "#E8EEF7"));
  const endpoint = sparklineEndpoint(sparkline.today.points);
  if (endpoint !== null) {
    const dot = document.createElementNS(SVG_NAMESPACE, "circle");
    dot.setAttribute("cx", endpoint.cx.toFixed(2));
    dot.setAttribute("cy", endpoint.cy.toFixed(2));
    dot.setAttribute("r", "4");
    dot.setAttribute("fill", "#E8EEF7");
    svg.append(dot);
  }
  if (sparkline.yesterday !== null) {
    const label = document.createElementNS(SVG_NAMESPACE, "text");
    // The label baseline is y=48 of the 84px box, right-anchored at x=498.
    label.setAttribute("x", "498");
    label.setAttribute("y", "48");
    label.setAttribute("text-anchor", "end");
    label.setAttribute("font-size", "20");
    label.setAttribute("fill", "#94A3B8");
    label.textContent = sparkline.yesterday.label;
    svg.append(label);
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
  if (model.sparkline !== null) {
    flow.append(sparklineBlock(model.sparkline));
  }
  section.append(today, flow);
  return section;
};

const pagerSection = (model: RailModel, actions: RailActions): HTMLElement => {
  const section = document.createElement("section");
  section.className = "rail-pager";
  for (let page = 1; page <= model.pageCount; page += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = page === model.page ? "page-dot current" : "page-dot";
    button.textContent = "●";
    const target = page - 1;
    button.addEventListener("click", () => actions.onJumpToPage(target));
    section.append(button);
  }
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
  if (!render.grouped) {
    section.dataset["state"] = panel.state;
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
 * second would detach the page-dot buttons mid-press and churn layout.
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
    page: model.page,
    pageCount: model.pageCount,
    tokens: model.tokens,
    quota: model.quota.map((panel) => [
      panel.provider,
      ...meterSignature(panel),
      panel.accounts.map((account) => [account.id, account.label, account.active, ...meterSignature(account)]),
    ]),
  });
};

export const renderRail = (root: HTMLElement, model: RailModel, actions: RailActions): void => {
  const tokens = tokensSection(model.tokens);
  const nowMs = model.now.getTime();
  const zone = document.createElement("div");
  zone.className = "rail-quota-zone";
  zone.append(...model.quota.map((quota) => quotaSection(quota, nowMs)));

  const sections: HTMLElement[] = [];
  if (tokens !== null) {
    sections.push(tokens);
  }
  sections.push(unreadSection(model), zone, pagerSection(model, actions));
  root.replaceChildren(...sections);
};
