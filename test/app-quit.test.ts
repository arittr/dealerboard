import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { quitRunningApp } from "../scripts/app-quit";

/** True while the pid names a live (or not-yet-reaped) process. */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Spawn a real child and wait until it is observably running. */
const spawnChild = async (command: string): Promise<{ pid: number; kill: () => void }> => {
  const child = spawn("sh", ["-c", command], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("child failed to spawn");
  }
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return { pid, kill: () => child.kill("SIGKILL") };
};

const realDeps = (pid: number) => ({
  pids: () => (isAlive(pid) ? [pid] : []),
  terminate: (target: number) => process.kill(target, "SIGTERM"),
});

describe("quitRunningApp", () => {
  test("reports not-running and signals nothing when no instance exists", async () => {
    const outcome = await quitRunningApp({
      pids: () => [],
      terminate: () => {
        throw new Error("must not signal when nothing is running");
      },
      timeoutMs: 1000,
      pollMs: 20,
    });
    expect(outcome).toBe("not-running");
  });

  test("terminates a real process and returns quit once it is gone", async () => {
    const child = await spawnChild("sleep 60");
    try {
      const outcome = await quitRunningApp({ ...realDeps(child.pid), timeoutMs: 5000, pollMs: 20 });
      expect(outcome).toBe("quit");
      expect(isAlive(child.pid)).toBe(false);
    } finally {
      child.kill();
    }
  });

  test("treats a process that exits between discovery and signalling as quit", async () => {
    const child = await spawnChild("sleep 60");
    child.kill();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(isAlive(child.pid)).toBe(false);
    let discoveries = 0;
    const outcome = await quitRunningApp({
      pids: () => (discoveries++ === 0 ? [child.pid] : []),
      terminate: (target) => process.kill(target, "SIGTERM"),
      timeoutMs: 1000,
      pollMs: 20,
    });
    expect(outcome).toBe("quit");
  });

  test("throws when the process survives SIGTERM past the timeout", async () => {
    const child = await spawnChild('trap "" TERM; sleep 60');
    try {
      // Let sh install its TERM trap before signalling, else TERM lands first.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(quitRunningApp({ ...realDeps(child.pid), timeoutMs: 400, pollMs: 20 })).rejects.toThrow(
        /still running/,
      );
      expect(isAlive(child.pid)).toBe(true);
    } finally {
      child.kill();
    }
  });
});
