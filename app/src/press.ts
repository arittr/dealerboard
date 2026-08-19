/**
 * Tile press = the Stream Deck keyDown gesture: ack fire-and-forget (a failed
 * ack only means the tile stays unread until the next lifecycle event — never
 * flash for it), then route. Routing failures flash the tile, matching the
 * plugin's activation alert.
 */

import { FOCUS_GHOSTTY_TERMINAL_SCRIPT } from "../../src/plugin/ghostty-focus";
import type { ProjectedSession, Provider } from "../../src/protocol";
import { routeForSession } from "./routing";

export type PressDeps = {
  ack: (provider: Provider, sessionId: string) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  focusGhostty: (script: string, terminalId: string) => Promise<void>;
  readPaseoServerId: () => Promise<string>;
  flash: () => void;
};

export const pressSessionTile = async (session: ProjectedSession, deps: PressDeps): Promise<void> => {
  void deps.ack(session.provider, session.sessionId).catch(() => {});
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
