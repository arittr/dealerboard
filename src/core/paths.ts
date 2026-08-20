/**
 * Canonical per-user filesystem locations for the registry database,
 * snapshot, logs, installed executable, and LaunchAgent. Resolution is pure;
 * directory creation and permission enforcement are explicit so tests can
 * point at a temporary home without touching the real one.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AppPaths = {
  home: string;
  root: string;
  binDirectory: string;
  executable: string;
  database: string;
  snapshot: string;
  quotaSnapshot: string;
  tokenUsageSnapshot: string;
  logsDirectory: string;
  launchAgent: string;
};

const APPLICATION_DIRECTORY_MODE = 0o700;

export const resolveAppPaths = (home: string = homedir()): AppPaths => {
  const root = join(home, "Library/Application Support/com.drewritter.stream-deck-agents");
  const binDirectory = join(root, "bin");
  return {
    home,
    root,
    binDirectory,
    executable: join(binDirectory, "stream-deck-agents"),
    database: join(root, "registry.sqlite3"),
    snapshot: join(root, "snapshot-v2.json"),
    quotaSnapshot: join(root, "quota-snapshot.json"),
    tokenUsageSnapshot: join(root, "token-usage-snapshot.json"),
    logsDirectory: join(root, "logs"),
    launchAgent: join(home, "Library/LaunchAgents/com.drewritter.stream-deck-agents.plist"),
  };
};

export const ensureAppDirectories = (paths: AppPaths): void => {
  for (const directory of [paths.root, paths.binDirectory, paths.logsDirectory]) {
    mkdirSync(directory, { recursive: true, mode: APPLICATION_DIRECTORY_MODE });
    // mkdir's mode only applies to newly created directories; chmod also
    // corrects a permissive pre-existing mode.
    chmodSync(directory, APPLICATION_DIRECTORY_MODE);
  }
};
