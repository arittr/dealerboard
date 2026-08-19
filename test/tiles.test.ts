import { describe, expect, test } from "bun:test";
import { stripColumnCount, visibleStripKeys } from "../app/src/tiles";
import type { KeyModel } from "../src/plugin/layout";

const session = (slot: number): Extract<KeyModel, { kind: "session" }> => ({
  kind: "session",
  session: {
    provider: "claude",
    sessionId: `s${slot}`,
    project: null,
    title: null,
    model: null,
    status: "idle",
    originKind: null,
    originRef: null,
    originSubagent: false,
    ghosttyTerminalId: null,
    descendantCount: 0,
    logicalSlot: slot,
  },
  label: `Session ${slot}`,
  degraded: false,
});

const blank = (degraded = false): KeyModel => ({ kind: "blank", degraded });

describe("visibleStripKeys", () => {
  test("drops trailing blanks so present sessions flex to fill the row", () => {
    const keys = [session(1), session(2), blank()];
    expect(visibleStripKeys(keys)).toEqual([session(1), session(2)]);
  });

  test("keeps every key when the page is full of sessions", () => {
    const keys = [session(1), session(2), session(3)];
    expect(visibleStripKeys(keys)).toEqual(keys);
  });

  test("trims only from the end — a blank before a session is kept", () => {
    const keys = [session(1), blank(), session(2)];
    expect(visibleStripKeys(keys)).toEqual(keys);
  });

  test("an all-blank page keeps exactly one blank (the degraded OFFLINE surface)", () => {
    const degradedBlank = blank(true);
    expect(visibleStripKeys([degradedBlank, blank(true), blank(false)])).toEqual([degradedBlank]);
  });
});

describe("stripColumnCount", () => {
  test("one row while sessions fit across at full width", () => {
    expect(stripColumnCount(1)).toBe(1);
    expect(stripColumnCount(2)).toBe(2);
    expect(stripColumnCount(3)).toBe(3);
  });

  test("grows rows before columns, never past three rows", () => {
    expect(stripColumnCount(4)).toBe(2);
    expect(stripColumnCount(5)).toBe(3);
    expect(stripColumnCount(6)).toBe(3);
    expect(stripColumnCount(7)).toBe(3);
    expect(stripColumnCount(9)).toBe(3);
  });

  test("past nine sessions, columns grow and tiles shrink", () => {
    expect(stripColumnCount(10)).toBe(4);
    expect(stripColumnCount(12)).toBe(4);
    expect(stripColumnCount(15)).toBe(5);
    expect(stripColumnCount(18)).toBe(6);
  });
});
