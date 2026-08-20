/**
 * Pointer-gesture classification for the strip: a pure state machine fed
 * pointer events (plus a long-press deadline tick) by main.ts, emitting
 * intents. Tap routing stays with the existing click handler; the recognizer
 * only decides when a stroke was something else (long-press or swipe) and
 * when the trailing click must be swallowed. No DOM, no
 * timers — the caller maps Date.now() and setTimeout onto tick/dueAt.
 */

export type GesturePoint = { readonly x: number; readonly y: number };

export type GestureInput =
  | { readonly kind: "down"; readonly point: GesturePoint; readonly now: number }
  | { readonly kind: "move"; readonly point: GesturePoint; readonly now: number }
  | { readonly kind: "up"; readonly point: GesturePoint; readonly now: number }
  | { readonly kind: "cancel"; readonly now: number }
  | { readonly kind: "tick"; readonly now: number };

export type GestureIntent =
  | { readonly kind: "longpress"; readonly point: GesturePoint }
  | { readonly kind: "swipe"; readonly direction: "previous" | "next" }
  | { readonly kind: "suppress-click" };

export const LONG_PRESS_MS = 500;
export const MOVE_SLOP_PX = 12;
export const SWIPE_MIN_HORIZONTAL_PX = 80;
export const SWIPE_MAX_VERTICAL_PX = 48;

type Stroke = {
  readonly start: GesturePoint;
  readonly deadline: number;
  moved: boolean;
  longPressed: boolean;
};

export type GestureRecognizer = {
  /** Feed one event; returns the intents it produced (usually empty). */
  feed: (input: GestureInput) => GestureIntent[];
  /** Absolute `now` at which a long-press tick is due; null when the current stroke cannot long-press. */
  longPressDueAt: () => number | null;
};

export const createGestureRecognizer = (): GestureRecognizer => {
  let stroke: Stroke | null = null;

  const longPressDueAt = (): number | null =>
    stroke !== null && !stroke.moved && !stroke.longPressed ? stroke.deadline : null;

  const feed = (input: GestureInput): GestureIntent[] => {
    switch (input.kind) {
      case "down": {
        if (stroke !== null) {
          return []; // a second finger's down is ignored mid-stroke
        }
        stroke = { start: input.point, deadline: input.now + LONG_PRESS_MS, moved: false, longPressed: false };
        return [];
      }
      case "move": {
        if (stroke === null || stroke.longPressed) {
          return [];
        }
        if (Math.hypot(input.point.x - stroke.start.x, input.point.y - stroke.start.y) > MOVE_SLOP_PX) {
          stroke.moved = true;
        }
        return [];
      }
      case "tick": {
        if (stroke !== null && !stroke.moved && !stroke.longPressed && input.now >= stroke.deadline) {
          stroke.longPressed = true;
          return [{ kind: "longpress", point: stroke.start }];
        }
        return [];
      }
      case "up": {
        if (stroke === null) {
          return [];
        }
        const finished = stroke;
        stroke = null;
        if (finished.longPressed) {
          return [{ kind: "suppress-click" }];
        }
        const dx = input.point.x - finished.start.x;
        const dy = input.point.y - finished.start.y;
        // Recompute the slop from the release position: pointermove delivery
        // is not guaranteed (samples can be coalesced or dropped), so a
        // release beyond the slop must never be treated as a clean tap.
        const moved = finished.moved || Math.hypot(dx, dy) > MOVE_SLOP_PX;
        if (Math.abs(dx) >= SWIPE_MIN_HORIZONTAL_PX && Math.abs(dy) <= SWIPE_MAX_VERTICAL_PX) {
          return [{ kind: "swipe", direction: dx < 0 ? "next" : "previous" }, { kind: "suppress-click" }];
        }
        return moved ? [{ kind: "suppress-click" }] : [];
      }
      case "cancel": {
        stroke = null;
        return [];
      }
    }
  };

  return { feed, longPressDueAt };
};

/**
 * Stroke-scoped click suppression: the wiring-side counterpart of the
 * "suppress-click" intent. A stroke's trailing click can bubble through
 * #tiles (a tile-to-tile release) or through #strip only (a drag released
 * over the rail fires its click on the common ancestor, bypassing #tiles)
 * — and a touch drag fires no click at all. Suppression is therefore bound
 * to the stroke: armed by its release, consumed by the first click after it
 * wherever that click lands, and dropped when the next stroke begins, so it
 * can never be carried forward to eat an innocent tap.
 */
export type ClickSuppression = {
  /** Arm for the stroke that just ended: its trailing click must be swallowed. */
  arm: () => void;
  /** Begin a new stroke: any still-unconsumed suppression from the last one is dropped. */
  beginStroke: () => void;
  /**
   * Consume on a click; true when this click must be swallowed. One-shot:
   * the first click after arming consumes it, later clicks pass untouched.
   */
  consumeClick: () => boolean;
};

export const createClickSuppression = (): ClickSuppression => {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    beginStroke: () => {
      armed = false;
    },
    consumeClick: () => {
      const swallow = armed;
      armed = false;
      return swallow;
    },
  };
};

/** The minimal event surface a swallowed click needs. */
export type SwallowableClick = {
  preventDefault: () => void;
  stopPropagation: () => void;
};

/**
 * Consume an armed suppression and stop the click outright. The strip
 * installs this in the capture phase: a moved stroke released on a page
 * dot would otherwise page-jump first — the dot's own listener fires in the
 * target phase, before any bubble-phase consumer on an ancestor could
 * swallow the click.
 */
export const swallowSuppressedClick = (suppression: ClickSuppression, event: SwallowableClick): boolean => {
  if (!suppression.consumeClick()) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
};
