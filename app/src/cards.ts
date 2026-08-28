/**
 * Per-card view model and DOM renderer for the board: the pure derived
 * fields (fallback title, model label cap, project suppression, origin disc)
 * plus the card assembler that turns a BoardPage into the documented card anatomy
 * (status edge, head/meta/status rows, sub pill, spine). All text goes
 * through textContent; no innerHTML anywhere.
 */

import { modelLabel, PROVIDER_LETTERS } from "../../src/plugin/render";
import type { SessionStatus } from "../../src/protocol";
import type { BoardPage, BoardSession, PlacedCard, SpineSegment } from "./board";
import { breathAnimationDelay, elapsedLabel } from "./liveness";

/** The corner's bright word: a working card headlines its session age; the other states spell themselves. */
export const statusWord = (status: SessionStatus): string => (status === "working" ? "open" : status);

/**
 * Compact elapsed text from an ISO stamp, or null when the stamp is absent
 * or unparseable — an old daemon simply shows no number.
 */
export const elapsedSince = (since: string | null, nowMs: number): string | null => {
  if (since === null) {
    return null;
  }
  const startedMs = Date.parse(since);
  if (Number.isNaN(startedMs)) {
    return null;
  }
  return elapsedLabel(nowMs - startedMs);
};

/** The dim corner fact "open 3h" — the session's age as a worded line; null without a usable stamp. */
export const ageLineText = (openedAt: string | null, nowMs: number): string | null => {
  const label = elapsedSince(openedAt, nowMs);
  return label === null ? null : `open ${label}`;
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
  /** The corner word beside the bright number: "open" on working cards, the status elsewhere. */
  word: string;
  /** True when the session ended holding an unviewed result — the card outlives its session. */
  ended: boolean;
  /** The bright number's anchor: openedAt on working cards, statusSince elsewhere; null shows no number. */
  timerSince: string | null;
  timer: string | null;
  /** The dim leading "open <age>" fact on idle/waiting/error cards; null on working
   *  (the gap slot owns that position) and on sessions without an openedAt stamp. */
  age: string | null;
  ageSince: string | null;
  /** The spawner whose containment ring encloses the chip: a Paseo agent
   *  (parents only) or the roborev review daemon; null renders no ring. */
  originRing: "paseo" | "roborev" | null;
  subagent: boolean;
  indent: boolean;
  spine: SpineSegment;
  /** First continued card of a split group on this page — renders the ↩ cont. tag. */
  continuation: boolean;
  displayOnly: boolean;
  badge: number | null;
  degraded: boolean;
};

const SAFE_ACTIVITY_LABELS = new Set(["File", "Command", "Search", "Request", "Tool", "Activity"]);

/** Old daemons may publish raw targets; never render those on the physical display. */
const safeActivityLabel = (activityLine: string | null): string | null => {
  if (activityLine === null) {
    return null;
  }
  return SAFE_ACTIVITY_LABELS.has(activityLine) ? activityLine : "Activity";
};

