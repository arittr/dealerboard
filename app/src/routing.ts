/**
 * Tile-press routing rules, ported from the Stream Deck controller's keyDown
 * (src/plugin/controller.ts): a Paseo origin with a known agent ref wins over
 * provider routing; claude focuses its Ghostty terminal; codex and kimi open
 * deep links; everything else flashes the tile. Pure — no Tauri imports.
 */

import type { ProjectedSession } from "../../src/protocol";

export type SessionRoute =
  | { kind: "paseo"; agentId: string }
  | { kind: "ghostty"; terminalId: string }
  | { kind: "url"; url: string }
  | { kind: "flash" };

const KIMI_WEB_SESSIONS_URL = "http://127.0.0.1:58627/sessions/";

export const routeForSession = (session: ProjectedSession): SessionRoute => {
  if (session.originKind === "paseo" && session.originRef !== null) {
    return { kind: "paseo", agentId: session.originRef };
  }
  switch (session.provider) {
    case "claude":
      return session.ghosttyTerminalId === null
        ? { kind: "flash" }
        : { kind: "ghostty", terminalId: session.ghosttyTerminalId };
    case "codex":
      return { kind: "url", url: `codex://threads/${encodeURIComponent(session.sessionId)}` };
    case "kimi":
      return { kind: "url", url: `${KIMI_WEB_SESSIONS_URL}${encodeURIComponent(session.sessionId)}` };
    case "pi":
    case "omp":
    case "zcode":
    case "deepseek":
    case "grok":
      return { kind: "flash" };
  }
  // Exhaustiveness proof: adding a Provider without a case fails typecheck.
  const uncoveredProvider: never = session.provider;
  void uncoveredProvider;
};
