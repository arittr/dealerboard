/**
 * Stream Deck plugin entrypoint — the file the Stream Deck Node.js 24 runtime
 * executes. Wires the SDK-backed ports into the SDK-independent controller,
 * registers the one session-grid action, and connects.
 *
 * The snapshot cache reads the daemon's canonical snapshot path through the
 * shared, Node-safe path resolver; no Bun-only core module is imported here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import streamDeck from "@elgato/streamdeck";
import { createFileDiagnostics } from "../core/diagnostics";
import { resolveAppPaths } from "../core/paths";
import { activateClaudeSession } from "./claude-session-activation";
import { activateCodexSession, executeFile } from "./codex-session-activation";
import { SessionGridController } from "./controller";
import { createEvenerSessionActivator } from "./evener-session-activation";
import { createKimiSessionActivator } from "./kimi-session-activation";
import { createPaseoSessionActivator } from "./paseo-session-activation";
import { createSessionAck } from "./session-ack";
import { SessionGridAction } from "./session-grid-action";
import { SnapshotCache } from "./snapshot-reader";

const appPaths = resolveAppPaths();
const snapshotCache = new SnapshotCache(appPaths.snapshot);
const diagnose = createFileDiagnostics(appPaths.logsDirectory);
const activateKimiSession = createKimiSessionActivator((url) => streamDeck.system.openUrl(url));
const activatePaseoSession = createPaseoSessionActivator(executeFile, () =>
  readFileSync(join(appPaths.home, ".paseo", "server-id"), "utf8").trim(),
);
const activateEvenerSession = createEvenerSessionActivator(executeFile, appPaths.executable);
const ackSession = createSessionAck(executeFile, appPaths.executable);

const keyActionForContext = (context: string) => {
  const target = streamDeck.actions.getActionById(context);
  return target?.isKey() ? target : undefined;
};

// Send failures are expected to be rare; throttle the incident log so a
// broken connection cannot spam it faster than once a minute.
let lastSendFailureLogAt = Number.NEGATIVE_INFINITY;
const setImage = (context: string, image: string): Promise<void> => {
  const send = keyActionForContext(context)?.setImage(image) ?? Promise.resolve();
  return send.catch((error: unknown) => {
    const now = Date.now();
    if (now - lastSendFailureLogAt > 60_000) {
      lastSendFailureLogAt = now;
      diagnose({ timestamp: new Date(now).toISOString(), component: "plugin", code: "set_image_failed" });
    }
    throw error;
  });
};

const controller = new SessionGridController({
  readSnapshot: () => snapshotCache.read(),
  getGlobalSettings: () => streamDeck.settings.getGlobalSettings(),
  setGlobalSettings: (settings) => streamDeck.settings.setGlobalSettings(settings),
  setImage,
  activateClaudeSession,
  activateCodexSession,
  activateKimiSession,
  activatePaseoSession,
  activateEvenerSession,
  ackSession,
  showAlert: (context) => keyActionForContext(context)?.showAlert() ?? Promise.resolve(),
  clock: {
    setInterval: (handler, intervalMs) => setInterval(handler, intervalMs),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    now: () => performance.now(),
  },
});

streamDeck.actions.registerAction(new SessionGridAction(controller, diagnose));
void streamDeck.connect();
