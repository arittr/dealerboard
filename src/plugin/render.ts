/**
 * XML-safe animated SVG tile renderer for the 5x3 keypad.
 *
 * Every key is a 144x144 SVG returned as one percent-encoded data URL.
 * Session tiles carry a provider-colored corner chip with the one-letter
 * provider mark and, when known, the session's model id label to its right,
 * up to two centered title lines, a prominent upper-right descendant count
 * when greater than zero, a violet bottom-right origin pip for Paseo-origin
 * sessions (filled disc for a parent, hollow ring for a subagent), and a
 * status-colored frame.
 * Animation is a pure function of the key model and an integer phase owned by
 * the plugin: working uses a shallow full-tile wash behind a static dim frame,
 * waiting and error breathe through deeper sinusoidal frame opacity (error
 * faster), and idle is a static green frame. Blank, NEXT, and offline
 * treatments render no session title; degraded models add a small error flag,
 * and a degraded blank renders the explicit offline treatment.
 *
 * The label is word-wrapped by Unicode code points: lines hold twelve points,
 * words longer than a line hard-split, and text that outlives the second line
 * ends in an ellipsis. Every injected text value passes through the one
 * escapeXml helper, and the module imports no SDK or runtime-specific APIs so
 * it bundles into the Node.js plugin unchanged.
 */

import type { Provider, SessionOriginKind, SessionStatus } from "../protocol";
import type { KeyModel } from "./layout";

const DATA_URL_PREFIX = "data:image/svg+xml,";

const TILE_SIZE = 144;
const FRAME_INSET = 4;
const FRAME_SIZE = TILE_SIZE - FRAME_INSET * 2;
const FRAME_WIDTH = 6;

const TITLE_LINE_CAPACITY = 12;
const TITLE_MAX_LINES = 2;

const MODEL_LABEL_PREFIXES = ["claude-", "gpt-", "zai/", "openai/", "grok-"];
const MODEL_LABEL_MAX_CODE_POINTS = 10;
// The descendant badge occupies x≈99–130 in the same top band; a ten-point
// label starting at x=56 would draw through it, so a badged tile caps at six.
const MODEL_LABEL_BADGED_MAX_CODE_POINTS = 6;

const COLOR_WORKING = "#20B8FF";
const COLOR_WAITING = "#FFB020";
const COLOR_ERROR = "#FF4D67";
const COLOR_IDLE = "#4ADE80";
// Neutral chrome (NEXT frame, page count, OFFLINE) — not a session status.
const COLOR_NEUTRAL = "#94A3B8";
// Orchestrator mark for Paseo-origin sessions (the bottom-right origin pip).
const COLOR_ORIGIN_PASEO = "#A78BFA";
const COLOR_BACKGROUND = "#10151C";
const COLOR_TEXT = "#E8EEF7";

const PROVIDER_COLORS: Record<Provider, string> = {
  claude: "#D97757",
  codex: "#D946EF",
  kimi: "#3B82F6",
  pi: "#0EA514",
  omp: "#F5F0EA",
  zcode: "#EAB308",
  deepseek: "#2DD4BF",
  grok: "#F472B6",
  qwen: "#EF4444",
};

export const PROVIDER_LETTERS: Record<Provider, string> = {
  claude: "C",
  codex: "X",
  kimi: "K",
  pi: "P",
  omp: "O",
  zcode: "Z",
  deepseek: "D",
  grok: "G",
  qwen: "Q",
};

const STATUS_COLORS: Record<SessionStatus, string> = {
  working: COLOR_WORKING,
  waiting: COLOR_WAITING,
  idle: COLOR_IDLE,
  error: COLOR_ERROR,
};

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const frameOpen = (color: string): string =>
  `<rect x="${FRAME_INSET}" y="${FRAME_INSET}" width="${FRAME_SIZE}" height="${FRAME_SIZE}" fill="none" stroke="${color}" stroke-width="${FRAME_WIDTH}"`;