export const cardViewModel = (card: PlacedCard, nowMs: number): CardViewModel => {
  const { session } = card;
  // Only agent-graph sessions carry openedAt; a legacy snapshot renders no open facts.
  const openedAt = "openedAt" in session ? session.openedAt : null;
  const timerSince = session.status === "working" ? openedAt : session.statusSince;
  const timer = elapsedSince(timerSince, nowMs);
  const age = session.status === "working" ? null : ageLineText(openedAt, nowMs);
  return {
    provider: session.provider,
    letter: PROVIDER_LETTERS[session.provider],
    unread: !card.displayOnly && session.unreadSince !== null,
    title: card.label,
    fallbackTitle: !(session.title !== null && session.title.length > 0),
    modelLabel: session.model === null ? null : modelLabel(session.model, CARD_MODEL_LABEL_MAX_CODE_POINTS),
    project:
      card.subagent && card.parentProject !== null && card.parentProject === session.project ? null : session.project,
    activity: safeActivityLabel(session.activityLine),
    status: session.status,
    ended: session.endedAt !== null,
    word: session.endedAt !== null ? "ended" : statusWord(session.status),
    timerSince: timer === null ? null : timerSince,
    timer,
    age,
    ageSince: age === null ? null : openedAt,
    originRing:
      session.originKind === "paseo" && !session.originSubagent
        ? "paseo"
        : session.originKind === "roborev"
          ? "roborev"
          : null,
    subagent: card.subagent,
    indent: card.indent,
    spine: card.spine,
    continuation: card.continuation,
    displayOnly: card.displayOnly,
    badge: card.displayOnly ? null : card.pendingResults > 0 ? card.pendingResults : card.descendantBadge,
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
    model.ended ? "ended" : "",
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
  // Every card carries the shared wall-clock breath phase; the stylesheet
  // scopes which dots animate on it.
  element.style.setProperty("--breath-delay", breathAnimationDelay(nowMs));

  const head = document.createElement("div");
  head.className = "card-head";
  // The containment ring: a spawner-dispatched chip is enclosed by the
  // multiplexer's ring — the harness inside something. Each spawner keeps
  // its own hue; the shape is shared.
  const chip = appendText(head, model.originRing === null ? "chip" : `chip ${model.originRing}`, model.letter);
  chip.dataset["provider"] = model.provider;
  if (model.unread) {
    // Corner badge: absolutely positioned on the chip, card-colored ring.
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    chip.append(dot);
  }
  // The page-break marker: this card continues a group split from the page
  // behind — spine-violet, so it reads as group identity, not status.
  if (model.continuation) {
    appendText(head, "cont-tag", "↩ cont.");
  }
  // A grouped sub's indent and spine already say it; only an orphan (neither)
  // still needs the pill.
  if (model.subagent && !model.indent) {
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
  if (model.badge !== null && model.badge > 0) {
    appendText(metaRight, "badge", String(model.badge));
  }
  // The quiet label slot stays empty while live; the 1s ticker owns its text.
  appendText(meta, "meta-item quiet-elapsed", "");
  meta.append(metaRight);
  element.append(meta);

  // The corner reads dim fact, worded bright number, dot — the dot last so
  // every card's number and dot share the board column's right rail.
  const statusRow = document.createElement("div");
  statusRow.className = "card-status";
  if (model.status === "working") {
    // The gap slot stays empty while fresh; the 1s liveness ticker owns its text.
    appendText(statusRow, "cardgap", "");
  } else if (model.age !== null && model.ageSince !== null) {
    const age = appendText(statusRow, "cardage", model.age);
    age.dataset["since"] = model.ageSince;
  }
  if (model.timer !== null && model.timerSince !== null) {
    appendText(statusRow, "status-word", model.word);
    const timer = appendText(statusRow, "cardtimer", model.timer);
    timer.dataset["since"] = model.timerSince;
  } else if (model.status === "waiting" || model.status === "error") {
    // The attention states spell themselves even when an old daemon has no stamp.
    appendText(statusRow, "status-word", model.word);
  }
  const statusDot = document.createElement("span");
  statusDot.className = "status-dot";
  statusRow.append(statusDot);
  element.append(statusRow);

  if (model.degraded) {
    appendText(element, "flag", "!");
  }
  // A permanent, invisible layer the ingest path animates on stamp advance.
  const pulse = document.createElement("span");
  pulse.className = "pulse-overlay";
  element.append(pulse);
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

/** The liveness stamp; null (an unstamped row, or an old daemon's snapshot)
 *  renders stampless (the stylesheet treatment). */
export const sessionLastEventAt = (session: BoardSession): string | null => session.lastEventAt;

/**
 * The per-card rebuild signature: everything cardElement bakes into the node
 * except its page position and its liveness stamp — both are (re)applied on
 * every pass by applyCardFrame, so a card that merely moves or ticks keeps
 * its DOM node, its CSS animation phase, and its in-place-painted decay.
 */
export const cardContentSignature = ({ column: _column, row: _row, ...content }: PlacedCard): string =>
  JSON.stringify({ ...content, session: { ...content.session, lastEventAt: undefined } });

/**
 * Everything outside the rebuild signature, (re)written on every pass: grid
 * position, the dense index, and the liveness stamp the 1s decay ticker
 * reads. A reused node gets fresh values without re-inserting.
 */
export const applyCardFrame = (element: HTMLElement, card: PlacedCard, index: number): void => {
  element.dataset["cardIndex"] = String(index);
  element.style.gridColumn = String(card.column + 1);
  element.style.gridRow = String(card.row + 1);
  element.dataset["lastEvent"] = sessionLastEventAt(card.session) ?? "";
};

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
    applyCardFrame(element, patch.card, index);
    kept.add(element);
  }
  for (const child of Array.from(root.children)) {
    if (!kept.has(child)) {
      child.remove();
    }
  }
};
