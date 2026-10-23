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

  // Argument shapes below mirror roborev's ClaudeAgent buildArgs/buildPlanningArgs.
  const reviewArgs = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--model",
    "claude-opus-5-5",
    "--effort",
    "xhigh",
    "--allowedTools",
    "Read,Glob,Grep",
  ];
  const readOnlyConfinement = ["--permission-mode", "plan", "--tools", "Read,Glob,Grep", "--disallowedTools", "mcp__*"];

  test("confines review runs to read-only tools", () => {
    const spawned = runShim(reviewArgs, {});
    expect(spawned.argv).toEqual([...reviewArgs, ...readOnlyConfinement]);
  });

  test("confines structured review runs without disturbing the schema", () => {
    const structuredArgs = [...reviewArgs, "--json-schema", '{"type":"object"}'];
    const spawned = runShim(structuredArgs, {});
    expect(spawned.argv).toEqual([...structuredArgs, ...readOnlyConfinement]);
  });

  test("leaves agentic fix and refine runs their write tools", () => {
    const agenticArgs = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--allowedTools",
      "Edit,MultiEdit,Write,Read,Glob,Grep,Bash",
    ];
    const spawned = runShim(agenticArgs, {});
    expect(spawned.argv).toEqual(agenticArgs);
  });

  test("leaves runs roborev already confined unchanged", () => {
    const planningArgs = [...reviewArgs, ...readOnlyConfinement];
    const spawned = runShim(planningArgs, {});
    expect(spawned.argv).toEqual(planningArgs);
  });

  test("scrubs spawn markers the roborev daemon inherited from its starting shell", () => {
    const spawned = runShim([], { PASEO_AGENT_ID: "stale-agent", TERM_PROGRAM: "ghostty" });
    expect(spawned.environment["PASEO_AGENT_ID"]).toBeUndefined();
    expect(spawned.environment["TERM_PROGRAM"]).toBeUndefined();
    expect(spawned.environment["ROBOREV_SPAWN"]).toBe("shim");
  });
});
