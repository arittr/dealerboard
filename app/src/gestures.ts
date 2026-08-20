/**
 * Pointer-gesture classification for the strip: a pure state machine fed
 * pointer events (plus a long-press deadline tick) by main.ts, emitting
 * intents. Tap routing stays with the existing click handler; the recognizer
 * only decides when a stroke was something else (long-press, and in a later
 * task, swipe) and when the trailing click must be swallowed. No DOM, no
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
  | { readonly kind: "suppress-click" };

export const LONG_PRESS_MS = 500;
export const MOVE_SLOP_PX = 12;

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
        return finished.longPressed || finished.moved ? [{ kind: "suppress-click" }] : [];
      }
      case "cancel": {
        stroke = null;
        return [];
      }
    }
  };

  return { feed, longPressDueAt };
};
