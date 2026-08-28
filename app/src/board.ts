/**
 * Pure grouped-board reducer for the strip: parent-grouped ordering (subagents
 * attach under their nearest on-grid Paseo ancestor, orphans form one tail
 * block), group-atomic page packing, and validated page settings. No DOM, no
 * I/O; the rendering layer is app/src/cards.ts and the driver app/src/main.ts.
 */

import {
  DEFAULT_LAYOUT_SETTINGS,
  type LayoutSettingsV1,
  labelForSession,
  validateLayoutSettings,
} from "../../src/plugin/layout";
import type { AgentIdentity, ProjectedAgentNode, ProjectedSession, SnapshotView } from "../../src/protocol";

export type BoardSession = ProjectedSession | ProjectedAgentNode;

export type BoardCardSeed = {
  session: BoardSession;
  label: string;
  subagent: boolean;
  /** Anchoring primary's project, for meta-line suppression; null for primaries and orphans. */
  parentProject: string | null;
  displayOnly: boolean;
  descendantBadge: number | null;
  /** Rolled-up unviewed results held by finished Paseo descendants; 0 shows none. */
  pendingResults: number;
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
      {
        session: primary,
        label: labelForSession(primary),
        subagent: false,
        parentProject: null,
        displayOnly: false,
        descendantBadge: primary.descendantCount,
        pendingResults: primary.pendingResults,
      },
    ];
    const walk = (ref: string | null): void => {
      if (ref === null) {
        return;
      }
      for (const child of childrenOf.get(ref) ?? []) {
        cards.push({
          session: child,
          label: labelForSession(child),
          subagent: true,
          parentProject: primary.project,
          displayOnly: false,
          descendantBadge: child.descendantCount,
          pendingResults: child.pendingResults,
        });
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
        displayOnly: false,
        descendantBadge: entry.descendantCount,
        pendingResults: entry.pendingResults,
      })),
      orphanTail: true,
    });
  }
  return groups;
};

const agentKey = (identity: AgentIdentity): string => `${identity.provider}\u0000${identity.sessionId}`;

const compareOpenedIdentity = (a: ProjectedAgentNode, b: ProjectedAgentNode): number =>
  a.openedAt.localeCompare(b.openedAt) ||
  a.provider.localeCompare(b.provider) ||
  a.sessionId.localeCompare(b.sessionId);

export const groupedAgentOrder = (agents: readonly ProjectedAgentNode[]): BoardGroup[] => {
  const childrenOf = new Map<string, ProjectedAgentNode[]>();
  const primaries = agents
    .filter(
      (node): node is ProjectedAgentNode & { logicalSlot: number } =>
        node.role === "primary" && node.logicalSlot !== null,
    )
    .sort((a, b) => a.logicalSlot - b.logicalSlot);

  for (const node of agents) {
    if (node.parent === null) {
      continue;
    }
    const key = agentKey(node.parent);
    const children = childrenOf.get(key) ?? [];
    children.push(node);
    childrenOf.set(key, children);
  }
  for (const children of childrenOf.values()) {
    children.sort(compareOpenedIdentity);
  }

  const seed = (node: ProjectedAgentNode, parentProject: string | null): BoardCardSeed => ({
    session: node,
    label: labelForSession(node),
    subagent: node.role === "subagent",
    parentProject,
    displayOnly: node.lineage === "native",
    descendantBadge: null,
    pendingResults: node.pendingResults,
  });

  const appendChildren = (cards: BoardCardSeed[], parent: ProjectedAgentNode, parentProject: string | null): void => {
    for (const child of childrenOf.get(agentKey(parent)) ?? []) {
      cards.push(seed(child, parentProject));
      appendChildren(cards, child, parentProject);
    }
  };

  const groups = primaries.map((primary): BoardGroup => {
    const cards = [seed(primary, null)];
    appendChildren(cards, primary, primary.project);
    return { cards, orphanTail: false };
  });

  const orphans = agents.filter((node) => node.role === "subagent" && node.parent === null).sort(compareOpenedIdentity);
  if (orphans.length > 0) {
    const cards: BoardCardSeed[] = [];
    for (const orphan of orphans) {
      cards.push(seed(orphan, null));
      appendChildren(cards, orphan, null);
    }
    groups.push({ cards, orphanTail: true });
  }
  return groups;
};

