/**
 * Bring-up pointer diagnostic — REMOVABLE (spec: on-device diagnostic during
 * bring-up, no permanent logging; deleted after threshold tuning). Localizes
 * a failed swipe to one of four layers, each on its own summary line:
 * delivery (raw pointer events reaching the paging-facing handlers, with a 1s move
 * rate and the last coalesced-batch size), recognition (intents the
 * recognizer emitted), navigation (page jumps), render (board re-renders).
 * Pure counters here; main.ts feeds records and mounts the overlay.
 */

import type { GestureIntent } from "./gestures";

export const POINTER_DIAGNOSTIC_ENABLED = true;

export type PointerDiagnostic = {
  recordPointer: (kind: "down" | "move" | "up" | "cancel" | "context", coalesced: number) => void;
  recordIntents: (intents: readonly GestureIntent[]) => void;
  recordNavigation: (from: number, to: number) => void;
  recordRender: () => void;
  /** Four lines, one per layer: delivery / recognition / navigation / render. */
  summary: () => string[];
};

export const createPointerDiagnostic = (now: () => number): PointerDiagnostic => {
  const counts = { down: 0, move: 0, up: 0, cancel: 0, context: 0 };
  let moveStamps: number[] = [];
  let lastCoalesced = 0;
  let intentCount = 0;
  let lastIntents = "none";
  let navigationCount = 0;
  let lastNavigation = "none";
  let renderCount = 0;
  return {
    recordPointer: (kind, coalesced) => {
      counts[kind] += 1;
      if (kind === "move") {
        lastCoalesced = coalesced;
        const at = now();
        moveStamps = [...moveStamps.filter((stamp) => at - stamp <= 1000), at];
      }
    },
    recordIntents: (intents) => {
      if (intents.length === 0) {
        return; // an empty feed is not a recognition event; keep the last real batch visible
      }
      intentCount += intents.length;
      // The whole batch, not its tail: a swipe is swipe + suppress-click.
      lastIntents = intents.map((intent) => JSON.stringify(intent)).join(" ");
    },
    recordNavigation: (from, to) => {
      navigationCount += 1;
      lastNavigation = `${from}→${to}`;
    },
    recordRender: () => {
      renderCount += 1;
    },
    summary: () => [
      `delivery d${counts.down} m${counts.move} u${counts.up} c${counts.cancel} ctx${counts.context} | ${moveStamps.length}/s x${lastCoalesced}`,
      `recognize ${intentCount} | ${lastIntents}`,
      `navigate ${navigationCount} | ${lastNavigation}`,
      `render ${renderCount}`,
    ],
  };
};

/** The on-glass readout: a corner overlay refreshed at 250ms, never interactive. */
export const mountPointerDiagnostic = (parent: HTMLElement, diagnostic: PointerDiagnostic): void => {
  const overlay = document.createElement("div");
  overlay.id = "pointer-diag";
  parent.append(overlay);
  setInterval(() => {
    const text = diagnostic.summary().join("\n");
    if (overlay.textContent !== text) {
      overlay.textContent = text;
    }
  }, 250);
};
