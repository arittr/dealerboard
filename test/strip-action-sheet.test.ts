import { describe, expect, test } from "bun:test";
import {
  advanceSheetGeneration,
  beginSheetAction,
  buildSheetModel,
  initialSheetActionState,
  reduceSheetSelection,
  settleSheetAction,
  transcriptPathOf,
} from "../app/src/action-sheet";
import type { ProjectedSession } from "../src/protocol";

const session = (overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: "session-1",
  status: "idle",
  title: "A session",
  project: "dealerboard",
  descendantCount: 0,
  logicalSlot: 1,
  ghosttyTerminalId: null,
  model: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  unreadSince: null,
  doneSince: null,
  statusSince: null,
  activityLine: null,
  transcriptPath: null,
  originParentRef: null,
  lastEventAt: null,
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
    // A genuinely omitted key — the pre-Lane-A wire shape — not a null value.
    const legacy: Record<string, unknown> = { ...session() };
    delete legacy["transcriptPath"];
    expect(transcriptPathOf(legacy as ProjectedSession)).toBeNull();
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

describe("sheet action state", () => {
  const pendingClear = () =>
    beginSheetAction(beginSheetAction(initialSheetActionState(), "clear").state, "clear").state;

  test("the first clear tap arms without firing", () => {
    expect(beginSheetAction(initialSheetActionState(), "clear")).toEqual({
      state: { generation: 0, clearArmed: true, pendingAction: null },
      fire: false,
    });
  });

  test("the second clear tap fires and goes pending", () => {
    const armed = beginSheetAction(initialSheetActionState(), "clear").state;
    const begin = beginSheetAction(armed, "clear");
    expect(begin.fire).toBe(true);
    expect(begin.state).toEqual({ generation: 0, clearArmed: false, pendingAction: "clear" });
  });

  test("a tap while an action is pending is blocked", () => {
    const pending = pendingClear();
    expect(beginSheetAction(pending, "ack")).toEqual({ state: pending, fire: false });
  });

  test("a successful settlement dismisses and ends the sheet instance", () => {
    const outcome = settleSheetAction({ generation: 3, clearArmed: false, pendingAction: "ack" }, 3, true);
    expect(outcome.dismissed).toBe(true);
    expect(outcome.reopen).toBe(false);
    expect(outcome.state).toEqual({ generation: 4, clearArmed: false, pendingAction: null });
  });

  test("a failed settlement reopens with the pending cleared and the arm reset", () => {
    const pending = pendingClear();
    const outcome = settleSheetAction(pending, pending.generation, false);
    expect(outcome.dismissed).toBe(false);
    expect(outcome.reopen).toBe(true);
    expect(outcome.state).toEqual({ generation: 0, clearArmed: false, pendingAction: null });
  });

  test("a settlement after user dismissal is a no-op — dismissal wins", () => {
    const pending = pendingClear();
    const dismissed = advanceSheetGeneration(pending);
    expect(settleSheetAction(dismissed, pending.generation, false)).toEqual({
      state: dismissed,
      dismissed: false,
      reopen: false,
    });
    expect(settleSheetAction(dismissed, pending.generation, true)).toEqual({
      state: dismissed,
      dismissed: false,
      reopen: false,
    });
  });

  test("a stale settlement never touches a newer sheet instance", () => {
    const stale = beginSheetAction(initialSheetActionState(), "ack").state;
    // Dismissed, a new sheet opened, and a new action went pending at a
    // later generation: the stale settlement must not dismiss it.
    const current = beginSheetAction(advanceSheetGeneration(stale), "ack").state;
    expect(settleSheetAction(current, stale.generation, true)).toEqual({
      state: current,
      dismissed: false,
      reopen: false,
    });
  });
});

describe("buildSheetModel pending state", () => {
  test("a pending action disables every item without relabeling", () => {
    const model = buildSheetModel(withTranscriptPath("/tmp/t.jsonl"), {
      title: "t",
      clipboardAvailable: true,
      clearArmed: false,
      pendingAction: "clear",
    });
    expect(model.items.every((item) => item.enabled)).toBe(false);
    expect(model.items.map((item) => item.label)).toContain("Clear session");
  });
});

describe("sheet error state", () => {
  test("carries an inline error message into the model", () => {
    const model = buildSheetModel(session(), {
      title: "t",
      clipboardAvailable: true,
      clearArmed: false,
      error: "Clear failed",
    });
    expect(model.error).toBe("Clear failed");
  });

  test("normalizes an absent error to null", () => {
    const model = buildSheetModel(session(), { title: "t", clipboardAvailable: true, clearArmed: false });
    expect(model.error).toBeNull();
  });
});
