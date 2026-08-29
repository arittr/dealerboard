/**
 * App entry: one initial snapshot read, then daemon pushes via the Rust
 * host's file watch (snapshot-changed events). The OFFLINE check is a
 * one-shot timer scheduled at the payload's actual expiry (mtime + the
 * staleness threshold, re-armed per healthy ingest), so a dead daemon
 * renders OFFLINE within one threshold of its last publish; a slow 10s
 * pass retries real reads while degraded (self-healing a missed event or
 * a late-starting daemon) and carries the quota and token-usage sidecar
 * reads (quota-snapshot.json, republished at most every 120s;
 * token-usage-snapshot.json, every 30s), whose files the watch
 * does not cover. Reads and pushes order through an ingest gate, so an
 * asynchronous read that completes after a newer push — or a newer read —
 * is dropped instead of regressing the view. The board reduces from the
 * snapshot (grouped, paged) and re-renders only when the serialized page
 * cards change (so CSS status animations are never restarted). Page settings
 * persist to localStorage; the reducer validates them on every read. A 1s
 * timer ticks the per-card status timers in place.
 */

import { enable, isEnabled } from "@tauri-apps/plugin-autostart";
import type { SessionSnapshotV2, SnapshotView } from "../../src/protocol";
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
import { type BoardPage, type BoardResult, type BoardSession, jumpBoard, type PlacedCard, reduceBoard } from "./board";
import {
  ackSession,
  clearSession,
  focusGhostty,
  type GestureWatermark,
  onSnapshotChanged,
  openUrl,
  readPaseoServerId,
  readQuotaSnapshot,
  readSnapshot,
  readTokenUsageSnapshot,
  revealTranscript,
  type SnapshotPayload,
  viewSession,
} from "./bridge";
import { ageLineText, boardRenderSignature, cardKey, renderBoard, sessionLastEventAt } from "./cards";
import { createPointerDiagnostic, mountPointerDiagnostic, POINTER_DIAGNOSTIC_ENABLED } from "./diagnostic";
import { createDismissals, flickRemoves } from "./dismissals";
/**
 * A pending press is bound to the pressed session's identity, never to a
 * dense tile index: a pushed snapshot can re-render the grid during the
 * stroke, and an index captured at press time may already point at a
 * different session when the long-press sheet opens, the flick lands, or
 * the trailing click settles the tap.
 */
import { capturePendingPress, type PendingPress, resolvePendingPress } from "./gesture-target";
import {
  createClickSuppression,
  createGestureRecognizer,
  type GestureInput,
  type GestureIntent,
  type GesturePoint,
  swallowSuppressedClick,
} from "./gestures";
import {
  indicatorsRenderSignature,
  peekModel,
  pipColumnModel,
  renderPeekBand,
  renderPips,
  renderReturnBand,
  returnSliverModel,
} from "./indicators";
import { createIngestGate } from "./ingest-gate";
import { elapsedLabel, livenessFrame, PULSE_SWEEP_MS, type PulseEntry, planPulses } from "./liveness";
import { createDeferredLatest, createPagingSession, type DragSettle } from "./paging";
import { pressBoardCard, pressSessionTile } from "./press";
import { type QuotaPanelModel, reduceQuotaRead } from "./quota";
import { railRenderSignature, renderRail } from "./rail";
import { countUnreadSessions, msUntilStale, reduceSnapshotRead } from "./snapshot-view";
import { reduceTokenUsageRead, type TokenUsageRailModel } from "./token-usage";
import { startStripWindowManager } from "./window";

const SLOW_PASS_MS = 10_000;
const SETTINGS_KEY = "agent-strip.layout.v1";

let lastGood: SessionSnapshotV2 | null = null;
let renderedSignature = "";
let railRenderedSignature = "";
let indicatorsRenderedSignature = "";
let pulseEntries: ReadonlyMap<string, PulseEntry> = new Map();
let currentView: SnapshotView | null = null;
let lastPayload: SnapshotPayload | null = null;
let currentQuota: QuotaPanelModel[] = [];
let currentTokenUsage: TokenUsageRailModel = { state: "hidden" };
let stalenessTimer: ReturnType<typeof setTimeout> | null = null;
let currentPage = 0;
let currentPageCount = 1;
let currentPages: readonly BoardPage[] = [];
let currentCards: readonly PlacedCard[] = [];
const ingestGate = createIngestGate();

