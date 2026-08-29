import { describe, expect, test } from "bun:test";
import type { BoardPage, PlacedCard } from "../app/src/board";
import {
  indicatorsRenderSignature,
  type PipModel,
  peekModel,
  pipColumnModel,
  renderPeekBand,
  renderPips,
  renderReturnBand,
  returnSliverModel,
  type SliverModel,
} from "../app/src/indicators";
import type { ProjectedSession } from "../src/protocol";
import { descendants, hasClass, renderedText, withFakeDocument } from "./support/fake-dom";

const UNREAD = "2026-08-27T00:00:00.000Z";

const session = (id: string, overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: id,
  project: null,
  title: id,
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
  logicalSlot: 1,
  lastEventAt: null,
  ...overrides,
});

const card = (
  column: number,
  row: number,
  overrides: Partial<PlacedCard> = {},
  sessionOverrides: Partial<ProjectedSession> = {},
): PlacedCard => ({
  session: session(`s${column}-${row}`, sessionOverrides),
  label: "t",
  subagent: false,
  parentProject: null,
  displayOnly: false,
  descendantBadge: 0,
  pendingResults: 0,
  degraded: false,
  indent: false,
  spine: "none",
  continuation: false,
  column,
  row,
  ...overrides,
});

const page = (...cards: PlacedCard[]): BoardPage => ({ cards });

describe("returnSliverModel", () => {
  test("shows the previous page's rightmost occupied column, row-aligned; absent on page 1", () => {
    const pages = [
      page(card(0, 0), card(1, 0, {}, { status: "waiting" }), card(1, 2, { subagent: true })),
      page(card(0, 0)),
    ];
    expect(returnSliverModel(pages, 1)).toEqual([
      { row: 0, status: "waiting", sub: false, unread: false },
      { row: 2, status: "working", sub: true, unread: false },
    ]);
    expect(returnSliverModel(pages, 0)).toEqual([]);
  });
});

describe("peekModel", () => {
  test("shows the next page's leftmost column with the cards' own unread bits; absent on the last page", () => {
    const pages = [
      page(card(0, 0)),
      page(
        card(0, 0, {}, { unreadSince: UNREAD }),
        card(0, 1, { displayOnly: true }, { unreadSince: UNREAD }),
        card(1, 0, {}, { status: "error" }),
      ),
    ];
    expect(peekModel(pages, 0)).toEqual([
      { row: 0, status: "working", sub: false, unread: true },
      { row: 1, status: "working", sub: false, unread: false },
    ]);
    expect(peekModel(pages, 1)).toEqual([]);
  });

  test("a sparse next page with no column-0 cards peeks its leftmost occupied column", () => {
    const pages = [
      page(card(0, 0)),
      page(card(1, 3), card(1, 0, { subagent: true }, { unreadSince: UNREAD, status: "waiting" })),
    ];
    expect(peekModel(pages, 0)).toEqual([
      { row: 0, status: "waiting", sub: true, unread: true },
      { row: 3, status: "working", sub: false, unread: false },
    ]);
  });
});

describe("pipColumnModel", () => {
  test("one pip per page, current clean, amber beats blue, hidden with one page", () => {
    const pages = [
      page(card(0, 0, {}, { unreadSince: UNREAD })),
      page(card(0, 0, {}, { unreadSince: UNREAD, status: "working" })),
      page(card(0, 0, {}, { status: "working" })),
      page(card(0, 0, {}, { status: "idle" })),
    ];
    expect(pipColumnModel(pages, 0)).toEqual([
      { current: true, dot: null },
      { current: false, dot: "unread" },
      { current: false, dot: "working" },
      { current: false, dot: null },
    ]);
    expect(pipColumnModel([page(card(0, 0))], 0)).toEqual([]);
  });

  test("display-only cards contribute no unread to a pip", () => {
    const pages = [page(card(0, 0)), page(card(0, 0, { displayOnly: true }, { unreadSince: UNREAD, status: "idle" }))];
    expect(pipColumnModel(pages, 0)[1]).toEqual({ current: false, dot: null });
  });
});

