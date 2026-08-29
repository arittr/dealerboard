/**
 * Pointer-gesture classification for the strip: a pure state machine fed
 * pointer events (plus a long-press deadline tick) by main.ts, emitting
 * intents. Tap routing stays with the existing click handler; the recognizer
 * decides when a stroke locks into a paging drag (streaming drag intents),
 * when it was something else (long-press or flick), and when the trailing
 * click must be swallowed. No DOM, no
 * timers — the caller maps Date.now() and setTimeout onto tick/dueAt.
 */

export type GesturePoint = { readonly x: number; readonly y: number };

export type GestureInput =
  | { readonly kind: "down"; readonly point: GesturePoint; readonly now: number }
  | { readonly kind: "move"; readonly point: GesturePoint; readonly now: number }
  | { readonly kind: "up"; readonly point: GesturePoint; readonly now: number }
  | { readonly kind: "cancel"; readonly now: number }
  | { readonly kind: "tick"; readonly now: number }
  | { readonly kind: "context"; readonly point: GesturePoint; readonly now: number };

export type GestureIntent =
  | { readonly kind: "longpress"; readonly point: GesturePoint }
  | { readonly kind: "drag-start" }
  | { readonly kind: "drag-move"; readonly dx: number }
  | { readonly kind: "drag-end"; readonly dx: number; readonly velocity: number }
  | { readonly kind: "drag-cancel" }
  | { readonly kind: "flick"; readonly direction: "up" | "down" }
  | { readonly kind: "suppress-click" };

export const LONG_PRESS_MS = 500;
export const MOVE_SLOP_PX = 12;
/** Axis-lock threshold. Freely tunable: the lock itself kills the stroke's
 *  hold outcomes (the tick and context cases reject dragging strokes), so no
 *  ordering with MOVE_SLOP_PX is load-bearing. Tuned on device. */
export const DRAG_LOCK_MIN_PX = 16;
/** Trailing sample window for the release velocity. Tuned on device. */
export const VELOCITY_WINDOW_MS = 100;
export const FLICK_MIN_VERTICAL_PX = 56;
export const FLICK_MAX_HORIZONTAL_PX = 48;

type Sample = { readonly x: number; readonly now: number };

type Stroke = {
  readonly start: GesturePoint;
  readonly deadline: number;
  moved: boolean;
  longPressed: boolean;
  /** Horizontal axis lock: the stroke is a paging drag until it ends. */
  dragging: boolean;
  /** Vertical won the axis race: this touch can never become a paging drag. */
  verticalLocked: boolean;
  samples: Sample[];
};

const pushSample = (stroke: Stroke, x: number, now: number): void => {
  stroke.samples.push({ x, now });
  while (stroke.samples.length > 0 && now - (stroke.samples[0]?.now ?? now) > VELOCITY_WINDOW_MS) {
    stroke.samples.shift();
  }
};

/** px/ms over the trailing window; 0 with no earlier sample there (sparse delivery settles by distance alone). */
const releaseVelocity = (samples: readonly Sample[], x: number, now: number): number => {
  const anchor = samples.find((sample) => now - sample.now <= VELOCITY_WINDOW_MS);
  if (anchor === undefined || now === anchor.now) {
    return 0;
  }
  return (x - anchor.x) / (now - anchor.now);
};

export type GestureRecognizer = {
  /** Feed one event; returns the intents it produced (usually empty). */
  feed: (input: GestureInput) => GestureIntent[];
  /** Absolute `now` at which a long-press tick is due; null when the current stroke cannot long-press. */
  longPressDueAt: () => number | null;
};

