import { describe, expect, test } from "bun:test";
import type { PlacedCard } from "../app/src/board";
import { capturePendingPress, resolvePendingPress } from "../app/src/gesture-target";
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
  continuation: false,
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

describe("resolvePendingPress", () => {
  const point = { x: 10, y: 20 };
  const other = (overrides: Partial<ProjectedSession> = {}): PlacedCard =>
    card({ provider: "codex", sessionId: "session-2", ...overrides });

  test("a clean tap settles against the captured identity and watermark, not the release-time index", () => {
    // Pointer-down on the only card, showing at(5). A snapshot ingested
    // mid-stroke inserts a card ahead of it and lands a newer result at(9):
    // the click must still view THE PRESSED card, consuming only at(5).
    const pending = capturePendingPress([card({ unreadSince: "2026-08-26T05:00:00.000Z" })], 0, point);
    expect(pending).not.toBeNull();
    const afterIngest = [other(), card({ unreadSince: "2026-08-26T05:09:00.000Z" })];
    const settled = resolvePendingPress(afterIngest, pending!);
    expect(settled?.index).toBe(1);
    expect(settled?.card.session.sessionId).toBe("session-1");
    expect(settled?.card.session.unreadSince).toBe("2026-08-26T05:09:00.000Z"); // routing sees the current facts
    expect(settled?.watermark).toEqual({ unreadSince: "2026-08-26T05:00:00.000Z" }); // the view consumes only what was seen
  });

  test("the long-press sheet carries the pointer-down watermark, not the sheet-open stamp", () => {
    // The hold lasts ~500ms; a result that lands during it must survive the
    // sheet's Dismiss (and Open's view) — both settle on the captured stamp.
    const pending = capturePendingPress([card({ unreadSince: "2026-08-26T05:00:00.000Z" })], 0, point);
    const atSheetOpen = [card({ unreadSince: "2026-08-26T05:09:00.000Z" })];
    expect(resolvePendingPress(atSheetOpen, pending!)?.watermark).toEqual({ unreadSince: "2026-08-26T05:00:00.000Z" });
  });

  test("a pressed card that left the grid cancels: never retarget the card that took its index", () => {
    const pending = capturePendingPress([card(), other()], 0, point);
    expect(resolvePendingPress([other()], pending!)).toBeNull();
  });

  test("a pressed card that became display-only cancels", () => {
    const pending = capturePendingPress([card()], 0, point);
    expect(resolvePendingPress([card({}, { displayOnly: true })], pending!)).toBeNull();
  });
});
