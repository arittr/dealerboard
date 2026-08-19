/**
 * The strip's fixed right rail: daemon health (with heartbeat age), clock,
 * unread count, and page dots. Rebuilt wholesale on each render — the rail is
 * small and has no CSS animations to disturb.
 */

export type RailModel = {
  degraded: boolean;
  /** Age of the snapshot file's mtime; null when no read has succeeded. */
  heartbeatAgeMs: number | null;
  unreadCount: number;
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

export const renderRail = (root: HTMLElement, model: RailModel, actions: RailActions): void => {
  const clock = document.createElement("section");
  clock.className = "rail-clock";
  clock.textContent = `${pad2(model.now.getHours())}:${pad2(model.now.getMinutes())}`;

  const unread = document.createElement("section");
  unread.className = model.unreadCount > 0 ? "rail-unread active" : "rail-unread";
  unread.textContent = model.unreadCount === 1 ? "1 unread" : `${model.unreadCount} unread`;

  root.replaceChildren(healthSection(model), clock, unread, pagerSection(model, actions));
};