const gestures = createGestureRecognizer();
const pagingSession = createPagingSession();
// Every snapshot ingest routes through this latch: mid-gesture payloads
// stash (latest wins) and apply once at settle. ingestNow is defined below;
// the closure only runs at call time.
const snapshotDeferral = createDeferredLatest<SnapshotPayload | null>(
  () => pagingSession.defersSnapshots(),
  (payload) => ingestNow(payload),
);
const clickSuppression = createClickSuppression();
const dismissals = createDismissals();
let gestureTimer: number | null = null;
/** The press of the stroke in progress: captured at pointer-down, consumed by a long-press or flick. */
let pendingPress: PendingPress | null = null;
/**
 * The press a finished stroke handed to its trailing click: a clean tap's
 * click arrives after pointer-up, so the capture outlives the stroke until
 * the click settles it. Dropped when the next stroke begins (a moved
 * stroke's click is swallowed, and a touch drag fires none), so it can
 * never settle under a later tap.
 */
let pressAwaitingClick: PendingPress | null = null;
// Bring-up pointer diagnostic (removed with app/src/diagnostic.ts).
const diagnostic = POINTER_DIAGNOSTIC_ENABLED ? createPointerDiagnostic(Date.now) : null;

type SheetContext = {
  point: GesturePoint;
  session: BoardSession;
  label: string;
  tile: HTMLElement;
  /** The pointer-down watermark: the sheet's Open and Dismiss consume only what the press saw. */
  watermark: GestureWatermark;
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
  if (currentView === null || !pagingSession.allowsNavigation()) {
    return;
  }
  const from = currentPage;
  // jumpBoard reports a page change as dirty, so applyBoard persists it and
  // later ingests (which reduce from the persisted settings) keep the page.
  applyBoard(jumpBoard(currentView, loadStoredSettings(), page));
  diagnostic?.recordNavigation(from, currentPage);
};

const renderRailNow = (): void => {
  const root = document.querySelector<HTMLElement>("#rail");
  if (root === null || currentView === null) {
    return;
  }
  const model = {
    degraded: currentView.degraded,
    unreadCount: countUnreadSessions(currentView.snapshot),
    quota: currentQuota,
    tokens: currentTokenUsage,
    now: new Date(),
  };
  // Skip the rebuild while nothing rendered would change: the 1s cadence
  // exists only for countdown minute rollovers, and rebuilding every second
  // would replace the quota layout out from under an in-flight tap.
  const signature = railRenderSignature(model);
  if (signature === railRenderedSignature) {
    return;
  }
  railRenderedSignature = signature;
  renderRail(root, model);
};

/** The three indicator surfaces re-render together, signature-skipped so a
 *  heartbeat ingest never detaches a pip mid-press. */
const renderIndicatorsNow = (): void => {
  const returnRoot = document.querySelector<HTMLElement>("#return-band");
  const peekRoot = document.querySelector<HTMLElement>("#peek-band");
  const pipsRoot = document.querySelector<HTMLElement>("#pips");
  if (returnRoot === null || peekRoot === null || pipsRoot === null) {
    return;
  }
  const returnBand = returnSliverModel(currentPages, currentPage);
  const peek = peekModel(currentPages, currentPage);
  const pips = pipColumnModel(currentPages, currentPage);
  const signature = indicatorsRenderSignature(returnBand, peek, pips);
  if (signature === indicatorsRenderedSignature) {
    return;
  }
  indicatorsRenderedSignature = signature;
  renderReturnBand(returnRoot, returnBand);
  renderPeekBand(peekRoot, peek);
  renderPips(pipsRoot, pips, { onJumpToPage: jumpToPage });
};

/**
 * Tick every rendered status timer's textContent in place. The DOM nodes and
 * the JSON render signature are untouched, so the renderedSignature skip and
 * the CSS status animations are never disturbed by a tick.
 */
