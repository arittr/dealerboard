import type { ProcessExecutor } from "./codex-session-activation";

export type ActivateEvenerSession = (sessionId: string) => Promise<void>;

export const createEvenerSessionActivator =
  (execute: ProcessExecutor, executablePath: string): ActivateEvenerSession =>
  (sessionId) =>
    execute(executablePath, ["sessions", "activate", "evener", sessionId]);
