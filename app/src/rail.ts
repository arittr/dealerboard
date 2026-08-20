/**
 * The strip's fixed right rail: daemon health (with heartbeat age), clock,
 * unread count, per-provider quota panels, and page dots. Rebuilt wholesale on
 * each render — the rail is small and has no CSS animations to disturb.
 */

import type { QuotaHistoryPoint } from "../../src/quota-snapshot";
import {
  formatPercentRemaining,
  formatWeeklyLine,
  type QuotaPanelModel,
  quotaBarColor,
  quotaStatusText,
  sparklinePoints,
} from "./quota";

export type RailModel = {
  degraded: boolean;
  /** Age of the snapshot file's mtime; null when no read has succeeded. */
  heartbeatAgeMs: number | null;
  unreadCount: number;
  quota: readonly QuotaPanelModel[];
  /** 1-based current page. */
  page: number;
  pageCount: number;
  now: Date;
};

export type RailActions = {
  /** Jump to a 0-based page; the layout reducer validates and clamps it. */
  onJumpToPage: (page: number) => void;
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

const PROVIDER_LABELS: Record<QuotaPanelModel["provider"], string> = {
  claude: "Claude",
  codex: "Codex",
  kimi: "Kimi",
  zai: "GLM",
};
const PROVIDER_CHIP_LETTERS: Record<QuotaPanelModel["provider"], string> = {
  claude: "C",
  codex: "X",
  kimi: "K",
  zai: "G",
};

const healthSection = (model: RailModel): HTMLElement => {
  const section = document.createElement("section");
  section.className = "rail-health";
  const dot = document.createElement("span");
  dot.className = model.degraded ? "dot bad" : "dot ok";
  section.append(dot);
  const text = document.createElement("span");
  if (model.degraded) {
    text.className = "offline-text";
    text.textContent = "OFFLINE";
  } else {
    const ageSeconds = model.heartbeatAgeMs === null ? null : Math.max(0, Math.round(model.heartbeatAgeMs / 1000));
    text.textContent = ageSeconds === null ? "daemon ok" : `daemon ok · ${ageSeconds}s ago`;
  }
  section.append(text);
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
  const pct = document.createElement("span");
  pct.className = "quota-pct";
  pct.textContent = model.percentRemaining === null ? "—" : formatPercentRemaining(model.percentRemaining);
  head.append(chip, name, pct);

  const bar = document.createElement("div");
  bar.className = "quota-bar";
  const fill = document.createElement("div");
  fill.className = "quota-bar-fill";
  if (model.percentRemaining !== null) {
    fill.style.width = `${Math.max(0, Math.min(100, model.percentRemaining))}%`;
    fill.style.background = quotaBarColor(model.percentRemaining);
  }
  bar.append(fill);

  const meta = document.createElement("div");
  meta.className = "quota-meta";
  const status = document.createElement("span");
  status.textContent = quotaStatusText(model, nowMs);
  const spark = document.createElement("canvas");
  spark.className = "quota-spark";
  meta.append(status, spark);

  section.append(head, bar, meta);
  const weekly = formatWeeklyLine(model.weeklyPercentRemaining, model.weeklyResetAtMs, nowMs);
  if (weekly !== null) {
    const weekLine = document.createElement("div");
    weekLine.className = "quota-weekly";
    weekLine.textContent = weekly;
    section.append(weekLine);
  }
  return section;
};

const drawSparkline = (section: HTMLElement, history: readonly QuotaHistoryPoint[]): void => {
  const canvas = section.querySelector<HTMLCanvasElement>(".quota-spark");
  if (canvas === null) {
    return;
  }
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) {
    return;
  }
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext("2d");
  if (context === null) {
    return;
  }
  context.scale(ratio, ratio);
  const points = sparklinePoints(history, width, height);
  const first = points[0];
  if (first === undefined) {
    return;
  }
  context.strokeStyle = "#94a3b8";
  context.lineWidth = 1.5;
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of points.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.stroke();
};

export const renderRail = (root: HTMLElement, model: RailModel, actions: RailActions): void => {
  const clock = document.createElement("section");
  clock.className = "rail-clock";
  clock.textContent = `${pad2(model.now.getHours())}:${pad2(model.now.getMinutes())}`;

  const unread = document.createElement("section");
  unread.className = model.unreadCount > 0 ? "rail-unread active" : "rail-unread";
  unread.textContent = model.unreadCount === 1 ? "1 unread" : `${model.unreadCount} unread`;

  const nowMs = model.now.getTime();
  const quotaSections = model.quota.map((quota) => quotaSection(quota, nowMs));

  root.replaceChildren(healthSection(model), clock, unread, ...quotaSections, pagerSection(model, actions));
  // Canvases only have layout once attached; draw after replaceChildren.
  for (let index = 0; index < quotaSections.length; index += 1) {
    const section = quotaSections[index];
    const quota = model.quota[index];
    if (section !== undefined && quota !== undefined) {
      drawSparkline(section, quota.history);
    }
  }
};
