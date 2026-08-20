import { describe, expect, test } from "bun:test";
import { createGestureRecognizer, type GestureInput, LONG_PRESS_MS, MOVE_SLOP_PX } from "../app/src/gestures";

const down = (x: number, y: number, now: number): GestureInput => ({ kind: "down", point: { x, y }, now });
const move = (x: number, y: number, now: number): GestureInput => ({ kind: "move", point: { x, y }, now });
const up = (x: number, y: number, now: number): GestureInput => ({ kind: "up", point: { x, y }, now });
const tick = (now: number): GestureInput => ({ kind: "tick", now });

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
});
