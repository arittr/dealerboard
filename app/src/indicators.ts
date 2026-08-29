/**
 * Page indicators for the strip: the return sliver (left gutter), the
 * next-page peek (board's right edge), and the pip column. Pure view models
 * derived from the packed pages — every aggregate is the OR of the page's
 * cards' existing view-model bits from the current snapshot; no page state
 * of its own, no freshness claim the cards don't make. Renderers put no
 * text in any band and no card index on any sliver (bands are page-level
 * tap targets only). The driver is app/src/main.ts; geometry is CSS.
 */

import type { SessionStatus } from "../../src/protocol";
import type { BoardPage } from "./board";
import { cardShowsUnread } from "./cards";

export type SliverModel = {
  /** 0-based board row the sliver aligns to. */
  row: number;
  status: SessionStatus;
  sub: boolean;
  unread: boolean;
};

const sliverColumn = (page: BoardPage, column: number): SliverModel[] =>
  page.cards
    .filter((card) => card.column === column)
    .sort((a, b) => a.row - b.row)
    .map((card) => ({ row: card.row, status: card.session.status, sub: card.subagent, unread: cardShowsUnread(card) }));

/** The page behind's cards nearest the shared edge — its rightmost occupied column; [] on page 1. */
export const returnSliverModel = (pages: readonly BoardPage[], currentPage: number): SliverModel[] => {
  const behind = currentPage > 0 ? pages[currentPage - 1] : undefined;
  if (behind === undefined || behind.cards.length === 0) {
    return [];
  }
  return sliverColumn(behind, Math.max(...behind.cards.map((card) => card.column)));
};

/** The next page's leftmost column; [] on the last page. */
export const peekModel = (pages: readonly BoardPage[], currentPage: number): SliverModel[] => {
  const ahead = pages[currentPage + 1];
  if (ahead === undefined || ahead.cards.length === 0) {
    return [];
  }
  return sliverColumn(ahead, 0);
};

export type PipModel = {
  current: boolean;
  /** At most one corner mini-dot: amber unread beats blue working; the current pip is always clean. */
  dot: "unread" | "working" | null;
};

/** One pip per page, top = page 1; [] (hidden) when only one page exists. */
export const pipColumnModel = (pages: readonly BoardPage[], currentPage: number): PipModel[] => {
  if (pages.length <= 1) {
    return [];
  }
  return pages.map((page, index) => {
    if (index === currentPage) {
      return { current: true, dot: null };
    }
    const unread = page.cards.some(cardShowsUnread);
    const working = page.cards.some((card) => card.session.status === "working");
    return { current: false, dot: unread ? "unread" : working ? "working" : null };
  });
};

const sliverElement = (model: SliverModel, withDot: boolean): HTMLElement => {
  const sliver = document.createElement("div");
  sliver.className = model.sub ? "sliver sub" : "sliver";
  sliver.dataset["status"] = model.status;
  sliver.style.gridRow = String(model.row + 1);
  if (withDot && model.unread) {
    const dot = document.createElement("span");
    dot.className = "sliver-dot";
    sliver.append(dot);
  }
  return sliver;
};

/** The return band: surface plus faint status edge only — no unread dots. */
export const renderReturnBand = (root: HTMLElement, model: readonly SliverModel[]): void => {
  root.dataset["present"] = model.length > 0 ? "true" : "false";
  root.replaceChildren(...model.map((sliver) => sliverElement(sliver, false)));
};

/** The peek band: dimmed surfaces, status edges, unread corner dots per row. */
export const renderPeekBand = (root: HTMLElement, model: readonly SliverModel[]): void => {
  root.dataset["present"] = model.length > 0 ? "true" : "false";
  root.replaceChildren(...model.map((sliver) => sliverElement(sliver, true)));
};

export type PipActions = {
  /** Jump to a 0-based page; the layout reducer validates and clamps it. */
  onJumpToPage: (page: number) => void;
};

export const renderPips = (root: HTMLElement, model: readonly PipModel[], actions: PipActions): void => {
  root.dataset["present"] = model.length > 0 ? "true" : "false";
  root.replaceChildren(
    ...model.map((pip, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = pip.current ? "pip current" : "pip";
      const dot = document.createElement("span");
      dot.className = "pip-dot";
      if (pip.dot !== null) {
        const mini = document.createElement("span");
        mini.className = "pip-mini";
        mini.dataset["kind"] = pip.dot;
        dot.append(mini);
      }
      button.append(dot);
      button.addEventListener("click", () => actions.onJumpToPage(index));
      return button;
    }),
  );
};

/** The render-skip signature: rebuilding every ingest would detach a pip mid-press. */
export const indicatorsRenderSignature = (
  returnBand: readonly SliverModel[],
  peek: readonly SliverModel[],
  pips: readonly PipModel[],
): string => JSON.stringify({ returnBand, peek, pips });
