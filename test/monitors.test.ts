import { describe, expect, test } from "bun:test";
import { isStripMonitor } from "../app/src/monitors";

describe("isStripMonitor", () => {
  test("matches the XENEON EDGE model string, case-insensitively", () => {
    expect(isStripMonitor({ name: "XENEON EDGE", width: 1920, height: 1080 })).toBe(true);
    expect(isStripMonitor({ name: "Corsair Xeneon Edge 14.5", width: 1, height: 1 })).toBe(true);
  });

  test("falls back to the exact physical resolution when the name is absent", () => {
    expect(isStripMonitor({ name: null, width: 2560, height: 720 })).toBe(true);
  });

  test("rejects unrelated names and other resolutions", () => {
    expect(isStripMonitor({ name: "LG UltraFine", width: 2560, height: 1440 })).toBe(false);
    expect(isStripMonitor({ name: null, width: 1280, height: 360 })).toBe(false);
  });
});