export const BOARD_COLUMNS = 2;
export const BOARD_ROWS = 6;

export type SpineSegment = "none" | "mid" | "end";

export type PlacedCard = BoardCardSeed & {
  degraded: boolean;
  indent: boolean;
  spine: SpineSegment;
  /** 0-based column within the page. */
  column: number;
  /** 0-based row within the column. */
  row: number;
};

export type BoardPage = { cards: PlacedCard[] };

type SpinedSeed = BoardCardSeed & { indent: boolean; spine: SpineSegment };

const withSpines = (group: BoardGroup): SpinedSeed[] =>
  group.cards.map((seed, index) => {
    const grouped = seed.subagent && !group.orphanTail;
    return {
      ...seed,
      indent: grouped,
      spine: grouped ? (index === group.cards.length - 1 ? "end" : "mid") : "none",
    };
  });

type MutablePage = { used: number[]; cards: PlacedCard[] };

/**
 * Group-atomic first-fit (spec "Packing and paging"): small groups take the
 * first column with room on the current page (later groups may backfill an
 * earlier gap on that page, never an earlier page); a 7-12 group needs two
 * empty columns so it starts on the current page only while it is empty;
 * a larger group fills whole pages from a fresh page.
 */
export const packBoard = (groups: readonly BoardGroup[], degraded: boolean): BoardPage[] => {
  const pages: MutablePage[] = [];
  const openPage = (): MutablePage => {
    const page: MutablePage = { used: Array.from({ length: BOARD_COLUMNS }, () => 0), cards: [] };
    pages.push(page);
    return page;
  };
  const current = (): MutablePage => pages[pages.length - 1] ?? openPage();
  const place = (page: MutablePage, column: number, seed: SpinedSeed): void => {
    page.cards.push({ ...seed, degraded, column, row: page.used[column] ?? 0 });
    page.used[column] = (page.used[column] ?? 0) + 1;
  };

  for (const group of groups) {
    const seeds = withSpines(group);
    if (seeds.length === 0) {
      continue;
    }
    if (seeds.length <= BOARD_ROWS) {
      let page = current();
      let column = page.used.findIndex((used) => used + seeds.length <= BOARD_ROWS);
      if (column === -1) {
        page = openPage();
        column = 0;
      }
      for (const seed of seeds) {
        place(page, column, seed);
      }
    } else {
      const empty = current().cards.length === 0;
      let page = empty ? current() : openPage();
      let column = 0;
      for (const seed of seeds) {
        if ((page.used[column] ?? 0) >= BOARD_ROWS) {
          column += 1;
          if (column >= BOARD_COLUMNS) {
            page = openPage();
            column = 0;
          }
        }
        place(page, column, seed);
      }
    }
  }
  return pages.map((page) => ({ cards: page.cards }));
};

export type BoardResult = {
  settings: LayoutSettingsV1;
  dirty: boolean;
  pages: BoardPage[];
  pageCount: number;
};

export const reduceBoard = (view: SnapshotView, storedState: unknown): BoardResult => {
  const groups =
    view.snapshot.agents === null ? groupedOrder(view.snapshot.sessions) : groupedAgentOrder(view.snapshot.agents);
  const packed = packBoard(groups, view.degraded);
  const pages = packed.length > 0 ? packed : [{ cards: [] }];
  const pageCount = pages.length;
  const { settings: restored, defaulted } = validateLayoutSettings(storedState);
  const currentPage = Math.min(restored.currentPage, pageCount - 1);
  const settings: LayoutSettingsV1 = { ...DEFAULT_LAYOUT_SETTINGS, currentPage };
  const dirty = defaulted || restored.currentPage !== currentPage || restored.overflowLatched;
  return { settings, dirty, pages, pageCount };
};

/**
 * A user page jump on top of the stored settings: clamp the target into range
 * and mark the result dirty when it changes the page — the driver persists
 * dirty settings, and every later ingest reduces from what was persisted, so
 * an unpersisted jump would snap back within one snapshot heartbeat.
 */
export const jumpBoard = (view: SnapshotView, storedState: unknown, page: number): BoardResult => {
  const base = reduceBoard(view, storedState);
  const currentPage = Math.min(Math.max(page, 0), base.pageCount - 1);
  if (currentPage === base.settings.currentPage) {
    return base;
  }
  return { ...base, settings: { ...base.settings, currentPage }, dirty: true };
};