export const createGestureRecognizer = (): GestureRecognizer => {
  let stroke: Stroke | null = null;

  // Mirrors the tick case's guard: a stroke the tick cannot long-press
  // (moved, long-pressed, or locked into a drag) must not advertise a
  // deadline either — the driver reschedules from this after every feed,
  // and a stale expired deadline would re-arm zero-delay ticks forever.
  const longPressDueAt = (): number | null =>
    stroke !== null && !stroke.moved && !stroke.longPressed && !stroke.dragging ? stroke.deadline : null;

  const feed = (input: GestureInput): GestureIntent[] => {
    switch (input.kind) {
      case "down": {
        if (stroke !== null) {
          return []; // a second finger's down is ignored mid-stroke
        }
        stroke = {
          start: input.point,
          deadline: input.now + LONG_PRESS_MS,
          moved: false,
          longPressed: false,
          dragging: false,
          verticalLocked: false,
          samples: [{ x: input.point.x, now: input.now }],
        };
        return [];
      }
      case "move": {
        if (stroke === null || stroke.longPressed) {
          return [];
        }
        const dx = input.point.x - stroke.start.x;
        const dy = input.point.y - stroke.start.y;
        if (Math.hypot(dx, dy) > MOVE_SLOP_PX) {
          stroke.moved = true;
        }
        pushSample(stroke, input.point.x, input.now);
        if (!stroke.dragging && !stroke.verticalLocked && Math.max(Math.abs(dx), Math.abs(dy)) >= DRAG_LOCK_MIN_PX) {
          // The axis race: whichever displacement dominates first owns the
          // touch. A tie goes vertical — paging never steals the dismiss axis.
          if (Math.abs(dx) > Math.abs(dy)) {
            stroke.dragging = true;
            return [{ kind: "drag-start" }, { kind: "drag-move", dx }];
          }
          stroke.verticalLocked = true;
        }
        return stroke.dragging ? [{ kind: "drag-move", dx }] : [];
      }
      case "tick": {
        if (
          stroke !== null &&
          !stroke.moved &&
          !stroke.longPressed &&
          !stroke.dragging && // a locked drag's hold deadline is dead at any tuning
          input.now >= stroke.deadline
        ) {
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
        // Recompute from the release position: pointermove delivery is not
        // guaranteed (samples can be coalesced or dropped), so the final
        // position alone must still lock a drag or dirty a tap.
        const moved = finished.moved || Math.hypot(dx, dy) > MOVE_SLOP_PX;
        const horizontal =
          finished.dragging ||
          (!finished.verticalLocked && Math.abs(dx) >= DRAG_LOCK_MIN_PX && Math.abs(dx) > Math.abs(dy));
        if (horizontal) {
          const end = {
            kind: "drag-end" as const,
            dx,
            velocity: releaseVelocity(finished.samples, input.point.x, input.now),
          };
          // A sample-starved stroke may lock only here: the driver learns of
          // the drag, its displacement, and its settle in one batch —
          // drag-start always precedes drag-end within a stroke (the session
          // has bounds), and the interposed drag-move carries the release
          // displacement so even this path paints a visible offset before
          // the settle returns.
          return finished.dragging
            ? [end, { kind: "suppress-click" }]
            : [{ kind: "drag-start" }, { kind: "drag-move", dx }, end, { kind: "suppress-click" }];
        }
        // Vertical is the dismiss axis: horizontal is taken by paging, so a
        // vertical-dominant release flicks the pressed card away instead.
        if (Math.abs(dy) >= FLICK_MIN_VERTICAL_PX && Math.abs(dx) <= FLICK_MAX_HORIZONTAL_PX) {
          return [{ kind: "flick", direction: dy < 0 ? "up" : "down" }, { kind: "suppress-click" }];
        }
        return moved ? [{ kind: "suppress-click" }] : [];
      }
      case "cancel": {
        const wasDragging = stroke?.dragging === true;
        stroke = null;
        return wasDragging ? [{ kind: "drag-cancel" }] : [];
      }
      // The platform's own hold verdict: macOS synthesizes a touchscreen
      // touch-and-hold as a secondary click, whose contextmenu event is the
      // only page-visible signal — the finger never produces the sustained
      // primary-button down the tick path needs. It outranks the slop check
      // (the classifying driver, not this recognizer, judged the hold), and
      // a mouse right-click rides the same route.
      case "context": {
        if (stroke === null) {
          return [{ kind: "longpress", point: input.point }];
        }
        if (stroke.longPressed || stroke.dragging) {
          return [];
        }
        stroke.longPressed = true;
        return [{ kind: "longpress", point: stroke.start }];
      }
    }
  };

  return { feed, longPressDueAt };
};

/**
 * Stroke-scoped click suppression: the wiring-side counterpart of the
 * "suppress-click" intent. A stroke's trailing click can bubble through
 * #board from anywhere in it (a card-to-card release, or a drag whose
 * pointer capture carried it past the board edge) — and a touch drag
 * fires no click at all. Suppression is therefore bound
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
  /** 0 when no pointer is behind the click (keyboard or assistive activation). */
  readonly detail: number;
  preventDefault: () => void;
  stopPropagation: () => void;
};

/**
 * Consume an armed suppression and stop the click outright. The driver
 * installs this in the capture phase: a moved stroke released on a pip
 * would otherwise page-jump first — the pip's own listener fires in the
 * target phase, before any bubble-phase consumer on an ancestor could
 * swallow the click. A detail-0 click carries no pointer (keyboard
 * Enter/Space, assistive activation), so it cannot be a stroke's trailing
 * click: it passes untouched, though it still consumes the arm — a stale
 * one must not survive to swallow an innocent later pointer click.
 */
export const swallowSuppressedClick = (suppression: ClickSuppression, event: SwallowableClick): boolean => {
  const swallow = suppression.consumeClick();
  if (!swallow || event.detail === 0) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
};
