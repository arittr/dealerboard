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
import { createDismissals, flickRemoves } from "./dismissals";
/**
 * A pending press is bound to the pressed session's identity, never to a
 * dense tile index: a pushed snapshot can re-render the grid during the
 * stroke, and an index captured at press time may already point at a
 * different session when the long-press sheet opens or the flick lands.
 */
import { capturePendingPress, type PendingPress } from "./gesture-target";
import {
  createClickSuppression,
  createGestureRecognizer,
  type GestureInput,
  type GestureIntent,
  type GesturePoint,
  swallowSuppressedClick,
} from "./gestures";
import { createIngestGate } from "./ingest-gate";
import { elapsedLabel, livenessFrame, PULSE_SWEEP_MS, type PulseEntry, planPulses } from "./liveness";
import { pressBoardCard, pressSessionTile } from "./press";
import { type QuotaPanelModel, reduceQuotaRead } from "./quota";
import { railRenderSignature, renderRail } from "./rail";
import { countUnreadSessions, msUntilStale, reduceSnapshotRead } from "./snapshot-view";
import { interactiveBoardCard, resolveInteractiveBoardCard } from "./tile-identity";
import { reduceTokenUsageRead, type TokenUsageRailModel } from "./token-usage";
import { startStripWindowManager } from "./window";

const SLOW_PASS_MS = 10_000;
const SETTINGS_KEY = "agent-strip.layout.v1";

let lastGood: SessionSnapshotV2 | null = null;
let renderedSignature = "";
let railRenderedSignature = "";
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
const clickSuppression = createClickSuppression();
const dismissals = createDismissals();
let gestureTimer: number | null = null;
let pendingPress: PendingPress | null = null;

type SheetContext = {
  point: GesturePoint;
  session: BoardSession;
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
  // jumpBoard reports a page change as dirty, so applyBoard persists it and
  // later ingests (which reduce from the persisted settings) keep the page.
  applyBoard(jumpBoard(currentView, loadStoredSettings(), page));
  // renderRailNow is declared below; referenced here at click time.
  renderRailNow();
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
    page: currentPage + 1,
    pageCount: currentPageCount,
    now: new Date(),
  };
  // Skip the rebuild while nothing rendered would change: the 1s cadence
  // exists only for countdown minute rollovers, and rebuilding every second
  // would replace the page-dot buttons out from under an in-flight tap.
  const signature = railRenderSignature(model);
  if (signature === railRenderedSignature) {
    return;
  }
  railRenderedSignature = signature;
  renderRail(root, model, { onJumpToPage: jumpToPage });
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

const onBoardClick = (event: MouseEvent): void => {
  if (!(event.target instanceof HTMLElement)) {
    return;
  }
  const card = event.target.closest<HTMLElement>("[data-card-index]");
  if (card === null) {
    return;
  }
  const index = Number(card.dataset["cardIndex"]);
  const currentCard = interactiveBoardCard(currentCards[index]);
  if (currentCard === null) {
    return;
  }
  void pressBoardCard(currentCard, {
    view: viewSession,
    openUrl,
    focusGhostty,
    readPaseoServerId,
    flash: () => flashCard(card),
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
  const { session, tile } = context;
  switch (id) {
    case "open":
      // Routing failures already surface through pressSessionTile's tile
      // flash; the sheet's job is done either way.
      dismissActionSheet();
      void pressSessionTile(session, {
        view: viewSession,
        openUrl,
        focusGhostty,
        readPaseoServerId,
        flash: () => flashCard(tile),
      });
      return;
    case "ack":
      return trackSheetAction(
        ackSession(session.provider, session.sessionId, { unreadSince: session.unreadSince }),
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
 * lost, the local dismissal expires and the slat honestly returns.
 */
const flickAway = (pending: PendingPress, direction: "up" | "down"): void => {
  const ref = resolveInteractiveBoardCard(currentCards, pending.identity);
  if (ref === null) {
    return;
  }
  const tile = document.querySelector<HTMLElement>(`#board [data-card-index="${ref.index}"]`);
  if (tile === null) {
    return;
  }
  if (!flickRemoves(ref.card.session)) {
    flashCard(tile);
    return;
  }
  const { provider, sessionId } = ref.card.session;
  void ackSession(provider, sessionId, pending.watermark).catch(() => {});
  const slide = tile.animate(
    [
      { transform: "translateY(0)", opacity: 1 },
      { transform: `translateY(${direction === "up" ? -120 : 120}%)`, opacity: 0 },
    ],
    { duration: FLICK_OUT_MS, easing: "ease-in", fill: "forwards" },
  );
  // A re-render mid-slide cancels the animation (finished rejects): settle
  // either way — the dismissal must land or the card pops back for a beat.
  const settle = (): void => {
    dismissals.dismiss(provider, sessionId, Date.now());
    ingest(lastPayload);
  };
  slide.finished.then(settle, settle);
};

const openActionSheetFor = (pending: PendingPress): void => {
  // Resolve by identity against the current cards: if the pressed session
  // left the board during the hold, cancel — never retarget the sheet (and
  // its Clear action) at whichever session shifted into the old index.
  const ref = resolveInteractiveBoardCard(currentCards, pending.identity);
  if (ref === null) {
    return;
  }
  const tile = document.querySelector<HTMLElement>(`#board [data-card-index="${ref.index}"]`);
  if (tile === null) {
    return;
  }
  sheetActions = advanceSheetGeneration(sheetActions);
  openActionSheet({ point: pending.point, session: ref.card.session, label: ref.card.label, tile });
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
  pendingPress = cardFromPointerEvent(event);
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
  pendingPress = null;
};

const onStripPointerCancel = (event: PointerEvent): void => {
  if (!event.isPrimary) {
    return;
  }
  feedPointer({ kind: "cancel", now: Date.now() });
  pendingPress = null;
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

/**
 * The platform's hold verdict arrives as that synthesized secondary click:
 * a finger planted on the panel never produces the sustained primary-button
 * down the long-press timer needs, so its contextmenu is routed through the
 * recognizer as the context signal instead — the pressed card opens the
 * same action sheet as a mouse hold, and a mouse right-click rides along.
 * The native menu stays cancelled at the document root regardless.
 */
const onStripContextMenu = (event: MouseEvent): void => {
  const pending = cardFromPointerEvent(event);
  if (pending !== null) {
    pendingPress = pending;
  }
  feedPointer({ kind: "context", point: { x: event.clientX, y: event.clientY }, now: Date.now() });
};

const wireInteraction = (): void => {
  document.querySelector<HTMLElement>("#board")?.addEventListener("click", onBoardClick);
  const strip = document.querySelector<HTMLElement>("#strip");
  strip?.addEventListener("pointerdown", onStripPointerDown);
  strip?.addEventListener("pointermove", onStripPointerMove);
  strip?.addEventListener("pointerup", onStripPointerUp);
  strip?.addEventListener("pointercancel", onStripPointerCancel);
  strip?.addEventListener("click", onStripClickCapture, true);
  strip?.addEventListener("contextmenu", onStripContextMenu);
  document.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      dismissActionSheet();
    }
  });
};

void start();
