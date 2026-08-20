/**
 * App entry: one initial snapshot read, then daemon pushes via the Rust
 * host's file watch (snapshot-changed events). The OFFLINE check is a
 * one-shot timer scheduled at the payload's actual expiry (mtime + the
 * staleness threshold, re-armed per healthy ingest), so a dead daemon
 * renders OFFLINE within one threshold of its last publish; a slow 10s
 * pass retries real reads while degraded (self-healing a missed event or
 * a late-starting daemon) and carries the quota read, whose file the watch
 * does not cover. Layout reduces with the strip geometry and re-renders
 * only when the serialized key models change (so CSS status animations are
 * never restarted). Page settings persist to localStorage; the reducer
 * validates them on every read. A 1s timer ticks the rail clock and the
 * per-tile status timers in place.
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
import { createGestureRecognizer, type GestureInput, type GestureIntent, type GesturePoint } from "./gestures";
import { pressSessionTile } from "./press";
import { type QuotaPanelModel, reduceQuotaRead } from "./quota";
import { renderRail } from "./rail";
import { countUnreadSessions, msUntilStale, reduceSnapshotRead } from "./snapshot-view";
import { renderTiles, statusLineText, stripGridLayout, visibleStripKeys } from "./tiles";
import { startStripWindowManager } from "./window";

const SLOW_PASS_MS = 10_000;
const SETTINGS_KEY = "agent-strip.layout.v1";

let lastGood: SessionSnapshotV2 | null = null;
let renderedSignature = "";
let currentView: SnapshotView | null = null;
let lastReadMtimeMs: number | null = null;
let lastPayload: SnapshotPayload | null = null;
let currentQuota: QuotaPanelModel[] = [];
let stalenessTimer: ReturnType<typeof setTimeout> | null = null;
let currentPage = 0;
let currentPageCount = 1;
let currentKeys: readonly KeyModel[] = [];

type PendingLongPress = { index: number; tile: HTMLElement; point: GesturePoint };

const gestures = createGestureRecognizer();
let gestureTimer: number | null = null;
let pendingLongPress: PendingLongPress | null = null;
let suppressNextClick = false;

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

const clearExpiryCheck = (): void => {
  if (stalenessTimer !== null) {
    clearTimeout(stalenessTimer);
    stalenessTimer = null;
  }
};

/**
 * The OFFLINE flip, scheduled at the payload's actual expiry rather than on
 * a fixed cadence: a periodic check can straddle the staleness boundary and
 * hold a healthy verdict for a full extra period (OFFLINE up to twice the
 * threshold after death), while a check fired at mtime + threshold flips it
 * within one threshold. Exactly one timer exists — each healthy ingest
 * reschedules it, so a live daemon's 5s heartbeat keeps pushing it out and
 * it only ever fires after the daemon stops publishing.
 */
const scheduleExpiryCheck = (payload: SnapshotPayload): void => {
  clearExpiryCheck();
  const delay = msUntilStale(payload, Date.now());
  if (delay === null) {
    return;
  }
  stalenessTimer = setTimeout(() => {
    stalenessTimer = null;
    // At expiry the last payload is past the threshold, so a re-read either
    // degrades to OFFLINE (dead daemon, same old mtime) or recovers
    // instantly when only the push event was missed and the file is fresh.
    void readAndIngest();
  }, delay);
};

const ingest = (payload: SnapshotPayload | null): void => {
  lastPayload = payload;
  lastReadMtimeMs = payload === null ? null : payload.mtimeMs;
  const reduction = reduceSnapshotRead(payload, lastGood, Date.now());
  lastGood = reduction.lastGood;
  currentView = reduction.view;
  applyLayout(reduceLayout(reduction.view, loadStoredSettings(), STRIP_GEOMETRY));
  // A healthy view arms the one-shot expiry check; a degraded one disarms it
  // — the slow pass owns re-reads until a fresh payload re-arms it.
  if (payload !== null && !reduction.view.degraded) {
    scheduleExpiryCheck(payload);
  } else {
    clearExpiryCheck();
  }
};

