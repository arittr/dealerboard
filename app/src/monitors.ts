/**
 * Xeneon Edge identification: prefer the monitor model string (the panel
 * reports "XENEON EDGE" over EDID), fall back to its exact physical
 * resolution. Physical size is used so a scaled 1280x360 HiDPI mode still
 * matches.
 */

export type MonitorInfo = { name: string | null; width: number; height: number };

const STRIP_NAME_FRAGMENT = "xeneon edge";
const STRIP_PHYSICAL_WIDTH = 2560;
const STRIP_PHYSICAL_HEIGHT = 720;

export const isStripMonitor = (monitor: MonitorInfo): boolean => {
  if (monitor.name !== null && monitor.name.toLowerCase().includes(STRIP_NAME_FRAGMENT)) {
    return true;
  }
  return monitor.width === STRIP_PHYSICAL_WIDTH && monitor.height === STRIP_PHYSICAL_HEIGHT;
};
