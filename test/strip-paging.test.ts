import { describe, expect, test } from "bun:test";
import {
  COMMIT_FRACTION,
  COMMIT_VELOCITY_PX_PER_MS,
  createDeferredLatest,
  createPagingSession,
  type DragBounds,
  dragOffset,
  RUBBER_BAND_FACTOR,
  settleDrag,
} from "../app/src/paging";

const BOARD_WIDTH = 1000;

const bounds = (overrides: Partial<DragBounds> = {}): DragBounds => ({
  page: 1,
  pageCount: 3,
  boardWidth: BOARD_WIDTH,
  ...overrides,
});

// Symbolic-constant contract (see the plan header): displacements derive from
// COMMIT_FRACTION against the named test board so Task 9 tuning cannot break
// the suite. BELOW is also the fling test's below-distance displacement.
const PAST = BOARD_WIDTH * COMMIT_FRACTION + 60; // commits by distance at any tuning
const BELOW = (BOARD_WIDTH * COMMIT_FRACTION) / 2; // never commits by distance

describe("dragOffset", () => {
  test("tracks the finger 1:1 toward an existing page", () => {
    expect(dragOffset(-320, bounds())).toBe(-320);
    expect(dragOffset(240, bounds())).toBe(240);
  });

  test("rubber-bands where no page exists — the give itself says nowhere to go", () => {
    expect(dragOffset(-320, bounds({ page: 2 }))).toBe(-320 * RUBBER_BAND_FACTOR);
    expect(dragOffset(240, bounds({ page: 0 }))).toBe(240 * RUBBER_BAND_FACTOR);
    // Resistance is per-direction: page 0 still pulls next freely.
    expect(dragOffset(-320, bounds({ page: 0 }))).toBe(-320);
    // A single page resists both ways.
    expect(dragOffset(-320, bounds({ page: 0, pageCount: 1 }))).toBe(-320 * RUBBER_BAND_FACTOR);
  });

  test("clamps to one page of travel", () => {
    expect(dragOffset(-BOARD_WIDTH * 1.4, bounds())).toBe(-BOARD_WIDTH);
    expect(dragOffset(BOARD_WIDTH * 1.4, bounds())).toBe(BOARD_WIDTH);
  });
});

describe("settleDrag", () => {
  test("commits past the distance threshold, carrying its origin and target pages", () => {
    expect(settleDrag(-COMMIT_FRACTION * BOARD_WIDTH, 0, bounds())).toEqual({
      kind: "commit",
      direction: "next",
      from: 1,
      target: 2,
    });
    expect(settleDrag(COMMIT_FRACTION * BOARD_WIDTH, 0, bounds())).toEqual({
      kind: "commit",
      direction: "previous",
      from: 1,
      target: 0,
    });
  });

  test("snaps back below the threshold without a fling", () => {
    expect(settleDrag(-COMMIT_FRACTION * BOARD_WIDTH + 1, 0, bounds())).toEqual({ kind: "snap-back" });
  });

  test("a direction-matched fling commits below the distance threshold", () => {
    expect(settleDrag(-BELOW, -COMMIT_VELOCITY_PX_PER_MS, bounds())).toMatchObject({
      kind: "commit",
      direction: "next",
    });
    expect(settleDrag(BELOW, COMMIT_VELOCITY_PX_PER_MS, bounds())).toMatchObject({
      kind: "commit",
      direction: "previous",
    });
  });

  test("a fling opposing the displacement does not commit", () => {
    expect(settleDrag(-BELOW, COMMIT_VELOCITY_PX_PER_MS * 2, bounds())).toEqual({ kind: "snap-back" });
  });

  test("never commits toward a page that does not exist, however hard the fling", () => {
    expect(settleDrag(-2 * PAST, -9, bounds({ page: 2 }))).toEqual({ kind: "snap-back" });
    expect(settleDrag(2 * PAST, 9, bounds({ page: 0 }))).toEqual({ kind: "snap-back" });
  });

  test("a zero-displacement release snaps back", () => {
    expect(settleDrag(0, -9, bounds())).toEqual({ kind: "snap-back" });
  });
});

