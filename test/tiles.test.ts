import { describe, expect, test } from "bun:test";
import { visibleStripKeys } from "../app/src/tiles";
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
