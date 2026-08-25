/**
 * DOM tile renderer for the strip: a web-native port of the Stream Deck SVG
 * tile anatomy (src/plugin/render.ts) — status frame, provider chip + model
 * label, two-line clamped title, descendant badge, Paseo origin pip, degraded
 * flag. Strip-only extras: unread dot, ticking status timer, activity footer
 * (no keypad counterpart). Status color and animation live in styles.css
 * (status-* classes); this module owns structure, text, and the working tile's
 * wash delay only. All text goes through textContent; no innerHTML anywhere.
 */

import type { KeyModel } from "../../src/plugin/layout";
import { modelLabel, PROVIDER_LETTERS, washCycleOffset } from "../../src/plugin/render";
import type { ProjectedSession, SessionStatus } from "../../src/protocol";

/** Strip tiles are wide enough that the keypad's badged six-point cap never applies. */
const STRIP_MODEL_LABEL_MAX_CODE_POINTS = 10;

const appendText = (parent: HTMLElement, className: string, text: string): HTMLSpanElement => {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
};

/** Compact elapsed label for the status timer: 42s, 12m, 3h, 2d. */
const elapsedLabel = (elapsedMs: number): string => {
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

/** The strip-only tile extras derived from the session's data-surface fields. */
export type StripTileExtras = {
  /** Unread dot: the exact ledger flag, not the on-grid idle+error proxy. */
  unread: boolean;
  statusLine: string | null;
  activityLine: string | null;
};

export const stripTileExtras = (session: ProjectedSession, nowMs: number): StripTileExtras => ({
  unread: session.unreadSince !== null,
  statusLine: statusLineText(session.status, session.statusSince, nowMs),
  activityLine: session.activityLine,
});

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

const sessionTile = (model: Extract<KeyModel, { kind: "session" }>, index: number): HTMLElement => {
  const { session } = model;
  const nowMs = Date.now();
  const extras = stripTileExtras(session, nowMs);
  const tile = document.createElement("div");
  tile.className = `tile session status-${session.status}`;
  tile.dataset["keyIndex"] = String(index);
  if (session.status === "working") {
    tile.style.setProperty("--wash-delay", washAnimationDelay(session.sessionId, nowMs));
  }

  const topband = document.createElement("div");
  topband.className = "topband";
  const chip = appendText(topband, "chip", PROVIDER_LETTERS[session.provider]);
  chip.dataset["provider"] = session.provider;
  if (session.model !== null) {
    appendText(topband, "model", modelLabel(session.model, STRIP_MODEL_LABEL_MAX_CODE_POINTS));
  }
  if (extras.unread) {
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    topband.append(dot);
  }
  if (session.descendantCount > 0) {
    appendText(topband, "badge", String(session.descendantCount));
  }
  tile.append(topband);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = model.label;
  tile.append(title);

  if (session.statusSince !== null && extras.statusLine !== null) {
    const line = appendText(tile, "statusline", extras.statusLine);
    // The ticker recomputes textContent from these two dataset values.
    line.dataset["status"] = session.status;
    line.dataset["since"] = session.statusSince;
  }
  if (extras.activityLine !== null) {
    appendText(tile, "activity", extras.activityLine);
  }

  if (session.originKind === "paseo") {
    const pip = document.createElement("span");
    pip.className = session.originSubagent ? "pip subagent" : "pip parent";
    tile.append(pip);
  }
  if (model.degraded) {
    appendText(tile, "flag", "!");
  }
  return tile;
};

const blankTile = (degraded: boolean): HTMLElement => {
  const tile = document.createElement("div");
  tile.className = "tile blank";
  if (degraded) {
    appendText(tile, "offline", "OFFLINE");
  }
  return tile;
};

/**
 * Keys the strip actually renders: the reducer pads pages with blanks for the
 * fixed keypad grid, but the strip packs only present sessions, so trailing
 * non-session keys are dropped. An all-blank page keeps one blank — the
 * degraded OFFLINE surface.
 */
export const visibleStripKeys = (keys: readonly KeyModel[]): readonly KeyModel[] => {
  let last = keys.length;
  while (last > 1 && keys[last - 1]?.kind !== "session") {
    last -= 1;
  }
  return keys.slice(0, last);
};

export type StripGridLayout = {
  readonly columnCount: number;
  readonly rowCount: number;
  readonly tileSize: number;
};

export type StripGridBounds = {
  readonly width: number;
  readonly height: number;
  readonly gap: number;
};

/**
 * Choose the one-, two-, or three-row packing that produces the largest
 * square tiles inside the measured grid. The three-across width caps sparse
 * pages so a small session count never overwhelms the fixed rail.
 */
export const stripGridLayout = (count: number, bounds: StripGridBounds): StripGridLayout => {
  const tileCount = Math.max(1, count);
  const maxTileSize = Math.max(0, (bounds.width - 2 * bounds.gap) / 3);
  let best: StripGridLayout = { columnCount: tileCount, rowCount: 1, tileSize: 0 };

  for (let rowCount = 1; rowCount <= Math.min(3, tileCount); rowCount += 1) {
    const columnCount = Math.ceil(tileCount / rowCount);
    const width = (bounds.width - bounds.gap * (columnCount - 1)) / columnCount;
    const height = (bounds.height - bounds.gap * (rowCount - 1)) / rowCount;
    const tileSize = Math.max(0, Math.min(maxTileSize, width, height));
    if (tileSize > best.tileSize) {
      best = { columnCount, rowCount, tileSize };
    }
  }

  return best;
};

export const renderTiles = (root: HTMLElement, keys: readonly KeyModel[]): void => {
  root.replaceChildren(
    ...keys.map((model, index) => {
      switch (model.kind) {
        case "session":
          return sessionTile(model, index);
        default:
          // STRIP_GEOMETRY never emits NEXT (the rail pages); treat it as blank defensively.
          return blankTile(model.degraded);
      }
    }),
  );
};
