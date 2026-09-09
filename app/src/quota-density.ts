/** The rail's one application-level quota layout setting. */
export type QuotaDensity = "comfortable" | "compact";

export const QUOTA_DENSITY: QuotaDensity = "comfortable";

export const QUOTA_DENSITY_PRESETS = {
  comfortable: { scale: 1.2, rowHeight: 40, providerGap: 16 },
  compact: { scale: 1, rowHeight: 31, providerGap: 10 },
} as const;
