import { describe, expect, test } from "bun:test";
import { DEFAULT_BOARD_SETTINGS, validateBoardSettings } from "../app/src/board-settings";

describe("validateBoardSettings", () => {
  test("restores a valid value", () => {
    expect(validateBoardSettings({ schemaVersion: 1, currentPage: 3 })).toEqual({
      settings: { schemaVersion: 1, currentPage: 3 },
      defaulted: false,
    });
  });

  test("defaults wrong-typed, wrong-version, and missing fields", () => {
    const invalid: unknown[] = [
      null,
      undefined,
      "page",
      42,
      [],
      { schemaVersion: 2, currentPage: 0 },
      { schemaVersion: 1, currentPage: -1 },
      { schemaVersion: 1, currentPage: 1.5 },
      { schemaVersion: 1, currentPage: "0" },
      { schemaVersion: 1 },
      { currentPage: 0 },
    ];
    for (const stored of invalid) {
      expect(validateBoardSettings(stored)).toEqual({ settings: DEFAULT_BOARD_SETTINGS, defaulted: true });
    }
  });

  test("tolerates unknown keys, including a legacy overflowLatched", () => {
    expect(validateBoardSettings({ schemaVersion: 1, overflowLatched: true, currentPage: 2 })).toEqual({
      settings: { schemaVersion: 1, currentPage: 2 },
      defaulted: false,
    });
    expect(validateBoardSettings({ schemaVersion: 1, overflowLatched: "yes", currentPage: 2 })).toEqual({
      settings: { schemaVersion: 1, currentPage: 2 },
      defaulted: false,
    });
    expect(validateBoardSettings({ schemaVersion: 1, currentPage: 2, future: "x" })).toEqual({
      settings: { schemaVersion: 1, currentPage: 2 },
      defaulted: false,
    });
  });
});
