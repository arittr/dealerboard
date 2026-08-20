/**
 * Atomic publication of the session snapshot — the only file the Stream
 * Deck plugin ever reads. `writeFileAtomically` is the shared primitive,
 * also used by the quota collector for `quota-snapshot.json`.
 *
 * The snapshot is serialized as JSON plus one trailing newline to a unique
 * sibling temporary file in the same directory, opened with mode `0600`,
 * written, fsynced, chmodded to `0600` (the open mode is subject to umask),
 * closed, and then `renameSync`ed over the target so readers only ever see a
 * complete file: the previous snapshot or the new one, never a partial
 * write. The temporary sibling is removed in `finally` if publication fails
 * before the rename.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SessionSnapshotV2 } from "../protocol";

const SNAPSHOT_FILE_MODE = 0o600;

/**
 * The atomic-publish primitive behind every file this project owns: serialize
 * to a unique sibling temporary file (mode 0600, fsynced), then rename over
 * the target so readers only ever see a complete file.
 */
export const writeFileAtomically = (path: string, payload: string): void => {
  const tempPath = join(dirname(path), `.${basename(path)}-${process.pid}-${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const fd = openSync(tempPath, "wx", SNAPSHOT_FILE_MODE);
    let closed = false;
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
      chmodSync(tempPath, SNAPSHOT_FILE_MODE);
      closeSync(fd);
      closed = true;
    } finally {
      if (!closed) {
        try {
          closeSync(fd);
        } catch {
          // The original failure is the one worth propagating.
        }
      }
    }
    renameSync(tempPath, path);
    renamed = true;
  } finally {
    if (!renamed) {
      rmSync(tempPath, { force: true });
    }
  }
};

export const writeSnapshotAtomically = (path: string, snapshot: SessionSnapshotV2): void => {
  writeFileAtomically(path, `${JSON.stringify(snapshot)}\n`);
};
