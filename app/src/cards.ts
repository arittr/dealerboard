/**
 * Pure per-card view model for the board renderer: the timer/wash helpers the
 * strip's tiles already use, plus the derived card fields (fallback title,
 * model label cap, project suppression, origin disc) the board draws from.
 * No DOM, no I/O; the DOM tile layer stays in app/src/tiles.ts until the
 * board renderer replaces it.
 */

import { modelLabel, PROVIDER_LETTERS, washCycleOffset } from "../../src/plugin/render";
import type { ProjectedSession, SessionStatus } from "../../src/protocol";
import type { PlacedCard, SpineSegment } from "./board";

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
