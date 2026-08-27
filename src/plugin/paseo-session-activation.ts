/**
 * Exact Paseo app navigation behind a small injectable process boundary.
 *
 * The fixed executable and argument array avoid shell parsing; the caller
 * receives only LaunchServices request success or failure, not app-level
 * confirmation that the requested agent became visible. The server id is
 * re-read from disk on every activation so a changed local Paseo host is
 * picked up without restarting the plugin — a read failure rejects here and
 * the controller surfaces it as the standard activation alert.
 */

import type { ProcessExecutor } from "./codex-session-activation";

export type ActivatePaseoSession = (agentId: string) => Promise<void>;

/** The server id identifies the local Paseo host in the deep link; re-read per press. */
export const createPaseoSessionActivator =
  (execute: ProcessExecutor, readServerId: () => string): ActivatePaseoSession =>
  async (agentId) =>
    execute("/usr/bin/open", [
      "-u",
      `paseo://h/${encodeURIComponent(readServerId())}/agent/${encodeURIComponent(agentId)}`,
    ]);
