/**
 * Explicit macOS-local installer for the hook-driven session registry.
 *
 * Step order (any pre-hook failure exits nonzero immediately; this script
 * installs its own managed artifacts — the pi/omp shims and the grok hook
 * file — into provider dirs; it still never edits provider **config files**):
 *   1. Require macOS; canonical paths resolve through node:os homedir().
 *   2. Preflight: an existing database newer than this build aborts the
 *      install before anything is clobbered — init would throw
 *      UnsupportedSchemaVersion only after the swap and bootout.
 *   3. Run the repository build and plugin validate/package commands with an
 *      explicit working directory.
 *   4. Create or correct the application directories to mode 0700.
 *   5. Copy the compiled core to the canonical executable, chmod 0700.
 *   6. Boot out the exact existing service only if present, so the schema
 *      migration never contends with a live daemon.
 *   7. Run the installed executable's init; verify the latest schema version.
 *   8. Replace the exact executable/log tokens in the plist template, write
 *      the canonical plist at mode 0600, and validate with plutil -lint.
 *   9. Bootstrap and kickstart the exact label.
 *   10. Install the single packaged plugin from dist, wait until the
 *       installed copy reaches this build's version (the app's install
 *       confirmation dialog can otherwise park the install silently), and
 *       restart it through the official Stream Deck CLI.
 *   11. Install the managed shims and grok hook file into the provider
 *       dirs that exist; never overwrite unmarked user files.
 *   12. Print the canonical paths; the Claude/Kimi/Codex hooks remain a
 *       manual step.
 *
 * Every subprocess runs through spawnSync with an argument array — no shell
 * command strings — and every tool path is absolute.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppPaths } from "../src/core/paths";
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

const SHIM_MARKER = "// stream-deck-agents: managed shim v1";
const SHIM_NAME = "stream-deck-agents.ts";
const SHIM_TARGETS = [
  { provider: "pi", homeDir: ".pi" },
  { provider: "omp", homeDir: ".omp" },
] as const;
const SHIM_MODE = 0o600;

const GROK_HOOK_MARKER = "x-stream-deck-agents";
const GROK_HOOK_MARKER_VALUE = "managed hook v1";
const GROK_HOOK_TEMPLATE = join("extensions", "grok", "stream-deck-agents.hook.json");
const GROK_HOOK_NAME = "stream-deck-agents.json";
const GROK_HOOK_MODE = 0o600;

const LAUNCHCTL = "/bin/launchctl";
const PLUTIL = "/usr/bin/plutil";
const OPEN = "/usr/bin/open";

const PLUGIN_DIR_NAME = "com.drewritter.stream-deck-agents.sdPlugin";
const PLUGIN_INSTALL_TIMEOUT_MS = 120_000;
const PLUGIN_INSTALL_POLL_MS = 2_000;

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

/**
 * Install the managed shims into provider extension dirs that exist. A shim
 * is skipped (with a printed note) when the provider dir is absent, and the
 * installer refuses to overwrite a same-named file without the managed
 * marker — that's user content, and losing it would be silent damage.
 * Writes are atomic (temp + rename), mode 0600, with the executable token
 * substituted at copy time.
 */
const installShims = (paths: AppPaths): void => {
  for (const target of SHIM_TARGETS) {
    const providerRoot = join(paths.home, target.homeDir);
    const extensionsDir = join(providerRoot, "agent", "extensions");
    const destination = join(extensionsDir, SHIM_NAME);
    if (!existsSync(providerRoot)) {
      process.stdout.write(`install-local: skipping ${target.provider} shim (${providerRoot} does not exist)\n`);
      continue;
    }
    const source = readFileSync(join(repositoryRoot, "extensions", target.provider, SHIM_NAME), "utf8");
    if (!source.startsWith(SHIM_MARKER) || !source.includes(EXECUTABLE_TOKEN)) {
      fail("shims", `extensions/${target.provider}/${SHIM_NAME} is missing its marker or token`);
    }
    const rendered = source.split(EXECUTABLE_TOKEN).join(paths.executable);
    if (existsSync(destination)) {
      const installed = readFileSync(destination, "utf8");
      if (!installed.startsWith(SHIM_MARKER)) {
        process.stdout.write(`install-local: NOT overwriting ${destination} — no managed marker (user content)\n`);
        continue;
      }
      if (installed === rendered) {
        continue;
      }
    }
    mkdirSync(extensionsDir, { recursive: true });
    const temp = join(extensionsDir, `.${SHIM_NAME}.tmp-${process.pid}`);
    writeFileSync(temp, rendered, { mode: SHIM_MODE });
    renameSync(temp, destination);
    process.stdout.write(`install-local: installed ${target.provider} shim → ${destination}\n`);
  }
};

