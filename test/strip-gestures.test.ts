import { describe, expect, test } from "bun:test";
import {
  createClickSuppression,
  createGestureRecognizer,
  FLICK_MIN_VERTICAL_PX,
  type GestureInput,
  LONG_PRESS_MS,
  MOVE_SLOP_PX,
  SWIPE_MIN_HORIZONTAL_PX,
  swallowSuppressedClick,
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
    recognizer.feed(move(100 + MOVE_SLOP_PX - 2, 100, 200));
    expect(recognizer.feed(tick(LONG_PRESS_MS))).toEqual([{ kind: "longpress", point: { x: 100, y: 100 } }]);
  });

  test("moving past the slop kills the long-press and the release suppresses the click", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    recognizer.feed(move(100 + MOVE_SLOP_PX + 10, 100, 200));
    expect(recognizer.longPressDueAt()).toBeNull();
    expect(recognizer.feed(tick(LONG_PRESS_MS + 50))).toEqual([]);
    expect(recognizer.feed(up(140, 100, 300))).toEqual([{ kind: "suppress-click" }]);
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
    expect(recognizer.feed(up(100 + MOVE_SLOP_PX + 10, 100, 300))).toEqual([{ kind: "suppress-click" }]);
  });

  test("a moved stroke's suppression does not bleed into the next clean tap", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    recognizer.feed(move(140, 100, 200));
    expect(recognizer.feed(up(140, 100, 300))).toEqual([{ kind: "suppress-click" }]);
    recognizer.feed(down(200, 200, 1000));
    expect(recognizer.feed(up(200, 200, 1080))).toEqual([]);
  });
});

describe("swipe classification", () => {
  test("a leftward fling pages next and suppresses the click", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(400 - SWIPE_MIN_HORIZONTAL_PX - 40, 320, 120));
    expect(recognizer.feed(up(280, 320, 200))).toEqual([
      { kind: "swipe", direction: "next" },
      { kind: "suppress-click" },
    ]);
  });

  test("a rightward fling pages previous", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 300, 0));
    recognizer.feed(move(100 + SWIPE_MIN_HORIZONTAL_PX + 40, 310, 150));
    expect(recognizer.feed(up(220, 310, 250))).toEqual([
      { kind: "swipe", direction: "previous" },
      { kind: "suppress-click" },
    ]);
  });

  test("a vertical-dominant drag is a flick, not a swipe", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 100, 0));
    recognizer.feed(move(430, 400, 200));
    expect(recognizer.feed(up(430, 400, 250))).toEqual([
      { kind: "flick", direction: "down" },
      { kind: "suppress-click" },
    ]);
  });

  test("a short horizontal drag below the threshold is not a swipe", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(400, 300, 0));
    recognizer.feed(move(400 + SWIPE_MIN_HORIZONTAL_PX - 20, 305, 150));
    expect(recognizer.feed(up(400 + SWIPE_MIN_HORIZONTAL_PX - 20, 305, 200))).toEqual([{ kind: "suppress-click" }]);
  });

  test("a stroke that long-pressed never becomes a swipe", () => {
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

  test("a context signal overrides the slop: a wiggled stroke still long-presses", () => {
    const recognizer = createGestureRecognizer();
    recognizer.feed(down(100, 100, 0));
    recognizer.feed(move(100 + MOVE_SLOP_PX + 10, 100, 50));
    expect(recognizer.feed(context(100, 100, 60))).toEqual([{ kind: "longpress", point: { x: 100, y: 100 } }]);
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

describe("swallowSuppressedClick", () => {
  const recordingEvent = () => {
    const calls: string[] = [];
    return {
      calls,
      event: {
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
