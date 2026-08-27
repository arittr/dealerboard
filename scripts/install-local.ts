/**
 * Explicit macOS-local installer for the hook-driven session registry.
 *
 * The Elgato Stream Deck plugin is deprecated: `bun run build` still bundles
 * it, but this installer neither packages nor installs it — it manages the
 * daemon, LaunchAgent, shims, and grok hook only.
 *
 * Step order (any pre-hook failure exits nonzero immediately; this script
 * installs its own managed artifacts — the pi/omp shims and the grok hook
 * file — into provider dirs; it still never edits provider **config files**):
 *   1. Require macOS; canonical paths resolve through node:os homedir().
 *   2. Preflight: an existing database newer than this build aborts the
 *      install before anything is clobbered — init would throw
 *      UnsupportedSchemaVersion only after the swap and bootout.
 *   3. Run the repository build with an explicit working directory.
 *   4. Create or correct the application directories to mode 0700.
 *   5. Copy the compiled core to the canonical executable, chmod 0700.
 *   6. Boot out the exact existing service only if present, so the schema
 *      migration never contends with a live daemon.
 *   7. Run the installed executable's init; verify the latest schema version.
 *   8. Replace the exact executable/log tokens in the plist template, write
 *      the canonical plist at mode 0600, and validate with plutil -lint.
 *   9. Bootstrap and kickstart the exact label.
 *   10. Install the managed shims and grok hook file into the provider
 *       dirs that exist; never overwrite unmarked user files.
 *   11. Print the canonical paths; Claude, Kimi, Codex, ZCode, and Qwen
 *       remain manual setup steps.
 *
 * Every subprocess runs through spawnSync with an argument array — no shell
 * command strings — and every tool path is absolute.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppPaths } from "../src/core/paths";
import { ensureAppDirectories, resolveAppPaths } from "../src/core/paths";
import { LATEST_SCHEMA_VERSION } from "../src/core/schema";
import { GROK_HOOK_NAME, type GrokHookInstallOutcome, installGrokHookFile } from "./grok-hook-install";

const LABEL = "com.drewritter.dealerboard";
const PLIST_TEMPLATE = "launchd/com.drewritter.dealerboard.plist.template";
const BUILT_CORE = "dist/dealerboard";

const EXECUTABLE_TOKEN = "__DEALERBOARD_EXECUTABLE__";
const LOGS_TOKEN = "__DEALERBOARD_LOGS_DIRECTORY__";
const TOKEN_MARKER = "__DEALERBOARD_";

const EXECUTABLE_MODE = 0o700;
const PLIST_MODE = 0o600;

const SHIM_MARKER = "// dealerboard: managed shim v1";
const SHIM_NAME = "dealerboard.ts";
const SHIM_TARGETS = [
  { provider: "pi", homeDir: ".pi" },
  { provider: "omp", homeDir: ".omp" },
] as const;
const SHIM_MODE = 0o600;

const GROK_HOOK_TEMPLATE = join("extensions", "grok", "dealerboard.hook.json");

const LAUNCHCTL = "/bin/launchctl";
const PLUTIL = "/usr/bin/plutil";

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
 * The grok-hook steps below are thin wrappers: all decisions and writes
 * live in grok-hook-install.ts (behavior-tested in
 * test/grok-hook-install.test.ts); install-local maps the outcomes to its
 * stdout notes and the throw to the fail() path.
 */
const readGrokHookTemplate = (): string => {
  try {
    return readFileSync(join(repositoryRoot, GROK_HOOK_TEMPLATE), "utf8");
  } catch (error) {
    return fail(
      "grok-hook",
      `cannot read ${GROK_HOOK_TEMPLATE}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const runGrokHookInstall = (grokRoot: string, template: string, executable: string): GrokHookInstallOutcome => {
  try {
    return installGrokHookFile({ grokRoot, source: template, executable });
  } catch {
    return fail("grok-hook", `${GROK_HOOK_TEMPLATE} is missing its marker or token`);
  }
};

const installGrokHook = (paths: AppPaths): void => {
  const grokRoot = join(paths.home, ".grok");
  const destination = join(grokRoot, "hooks", GROK_HOOK_NAME);
  switch (runGrokHookInstall(grokRoot, readGrokHookTemplate(), paths.executable)) {
    case "skipped-no-grok-home":
      process.stdout.write(`install-local: skipping grok hook (${grokRoot} does not exist)\n`);
      return;
    case "skipped-user-content":
      process.stdout.write(`install-local: NOT overwriting ${destination} — no managed marker (user content)\n`);
      return;
    case "unchanged":
      return;
    case "installed":
      process.stdout.write(`install-local: installed grok hook → ${destination}\n`);
      return;
  }
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

  // 3. Repository build (the deprecated plugin bundle rides along in `bun run build`).
  run("build", process.execPath, ["run", "build"]);

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

  // 10. Install the managed shims and the grok hook file last — managed
  // artifacts must never activate before the compatible daemon is live.
  installShims(paths);
  installGrokHook(paths);

  // 11. Report canonical paths; five provider integrations remain manual.
  process.stdout.write(
    [
      "install-local: complete",
      `  executable:  ${paths.executable}`,
      `  database:    ${paths.database}`,
      `  snapshot:    ${paths.snapshot}`,
      `  logs:        ${paths.logsDirectory}`,
      `  launchagent: ${paths.launchAgent}`,
      `  service:     ${serviceTarget}`,
      "",
      "Managed pi/omp shims and the grok hook file were installed where their",
      "provider dirs exist (see above). Claude, Kimi, Codex, ZCode, and Qwen",
      "hooks are NOT installed — follow",
      "docs/hook-configuration.md to add them manually as the final setup step.",
      "",
    ].join("\n"),
  );
};

main();