const tickStatusLines = (): void => {
  const nowMs = Date.now();
  for (const timer of document.querySelectorAll<HTMLElement>("#board .cardtimer")) {
    const since = timer.dataset["since"];
    if (since === undefined) {
      continue;
    }
    const startedMs = Date.parse(since);
    if (Number.isNaN(startedMs)) {
      continue;
    }
    const text = elapsedLabel(nowMs - startedMs);
    if (timer.textContent !== text) {
      timer.textContent = text;
    }
  }
  for (const age of document.querySelectorAll<HTMLElement>("#board .cardage")) {
    const text = ageLineText(age.dataset["since"] ?? null, nowMs);
    if (text !== null && age.textContent !== text) {
      age.textContent = text;
    }
  }
};

/**
 * Paint every working card's decay in place from its data-last-event stamp.
 * Inline styles are written (and removed — quiet and stampless cards must
 * fall back to the stylesheet) without touching the render signature, so
 * reconciliation and CSS animations are undisturbed, exactly like the
 * status-timer tick above.
 */
const tickLiveness = (): void => {
  const nowMs = Date.now();
  for (const card of document.querySelectorAll<HTMLElement>("#board .card.status-working")) {
    const stamp = card.dataset["lastEvent"];
    const frame = livenessFrame(
      stamp === undefined || stamp === "" ? null : stamp,
      card.classList.contains("sub"),
      nowMs,
    );
    card.classList.toggle("quiet", frame.quiet);
    if (frame.edgeColor === null) {
      card.style.removeProperty("border-left-color");
    } else {
      card.style.borderLeftColor = frame.edgeColor;
    }
    if (frame.dotColor === null) {
      card.style.removeProperty("--st");
    } else {
      card.style.setProperty("--st", frame.dotColor);
    }
    const label = card.querySelector<HTMLElement>(".quiet-elapsed");
    if (label !== null) {
      const text = frame.quietLabel ?? "";
      if (label.textContent !== text) {
        label.textContent = text;
      }
    }
    const gap = card.querySelector<HTMLElement>(".cardgap");
    if (gap !== null) {
      const text = frame.gapLabel ?? "";
      if (gap.textContent !== text) {
        gap.textContent = text;
      }
    }
  }
};

const applyBoard = (result: BoardResult): void => {
  if (result.dirty) {
    persistSettings(result.settings);
  }
  currentPage = result.settings.currentPage;
  currentPageCount = result.pageCount;
  currentPages = result.pages;
  const page = currentPages[currentPage] ?? { cards: [] };
  currentCards = page.cards;
  const degraded = currentView?.degraded ?? false;
  const signature = boardRenderSignature(page, degraded);
  const root = document.querySelector<HTMLElement>("#board");
  if (root !== null && signature !== renderedSignature) {
    diagnostic?.recordRender();
    renderedSignature = signature;
    renderBoard(root, page, degraded);
    // Pulse on stamp advance (working cards only — planPulses gates on the
    // status): compared against the previous ingest, keyed by card, gated per
    // card — and animated via element.animate so a re-fire never has to fight
    // a CSS class retrigger.
    const plan = planPulses(
      pulseEntries,
      page.cards.map((card) => ({
        key: cardKey(card),
        lastEventAt: sessionLastEventAt(card.session),
        status: card.session.status,
      })),
      Date.now(),
    );
    pulseEntries = plan.next;
    // cardKey's NUL separator cannot be expressed in a CSS attribute selector
    // (escaping maps it to U+FFFD), so firing keys match in JS, not in CSS.
    const firing = new Set(plan.fire);
    for (const element of root.querySelectorAll<HTMLElement>("[data-card-key]")) {
      if (!firing.has(element.dataset["cardKey"] ?? "")) {
        continue;
      }
      element
        .querySelector<HTMLElement>(".pulse-overlay")
        ?.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 0 }], {
          duration: PULSE_SWEEP_MS,
          easing: "ease-out",
        });
    }
    tickLiveness(); // fresh nodes paint immediately instead of waiting out the 1s tick
  }
  renderIndicatorsNow();
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

/** All snapshot application goes through the deferral latch: nothing
 *  repacks or re-renders the board, peek, or pips mid-gesture; the newest
 *  payload applies at settle. */
const ingest = (payload: SnapshotPayload | null): void => {
  snapshotDeferral.submit(payload);
};

