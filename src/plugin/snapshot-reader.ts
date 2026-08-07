/**
 * Replacement-aware cache for the daemon-published session snapshot — the
 * only file the Stream Deck plugin ever reads.
 *
 * The daemon publishes atomically by sibling rename (see
 * src/core/snapshot.ts), so a new snapshot always arrives under a new file
 * identity. This cache stats the file on every read and reparses only when
 * the identity tuple (dev, ino, size, mtimeNs) changes. It keeps exactly one
 * process-lifetime last-good snapshot: a missing, malformed, unsupported, or
 * explicitly unhealthy file yields the last-good snapshot marked degraded,
 * or an empty degraded view when no healthy snapshot was ever read. File age
 * is never used as a health signal.
 *
 * This module is bundled into the Node.js plugin, so it uses node:fs only —
 * no Bun APIs and no Stream Deck SDK imports.
 */

import { readFileSync, statSync } from "node:fs";
import { parseSessionSnapshot, type SessionSnapshotV2 } from "../protocol";

export type SnapshotView = {
  snapshot: SessionSnapshotV2;
  degraded: boolean;
};

type FileIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
};

const EMPTY_DEGRADED_SNAPSHOT: SessionSnapshotV2 = {
  schemaVersion: 2,
  health: { status: "error", message: "snapshot_unavailable" },
  sessions: [],
};

const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

export class SnapshotCache {
  readonly #path: string;
  #identity: FileIdentity | null = null;
  #view: SnapshotView | null = null;
  #lastGood: SessionSnapshotV2 | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  read(): SnapshotView {
    const identity = this.#statIdentity();
    if (identity === null) {
      // A missing or unreadable file has no identity to cache against.
      return this.#degraded();
    }
    if (this.#identity !== null && this.#view !== null && sameIdentity(identity, this.#identity)) {
      return this.#view;
    }
    const view = this.#readReplacement();
    this.#identity = identity;
    this.#view = view;
    return view;
  }

  #statIdentity(): FileIdentity | null {
    try {
      const stats = statSync(this.#path, { bigint: true });
      return {
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeNs: stats.mtimeNs,
      };
    } catch {
      return null;
    }
  }

  #readReplacement(): SnapshotView {
    let snapshot: SessionSnapshotV2;
    try {
      snapshot = parseSessionSnapshot(JSON.parse(readFileSync(this.#path, "utf8")));
    } catch {
      return this.#degraded();
    }
    if (snapshot.health.status !== "ok") {
      // An explicitly unhealthy snapshot never becomes the last good one.
      return this.#degraded();
    }
    this.#lastGood = snapshot;
    return { snapshot, degraded: false };
  }

  #degraded(): SnapshotView {
    return { snapshot: this.#lastGood ?? EMPTY_DEGRADED_SNAPSHOT, degraded: true };
  }
}
