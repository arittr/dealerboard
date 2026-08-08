/**
 * Explicit macOS-local installer for the hook-driven session registry.
 *
 * Step order (any pre-hook failure exits nonzero immediately; this script
 * never edits provider configuration):
 *   1. Require macOS; canonical paths resolve through node:os homedir().
 *   2. Run the repository build and plugin validate/package commands with an
 *      explicit working directory.
 *   3. Create or correct the application directories to mode 0700.
 *   4. Copy the compiled core to the canonical executable, chmod 0700.
 *   5. Run the installed executable's init; verify the latest schema version.
 *   6. Replace the exact executable/log tokens in the plist template, write
 *      the canonical plist at mode 0600, and validate with plutil -lint.
 *   7. Boot out the exact existing service only if present, then bootstrap
 *      and kickstart the exact label.
 *   8. Install the single packaged plugin from dist and restart it through
 *      the official Stream Deck CLI.
 *   9. Print the canonical paths; provider hooks remain uninstalled.
 *
 * Every subprocess runs through spawnSync with an argument array — no shell
 * command strings — and every tool path is absolute.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAppDirectories, resolveAppPaths } from "../src/core/paths";
import { LATEST_SCHEMA_VERSION } from "../src/core/schema";

const LABEL = "com.drewritter.stream-deck-agents";
const PLIST_TEMPLATE = "launchd/com.drewritter.stream-deck-agents.plist.template";
const STREAMDECK_CLI = "node_modules/@elgato/cli/bin/streamdeck.mjs";
const BUILT_CORE = "dist/stream-deck-agents";
const PACKAGE_SUFFIX = ".streamDeckPlugin";

const EXECUTABLE_TOKEN = "__STREAM_DECK_AGENTS_EXECUTABLE__";
const LOGS_TOKEN = "__STREAM_DECK_AGENTS_LOGS_DIRECTORY__";
const TOKEN_MARKER = "__STREAM_DECK_AGENTS_";

const EXECUTABLE_MODE = 0o700;
const PLIST_MODE = 0o600;

const LAUNCHCTL = "/bin/launchctl";
const PLUTIL = "/usr/bin/plutil";
const OPEN = "/usr/bin/open";

/** Repository root: this script lives at <root>/scripts/install-local.ts. */
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const fail = (step: string, detail: string): never => {
  process.stderr.write(`install-local: step "${step}" failed: ${detail}\n`);
  process.stderr.write("install-local: aborted; provider configuration was not modified\n");
  process.exit(1);
};

/** Run one subprocess with an argument array, inheriting stdio. */
const run = (step: string, command: string, args: readonly string[]): void => {
  const result = spawnSync(command, [...args], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    fail(step, `${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(step, `${command} exited with status ${String(result.status)}`);
  }
};

const main = (): void => {
  // 1. macOS only; resolveAppPaths resolves the home directory via node:os.
  if (process.platform !== "darwin") {
    fail("platform", "this installer supports macOS only");
  }
  process.umask(0o077);
  const paths = resolveAppPaths();

  // 2. Core/plugin build, then plugin validate + package.
  run("build", process.execPath, ["run", "build"]);
  run("package-plugin", process.execPath, ["run", "pack:plugin"]);

  // 3. Application directories, created or corrected to 0700.
  ensureAppDirectories(paths);

  // 4. Install the compiled core as the canonical executable.
  copyFileSync(join(repositoryRoot, BUILT_CORE), paths.executable);
  chmodSync(paths.executable, EXECUTABLE_MODE);

  // 5. Initialize schema version 2 through the installed executable and verify it.
  run("init", paths.executable, ["init"]);
  const db = new Database(paths.database, { readonly: true, create: false });
  try {
    const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
    if (row === null || row.user_version !== LATEST_SCHEMA_VERSION) {
      fail("init", `schema user_version is ${String(row?.user_version)}, expected ${String(LATEST_SCHEMA_VERSION)}`);
    }
  } finally {
    db.close();
  }

  // 6. Render the plist template and install the LaunchAgent definition.
  const template = readFileSync(join(repositoryRoot, PLIST_TEMPLATE), "utf8");
  if (!template.includes(EXECUTABLE_TOKEN) || !template.includes(LOGS_TOKEN)) {
    fail("launchagent", "plist template is missing an expected token");
  }
  const rendered = template.split(EXECUTABLE_TOKEN).join(paths.executable).split(LOGS_TOKEN).join(paths.logsDirectory);
  if (rendered.includes(TOKEN_MARKER)) {
    fail("launchagent", "an unreplaced token remains in the rendered plist");
  }
  mkdirSync(dirname(paths.launchAgent), { recursive: true });
  writeFileSync(paths.launchAgent, rendered, { mode: PLIST_MODE });
  // writeFileSync mode applies only at creation; chmod corrects a pre-existing file.
  chmodSync(paths.launchAgent, PLIST_MODE);
  run("launchagent", PLUTIL, ["-lint", paths.launchAgent]);

  // 7. Load the daemon under the exact label.
  const uid =
    typeof process.getuid === "function"
      ? process.getuid()
      : fail("launchagent", "process.getuid is unavailable on this platform");
  const serviceTarget = `gui/${uid}/${LABEL}`;
  const probe = spawnSync(LAUNCHCTL, ["print", serviceTarget], { stdio: "ignore" });
  if (probe.status === 0) {
    run("launchagent", LAUNCHCTL, ["bootout", serviceTarget]);
  }
  run("launchagent", LAUNCHCTL, ["bootstrap", `gui/${uid}`, paths.launchAgent]);
  run("launchagent", LAUNCHCTL, ["kickstart", "-k", serviceTarget]);

  // 8. Install the single packaged plugin and start it through the official
  // Stream Deck CLI. @elgato/cli (1.7.4, the latest) ships no install verb,
  // so the package is opened: LaunchServices hands the registered
  // .streamDeckPlugin document to the Stream Deck app, which installs it. If
  // the app presents an install confirmation, accept it and re-run this
  // installer — every step is idempotent and converges.
  const packages = readdirSync(join(repositoryRoot, "dist")).filter((name) => name.endsWith(PACKAGE_SUFFIX));
  const packageName =
    packages.length === 1 && packages[0] !== undefined
      ? packages[0]
      : fail("install-plugin", `expected exactly one ${PACKAGE_SUFFIX} package in dist, found ${packages.length}`);
  const packagePath = join(repositoryRoot, "dist", packageName);
  run("install-plugin", OPEN, [packagePath]);
  run("install-plugin", process.execPath, [STREAMDECK_CLI, "restart", LABEL]);

  // 9. Report canonical paths; provider hooks remain a manual final step.
  process.stdout.write(
    [
      "install-local: complete",
      `  executable:  ${paths.executable}`,
      `  database:    ${paths.database}`,
      `  snapshot:    ${paths.snapshot}`,
      `  logs:        ${paths.logsDirectory}`,
      `  launchagent: ${paths.launchAgent}`,
      `  plugin:      ${packagePath}`,
      `  service:     ${serviceTarget}`,
      "",
      "Provider hooks are NOT installed. Follow docs/hook-configuration.md to add",
      "the Claude, Kimi, and Codex hook entries manually as the final setup step.",
      "",
    ].join("\n"),
  );
};

main();
