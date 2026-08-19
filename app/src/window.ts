/**
 * Pins the frameless window onto the Xeneon Edge. Detection prefers the
 * EDID model string, falling back to the exact physical resolution (physical
 * size is scaling-independent, so a HiDPI 1280x360 mode still matches). A
 * 5s re-pin interval covers panel reconnects; with no strip attached the
 * window is left alone as a normal floating window.
 */

import { availableMonitors, getCurrentWindow, type Monitor } from "@tauri-apps/api/window";
import { isStripMonitor } from "./monitors";

const REPIN_INTERVAL_MS = 5000;

const findStripMonitor = async (): Promise<Monitor | undefined> =>
  (await availableMonitors()).find((monitor) =>
    isStripMonitor({ name: monitor.name, width: monitor.size.width, height: monitor.size.height }),
  );

const pinTo = async (target: Monitor): Promise<void> => {
  const window = getCurrentWindow();
  await window.setPosition(target.position);
  await window.setSize(target.size);
};

export const startStripWindowManager = async (): Promise<void> => {
  const window = getCurrentWindow();
  const initial = await findStripMonitor().catch(() => undefined);
  if (initial !== undefined) {
    await pinTo(initial).catch(() => {});
  }
  setInterval(() => {
    void (async () => {
      const strip = await findStripMonitor().catch(() => undefined);
      if (strip === undefined) {
        return;
      }
      const position = await window.outerPosition().catch(() => null);
      if (position === null) {
        return;
      }
      const size = await window.outerSize().catch(() => null);
      if (size === null) {
        return;
      }
      if (
        position.x !== strip.position.x ||
        position.y !== strip.position.y ||
        size.width !== strip.size.width ||
        size.height !== strip.size.height
      ) {
        await pinTo(strip).catch(() => {});
      }
    })();
  }, REPIN_INTERVAL_MS);
};
