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
import { SessionGridController } from "./controller";
import { SessionGridAction } from "./session-grid-action";
import { SnapshotCache } from "./snapshot-reader";

const snapshotCache = new SnapshotCache(resolveAppPaths().snapshot);

const controller = new SessionGridController({
  readSnapshot: () => snapshotCache.read(),
  getGlobalSettings: () => streamDeck.settings.getGlobalSettings(),
  setGlobalSettings: (settings) => streamDeck.settings.setGlobalSettings(settings),
  setImage: (context, image) => {
    const target = streamDeck.actions.getActionById(context);
    // The context may have disappeared while a frame was in flight.
    return target !== undefined && target.isKey() ? target.setImage(image) : Promise.resolve();
  },
  clock: {
    setInterval: (handler, intervalMs) => setInterval(handler, intervalMs),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    now: () => performance.now(),
  },
});

streamDeck.actions.registerAction(new SessionGridAction(controller));
streamDeck.connect();
