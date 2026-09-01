/**
 * Quit logic for a running Dealerboard strip app instance, extracted from
 * install-app.ts so the terminate-and-wait contract is testable in
 * isolation. Pure in its decisions, physical only through the injected
 * process primitives: the caller supplies pid discovery and termination.
 */

export type QuitOutcome = "not-running" | "quit";

export const quitRunningApp = async (options: {
  pids: () => number[];
  terminate: (pid: number) => void;
  timeoutMs: number;
  pollMs: number;
}): Promise<QuitOutcome> => {
  const initial = options.pids();
  if (initial.length === 0) {
    return "not-running";
  }
  for (const pid of initial) {
    try {
      options.terminate(pid);
    } catch {
      // A pid that died between discovery and signalling is already the
      // outcome the signal was after; the wait loop below confirms it.
    }
  }
  const deadline = Date.now() + options.timeoutMs;
  while (options.pids().length > 0) {
    if (Date.now() >= deadline) {
      throw new Error(`app still running ${options.timeoutMs}ms after SIGTERM`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
  return "quit";
};
