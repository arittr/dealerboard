import { describe, expect, test } from "bun:test";
import {
  createClickSuppression,
  createGestureRecognizer,
  createScrollGestureRecognizer,
  DRAG_LOCK_MIN_PX,
  FLICK_MAX_HORIZONTAL_PX,
  FLICK_MIN_VERTICAL_PX,
  type GestureInput,
  LONG_PRESS_MS,
  MOVE_SLOP_PX,
  SCROLL_GESTURE_IDLE_MS,
  SCROLL_GESTURE_THRESHOLD_PX,
  swallowSuppressedClick,
  VELOCITY_WINDOW_MS,
} from "../app/src/gestures";

const down = (x: number, y: number, now: number): GestureInput => ({ kind: "down", point: { x, y }, now });
const move = (x: number, y: number, now: number): GestureInput => ({ kind: "move", point: { x, y }, now });
const up = (x: number, y: number, now: number): GestureInput => ({ kind: "up", point: { x, y }, now });
const tick = (now: number): GestureInput => ({ kind: "tick", now });
const context = (x: number, y: number, now: number): GestureInput => ({ kind: "context", point: { x, y }, now });

describe("createGestureRecognizer", () => {
  test("a clean tap emits nothing and does not suppress the click", () => {
    const recognizer = createGestureRecognizer();
    expect(recognizer.feed(down(100, 100, 0))).toEqual([]);
    expect(recognizer.feed(up(100, 100, 80))).toEqual([]);
  });

  test("a tick before the deadline does not fire the long-press", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    expect(recognizer.feed(tick(LONG_PRESS_MS - 1))).toEqual([]);
  });

  test("holding past the deadline fires the long-press once and swallows the trailing click", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    expect(recognizer.feed(tick(LONG_PRESS_MS))).toEqual([{ kind: "longpress", point: { x: 100, y: 100 } }]);
    expect(recognizer.feed(tick(LONG_PRESS_MS + 100))).toEqual([]);
    expect(recognizer.feed(up(100, 100, LONG_PRESS_MS + 200))).toEqual([{ kind: "suppress-click" }]);
  });

  test("jitter within the slop radius keeps the long-press alive", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    // Jitter below BOTH thresholds: sub-slop (the long-press contract under
    // test) and sub-lock (so no relative tuning of DRAG_LOCK_MIN_PX against
    // MOVE_SLOP_PX can turn this hold into a paging drag).
    const jitter = Math.max(0, Math.min(MOVE_SLOP_PX, DRAG_LOCK_MIN_PX) - 2);
    recognizer.feed(move(100 + jitter, 100, 200));
    expect(recognizer.feed(tick(LONG_PRESS_MS))).toEqual([{ kind: "longpress", point: { x: 100, y: 100 } }]);
  });

  test("moving past the slop kills the long-press and the release suppresses the click", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    recognizer.feed(move(100, 100 + MOVE_SLOP_PX + 10, 200));
    expect(recognizer.longPressDueAt()).toBeNull();
    expect(recognizer.feed(tick(LONG_PRESS_MS + 50))).toEqual([]);
    expect(recognizer.feed(up(100, 122, 300))).toEqual([{ kind: "suppress-click" }]);
  });

  test("longPressDueAt tracks the stroke lifecycle", () => {
    const recognizer = createGestureRecognizer();
    expect(recognizer.longPressDueAt()).toBeNull();
    recognizer.feed(down(100, 100, 1000));
    expect(recognizer.longPressDueAt()).toBe(1000 + LONG_PRESS_MS);
    recognizer.feed(up(100, 100, 1100));
    expect(recognizer.longPressDueAt()).toBeNull();
  });

  test("a second finger's down is ignored while a stroke is tracked", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    expect(recognizer.feed(down(300, 300, 10))).toEqual([]);
    expect(recognizer.feed(tick(LONG_PRESS_MS))).toEqual([{ kind: "longpress", point: { x: 100, y: 100 } }]);
  });

  test("a cancel drops the stroke silently", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    expect(recognizer.feed({ kind: "cancel", now: 100 })).toEqual([]);
    expect(recognizer.feed(tick(LONG_PRESS_MS))).toEqual([]);
    expect(recognizer.feed(up(100, 100, 200))).toEqual([]);
  });

  test("a stroke that long-pressed stays suppressed even after drifting", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    recognizer.feed(tick(LONG_PRESS_MS));
    recognizer.feed(move(400, 100, LONG_PRESS_MS + 100));
    expect(recognizer.feed(up(400, 100, LONG_PRESS_MS + 200))).toEqual([{ kind: "suppress-click" }]);
  });

  test("a release past the slop suppresses the click even without a move sample", () => {
    // Pointermove delivery is not guaranteed (coalesced or dropped): the
    // final position alone must decide, so a sub-swipe release beyond the
    // slop is never treated as a clean tap.
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    expect(recognizer.feed(up(100, 100 + MOVE_SLOP_PX + 10, 300))).toEqual([{ kind: "suppress-click" }]);
  });

  test("a moved stroke's suppression does not bleed into the next clean tap", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    recognizer.feed(move(100, 140, 200));
    expect(recognizer.feed(up(100, 140, 300))).toEqual([{ kind: "suppress-click" }]);
    recognizer.feed(down(200, 200, 1000));
    expect(recognizer.feed(up(200, 200, 1080))).toEqual([]);
  });
});

