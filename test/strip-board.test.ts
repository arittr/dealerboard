import { describe, expect, test } from "bun:test";
import { type BoardGroup, groupedAgentOrder, groupedOrder, jumpBoard, packBoard, reduceBoard } from "../app/src/board";
import type { ProjectedAgentNode, ProjectedSession } from "../src/protocol";

const session = (slot: number, overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: `s${slot}`,
  project: null,
  title: `t${slot}`,
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

const parent = (slot: number, ref: string, overrides: Partial<ProjectedSession> = {}): ProjectedSession =>
  session(slot, { originKind: "paseo", originRef: ref, ...overrides });

const sub = (
  slot: number,
  ref: string,
  parentRef: string | null,
  overrides: Partial<ProjectedSession> = {},
): ProjectedSession =>
  session(slot, {
    originKind: "paseo",
    originRef: ref,
    originSubagent: true,
    originParentRef: parentRef,
    ...overrides,
  });

const ids = (group: BoardGroup): string[] => group.cards.map((card) => card.session.sessionId);

const node = (sessionId: string, overrides: Partial<ProjectedAgentNode> = {}): ProjectedAgentNode => ({
  provider: "evener",
  sessionId,
  role: "primary",
  lineage: null,
  parent: null,
  status: "working",
  title: sessionId,
  project: "repo",
  model: null,
  openedAt: "2026-08-26T05:00:00.000Z",
  statusSince: "2026-08-26T05:00:00.000Z",
  activityLine: null,
  unreadSince: null,
  logicalSlot: 1,
  ghosttyTerminalId: null,
  transcriptPath: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  originParentRef: null,
  ...overrides,
});

describe("groupedOrder", () => {
  test("primaries in slot order, each followed by its subs in slot order", () => {
    const groups = groupedOrder([sub(4, "b1", "a2"), parent(2, "a2"), parent(1, "a1"), sub(3, "b2", "a2")]);
    expect(groups.map(ids)).toEqual([["s1"], ["s2", "s3", "s4"]]);
    expect(groups[1]?.cards[1]?.subagent).toBe(true);
    expect(groups[1]?.orphanTail).toBe(false);
  });

  test("fallback seeds stay interactive and carry the legacy descendant badge", () => {
    const card = groupedOrder([session(1, { descendantCount: 3 })])[0]?.cards[0];
    expect(card).toMatchObject({ displayOnly: false, descendantBadge: 3 });
  });

  test("nested subs flatten to the primary's group, directly after their own parent", () => {
    // primary a ← sub b ← sub c; sibling sub d of a with a later slot than b
    const groups = groupedOrder([parent(1, "a"), sub(2, "b", "a"), sub(4, "d", "a"), sub(3, "c", "b")]);
    expect(groups.map(ids)).toEqual([["s1", "s2", "s3", "s4"]]);
  });

  test("subs with no on-grid ancestor collect in one orphan tail group, slot order", () => {
    const groups = groupedOrder([sub(3, "x", "gone"), parent(1, "a"), sub(2, "y", null)]);
    expect(groups.map(ids)).toEqual([["s1"], ["s2", "s3"]]);
    expect(groups[1]?.orphanTail).toBe(true);
    expect(groups[1]?.cards.every((card) => card.subagent)).toBe(true);
  });

  test("a parent-ref cycle among subs orphans the cycle instead of looping", () => {
    const groups = groupedOrder([sub(1, "x", "y"), sub(2, "y", "x")]);
    expect(groups.map(ids)).toEqual([["s1", "s2"]]);
    expect(groups[0]?.orphanTail).toBe(true);
  });

  test("grouped subs carry the anchoring primary's project for suppression; orphans carry null", () => {
    const groups = groupedOrder([
      parent(1, "a", { project: "repo" }),
      sub(2, "b", "a", { project: "repo" }),
      sub(3, "x", null),
    ]);
    expect(groups[0]?.cards[1]?.parentProject).toBe("repo");
    expect(groups[1]?.cards[0]?.parentProject).toBeNull();
  });

  test("the early lineage hop: an unstamped Paseo session sits primary, the stamped re-projection regroups it", () => {
    // Before the overlay pass the row has kind/ref only (origin.ts stamps no
    // subagent bit at ingest); the next snapshot carries the stamp.
    const before = groupedOrder([parent(1, "a"), parent(2, "b")]);
    expect(before.map(ids)).toEqual([["s1"], ["s2"]]);
    const after = groupedOrder([parent(1, "a"), sub(2, "b", "a")]);
    expect(after.map(ids)).toEqual([["s1", "s2"]]);
  });
});

describe("groupedAgentOrder", () => {
  test("graph groups primaries by slot and mixed children depth-first", () => {
    const root = node("root", { logicalSlot: 2 });
    const first = node("paseo", {
      provider: "codex",
      role: "subagent",
      lineage: "paseo",
      parent: { provider: "evener", sessionId: "root" },
      logicalSlot: 3,
      openedAt: "2026-08-26T05:00:01.000Z",
      originKind: "paseo",
      originRef: "paseo-ref",
      originSubagent: true,
    });
    const firstChild = node("paseo-native", {
      provider: "codex",
      role: "subagent",
      lineage: "native",
      parent: { provider: "codex", sessionId: "paseo" },
      logicalSlot: null,
      openedAt: "2026-08-26T05:00:02.000Z",
    });
    const second = node("native", {
      role: "subagent",
      lineage: "native",
      parent: { provider: "evener", sessionId: "root" },
      logicalSlot: null,
      openedAt: "2026-08-26T05:00:03.000Z",
    });
    const earlierPrimary = node("earlier", { provider: "claude", logicalSlot: 1 });

    const groups = groupedAgentOrder([second, firstChild, root, first, earlierPrimary]);
    expect(groups.map(ids)).toEqual([["earlier"], ["root", "paseo", "paseo-native", "native"]]);
    expect(groups[1]?.cards.map((card) => [card.session.sessionId, card.displayOnly])).toEqual([
      ["root", false],
      ["paseo", false],
      ["paseo-native", true],
      ["native", true],
    ]);
    expect(packBoard([groups[1]!], false)[0]?.cards.map((card) => [card.session.sessionId, card.indent])).toEqual([
      ["root", false],
      ["paseo", true],
      ["paseo-native", true],
      ["native", true],
    ]);
  });

  test("equal child timestamps use provider then session identity", () => {
    const root = node("root");
    const child = (provider: ProjectedAgentNode["provider"], sessionId: string): ProjectedAgentNode =>
      node(sessionId, {
        provider,
        role: "subagent",
        lineage: "paseo",
        parent: { provider: "evener", sessionId: "root" },
        logicalSlot: provider === "claude" ? (sessionId === "a" ? 2 : 3) : 4,
        openedAt: "2026-08-26T05:00:01.000Z",
        originKind: "paseo",
        originRef: `${provider}-${sessionId}`,
        originSubagent: true,
      });
    expect(ids(groupedAgentOrder([child("codex", "z"), root, child("claude", "b"), child("claude", "a")])[0]!)).toEqual(
      ["root", "a", "b", "z"],
    );
  });

  test("orphan roots keep safe descendants in one full-width atomic tail", () => {
    const orphanB = node("orphan-b", {
      provider: "codex",
      role: "subagent",
      lineage: "paseo",
      logicalSlot: 3,
      openedAt: "2026-08-26T05:00:02.000Z",
      originKind: "paseo",
      originRef: "b",
      originSubagent: true,
    });
    const orphanA = node("orphan-a", {
      role: "subagent",
      lineage: "paseo",
      logicalSlot: 2,
      openedAt: "2026-08-26T05:00:01.000Z",
      originKind: "paseo",
      originRef: "a",
      originSubagent: true,
    });
    const native = node("orphan-child", {
      role: "subagent",
      lineage: "native",
      parent: { provider: "evener", sessionId: "orphan-a" },
      logicalSlot: null,
      openedAt: "2026-08-26T05:00:03.000Z",
    });
    const groups = groupedAgentOrder([orphanB, native, orphanA]);
    expect(groups.map(ids)).toEqual([["orphan-a", "orphan-child", "orphan-b"]]);
    const placed = packBoard(groups, false)[0]?.cards ?? [];
    expect(placed.every((card) => !card.indent && card.spine === "none")).toBe(true);
  });
});

const groupOf = (start: number, size: number, orphanTail = false): BoardGroup => ({
  cards: Array.from({ length: size }, (_, i) => ({
    session: session(start + i),
    label: `t${start + i}`,
    subagent: i > 0 && !orphanTail ? true : orphanTail,
    parentProject: null,
    displayOnly: false,
    descendantBadge: 0,
  })),
  orphanTail,
});

const cell = (page: { cards: { session: { sessionId: string }; column: number; row: number }[] }, id: string) => {
  const card = page.cards.find((c) => c.session.sessionId === id);
  return card === undefined ? null : [card.column, card.row];
};

describe("packBoard", () => {
  test("small groups first-fit columns top-down and backfill same-page gaps", () => {
    // 4 + 4 + 2: third group backfills column 0 rows 4-5
    const pages = packBoard([groupOf(1, 4), groupOf(11, 4), groupOf(21, 2)], false);
    expect(pages).toHaveLength(1);
    expect(cell(pages[0]!, "s1")).toEqual([0, 0]);
    expect(cell(pages[0]!, "s11")).toEqual([1, 0]);
    expect(cell(pages[0]!, "s21")).toEqual([0, 4]);
  });

  test("a group that fits no column starts the next page (4+4+4 → pages of 8 and 4)", () => {
    const pages = packBoard([groupOf(1, 4), groupOf(11, 4), groupOf(21, 4)], false);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.cards).toHaveLength(8);
    expect(cell(pages[1]!, "s21")).toEqual([0, 0]);
  });

  test("backfill never crosses back to an earlier page", () => {
    // 4+4+4 opens page 2; a later 2-group lands on page 2, not page 1's gaps
    const pages = packBoard([groupOf(1, 4), groupOf(11, 4), groupOf(21, 4), groupOf(31, 2)], false);
    expect(pages).toHaveLength(2);
    expect(cell(pages[1]!, "s31")).toEqual([0, 4]);
  });

  test("a 7-12 group needs an empty page: wraps col 0 into col 1, else opens the next page", () => {
    const fresh = packBoard([groupOf(1, 8)], false);
    expect(cell(fresh[0]!, "s7")).toEqual([1, 0]);
    const after = packBoard([groupOf(90, 1), groupOf(1, 8)], false);
    expect(after).toHaveLength(2);
    expect(cell(after[1]!, "s1")).toEqual([0, 0]);
  });

  test("a >12 group fills whole pages from a fresh page and continues across the seam", () => {
    const pages = packBoard([groupOf(90, 1), groupOf(1, 14)], false);
    expect(pages).toHaveLength(3);
    expect(pages[1]!.cards).toHaveLength(12);
    expect(cell(pages[2]!, "s13")).toEqual([0, 0]);
  });

  test("grouped subs get indent + spine (mid/end); primaries and orphans get none", () => {
    const pages = packBoard([groupOf(1, 3), groupOf(11, 2, true)], false);
    const spines = pages[0]!.cards.map((card) => [card.session.sessionId, card.indent, card.spine]);
    expect(spines).toEqual([
      ["s1", false, "none"],
      ["s2", true, "mid"],
      ["s3", true, "end"],
      ["s11", false, "none"],
      ["s12", false, "none"],
    ]);
  });
});