const ingestNow = (payload: SnapshotPayload | null): void => {
  lastPayload = payload;
  const reduction = reduceSnapshotRead(payload, lastGood, Date.now());
  lastGood = reduction.lastGood;
  // The rendered view hides freshly-flicked slats while their ack's
  // settlement makes the registry → snapshot round-trip; lastGood stays
  // unfiltered so an expired dismissal honestly resurfaces.
  currentView = {
    ...reduction.view,
    snapshot: dismissals.filterSnapshot(reduction.view.snapshot, Date.now()),
  };
  applyBoard(reduceBoard(currentView, loadStoredSettings()));
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
 * those files change at most every 120s (quota) and 30s (token-usage), and
 * a rejection is a missing file, i.e. "no data yet".
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
  if (diagnostic !== null) {
    mountPointerDiagnostic(document.body, diagnostic);
  }
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
    tickLiveness();
  }, 1000);
};

const FLASH_MS = 320;

const flashCard = (card: HTMLElement): void => {
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), FLASH_MS);
};

/**
 * The clean tap's settlement. The click carries no capture of its own — its
 * target may even be a card that re-rendered into the pressed one's place
 * mid-stroke — so it settles the press captured at pointer-down: the
 * pressed identity re-resolved against the current cards (left the grid →
 * cancel, never retarget), viewed with the pointer-down watermark.
 */
const onBoardClick = (): void => {
  const pending = pressAwaitingClick;
  pressAwaitingClick = null;
  if (pending === null) {
    return;
  }
  const settled = resolvePendingPress(currentCards, pending);
  if (settled === null) {
    return;
  }
  const tile = document.querySelector<HTMLElement>(`#board [data-card-index="${settled.index}"]`);
  if (tile === null) {
    return;
  }
  void pressBoardCard(settled.card, settled.watermark, {
    view: viewSession,
    openUrl,
    focusGhostty,
    readPaseoServerId,
    flash: () => flashCard(tile),
  });
};

