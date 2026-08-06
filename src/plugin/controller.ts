/**
 * SDK-independent lifecycle owner for the session grid.
 *
 * The controller sits between the official Stream Deck SDK adapter and the
 * pure plugin layers. It tracks devices and action contexts, owns the global
 * page settings, polls the snapshot exactly once every 250 ms while relevant
 * keys are visible, and registers every visible context with the shared frame
 * scheduler. All side effects flow through narrow injected ports (snapshot,
 * settings, image, timers, monotonic time), so this module has no Stream Deck
 * SDK or runtime imports and is fully testable with fakes.
 *
 * Exactly one connected 5-column by 3-row keypad device is supported. A
 * second device, wrong dimensions, a non-keypad or coordinate-less context, a
 * duplicate or out-of-grid coordinate, or more than fifteen contexts switches
 * every visible key to one bounded static unsupported-layout treatment —
 * session models and the treatment never mix — until the offending state
 * disappears.
 */

import {
  advanceLayoutPage,
  type KeyModel,
  type LayoutResult,
  type LayoutSettingsV1,
  reduceLayout,
} from "./layout";
import { renderKey } from "./render";
import { FrameScheduler, type SchedulerClock, type SendImage } from "./scheduler";
import type { SnapshotView } from "./snapshot-reader";

export type GridDeviceInfo = {
  columns: number;
  rows: number;
};

export type AppearInfo = {
  context: string;
  deviceId: string;
  device: GridDeviceInfo;
  controller: string;
  coordinates: { row: number; column: number } | undefined;
};

export type SessionGridPorts = {
  readSnapshot: () => SnapshotView;
  getGlobalSettings: () => Promise<unknown>;
  setGlobalSettings: (settings: LayoutSettingsV1) => Promise<void>;
  setImage: SendImage;
  clock: SchedulerClock;
};

const KEYPAD_COLUMNS = 5;
const KEYPAD_ROWS = 3;
const MAX_CONTEXTS = KEYPAD_COLUMNS * KEYPAD_ROWS;
const KEYPAD_CONTROLLER = "Keypad";
const POLL_MS = 250;

const BLANK_MODEL: KeyModel = { kind: "blank", degraded: false };

