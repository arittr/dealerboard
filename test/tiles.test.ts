import { describe, expect, test } from "bun:test";
import {
  statusLineText,
  stripGridLayout,
  stripTileExtras,
  visibleStripKeys,
  WASH_CYCLE_MS,
  washAnimationDelay,
} from "../app/src/tiles";
import type { KeyModel } from "../src/plugin/layout";
import type { ProjectedSession } from "../src/protocol";

const session = (slot: number, overrides: Partial<ProjectedSession> = {}): Extract<KeyModel, { kind: "session" }> => ({
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
    unreadSince: null,
    statusSince: null,
    activityLine: null,
    transcriptPath: null,
    originParentRef: null,
    ghosttyTerminalId: null,
    descendantCount: 0,
    logicalSlot: slot,
    ...overrides,
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

describe("statusLineText", () => {
  const NOW_MS = Date.parse("2026-08-19T00:10:00.000Z");

  test("formats compact elapsed labels across the unit boundaries", () => {
    expect(statusLineText("working", "2026-08-19T00:09:18.000Z", NOW_MS)).toBe("working 42s");
    expect(statusLineText("working", "2026-08-19T00:09:00.000Z", NOW_MS)).toBe("working 1m");
    expect(statusLineText("waiting", "2026-08-18T23:58:00.000Z", NOW_MS)).toBe("waiting 12m");
    expect(statusLineText("error", "2026-08-18T22:10:00.000Z", NOW_MS)).toBe("error 2h");
    expect(statusLineText("idle", "2026-08-16T00:10:00.000Z", NOW_MS)).toBe("idle 3d");
  });

  test("clamps a future stamp to 0s and returns null for a missing or unparseable one", () => {
    expect(statusLineText("working", "2026-08-20T00:00:00.000Z", NOW_MS)).toBe("working 0s");
    expect(statusLineText("working", null, NOW_MS)).toBeNull();
    expect(statusLineText("working", "not a timestamp", NOW_MS)).toBeNull();
  });
});

describe("stripTileExtras", () => {
  const NOW_MS = Date.parse("2026-08-19T00:10:00.000Z");

  test("derives the extras from the session's data-surface fields", () => {
    const withNews = session(1, {
      unreadSince: "2026-08-19T00:05:00.000Z",
      status: "working",
      statusSince: "2026-08-19T00:08:00.000Z",
      activityLine: "Bash git status",
    });
    expect(stripTileExtras(withNews.session, NOW_MS)).toEqual({
      unread: true,
      statusLine: "working 2m",
      activityLine: "Bash git status",
    });
  });

  test("a session without the fields shows no extras (old-daemon snapshot)", () => {
    expect(stripTileExtras(session(2).session, NOW_MS)).toEqual({
      unread: false,
      statusLine: null,
      activityLine: null,
    });
  });

  test("the unread flag tracks the ledger stamp, not the status — an acked error tile drops it", () => {
    const ackedError = session(3, { status: "error", unreadSince: null });
    expect(stripTileExtras(ackedError.session, NOW_MS).unread).toBe(false);
    const unreadError = session(4, { status: "error", unreadSince: "2026-08-19T00:01:00.000Z" });
    expect(stripTileExtras(unreadError.session, NOW_MS).unread).toBe(true);
  });
});

describe("washAnimationDelay", () => {
  const NOW_MS = Date.parse("2026-08-19T00:10:00.000Z");

  const parseDelay = (delay: string): number => {
    expect(delay).toMatch(/^-\d+\.\d{3}s$/);
    return Math.round(Number.parseFloat(delay.slice(1, -1)) * 1000);
  };

  test("seats each session at its own point in the wash cycle", () => {
    const phases = ["s1", "s2", "s3", "s4"].map((id) => parseDelay(washAnimationDelay(id, NOW_MS)));
    expect(new Set(phases).size).toBe(phases.length);
    for (const phase of phases) {
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(WASH_CYCLE_MS);
    }
  });

  test("a re-rendered tile resumes the phase it was already showing", () => {
    // renderTiles recreates every tile on any data change, so the delay has to
    // carry the wash forward; otherwise each re-render snaps it to the dim end.
    const atCreate = parseDelay(washAnimationDelay("s1", NOW_MS));
    for (const elapsed of [0, 250, 3_100, 7_999, 8_000, 19_400]) {
      const atRerender = parseDelay(washAnimationDelay("s1", NOW_MS + elapsed));
      const drift = (((atCreate + elapsed - atRerender) % WASH_CYCLE_MS) + WASH_CYCLE_MS) % WASH_CYCLE_MS;
      // One millisecond of slack for the delay string's millisecond precision.
      expect(Math.min(drift, WASH_CYCLE_MS - drift)).toBeLessThanOrEqual(1);
    }
  });
});
