/**
 * Pure paging reducer for the 5x3 Stream Deck profile.
 *
 * Maps the daemon's stable logical slots onto fifteen physical keys. Without
 * overflow, slots 1..15 land on keys 0..14. Once a live slot above 15 latches
 * overflow, keys 0..13 show the current page's fourteen slots and key 14 is
 * NEXT; the second page starts at slot 15 and further pages advance in
 * blocks of fourteen. Gaps stay blank — sessions never compact. The latch
 * persists while any slot at least 15 is live (including slot 15 itself) and
 * ends when none is. An empty current page clamps to the nearest earlier
 * non-empty page, otherwise the earliest later one.
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
const FIRST_OVERFLOW_SLOT = 15;
const SHORT_SESSION_ID_LENGTH = 8;

/** Page 0 covers slots 1..14; page p >= 1 covers a block of 14 from slot 15. */
const pageStartSlot = (page: number): number =>
  page === 0 ? 1 : FIRST_OVERFLOW_SLOT + (page - 1) * PAGE_SESSION_KEYS;

const pageForSlot = (slot: number): number =>
  slot < FIRST_OVERFLOW_SLOT
    ? 0
    : Math.ceil((slot - (FIRST_OVERFLOW_SLOT - 1)) / PAGE_SESSION_KEYS);

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
  sessionsBySlot: ReadonlyMap<number, ProjectedSession>,
  degraded: boolean,
  settings: LayoutSettingsV1,
  nonEmptyPages: readonly number[],
): KeyModel[] => {
  const keys: KeyModel[] = [];
  if (!settings.overflowLatched) {
    for (let key = 0; key < KEY_COUNT; key++) {
      keys.push(sessionKey(sessionsBySlot.get(key + 1), degraded));
    }
    return keys;
  }
  const start = pageStartSlot(settings.currentPage);
  for (let key = 0; key < PAGE_SESSION_KEYS; key++) {
    keys.push(sessionKey(sessionsBySlot.get(start + key), degraded));
  }
  keys.push({
    kind: "next",
    page: nonEmptyPages.indexOf(settings.currentPage) + 1,
    pageCount: nonEmptyPages.length,
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
      value.schemaVersion === 1 &&
      typeof value.overflowLatched === "boolean" &&
      typeof value.currentPage === "number" &&
      Number.isSafeInteger(value.currentPage) &&
      value.currentPage >= 0
    ) {
      return {
        settings: {
          schemaVersion: 1,
          overflowLatched: value.overflowLatched,
          currentPage: value.currentPage,
        },
        defaulted: false,
      };
    }
  }
  return { settings: { ...DEFAULT_LAYOUT_SETTINGS }, defaulted: true };
};

const clampToNonEmptyPage = (page: number, nonEmptyPages: readonly number[]): number => {
  // Nearest earlier non-empty page wins; otherwise the earliest later one.
  // The overflow branch always has at least one non-empty page: the one
  // holding the highest live slot.
  for (let index = nonEmptyPages.length - 1; index >= 0; index--) {
    const candidate = nonEmptyPages[index]!;
    if (candidate < page) {
      return candidate;
    }
  }
  for (const candidate of nonEmptyPages) {
    if (candidate > page) {
      return candidate;
    }
  }
  throw new Error("unreachable: overflow always has a non-empty page");
};

type InternalLayout = LayoutResult & { nonEmptyPages: number[] };

const reduceInternal = (view: SnapshotView, storedState: unknown): InternalLayout => {
  // Sort defensively by logical slot even though the daemon already orders.
  const sessions = [...view.snapshot.sessions].sort((a, b) => a.logicalSlot - b.logicalSlot);
  const maxSlot = sessions.length === 0 ? 0 : sessions[sessions.length - 1]!.logicalSlot;
  const { settings: restored, defaulted } = validateStoredSettings(storedState);

  // The latch engages only when a live slot exceeds 15; once engaged it holds
  // while any slot at least 15 is live, including slot 15 itself.
  const overflow = restored.overflowLatched
    ? maxSlot >= FIRST_OVERFLOW_SLOT
    : maxSlot > FIRST_OVERFLOW_SLOT;

  const sessionsBySlot = new Map(sessions.map((s) => [s.logicalSlot, s]));

  if (!overflow) {
    const settings: LayoutSettingsV1 = { ...DEFAULT_LAYOUT_SETTINGS };
    const dirty = defaulted || restored.overflowLatched || restored.currentPage !== 0;
    return {
      settings,
      dirty,
      keys: buildKeys(sessionsBySlot, view.degraded, settings, [0]),
      nonEmptyPages: [0],
    };
  }

  const nonEmptyPages = [...new Set(sessions.map((s) => pageForSlot(s.logicalSlot)))].sort(
    (a, b) => a - b,
  );
  const currentPage = nonEmptyPages.includes(restored.currentPage)
    ? restored.currentPage
    : clampToNonEmptyPage(restored.currentPage, nonEmptyPages);
  const settings: LayoutSettingsV1 = { schemaVersion: 1, overflowLatched: true, currentPage };
  const dirty = defaulted || !restored.overflowLatched || restored.currentPage !== currentPage;
  return {
    settings,
    dirty,
    keys: buildKeys(sessionsBySlot, view.degraded, settings, nonEmptyPages),
    nonEmptyPages,
  };
};

export const reduceLayout = (view: SnapshotView, storedState: unknown): LayoutResult => {
  const { settings, dirty, keys } = reduceInternal(view, storedState);
  return { settings, dirty, keys };
};

/**
 * Advance to the next non-empty page, wrapping. Pages with no sessions are
 * skipped. Without overflow, or with only one non-empty page, nothing moves
 * and the base reduction's dirty flag is preserved.
 */
export const advanceLayoutPage = (view: SnapshotView, storedState: unknown): LayoutResult => {
  const base = reduceInternal(view, storedState);
  if (!base.settings.overflowLatched || base.nonEmptyPages.length <= 1) {
    return { settings: base.settings, dirty: base.dirty, keys: base.keys };
  }
  const index = base.nonEmptyPages.indexOf(base.settings.currentPage);
  const currentPage = base.nonEmptyPages[(index + 1) % base.nonEmptyPages.length]!;
  const settings: LayoutSettingsV1 = { ...base.settings, currentPage };
  const sessionsBySlot = new Map(view.snapshot.sessions.map((s) => [s.logicalSlot, s]));
  return {
    settings,
    dirty: true,
    keys: buildKeys(sessionsBySlot, view.degraded, settings, base.nonEmptyPages),
  };
};
