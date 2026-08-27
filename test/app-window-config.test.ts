import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type WindowConfig = { label: string; acceptFirstMouse?: boolean };

const config = JSON.parse(readFileSync(new URL("../app/src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
  app: { windows: WindowConfig[] };
};

describe("tauri window configuration", () => {
  // The strip window is almost never the macOS-active app. Without
  // acceptFirstMouse, WKWebView refuses the first mouse of a background
  // window: taps mostly survive AppKit's activation-click handling, but a
  // stroke with movement never delivers its moves or release to the page,
  // so swipes and flicks silently die. The recognizer (gestures.ts) can
  // only see what the window lets through.
  test("the main window accepts first mouse so strokes reach the page while the app is inactive", () => {
    const main = config.app.windows.find((window) => window.label === "main");
    expect(main?.acceptFirstMouse).toBe(true);
  });
});
