import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlacedCard } from "../app/src/board";
import {
  ageLineText,
  applyCardFrame,
  boardRenderSignature,
  CARD_MODEL_LABEL_MAX_CODE_POINTS,
  cardClassName,
  cardContentSignature,
  cardKey,
  cardViewModel,
  elapsedSince,
  planCardPatches,
  renderBoard,
  statusWord,
} from "../app/src/cards";
import type { ProjectedSession } from "../src/protocol";
import { descendants, FakeElement, hasClass, withFakeDocument } from "./support/fake-dom";

const session = (
  slot: number,
  overrides: Partial<ProjectedSession> & { openedAt?: string } = {},
): ProjectedSession & { openedAt?: string } => ({
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
  doneSince: null,
  pendingResults: 0,
  endedAt: null,
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

const placed = (
  overrides: Partial<PlacedCard> = {},
  sessionOverrides: Partial<ProjectedSession> & { openedAt?: string } = {},
): PlacedCard => {
  const projected = session(1, sessionOverrides);
  return {
    session: projected,
    label: "Label",
    subagent: false,
    parentProject: null,
    displayOnly: false,
    descendantBadge: projected.descendantCount,
    pendingResults: projected.pendingResults,
    degraded: false,
    indent: false,
    spine: "none",
    continuation: false,
    column: 0,
    row: 0,
    ...overrides,
  };
};

describe("card source hygiene", () => {
  test("contains no literal NUL bytes", () => {
    const source = readFileSync(join(import.meta.dir, "..", "app", "src", "cards.ts"));
    expect(source.includes(0x00)).toBe(false);
  });
});

describe("statusWord", () => {
  test("working cards headline the session age as open; the other states spell themselves", () => {
    expect(statusWord("working")).toBe("open");
    expect(statusWord("idle")).toBe("idle");
    expect(statusWord("waiting")).toBe("waiting");
    expect(statusWord("error")).toBe("error");
  });
});

describe("elapsedSince", () => {
  const NOW_MS = Date.parse("2026-08-19T00:10:00.000Z");

  test("formats compact elapsed labels across the unit boundaries", () => {
    expect(elapsedSince("2026-08-19T00:09:18.000Z", NOW_MS)).toBe("42s");
    expect(elapsedSince("2026-08-19T00:09:00.000Z", NOW_MS)).toBe("1m");
    expect(elapsedSince("2026-08-18T23:58:00.000Z", NOW_MS)).toBe("12m");
    expect(elapsedSince("2026-08-18T22:10:00.000Z", NOW_MS)).toBe("2h");
    expect(elapsedSince("2026-08-16T00:10:00.000Z", NOW_MS)).toBe("3d");
  });

  test("clamps a future stamp to 0s and returns null for a missing or unparseable one", () => {
    expect(elapsedSince("2026-08-20T00:00:00.000Z", NOW_MS)).toBe("0s");
    expect(elapsedSince(null, NOW_MS)).toBeNull();
    expect(elapsedSince("not a timestamp", NOW_MS)).toBeNull();
  });
});

describe("ageLineText", () => {
  const NOW_MS = Date.parse("2026-08-19T00:10:00.000Z");

  test("words the open fact and degrades to null without a usable stamp", () => {
    expect(ageLineText("2026-08-19T00:00:00.000Z", NOW_MS)).toBe("open 10m");
    expect(ageLineText(null, NOW_MS)).toBeNull();
    expect(ageLineText("not a timestamp", NOW_MS)).toBeNull();
  });
});

describe("cardViewModel", () => {
  const NOW_MS = Date.parse("2026-08-25T00:10:00.000Z");

  test("renders only safe activity categories and collapses legacy raw values", () => {
    expect(cardViewModel(placed({}, { activityLine: "Command" }), NOW_MS).activity).toBe("Command");
    expect(cardViewModel(placed({}, { activityLine: "Bash API_TOKEN=top-secret" }), NOW_MS).activity).toBe("Activity");
    expect(cardViewModel(placed({}, { activityLine: null }), NOW_MS).activity).toBeNull();
  });

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

  test("origin ring only for Paseo parents and roborev sessions; badge is the bare descendant count", () => {
    const paseoParent = cardViewModel(placed({}, { originKind: "paseo", descendantCount: 2 }), NOW_MS);
    expect(paseoParent.originRing).toBe("paseo");
    expect(paseoParent.badge).toBe(2);
    const paseoSub = cardViewModel(placed({ subagent: true }, { originKind: "paseo", originSubagent: true }), NOW_MS);
    expect(paseoSub.originRing).toBeNull();
    const roborev = cardViewModel(placed({}, { originKind: "roborev" }), NOW_MS);
    expect(roborev.originRing).toBe("roborev");
    const terminal = cardViewModel(placed({}, { originKind: "terminal" }), NOW_MS);
    expect(terminal.originRing).toBeNull();
  });

  test("degraded passes through to the model (the card's ! flag)", () => {
    expect(cardViewModel(placed({ degraded: true }), NOW_MS).degraded).toBe(true);
  });

  test("unread tracks the ledger stamp; a working card's bright corner is the session age", () => {
    const model = cardViewModel(
      placed(
        {},
        {
          unreadSince: "2026-08-25T00:05:00.000Z",
          status: "working",
          statusSince: "2026-08-25T00:08:00.000Z",
          openedAt: "2026-08-25T00:00:00.000Z",
        },
      ),
      NOW_MS,
    );
    expect(model.unread).toBe(true);
    expect(model.word).toBe("open");
    expect(model.timer).toBe("10m");
    expect(model.timerSince).toBe("2026-08-25T00:00:00.000Z");
    // The gap slot owns the working card's dim position; no open fact there.
    expect(model.age).toBeNull();
    expect(model.ageSince).toBeNull();
  });

  test("idle, waiting, and error corners pair their status age with a dim open fact", () => {
    for (const status of ["idle", "waiting", "error"] as const) {
      const model = cardViewModel(
        placed({}, { status, statusSince: "2026-08-25T00:08:00.000Z", openedAt: "2026-08-25T00:00:00.000Z" }),
        NOW_MS,
      );
      expect(model.word).toBe(status);
      expect(model.timer).toBe("2m");
      expect(model.timerSince).toBe("2026-08-25T00:08:00.000Z");
      expect(model.age).toBe("open 10m");
      expect(model.ageSince).toBe("2026-08-25T00:00:00.000Z");
    }
  });

  test("a legacy session without openedAt renders no open facts", () => {
    const working = cardViewModel(placed({}, { status: "working", statusSince: "2026-08-25T00:08:00.000Z" }), NOW_MS);
    expect(working.timer).toBeNull();
    expect(working.timerSince).toBeNull();
    const waiting = cardViewModel(placed({}, { status: "waiting", statusSince: "2026-08-25T00:08:00.000Z" }), NOW_MS);
    expect(waiting.timer).toBe("2m");
    expect(waiting.age).toBeNull();
    expect(waiting.ageSince).toBeNull();
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
      word: "waiting",
      timer: "2m",
      unread: false,
      badge: null,
    });
    expect(cardClassName(model)).toContain("display-only");
    expect(cardViewModel(placed({ displayOnly: true, descendantBadge: 3 }), NOW_MS).badge).toBeNull();
  });

  test("fallback cards retain the legacy descendant badge", () => {
    expect(cardViewModel(placed({ descendantBadge: 3 }), NOW_MS).badge).toBe(3);
  });

  test("an ended card reads ended in the corner word and carries the ended class", () => {
    const model = cardViewModel(
      placed({}, { status: "idle", endedAt: "2026-08-25T00:01:00.000Z", statusSince: "2026-08-25T00:00:00.000Z" }),
      NOW_MS,
    );
    expect(model.ended).toBe(true);
    expect(model.word).toBe("ended");
    expect(cardClassName(model).split(" ")).toContain("ended");
  });

  test("a live card is not ended and keeps its status word", () => {
    const model = cardViewModel(placed({}, { status: "idle" }), NOW_MS);
    expect(model.ended).toBe(false);
    expect(model.word).toBe("idle");
  });

  test("the badge shows pending results over the descendant count", () => {
    const pending = cardViewModel(
      placed({ pendingResults: 2, descendantBadge: 3 }, { originKind: "paseo", originRef: "agent-0" }),
      NOW_MS,
    );
    expect(pending.badge).toBe(2);
    const none = cardViewModel(placed({ pendingResults: 0, descendantBadge: 3 }), NOW_MS);
    expect(none.badge).toBe(3);
    const displayOnly = cardViewModel(placed({ pendingResults: 2, displayOnly: true }), NOW_MS);
    expect(displayOnly.badge).toBeNull();
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

const OPENED_AT = "2026-08-25T00:00:00.000Z";
const STATUS_SINCE = "2026-08-25T00:08:00.000Z";

const pageWith = (status: ProjectedSession["status"], overrides: { openedAt?: string } = { openedAt: OPENED_AT }) => ({
  cards: [placed({}, { status, statusSince: STATUS_SINCE, ...overrides })],
});

const statusRowOf = (root: FakeElement): FakeElement | undefined =>
  descendants(root).find((node) => hasClass(node, "card-status"));

const cornerClasses = (row: FakeElement | undefined): string[] => (row?.children ?? []).map((node) => node.className);

describe("status corner anatomy", () => {
  test("a working card reads gap slot, open word, session-age timer, dot last", () => {
    withFakeDocument((root) => {
      renderBoard(root as unknown as HTMLElement, pageWith("working"), false);
      const row = statusRowOf(root);
      expect(cornerClasses(row)).toEqual(["cardgap", "status-word", "cardtimer", "status-dot"]);
      const [gap, word, timer] = row?.children ?? [];
      expect(gap?.textContent).toBe("");
      expect(word?.textContent).toBe("open");
      expect(timer?.dataset["since"]).toBe(OPENED_AT);
    });
  });

  test("idle, waiting, and error cards read open fact, status word, status-age timer, dot last", () => {
    for (const status of ["idle", "waiting", "error"] as const) {
      withFakeDocument((root) => {
        renderBoard(root as unknown as HTMLElement, pageWith(status), false);
        const row = statusRowOf(root);
        expect(cornerClasses(row)).toEqual(["cardage", "status-word", "cardtimer", "status-dot"]);
        const [age, word, timer] = row?.children ?? [];
        // renderBoard stamps the initial text from the wall clock; the exact
        // number is the 1s ticker's business, the grammar and anchor are ours.
        expect(age?.textContent).toMatch(/^open \d+[smhd]$/u);
        expect(age?.dataset["since"]).toBe(OPENED_AT);
        expect(word?.textContent).toBe(status);
        expect(timer?.dataset["since"]).toBe(STATUS_SINCE);
      });
    }
  });

  test("a legacy working card without openedAt degrades to the gap slot and dot alone", () => {
    withFakeDocument((root) => {
      renderBoard(root as unknown as HTMLElement, pageWith("working", {}), false);
      expect(cornerClasses(statusRowOf(root))).toEqual(["cardgap", "status-dot"]);
    });
  });

  test("legacy waiting and error cards keep their worded status age without an open fact", () => {
    for (const status of ["waiting", "error"] as const) {
      withFakeDocument((root) => {
        renderBoard(root as unknown as HTMLElement, pageWith(status, {}), false);
        expect(cornerClasses(statusRowOf(root))).toEqual(["status-word", "cardtimer", "status-dot"]);
      });
    }
  });

  test("a legacy idle card without openedAt still spells its status age", () => {
    withFakeDocument((root) => {
      renderBoard(root as unknown as HTMLElement, pageWith("idle", {}), false);
      expect(cornerClasses(statusRowOf(root))).toEqual(["status-word", "cardtimer", "status-dot"]);
    });
  });
});

describe("head origin and lineage pills", () => {
  const headClasses = (root: FakeElement): string[] =>
    (descendants(root).find((node) => hasClass(node, "card-head"))?.children ?? []).map(
      (node) => node.className.split(/\s+/u)[0] ?? "",
    );

  test("a paseo parent's chip wears the containment ring; no pill or disc anywhere", () => {
    withFakeDocument((root) => {
      renderBoard(root as unknown as HTMLElement, { cards: [placed({}, { originKind: "paseo" })] }, false);
      expect(headClasses(root)).toEqual(["chip", "card-title"]);
      const chip = descendants(root).find((node) => hasClass(node, "chip"));
      expect(chip !== undefined && hasClass(chip, "paseo")).toBe(true);
      expect(descendants(root).some((node) => hasClass(node, "paseo-pill"))).toBe(false);
      expect(descendants(root).some((node) => hasClass(node, "origin-disc"))).toBe(false);
    });
  });

  test("a roborev session's chip wears the containment ring in the roborev hue", () => {
    withFakeDocument((root) => {
      renderBoard(root as unknown as HTMLElement, { cards: [placed({}, { originKind: "roborev" })] }, false);
      const chip = descendants(root).find((node) => hasClass(node, "chip"));
      expect(chip !== undefined && hasClass(chip, "roborev")).toBe(true);
      expect(chip !== undefined && hasClass(chip, "paseo")).toBe(false);
    });
  });

  test("a terminal session's chip has no ring and no pill", () => {
    withFakeDocument((root) => {
      renderBoard(root as unknown as HTMLElement, { cards: [placed()] }, false);
      expect(headClasses(root)).toEqual(["chip", "card-title"]);
      const chip = descendants(root).find((node) => hasClass(node, "chip"));
      expect(chip !== undefined && hasClass(chip, "paseo")).toBe(false);
    });
  });

  test("a grouped sub drops the sub pill — the indent and spine already say it", () => {
    withFakeDocument((root) => {
      renderBoard(
        root as unknown as HTMLElement,
        { cards: [placed({ subagent: true, indent: true, spine: "end" })] },
        false,
      );
      expect(headClasses(root)).toEqual(["chip", "card-title"]);
    });
  });

  test("an orphan sub keeps the sub pill — no indent or spine identifies it", () => {
    withFakeDocument((root) => {
      renderBoard(root as unknown as HTMLElement, { cards: [placed({ subagent: true })] }, false);
      expect(headClasses(root)).toEqual(["chip", "sub-pill", "card-title"]);
      expect(descendants(root).find((node) => hasClass(node, "sub-pill"))?.textContent).toBe("sub");
    });
  });
});