const statusFrame = (status: SessionStatus, phase: number): string => {
  const color = STATUS_COLORS[status];
  switch (status) {
    case "working": {
      // Thirty-two phases per cycle: a four-second 4%-to-14% wash behind a
      // static 30% frame, keeping the title and provider chip crisp.
      const opacity = 0.09 + 0.05 * Math.sin((phase * Math.PI) / 16);
      return (
        `<rect x="0" y="0" width="${TILE_SIZE}" height="${TILE_SIZE}" fill="${color}" opacity="${opacity.toFixed(3)}"/>` +
        `${frameOpen(color)} opacity="0.300"/>`
      );
    }
    case "waiting": {
      // Thirty-two phases per cycle: a four-second breath at the 125 ms cadence.
      const opacity = 0.55 + 0.35 * Math.sin((phase * Math.PI) / 16);
      return `${frameOpen(color)} opacity="${opacity.toFixed(3)}"/>`;
    }
    case "error": {
      // Sixteen phases per cycle: a two-second pulse, twice as fast as waiting.
      const opacity = 0.55 + 0.35 * Math.sin((phase * Math.PI) / 8);
      return `${frameOpen(color)} opacity="${opacity.toFixed(3)}"/>`;
    }
    case "idle":
      return `${frameOpen(color)}/>`;
  }
};

/**
 * Greedy word wrap: lines hold TITLE_LINE_CAPACITY code points, words longer
 * than a line hard-split into the empty line, and text left over after the
 * second line collapses the second line to eleven points plus an ellipsis.
 */
const splitTitleLines = (label: string): string[] => {
  const words = label.split(" ").filter((word) => word.length > 0);
  const lines: string[] = [];
  let current: string[] = [];
  let overflow = false;

  const closeLine = (): boolean => {
    lines.push(current.join(""));
    current = [];
    return lines.length < TITLE_MAX_LINES;
  };

  for (const word of words) {
    let pending = Array.from(word);
    while (pending.length > 0) {
      if (current.length === 0 && pending.length > TITLE_LINE_CAPACITY) {
        current.push(...pending.slice(0, TITLE_LINE_CAPACITY));
        pending = pending.slice(TITLE_LINE_CAPACITY);
        continue;
      }
      const gap = current.length > 0 ? 1 : 0;
      if (current.length + gap + pending.length <= TITLE_LINE_CAPACITY) {
        if (gap === 1) {
          current.push(" ");
        }
        current.push(...pending);
        pending = [];
      } else if (!closeLine()) {
        overflow = true;
        break;
      }
    }
    if (overflow) {
      break;
    }
  }
  if (current.length > 0) {
    if (lines.length < TITLE_MAX_LINES) {
      lines.push(current.join(""));
    } else {
      overflow = true;
    }
  }
  if (overflow && lines.length === TITLE_MAX_LINES) {
    const last = Array.from(lines[TITLE_MAX_LINES - 1] ?? "");
    lines[TITLE_MAX_LINES - 1] = `${last.slice(0, TITLE_LINE_CAPACITY - 1).join("")}…`;
  }
  return lines;
};

const titleLines = (label: string): string => {
  const lines = splitTitleLines(label);
  const firstBaseline = lines.length > 1 ? 72 : 86;
  return lines
    .map(
      (line, index) =>
        `<text class="title" x="72" y="${firstBaseline + index * 24}" text-anchor="middle" font-size="20" fill="${COLOR_TEXT}">${escapeXml(line)}</text>`,
    )
    .join("");
};

const providerMark = (provider: Provider): string =>
  `<rect class="markchip" x="12" y="13" width="38" height="26" rx="6" fill="${PROVIDER_COLORS[provider]}"/>` +
  `<text class="mark" x="31" y="32" text-anchor="middle" font-size="20" fill="${COLOR_BACKGROUND}">${escapeXml(PROVIDER_LETTERS[provider])}</text>`;

/**
 * Raw id to chip label: strip one vendor prefix (keeping the raw id if
 * stripping would leave nothing), then cap by code points with an ellipsis
 * on overflow — ten normally, six when the label must yield width to the
 * descendant badge.
 */
