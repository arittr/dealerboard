import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHIM = join(import.meta.dir, "..", "scripts", "roborev-claude-shim");

/** Run the shim against a fake `claude` that records its argv and environment. */
const runShim = (
  args: string[],
  environment: Record<string, string>,
): { argv: string[]; environment: Record<string, string> } => {
  const stage = mkdtempSync(join(tmpdir(), "dealerboard-roborev-shim-"));
  try {
    const argvRecord = join(stage, "argv");
    const envRecord = join(stage, "env");
    const fake = join(stage, "claude");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvRecord}"\nenv > "${envRecord}"\n`);
    chmodSync(fake, 0o755);
    const result = spawnSync(SHIM, args, {
      env: { ...environment, PATH: `${stage}:/usr/bin:/bin` },
    });
    expect(result.status).toBe(0);
    const argv = readFileSync(argvRecord, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    const spawnedEnvironment: Record<string, string> = {};
    for (const line of readFileSync(envRecord, "utf8").split("\n")) {
      const separator = line.indexOf("=");
      if (separator > 0) {
        spawnedEnvironment[line.slice(0, separator)] = line.slice(separator + 1);
      }
    }
    return { argv, environment: spawnedEnvironment };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

describe("roborev claude shim", () => {
  test("plants the roborev marker and forwards every argument", () => {
    const spawned = runShim(["-p", "--output-format", "stream-json"], {});
    expect(spawned.environment["ROBOREV_SPAWN"]).toBe("shim");
    expect(spawned.argv).toEqual(["-p", "--output-format", "stream-json"]);
  });

  test("scrubs spawn markers the roborev daemon inherited from its starting shell", () => {
    const spawned = runShim([], { PASEO_AGENT_ID: "stale-agent", TERM_PROGRAM: "ghostty" });
    expect(spawned.environment["PASEO_AGENT_ID"]).toBeUndefined();
    expect(spawned.environment["TERM_PROGRAM"]).toBeUndefined();
    expect(spawned.environment["ROBOREV_SPAWN"]).toBe("shim");
  });
});
