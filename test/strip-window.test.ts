import { describe, expect, test } from "bun:test";
import { stripWindowNeedsPin } from "../app/src/window";

const strip = { position: { x: 1280, y: 0 }, size: { width: 2560, height: 720 } };

describe("stripWindowNeedsPin", () => {
  test("never re-pins a fullscreen window even when its geometry differs", () => {
    expect(stripWindowNeedsPin(true, { x: 0, y: 0 }, { width: 1280, height: 360 }, strip)).toBe(false);
  });

  test("re-pins windowed geometry drift and leaves an exact match alone", () => {
    expect(stripWindowNeedsPin(false, { x: 0, y: 0 }, { width: 1280, height: 360 }, strip)).toBe(true);
    expect(stripWindowNeedsPin(false, strip.position, strip.size, strip)).toBe(false);
  });
});
