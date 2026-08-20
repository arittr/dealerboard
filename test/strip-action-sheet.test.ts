import { describe, expect, test } from "bun:test";
import { buildSheetModel, reduceSheetSelection, transcriptPathOf } from "../app/src/action-sheet";
import type { ProjectedSession } from "../src/protocol";

const session = (overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: "session-1",
  status: "idle",
  title: "A session",
  project: "stream-deck-agents",
  descendantCount: 0,
  logicalSlot: 1,
  ghosttyTerminalId: null,
  model: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  unreadSince: null,
  statusSince: null,
  activityLine: null,
  transcriptPath: null,
  originParentRef: null,
  ...overrides,
});

/**
 * transcriptPath is additive (Lane A): inject it the way a new daemon
 * would, regardless of whether the type has the field yet.
 */
const withTranscriptPath = (path: string | null): ProjectedSession => {
  const value = session();
  value["transcriptPath"] = path;
  return value;
};

describe("transcriptPathOf", () => {
  test("is null when the key is absent (old daemon / pre-Lane-A protocol)", () => {
    expect(transcriptPathOf(session())).toBeNull();
  });

  test("is null for a null or empty value", () => {
    expect(transcriptPathOf(withTranscriptPath(null))).toBeNull();
    expect(transcriptPathOf(withTranscriptPath(""))).toBeNull();
  });

  test("returns a present path", () => {
    expect(transcriptPathOf(withTranscriptPath("/tmp/t.jsonl"))).toBe("/tmp/t.jsonl");
  });
});

describe("buildSheetModel", () => {
  test("lists the five actions in order", () => {
    const model = buildSheetModel(session(), { title: "A session", clipboardAvailable: true, clearArmed: false });
    expect(model.title).toBe("A session");
    expect(model.items.map((item) => item.id)).toEqual(["open", "ack", "reveal", "copy", "clear"]);
    expect(model.items.map((item) => item.label)).toEqual([
      "Open",
      "Ack",
      "Reveal transcript",
      "Copy session ID",
      "Clear session",
    ]);
  });

  test("Reveal transcript is disabled without a transcript path, enabled with one", () => {
    const disabled = buildSheetModel(session(), { title: "t", clipboardAvailable: true, clearArmed: false });
    expect(disabled.items[2]?.enabled).toBe(false);
    const enabled = buildSheetModel(withTranscriptPath("/tmp/t.jsonl"), {
      title: "t",
      clipboardAvailable: true,
      clearArmed: false,
    });
    expect(enabled.items[2]?.enabled).toBe(true);
  });

  test("Copy session ID is disabled when the clipboard API is unavailable", () => {
    const model = buildSheetModel(session(), { title: "t", clipboardAvailable: false, clearArmed: false });
    expect(model.items[3]?.enabled).toBe(false);
  });

  test("an armed clear shows the confirm label and the confirming flag", () => {
    const model = buildSheetModel(session(), { title: "t", clipboardAvailable: true, clearArmed: true });
    expect(model.items[4]).toEqual({ id: "clear", label: "Confirm clear", enabled: true, confirming: true });
  });
});

describe("reduceSheetSelection", () => {
  test("the first clear tap arms without firing", () => {
    expect(reduceSheetSelection(false, "clear")).toEqual({ clearArmed: true, fire: false });
  });

  test("the second clear tap fires and disarms", () => {
    expect(reduceSheetSelection(true, "clear")).toEqual({ clearArmed: false, fire: true });
  });

  test("any other action fires immediately and resets the arm", () => {
    expect(reduceSheetSelection(true, "ack")).toEqual({ clearArmed: false, fire: true });
    expect(reduceSheetSelection(false, "open")).toEqual({ clearArmed: false, fire: true });
  });
});
