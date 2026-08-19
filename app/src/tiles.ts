/**
 * DOM tile renderer for the strip: a web-native port of the Stream Deck SVG
 * tile anatomy (src/plugin/render.ts) — status frame, provider chip + model
 * label, two-line clamped title, descendant badge, Paseo origin pip, degraded
 * flag. Status color and animation live in styles.css (status-* classes);
 * this module owns structure and text only. All text goes through
 * textContent; no innerHTML anywhere.
 */

import type { KeyModel } from "../../src/plugin/layout";
import { modelLabel, PROVIDER_LETTERS } from "../../src/plugin/render";

/** Strip tiles are wide enough that the keypad's badged six-point cap never applies. */
const STRIP_MODEL_LABEL_MAX_CODE_POINTS = 10;

const appendText = (parent: HTMLElement, className: string, text: string): HTMLSpanElement => {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
};

const sessionTile = (model: Extract<KeyModel, { kind: "session" }>, index: number): HTMLElement => {
  const { session } = model;
  const tile = document.createElement("div");
  tile.className = `tile session status-${session.status}`;
  tile.dataset["keyIndex"] = String(index);

  const topband = document.createElement("div");
  topband.className = "topband";
  const chip = appendText(topband, "chip", PROVIDER_LETTERS[session.provider]);
  chip.dataset["provider"] = session.provider;
  if (session.model !== null) {
    appendText(topband, "model", modelLabel(session.model, STRIP_MODEL_LABEL_MAX_CODE_POINTS));
  }
  if (session.descendantCount > 0) {
    appendText(topband, "badge", String(session.descendantCount));
  }
  tile.append(topband);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = model.label;
  tile.append(title);

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
 * fixed keypad grid, but strip tiles flex to fill the row, so trailing
 * non-session keys are dropped (columns = sessions on the page, capped by the
 * geometry). An all-blank page keeps one blank — the degraded OFFLINE surface.
 */
export const visibleStripKeys = (keys: readonly KeyModel[]): readonly KeyModel[] => {
  let last = keys.length;
  while (last > 1 && keys[last - 1]?.kind !== "session") {
    last -= 1;
  }
  return keys.slice(0, last);
};

/**
 * Columns for a page of N tiles: rows grow to three first (keeping tiles at
 * the three-across width), then columns — tiles shrink past nine sessions.
 */
export const stripColumnCount = (count: number): number => {
  const rows = Math.min(3, Math.ceil(count / 3));
  return Math.max(1, Math.ceil(count / rows));
};

export type StripGridLayout = {
  readonly columnCount: number;
  readonly trackWidth: "capped" | "fluid";
};

/**
 * Sparse pages use tracks capped at the three-across width. Past three
 * columns, every track shares the available width so tiles can shrink.
 */
export const stripGridLayout = (count: number): StripGridLayout => {
  const columnCount = stripColumnCount(count);
  return {
    columnCount,
    trackWidth: columnCount <= 3 ? "capped" : "fluid",
  };
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
