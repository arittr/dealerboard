/**
 * Atomic publication of the session snapshot — the only file the Stream
 * Deck plugin ever reads.
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
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { SessionSnapshotV2 } from "../protocol";

const SNAPSHOT_FILE_MODE = 0o600;

export const writeSnapshotAtomically = (path: string, snapshot: SessionSnapshotV2): void => {
  const tempPath = join(
    dirname(path),
    `.snapshot-${process.pid}-${randomUUID()}.tmp`,
  );
  const payload = `${JSON.stringify(snapshot)}\n`;
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
