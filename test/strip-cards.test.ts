import { describe, expect, test } from "bun:test";
import type { PlacedCard } from "../app/src/board";
import {
  boardRenderSignature,
  CARD_MODEL_LABEL_MAX_CODE_POINTS,
  cardClassName,
  cardContentSignature,
  cardKey,
  cardViewModel,
  planCardPatches,
  statusLineText,
  WASH_CYCLE_MS,
  washAnimationDelay,
} from "../app/src/cards";
import type { ProjectedSession } from "../src/protocol";

const session = (slot: number, overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: `s${slot}`,
  project: null,
  title: null,
  model: null,
  status: "working",
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
});

const placed = (overrides: Partial<PlacedCard> = {}, sessionOverrides: Partial<ProjectedSession> = {}): PlacedCard => {
  const projected = session(1, sessionOverrides);
  return {
    session: projected,
    label: "Label",
    subagent: false,
    parentProject: null,
    displayOnly: false,
    descendantBadge: projected.descendantCount,
    degraded: false,
    indent: false,
    spine: "none",
    column: 0,
    row: 0,
    ...overrides,
  };
};

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
    // renderBoard recreates every card on any data change, so the delay has
    // to carry the wash forward; otherwise each re-render snaps it to the dim
    // end.
    const atCreate = parseDelay(washAnimationDelay("s1", NOW_MS));
    for (const elapsed of [0, 250, 3_100, 7_999, 8_000, 19_400]) {
      const atRerender = parseDelay(washAnimationDelay("s1", NOW_MS + elapsed));
      const drift = (((atCreate + elapsed - atRerender) % WASH_CYCLE_MS) + WASH_CYCLE_MS) % WASH_CYCLE_MS;
      // One millisecond of slack for the delay string's millisecond precision.
      expect(Math.min(drift, WASH_CYCLE_MS - drift)).toBeLessThanOrEqual(1);
    }
  });
});

describe("cardViewModel", () => {
  const NOW_MS = Date.parse("2026-08-25T00:10:00.000Z");

  test("real title is not a fallback; project and long model id survive to 24 code points", () => {
    const model = cardViewModel(
      placed({}, { title: "Fix the thing", project: "repo", model: "qwen3.8-max-preview" }),
      NOW_MS,
    );
    expect(model.fallbackTitle).toBe(false);
    expect(model.modelLabel).toBe("qwen3.8-max-preview");
    expect(model.project).toBe("repo");
  });

  test("null title marks the fallback label (project or provider+id chain comes in via label)", () => {
    expect(cardViewModel(placed({ label: "repo" }, { title: null }), NOW_MS).fallbackTitle).toBe(true);
    expect(cardViewModel(placed({}, { title: "" }), NOW_MS).fallbackTitle).toBe(true);
  });

  test("a grouped sub suppresses a project equal to its parent's; a differing one stays", () => {
    const same = cardViewModel(
      placed({ subagent: true, indent: true, parentProject: "repo" }, { project: "repo" }),
      NOW_MS,
    );
    expect(same.project).toBeNull();
    const differs = cardViewModel(
      placed({ subagent: true, indent: true, parentProject: "repo" }, { project: "other" }),
      NOW_MS,
    );
    expect(differs.project).toBe("other");
  });

  test("model label caps at 24 code points with an ellipsis", () => {
    const long = "a".repeat(30);
    const label = cardViewModel(placed({}, { model: long }), NOW_MS).modelLabel;
    expect(label).toHaveLength(CARD_MODEL_LABEL_MAX_CODE_POINTS);
    expect(label?.endsWith("…")).toBe(true);
  });

  test("origin disc only for Paseo parents; badge is the bare descendant count", () => {
    const paseoParent = cardViewModel(placed({}, { originKind: "paseo", descendantCount: 2 }), NOW_MS);
    expect(paseoParent.originDisc).toBe(true);
    expect(paseoParent.badge).toBe(2);
    const paseoSub = cardViewModel(placed({ subagent: true }, { originKind: "paseo", originSubagent: true }), NOW_MS);
    expect(paseoSub.originDisc).toBe(false);
  });

  test("degraded passes through to the model (the card's ! flag)", () => {
    expect(cardViewModel(placed({ degraded: true }), NOW_MS).degraded).toBe(true);
  });

  test("unread tracks the ledger stamp; timer derives from statusSince", () => {
    const model = cardViewModel(
      placed(
        {},
        { unreadSince: "2026-08-25T00:05:00.000Z", status: "working", statusSince: "2026-08-25T00:08:00.000Z" },
      ),
      NOW_MS,
    );
    expect(model.unread).toBe(true);
    expect(model.timer).toBe("working 2m");
  });

  test("a graph-backed display-only child has no unread dot or descendant badge", () => {
    const model = cardViewModel(
      placed(
        { displayOnly: true, descendantBadge: null, subagent: true, indent: true },
        {
          model: "gpt-5.6-terra",
          status: "waiting",
          statusSince: "2026-08-25T00:08:00.000Z",
          unreadSince: "2026-08-25T00:09:00.000Z",
          descendantCount: 9,
        },
      ),
      NOW_MS,
    );
    expect(model).toMatchObject({
      displayOnly: true,
      modelLabel: "5.6-terra",
      status: "waiting",
      timer: "waiting 2m",
      unread: false,
      badge: null,
    });
    expect(cardClassName(model)).toContain("display-only");
    expect(cardViewModel(placed({ displayOnly: true, descendantBadge: 3 }), NOW_MS).badge).toBeNull();
  });

  test("fallback cards retain the legacy descendant badge", () => {
    expect(cardViewModel(placed({ descendantBadge: 3 }), NOW_MS).badge).toBe(3);
  });
});

