/**
 * The strip's fixed right rail: token usage (today's total with rolling /hr
 * and /10m rates), the unread count carrying the daemon-health dot (red plus
 * OFFLINE when degraded), per-provider quota panels (binding window, tag
 * pill, bar), and page dots. Rebuilt
 * wholesale on each render — the rail is small and has no CSS animations to
 * disturb.
 */

import {
  bindingWindow,
  formatBindingNote,
  formatBindingPercent,
  formatBindingTag,
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

const PROVIDER_LABELS: Record<QuotaPanelModel["provider"], string> = {
  claude: "Claude",
  codex: "Codex",
  kimi: "Kimi",
  zai: "GLM",
  qwen: "Qwen",
};
const PROVIDER_CHIP_LETTERS: Record<QuotaPanelModel["provider"], string> = {
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

/** d6's day-over-day sparkline: faint fill under today's curve, dim yesterday line with its yda label, bright today line, endpoint dot. */
const sparklineBlock = (sparkline: SparklineModel): HTMLElement => {
  const block = document.createElement("div");
  block.className = "rail-sparkline";
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  // d6's matched-aspect geometry: the 436x80 viewBox scales uniformly (no
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
    // d6.html:444 — the exact baseline: y=30 of the 80px box, right-aligned at x=434.
    label.setAttribute("x", "434");
    label.setAttribute("y", "30");
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
  const rates = document.createElement("div");
  rates.className = "tokens-rate";
  const separator = document.createElement("span");
  separator.className = "tokens-rate-sep";
  separator.textContent = "·";
  rates.append(rateSpan(model.hour, "hr"), separator, rateSpan(model.tenMin, "10m"));
  section.append(today, rates);
  if (model.sparkline !== null) {
    section.append(sparklineBlock(model.sparkline));
  }
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

/** Two-line compact panel: head (chip, label, binding-window tag, muted countdown then bright percent) over a bar that fills to the binding window. */
const quotaSection = (model: QuotaPanelModel, nowMs: number): HTMLElement => {
  const section = document.createElement("section");
  section.className = "rail-quota";
  section.dataset["provider"] = model.provider;
  section.dataset["state"] = model.state;

  const head = document.createElement("div");
  head.className = "quota-head";
  const chip = document.createElement("span");
  chip.className = "quota-chip";
  chip.dataset["provider"] = model.provider;
  chip.textContent = PROVIDER_CHIP_LETTERS[model.provider];
  const name = document.createElement("span");
  name.textContent = PROVIDER_LABELS[model.provider];
  head.append(chip, name);
  const tag = formatBindingTag(model);
  if (tag !== null) {
    const pill = document.createElement("span");
    pill.className = "quota-tag";
    pill.textContent = tag;
    head.append(pill);
  }
  const right = document.createElement("span");
  right.className = "quota-right";
  if (model.state === "unavailable") {
    const note = document.createElement("span");
    note.className = "quota-note";
    note.textContent = formatBindingNote(model, nowMs);
    right.append(note);
  } else {
    const note = formatBindingNote(model, nowMs);
    if (note !== "") {
      const noteSpan = document.createElement("span");
      noteSpan.className = "quota-note";
      noteSpan.textContent = `${note} ·`;
      right.append(noteSpan);
    }
    const pct = document.createElement("span");
    pct.className = "quota-pct";
    pct.textContent = formatBindingPercent(model);
    right.append(pct);
  }
  head.append(right);

  const bar = document.createElement("div");
  bar.className = "quota-bar";
  const binding = bindingWindow(model);
  if (binding !== null) {
    const fill = document.createElement("div");
    fill.className = "quota-bar-fill";
    fill.style.width = `${Math.max(0, Math.min(100, binding.percentRemaining))}%`;
    fill.style.background = quotaBarColor(binding.percentRemaining);
    bar.append(fill);
    // A neutral tick per non-binding window at its own percent — the tick is
    // the whole treatment; textual readouts proved too busy for the row.
    for (const secondary of secondaryWindows(model)) {
      const tick = document.createElement("span");
      tick.className = "quota-tick";
      tick.style.left = `${Math.max(0, Math.min(100, secondary.percentRemaining))}%`;
      bar.append(tick);
    }
  }
  section.append(head, bar);
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
  return JSON.stringify({
    degraded: model.degraded,
    unreadCount: model.unreadCount,
    page: model.page,
    pageCount: model.pageCount,
    tokens: model.tokens,
    quota: model.quota.map((panel) => [
      panel.provider,
      panel.state,
      formatBindingTag(panel),
      formatBindingNote(panel, nowMs),
      formatBindingPercent(panel),
      bindingWindow(panel)?.percentRemaining ?? null,
      secondaryWindows(panel),
    ]),
  });
};

export const renderRail = (root: HTMLElement, model: RailModel, actions: RailActions): void => {
  const tokens = tokensSection(model.tokens);
  const nowMs = model.now.getTime();
  const quotaSections = model.quota.map((quota) => quotaSection(quota, nowMs));

  const sections: HTMLElement[] = [];
  if (tokens !== null) {
    sections.push(tokens);
  }
  sections.push(unreadSection(model), ...quotaSections, pagerSection(model, actions));
  root.replaceChildren(...sections);
};
