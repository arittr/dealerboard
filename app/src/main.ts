/**
 * App entry: one initial snapshot read, then daemon pushes via the Rust
 * host's file watch (snapshot-changed events). The OFFLINE check is a
 * one-shot timer scheduled at the payload's actual expiry (mtime + the
 * staleness threshold, re-armed per healthy ingest), so a dead daemon
 * renders OFFLINE within one threshold of its last publish; a slow 10s
 * pass retries real reads while degraded (self-healing a missed event or
 * a late-starting daemon) and carries the quota read, whose file the watch
 * does not cover. Reads and pushes order through an ingest gate, so an
 * asynchronous read that completes after a newer push — or a newer read —
 * is dropped instead of regressing the view. Layout reduces with the strip
 * geometry and re-renders only when the serialized key models change (so
 * CSS status animations are never restarted). Page settings persist to
 * localStorage; the reducer validates them on every read. A 1s timer ticks
 * the per-tile status timers in place.
 */

import { enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { type KeyModel, type LayoutResult, reduceLayout, STRIP_GEOMETRY } from "../../src/plugin/layout";
import type { ProjectedSession, SessionSnapshotV2, SessionStatus, SnapshotView } from "../../src/protocol";
import {
  advanceSheetGeneration,
  beginSheetAction,
  buildSheetModel,
  buildSheetOverlay,
  initialSheetActionState,
  type SheetActionId,
  type SheetActionState,
  settleSheetAction,
  transcriptPathOf,
} from "./action-sheet";
import {
  ackSession,
  clearSession,
  focusGhostty,
  onSnapshotChanged,
  openUrl,
  readPaseoServerId,
  readQuotaSnapshot,
  readSnapshot,
  readTokenUsageSnapshot,
  revealTranscript,
  type SnapshotPayload,
} from "./bridge";
import {
  createClickSuppression,
  createGestureRecognizer,
  type GestureInput,
  type GestureIntent,
  type GesturePoint,
  swallowSuppressedClick,
} from "./gestures";
import { createIngestGate } from "./ingest-gate";
import { pressSessionTile } from "./press";
import { type QuotaPanelModel, reduceQuotaRead } from "./quota";
import { renderRail } from "./rail";
import { countUnreadSessions, msUntilStale, reduceSnapshotRead } from "./snapshot-view";
import { identityOf, resolveSessionTile, type SessionIdentity } from "./tile-identity";
import { renderTiles, statusLineText, stripGridLayout, visibleStripKeys } from "./tiles";
import { reduceTokenUsageRead, type TokenUsageRailModel } from "./token-usage";
import { startStripWindowManager } from "./window";

const SLOW_PASS_MS = 10_000;
const SETTINGS_KEY = "agent-strip.layout.v1";

let lastGood: SessionSnapshotV2 | null = null;
let renderedSignature = "";
let currentView: SnapshotView | null = null;
let lastReadMtimeMs: number | null = null;
let lastPayload: SnapshotPayload | null = null;
let currentQuota: QuotaPanelModel[] = [];
let currentTokenUsage: TokenUsageRailModel = { state: "hidden" };
let stalenessTimer: ReturnType<typeof setTimeout> | null = null;
let currentPage = 0;
let currentPageCount = 1;
let currentKeys: readonly KeyModel[] = [];
const ingestGate = createIngestGate();

/**
 * A pending long-press is bound to the pressed session's identity, never to
 * a dense tile index: a pushed snapshot can re-render the grid during the
 * 500ms hold, and an index captured at press time may already point at a
 * different session when the sheet opens.
 */
type PendingLongPress = { identity: SessionIdentity; point: GesturePoint };

const gestures = createGestureRecognizer();
const clickSuppression = createClickSuppression();
let gestureTimer: number | null = null;
let pendingLongPress: PendingLongPress | null = null;

type SheetContext = {
  point: GesturePoint;
  session: ProjectedSession;
  label: string;
  tile: HTMLElement;
};

let sheetOverlay: HTMLElement | null = null;
let sheetActions: SheetActionState = initialSheetActionState();
let sheetRestoreFocus: HTMLElement | null = null;

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
      tokens: currentTokenUsage,
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

/** Pushes are handled synchronously, so a push is the freshest source by
 * construction: it claims the newest slot, invalidating any read that is
 * still outstanding. */
const ingestPush = (payload: SnapshotPayload): void => {
  ingestGate.next();
  ingest(payload);
};

const readAndIngest = async (): Promise<void> => {
  const token = ingestGate.next();
  const payload = await readSnapshot().catch(() => null);
  if (!ingestGate.isCurrent(token)) {
    // A newer push or read won while this one was in flight: its older
    // payload — or its failed-read null — must not regress the view.
    return;
  }
  ingest(payload);
};

/**
 * The slow degraded-recovery pass (the push stream is the healthy update
 * path): while degraded it retries a real read, self-healing a missed event
 * or a late-starting daemon; while healthy it touches no snapshot state —
 * the expiry check owns the OFFLINE flip. The quota and token-usage
 * snapshots also ride this pass — the watch pushes snapshot-v2.json only,
 * those files change at most every 120s, and a rejection is a missing
 * file, i.e. "no data yet".
 */
const slowPass = async (): Promise<void> => {
  currentQuota = reduceQuotaRead(await readQuotaSnapshot().catch(() => null), Date.now());
  currentTokenUsage = reduceTokenUsageRead(await readTokenUsageSnapshot().catch(() => null), Date.now());
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

const start = async (): Promise<void> => {
  void startStripWindowManager();
  void ensureAutostart();
  wireInteraction();
  // Arm the push subscription before the first read so no publication can
  // land in the gap between the two; both sources order through the gate.
  try {
    await onSnapshotChanged(ingestPush);
  } catch {
    // A failed subscription falls back to the read paths (slow pass,
    // expiry re-check); push delivery only narrows their latency.
  }
  // The first slow pass doubles as the initial read: with no payload yet it
  // falls through to readAndIngest (and rides the quota read).
  void slowPass();
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
  return { identity: identityOf(model.session), point: { x: event.clientX, y: event.clientY } };
};

const removeSheetOverlay = (): void => {
  if (sheetOverlay !== null) {
    sheetOverlay.remove();
    sheetOverlay = null;
    sheetRestoreFocus?.focus();
    sheetRestoreFocus = null;
  }
};

/**
 * User dismissal (backdrop, Escape, the Open action) always wins: it ends
 * the sheet instance, so any action settlement still in flight becomes a
 * stale no-op.
 */
const dismissActionSheet = (): void => {
  sheetActions = advanceSheetGeneration(sheetActions);
  removeSheetOverlay();
};

const clipboardAvailable = (): boolean => "clipboard" in navigator;

const openActionSheet = (context: SheetContext, error: string | null = null): void => {
  // Only the first open of a sheet session captures the focus to restore;
  // re-renders (armed clear, in-flight disable, error retry) must keep the
  // original capture.
  if (sheetOverlay === null) {
    sheetRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  sheetOverlay?.remove(); // re-render path keeps the sheet-action state
  const model = buildSheetModel(context.session, {
    title: context.label,
    clipboardAvailable: clipboardAvailable(),
    clearArmed: sheetActions.clearArmed,
    pendingAction: sheetActions.pendingAction,
    error,
  });
  const overlay = buildSheetOverlay(model, {
    onAction: (id) => {
      void runSheetAction(context, id);
    },
    onDismiss: dismissActionSheet,
  });
  document.body.append(overlay);
  const sheet = overlay.querySelector<HTMLElement>(".action-sheet");
  if (sheet !== null) {
    const x = Math.min(
      Math.max(context.point.x, sheet.offsetWidth / 2 + 8),
      window.innerWidth - sheet.offsetWidth / 2 - 8,
    );
    const y = Math.min(Math.max(context.point.y, sheet.offsetHeight + 8), window.innerHeight - 8);
    sheet.style.left = `${x - sheet.offsetWidth / 2}px`;
    sheet.style.top = `${y - sheet.offsetHeight}px`; // above the finger
  }
  // Move focus into the dialog: keyboard and assistive tech land on its
  // first actionable item instead of staying behind the modal backdrop.
  overlay.querySelector<HTMLElement>("button.sheet-item:not(:disabled)")?.focus();
  sheetOverlay = overlay;
};

/**
 * Only success dismisses: a failure re-renders the sheet with an inline
 * error, keeping the retry surface open — above all for Clear, whose
 * destructive miss must never look accepted. Each settlement is bound to
 * the sheet instance (generation) it was fired from; a stale generation is
 * a no-op — user dismissal wins.
 */
const applySheetSettlement = (succeeded: boolean, context: SheetContext, generation: number, failure: string): void => {
  const outcome = settleSheetAction(sheetActions, generation, succeeded);
  sheetActions = outcome.state;
  if (outcome.dismissed) {
    removeSheetOverlay();
  } else if (outcome.reopen) {
    openActionSheet(context, failure);
  }
};

const trackSheetAction = (action: Promise<void>, context: SheetContext, generation: number, failure: string): void => {
  void action.then(
    () => applySheetSettlement(true, context, generation, failure),
    () => applySheetSettlement(false, context, generation, failure),
  );
};

const runSheetAction = async (context: SheetContext, id: SheetActionId): Promise<void> => {
  const begin = beginSheetAction(sheetActions, id);
  sheetActions = begin.state;
  if (!begin.fire) {
    openActionSheet(context); // armed "Confirm clear" (or a blocked duplicate tap): re-render
    return;
  }
  // Re-render with every action disabled while the settlement is in flight.
  openActionSheet(context);
  const generation = sheetActions.generation;
  const { session, tile } = context;
  switch (id) {
    case "open":
      // Routing failures already surface through pressSessionTile's tile
      // flash; the sheet's job is done either way.
      dismissActionSheet();
      void pressSessionTile(session, {
        ack: ackSession,
        openUrl,
        focusGhostty,
        readPaseoServerId,
        flash: () => flashTile(tile),
      });
      return;
    case "ack":
      return trackSheetAction(ackSession(session.provider, session.sessionId), context, generation, "Ack failed");
    case "reveal": {
      const path = transcriptPathOf(session);
      if (path === null) {
        dismissActionSheet(); // disabled-button drift: nothing to reveal
        return;
      }
      return trackSheetAction(revealTranscript(path), context, generation, "Reveal failed");
    }
    case "copy":
      if (!clipboardAvailable()) {
        dismissActionSheet(); // disabled-button drift: nothing to copy
        return;
      }
      return trackSheetAction(navigator.clipboard.writeText(session.sessionId), context, generation, "Copy failed");
    case "clear":
      return trackSheetAction(clearSession(session.provider, session.sessionId), context, generation, "Clear failed");
  }
};

const openActionSheetFor = (pending: PendingLongPress): void => {
  // Resolve by identity against the current keys: if the pressed session
  // left the grid during the hold, cancel — never retarget the sheet (and
  // its Clear action) at whichever session shifted into the old index.
  const ref = resolveSessionTile(currentKeys, pending.identity);
  if (ref === null) {
    return;
  }
  const tile = document.querySelector<HTMLElement>(`#tiles [data-key-index="${ref.index}"]`);
  if (tile === null) {
    return;
  }
  sheetActions = advanceSheetGeneration(sheetActions);
  openActionSheet({ point: pending.point, session: ref.session, label: ref.label, tile });
};

/**
 * Installing the overlay steals this stroke's release: a mouse pointer
 * carries no implicit capture, so the physical up retargets to the sheet
 * and never reaches #strip — leaving the recognizer holding a live stroke
 * whose stale up would eat the next tap. Close the stroke here,
 * deterministically; its emitted suppress-click keeps this stroke's
 * trailing click swallowed (Task 3's stroke-scoped contract).
 */
const settleLongPressStroke = (point: GesturePoint): void => {
  handleGestureIntents(gestures.feed({ kind: "up", point, now: Date.now() }));
};

const onSwipe = (direction: "previous" | "next"): void => {
  if (currentView === null || currentPageCount <= 1) {
    return;
  }
  const delta = direction === "next" ? 1 : -1;
  jumpToPage(Math.min(Math.max(currentPage + delta, 0), currentPageCount - 1));
};

const handleGestureIntents = (intents: readonly GestureIntent[]): void => {
  for (const intent of intents) {
    switch (intent.kind) {
      case "swipe":
        onSwipe(intent.direction);
        break;
      case "longpress": {
        const pending = pendingLongPress;
        if (pending !== null) {
          pendingLongPress = null;
          settleLongPressStroke(pending.point); // before the overlay takes the pointer
          openActionSheetFor(pending);
        }
        break;
      }
      case "suppress-click":
        clickSuppression.arm();
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
  // Suppression belongs to one stroke, and a touch drag fires no trailing
  // click at all — so any still-unconsumed suppression from the last stroke
  // dies here rather than eating this stroke's taps.
  clickSuppression.beginStroke();
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

/**
 * Consume suppression in the capture phase on #strip — before the click
 * reaches any target: a moved stroke released on a page dot would
 * otherwise page-jump, because the dot's own listener fires in the target
 * phase, ahead of any bubble-phase consumer on an ancestor. A suppressed
 * click is prevented and stopped outright; clean clicks pass untouched.
 */
const onStripClickCapture = (event: MouseEvent): void => {
  swallowSuppressedClick(clickSuppression, event);
};

/**
 * macOS delivers a Xeneon touch-and-hold as a synthesized secondary click,
 * and an uncanceled contextmenu event makes WKWebView answer with its native
 * fallback menu (the lone "Refresh" item) — a native menu opening warps the
 * cursor onto the strip display. The pointer must never be moved to the
 * panel, so every context menu in this window is suppressed at the document
 * root, whatever its source (touch hold, mouse right-click). Debug builds
 * keep inspection: Safari's Develop menu attaches to the webview directly.
 */
const onContextMenu = (event: MouseEvent): void => {
  event.preventDefault();
};

const wireInteraction = (): void => {
  document.querySelector<HTMLElement>("#tiles")?.addEventListener("click", onTilesClick);
  const strip = document.querySelector<HTMLElement>("#strip");
  strip?.addEventListener("pointerdown", onStripPointerDown);
  strip?.addEventListener("pointermove", onStripPointerMove);
  strip?.addEventListener("pointerup", onStripPointerUp);
  strip?.addEventListener("pointercancel", onStripPointerCancel);
  strip?.addEventListener("click", onStripClickCapture, true);
  document.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      dismissActionSheet();
    }
  });
};

void start();
