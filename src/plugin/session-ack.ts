/** Read-state acknowledgement through the installed CLI: the only plugin→daemon write path. */
import type { Provider } from "../protocol";
import type { ProcessExecutor } from "./codex-session-activation";

export type AckSession = (provider: Provider, sessionId: string) => Promise<void>;

export const createSessionAck =
  (execute: ProcessExecutor, executablePath: string): AckSession =>
  (provider, sessionId) =>
    execute(executablePath, ["sessions", "ack", provider, sessionId]);