describe("drag axis lock", () => {
  // A locked drag for tests that need one: displacement derived from the
  // exported constant, so Task 9 tuning can never un-lock it.
  const lockX = 400 - DRAG_LOCK_MIN_PX - 24;

  test("horizontal dominance past the lock threshold starts a drag and streams dx", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    expect(recognizer.feed(move(400 - DRAG_LOCK_MIN_PX - 4, 302, 40))).toEqual([
      { kind: "drag-start" },
      { kind: "drag-move", dx: -(DRAG_LOCK_MIN_PX + 4) },
    ]);
    expect(recognizer.feed(move(300, 305, 80))).toEqual([{ kind: "drag-move", dx: -100 }]);
  });

  test("a locked drag's release is a drag-end with a trailing-window velocity, click suppressed", () => {
    // Sample geometry derives from VELOCITY_WINDOW_MS: one sample lands just
    // outside the window (never the anchor), one at half a window before the
    // release (always the anchor) — the expectation holds for any tuning.
    const recognizer = createGestureRecognizer();
    const release = VELOCITY_WINDOW_MS * 10;
    const outside = release - VELOCITY_WINDOW_MS - 10;
    const inside = release - VELOCITY_WINDOW_MS / 2;
    const anchorX = lockX - 60;
    const releaseX = anchorX - 100;
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(lockX, 300, outside));
    recognizer.feed(move(anchorX, 300, inside));
    expect(recognizer.feed(up(releaseX, 300, release))).toEqual([
      { kind: "drag-end", dx: releaseX - 400, velocity: (releaseX - anchorX) / (release - inside) },
      { kind: "suppress-click" },
    ]);
  });

  test("release-position fallback: a sample-free horizontal release is a full drag batch", () => {
    // Pointermove delivery is not guaranteed (coalesced or dropped): the
    // final position alone must still produce a drag — drag-start FIRST (so
    // the driver's session has bounds), then drag-move carrying the release
    // displacement (so even this path paints a visible offset before the
    // settle returns — a failed swipe is never a silent no-op), then the
    // distance-decided end (no samples inside the window means velocity 0;
    // the release instant sits beyond any tuned window).
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    expect(recognizer.feed(up(400 - DRAG_LOCK_MIN_PX - 10, 302, VELOCITY_WINDOW_MS * 2))).toEqual([
      { kind: "drag-start" },
      { kind: "drag-move", dx: -(DRAG_LOCK_MIN_PX + 10) },
      { kind: "drag-end", dx: -(DRAG_LOCK_MIN_PX + 10), velocity: 0 },
      { kind: "suppress-click" },
    ]);
  });

  test("vertical wins the axis race and blocks a later horizontal lock; the release still flicks", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(402, 300 + DRAG_LOCK_MIN_PX + 4, 40));
    expect(recognizer.feed(move(430, 370, 100))).toEqual([]);
    expect(recognizer.feed(up(430, 370, 160))).toEqual([
      { kind: "flick", direction: "down" },
      { kind: "suppress-click" },
    ]);
  });

  test("a diagonal tie locks vertical: paging never steals the dismiss axis", () => {
    const recognizer = createGestureRecognizer();
    const tie = DRAG_LOCK_MIN_PX + 4;
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(400 + tie, 300 + tie, 40));
    expect(recognizer.feed(move(300, 300 + tie, 80))).toEqual([]);
    expect(recognizer.feed(up(280, 300 + tie, 120))).toEqual([{ kind: "suppress-click" }]);
  });

  test("a jitter below the lock threshold never drags", () => {
    // Purely horizontal and derived below the lock: at any tuning the
    // stroke can never drag. Whether the release is a suppressed click or
    // a clean tap depends on where the jitter lands against the slop —
    // both outcomes are correct, so the assertion follows the exported
    // threshold, mirroring the recognizer's own strict `>` slop check.
    const jitter = Math.max(0, DRAG_LOCK_MIN_PX - 2);
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    // Both batches, not just the release: a regression that streams a drag
    // intent on the move while releasing clean must fail here too.
    const intents = [...recognizer.feed(move(400 + jitter, 300, 150)), ...recognizer.feed(up(400 + jitter, 300, 200))];
    expect(intents.filter((intent) => intent.kind.startsWith("drag"))).toEqual([]);
    expect(intents).toEqual(jitter > MOVE_SLOP_PX ? [{ kind: "suppress-click" }] : []);
  });

  test("once locked, the platform hold verdict and the deadline tick are dead for the stroke", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(lockX, 300, 40));
    expect(recognizer.feed(context(lockX, 300, 50))).toEqual([]);
    expect(recognizer.feed(tick(LONG_PRESS_MS))).toEqual([]);
    expect(recognizer.feed(up(lockX, 300, LONG_PRESS_MS + 40))[0]?.kind).toBe("drag-end");
  });

  test("a locked drag never advertises a long-press deadline at any tuning", () => {
    // The driver reschedules its tick from longPressDueAt after every feed;
    // a drag that locks below the slop (reachable whenever DRAG_LOCK_MIN_PX
    // is tuned at or below MOVE_SLOP_PX) leaves `moved` false, so a stale
    // deadline here would re-arm zero-delay ticks forever. The lock
    // displacement derives from the constant so it stays sub-slop in that
    // regime — red proven under a tuned DRAG_LOCK_MIN_PX (see the task
    // report); at today's constants the lock implies `moved`, which already
    // nulls the deadline.
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(400 - DRAG_LOCK_MIN_PX - 4, 300, 40));
    expect(recognizer.longPressDueAt()).toBeNull();
  });

  test("cancel mid-drag emits drag-cancel; cancel without a lock stays silent", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(lockX, 300, 40));
    expect(recognizer.feed({ kind: "cancel", now: 80 })).toEqual([{ kind: "drag-cancel" }]);
    recognizer.feed(down(400, 300, 200));
    expect(recognizer.feed({ kind: "cancel", now: 240 })).toEqual([]);
  });

  test("a drag returning to its origin still ends as a drag — visible snap-back, not a tap", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(lockX, 300, 40));
    recognizer.feed(move(398, 300, 90));
    const intents = recognizer.feed(up(400, 300, 130));
    expect(intents[0]).toMatchObject({ kind: "drag-end", dx: 0 });
    expect(intents[1]).toEqual({ kind: "suppress-click" });
    expect(intents).toHaveLength(2);
  });

  test("a stroke that long-pressed never becomes a drag", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(tick(LONG_PRESS_MS));
    recognizer.feed(move(100, 300, LONG_PRESS_MS + 100));
    expect(recognizer.feed(up(100, 300, LONG_PRESS_MS + 200))).toEqual([{ kind: "suppress-click" }]);
  });
});

