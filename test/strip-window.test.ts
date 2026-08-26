import { describe, expect, test } from "bun:test";
import { logicalPinFrame, stripWindowNeedsPin } from "../app/src/window";

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

describe("logicalPinFrame", () => {
  test("a 1x strip monitor's physical frame is its logical frame", () => {
    const frame = logicalPinFrame({ position: { x: 1651, y: 1692 }, size: strip.size, scaleFactor: 1 });
    expect(frame).toEqual({ position: { x: 1651, y: 1692 }, size: { width: 2560, height: 720 } });
  });

  test("divides by the monitor's own scale, not the window's current display scale", () => {
    // The regression: physical values fed to setPosition/setSize are
    // interpreted against the window's current display — from a 2x main
    // display the coordinates halve and the pin never converges.
    const frame = logicalPinFrame({ position: { x: 3008, y: 0 }, size: { width: 6016, height: 3384 }, scaleFactor: 2 });
    expect(frame).toEqual({ position: { x: 1504, y: 0 }, size: { width: 3008, height: 1692 } });
  });
});
