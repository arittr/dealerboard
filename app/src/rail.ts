/**
 * The strip's fixed right rail: token usage (today's total with rolling /hr
 * and /10m rates), the unread count carrying the daemon-health dot (red plus
 * OFFLINE when degraded), per-provider quota panels, and page dots. Rebuilt
 * wholesale on each render — the rail is small and has no CSS animations to
 * disturb.
 */

import {
  formatSessionNote,
  formatSessionPercent,
  formatWeeklySummary,
  headlinePercent,
  type QuotaPanelModel,
  quotaBarColor,
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

const rateLineElement = (line: TokenUsageRateLine, unit: string): HTMLElement => {
  const row = document.createElement("div");
  row.className = "tokens-rate";
  row.dataset["trend"] = line.trend;
  const arrow = line.trend === "up" ? "↑" : line.trend === "down" ? "↓" : "→";
  row.textContent = `${arrow} ${formatTokensCompact(line.tokens)}/${unit}`;
  return row;
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
  section.append(today, rateLineElement(model.hour, "hr"), rateLineElement(model.tenMin, "10m"));
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

/** Two-line compact panel: head (chip, label, weekly summary, percent + note) over a bare bar. */
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
  // Weekly-only providers headline the weekly window, so the summary would
  // just repeat the headline; show it only beside a session headline.
  if (model.percentRemaining !== null) {
    const weekly = formatWeeklySummary(model.weeklyPercentRemaining, model.weeklyResetAtMs, nowMs);
    if (weekly !== null) {
      const week = document.createElement("span");
      week.className = "quota-weekly";
      week.textContent = weekly;
      head.append(week);
    }
  }
  const right = document.createElement("span");
  right.className = "quota-right";
  if (model.state === "unavailable") {
    const note = document.createElement("span");
    note.className = "quota-note";
    note.textContent = formatSessionNote(model, nowMs);
    right.append(note);
  } else {
    const pct = document.createElement("span");
    pct.className = "quota-pct";
    pct.textContent = formatSessionPercent(model);
    right.append(pct);
    const note = formatSessionNote(model, nowMs);
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
  const fill = document.createElement("div");
  fill.className = "quota-bar-fill";
  const headline = headlinePercent(model);
  if (headline !== null) {
    fill.style.width = `${Math.max(0, Math.min(100, headline))}%`;
    fill.style.background = quotaBarColor(headline);
  }
  bar.append(fill);

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
