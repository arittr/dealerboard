/**
 * App entry: one initial snapshot read, then daemon pushes via the Rust
 * host's file watch (snapshot-changed events). A slow 10s timer only
 * re-checks staleness (a dead daemon's heartbeat stops, rendering OFFLINE)
 * and retries real reads while degraded, so a missed event or a
 * late-starting daemon self-heals; it also carries the quota read, whose
 * file the watch does not cover. Layout reduces with the strip geometry
 * and re-renders only when the serialized key models change (so CSS status
 * animations are never restarted). Page settings persist to localStorage;
 * the reducer validates them on every read. A 1s timer ticks the rail
 * clock and the per-tile status timers in place.
 */

import { enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { type KeyModel, type LayoutResult, reduceLayout, STRIP_GEOMETRY } from "../../src/plugin/layout";
import type { SessionSnapshotV2, SessionStatus, SnapshotView } from "../../src/protocol";
import {
  ackSession,
  focusGhostty,
  onSnapshotChanged,
  openUrl,
  readPaseoServerId,
  readQuotaSnapshot,
  readSnapshot,
  type SnapshotPayload,
} from "./bridge";
import { pressSessionTile } from "./press";
import { type QuotaPanelModel, reduceQuotaRead } from "./quota";
import { renderRail } from "./rail";
import { countUnreadSessions, reduceSnapshotRead } from "./snapshot-view";
import { renderTiles, statusLineText, stripGridLayout, visibleStripKeys } from "./tiles";
import { startStripWindowManager } from "./window";

const STALENESS_CHECK_MS = 10_000;
const SETTINGS_KEY = "agent-strip.layout.v1";

let lastGood: SessionSnapshotV2 | null = null;
let renderedSignature = "";
let currentView: SnapshotView | null = null;
let lastReadMtimeMs: number | null = null;
let lastPayload: SnapshotPayload | null = null;
let currentQuota: QuotaPanelModel[] = [];
let currentPage = 0;
let currentPageCount = 1;
let currentKeys: readonly KeyModel[] = [];

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
    // Best effort: a dropped page preference re-derives on the next ingest.
  }
};

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
      unreadCount: countUnreadSessions(currentView.snapshot),
      quota: currentQuota,
      page: currentPage + 1,
      pageCount: currentPageCount,
      now: new Date(),
    },
    { onJumpToPage: jumpToPage },
  );
};

/**
 * Tick every rendered status timer's textContent in place. The DOM nodes and
 * the JSON render signature are untouched, so the renderedSignature skip and
 * the CSS status animations are never disturbed by a tick.
 */
const tickStatusLines = (): void => {
  const nowMs = Date.now();
  for (const line of document.querySelectorAll<HTMLElement>("#tiles .statusline")) {
    const status = line.dataset["status"];
    const since = line.dataset["since"];
    if (status === undefined || since === undefined) {
      continue;
    }
    const text = statusLineText(status as SessionStatus, since, nowMs);
    if (text !== null && line.textContent !== text) {
      line.textContent = text;
    }
  }
};

const applyLayout = (layout: LayoutResult): void => {
  if (layout.dirty) {
    persistSettings(layout.settings);
  }
  currentPage = layout.settings.currentPage;
  currentPageCount = layout.pageCount;
  const visible = visibleStripKeys(layout.keys);
  currentKeys = visible;
  const signature = JSON.stringify(visible);
  const root = document.querySelector<HTMLElement>("#tiles");
  if (root !== null) {
    const computedStyle = getComputedStyle(root);
    const gap = Number.parseFloat(computedStyle.columnGap);
    const grid = stripGridLayout(visible.length, {
      width: root.clientWidth,
      height: root.clientHeight,
      gap: Number.isFinite(gap) ? gap : 0,
    });
    root.style.setProperty("--tile-columns", String(grid.columnCount));
    root.style.setProperty("--tile-rows", String(grid.rowCount));
    root.style.setProperty("--tile-size", `${grid.tileSize}px`);
    if (signature !== renderedSignature) {
      renderedSignature = signature;
      renderTiles(root, visible);
    }
  }
};

const ingest = (payload: SnapshotPayload | null): void => {
  lastPayload = payload;
  lastReadMtimeMs = payload === null ? null : payload.mtimeMs;
  const reduction = reduceSnapshotRead(payload, lastGood, Date.now());
  lastGood = reduction.lastGood;
  currentView = reduction.view;
  applyLayout(reduceLayout(reduction.view, loadStoredSettings(), STRIP_GEOMETRY));
};

const readAndIngest = async (): Promise<void> => {
  ingest(await readSnapshot().catch(() => null));
};

/**
 * The staleness half of the old 2s poll: a healthy view only needs its file
 * age re-evaluated against the last payload (no snapshot I/O); a degraded
 * view retries a real read so a missed event or a late-starting daemon
 * self-heals. The quota snapshot rides this timer — the watch pushes
 * snapshot-v2.json only, that file changes at most every 120s, and a
 * rejection is a missing file, i.e. "no data yet".
 */
const checkStaleness = async (): Promise<void> => {
  currentQuota = reduceQuotaRead(await readQuotaSnapshot().catch(() => null), Date.now());
  if (lastPayload !== null && currentView !== null && !currentView.degraded) {
    ingest(lastPayload);
    return;
  }
  await readAndIngest();
};

const ensureAutostart = async (): Promise<void> => {
  try {
    if (!(await isEnabled())) {
      await enable();
    }
  } catch {
    // Login-item registration is best effort.
  }
};

const start = (): void => {
  void startStripWindowManager();
  void ensureAutostart();
  wireInteraction();
  // The first staleness run doubles as the initial read: with no payload yet
  // it falls through to readAndIngest (and rides the quota read).
  void checkStaleness();
  void onSnapshotChanged(ingest);
  setInterval(() => {
    void checkStaleness();
  }, STALENESS_CHECK_MS);
  setInterval(() => {
    renderRailNow();
    tickStatusLines();
  }, 1000);
};

const FLASH_MS = 320;

const flashTile = (tile: HTMLElement): void => {
  tile.classList.add("flash");
  setTimeout(() => tile.classList.remove("flash"), FLASH_MS);
};

const onTilesClick = (event: MouseEvent): void => {
  if (!(event.target instanceof HTMLElement)) {
    return;
  }
  const tile = event.target.closest<HTMLElement>("[data-key-index]");
  if (tile === null) {
    return;
  }
  const index = Number(tile.dataset["keyIndex"]);
  const model = currentKeys[index];
  if (model === undefined || model.kind !== "session") {
    return;
  }
  void pressSessionTile(model.session, {
    ack: ackSession,
    openUrl,
    focusGhostty,
    readPaseoServerId,
    flash: () => flashTile(tile),
  });
};

const wireInteraction = (): void => {
  document.querySelector<HTMLElement>("#tiles")?.addEventListener("click", onTilesClick);
};

start();
