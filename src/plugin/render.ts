/**
 * XML-safe animated SVG tile renderer for the 5x3 keypad.
 *
 * Every key is a 144x144 SVG returned as one percent-encoded data URL.
 * Session tiles carry a provider-colored corner chip with the two-letter
 * provider mark, up to two centered title lines, a bare
 * descendant count when greater than zero, and a status-colored frame.
 * Animation is a pure function of the key model and an integer phase owned by
 * the plugin: working shows a bright border segment offset by phase, waiting
 * and error breathe through sinusoidal frame opacity (error faster), and idle
 * is a static green frame. Blank, NEXT, and offline treatments render no
 * session title; degraded models add a small error flag, and a degraded blank
 * renders the explicit offline treatment.
 *
 * The label is bounded by Unicode code points before line splitting, every
 * injected text value passes through the one escapeXml helper, and the module
 * imports no SDK or runtime-specific APIs so it bundles into the Node.js
 * plugin unchanged.
 */

import type { Provider, SessionStatus } from "../protocol";
import type { KeyModel } from "./layout";

const DATA_URL_PREFIX = "data:image/svg+xml,";

const TILE_SIZE = 144;
const FRAME_INSET = 4;
const FRAME_SIZE = TILE_SIZE - FRAME_INSET * 2;
const FRAME_WIDTH = 6;
// Square corners keep the dash math an exact perimeter walk.
const FRAME_PERIMETER = FRAME_SIZE * 4;
const WORKING_SEGMENT_LENGTH = 80;
const WORKING_SEGMENT_STEP = 34;

const TITLE_LINE_CAPACITY = 12;
const TITLE_MAX_LINES = 2;
const TITLE_CAPACITY = TITLE_LINE_CAPACITY * TITLE_MAX_LINES;

const COLOR_WORKING = "#20B8FF";
const COLOR_WAITING = "#FFB020";
const COLOR_ERROR = "#FF4D67";
const COLOR_IDLE = "#4ADE80";
// Neutral chrome (NEXT frame, page count, OFFLINE) — not a session status.
const COLOR_NEUTRAL = "#94A3B8";
const COLOR_BACKGROUND = "#10151C";
const COLOR_TEXT = "#E8EEF7";

const PROVIDER_COLORS: Record<Provider, string> = {
  claude: "#D97757",
  codex: "#A855F7",
  kimi: "#3B82F6",
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
      const offset =
        (((phase * WORKING_SEGMENT_STEP) % FRAME_PERIMETER) + FRAME_PERIMETER) % FRAME_PERIMETER;
      return (
        `${frameOpen(color)} opacity="0.35"/>` +
        `${frameOpen(color)} stroke-dasharray="${WORKING_SEGMENT_LENGTH} ${FRAME_PERIMETER - WORKING_SEGMENT_LENGTH}" stroke-dashoffset="${-offset}"/>`
      );
    }
    case "waiting": {
      // Sixteen phases per cycle: a four-second breath at the 250 ms cadence.
      const opacity = 0.55 + 0.35 * Math.sin((phase * Math.PI) / 8);
      return `${frameOpen(color)} opacity="${opacity.toFixed(3)}"/>`;
    }
    case "error": {
      // Eight phases per cycle: a two-second pulse, twice as fast as waiting.
      const opacity = 0.55 + 0.35 * Math.sin((phase * Math.PI) / 4);
      return `${frameOpen(color)} opacity="${opacity.toFixed(3)}"/>`;
    }
    case "idle":
      return `${frameOpen(color)}/>`;
  }
};

const splitTitleLines = (label: string): string[] => {
  const points = Array.from(label).slice(0, TITLE_CAPACITY);
  const lines: string[] = [];
  for (let start = 0; start < points.length; start += TITLE_LINE_CAPACITY) {
    lines.push(points.slice(start, start + TITLE_LINE_CAPACITY).join(""));
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
  `<text class="mark" x="31" y="32" text-anchor="middle" font-size="20" fill="${COLOR_BACKGROUND}">${escapeXml(provider.slice(0, 2).toUpperCase())}</text>`;

const descendantBadge = (descendantCount: number): string =>
  descendantCount > 0
    ? `<text class="badge" x="130" y="128" text-anchor="end" font-size="18" fill="${COLOR_TEXT}">${descendantCount}</text>`
    : "";

const DEGRADED_FLAG = `<text class="flag" x="128" y="27" text-anchor="end" font-size="16" fill="${COLOR_WAITING}">!</text>`;

const sessionTile = (model: Extract<KeyModel, { kind: "session" }>, phase: number): string =>
  statusFrame(model.session.status, phase) +
  providerMark(model.session.provider) +
  titleLines(model.label) +
  descendantBadge(model.session.descendantCount) +
  (model.degraded ? DEGRADED_FLAG : "");

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
