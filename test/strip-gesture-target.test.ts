import { describe, expect, test } from "bun:test";
import type { PlacedCard } from "../app/src/board";
import { capturePendingPress } from "../app/src/gesture-target";
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
  pendingResults: 0,
  endedAt: null,
  statusSince: null,
  activityLine: null,
  transcriptPath: null,
  originParentRef: null,
  lastEventAt: null,
  ...overrides,
});

const card = (overrides: Partial<ProjectedSession> = {}, placed: Partial<PlacedCard> = {}): PlacedCard => ({
  session: session(overrides),
  label: "Label",
  subagent: false,
  parentProject: null,
  displayOnly: false,
  descendantBadge: 0,
  pendingResults: 0,
  degraded: false,
  indent: false,
  spine: "none",
  column: 0,
  row: 0,
  ...placed,
});

describe("capturePendingPress", () => {
  const point = { x: 10, y: 20 };

  test("captures the pressed card's identity and its unread stamp at pointer-down", () => {
    const pending = capturePendingPress([card({ unreadSince: "2026-08-26T05:00:00.000Z" })], 0, point);
    expect(pending).toEqual({
      identity: { provider: "claude", sessionId: "session-1" },
      point,
      watermark: { unreadSince: "2026-08-26T05:00:00.000Z" },
    });
  });

  test("a card with no badge captures a null-stamp watermark — still causal, never the unconditional shape", () => {
    expect(capturePendingPress([card()], 0, point)?.watermark).toEqual({ unreadSince: null });
  });

  test("a snapshot ingested mid-stroke cannot move the captured watermark", () => {
    // Pointer-down sees the at(5) badge; before release a newer snapshot
    // shows at(9). The pending press still carries at(5) — the flick
    // consumes only the result the user saw when the gesture started.
    const pending = capturePendingPress([card({ unreadSince: "2026-08-26T05:00:00.000Z" })], 0, point);
    const afterIngest = [card({ unreadSince: "2026-08-26T05:09:00.000Z" })];
    expect(pending?.watermark).toEqual({ unreadSince: "2026-08-26T05:00:00.000Z" });
    expect(afterIngest[0]?.session.unreadSince).toBe("2026-08-26T05:09:00.000Z");
  });

  test("a display-only card captures nothing", () => {
    expect(capturePendingPress([card({}, { displayOnly: true })], 0, point)).toBeNull();
  });
});
