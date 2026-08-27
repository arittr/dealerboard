/**
 * Install logic for the managed grok hook file, extracted from
 * install-local.ts so the overwrite guard is testable in isolation:
 * install-local maps this module's outcomes to its stdout notes and its
 * fail() path, while every decision and write lives here.
 *
 * Rules (identical to the shims): skip when the grok root is absent, refuse
 * to overwrite a same-named file without this installer's exact managed
 * marker (user content), no-op when the rendered content is already
 * installed, otherwise an atomic temp + rename write at mode 0600 with the
 * executable token substituted. A source template missing its marker or
 * token throws — that is a packaging bug, not a user-content case.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GROK_HOOK_MARKER = "x-dealerboard";
export const GROK_HOOK_MARKER_VALUE = "managed hook v1";
export const GROK_HOOK_NAME = "dealerboard.json";
export const GROK_HOOK_MODE = 0o600;

const EXECUTABLE_TOKEN = "__DEALERBOARD_EXECUTABLE__";

export type GrokHookInstallOutcome = "installed" | "skipped-no-grok-home" | "skipped-user-content" | "unchanged";

/**
 * True only when the installed JSON carries this installer's exact managed
 * marker key/value. Malformed JSON, a missing key, or any other value means
 * the file is not ours — user content, never overwritten.
 */
export const isManagedGrokHook = (contents: string): boolean => {
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
 * Install the managed grok hook file into <grokRoot>/hooks/<GROK_HOOK_NAME>.
 * Pure in its decisions, physical only in the writes: the caller supplies
 * the grok root directory (e.g. ~/.grok), the source template's contents,
 * and the canonical executable path for token substitution.
 */
export const installGrokHookFile = (options: {
  grokRoot: string;
  source: string;
  executable: string;
}): GrokHookInstallOutcome => {
  const hooksDir = join(options.grokRoot, "hooks");
  const destination = join(hooksDir, GROK_HOOK_NAME);
  if (!existsSync(options.grokRoot)) {
    return "skipped-no-grok-home";
  }
  if (!options.source.includes(GROK_HOOK_MARKER) || !options.source.includes(EXECUTABLE_TOKEN)) {
    throw new Error("grok hook template is missing its marker or token");
  }
  const rendered = options.source.split(EXECUTABLE_TOKEN).join(options.executable);
  if (existsSync(destination)) {
    const installed = readFileSync(destination, "utf8");
    if (!isManagedGrokHook(installed)) {
      return "skipped-user-content";
    }
    if (installed === rendered) {
      return "unchanged";
    }
  }
  mkdirSync(hooksDir, { recursive: true });
  const temp = join(hooksDir, `.${GROK_HOOK_NAME}.tmp-${process.pid}`);
  writeFileSync(temp, rendered, { mode: GROK_HOOK_MODE });
  renameSync(temp, destination);
  return "installed";
};
