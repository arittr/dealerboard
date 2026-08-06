/**
 * Two-process SQLite contention smoke helper — spawned, never imported.
 *
 * Usage: bun test/helpers/event-process.ts <database-path> <session-id>
 *
 * Opens its own read-write connection to the given temporary registry and
 * applies one real `SessionStart` through the registry mutation layer, then
 * exits zero. The CLI test suite's process smoke spawns two copies against
 * one database to prove real cross-process slot allocation.
 */

import { applyRegistryEvents } from "../../src/core/registry";
import { openRegistryDatabase } from "../../src/core/schema";

const args = process.argv.slice(2);
const [databasePath, sessionId] = args;
if (args.length !== 2 || databasePath === undefined || sessionId === undefined || sessionId.length === 0) {
  process.stderr.write("usage: event-process <database-path> <session-id>\n");
  process.exit(1);
}

const db = openRegistryDatabase(databasePath, "readwrite");
try {
  applyRegistryEvents(db, [
    {
      kind: "SessionStart",
      provider: "claude",
      sessionId,
      title: null,
      project: null,
      observedAt: new Date().toISOString(),
    },
  ]);
} finally {
  db.close();
}