export const modelLabel = (model: string, maxCodePoints: number): string => {
  let label = model;
  for (const prefix of MODEL_LABEL_PREFIXES) {
    if (label.startsWith(prefix) && label.length > prefix.length) {
      label = label.slice(prefix.length);
      break;
    }
  }
  const points = Array.from(label);
  return points.length > maxCodePoints ? `${points.slice(0, maxCodePoints - 1).join("")}…` : label;
};

const modelMark = (model: string | null, descendantCount: number): string => {
  if (model === null) {
    return "";
  }
  const maxCodePoints = descendantCount > 0 ? MODEL_LABEL_BADGED_MAX_CODE_POINTS : MODEL_LABEL_MAX_CODE_POINTS;
  return `<text class="model" x="56" y="32" text-anchor="start" font-size="12" fill="${COLOR_NEUTRAL}">${escapeXml(modelLabel(model, maxCodePoints))}</text>`;
};

const descendantBadge = (descendantCount: number): string =>
  descendantCount > 0
    ? `<text class="badge" x="130" y="38" text-anchor="end" font-size="28" fill="${COLOR_TEXT}">${descendantCount}</text>`
    : "";

const DEGRADED_FLAG = `<text class="flag" x="128" y="27" text-anchor="end" font-size="16" fill="${COLOR_WAITING}">!</text>`;
const SESSION_DEGRADED_FLAG = `<text class="flag" x="16" y="128" text-anchor="start" font-size="16" fill="${COLOR_WAITING}">!</text>`;

/** Orchestrator mark in the free bottom-right corner: filled disc for a Paseo
 *  parent, hollow ring for a Paseo subagent; terminal-origin sessions get none. */
const originMark = (originKind: SessionOriginKind | null, originSubagent: boolean): string => {
  if (originKind !== "paseo") {
    return "";
  }
  return originSubagent
    ? `<circle class="originpip" cx="122" cy="122" r="9" fill="none" stroke="${COLOR_ORIGIN_PASEO}" stroke-width="3"/>`
    : `<circle class="originpip" cx="122" cy="122" r="9" fill="${COLOR_ORIGIN_PASEO}"/>`;
};

const sessionTile = (model: Extract<KeyModel, { kind: "session" }>, phase: number): string =>
  statusFrame(model.session.status, phase) +
  providerMark(model.session.provider) +
  modelMark(model.session.model, model.session.descendantCount) +
  titleLines(model.label) +
  descendantBadge(model.session.descendantCount) +
  originMark(model.session.originKind, model.session.originSubagent) +
  (model.degraded ? SESSION_DEGRADED_FLAG : "");

const blankTile = (degraded: boolean): string =>
  degraded
    ? `<text class="offline" x="72" y="80" text-anchor="middle" font-size="14" fill="${COLOR_NEUTRAL}">OFFLINE</text>`
    : "";

const nextTile = (page: number, pageCount: number, degraded: boolean): string =>
  `${frameOpen(COLOR_NEUTRAL)}/>` +
  `<text class="next" x="72" y="74" text-anchor="middle" font-size="18" fill="${COLOR_TEXT}">NEXT</text>` +
  `<text class="page" x="72" y="98" text-anchor="middle" font-size="14" fill="${COLOR_NEUTRAL}">${page}/${pageCount}</text>` +
  (degraded ? DEGRADED_FLAG : "");

export const renderKey = (model: KeyModel, phase: number): string => {
  let body: string;
  switch (model.kind) {
    case "session":
      body = sessionTile(model, phase);
      break;
    case "next":
      body = nextTile(model.page, model.pageCount, model.degraded);
      break;
    case "blank":
      body = blankTile(model.degraded);
      break;
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_SIZE}" height="${TILE_SIZE}" viewBox="0 0 ${TILE_SIZE} ${TILE_SIZE}" font-family="sans-serif">` +
    `<rect width="${TILE_SIZE}" height="${TILE_SIZE}" fill="${COLOR_BACKGROUND}"/>` +
    body +
    `</svg>`;
  return `${DATA_URL_PREFIX}${encodeURIComponent(svg)}`;
};
