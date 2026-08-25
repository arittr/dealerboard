import { describe, expect, test } from "bun:test";
import { type BoardGroup, groupedOrder } from "../app/src/board";
import type { ProjectedSession } from "../src/protocol";

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

describe("groupedOrder", () => {
  test("primaries in slot order, each followed by its subs in slot order", () => {
    const groups = groupedOrder([sub(4, "b1", "a2"), parent(2, "a2"), parent(1, "a1"), sub(3, "b2", "a2")]);
    expect(groups.map(ids)).toEqual([["s1"], ["s2", "s3", "s4"]]);
    expect(groups[1]?.cards[1]?.subagent).toBe(true);
    expect(groups[1]?.orphanTail).toBe(false);
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
