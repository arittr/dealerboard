/**
 * Explicit macOS-local installer for the Dealerboard Xeneon app: build the
 * release bundle (frontend + Tauri), quit any running instance so the
 * replaced binary is what actually runs, replace the installed copy in
 * /Applications, then relaunch whatever was quit. The destructive steps are
 * signalling the installed app's own binary path and replacing a path that
 * must end in .app.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { quitRunningApp } from "./app-quit";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_NAME = "Dealerboard.app";
const BUNDLE_PATH = join(REPO_ROOT, "app/src-tauri/target/release/bundle/macos", APP_NAME);
const INSTALL_PATH = join("/Applications", APP_NAME);

const run = (step: string, command: string, args: readonly string[]): void => {
  const result = spawnSync(command, [...args], { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    process.stderr.write(`install-app: step "${step}" failed with status ${result.status ?? "signal"}\n`);
    process.exit(1);
  }
};

/**
 * Pids of the installed app binary only — the daemon shares the executable
 * name, so discovery matches the full installed path, never the bare name.
 */
const installedAppPids = (): number[] => {
  const result = spawnSync("pgrep", ["-f", join(INSTALL_PATH, "Contents/MacOS/dealerboard")], { encoding: "utf8" });
  if (result.status !== 0 && result.status !== 1) {
    process.stderr.write(`install-app: pgrep failed with status ${result.status ?? "signal"}\n`);
    process.exit(1);
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => Number.parseInt(line, 10));
};

run("build", "bun", ["run", "bundle:app"]);
if (!existsSync(BUNDLE_PATH)) {
  process.stderr.write(`install-app: bundle missing at ${BUNDLE_PATH}\n`);
  process.exit(1);
}
const quitOutcome = await quitRunningApp({
  pids: installedAppPids,
  terminate: (pid) => process.kill(pid, "SIGTERM"),
  timeoutMs: 10_000,
  pollMs: 200,
}).catch((error: unknown) => {
  process.stderr.write(`install-app: ${error instanceof Error ? error.message : String(error)}\n`);
  return process.exit(1);
});
if (existsSync(INSTALL_PATH)) {
  if (!INSTALL_PATH.endsWith(".app")) {
    process.stderr.write(`install-app: refusing to remove non-app path ${INSTALL_PATH}\n`);
    process.exit(1);
  }
  rmSync(INSTALL_PATH, { recursive: true });
}
cpSync(BUNDLE_PATH, INSTALL_PATH, { recursive: true });
process.stdout.write(`install-app: installed ${INSTALL_PATH}\n`);
if (quitOutcome === "quit") {
  run("relaunch", "open", [INSTALL_PATH]);
  process.stdout.write("install-app: relaunched the running app on the new bundle\n");
} else {
  process.stdout.write(
    "install-app: launch it once (open -a 'Dealerboard'); login autostart enables itself on first run\n",
  );
}
