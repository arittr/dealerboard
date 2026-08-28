/**
 * Tile press = view, then route. Viewing clears the unread badge and starts
 * the card's expiry clock; the card itself stays — dismissal is a separate
 * gesture (flick or action sheet). The view is fire-and-forget with the
 * caller's causality watermark — the stamp the card showed at pointer-down,
 * never the session's current stamp, which a snapshot ingested mid-stroke
 * may have moved past what the user saw (a failed view only means the
 * badge stays until the next lifecycle event — never flash for it).
 * Routing failures flash the tile, matching the plugin's activation alert.
 * An ended card views but never routes: its session is gone, only the
 * result remains.
 */

import { FOCUS_GHOSTTY_TERMINAL_SCRIPT } from "../../src/plugin/ghostty-focus";
import type { Provider } from "../../src/protocol";
import type { BoardSession } from "./board";
import type { GestureWatermark } from "./bridge";
import { routeForSession } from "./routing";

export type PressDeps = {
  view: (provider: Provider, sessionId: string, watermark: GestureWatermark | null) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  focusGhostty: (script: string, terminalId: string) => Promise<void>;
  readPaseoServerId: () => Promise<string>;
  flash: () => void;
};

export type BoardPressTarget = {
  session: BoardSession;
  displayOnly: boolean;
};

export const pressBoardCard = async (
  card: BoardPressTarget,
  watermark: GestureWatermark,
  deps: PressDeps,
): Promise<void> => {
  if (card.displayOnly) {
    return;
  }
  await pressSessionTile(card.session, watermark, deps);
};

export const pressSessionTile = async (
  session: BoardSession,
  watermark: GestureWatermark,
  deps: PressDeps,
): Promise<void> => {
  // A tap is always a causal gesture issued from the rendered snapshot: the
  // watermark object carries the stamp the user saw at pointer-down —
  // `{ unreadSince: null }` when the card had no badge — never the bare-null
  // unconditional shape.
  void deps.view(session.provider, session.sessionId, watermark).catch(() => {});
  if (session.endedAt !== null) {
    return;
  }
  const route = routeForSession(session);
  try {
    switch (route.kind) {
      case "paseo": {
        const serverId = await deps.readPaseoServerId();
        await deps.openUrl(`paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(route.agentId)}`);
        return;
      }
      case "ghostty":
        await deps.focusGhostty(FOCUS_GHOSTTY_TERMINAL_SCRIPT, route.terminalId);
        return;
      case "url":
        await deps.openUrl(route.url);
        return;
      case "flash":
        deps.flash();
        return;
    }
  } catch {
    deps.flash();
  }
};