describe("createPagingSession", () => {
  test("phases gate snapshot deferral: idle applies, dragging and settling defer", () => {
    const session = createPagingSession();
    expect(session.phase()).toBe("idle");
    expect(session.defersSnapshots()).toBe(false);
    expect(session.start(bounds())).toBe(true);
    expect(session.phase()).toBe("dragging");
    expect(session.defersSnapshots()).toBe(true);
    expect(session.release(-PAST, 0)).toEqual({ kind: "commit", direction: "next", from: 1, target: 2 });
    expect(session.phase()).toBe("settling");
    expect(session.defersSnapshots()).toBe(true);
    session.settled();
    expect(session.phase()).toBe("idle");
    expect(session.defersSnapshots()).toBe(false);
  });

  test("settle re-entry: a settling board is not grabbable, and stray verdicts are nobody's", () => {
    const session = createPagingSession();
    expect(session.release(-BELOW, 0)).toBeNull(); // no drag ever started
    expect(session.start(bounds({ page: 0 }))).toBe(true);
    expect(session.release(-PAST, 0)).toEqual({ kind: "commit", direction: "next", from: 0, target: 1 });
    expect(session.start(bounds({ page: 0 }))).toBe(false); // refused mid-settle
    expect(session.phase()).toBe("settling");
    expect(session.release(-BELOW, 0)).toBeNull(); // the refused stroke settles nothing
    expect(session.cancel()).toBeNull(); // and cannot cancel the live settle either
    session.settled();
    expect(session.start(bounds({ page: 1 }))).toBe(true);
  });

  test("navigation is gated while a gesture or settle owns the board", () => {
    const session = createPagingSession();
    expect(session.allowsNavigation()).toBe(true);
    session.start(bounds());
    expect(session.allowsNavigation()).toBe(false);
    session.release(-PAST, 0);
    expect(session.allowsNavigation()).toBe(false);
    session.settled();
    expect(session.allowsNavigation()).toBe(true);
  });

  test("move answers offsets only while dragging — a refused stroke must not touch the track", () => {
    const session = createPagingSession();
    expect(session.move(-BELOW)).toBeNull();
    session.start(bounds({ page: 2 }));
    expect(session.move(-BELOW)).toBe(-BELOW * RUBBER_BAND_FACTOR);
    session.release(-BELOW, 0);
    expect(session.move(-BELOW)).toBeNull();
  });

  test("cancel settles a live drag as snap-back", () => {
    const session = createPagingSession();
    session.start(bounds());
    expect(session.cancel()).toEqual({ kind: "snap-back" });
    expect(session.phase()).toBe("settling");
  });
});

describe("createDeferredLatest", () => {
  test("defers during a gesture and applies the newest exactly once at settle", () => {
    const session = createPagingSession();
    const applied: number[] = [];
    const deferral = createDeferredLatest<number>(session.defersSnapshots, (value) => applied.push(value));
    deferral.submit(1); // idle: applies immediately
    session.start(bounds());
    deferral.submit(2);
    deferral.submit(3); // latest wins
    session.release(-PAST, 0);
    deferral.flush(); // still settling: nothing applies
    expect(applied).toEqual([1]);
    session.settled();
    deferral.flush();
    expect(applied).toEqual([1, 3]);
    deferral.flush(); // exactly once
    expect(applied).toEqual([1, 3]);
  });

  test("a direct apply supersedes any stale stash", () => {
    const session = createPagingSession();
    const applied: number[] = [];
    const deferral = createDeferredLatest<number>(session.defersSnapshots, (value) => applied.push(value));
    session.start(bounds());
    deferral.submit(2);
    session.release(-PAST, 0);
    session.settled();
    deferral.submit(4); // idle again: applies directly and drops the stashed 2
    deferral.flush();
    expect(applied).toEqual([4]);
  });

  test("a local re-submission never resurrects an older payload over a deferred one", () => {
    // The dismissal-flick composition the review flagged: A applied, a drag
    // defers B, the flick's settle re-reduces locally — it must re-submit the
    // NEWEST payload (B), not a driver-held copy of A.
    const session = createPagingSession();
    const applied: number[] = [];
    const deferral = createDeferredLatest<number>(session.defersSnapshots, (value) => applied.push(value));
    deferral.submit(1); // A: idle, applies
    session.start(bounds());
    deferral.submit(2); // B: deferred
    deferral.resubmitLatest(); // the flick settles mid-drag: latest is B, stash stays B
    session.release(-PAST, 0);
    session.settled();
    deferral.flush();
    expect(applied).toEqual([1, 2]); // B once — A never came back
  });

  test("resubmitLatest with no deferral re-applies the newest immediately; before any submit it is a no-op", () => {
    const session = createPagingSession();
    const applied: number[] = [];
    const deferral = createDeferredLatest<number>(session.defersSnapshots, (value) => applied.push(value));
    deferral.resubmitLatest(); // nothing ever submitted
    expect(applied).toEqual([]);
    deferral.submit(7);
    deferral.resubmitLatest(); // idle: the local re-reduction applies now
    expect(applied).toEqual([7, 7]);
  });
});
