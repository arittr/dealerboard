/**
 * Pure paging reducer: maps live sessions onto a fixed tile grid in dense
 * slot-rank order. Geometry is parameterized; the 5x3 Stream Deck keypad is
 * the default and the sole production consumer (the Xeneon strip pages its
 * board in app/src/board.ts and no longer consumes this module). Sessions
 * sort by their stable logical slot and pack onto tiles by rank, so the
 * grid never shows holes; the overflow latch
 * engages above the geometry's unpaged capacity, holds at or above it, and
 * releases below it. An out-of-range current page clamps to the last page.
 *
 * All page/latch state lives in this module as validated settings; the
 * reducer performs no I/O and imports no Stream Deck SDK types.
 */

import type { ProjectedSession, SnapshotView } from "../protocol";

export type KeyModel =
  | { kind: "blank"; degraded: boolean }
  | { kind: "next"; page: number; pageCount: number; degraded: boolean }
  | { kind: "session"; session: ProjectedSession; label: string; degraded: boolean };

export type LayoutGeometry = {
  /** Total tiles in the grid. */
  keyCount: number;
  /** Session tiles per page once overflow paging engages. */
  pageSessionKeys: number;
  /** Overflow engages above this live count and holds at or above it. */
  maxUnpagedSessions: number;
  /** True: a paged grid's last tile is NEXT. False: pages run at full density with no NEXT tile. */
  nextKey: boolean;
};

export const KEYPAD_GEOMETRY: LayoutGeometry = {
  keyCount: 15,
  pageSessionKeys: 14,
  maxUnpagedSessions: 15,
  nextKey: true,
};

/** Keypad-sized full-density geometry (no NEXT tile). No longer consumed by
 *  the strip — kept as a coverage fixture for the `nextKey: false` paging
 *  path used by test/layout.test.ts. */
export const STRIP_GEOMETRY: LayoutGeometry = {
  keyCount: 15,
  pageSessionKeys: 15,
  maxUnpagedSessions: 15,
  nextKey: false,
};

export type LayoutSettingsV1 = {
  schemaVersion: 1;
  overflowLatched: boolean;
  currentPage: number;
};

export type LayoutResult = {
  /** Validated, clamped, latch-updated settings to persist when dirty. */
  settings: LayoutSettingsV1;
  /** True only after NEXT or a validation, clamping, or latch change. */
  dirty: boolean;
  /** Exactly geometry.keyCount models, one per tile, row-major. */
  keys: KeyModel[];
  /** Total pages; 1 when unpaged. Mirrored onto the NEXT key model for rendering. */
  pageCount: number;
};

export const DEFAULT_LAYOUT_SETTINGS: LayoutSettingsV1 = {
  schemaVersion: 1,
  overflowLatched: false,
  currentPage: 0,
};

const SHORT_SESSION_ID_LENGTH = 8;

export type SessionLabelSource = Pick<ProjectedSession, "provider" | "sessionId" | "title" | "project">;

export const labelForSession = (session: SessionLabelSource): string => {
  if (session.title !== null && session.title.length > 0) {
    return session.title;
  }
  if (session.project !== null && session.project.length > 0) {
    return session.project;
  }
  return `${session.provider} ${session.sessionId.slice(0, SHORT_SESSION_ID_LENGTH)}`;
};

const sessionKey = (session: ProjectedSession | undefined, degraded: boolean): KeyModel =>
  session === undefined
    ? { kind: "blank", degraded }
    : { kind: "session", session, label: labelForSession(session), degraded };

const buildKeys = (
  sessions: readonly ProjectedSession[],
  degraded: boolean,
  settings: LayoutSettingsV1,
  pageCount: number,
  geometry: LayoutGeometry,
): KeyModel[] => {
  const keys: KeyModel[] = [];
  if (!settings.overflowLatched) {
    for (let key = 0; key < geometry.keyCount; key++) {
      keys.push(sessionKey(sessions[key], degraded));
    }
    return keys;
  }
  const start = settings.currentPage * geometry.pageSessionKeys;
  for (let key = 0; key < geometry.pageSessionKeys; key++) {
    keys.push(sessionKey(sessions[start + key], degraded));
  }
  if (geometry.nextKey) {
    keys.push({
      kind: "next",
      page: settings.currentPage + 1,
      pageCount,
      degraded,
    });
  }
  return keys;
};