describe("flick classification", () => {
  test("an upward fling past the threshold is a flick and suppresses the click", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(410, 300 - FLICK_MIN_VERTICAL_PX - 20, 120));
    expect(recognizer.feed(up(410, 300 - FLICK_MIN_VERTICAL_PX - 20, 180))).toEqual([
      { kind: "flick", direction: "up" },
      { kind: "suppress-click" },
    ]);
  });

  test("a downward fling is a flick too", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    expect(recognizer.feed(up(395, 300 + FLICK_MIN_VERTICAL_PX + 20, 180))).toEqual([
      { kind: "flick", direction: "down" },
      { kind: "suppress-click" },
    ]);
  });

  test("a diagonal drag beyond the horizontal tolerance is neither swipe nor flick", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    expect(recognizer.feed(up(400 + 60, 300 + FLICK_MIN_VERTICAL_PX + 20, 180))).toEqual([{ kind: "suppress-click" }]);
  });

  test("a vertically locked stroke stays a flick despite later sideways drift", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(400, 300 - DRAG_LOCK_MIN_PX - 4, 20));
    expect(recognizer.feed(up(400 + FLICK_MAX_HORIZONTAL_PX + 2, 300 - FLICK_MIN_VERTICAL_PX - 40, 80))).toEqual([
      { kind: "flick", direction: "up" },
      { kind: "suppress-click" },
    ]);
  });

  test("a short vertical drag below the threshold is not a flick", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    expect(recognizer.feed(up(400, 300 + FLICK_MIN_VERTICAL_PX - 10, 180))).toEqual([{ kind: "suppress-click" }]);
  });

  test("a stroke that long-pressed never becomes a flick", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(tick(LONG_PRESS_MS));
    recognizer.feed(move(400, 500, LONG_PRESS_MS + 100));
    expect(recognizer.feed(up(400, 500, LONG_PRESS_MS + 200))).toEqual([{ kind: "suppress-click" }]);
  });
});