describe("boardRenderSignature", () => {
  test("an empty page distinguishes healthy from degraded (the OFFLINE re-render)", () => {
    // The regression the review caught: an empty page serializes its cards to
    // "[]" either way, so the page-level degraded flag must ride the signature
    // or a healthy↔OFFLINE flip on an empty board skips the re-render.
    const empty = { cards: [] };
    expect(boardRenderSignature(empty, false)).not.toBe(boardRenderSignature(empty, true));
    expect(boardRenderSignature(empty, false)).toBe(boardRenderSignature(empty, false));
  });

  test("a non-empty page flips on the cards' own degraded bits and placement", () => {
    const healthy = boardRenderSignature({ cards: [placed()] }, false);
    expect(boardRenderSignature({ cards: [placed({ degraded: true })] }, false)).not.toBe(healthy);
    expect(boardRenderSignature({ cards: [placed({ column: 1, row: 3 })] }, false)).not.toBe(healthy);
    expect(boardRenderSignature({ cards: [placed()] }, true)).not.toBe(healthy);
  });
});

describe("card reconciliation plan", () => {
  test("the content signature ignores page position, so a moved card reuses its node", () => {
    expect(cardContentSignature(placed({ column: 1, row: 5 }))).toBe(
      cardContentSignature(placed({ column: 0, row: 2 })),
    );
    expect(cardContentSignature(placed({}, { activityLine: "Read a.ts" }))).not.toBe(cardContentSignature(placed()));
  });

  test("an activity-line change replaces only that card; every other card reuses", () => {
    const a = placed({}, { sessionId: "a", activityLine: "Bash ls" });
    const b = placed({}, { sessionId: "b" });
    const previous = new Map([
      [cardKey(a), cardContentSignature(a)],
      [cardKey(b), cardContentSignature(b)],
    ]);
    const aChanged = placed({}, { sessionId: "a", activityLine: "Read foo.ts" });
    expect(planCardPatches(previous, [aChanged, b]).map((patch) => patch.action)).toEqual(["replace", "reuse"]);
  });

  test("unknown keys create; a degraded flip replaces; position-only moves reuse", () => {
    const a = placed({}, { sessionId: "a" });
    const previous = new Map([[cardKey(a), cardContentSignature(a)]]);
    const plan = planCardPatches(previous, [
      placed({ degraded: true }, { sessionId: "a" }),
      placed({}, { sessionId: "b" }),
    ]);
    expect(plan.map((patch) => patch.action)).toEqual(["replace", "create"]);
    expect(planCardPatches(previous, [placed({ column: 1, row: 4 }, { sessionId: "a" })])[0]?.action).toBe("reuse");
  });
});
