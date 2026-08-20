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
  items: SheetItem[];
};

export type SheetOptions = {
  /** Tile label — the layout's title/project fallbacks are already applied. */
  title: string;
  clipboardAvailable: boolean;
  clearArmed: boolean;
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

export const buildSheetModel = (session: ProjectedSession, options: SheetOptions): SheetModel => ({
  title: options.title,
  items: [
    { id: "open", label: "Open", enabled: true, confirming: false },
    { id: "ack", label: "Ack", enabled: true, confirming: false },
    { id: "reveal", label: "Reveal transcript", enabled: transcriptPathOf(session) !== null, confirming: false },
    { id: "copy", label: "Copy session ID", enabled: options.clipboardAvailable, confirming: false },
    {
      id: "clear",
      label: options.clearArmed ? "Confirm clear" : "Clear session",
      enabled: true,
      confirming: options.clearArmed,
    },
  ],
});

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

export type SheetHandlers = {
  onAction: (id: SheetActionId) => void;
  onDismiss: () => void;
};

/**
 * Full-window overlay carrying the sheet; the caller appends it to the body
 * and positions the `.action-sheet` element. A pointer-down landing on the
 * backdrop (not the sheet) dismisses.
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
  const title = document.createElement("div");
  title.className = "sheet-title";
  title.textContent = model.title;
  sheet.append(title);
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