describe("context press", () => {
  test("a context signal on a live stroke long-presses it and the trailing release suppresses the click", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    expect(recognizer.feed(context(100, 100, 2))).toEqual([{ kind: "longpress", point: { x: 100, y: 100 } }]);
    expect(recognizer.feed(up(100, 100, 80))).toEqual([{ kind: "suppress-click" }]);
  });

  test("a context signal with no stroke long-presses at its own point", () => {
    const recognizer = createGestureRecognizer();
    expect(recognizer.feed(context(250, 40, 10))).toEqual([{ kind: "longpress", point: { x: 250, y: 40 } }]);
  });

  test("a context signal after the deadline tick fires nothing more", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    recognizer.feed(tick(LONG_PRESS_MS));
    expect(recognizer.feed(context(100, 100, LONG_PRESS_MS + 10))).toEqual([]);
  });

  test("a context signal cannot steal a moved vertical stroke", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    recognizer.feed(move(100, 100 + FLICK_MIN_VERTICAL_PX, 50));
    expect(recognizer.feed(context(100, 100 + FLICK_MIN_VERTICAL_PX, 60))).toEqual([]);
    expect(recognizer.feed(up(100, 100 + FLICK_MIN_VERTICAL_PX, 80))).toEqual([
      { kind: "flick", direction: "down" },
      { kind: "suppress-click" },
    ]);
  });

  test("a stroke that context-pressed never becomes a flick", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(context(400, 300, 2));
    recognizer.feed(move(400, 500, 100));
    expect(recognizer.feed(up(400, 500, 150))).toEqual([{ kind: "suppress-click" }]);
  });

  test("longPressDueAt goes quiet once the context signal lands", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    recognizer.feed(context(100, 100, 2));
    expect(recognizer.longPressDueAt()).toBeNull();
  });
});