describe("band renderers", () => {
  const model: SliverModel[] = [
    { row: 1, status: "waiting", sub: false, unread: true },
    { row: 4, status: "working", sub: true, unread: false },
  ];

  test("row-aligned sliver blocks: status attr, sub class, dot only in the peek, no text, no card routing", () => {
    withFakeDocument((root) => {
      renderPeekBand(root as unknown as HTMLElement, model);
      expect(root.dataset["present"]).toBe("true");
      expect(root.children.map((s) => [s.dataset["status"], s.style["gridRow"], hasClass(s, "sub")])).toEqual([
        ["waiting", "2", false],
        ["working", "5", true],
      ]);
      expect(root.children[0]?.children.map((node) => node.className)).toEqual(["sliver-dot"]);
      expect(root.children[1]?.children).toHaveLength(0);
      expect(descendants(root).every((node) => node.dataset["cardIndex"] === undefined)).toBe(true);
      expect(renderedText(root).trim()).toBe("");
    });
    withFakeDocument((root) => {
      renderReturnBand(root as unknown as HTMLElement, model);
      expect(descendants(root).some((node) => hasClass(node, "sliver-dot"))).toBe(false);
    });
    withFakeDocument((root) => {
      renderPeekBand(root as unknown as HTMLElement, []);
      expect(root.dataset["present"]).toBe("false");
      expect(root.children).toHaveLength(0);
    });
  });

  test("pips are tap targets: current enlarged pip clean, minis by kind, taps jump by index", () => {
    const jumps: number[] = [];
    const pips: PipModel[] = [
      { current: false, dot: "unread" },
      { current: true, dot: null },
      { current: false, dot: "working" },
    ];
    withFakeDocument((root) => {
      renderPips(root as unknown as HTMLElement, pips, { onJumpToPage: (target) => jumps.push(target) });
      expect(root.dataset["present"]).toBe("true");
      expect(root.children.map((pip) => hasClass(pip, "current"))).toEqual([false, true, false]);
      expect(root.children.map((pip) => pip.type)).toEqual(["button", "button", "button"]);
      const minis = root.children.map(
        (pip) => descendants(pip).find((node) => hasClass(node, "pip-mini"))?.dataset["kind"] ?? null,
      );
      expect(minis).toEqual(["unread", null, "working"]);
      expect(root.children.map((pip) => pip.attributes["aria-label"])).toEqual(["Page 1", "Page 2", "Page 3"]);
      expect(root.children.map((pip) => pip.attributes["aria-current"])).toEqual([undefined, "page", undefined]);
      for (const pip of root.children) {
        for (const listener of pip.listeners["click"] ?? []) {
          listener();
        }
      }
      expect(jumps).toEqual([0, 1, 2]);
    });
    withFakeDocument((root) => {
      renderPips(root as unknown as HTMLElement, [], { onJumpToPage: () => {} });
      expect(root.dataset["present"]).toBe("false");
    });
  });
});

describe("indicatorsRenderSignature", () => {
  test("stable for equal models, distinct when any surface moves", () => {
    const pips: PipModel[] = [{ current: true, dot: null }];
    const base = indicatorsRenderSignature([], [], pips);
    expect(indicatorsRenderSignature([], [], [{ current: true, dot: null }])).toBe(base);
    expect(
      indicatorsRenderSignature(
        [],
        [],
        [
          { current: true, dot: null },
          { current: false, dot: "unread" },
        ],
      ),
    ).not.toBe(base);
    expect(indicatorsRenderSignature([], [{ row: 0, status: "idle", sub: false, unread: false }], pips)).not.toBe(base);
    expect(indicatorsRenderSignature([{ row: 0, status: "idle", sub: false, unread: false }], [], pips)).not.toBe(base);
  });
});