describe("reduceBoard", () => {
  const view = (sessions: ProjectedSession[], degraded = false) =>
    ({ snapshot: { schemaVersion: 2, health: { status: "ok" }, sessions, agents: null }, degraded }) as never;

  test("zero sessions produce one empty page (the OFFLINE surface when degraded)", () => {
    const result = reduceBoard(view([], true), null);
    expect(result.pages).toEqual([{ cards: [] }]);
    expect(result.pageCount).toBe(1);
  });

  test("clamps a persisted out-of-range page and reports dirty", () => {
    const result = reduceBoard(view([session(1)]), { schemaVersion: 1, overflowLatched: false, currentPage: 7 });
    expect(result.settings.currentPage).toBe(0);
    expect(result.dirty).toBe(true);
  });

  test("keeps a valid page clean and always persists overflowLatched false", () => {
    const sessions = Array.from({ length: 13 }, (_, i) => session(i + 1));
    const result = reduceBoard(view(sessions), { schemaVersion: 1, overflowLatched: true, currentPage: 1 });
    expect(result.pageCount).toBe(2);
    expect(result.settings).toEqual({ schemaVersion: 1, overflowLatched: false, currentPage: 1 });
    expect(result.dirty).toBe(true); // latched true was persisted → rewrite
  });

  test("session-count boundaries: 1-3 stay one sparse page, exactly 12 one page, 13 two pages", () => {
    const count = (n: number) => reduceBoard(view(Array.from({ length: n }, (_, i) => session(i + 1))), null).pageCount;
    expect(count(1)).toBe(1);
    expect(count(3)).toBe(1);
    expect(count(12)).toBe(1);
    expect(count(13)).toBe(2);
    expect(count(15)).toBe(2);
  });

  test("present empty agents ignore non-empty legacy sessions", () => {
    const result = reduceBoard(
      {
        snapshot: { schemaVersion: 2, health: { status: "ok" }, sessions: [session(1)], agents: [] },
        degraded: false,
      } as never,
      null,
    );
    expect(result.pages).toEqual([{ cards: [] }]);
    expect(result.pageCount).toBe(1);
  });

  test("null agents retain legacy Paseo grouping and descendant badges", () => {
    const result = reduceBoard(
      view([parent(1, "a", { descendantCount: 2 }), sub(2, "b", "a", { descendantCount: 1 })]),
      null,
    );
    expect(result.pages[0]?.cards.map((card) => [card.session.sessionId, card.descendantBadge])).toEqual([
      ["s1", 2],
      ["s2", 1],
    ]);
  });

  test("present agents suppress every descendant badge", () => {
    const root = node("root", { logicalSlot: 1 });
    const child = node("child", {
      role: "subagent",
      lineage: "paseo",
      parent: { provider: "evener", sessionId: "root" },
      originKind: "paseo",
      originSubagent: true,
      originRef: "child",
    });
    const result = reduceBoard(
      {
        snapshot: { schemaVersion: 2, health: { status: "ok" }, sessions: [session(1)], agents: [root, child] },
        degraded: false,
      } as never,
      null,
    );
    expect(result.pages[0]?.cards.every((card) => card.descendantBadge === null)).toBe(true);
  });

  test("disappearing graph children clamp the persisted page", () => {
    const root = node("root");
    const children = Array.from({ length: 12 }, (_, index) =>
      node(`child-${index}`, {
        role: "subagent",
        lineage: "paseo",
        parent: { provider: "evener", sessionId: "root" },
        openedAt: `2026-08-26T05:00:${String(index).padStart(2, "0")}.000Z`,
        originKind: "paseo",
        originRef: `child-${index}`,
        originSubagent: true,
      }),
    );
    const stored = { schemaVersion: 1, overflowLatched: false, currentPage: 1 };
    const result = reduceBoard(
      {
        snapshot: {
          schemaVersion: 2,
          health: { status: "ok" },
          sessions: [],
          agents: [root, ...children.slice(0, 11)],
        },
        degraded: false,
      } as never,
      stored,
    );
    expect(
      reduceBoard(
        {
          snapshot: { schemaVersion: 2, health: { status: "ok" }, sessions: [], agents: [root, ...children] },
          degraded: false,
        } as never,
        stored,
      ).pageCount,
    ).toBe(2);
    expect(result.settings.currentPage).toBe(0);
    expect(result.dirty).toBe(true);
  });
});