describe("translated scroll gestures", () => {
  test("a vertical burst emits one flick only after crossing the travel threshold", () => {
    const recognizer = createScrollGestureRecognizer();
    expect(recognizer.feed({ deltaX: 0, deltaY: -(SCROLL_GESTURE_THRESHOLD_PX - 1), now: 0 })).toEqual({
      started: true,
      intents: [],
    });
    expect(recognizer.feed({ deltaX: 0, deltaY: -1, now: 10 })).toEqual({
      started: false,
      intents: [{ kind: "flick", direction: "up" }],
    });
    expect(recognizer.feed({ deltaX: 0, deltaY: -100, now: 20 })).toEqual({ started: false, intents: [] });
  });

  test("horizontal bursts page in the natural-scroll direction", () => {
    const recognizer = createScrollGestureRecognizer();
    expect(recognizer.feed({ deltaX: SCROLL_GESTURE_THRESHOLD_PX, deltaY: 0, now: 0 })).toEqual({
      started: true,
      intents: [{ kind: "page", direction: "next" }],
    });
    expect(
      recognizer.feed({
        deltaX: -SCROLL_GESTURE_THRESHOLD_PX,
        deltaY: 0,
        now: SCROLL_GESTURE_IDLE_MS + 1,
      }),
    ).toEqual({ started: true, intents: [{ kind: "page", direction: "previous" }] });
  });

  test("a diagonal tie belongs to the card-dismiss axis", () => {
    const recognizer = createScrollGestureRecognizer();
    expect(
      recognizer.feed({
        deltaX: SCROLL_GESTURE_THRESHOLD_PX,
        deltaY: SCROLL_GESTURE_THRESHOLD_PX,
        now: 0,
      }),
    ).toEqual({ started: true, intents: [{ kind: "flick", direction: "down" }] });
  });

  test("a sub-threshold burst resets after the idle boundary", () => {
    const recognizer = createScrollGestureRecognizer();
    expect(recognizer.feed({ deltaX: 20, deltaY: 0, now: 0 })).toEqual({ started: true, intents: [] });
    expect(recognizer.feed({ deltaX: 20, deltaY: 0, now: SCROLL_GESTURE_IDLE_MS })).toEqual({
      started: false,
      intents: [],
    });
    expect(recognizer.feed({ deltaX: 20, deltaY: 0, now: SCROLL_GESTURE_IDLE_MS * 2 + 1 })).toEqual({
      started: true,
      intents: [],
    });
  });
});

describe("swallowSuppressedClick", () => {
  const recordingEvent = (detail = 1) => {
    const calls: string[] = [];
    return {
      calls,
      event: {
        detail,
        preventDefault: () => calls.push("preventDefault"),
        stopPropagation: () => calls.push("stopPropagation"),
      },
    };
  };

  test("an armed click is consumed and stopped before any handler sees it", () => {
    const suppression = createClickSuppression();
    suppression.arm();
    const { calls, event } = recordingEvent();
    expect(swallowSuppressedClick(suppression, event)).toBe(true);
    expect(calls).toEqual(["preventDefault", "stopPropagation"]);
  });

  test("a clean click is left untouched for normal routing", () => {
    const suppression = createClickSuppression();
    suppression.beginStroke();
    const { calls, event } = recordingEvent();
    expect(swallowSuppressedClick(suppression, event)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("swallowing is one-shot: the next click passes", () => {
    const suppression = createClickSuppression();
    suppression.arm();
    swallowSuppressedClick(suppression, recordingEvent().event);
    const { calls, event } = recordingEvent();
    expect(swallowSuppressedClick(suppression, event)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a keyboard activation passes through an armed suppression and drops the arm", () => {
    const suppression = createClickSuppression();
    // A touch drag arms suppression and fires no trailing click; keyboard
    // Enter/Space (and assistive activation) click with detail 0 and no
    // pointerdown, so no stroke ever clears the stale arm first.
    suppression.arm();
    const key = recordingEvent(0);
    expect(swallowSuppressedClick(suppression, key.event)).toBe(false);
    expect(key.calls).toEqual([]);
    // The arm is consumed, not retained: a later pointer click must not be
    // swallowed for the keyboard press's sake.
    const pointer = recordingEvent(1);
    expect(swallowSuppressedClick(suppression, pointer.event)).toBe(false);
    expect(pointer.calls).toEqual([]);
  });
});

describe("createClickSuppression", () => {
  test("swallows exactly the first click after arming", () => {
    const suppression = createClickSuppression();
    suppression.arm();
    expect(suppression.consumeClick()).toBe(true);
    expect(suppression.consumeClick()).toBe(false);
  });

  test("a stroke's suppression never survives into the next stroke", () => {
    const suppression = createClickSuppression();
    suppression.arm();
    // A touch drag fires no trailing click at all; the next stroke must not
    // inherit the old stroke's suppression.
    suppression.beginStroke();
    expect(suppression.consumeClick()).toBe(false);
  });

  test("a click for a clean stroke is never swallowed", () => {
    const suppression = createClickSuppression();
    suppression.beginStroke();
    expect(suppression.consumeClick()).toBe(false);
  });
});