/**
 * True only when the installed JSON carries this installer's exact managed
 * marker key/value. Malformed JSON, a missing key, or any other value means
 * the file is not ours — user content, never overwritten.
 */
const isManagedGrokHook = (contents: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(contents);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>)[GROK_HOOK_MARKER] === GROK_HOOK_MARKER_VALUE
    );
  } catch {
    return false;
  }
};

/**
 * Install the managed grok hook file into ~/.grok/hooks when the grok home
 * exists. Same rules as the shims: skip when the provider dir is absent,
 * refuse to overwrite a same-named file without the managed marker (user
 * content), atomic temp + rename, token substituted at copy time.
 */
const installGrokHook = (paths: AppPaths): void => {
  const grokRoot = join(paths.home, ".grok");
  const hooksDir = join(grokRoot, "hooks");
  const destination = join(hooksDir, GROK_HOOK_NAME);
  if (!existsSync(grokRoot)) {
    process.stdout.write(`install-local: skipping grok hook (${grokRoot} does not exist)\n`);
    return;
  }
  const source = readFileSync(join(repositoryRoot, GROK_HOOK_TEMPLATE), "utf8");
  if (!source.includes(GROK_HOOK_MARKER) || !source.includes(EXECUTABLE_TOKEN)) {
    fail("grok-hook", `${GROK_HOOK_TEMPLATE} is missing its marker or token`);
  }
  const rendered = source.split(EXECUTABLE_TOKEN).join(paths.executable);
  if (existsSync(destination)) {
    const installed = readFileSync(destination, "utf8");
    if (!isManagedGrokHook(installed)) {
      process.stdout.write(`install-local: NOT overwriting ${destination} — no managed marker (user content)\n`);
      return;
    }
    if (installed === rendered) {
      return;
    }
  }
  mkdirSync(hooksDir, { recursive: true });
  const temp = join(hooksDir, `.${GROK_HOOK_NAME}.tmp-${process.pid}`);
  writeFileSync(temp, rendered, { mode: GROK_HOOK_MODE });
  renameSync(temp, destination);
  process.stdout.write(`install-local: installed grok hook → ${destination}\n`);
};

/** The `"Version"` field of a plugin manifest, or null when unreadable or absent. */
const manifestVersion = (manifestPath: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("Version" in parsed)) {
      return null;
    }
    const version = (parsed as { Version: unknown }).Version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
};

/**
 * Block until the Stream Deck app's installed copy of the plugin reaches the
 * expected version. The app installs behind a confirmation dialog whenever it
 * chooses to show one; polling the installed manifest (rather than trusting
 * `open`'s immediate return) keeps a parked dialog from leaving the old
 * plugin running under a "complete" report. On timeout the step fails with
 * instructions — every install step is idempotent, so accepting the dialog
 * and re-running this installer converges.
 */
const awaitPluginInstall = (installedManifest: string, expectedVersion: string): void => {
  const deadline = Date.now() + PLUGIN_INSTALL_TIMEOUT_MS;
  let announced = false;
  while (manifestVersion(installedManifest) !== expectedVersion) {
    if (Date.now() >= deadline) {
      fail(
        "install-plugin",
        `plugin v${expectedVersion} was not installed within 120s — accept the Stream Deck confirmation dialog and re-run this installer`,
      );
    }
    if (!announced) {
      process.stdout.write(
        `install-local: waiting for the Stream Deck app to install plugin v${expectedVersion} (accept its confirmation dialog if shown)\n`,
      );
      announced = true;
    }
    Bun.sleepSync(PLUGIN_INSTALL_POLL_MS);
  }
  process.stdout.write(`install-local: plugin v${expectedVersion} confirmed installed\n`);
};