export type ValidatedSettings = {
  settings: LayoutSettingsV1;
  defaulted: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateLayoutSettings = (stored: unknown): ValidatedSettings => {
  if (isRecord(stored)) {
    const value = stored;
    if (
      value["schemaVersion"] === 1 &&
      typeof value["overflowLatched"] === "boolean" &&
      typeof value["currentPage"] === "number" &&
      Number.isSafeInteger(value["currentPage"]) &&
      value["currentPage"] >= 0
    ) {
      return {
        settings: {
          schemaVersion: 1,
          overflowLatched: value["overflowLatched"],
          currentPage: value["currentPage"],
        },
        defaulted: false,
      };
    }
  }
  return { settings: { ...DEFAULT_LAYOUT_SETTINGS }, defaulted: true };
};

/** Sort defensively by logical slot even though the daemon already orders. */
const sortedSessions = (view: SnapshotView): ProjectedSession[] =>
  [...view.snapshot.sessions].sort((a, b) => a.logicalSlot - b.logicalSlot);

const reduceInternal = (view: SnapshotView, storedState: unknown, geometry: LayoutGeometry): LayoutResult => {
  const sessions = sortedSessions(view);
  const count = sessions.length;
  const { settings: restored, defaulted } = validateLayoutSettings(storedState);

  // The latch engages only when the live count exceeds the unpaged capacity;
  // once engaged it holds while at least that many sessions remain live.
  const overflow = restored.overflowLatched
    ? count >= geometry.maxUnpagedSessions
    : count > geometry.maxUnpagedSessions;

  if (!overflow) {
    const settings: LayoutSettingsV1 = { ...DEFAULT_LAYOUT_SETTINGS };
    const dirty = defaulted || restored.overflowLatched || restored.currentPage !== 0;
    return { settings, dirty, keys: buildKeys(sessions, view.degraded, settings, 1, geometry), pageCount: 1 };
  }

  // Latched pages are dense by construction, so every page in range is
  // non-empty and clamping reduces to bounding the page index.
  const pageCount = Math.ceil(count / geometry.pageSessionKeys);
  const currentPage = Math.min(restored.currentPage, pageCount - 1);
  const settings: LayoutSettingsV1 = { schemaVersion: 1, overflowLatched: true, currentPage };
  const dirty = defaulted || !restored.overflowLatched || restored.currentPage !== currentPage;
  return { settings, dirty, keys: buildKeys(sessions, view.degraded, settings, pageCount, geometry), pageCount };
};

export const reduceLayout = (
  view: SnapshotView,
  storedState: unknown,
  geometry: LayoutGeometry = KEYPAD_GEOMETRY,
): LayoutResult => reduceInternal(view, storedState, geometry);

/**
 * Advance to the next page, wrapping. Without overflow, or with a single
 * page, nothing moves and the base reduction's dirty flag is preserved.
 */
export const advanceLayoutPage = (
  view: SnapshotView,
  storedState: unknown,
  geometry: LayoutGeometry = KEYPAD_GEOMETRY,
): LayoutResult => {
  const base = reduceInternal(view, storedState, geometry);
  if (!base.settings.overflowLatched || base.pageCount <= 1) {
    return base;
  }
  const currentPage = (base.settings.currentPage + 1) % base.pageCount;
  const settings: LayoutSettingsV1 = { ...base.settings, currentPage };
  return {
    settings,
    dirty: true,
    keys: buildKeys(sortedSessions(view), view.degraded, settings, base.pageCount, geometry),
    pageCount: base.pageCount,
  };
};