describe("jumpBoard", () => {
  const view = (sessions: ProjectedSession[]) =>
    ({ snapshot: { schemaVersion: 2, health: { status: "ok" }, sessions, agents: null }, degraded: false }) as never;
  const twoPages = () => view(Array.from({ length: 13 }, (_, i) => session(i + 1)));

  test("an in-range jump is dirty, so it persists and the next reduce keeps the page", () => {
    const jumped = jumpBoard(twoPages(), { schemaVersion: 1, overflowLatched: false, currentPage: 0 }, 1);
    expect(jumped.settings.currentPage).toBe(1);
    expect(jumped.dirty).toBe(true);
    // The driver persists jumped.settings; a later ingest reduces from them
    // and must stay on the chosen page without churn.
    const next = reduceBoard(twoPages(), jumped.settings);
    expect(next.settings.currentPage).toBe(1);
    expect(next.dirty).toBe(false);
  });

  test("clamps out-of-range targets and keeps a same-page jump clean", () => {
    const stored = { schemaVersion: 1, overflowLatched: false, currentPage: 1 };
    expect(jumpBoard(twoPages(), stored, 9).settings.currentPage).toBe(1);
    expect(jumpBoard(twoPages(), stored, -3).settings.currentPage).toBe(0);
    expect(jumpBoard(twoPages(), stored, -3).dirty).toBe(true);
    expect(jumpBoard(twoPages(), stored, 1).dirty).toBe(false);
  });
});
