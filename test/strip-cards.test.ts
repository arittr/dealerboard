import { describe, expect, test } from "bun:test";
import type { PlacedCard } from "../app/src/board";
import {
  applyCardFrame,
  boardRenderSignature,
  CARD_MODEL_LABEL_MAX_CODE_POINTS,
  cardContentSignature,
  cardKey,
  cardViewModel,
  planCardPatches,
  statusLineText,
} from "../app/src/cards";
import type { ProjectedSession } from "../src/protocol";
import { FakeElement } from "./support/fake-dom";

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
  lastEventAt: null,
  ...overrides,
});

const placed = (overrides: Partial<PlacedCard> = {}, sessionOverrides: Partial<ProjectedSession> = {}): PlacedCard => ({
  session: session(1, sessionOverrides),
  label: "Label",
  subagent: false,
  parentProject: null,
  degraded: false,
  indent: false,
  spine: "none",
  column: 0,
  row: 0,
  ...overrides,
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

describe("cardKey", () => {
  test("joins provider and session id with a NUL separator that cannot appear in either", () => {
    expect(cardKey(placed({}, { provider: "claude", sessionId: "s1" }))).toBe("claude\u0000s1");
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

describe("liveness reconciliation", () => {
  test("a changed lastEventAt alone reuses the DOM node", () => {
    const before = placed({}, { lastEventAt: "2026-08-25T00:00:01.000Z" });
    const after = placed({}, { lastEventAt: "2026-08-25T00:00:09.000Z" });
    expect(cardContentSignature(before)).toBe(cardContentSignature(after));
    const previous = new Map([[cardKey(before), cardContentSignature(before)]]);
    expect(planCardPatches(previous, [after])[0]?.action).toBe("reuse");
  });

  test("applyCardFrame writes the stamp, position, and index on every pass", () => {
    const element = new FakeElement("div") as unknown as HTMLElement;
    applyCardFrame(element, placed({ column: 2, row: 1 }, { lastEventAt: "2026-08-25T00:00:01.000Z" }), 5);
    expect(element.dataset["lastEvent"]).toBe("2026-08-25T00:00:01.000Z");
    expect(element.dataset["cardIndex"]).toBe("5");
    expect(element.style.gridColumn).toBe("3");
    expect(element.style.gridRow).toBe("2");
    applyCardFrame(element, placed({ column: 2, row: 1 }, { lastEventAt: null }), 5);
    expect(element.dataset["lastEvent"]).toBe("");
  });
});
