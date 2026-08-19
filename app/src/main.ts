/**
 * App entry: poll the daemon snapshot every 2s, reduce layout with the strip
 * geometry, and re-render only when the serialized key models change (so CSS
 * status animations are never restarted by a no-op poll). Page settings
 * persist to localStorage; the reducer validates them on every read.
 */

import { type LayoutResult, reduceLayout, STRIP_GEOMETRY } from "../../src/plugin/layout";
import type { SessionSnapshotV2 } from "../../src/protocol";
import { readSnapshot } from "./bridge";
import { reduceSnapshotRead } from "./snapshot-view";
import { renderTiles } from "./tiles";

const POLL_MS = 2000;
const SETTINGS_KEY = "agent-strip.layout.v1";

let lastGood: SessionSnapshotV2 | null = null;
let renderedSignature = "";

const loadStoredSettings = (): unknown => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
  } catch {
    return null;
  }
};

const persistSettings = (settings: unknown): void => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Best effort: a dropped page preference re-derives on the next poll.
  }
};

const applyLayout = (layout: LayoutResult): void => {
  if (layout.dirty) {
    persistSettings(layout.settings);
  }
  const signature = JSON.stringify(layout.keys);
  const root = document.querySelector<HTMLElement>("#tiles");
  if (root !== null && signature !== renderedSignature) {
    renderedSignature = signature;
    renderTiles(root, layout.keys);
  }
};

const poll = async (): Promise<void> => {
  const payload = await readSnapshot().catch(() => null);
  const reduction = reduceSnapshotRead(payload, lastGood, Date.now());
  lastGood = reduction.lastGood;
  applyLayout(reduceLayout(reduction.view, loadStoredSettings(), STRIP_GEOMETRY));
};

const start = (): void => {
  void poll();
  setInterval(() => {
    void poll();
  }, POLL_MS);
};

start();
