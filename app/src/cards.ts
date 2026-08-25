/**
 * Per-card view model and DOM renderer for the board: the pure derived
 * fields (fallback title, model label cap, project suppression, origin disc)
 * plus the card assembler that turns a BoardPage into the d6 card anatomy
 * (status edge, head/meta/status rows, sub pill, spine). All text goes
 * through textContent; no innerHTML anywhere.
 */

import { modelLabel, PROVIDER_LETTERS, washCycleOffset } from "../../src/plugin/render";
import type { ProjectedSession, SessionStatus } from "../../src/protocol";
import type { BoardPage, PlacedCard, SpineSegment } from "./board";

/** Compact elapsed label for the status timer: 42s, 12m, 3h, 2d. */
export const elapsedLabel = (elapsedMs: number): string => {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
};

/**
 * The per-tile status timer text ("working 12m"), or null when the row's own
 * status stamp is absent or unparseable — an old daemon simply shows no line.
 */
export const statusLineText = (status: SessionStatus, statusSince: string | null, nowMs: number): string | null => {
  if (statusSince === null) {
    return null;
  }
  const startedMs = Date.parse(statusSince);
  if (Number.isNaN(startedMs)) {
    return null;
  }
  return `${status} ${elapsedLabel(nowMs - startedMs)}`;
};

/** The wash alternates over four seconds each way (styles.css), so one full
 *  round trip takes eight. */
export const WASH_CYCLE_MS = 8000;

/**
 * Negative CSS animation delay that starts a working tile's wash partway into
 * its cycle. The session offset staggers concurrent tiles so they never
 * breathe in lockstep, and folding in the wall clock keeps the wash
 * phase-continuous across re-renders: renderTiles recreates every tile on any
 * data change, and an undelayed tile would snap back to the dim end each time.
 */
export const washAnimationDelay = (sessionId: string, nowMs: number): string => {
  const elapsed = (nowMs + washCycleOffset(sessionId) * WASH_CYCLE_MS) % WASH_CYCLE_MS;
  return `-${(elapsed / 1000).toFixed(3)}s`;
};

/** The board's meta line has room for full model ids; the tile 10-point cap does not apply. */
export const CARD_MODEL_LABEL_MAX_CODE_POINTS = 24;

export type CardViewModel = {
  provider: ProjectedSession["provider"];
  letter: string;
  unread: boolean;
  title: string;
  /** True when the label is not the session's own title (project or provider+id fallback) — rendered italic. */
  fallbackTitle: boolean;
  modelLabel: string | null;
  project: string | null;
  activity: string | null;
  status: SessionStatus;
  statusSince: string | null;
  timer: string | null;
  originDisc: boolean;
  subagent: boolean;
  indent: boolean;
  spine: SpineSegment;
  badge: number;
  degraded: boolean;
};

export const cardViewModel = (card: PlacedCard, nowMs: number): CardViewModel => {
  const { session } = card;
  return {
    provider: session.provider,
    letter: PROVIDER_LETTERS[session.provider],
    unread: session.unreadSince !== null,
    title: card.label,
    fallbackTitle: !(session.title !== null && session.title.length > 0),
    modelLabel: session.model === null ? null : modelLabel(session.model, CARD_MODEL_LABEL_MAX_CODE_POINTS),
    project:
      card.subagent && card.parentProject !== null && card.parentProject === session.project ? null : session.project,
    activity: session.activityLine,
    status: session.status,
    statusSince: session.statusSince,
    timer: statusLineText(session.status, session.statusSince, nowMs),
    originDisc: session.originKind === "paseo" && !session.originSubagent,
    subagent: card.subagent,
    indent: card.indent,
    spine: card.spine,
    badge: session.descendantCount,
    degraded: card.degraded,
  };
};

const appendText = (parent: HTMLElement, className: string, text: string): HTMLSpanElement => {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
};

const cardElement = (card: PlacedCard, index: number, nowMs: number): HTMLElement => {
  const model = cardViewModel(card, nowMs);
  const element = document.createElement("div");
  element.className = [
    "card",
    `status-${model.status}`,
    model.subagent ? "sub" : "primary",
    model.indent ? "indented" : "",
    model.spine !== "none" ? `spine-${model.spine}` : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  element.dataset["cardIndex"] = String(index);
  element.style.gridColumn = String(card.column + 1);
  element.style.gridRow = String(card.row + 1);
  if (model.status === "working") {
    element.style.setProperty("--wash-delay", washAnimationDelay(card.session.sessionId, nowMs));
  }

  const head = document.createElement("div");
  head.className = "card-head";
  const chip = appendText(head, "chip", model.letter);
  chip.dataset["provider"] = model.provider;
  if (model.unread) {
    // d6's corner badge: absolutely positioned on the chip, card-colored ring.
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    chip.append(dot);
  }
  if (model.subagent) {
    appendText(head, "sub-pill", "sub");
  }
  const title = appendText(head, model.fallbackTitle ? "card-title fallback" : "card-title", model.title);
  title.classList.add("one-line");
  element.append(head);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  if (model.modelLabel !== null) {
    appendText(meta, "meta-item", model.modelLabel);
  }
  if (model.project !== null) {
    appendText(meta, "meta-item", model.project);
  }
  if (model.activity !== null) {
    appendText(meta, "meta-item activity", model.activity);
  }
  const metaRight = document.createElement("span");
  metaRight.className = "meta-right";
  if (model.originDisc) {
    const disc = document.createElement("span");
    disc.className = "origin-disc";
    metaRight.append(disc);
  }
  if (model.badge > 0) {
    appendText(metaRight, "badge", String(model.badge));
  }
  meta.append(metaRight);
  element.append(meta);

  const statusRow = document.createElement("div");
  statusRow.className = "card-status";
  const statusDot = document.createElement("span");
  statusDot.className = "status-dot";
  statusRow.append(statusDot);
  appendText(statusRow, "status-word", model.status);
  if (model.statusSince !== null && model.timer !== null) {
    const timer = appendText(statusRow, "cardtimer", model.timer.slice(model.status.length + 1));
    timer.dataset["since"] = model.statusSince;
  }
  element.append(statusRow);

  if (model.degraded) {
    appendText(element, "flag", "!");
  }
  return element;
};

/** The render-skip signature: every renderBoard input except the wall clock
 *  (the in-place ticker owns time). Cards carry their own degraded bit, so a
 *  degraded flip changes any non-empty page — but an empty page serializes to
 *  the same "[]" healthy or degraded, and the page-level flag is what makes
 *  the healthy↔OFFLINE transition re-render it. */
export const boardRenderSignature = (page: BoardPage, degraded: boolean): string =>
  JSON.stringify({ cards: page.cards, degraded });

export const renderBoard = (root: HTMLElement, page: BoardPage, degraded: boolean): void => {
  if (page.cards.length === 0) {
    const blank = document.createElement("div");
    blank.className = "offline";
    if (degraded) {
      blank.textContent = "OFFLINE";
    }
    root.replaceChildren(blank);
    return;
  }
  const nowMs = Date.now();
  root.replaceChildren(...page.cards.map((card, index) => cardElement(card, index, nowMs)));
};
