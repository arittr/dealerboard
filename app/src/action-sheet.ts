/**
 * Long-press action sheet: the per-session action menu. buildSheetModel,
 * reduceSheetSelection, and transcriptPathOf are the pure, tested core;
 * buildSheetOverlay is the DOM surface (like renderRail — exercised on the
 * panel, not under bun test). All text goes through textContent.
 */

import type { ProjectedSession } from "../../src/protocol";

export type SheetActionId = "open" | "ack" | "reveal" | "copy" | "clear";

export type SheetItem = {
  id: SheetActionId;
  label: string;
  enabled: boolean;
  /** True only for the armed "Confirm clear" state. */
  confirming: boolean;
};

export type SheetModel = {
  title: string;
  /** Inline failure notice for the last action; null when the sheet is clean. */
  error: string | null;
  items: SheetItem[];
};

export type SheetOptions = {
  /** Tile label — the layout's title/project fallbacks are already applied. */
  title: string;
  clipboardAvailable: boolean;
  clearArmed: boolean;
  /** The action whose settlement is in flight; when set, every action is disabled. */
  pendingAction?: SheetActionId | null;
  /** Inline failure notice to render; omitted/null renders nothing. */
  error?: string | null;
};

/**
 * transcriptPath rides the snapshot as an additive field (Lane A); until it
 * lands, parsed sessions simply lack the key. Read it defensively so the
 * sheet works — with Reveal disabled — against both protocol shapes.
 */
export const transcriptPathOf = (session: ProjectedSession): string | null => {
  const record: Record<string, unknown> = session;
  const value = record["transcriptPath"];
  return typeof value === "string" && value.length > 0 ? value : null;
};

export const buildSheetModel = (session: ProjectedSession, options: SheetOptions): SheetModel => {
  const actionsLocked = options.pendingAction != null;
  return {
    title: options.title,
    error: options.error ?? null,
    items: [
      { id: "open", label: "Open", enabled: !actionsLocked, confirming: false },
      { id: "ack", label: "Ack", enabled: !actionsLocked, confirming: false },
      {
        id: "reveal",
        label: "Reveal transcript",
        enabled: !actionsLocked && transcriptPathOf(session) !== null,
        confirming: false,
      },
      {
        id: "copy",
        label: "Copy session ID",
        enabled: !actionsLocked && options.clipboardAvailable,
        confirming: false,
      },
      {
        id: "clear",
        label: options.clearArmed ? "Confirm clear" : "Clear session",
        enabled: !actionsLocked,
        confirming: options.clearArmed,
      },
    ],
  };
};

/** Inline confirm for the destructive action: Clear must be tapped twice. */
export const reduceSheetSelection = (
  clearArmed: boolean,
  id: SheetActionId,
): { clearArmed: boolean; fire: boolean } => {
  if (id === "clear" && !clearArmed) {
    return { clearArmed: true, fire: false };
  }
  return { clearArmed: false, fire: true };
};

/**
 * Firing state for sheet actions. Actions are async invocations whose
 * settlements land later, so the sheet needs two guards: a pending flag
 * (buttons stay disabled, duplicate calls are blocked while one is in
 * flight) and a generation identifying the sheet instance a settlement
 * belongs to — a late settlement must not dismiss whatever sheet is open
 * now, nor resurrect its own context after the user dismissed it.
 */
export type SheetActionState = {
  /** Identifies the open sheet instance; advanced on every dismissal and fresh open. */
  generation: number;
  clearArmed: boolean;
  /** The action whose settlement is in flight; null when idle. */
  pendingAction: SheetActionId | null;
};

export const initialSheetActionState = (): SheetActionState => ({
  generation: 0,
  clearArmed: false,
  pendingAction: null,
});

/** End the sheet instance: clears the arm and any pending action and makes every in-flight settlement stale. */
export const advanceSheetGeneration = (state: SheetActionState): SheetActionState => ({
  generation: state.generation + 1,
  clearArmed: false,
  pendingAction: null,
});

export type SheetActionBegin = { state: SheetActionState; fire: boolean };

/** Decide a sheet button tap: blocked while an action is pending, the first
 * clear tap only arms, anything else fires and goes pending. */
export const beginSheetAction = (state: SheetActionState, id: SheetActionId): SheetActionBegin => {
  if (state.pendingAction !== null) {
    return { state, fire: false };
  }
  const selection = reduceSheetSelection(state.clearArmed, id);
  if (!selection.fire) {
    return { state: { ...state, clearArmed: selection.clearArmed }, fire: false };
  }
  return { state: { ...state, clearArmed: false, pendingAction: id }, fire: true };
};

export type SheetActionSettlement = {
  state: SheetActionState;
  /** Remove the sheet from the DOM — the action completed successfully. */
  dismissed: boolean;
  /** Re-render the sheet with an inline error — the action failed. */
  reopen: boolean;
};

/**
 * Settle a fired action against the state captured when it fired. A stale
 * generation — the user dismissed the sheet, or a newer instance opened —
 * is a no-op: user dismissal always wins, and a late settlement never
 * dismisses or resurrects a sheet it no longer owns.
 */
export const settleSheetAction = (
  state: SheetActionState,
  firedAtGeneration: number,
  succeeded: boolean,
): SheetActionSettlement => {
  if (firedAtGeneration !== state.generation) {
    return { state, dismissed: false, reopen: false };
  }
  if (succeeded) {
    return {
      state: { generation: state.generation + 1, clearArmed: false, pendingAction: null },
      dismissed: true,
      reopen: false,
    };
  }
  return { state: { ...state, pendingAction: null }, dismissed: false, reopen: true };
};

export type SheetHandlers = {
  onAction: (id: SheetActionId) => void;
  onDismiss: () => void;
};

/**
 * Full-window overlay carrying the sheet; the caller appends it to the body,
 * positions the `.action-sheet` element, and moves focus into it. The sheet
 * carries dialog semantics (role/aria-modal/aria-label from the title) so
 * keyboard and assistive-tech focus stay with it, not behind the backdrop.
 * A pointer-down landing on the backdrop (not the sheet) dismisses.
 */
export const buildSheetOverlay = (model: SheetModel, handlers: SheetHandlers): HTMLElement => {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) {
      handlers.onDismiss();
    }
  });
  const sheet = document.createElement("div");
  sheet.className = "action-sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", model.title);
  const title = document.createElement("div");
  title.className = "sheet-title";
  title.textContent = model.title;
  sheet.append(title);
  if (model.error !== null) {
    const error = document.createElement("div");
    error.className = "sheet-error";
    error.textContent = model.error;
    sheet.append(error);
  }
  for (const item of model.items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = item.confirming ? "sheet-item confirming" : "sheet-item";
    button.disabled = !item.enabled;
    button.textContent = item.label;
    button.addEventListener("click", () => handlers.onAction(item.id));
    sheet.append(button);
  }
  overlay.append(sheet);
  return overlay;
};
