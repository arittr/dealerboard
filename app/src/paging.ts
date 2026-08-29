/**
 * Pure drag-follow paging decisions for the strip board: rubber-banded
 * display offsets, the commit-or-snap-back settle rule (a commit carries its
 * captured origin and target pages), the single-flight drag-session phases
 * the driver keys rendering, navigation gating, and snapshot deferral off,
 * and the latest-wins deferral latch itself. No DOM, no timers — main.ts
 * feeds recognizer intents and animation completion in and animates only
 * the non-null verdicts minted here.
 */

export type PageDirection = "previous" | "next";

/** Bring-up placeholders — Task 9 tunes all three on the physical strip. */
export const COMMIT_FRACTION = 0.25;
export const COMMIT_VELOCITY_PX_PER_MS = 0.6;
export const RUBBER_BAND_FACTOR = 0.3;

export type DragBounds = {
  /** 0-based page under the finger at drag start. */
  page: number;
  pageCount: number;
  /** The board viewport's width in CSS px — the commit fraction's base. */
  boardWidth: number;
};

export const dragDirection = (dx: number): PageDirection => (dx < 0 ? "next" : "previous");

const pageExists = (bounds: DragBounds, direction: PageDirection): boolean =>
  direction === "next" ? bounds.page < bounds.pageCount - 1 : bounds.page > 0;

/** 1:1 toward an existing page; rubber-banded where none exists; clamped to one page of travel. */
export const dragOffset = (dx: number, bounds: DragBounds): number => {
  const offset = pageExists(bounds, dragDirection(dx)) ? dx : dx * RUBBER_BAND_FACTOR;
  return Math.max(-bounds.boardWidth, Math.min(bounds.boardWidth, offset));
};

export type DragSettle =
  | { kind: "commit"; direction: PageDirection; from: number; target: number }
  | { kind: "snap-back" };

export const settleDrag = (dx: number, velocity: number, bounds: DragBounds): DragSettle => {
  if (dx === 0) {
    return { kind: "snap-back" };
  }
  const direction = dragDirection(dx);
  if (!pageExists(bounds, direction)) {
    return { kind: "snap-back" };
  }
  const past = Math.abs(dx) >= bounds.boardWidth * COMMIT_FRACTION;
  const flung = Math.sign(velocity) === Math.sign(dx) && Math.abs(velocity) >= COMMIT_VELOCITY_PX_PER_MS;
  return past || flung
    ? { kind: "commit", direction, from: bounds.page, target: bounds.page + (direction === "next" ? 1 : -1) }
    : { kind: "snap-back" };
};

export type PagingPhase = "idle" | "dragging" | "settling";

export type PagingSession = {
  phase: () => PagingPhase;
  /** Snapshots defer while a gesture or its settle animation owns the board. */
  defersSnapshots: () => boolean;
  /** Pip/band navigation is gated while a gesture or settle owns the board. */
  allowsNavigation: () => boolean;
  /** Begin a drag; refused (false) unless idle — a settling board is not grabbable. */
  start: (bounds: DragBounds) => boolean;
  /** Display offset while dragging; null otherwise — a refused stroke must not touch the track. */
  move: (dx: number) => number | null;
  /** The settle verdict for this session's live drag; null when none exists (stray release). */
  release: (dx: number, velocity: number) => DragSettle | null;
  /** Pointer cancellation or leaving the window: snap-back for a live drag, null otherwise. */
  cancel: () => DragSettle | null;
  /** The settle animation finished: back to rest. */
  settled: () => void;
};

export const createPagingSession = (): PagingSession => {
  let phase: PagingPhase = "idle";
  let bounds: DragBounds = { page: 0, pageCount: 1, boardWidth: 0 };
  return {
    phase: () => phase,
    defersSnapshots: () => phase !== "idle",
    allowsNavigation: () => phase === "idle",
    start: (next) => {
      if (phase !== "idle") {
        return false;
      }
      phase = "dragging";
      bounds = next;
      return true;
    },
    move: (dx) => (phase === "dragging" ? dragOffset(dx, bounds) : null),
    release: (dx, velocity) => {
      if (phase !== "dragging") {
        return null;
      }
      phase = "settling";
      return settleDrag(dx, velocity, bounds);
    },
    cancel: () => {
      if (phase !== "dragging") {
        return null;
      }
      phase = "settling";
      return { kind: "snap-back" };
    },
    settled: () => {
      phase = "idle";
    },
  };
};

/**
 * Latest-wins deferral: while shouldDefer() holds, submitted values stash
 * (newest replaces older); flush() applies the pending value exactly once,
 * and only after deferral has lifted. A direct apply supersedes any stash.
 * resubmitLatest() re-submits the newest value ever submitted — applied or
 * stashed — so a local re-reduction (the dismissal flick's settle) can never
 * resurrect an older payload over a newer deferred one.
 */
export const createDeferredLatest = <T>(
  shouldDefer: () => boolean,
  apply: (value: T) => void,
): { submit: (value: T) => void; flush: () => void; resubmitLatest: () => void } => {
  let pending: { value: T } | null = null;
  let latest: { value: T } | null = null;
  const submit = (value: T): void => {
    latest = { value };
    if (shouldDefer()) {
      pending = { value };
      return;
    }
    pending = null;
    apply(value);
  };
  return {
    submit,
    flush: () => {
      if (pending !== null && !shouldDefer()) {
        const { value } = pending;
        pending = null;
        apply(value);
      }
    },
    resubmitLatest: () => {
      if (latest !== null) {
        submit(latest.value);
      }
    },
  };
};
