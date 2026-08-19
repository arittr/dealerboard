/**
 * App entry: poll the daemon snapshot every 2s, reduce layout with the strip
 * geometry, and re-render only when the serialized key models change (so CSS
 * status animations are never restarted by a no-op poll). Page settings
 * persist to localStorage; the reducer validates them on every read.
 */

import { type LayoutResult, reduceLayout, STRIP_GEOMETRY } from "../../src/plugin/layout";
import type { SessionSnapshotV2, SnapshotView } from "../../src/protocol";
import { readSnapshot } from "./bridge";
import { renderRail } from "./rail";
import { reduceSnapshotRead } from "./snapshot-view";
import { renderTiles } from "./tiles";

const POLL_MS = 2000;
const SETTINGS_KEY = "agent-strip.layout.v1";

let lastGood: SessionSnapshotV2 | null = null;
let renderedSignature = "";
let currentView: SnapshotView | null = null;
let lastReadMtimeMs: number | null = null;
let currentPage = 0;
let currentPageCount = 1;

const loadStoredSettings = (): unknown => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
  } catch {
    return null;
  }
};

const persistSettings = (settings: unknown): void => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Best effort: a dropped page preference re-derives on the next poll.
  }
};

/**
 * Grid-visible unread, exact only for idle: the projection admits
 * read-and-idle rows solely off the grid, so an on-grid idle tile is unread
 * for certain. Error tiles are counted as news even though an acked error
 * row lingers on-grid until its next lifecycle event — an accepted overcount,
 * since the wire format carries no unread field; a daemon-side unread flag
 * would make this exact.
 */
const unreadCount = (view: SnapshotView): number =>
  view.snapshot.sessions.filter((session) => session.status === "idle" || session.status === "error").length;

const jumpToPage = (page: number): void => {
  if (currentView === null) {
    return;
  }
  applyLayout(
    reduceLayout(currentView, { schemaVersion: 1, overflowLatched: true, currentPage: page }, STRIP_GEOMETRY),
  );
  // renderRailNow is declared below; referenced here only at click time.
  renderRailNow();
};

const renderRailNow = (): void => {
  const root = document.querySelector<HTMLElement>("#rail");
  if (root === null || currentView === null) {
    return;
  }
  renderRail(
    root,
    {
      degraded: currentView.degraded,
      heartbeatAgeMs: lastReadMtimeMs === null ? null : Date.now() - lastReadMtimeMs,
      unreadCount: unreadCount(currentView),
      page: currentPage + 1,
      pageCount: currentPageCount,
      now: new Date(),
    },
    { onJumpToPage: jumpToPage },
  );
};

const applyLayout = (layout: LayoutResult): void => {
  if (layout.dirty) {
    persistSettings(layout.settings);
  }
  currentPage = layout.settings.currentPage;
  currentPageCount = layout.pageCount;
  const signature = JSON.stringify(layout.keys);
  const root = document.querySelector<HTMLElement>("#tiles");
  if (root !== null && signature !== renderedSignature) {
    renderedSignature = signature;
    renderTiles(root, layout.keys);
  }
};

const poll = async (): Promise<void> => {
  const payload = await readSnapshot().catch(() => null);
  const reduction = reduceSnapshotRead(payload, lastGood, Date.now());
  lastGood = reduction.lastGood;
  currentView = reduction.view;
  lastReadMtimeMs = payload?.mtimeMs ?? null;
  applyLayout(reduceLayout(reduction.view, loadStoredSettings(), STRIP_GEOMETRY));
};

const start = (): void => {
  void poll();
  setInterval(() => {
    void poll();
  }, POLL_MS);
  setInterval(renderRailNow, 1000);
};

start();