const cardFromPointerEvent = (event: MouseEvent): PendingPress | null => {
  if (!(event.target instanceof HTMLElement)) {
    return null;
  }
  const card = event.target.closest<HTMLElement>("[data-card-index]");
  if (card === null) {
    return null;
  }
  const index = Number(card.dataset["cardIndex"]);
  return capturePendingPress(currentCards, index, { x: event.clientX, y: event.clientY });
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
  const { session, tile, watermark } = context;
  switch (id) {
    case "open":
      // Routing failures already surface through pressSessionTile's tile
      // flash; the sheet's job is done either way.
      dismissActionSheet();
      void pressSessionTile(session, watermark, {
        view: viewSession,
        openUrl,
        focusGhostty,
        readPaseoServerId,
        flash: () => flashCard(tile),
      });
      return;
    case "ack":
      return trackSheetAction(
        ackSession(session.provider, session.sessionId, watermark),
        context,
        generation,
        "Dismiss failed",
      );
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

const FLICK_OUT_MS = 200;

/**
 * Flick-to-dismiss: the tap views; the flick is the explicit dismissal,
 * minus the routing.
 * Only a slat an ack would actually take off the board (a retired error, a
 * viewed idle result) slides out; a live slat flashes like a routeless tap,
 * so the animation never promises a dismissal the registry will refuse. The
 * ack itself is fire-and-forget exactly like the tap's view: if it is
 * lost, the local dismissal expires and the slat honestly returns; if the
 * registry refuses it causally (a newer result landed in transit), the
 * local hide ends as soon as a snapshot shows that newer result.
 */
const flickAway = (pending: PendingPress, direction: "up" | "down"): void => {
  const settled = resolvePendingPress(currentCards, pending);
  if (settled === null) {
    return;
  }
  const tile = document.querySelector<HTMLElement>(`#board [data-card-index="${settled.index}"]`);
  if (tile === null) {
    return;
  }
  if (!flickRemoves(settled.card.session)) {
    flashCard(tile);
    return;
  }
  const { provider, sessionId } = settled.card.session;
  void ackSession(provider, sessionId, settled.watermark).catch(() => {});
  const slide = tile.animate(
    [
      { transform: "translateY(0)", opacity: 1 },
      { transform: `translateY(${direction === "up" ? -120 : 120}%)`, opacity: 0 },
    ],
    { duration: FLICK_OUT_MS, easing: "ease-in", fill: "forwards" },
  );
  // A re-render mid-slide cancels the animation (finished rejects): settle
  // either way — the dismissal must land or the card pops back for a beat.
  // The local hide carries the flick's watermark so a causal refusal ends
  // it; when the refusal is already visible at settle time the card never
  // leaves the cards, no re-render follows, and the slid-out tile must snap
  // back itself.
  const settle = (): void => {
    dismissals.dismiss(provider, sessionId, Date.now(), settled.watermark);
    // Local re-reduction through the latch's own latest — never a driver-held
    // copy, which can be older than a deferred payload.
    snapshotDeferral.resubmitLatest();
    if (resolvePendingPress(currentCards, pending) !== null) {
      slide.cancel();
    }
  };
  slide.finished.then(settle, settle);
};

const openActionSheetFor = (pending: PendingPress): void => {
  // Resolve by identity against the current cards: if the pressed session
  // left the board during the hold, cancel — never retarget the sheet (and
  // its Clear action) at whichever session shifted into the old index. The
  // sheet carries the pointer-down watermark for its Open and Dismiss.
  const settled = resolvePendingPress(currentCards, pending);
  if (settled === null) {
    return;
  }
  const tile = document.querySelector<HTMLElement>(`#board [data-card-index="${settled.index}"]`);
  if (tile === null) {
    return;
  }
  sheetActions = advanceSheetGeneration(sheetActions);
  openActionSheet({
    point: pending.point,
    session: settled.card.session,
    label: settled.card.label,
    tile,
    watermark: settled.watermark,
  });
};

/**
 * Installing the overlay steals this stroke's release: the physical up may
 * retarget to the sheet or arrive with the capture gone, and a live stroke
 * left open would let its stale up eat the next tap. Close the stroke
 * deterministically; its emitted suppress-click keeps this stroke's
 * trailing click swallowed (Task 3's stroke-scoped contract).
 */
const settleLongPressStroke = (point: GesturePoint): void => {
  handleGestureIntents(gestures.feed({ kind: "up", point, now: Date.now() }));
};

/** The commit fraction's base. */
const boardRegionWidth = (): number => document.querySelector<HTMLElement>("#board-viewport")?.clientWidth ?? 0;

const SETTLE_MS = 160;
/** Mirrors .board-grid's 1.5625vw gutter (styles.css): adjacent pages sit one
 *  board-width-minus-gutter apart, so the incoming first column starts exactly
 *  under the peek slivers and the sliver grows into the real card. */
const BOARD_GUTTER_NATIVE_PX = 40;
const NATIVE_STRIP_WIDTH_PX = 2560;
const gutterPx = (): number => (window.innerWidth * BOARD_GUTTER_NATIVE_PX) / NATIVE_STRIP_WIDTH_PX;

const boardTrack = (): HTMLElement | null => document.querySelector<HTMLElement>("#board-track");
let adjacentPages: HTMLElement[] = [];
let settleFallback: ReturnType<typeof setTimeout> | null = null;

const setTrackOffset = (offset: number, animate: boolean): void => {
  const track = boardTrack();
  if (track === null) {
    return;
  }
  track.style.transition = animate ? `transform ${SETTLE_MS}ms ease-out` : "none";
  track.style.transform = `translateX(${offset}px)`;
};

const mountAdjacentPages = (): void => {
  const track = boardTrack();
  const degraded = currentView?.degraded ?? false;
  if (track === null) {
    return;
  }
  const mount = (page: BoardPage | undefined, side: "previous" | "next"): void => {
    if (page === undefined || page.cards.length === 0) {
      return;
    }
    const grid = document.createElement("div");
    grid.className = `board-grid board-adjacent ${side}`;
    renderBoard(grid, page, degraded);
    track.append(grid);
    adjacentPages.push(grid);
  };
  mount(currentPages[currentPage - 1], "previous");
  mount(currentPages[currentPage + 1], "next");
};

const unmountAdjacentPages = (): void => {
  for (const grid of adjacentPages) {
    grid.remove();
  }
  adjacentPages = [];
};

/**
 * Animate to the settle target, then commit-and-reset in one synchronous
 * handler so the swap never flashes: the page jump re-renders #board while
 * the track snaps back to rest and the transient neighbors unmount. The
 * commit navigates to the settle's own captured target — never to whatever
 * currentPage mutated to during the animation. Single-flight is the
 * session's guarantee: finishSettle only ever runs on a non-null verdict,
 * and no second verdict can exist until settled() runs here. The fallback
 * timer covers a transitionend that never fires (an already-at-rest
 * snap-back transitions nothing).
 */
const finishSettle = (settle: DragSettle): void => {
  const track = boardTrack();
  const done = (): void => {
    track?.removeEventListener("transitionend", done);
    if (settleFallback !== null) {
      clearTimeout(settleFallback);
      settleFallback = null;
    }
    pagingSession.settled(); // before the jump: the navigation gate opens here
    if (settle.kind === "commit") {
      jumpToPage(settle.target);
    }
    setTrackOffset(0, false);
    unmountAdjacentPages();
    snapshotDeferral.flush();
  };
  const target =
    settle.kind === "commit" ? (settle.direction === "next" ? -1 : 1) * (boardRegionWidth() - gutterPx()) : 0;
  track?.addEventListener("transitionend", done);
  settleFallback = setTimeout(done, SETTLE_MS + 80);
  setTrackOffset(target, true);
};

const handleGestureIntents = (intents: readonly GestureIntent[]): void => {
  for (const intent of intents) {
    switch (intent.kind) {
      case "drag-start": {
        const accepted = pagingSession.start({
          page: currentPage,
          pageCount: currentPageCount,
          boardWidth: boardRegionWidth(),
        });
        if (!accepted) {
          break; // a settling board is not grabbable; this stroke owns nothing
        }
        mountAdjacentPages();
        setTrackOffset(0, false);
        break;
      }
      case "drag-move": {
        const offset = pagingSession.move(intent.dx);
        if (offset !== null) {
          setTrackOffset(offset, false); // a refused stroke never touches the track
        }
        break;
      }
      case "drag-end": {
        const settle = pagingSession.release(intent.dx, intent.velocity);
        if (settle !== null) {
          finishSettle(settle);
        }
        break;
      }
      case "drag-cancel": {
        const settle = pagingSession.cancel();
        if (settle !== null) {
          finishSettle(settle);
        }
        break;
      }
      case "longpress": {
        const pending = pendingPress;
        if (pending !== null) {
          pendingPress = null;
          settleLongPressStroke(pending.point); // before the overlay takes the pointer
          openActionSheetFor(pending);
        }
        break;
      }
      case "flick": {
        const pending = pendingPress;
        if (pending !== null) {
          pendingPress = null;
          flickAway(pending, intent.direction);
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
        // The tick rides the same seam as pointer input so the diagnostic
        // records its intents too. feedPointer is declared below — referenced
        // here at fire time. After a tick no long-press is due anymore (the
        // stroke fired, moved, or ended), so the reschedule in feedPointer
        // terminates; only a clamped-early tick re-arms, at zero delay.
        feedPointer({ kind: "tick", now: Date.now() });
      },
      Math.max(0, dueAt - Date.now()),
    );
  }
};

const feedPointer = (input: GestureInput): void => {
  const intents = gestures.feed(input);
  diagnostic?.recordIntents(intents);
  handleGestureIntents(intents);
  scheduleLongPressTimer();
};

const onSurfacePointerDown = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  diagnostic?.recordPointer("down", 1);
  pendingPress = cardFromPointerEvent(event);
  // Capture the pointer: the stroke's continuation belongs to this surface
  // even when the finger crosses the rail — which itself hosts no handlers.
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  feedPointer({ kind: "down", point: { x: event.clientX, y: event.clientY }, now: Date.now() });
};

/**
 * Stroke bookkeeping on the pager+pips wrapper: suppression belongs to one
 * stroke, and a touch drag fires no trailing click at all — any unconsumed
 * suppression from the last stroke dies at the next stroke's birth, wherever
 * it lands inside the paging region (a pip tap must never be eaten by a stale
 * arm). A card press whose trailing click never arrived dies there too. This
 * listener feeds no recognizer, and the wrapper excludes the rail.
 */
const onGestureRegionStrokeBookkeeping = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  clickSuppression.beginStroke();
  pressAwaitingClick = null;
};

/** Leaving the window mid-gesture snaps back; with no live stroke the feed is a no-op. */
const onWindowBlur = (): void => {
  feedPointer({ kind: "cancel", now: Date.now() });
  pendingPress = null;
};

const onSurfacePointerMove = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  diagnostic?.recordPointer("move", event.getCoalescedEvents?.().length ?? 0);
  feedPointer({ kind: "move", point: { x: event.clientX, y: event.clientY }, now: Date.now() });
};

