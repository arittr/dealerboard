/**
 * Persisted page settings for the strip board, superseding the retired
 * Stream Deck plugin's layout settings. Unknown keys are ignored so a stored
 * value from an older build (notably a legacy `overflowLatched`) still reads.
 */

export type BoardSettingsV1 = {
  schemaVersion: 1;
  currentPage: number;
};

export const DEFAULT_BOARD_SETTINGS: BoardSettingsV1 = {
  schemaVersion: 1,
  currentPage: 0,
};

export type ValidatedBoardSettings = {
  settings: BoardSettingsV1;
  defaulted: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateBoardSettings = (stored: unknown): ValidatedBoardSettings => {
  if (isRecord(stored)) {
    const value = stored;
    if (
      value["schemaVersion"] === 1 &&
      typeof value["currentPage"] === "number" &&
      Number.isSafeInteger(value["currentPage"]) &&
      value["currentPage"] >= 0
    ) {
      return {
        settings: {
          schemaVersion: 1,
          currentPage: value["currentPage"],
        },
        defaulted: false,
      };
    }
  }
  return { settings: { ...DEFAULT_BOARD_SETTINGS }, defaulted: true };
};
