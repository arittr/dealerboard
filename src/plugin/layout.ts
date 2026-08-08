/**
 * Pure paging reducer for the 5x3 Stream Deck profile.
 *
 * Maps live sessions onto fifteen physical keys in dense slot-rank order.
 * Sessions sort by their stable logical slot and pack onto keys by rank, so
 * the grid never shows holes between tiles: a session ending shifts later
 * tiles one key left, and a new session reusing a freed slot inserts at that
 * rank, shifting later tiles one key right. Without overflow, ranks 0..14
 * land on keys 0..14. Once the live count exceeds fifteen, the overflow
 * latch engages: keys 0..13 show the current page's fourteen ranks and key
 * 14 is NEXT; pages are uniform dense fourteen-rank slices. The latch holds
 * while the live count is at least fifteen and ends at fourteen or fewer. An
 * out-of-range current page clamps to the last page.
 *
 * All page/latch state lives in this module as validated settings; the
 * reducer performs no I/O and imports no Stream Deck SDK types.
 */

import type { ProjectedSession } from "../protocol";
import type { SnapshotView } from "./snapshot-reader";

export type KeyModel =
  | { kind: "blank"; degraded: boolean }
  | { kind: "next"; page: number; pageCount: number; degraded: boolean }
  | { kind: "session"; session: ProjectedSession; label: string; degraded: boolean };

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
  /** Exactly fifteen models, one per physical key, row-major. */
  keys: KeyModel[];
};

export const DEFAULT_LAYOUT_SETTINGS: LayoutSettingsV1 = {
  schemaVersion: 1,
  overflowLatched: false,
  currentPage: 0,
};

const KEY_COUNT = 15;
const PAGE_SESSION_KEYS = 14;
const MAX_UNPAGED_SESSIONS = 15;
const SHORT_SESSION_ID_LENGTH = 8;

const labelForSession = (session: ProjectedSession): string => {
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
): KeyModel[] => {
  const keys: KeyModel[] = [];
  if (!settings.overflowLatched) {
    for (let key = 0; key < KEY_COUNT; key++) {
      keys.push(sessionKey(sessions[key], degraded));
    }
    return keys;
  }
  const start = settings.currentPage * PAGE_SESSION_KEYS;
  for (let key = 0; key < PAGE_SESSION_KEYS; key++) {
    keys.push(sessionKey(sessions[start + key], degraded));
  }
  keys.push({
    kind: "next",
    page: settings.currentPage + 1,
    pageCount,
    degraded,
  });
  return keys;
};

type ValidatedSettings = {
  settings: LayoutSettingsV1;
  defaulted: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validateStoredSettings = (stored: unknown): ValidatedSettings => {
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

type InternalLayout = LayoutResult & { pageCount: number };

/** Sort defensively by logical slot even though the daemon already orders. */
const sortedSessions = (view: SnapshotView): ProjectedSession[] =>
  [...view.snapshot.sessions].sort((a, b) => a.logicalSlot - b.logicalSlot);

const reduceInternal = (view: SnapshotView, storedState: unknown): InternalLayout => {
  const sessions = sortedSessions(view);
  const count = sessions.length;
  const { settings: restored, defaulted } = validateStoredSettings(storedState);

  // The latch engages only when the live count exceeds fifteen; once engaged
  // it holds while at least fifteen sessions remain live.
  const overflow = restored.overflowLatched ? count >= MAX_UNPAGED_SESSIONS : count > MAX_UNPAGED_SESSIONS;

  if (!overflow) {
    const settings: LayoutSettingsV1 = { ...DEFAULT_LAYOUT_SETTINGS };
    const dirty = defaulted || restored.overflowLatched || restored.currentPage !== 0;
    return {
      settings,
      dirty,
      keys: buildKeys(sessions, view.degraded, settings, 1),
      pageCount: 1,
    };
  }

  // Latched pages are dense by construction, so every page in range is
  // non-empty and clamping reduces to bounding the page index.
  const pageCount = Math.ceil(count / PAGE_SESSION_KEYS);
  const currentPage = Math.min(restored.currentPage, pageCount - 1);
  const settings: LayoutSettingsV1 = { schemaVersion: 1, overflowLatched: true, currentPage };
  const dirty = defaulted || !restored.overflowLatched || restored.currentPage !== currentPage;
  return {
    settings,
    dirty,
    keys: buildKeys(sessions, view.degraded, settings, pageCount),
    pageCount,
  };
};

export const reduceLayout = (view: SnapshotView, storedState: unknown): LayoutResult => {
  const { settings, dirty, keys } = reduceInternal(view, storedState);
  return { settings, dirty, keys };
};

/**
 * Advance to the next page, wrapping. Without overflow, or with a single
 * page, nothing moves and the base reduction's dirty flag is preserved.
 */
export const advanceLayoutPage = (view: SnapshotView, storedState: unknown): LayoutResult => {
  const base = reduceInternal(view, storedState);
  if (!base.settings.overflowLatched || base.pageCount <= 1) {
    return { settings: base.settings, dirty: base.dirty, keys: base.keys };
  }
  const currentPage = (base.settings.currentPage + 1) % base.pageCount;
  const settings: LayoutSettingsV1 = { ...base.settings, currentPage };
  return {
    settings,
    dirty: true,
    keys: buildKeys(sortedSessions(view), view.degraded, settings, base.pageCount),
  };
};