const onSurfacePointerUp = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  diagnostic?.recordPointer("up", 1);
  feedPointer({ kind: "up", point: { x: event.clientX, y: event.clientY }, now: Date.now() });
  // A press the stroke did not consume (no long-press, no flick) belongs to
  // the trailing click now: a clean tap settles it; a suppressed click
  // never reaches the board and the next stroke drops it.
  pressAwaitingClick = pendingPress;
  pendingPress = null;
};

const onSurfacePointerCancel = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  diagnostic?.recordPointer("cancel", 1);
  feedPointer({ kind: "cancel", now: Date.now() });
  pendingPress = null;
  pressAwaitingClick = null;
};

/**
 * Capture loss ends the stroke like a cancel, but is not one: it also
 * follows every ordinary pointerup (capture releases with the stroke), and
 * the diagnostic's cancel count must stay a count of real cancel events —
 * the on-glass delivery receipt reads it. Same cleanup, no synthetic
 * delivery record.
 */
const onSurfaceLostPointerCapture = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  feedPointer({ kind: "cancel", now: Date.now() });
  pendingPress = null;
};

/**
 * Consume suppression in the capture phase on the paging region — before
 * the click reaches any target: a moved stroke released on a pip would
 * otherwise page-jump, because the pip's own listener fires in the target
 * phase, ahead of any bubble-phase consumer on an ancestor. A suppressed
 * click is prevented and stopped outright; clean clicks pass untouched.
 */
