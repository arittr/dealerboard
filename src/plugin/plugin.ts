/**
 * Stream Deck plugin entrypoint — the file the Stream Deck Node.js 24 runtime
 * executes. Wires the SDK-backed ports into the SDK-independent controller,
 * registers the one session-grid action, and connects.
 *
 * The snapshot cache reads the daemon's canonical snapshot path through the
 * shared, Node-safe path resolver; no Bun-only core module is imported here.
 */

import streamDeck from "@elgato/streamdeck";
import { resolveAppPaths } from "../core/paths";
import { activateCodexSession } from "./codex-session-activation";
import { SessionGridController } from "./controller";
import { SessionGridAction } from "./session-grid-action";
import { SnapshotCache } from "./snapshot-reader";

const snapshotCache = new SnapshotCache(resolveAppPaths().snapshot);

const keyActionForContext = (context: string) => {
  const target = streamDeck.actions.getActionById(context);
  return target !== undefined && target.isKey() ? target : undefined;
};

const controller = new SessionGridController({
  readSnapshot: () => snapshotCache.read(),
  getGlobalSettings: () => streamDeck.settings.getGlobalSettings(),
  setGlobalSettings: (settings) => streamDeck.settings.setGlobalSettings(settings),
  setImage: (context, image) =>
    keyActionForContext(context)?.setImage(image) ?? Promise.resolve(),
  activateCodexSession,
  showAlert: (context) =>
    keyActionForContext(context)?.showAlert() ?? Promise.resolve(),
  clock: {
    setInterval: (handler, intervalMs) => setInterval(handler, intervalMs),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    now: () => performance.now(),
  },
});

streamDeck.actions.registerAction(new SessionGridAction(controller));
streamDeck.connect();
