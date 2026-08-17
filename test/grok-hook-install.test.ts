import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GROK_HOOK_MARKER,
  GROK_HOOK_MARKER_VALUE,
  GROK_HOOK_NAME,
  installGrokHookFile,
} from "../scripts/grok-hook-install";

/** The real repository template, exercised so the shipped artifact is what the assertions cover. */
const REPO_TEMPLATE = readFileSync(
  join(import.meta.dir, "..", "extensions", "grok", "stream-deck-agents.hook.json"),
  "utf8",
);

const EXECUTABLE = "/usr/local/libexec/stream-deck-agents-test";

type HookCommand = { type: string; command: string; timeout: number };
type HookEntry = { hooks: HookCommand[] };
type HookFile = { hooks: Record<string, HookEntry[]> };

describe("grok hook file install", () => {
  let home: string;
  let grokRoot: string;
  let destination: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sda-grok-hook-"));
    grokRoot = join(home, ".grok");
    mkdirSync(grokRoot);
    destination = join(grokRoot, "hooks", GROK_HOOK_NAME);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const managedDestination = (contents: string): void => {
    mkdirSync(join(grokRoot, "hooks"), { recursive: true });
    writeFileSync(destination, contents);
  };

  test("installs into an absent hooks dir: mode 0600, substituted executable, valid JSON, 9 events", () => {
    const outcome = installGrokHookFile({ grokRoot, source: REPO_TEMPLATE, executable: EXECUTABLE });
    expect(outcome).toBe("installed");
    const installed = readFileSync(destination, "utf8");
    expect(installed).toContain(EXECUTABLE);
    expect(installed).not.toContain("__STREAM_DECK_AGENTS_EXECUTABLE__");
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    const hookFile = JSON.parse(installed) as HookFile;
    const eventNames = Object.keys(hookFile.hooks).sort();
    expect(eventNames).toEqual(
      [
        "Notification",
        "PostToolUse",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "StopCancelled",
        "StopFailure",
        "UserPromptSubmit",
      ].sort(),
    );
    for (const eventName of eventNames) {
      const commands = hookFile.hooks[eventName]?.[0]?.hooks ?? [];
      expect(commands).toEqual([{ type: "command", command: `"${EXECUTABLE}" event grok`, timeout: 5 }]);
    }
  });

  test("skips when the grok root is absent", () => {
    const absentRoot = join(home, "grok-absent");
    const outcome = installGrokHookFile({ grokRoot: absentRoot, source: REPO_TEMPLATE, executable: EXECUTABLE });
    expect(outcome).toBe("skipped-no-grok-home");
    expect(statSync(absentRoot, { throwIfNoEntry: false })).toBeUndefined();
    expect(readdirSync(grokRoot)).toEqual([]);
  });

  test("leaves a malformed-JSON destination untouched", () => {
    const original = "definitely { not json";
    managedDestination(original);
    const outcome = installGrokHookFile({ grokRoot, source: REPO_TEMPLATE, executable: EXECUTABLE });
    expect(outcome).toBe("skipped-user-content");
    expect(readFileSync(destination, "utf8")).toBe(original);
  });

  test("leaves a foreign marker value untouched", () => {
    const original = JSON.stringify({ [GROK_HOOK_MARKER]: "foreign", hooks: {} });
    managedDestination(original);
    const outcome = installGrokHookFile({ grokRoot, source: REPO_TEMPLATE, executable: EXECUTABLE });
    expect(outcome).toBe("skipped-user-content");
    expect(readFileSync(destination, "utf8")).toBe(original);
  });

  test("replaces an exact-marker file whose content is older (upgrade)", () => {
    const older = JSON.stringify({
      [GROK_HOOK_MARKER]: GROK_HOOK_MARKER_VALUE,
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: '"/old/bin" event grok', timeout: 5 }] }] },
    });
    managedDestination(older);
    const outcome = installGrokHookFile({ grokRoot, source: REPO_TEMPLATE, executable: EXECUTABLE });
    expect(outcome).toBe("installed");
    const installed = readFileSync(destination, "utf8");
    expect(installed).toContain(EXECUTABLE);
    expect(installed).not.toContain("/old/bin");
  });

  test("identical rendered content is a no-op: nothing rewritten, mtime preserved", () => {
    expect(installGrokHookFile({ grokRoot, source: REPO_TEMPLATE, executable: EXECUTABLE })).toBe("installed");
    const before = readFileSync(destination, "utf8");
    // Pin an old mtime: any rewrite — even of identical bytes — would move it.
    const pinned = new Date(1_000_000_000_000);
    utimesSync(destination, pinned, pinned);
    const outcome = installGrokHookFile({ grokRoot, source: REPO_TEMPLATE, executable: EXECUTABLE });
    expect(outcome).toBe("unchanged");
    expect(readFileSync(destination, "utf8")).toBe(before);
    expect(statSync(destination).mtimeMs).toBe(pinned.getTime());
    // No stray temp files left in the hooks dir.
    expect(readdirSync(join(grokRoot, "hooks"))).toEqual([GROK_HOOK_NAME]);
  });

  test("a broken source template throws instead of installing", () => {
    const noToken = JSON.stringify({ [GROK_HOOK_MARKER]: GROK_HOOK_MARKER_VALUE, hooks: {} });
    expect(() => installGrokHookFile({ grokRoot, source: noToken, executable: EXECUTABLE })).toThrow();
    const noMarker = REPO_TEMPLATE.split(GROK_HOOK_MARKER).join("x-unrelated-key");
    expect(() => installGrokHookFile({ grokRoot, source: noMarker, executable: EXECUTABLE })).toThrow();
    expect(statSync(destination, { throwIfNoEntry: false })).toBeUndefined();
  });
});