const main = (): void => {
  // 1. macOS only; resolveAppPaths resolves the home directory via node:os.
  if (process.platform !== "darwin") {
    fail("platform", "this installer supports macOS only");
  }
  process.umask(0o077);
  const paths = resolveAppPaths();

  // 2. Preflight the schema before anything can clobber the install: a
  // database newer than this build makes step 7's init throw
  // UnsupportedSchemaVersion — after the executable swap and daemon bootout,
  // leaving the daemon unable to start. Refuse while everything is untouched.
  if (existsSync(paths.database)) {
    const db = new Database(paths.database, { readonly: true, create: false });
    let found = 0;
    try {
      const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
      found = row?.user_version ?? 0;
    } finally {
      db.close();
    }
    if (found > LATEST_SCHEMA_VERSION) {
      fail(
        "preflight",
        `schema user_version ${String(found)} needs a newer build (this build supports ${String(LATEST_SCHEMA_VERSION)})`,
      );
    }
  }

  // 3. Core/plugin build, then plugin validate + package.
  run("build", process.execPath, ["run", "build"]);
  run("package-plugin", process.execPath, ["run", "pack:plugin"]);

  // 4. Application directories, created or corrected to 0700.
  ensureAppDirectories(paths);

  // 5. Install the compiled core as the canonical executable.
  copyFileSync(join(repositoryRoot, BUILT_CORE), paths.executable);
  chmodSync(paths.executable, EXECUTABLE_MODE);

  // 6. Stop the live daemon before init runs the schema migration; the rebuild
  // must not contend with the daemon's write cadence on a 250ms busy timeout.
  const uid =
    typeof process.getuid === "function"
      ? process.getuid()
      : fail("launchagent", "process.getuid is unavailable on this platform");
  const serviceTarget = `gui/${uid}/${LABEL}`;
  const probe = spawnSync(LAUNCHCTL, ["print", serviceTarget], { stdio: "ignore" });
  if (probe.status === 0) {
    run("launchagent", LAUNCHCTL, ["bootout", serviceTarget]);
  }

  // 7. Initialize the latest schema version through the installed executable and verify it.
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

  // 8. Render the plist template and install the LaunchAgent definition.
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

  // 9. Load the daemon under the exact label.
  run("launchagent", LAUNCHCTL, ["bootstrap", `gui/${uid}`, paths.launchAgent]);
  run("launchagent", LAUNCHCTL, ["kickstart", "-k", serviceTarget]);

  // 10. Install the single packaged plugin and start it through the official
  // Stream Deck CLI. @elgato/cli (1.7.4, the latest) ships no install verb,
  // so the package is opened: LaunchServices hands the registered
  // .streamDeckPlugin document to the Stream Deck app, which installs it.
  // The restart waits until the installed copy reaches this build's version.
  const packages = readdirSync(join(repositoryRoot, "dist")).filter((name) => name.endsWith(PACKAGE_SUFFIX));
  const packageName =
    packages.length === 1 && packages[0] !== undefined
      ? packages[0]
      : fail("install-plugin", `expected exactly one ${PACKAGE_SUFFIX} package in dist, found ${packages.length}`);
  const packagePath = join(repositoryRoot, "dist", packageName);
  const expectedVersion =
    manifestVersion(join(repositoryRoot, PLUGIN_DIR_NAME, "manifest.json")) ??
    fail("install-plugin", "the repository plugin manifest has no readable Version");
  run("install-plugin", OPEN, [packagePath]);
  awaitPluginInstall(
    join(paths.home, "Library/Application Support/com.elgato.StreamDeck/Plugins", PLUGIN_DIR_NAME, "manifest.json"),
    expectedVersion,
  );
  run("install-plugin", process.execPath, [STREAMDECK_CLI, "restart", LABEL]);

  // 11. Install the managed shims and the grok hook file last — managed
  // artifacts must never activate before the compatible daemon and plugin
  // are live.
  installShims(paths);
  installGrokHook(paths);

  // 12. Report canonical paths; the Claude/Kimi/Codex hooks remain manual.
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
      "Managed pi/omp shims and the grok hook file were installed where their",
      "provider dirs exist (see above). Claude, Kimi, and Codex hooks are NOT",
      "installed — follow",
      "docs/hook-configuration.md to add them manually as the final setup step.",
      "",
    ].join("\n"),
  );
};

main();
