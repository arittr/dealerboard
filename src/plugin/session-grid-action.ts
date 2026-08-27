/**
 * Thin official-SDK adapter for the session grid.
 *
 * Translates typed SDK events into SessionGridController calls and back. It
 * contains no layout, render, or paging logic: coordinates pass through
 * 0-indexed exactly as the SDK reports them, settings are loaded through the
 * SDK global settings API, and only controller-requested settings updates are
 * written. Device connect/disconnect is subscribed through the official
 * device events.
 */

import streamDeck, {
  action,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { DiagnosticRecord } from "../core/diagnostics";
import type { SessionGridController } from "./controller";

export const SESSION_GRID_ACTION_UUID = "com.drewritter.dealerboard.session-grid";

@action({ UUID: SESSION_GRID_ACTION_UUID })
export class SessionGridAction extends SingletonAction {
  private readonly controller: SessionGridController;

  constructor(controller: SessionGridController, diagnose: (record: DiagnosticRecord) => void) {
    super();
    this.controller = controller;
    streamDeck.devices.onDeviceDidConnect((ev) => {
      this.controller.deviceDidConnect(ev.device.id, {
        columns: ev.device.size.columns,
        rows: ev.device.size.rows,
      });
    });
    streamDeck.devices.onDeviceDidDisconnect((ev) => {
      this.controller.deviceDidDisconnect(ev.device.id);
    });
    streamDeck.system.onSystemDidWakeUp(() => {
      diagnose({ timestamp: new Date().toISOString(), component: "plugin", code: "wake_up" });
      this.controller.systemDidWakeUp();
    });
  }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    await this.controller.willAppear({
      context: ev.action.id,
      deviceId: ev.action.device.id,
      device: {
        columns: ev.action.device.size.columns,
        rows: ev.action.device.size.rows,
      },
      controller: ev.payload.controller,
      coordinates: ev.payload.isInMultiAction
        ? undefined
        : { row: ev.payload.coordinates.row, column: ev.payload.coordinates.column },
    });
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.controller.willDisappear(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    await this.controller.keyDown(ev.action.id);
  }
}
