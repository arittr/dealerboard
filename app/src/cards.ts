/**
 * Per-card view model and DOM renderer for the board: the pure derived
 * fields (fallback title, model label cap, project suppression, origin disc)
 * plus the card assembler that turns a BoardPage into the d6 card anatomy
 * (status edge, head/meta/status rows, sub pill, spine). All text goes
 * through textContent; no innerHTML anywhere.
 */

import { modelLabel, PROVIDER_LETTERS, washCycleOffset } from "../../src/plugin/render";
import type { SessionStatus } from "../../src/protocol";
import type { BoardPage, BoardSession, PlacedCard, SpineSegment } from "./board";

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
 * phase-continuous across re-renders: renderBoard recreates every card on
 * any data change, and an undelayed card would snap back to the dim end
 * each time.
 */
export const washAnimationDelay = (sessionId: string, nowMs: number): string => {
  const elapsed = (nowMs + washCycleOffset(sessionId) * WASH_CYCLE_MS) % WASH_CYCLE_MS;
  return `-${(elapsed / 1000).toFixed(3)}s`;
};

/** The board's meta line has room for full model ids; the tile 10-point cap does not apply. */
export const CARD_MODEL_LABEL_MAX_CODE_POINTS = 24;

export type CardViewModel = {
  provider: BoardSession["provider"];
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
  displayOnly: boolean;
  badge: number | null;
  degraded: boolean;
};

export const cardViewModel = (card: PlacedCard, nowMs: number): CardViewModel => {
  const { session } = card;
  return {
    provider: session.provider,
    letter: PROVIDER_LETTERS[session.provider],
    unread: !card.displayOnly && session.unreadSince !== null,
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
    displayOnly: card.displayOnly,
    badge: card.displayOnly ? null : card.descendantBadge,
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

export const cardClassName = (model: CardViewModel): string =>
  [
    "card",
    `status-${model.status}`,
    model.subagent ? "sub" : "primary",
    model.indent ? "indented" : "",
    model.spine !== "none" ? `spine-${model.spine}` : "",
    model.displayOnly ? "display-only" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");

const cardElement = (card: PlacedCard, index: number, nowMs: number): HTMLElement => {
  const model = cardViewModel(card, nowMs);
  const element = document.createElement("div");
  element.className = cardClassName(model);
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
  if (model.badge !== null && model.badge > 0) {
    appendText(metaRight, "badge", String(model.badge));
  }
  meta.append(metaRight);
  element.append(meta);

  const statusRow = document.createElement("div");
  statusRow.className = "card-status";
  const statusDot = document.createElement("span");
  statusDot.className = "status-dot";
  statusRow.append(statusDot);
  // Working/idle carry their state in the dot and edge color; only the
  // attention states spell it out.
  if (model.status === "waiting" || model.status === "error") {
    appendText(statusRow, "status-word", model.status);
  }
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

/** The reconciliation identity: one DOM node per session per page. */
export const cardKey = (card: PlacedCard): string => `${card.session.provider}\u0000${card.session.sessionId}`;

/**
 * The per-card rebuild signature: everything cardElement bakes into the node
 * except its page position (grid column/row and the dense index), which the
 * reconciler (re)applies on every pass — so a card that merely moves keeps
 * its DOM node, its CSS animation phase, and its in-place-ticked timer.
 */
export const cardContentSignature = ({ column: _column, row: _row, ...content }: PlacedCard): string =>
  JSON.stringify(content);

export type CardPatch = {
  card: PlacedCard;
  key: string;
  signature: string;
  action: "reuse" | "replace" | "create";
};

/**
 * Plan one page render against the previous pass's key → content-signature
 * map: an unchanged card reuses its node untouched, a changed one replaces
 * only itself, an unknown key creates. Rebuilding the whole board instead
 * restarts every card's CSS animation on any single-field change — and the
 * activity line of a working session changes on nearly every heartbeat.
 */
export const planCardPatches = (previous: ReadonlyMap<string, string>, cards: readonly PlacedCard[]): CardPatch[] =>
  cards.map((card) => {
    const key = cardKey(card);
    const signature = cardContentSignature(card);
    const prior = previous.get(key);
    return { card, key, signature, action: prior === undefined ? "create" : prior === signature ? "reuse" : "replace" };
  });

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
  // Existing card nodes by key; anything unkeyed (the blank/OFFLINE div) is
  // swept as stale below.
  const existing = new Map<string, HTMLElement>();
  const signatures = new Map<string, string>();
  for (const child of Array.from(root.children)) {
    if (child instanceof HTMLElement && child.dataset["cardKey"] !== undefined) {
      existing.set(child.dataset["cardKey"], child);
      signatures.set(child.dataset["cardKey"], child.dataset["cardSignature"] ?? "");
    }
  }
  const kept = new Set<Element>();
  for (const [index, patch] of planCardPatches(signatures, page.cards).entries()) {
    const current = existing.get(patch.key);
    let element: HTMLElement;
    if (patch.action === "reuse" && current !== undefined) {
      element = current;
    } else {
      element = cardElement(patch.card, index, nowMs);
      element.dataset["cardKey"] = patch.key;
      element.dataset["cardSignature"] = patch.signature;
      if (current !== undefined) {
        // In-place content refresh: siblings never re-insert, so their
        // animations and timers are untouched by this card's change.
        current.replaceWith(element);
      } else {
        root.append(element);
      }
    }
    // Position and index sit outside the content signature: applied on every
    // pass, so a reused node moves by grid style alone, never re-inserting.
    element.dataset["cardIndex"] = String(index);
    element.style.gridColumn = String(patch.card.column + 1);
    element.style.gridRow = String(patch.card.row + 1);
    kept.add(element);
  }
  for (const child of Array.from(root.children)) {
    if (!kept.has(child)) {
      child.remove();
    }
  }
};