/** One static tile shown on every key while the layout is unsupported. */
const UNSUPPORTED_LAYOUT_IMAGE = ((): string => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144" font-family="sans-serif">` +
    `<rect width="144" height="144" fill="#10151C"/>` +
    `<text x="72" y="70" text-anchor="middle" font-size="15" fill="#94A3B8">UNSUPPORTED</text>` +
    `<text x="72" y="92" text-anchor="middle" font-size="15" fill="#94A3B8">LAYOUT</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
})();

type ContextEntry = {
  deviceId: string;
  controller: string;
  coordinates: { row: number; column: number } | undefined;
  /** Row-major key index, row * 5 + column; -1 when the context has no cell. */
  index: number;
};

export class SessionGridController {
  private readonly ports: SessionGridPorts;
  private readonly scheduler: FrameScheduler;
  private readonly devices = new Map<string, GridDeviceInfo>();
  private readonly contexts = new Map<string, ContextEntry>();
  private view: SnapshotView | null = null;
  private layout: LayoutResult | null = null;
  private storedSettings: unknown = undefined;
  private settingsLoad: Promise<void> | null = null;
  private settingsReady = false;
  private unsupportedReason: string | null = null;
  private poller: unknown = null;

  constructor(ports: SessionGridPorts) {
    this.ports = ports;
    this.scheduler = new FrameScheduler({
      clock: ports.clock,
      sendImage: ports.setImage,
      renderFrame: (context, phase) => this.renderFrame(context, phase),
    });
  }

  async willAppear(info: AppearInfo): Promise<void> {
    this.devices.set(info.deviceId, info.device);
    if (this.contexts.has(info.context)) {
      // A re-appearing context re-registers fresh rather than duplicating.
      this.scheduler.removeContext(info.context);
    }
    this.contexts.set(info.context, {
      deviceId: info.deviceId,
      controller: info.controller,
      coordinates: info.coordinates,
      index:
        info.coordinates === undefined
          ? -1
          : info.coordinates.row * KEYPAD_COLUMNS + info.coordinates.column,
    });
    this.unsupportedReason = this.computeUnsupportedReason();
    if (this.unsupportedReason !== null) {
      this.stopPolling();
      this.scheduler.addContext(info.context);
      return;
    }
    try {
      await this.ensureSettings();
    } catch {
      // A dropped settings IPC must not escape willAppear as an unhandled
      // rejection. The context stays registered; the next lifecycle event
      // retries the load through bootstrap and converges the grid then.
      return;
    }
    // Settings loading yields; the world may have changed underneath.
    if (!this.contexts.has(info.context)) {
      return;
    }
    if (this.unsupportedReason !== null) {
      this.stopPolling();
      this.scheduler.addContext(info.context);
      return;
    }
    this.convergeGrid();
  }

  willDisappear(context: string): void {
    if (!this.contexts.has(context)) {
      return;
    }
    this.contexts.delete(context);
    // Dropping the scheduler context cancels its pending frames; the last
    // removal also stops the shared animation clock.
    this.scheduler.removeContext(context);
    this.reconcileSupport();
  }

  async keyDown(context: string): Promise<void> {
    if (this.unsupportedReason !== null) {
      return;
    }
    const entry = this.contexts.get(context);
    if (entry === undefined || this.view === null || this.layout === null) {
      return;
    }
    // Session and blank keys are display-only; only NEXT handles input.
    if (this.layout.keys[entry.index]?.kind !== "next") {
      return;
    }
    this.layout = advanceLayoutPage(this.view, this.storedSettings);
    if (this.layout.dirty) {
      await this.persist(this.layout.settings);
    }
  }

  deviceDidConnect(deviceId: string, info: GridDeviceInfo): void {
    this.devices.set(deviceId, info);
    this.reconcileSupport();
  }

  deviceDidDisconnect(deviceId: string): void {
    this.devices.delete(deviceId);
    for (const [context, entry] of this.contexts) {
      if (entry.deviceId === deviceId) {
        this.contexts.delete(context);
        this.scheduler.removeContext(context);
      }
    }
    this.reconcileSupport();
  }

  private computeUnsupportedReason(): string | null {
    if (this.devices.size > 1) {
      return "multiple_devices";
    }
    for (const device of this.devices.values()) {
      if (device.columns !== KEYPAD_COLUMNS || device.rows !== KEYPAD_ROWS) {
        return "unsupported_device_size";
      }
    }
    if (this.contexts.size > MAX_CONTEXTS) {
      return "too_many_contexts";
    }
    const seen = new Set<string>();
    for (const entry of this.contexts.values()) {
      if (entry.controller !== KEYPAD_CONTROLLER || entry.coordinates === undefined) {
        return "non_keypad_context";
      }
      const { row, column } = entry.coordinates;
      if (row < 0 || row >= KEYPAD_ROWS || column < 0 || column >= KEYPAD_COLUMNS) {
        return "coordinate_out_of_bounds";
      }
      const cell = `${entry.deviceId}:${row}:${column}`;
      if (seen.has(cell)) {
        return "duplicate_coordinate";
      }
      seen.add(cell);
    }
    return null;
  }

  private reconcileSupport(): void {
    this.unsupportedReason = this.computeUnsupportedReason();
    if (this.unsupportedReason !== null || this.contexts.size === 0) {
      this.stopPolling();
      return;
    }
    if (!this.settingsReady) {
      // Recovery into a supported grid before settings ever loaded — every
      // appearance so far was itself unsupported — bootstraps the same load
      // the willAppear path performs.
      void this.bootstrap();
      return;
    }
    this.startPolling();
  }

  private async bootstrap(): Promise<void> {
    try {
      await this.ensureSettings();
    } catch {
      return; // The next lifecycle event retries the load.
    }
    if (this.unsupportedReason !== null || this.contexts.size === 0) {
      return;
    }
    this.convergeGrid();
  }

  /**
   * Converge on a live grid: snapshot cached, every registered context
   * rendering, and the poller running. Scheduler registration is idempotent
   * with an immediate first render, so contexts that missed an earlier
   * registration — e.g. their willAppear hit a settings-load rejection — are
   * caught up here with the current cached model.
   */
  private convergeGrid(): void {
    if (this.view === null) {
      this.refreshSnapshot();
    }
    for (const context of this.contexts.keys()) {
      this.scheduler.addContext(context);
    }
    this.startPolling();
  }

  private ensureSettings(): Promise<void> {
    this.settingsLoad ??= this.ports.getGlobalSettings().then(
      (stored) => {
        this.storedSettings = stored;
        this.settingsReady = true;
      },
      (error: unknown) => {
        // A failed load leaves no poisoned latch; the next appear retries.
        this.settingsLoad = null;
        throw error;
      },
    );
    return this.settingsLoad;
  }

  /**
   * Replace the cached view, re-reduce the layout, and persist only when the
   * reduction normalized, clamped, latched, or paged something. Unchanged
   * settings are never rewritten. The scheduler dedupes the actual images.
   */
  private refreshSnapshot(): void {
    this.view = this.ports.readSnapshot();
    this.layout = reduceLayout(this.view, this.storedSettings);
    if (this.layout.dirty) {
      void this.persist(this.layout.settings);
    }
  }

  private async persist(settings: LayoutSettingsV1): Promise<void> {
    try {
      await this.ports.setGlobalSettings(settings);
      this.storedSettings = settings;
    } catch {
      // Best effort: stale stored settings make the next reduce retry.
    }
  }

  private readonly onPoll = (): void => {
    if (this.unsupportedReason !== null || this.contexts.size === 0 || !this.settingsReady) {
      return;
    }
    this.refreshSnapshot();
  };

  private startPolling(): void {
    if (this.poller === null) {
      this.poller = this.ports.clock.setInterval(this.onPoll, POLL_MS);
    }
  }

  private stopPolling(): void {
    if (this.poller !== null) {
      this.ports.clock.clearInterval(this.poller);
      this.poller = null;
    }
  }

  private renderFrame(context: string, phase: number): string {
    if (this.unsupportedReason !== null) {
      return UNSUPPORTED_LAYOUT_IMAGE;
    }
    const entry = this.contexts.get(context);
    const model = entry === undefined ? undefined : this.layout?.keys[entry.index];
    return renderKey(model ?? BLANK_MODEL, phase);
  }
}
