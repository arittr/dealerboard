/**
 * Explicit macOS-local installer for the Agent Strip Xeneon app: build the
 * release bundle (frontend + Tauri), then replace the installed copy in
 * /Applications. The only destructive step is replacing a path that must end
 * in .app.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_NAME = "Agent Strip.app";
const BUNDLE_PATH = join(REPO_ROOT, "app/src-tauri/target/release/bundle/macos", APP_NAME);
const INSTALL_PATH = join("/Applications", APP_NAME);

const run = (step: string, command: string, args: readonly string[]): void => {
  const result = spawnSync(command, [...args], { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    process.stderr.write(`install-app: step "${step}" failed with status ${result.status ?? "signal"}\n`);
    process.exit(1);
  }
};

run("build", "bun", ["run", "bundle:app"]);
if (!existsSync(BUNDLE_PATH)) {
  process.stderr.write(`install-app: bundle missing at ${BUNDLE_PATH}\n`);
  process.exit(1);
}
if (existsSync(INSTALL_PATH)) {
  if (!INSTALL_PATH.endsWith(".app")) {
    process.stderr.write(`install-app: refusing to remove non-app path ${INSTALL_PATH}\n`);
    process.exit(1);
  }
  rmSync(INSTALL_PATH, { recursive: true });
}
cpSync(BUNDLE_PATH, INSTALL_PATH, { recursive: true });
process.stdout.write(`install-app: installed ${INSTALL_PATH}\n`);
process.stdout.write(
  "install-app: launch it once (open -a 'Agent Strip'); login autostart enables itself on first run\n",
);