const onGestureRegionClickCapture = (event: MouseEvent): void => {
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

/**
 * The platform's hold verdict arrives as that synthesized secondary click:
 * a finger planted on the panel never produces the sustained primary-button
 * down the long-press timer needs, so its contextmenu is routed through the
 * recognizer as the context signal instead — the pressed card opens the
 * same action sheet as a mouse hold, and a mouse right-click rides along.
 * The native menu stays cancelled at the document root regardless.
 */
const onSurfaceContextMenu = (event: MouseEvent): void => {
  diagnostic?.recordPointer("context", 1);
  const pending = cardFromPointerEvent(event);
  if (pending !== null) {
    pendingPress = pending;
  }
  feedPointer({ kind: "context", point: { x: event.clientX, y: event.clientY }, now: Date.now() });
};

const wireInteraction = (): void => {
  document.querySelector<HTMLElement>("#board")?.addEventListener("click", onBoardClick);
  // The paging region hosts the two capture-phase stroke/suppression
  // listeners; the pager is the recognizer surface, so the rail and the
  // pips never traverse a recognizer listener.
  const region = document.querySelector<HTMLElement>("#paging-region");
  region?.addEventListener("pointerdown", onGestureRegionStrokeBookkeeping, true);
  region?.addEventListener("click", onGestureRegionClickCapture, true);
  const surface = document.querySelector<HTMLElement>("#pager");
  surface?.addEventListener("pointerdown", onSurfacePointerDown);
  surface?.addEventListener("pointermove", onSurfacePointerMove);
  surface?.addEventListener("pointerup", onSurfacePointerUp);
  surface?.addEventListener("pointercancel", onSurfacePointerCancel);
  // Losing the capture (element teardown, capture theft) cancels the stroke.
  surface?.addEventListener("lostpointercapture", onSurfaceLostPointerCapture);
  surface?.addEventListener("contextmenu", onSurfaceContextMenu);
  // Page-level band taps: jumpBoard clamps, and a drag released here is
  // already swallowed by the capture-phase suppression.
  document.querySelector<HTMLElement>("#peek-band")?.addEventListener("click", () => jumpToPage(currentPage + 1));
  document.querySelector<HTMLElement>("#return-band")?.addEventListener("click", () => jumpToPage(currentPage - 1));
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      dismissActionSheet();
    }
  });
};

void start();
