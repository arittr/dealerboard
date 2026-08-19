import { describe, expect, test } from "bun:test";
import { stripGridLayout, visibleStripKeys } from "../app/src/tiles";
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
    unreadSince: null,
    statusSince: null,
    activityLine: null,
    transcriptPath: null,
    originParentRef: null,
  },
  label: `Session ${slot}`,
  degraded: false,
});

const blank = (degraded = false): KeyModel => ({ kind: "blank", degraded });

describe("visibleStripKeys", () => {
  test("drops trailing blanks so only present sessions are packed", () => {
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

describe("stripGridLayout", () => {
  const bounds = { width: 940, height: 300, gap: 20 };

  test("caps sparse tiles at the three-across square size", () => {
    expect(stripGridLayout(3, bounds)).toEqual({ columnCount: 3, rowCount: 1, tileSize: 300 });
  });

  test("chooses the largest square packing within three rows", () => {
    expect(stripGridLayout(8, bounds)).toEqual({ columnCount: 4, rowCount: 2, tileSize: 140 });
  });

  test("adds columns when two rows make larger tiles than three", () => {
    expect(stripGridLayout(15, bounds)).toEqual({ columnCount: 8, rowCount: 2, tileSize: 100 });
  });

  test("uses the third row when the measured area makes it optimal", () => {
    expect(stripGridLayout(8, { width: 940, height: 940, gap: 20 })).toEqual({
      columnCount: 3,
      rowCount: 3,
      tileSize: 300,
    });
  });
});