const readAndIngest = async (): Promise<void> => {
  ingest(await readSnapshot().catch(() => null));
};

/**
 * The slow degraded-recovery pass (the push stream is the healthy update
 * path): while degraded it retries a real read, self-healing a missed event
 * or a late-starting daemon; while healthy it touches no snapshot state —
 * the expiry check owns the OFFLINE flip. The quota snapshot also rides
 * this pass — the watch pushes snapshot-v2.json only, that file changes at
 * most every 120s, and a rejection is a missing file, i.e. "no data yet".
 */
const slowPass = async (): Promise<void> => {
  currentQuota = reduceQuotaRead(await readQuotaSnapshot().catch(() => null), Date.now());
  if (lastPayload !== null && currentView !== null && !currentView.degraded) {
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
  // The first slow pass doubles as the initial read: with no payload yet it
  // falls through to readAndIngest (and rides the quota read).
  void slowPass();
  void onSnapshotChanged(ingest);
  setInterval(() => {
    void slowPass();
  }, SLOW_PASS_MS);
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
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
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

const tileFromPointerEvent = (event: PointerEvent): PendingLongPress | null => {
  if (!(event.target instanceof HTMLElement)) {
    return null;
  }
  const tile = event.target.closest<HTMLElement>("[data-key-index]");
  if (tile === null) {
    return null;
  }
  const index = Number(tile.dataset["keyIndex"]);
  const model = currentKeys[index];
  if (model === undefined || model.kind !== "session") {
    return null;
  }
  return { index, tile, point: { x: event.clientX, y: event.clientY } };
};

const handleGestureIntents = (intents: readonly GestureIntent[]): void => {
  for (const intent of intents) {
    switch (intent.kind) {
      case "longpress":
        if (pendingLongPress !== null) {
          flashTile(pendingLongPress.tile); // Task 4 replaces the flash with the action sheet.
        }
        break;
      case "suppress-click":
        suppressNextClick = true;
        break;
    }
  }
};

const scheduleLongPressTimer = (): void => {
  if (gestureTimer !== null) {
    clearTimeout(gestureTimer);
    gestureTimer = null;
  }
  const dueAt = gestures.longPressDueAt();
  if (dueAt !== null) {
    gestureTimer = setTimeout(
      () => {
        gestureTimer = null;
        handleGestureIntents(gestures.feed({ kind: "tick", now: Date.now() }));
      },
      Math.max(0, dueAt - Date.now()),
    );
  }
};

const feedPointer = (input: GestureInput): void => {
  handleGestureIntents(gestures.feed(input));
  scheduleLongPressTimer();
};

const onStripPointerDown = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  pendingLongPress = tileFromPointerEvent(event);
  feedPointer({ kind: "down", point: { x: event.clientX, y: event.clientY }, now: Date.now() });
};

const onStripPointerMove = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  feedPointer({ kind: "move", point: { x: event.clientX, y: event.clientY }, now: Date.now() });
};

const onStripPointerUp = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  feedPointer({ kind: "up", point: { x: event.clientX, y: event.clientY }, now: Date.now() });
  pendingLongPress = null;
};

const onStripPointerCancel = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  feedPointer({ kind: "cancel", now: Date.now() });
  pendingLongPress = null;
};

const wireInteraction = (): void => {
  document.querySelector<HTMLElement>("#tiles")?.addEventListener("click", onTilesClick);
  const strip = document.querySelector<HTMLElement>("#strip");
  strip?.addEventListener("pointerdown", onStripPointerDown);
  strip?.addEventListener("pointermove", onStripPointerMove);
  strip?.addEventListener("pointerup", onStripPointerUp);
  strip?.addEventListener("pointercancel", onStripPointerCancel);
};

start();
