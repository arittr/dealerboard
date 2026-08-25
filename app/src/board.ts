/**
 * Pure grouped-board reducer for the strip: parent-grouped ordering (subagents
 * attach under their nearest on-grid Paseo ancestor, orphans form one tail
 * block), group-atomic page packing, and validated page settings. No DOM, no
 * I/O; the rendering layer is app/src/cards.ts and the driver app/src/main.ts.
 */

import { labelForSession } from "../../src/plugin/layout";
import type { ProjectedSession } from "../../src/protocol";

export type BoardCardSeed = {
  session: ProjectedSession;
  label: string;
  subagent: boolean;
  /** Anchoring primary's project, for meta-line suppression; null for primaries and orphans. */
  parentProject: string | null;
};

export type BoardGroup = { cards: BoardCardSeed[]; orphanTail: boolean };

const isPaseoSubagent = (session: ProjectedSession): boolean =>
  session.originKind === "paseo" && session.originSubagent;

export const groupedOrder = (sessions: readonly ProjectedSession[]): BoardGroup[] => {
  const ordered = [...sessions].sort((a, b) => a.logicalSlot - b.logicalSlot);
  const primaries = ordered.filter((entry) => !isPaseoSubagent(entry));
  const subs = ordered.filter(isPaseoSubagent);

  const byRef = new Map<string, ProjectedSession>();
  for (const entry of ordered) {
    if (entry.originKind === "paseo" && entry.originRef !== null) {
      byRef.set(entry.originRef, entry);
    }
  }

  // A sub anchors to the primary at the top of its on-grid parent chain; a
  // missing link, null ref, or cycle orphans it (the chain cannot be followed
  // through rows the grid does not have).
  const childrenOf = new Map<string, ProjectedSession[]>();
  const orphans: ProjectedSession[] = [];
  for (const entry of subs) {
    let anchored = false;
    const visited = new Set<string>();
    let ref = entry.originParentRef;
    while (ref !== null && !visited.has(ref)) {
      visited.add(ref);
      const link: ProjectedSession | undefined = byRef.get(ref);
      if (link === undefined) {
        break;
      }
      if (!isPaseoSubagent(link)) {
        anchored = true;
        break;
      }
      ref = link.originParentRef;
    }
    if (anchored && entry.originParentRef !== null) {
      const list = childrenOf.get(entry.originParentRef) ?? [];
      list.push(entry);
      childrenOf.set(entry.originParentRef, list);
    } else {
      orphans.push(entry);
    }
  }

  const groups: BoardGroup[] = primaries.map((primary) => {
    const cards: BoardCardSeed[] = [
      { session: primary, label: labelForSession(primary), subagent: false, parentProject: null },
    ];
    const walk = (ref: string | null): void => {
      if (ref === null) {
        return;
      }
      for (const child of childrenOf.get(ref) ?? []) {
        cards.push({ session: child, label: labelForSession(child), subagent: true, parentProject: primary.project });
        walk(child.originRef);
      }
    };
    walk(primary.originRef);
    return { cards, orphanTail: false };
  });

  if (orphans.length > 0) {
    groups.push({
      cards: orphans.map((entry) => ({
        session: entry,
        label: labelForSession(entry),
        subagent: true,
        parentProject: null,
      })),
      orphanTail: true,
    });
  }
  return groups;
};
