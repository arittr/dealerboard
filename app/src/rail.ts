/**
 * The strip's fixed right rail: token usage (today's total with rolling /hr
 * and /10m rates), the unread count carrying the daemon-health dot (red plus
 * OFFLINE when degraded), per-provider quota panels (binding window, tag
 * pill, bar ticks), and page dots. Rebuilt
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
  tickPercents,
} from "./quota";
import { formatTokensCompact, type TokenUsageRailModel, type TokenUsageRateLine } from "./token-usage";

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

/** Two-line compact panel: head (chip, label, binding-window tag, percent + note) over a bar that fills to the binding window and ticks every other window. */
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
    const pct = document.createElement("span");
    pct.className = "quota-pct";
    pct.textContent = formatBindingPercent(model);
    right.append(pct);
    const note = formatBindingNote(model, nowMs);
    if (note !== "") {
      const noteSpan = document.createElement("span");
      noteSpan.className = "quota-note";
      noteSpan.textContent = `· ${note}`;
      right.append(noteSpan);
    }
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
    for (const percent of tickPercents(model)) {
      const tick = document.createElement("span");
      tick.className = "quota-tick";
      tick.style.left = `${Math.max(0, Math.min(100, percent))}%`;
      bar.append(tick);
    }
  }
  section.append(head, bar);
  return section;
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
