/**
 * Ordering gate for snapshot ingestion. Reads and pushes both feed the one
 * `ingest` reduction in main.ts, but reads are async while pushes are
 * synchronous: a push can land while a read is outstanding, and the read's
 * completion — an older payload, or null for a failed read — must never
 * overwrite the newer pushed state, the visible layout, or the expiry
 * timer. Every ingest source claims a token when it starts; a completion
 * applies only while its token is still the newest claim.
 */

export type IngestGate = {
  /** Claim the newest slot; invalidates every earlier token. */
  next: () => number;
  /** True when `token` is still the newest claim. */
  isCurrent: (token: number) => boolean;
};

export const createIngestGate = (): IngestGate => {
  let generation = 0;
  return {
    next: () => {
      generation += 1;
      return generation;
    },
    isCurrent: (token: number) => token === generation,
  };
};
