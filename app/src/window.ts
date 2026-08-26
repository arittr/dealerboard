/**
 * Pins the frameless window onto the Xeneon Edge. Detection prefers the
 * EDID model string, falling back to the exact physical resolution (physical
 * size is scaling-independent, so a HiDPI 1280x360 mode still matches). A
 * 5s re-pin interval covers panel reconnects; with no strip attached the
 * window is left alone as a normal floating window.
 */

import {
  availableMonitors,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
  type Monitor,
} from "@tauri-apps/api/window";
import { isStripMonitor } from "./monitors";

const REPIN_INTERVAL_MS = 5000;

type Point = { readonly x: number; readonly y: number };
type Dimensions = { readonly width: number; readonly height: number };
type WindowGeometry = { readonly position: Point; readonly size: Dimensions };

/**
 * A monitor's frame in logical pixels, divided by its own scale factor.
 * Monitor frames arrive physical, but plain physical values fed to
 * setPosition/setSize are interpreted against the window's CURRENT display —
 * from the 2x main display the strip's coordinates would halve, landing the
 * window mid-main at half size, and the re-pin loop never converges. Logical
 * coordinates are scale-independent, so the move lands regardless of where
 * the window starts.
 */
export const logicalPinFrame = (monitor: {
  position: Point;
  size: Dimensions;
  scaleFactor: number;
}): WindowGeometry => ({
  position: { x: monitor.position.x / monitor.scaleFactor, y: monitor.position.y / monitor.scaleFactor },
  size: { width: monitor.size.width / monitor.scaleFactor, height: monitor.size.height / monitor.scaleFactor },
});

export const stripWindowNeedsPin = (
  isFullscreen: boolean,
  position: Point,
  size: Dimensions,
  strip: WindowGeometry,
): boolean =>
  !isFullscreen &&
  (position.x !== strip.position.x ||
    position.y !== strip.position.y ||
    size.width !== strip.size.width ||
    size.height !== strip.size.height);

const findStripMonitor = async (): Promise<Monitor | undefined> =>
  (await availableMonitors()).find((monitor) =>
    isStripMonitor({ name: monitor.name, width: monitor.size.width, height: monitor.size.height }),
  );

const pinTo = async (target: Monitor): Promise<void> => {
  const window = getCurrentWindow();
  const frame = logicalPinFrame(target);
  await window.setPosition(new LogicalPosition(frame.position.x, frame.position.y));
  await window.setSize(new LogicalSize(frame.size.width, frame.size.height));
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
      const isFullscreen = await window.isFullscreen().catch(() => null);
      if (isFullscreen === null) {
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
      if (stripWindowNeedsPin(isFullscreen, position, size, strip)) {
        await pinTo(strip).catch(() => {});
      }
    })();
  }, REPIN_INTERVAL_MS);
};
