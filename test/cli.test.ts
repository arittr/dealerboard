import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeGhosttyBindingContext } from "../src/core/claude-ghostty-binding";
import { type CliDependencies, MAX_STDIN_BYTES, runCli } from "../src/core/cli";
import { createFileDiagnostics, type DiagnosticRecord } from "../src/core/diagnostics";
import { type AppPaths, resolveAppPaths } from "../src/core/paths";
import { applyRegistryEvents, listSessions } from "../src/core/registry";
import { initializeDatabase, openRegistryDatabase } from "../src/core/schema";
import type { RegistryEvent } from "../src/protocol";

const NOW = "2026-08-06T00:00:00.000Z";
const LATER = "2026-08-06T00:01:00.000Z";
const DIAGNOSTIC_KEYS = new Set(["timestamp", "component", "code", "provider", "sessionId"]);

let tempHome: string;
let paths: AppPaths;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "stream-deck-agents-cli-"));
  paths = resolveAppPaths(tempHome);
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

const stdinOf = (text: string, chunkSize = Number.POSITIVE_INFINITY): AsyncIterable<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  return (async function* () {
    if (chunkSize === Number.POSITIVE_INFINITY) {
      if (bytes.byteLength > 0) {
        yield bytes;
      }
      return;
    }
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      yield bytes.subarray(offset, offset + chunkSize);
    }
  })();
};

type Harness = {
  deps: CliDependencies;
  diagnostics: DiagnosticRecord[];
  delays: number[];
  stdout: () => string;
  stderr: () => string;
};

const makeHarness = (overrides: Partial<CliDependencies> = {}): Harness => {
  const diagnostics: DiagnosticRecord[] = [];
  const delays: number[] = [];
  let out = "";
  let err = "";
  const deps: CliDependencies = {
    paths,
    stdin: stdinOf(""),
    now: () => NOW,
    delay: (milliseconds) => {
      delays.push(milliseconds);
      return Promise.resolve();
    },
    diagnostics: (record) => {
      diagnostics.push(record);
    },
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    discoverClaudeGhosttyTerminal: () => Promise.resolve("test-ghostty-terminal"),
    environment: {},
    ...overrides,
  };
  return { deps, diagnostics, delays, stdout: () => out, stderr: () => err };
};

const startEvent = (sessionId: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: sessionId,
    cwd: "/users/drew/project-x",
    session_title: `Title for ${sessionId}`,
    ...extra,
  });

const initRegistry = (): void => {
  initializeDatabase(paths);
};

const listRows = (): ReturnType<typeof listSessions> => {
  const db = openRegistryDatabase(paths.database, "readonly");
  try {
    return listSessions(db);
  } finally {
    db.close();
  }
};

const sqliteError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

describe("init", () => {
  test("creates a version 8 database and stays silent on stdout", async () => {
    const harness = makeHarness();
    expect(await runCli(["init"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("");

    const db = openRegistryDatabase(paths.database, "readonly");
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 8 });
    } finally {
      db.close();
    }

    // Re-running init is idempotent.
    expect(await runCli(["init"], harness.deps)).toBe(0);
  });

  test("returns nonzero when the existing schema is unsupported", async () => {
    initRegistry();
    const raw = new Database(paths.database);
    try {
      raw.exec("PRAGMA user_version = 99");
    } finally {
      raw.close();
    }

    const harness = makeHarness();
    expect(await runCli(["init"], harness.deps)).not.toBe(0);
    expect(harness.stderr()).not.toBe("");
    expect(harness.stdout()).toBe("");
  });
});

describe("event ingress", () => {
  test("applies valid native JSON to the registry and prints nothing", async () => {
    initRegistry();
    const harness = makeHarness({ stdin: stdinOf(startEvent("s1")) });
    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("");
    expect(harness.diagnostics).toEqual([]);

    expect(listRows()).toEqual([
      {
        provider: "claude",
        sessionId: "s1",
        parentSessionId: null,
        status: "idle",
        title: "Title for s1",
        project: "project-x",
        logicalSlot: 1,
        ghosttyTerminalId: "test-ghostty-terminal",
        backgroundOutstanding: 0,
        transcriptPath: null,
        model: null,
        originKind: null,
        originRef: null,
        originSubagent: 0,
        unreadSince: null,
        openedAt: NOW,
        updatedAt: NOW,
      },
    ]);
  });

  test("keeps a Claude session working across Stop while a background shell is outstanding", async () => {
    initRegistry();
    const send = async (payload: Record<string, unknown>): Promise<void> => {
      const harness = makeHarness({ stdin: stdinOf(JSON.stringify({ session_id: "s1", ...payload })) });
      expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
      expect(harness.diagnostics).toEqual([]);
    };

    await send({ hook_event_name: "SessionStart" });
    await send({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "SENTINEL_BG_COMMAND", run_in_background: true },
    });
    expect(listRows()[0]).toMatchObject({ status: "working", backgroundOutstanding: 1 });

    // The launching turn ends: the live shell keeps the tile at working.
    await send({ hook_event_name: "Stop" });
    expect(listRows()[0]).toMatchObject({ status: "working", backgroundOutstanding: 1 });

    // A typed prompt turn that starts nothing new keeps working as well.
    await send({ hook_event_name: "UserPromptSubmit", prompt: "how we lookin" });
    await send({ hook_event_name: "Stop" });
    expect(listRows()[0]).toMatchObject({ status: "working", backgroundOutstanding: 1 });

    // The completion notification clears the flag; the wake turn's Stop idles.
    await send({ hook_event_name: "UserPromptSubmit", prompt: "<task-notification>\n<task-id>b1</task-id>" });
    expect(listRows()[0]).toMatchObject({ status: "working", backgroundOutstanding: 0 });
    await send({ hook_event_name: "Stop" });
    expect(listRows()[0]).toMatchObject({ status: "idle", backgroundOutstanding: 0 });

    // Neither the command text nor the notification body reaches the registry.
    expect(JSON.stringify(listRows())).not.toContain("SENTINEL");
  });

  test("preserves resumed Kimi metadata when a prompt observes existing membership", async () => {
    initRegistry();
    const resumedStart = makeHarness({ stdin: stdinOf(startEvent("resumed-kimi")) });
    expect(await runCli(["event", "kimi"], resumedStart.deps)).toBe(0);

    const prompt = makeHarness({
      stdin: stdinOf(
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "resumed-kimi",
          prompt: "SENTINEL_PROMPT_NEVER_STORED",
        }),
      ),
      now: () => LATER,
    });
    expect(await runCli(["event", "kimi"], prompt.deps)).toBe(0);
    expect(prompt.diagnostics).toEqual([]);
    expect(listRows()).toEqual([
      {
        provider: "kimi",
        sessionId: "resumed-kimi",
        parentSessionId: null,
        status: "working",
        title: "Title for resumed-kimi",
        project: "project-x",
        logicalSlot: 1,
        ghosttyTerminalId: null,
        backgroundOutstanding: 0,
        transcriptPath: null,
        model: null,
        originKind: null,
        originRef: null,
        originSubagent: 0,
        unreadSince: null,
        openedAt: NOW,
        updatedAt: LATER,
      },
    ]);
  });

  test("reassembles a payload split across many stdin chunks", async () => {
    initRegistry();
    const harness = makeHarness({ stdin: stdinOf(startEvent("s1"), 7) });
    expect(await runCli(["event", "kimi"], harness.deps)).toBe(0);
    expect(listRows().map((row) => [row.provider, row.sessionId])).toEqual([["kimi", "s1"]]);
  });

  test("keeps a blank Kimi page absent until its first prompt", async () => {
    initRegistry();
    const blankStart = makeHarness({
      stdin: stdinOf(
        JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "blank-kimi",
          cwd: "/users/drew/project-x",
          source: "startup",
        }),
      ),
    });
    expect(await runCli(["event", "kimi"], blankStart.deps)).toBe(0);
    expect(blankStart.diagnostics).toEqual([]);
    expect(listRows()).toEqual([]);

    const firstPrompt = makeHarness({
      stdin: stdinOf(
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "blank-kimi",
          cwd: "/users/drew/project-x",
          prompt: "SENTINEL_PROMPT_NEVER_STORED",
        }),
      ),
    });
    expect(await runCli(["event", "kimi"], firstPrompt.deps)).toBe(0);
    expect(firstPrompt.diagnostics).toEqual([]);
    expect(listRows()).toEqual([
      {
        provider: "kimi",
        sessionId: "blank-kimi",
        parentSessionId: null,
        status: "working",
        title: null,
        project: "project-x",
        logicalSlot: 1,
        ghosttyTerminalId: null,
        backgroundOutstanding: 0,
        transcriptPath: null,
        model: null,
        originKind: null,
        originRef: null,
        originSubagent: 0,
        unreadSince: null,
        openedAt: NOW,
        updatedAt: NOW,
      },
    ]);

    const repeatedPrompt = makeHarness({
      stdin: stdinOf(
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "blank-kimi",
          prompt: "SECOND_SENTINEL_PROMPT_NEVER_STORED",
        }),
      ),
      now: () => LATER,
    });
    expect(await runCli(["event", "kimi"], repeatedPrompt.deps)).toBe(0);
    expect(repeatedPrompt.diagnostics).toEqual([]);
    expect(listRows()).toEqual([
      {
        provider: "kimi",
        sessionId: "blank-kimi",
        parentSessionId: null,
        status: "working",
        title: null,
        project: "project-x",
        logicalSlot: 1,
        ghosttyTerminalId: null,
        backgroundOutstanding: 0,
        transcriptPath: null,
        model: null,
        originKind: null,
        originRef: null,
        originSubagent: 0,
        unreadSince: null,
        openedAt: NOW,
        updatedAt: LATER,
      },
    ]);
  });

  test("enriches only Claude SessionStart from the trusted native discoverer", async () => {
    initRegistry();
    const contexts: ClaudeGhosttyBindingContext[] = [];
    const harness = makeHarness({
      stdin: stdinOf(startEvent("bound", { ghosttyTerminalId: "payload-selected-terminal" })),
      environment: { TERM_PROGRAM: "ghostty" },
      parentPid: 4242,
      discoverClaudeGhosttyTerminal: (context) => {
        contexts.push(context);
        return Promise.resolve("terminal-bound");
      },
    });

    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(contexts).toEqual([{ termProgram: "ghostty", tmux: undefined, parentPid: 4242 }]);
    expect(listRows()[0]?.ghosttyTerminalId).toBe("terminal-bound");
    expect(harness.diagnostics).toEqual([]);
  });

  test("does not discover targets for non-Claude-start events or trust payload targets", async () => {
    initRegistry();
    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      applyRegistryEvents(db, [
        {
          kind: "SessionStart",
          provider: "claude",
          sessionId: "existing",
          title: null,
          project: null,
          ghosttyTerminalId: "existing-terminal",
          transcriptPath: null,
          model: null,
          observedAt: NOW,
        },
      ]);
    } finally {
      db.close();
    }
    let discoveries = 0;
    const discoverClaudeGhosttyTerminal = () => {
      discoveries += 1;
      return Promise.resolve("should-not-be-used");
    };
    const events: [string, string][] = [
      ["codex", startEvent("codex-start", { ghosttyTerminalId: "payload-selected-terminal" })],
      ["kimi", startEvent("kimi-start", { ghosttyTerminalId: "payload-selected-terminal" })],
      [
        "claude",
        JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: "existing",
          ghosttyTerminalId: "payload-selected-terminal",
        }),
      ],
      [
        "claude",
        JSON.stringify({
          hook_event_name: "SubagentStart",
          session_id: "existing",
          agent_id: "child",
          ghosttyTerminalId: "payload-selected-terminal",
        }),
      ],
    ];

    for (const [provider, input] of events) {
      const harness = makeHarness({
        stdin: stdinOf(input),
        discoverClaudeGhosttyTerminal,
      });
      expect(await runCli(["event", provider], harness.deps)).toBe(0);
      expect(harness.diagnostics).toEqual([]);
    }

    expect(discoveries).toBe(0);
    expect(listRows().map((row) => [row.provider, row.sessionId, row.ghosttyTerminalId])).toEqual([
      ["claude", "existing", "existing-terminal"],
      ["codex", "codex-start", null],
      ["kimi", "kimi-start", null],
      ["claude", "child", null],
    ]);
  });

  test("stores a null target and reports an unbound Claude terminal when discovery returns null", async () => {
    initRegistry();
    const harness = makeHarness({
      stdin: stdinOf(startEvent("unbound")),
      discoverClaudeGhosttyTerminal: () => Promise.resolve(null),
    });

    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(listRows()[0]?.ghosttyTerminalId).toBeNull();
    expect(harness.diagnostics).toEqual([
      {
        timestamp: NOW,
        component: "cli",
        code: "claude_terminal_unbound",
        provider: "claude",
        sessionId: "unbound",
      },
    ]);
  });

  test("stores a null target and reports an unbound Claude terminal when discovery rejects", async () => {
    initRegistry();
    const harness = makeHarness({
      stdin: stdinOf(startEvent("unbound")),
      discoverClaudeGhosttyTerminal: () => Promise.reject(new Error("discovery failed")),
    });

    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(listRows()[0]?.ghosttyTerminalId).toBeNull();
    expect(harness.diagnostics).toEqual([
      {
        timestamp: NOW,
        component: "cli",
        code: "claude_terminal_unbound",
        provider: "claude",
        sessionId: "unbound",
      },
    ]);
  });

  test("event stamps paseo origin from PASEO_AGENT_ID at SessionStart", async () => {
    initRegistry();
    const harness = makeHarness({
      environment: { PASEO_AGENT_ID: "agent-xyz" },
      stdin: stdinOf(startEvent("s1")),
    });

    expect(await runCli(["event", "kimi"], harness.deps)).toBe(0);
    expect(harness.diagnostics).toEqual([]);
    expect(listRows()[0]).toMatchObject({ originKind: "paseo", originRef: "agent-xyz" });
  });

  test("event stamps terminal origin from TERM_PROGRAM when no Paseo marker", async () => {
    initRegistry();
    const harness = makeHarness({
      environment: { TERM_PROGRAM: "ghostty" },
      stdin: stdinOf(startEvent("s1")),
    });

    expect(await runCli(["event", "kimi"], harness.deps)).toBe(0);
    expect(listRows()[0]).toMatchObject({ originKind: "terminal", originRef: "ghostty" });
  });

  test("event stamps no origin when no markers", async () => {
    initRegistry();
    const harness = makeHarness({ environment: {}, stdin: stdinOf(startEvent("s1")) });
    expect(await runCli(["event", "kimi"], harness.deps)).toBe(0);
    expect(harness.diagnostics).toEqual([]);
    expect(listRows()[0]).toMatchObject({ originKind: null, originRef: null });
  });

  test("event stamps the same origin on a late-joining SessionObserved row", async () => {
    initRegistry();
    const harness = makeHarness({
      environment: { PASEO_AGENT_ID: "agent-xyz" },
      stdin: stdinOf(
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "late-join",
          cwd: "/users/drew/project-x",
          prompt: "SENTINEL_PROMPT_NEVER_STORED",
        }),
      ),
    });

    expect(await runCli(["event", "kimi"], harness.deps)).toBe(0);
    expect(harness.diagnostics).toEqual([]);
    expect(listRows()[0]).toMatchObject({ originKind: "paseo", originRef: "agent-xyz" });
  });

  test("event refreshes origin on an existing row when an observed prompt carries markers", async () => {
    initRegistry();
    // A start without markers leaves the existing row origin-unknown.
    const plainStart = makeHarness({ stdin: stdinOf(startEvent("s1")) });
    expect(await runCli(["event", "kimi"], plainStart.deps)).toBe(0);
    expect(listRows()[0]).toMatchObject({ originKind: null, originRef: null });

    // A later prompt in a terminal late-joins nothing (the row exists) but
    // its fresh origin evidence replaces the unknown one.
    const prompt = makeHarness({
      environment: { TERM_PROGRAM: "ghostty" },
      stdin: stdinOf(
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "s1",
          cwd: "/users/drew/project-x",
          prompt: "SENTINEL_PROMPT_NEVER_STORED",
        }),
      ),
    });
    expect(await runCli(["event", "kimi"], prompt.deps)).toBe(0);
    expect(prompt.diagnostics).toEqual([]);

    // The refreshed origin is visible through the read-only listing path.
    const lister = makeHarness();
    expect(await runCli(["sessions", "list"], lister.deps)).toBe(0);
    expect(lister.stderr()).toBe("");
    expect(JSON.parse(lister.stdout())).toMatchObject([
      { provider: "kimi", sessionId: "s1", originKind: "terminal", originRef: "ghostty" },
    ]);
  });

  test("keeps the stamped origin through the Claude ghostty terminal enrichment", async () => {
    initRegistry();
    const harness = makeHarness({
      environment: { PASEO_AGENT_ID: "agent-xyz", TERM_PROGRAM: "ghostty" },
      stdin: stdinOf(startEvent("s1")),
    });

    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(harness.diagnostics).toEqual([]);
    expect(listRows()[0]).toMatchObject({
      originKind: "paseo",
      originRef: "agent-xyz",
      ghosttyTerminalId: "test-ghostty-terminal",
    });
  });

  test("late-joins a row from UserPromptSubmit when SessionStart was missed", async () => {
    // A prompt proves membership: sessions whose start hook never fired (or
    // whose row was pruned) reappear instead of staying invisible forever.
    initRegistry();
    const harness = makeHarness({
      stdin: stdinOf(
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "s1",
          cwd: "/users/drew/project-x",
          prompt: "SENTINEL_PROMPT_NEVER_STORED",
        }),
      ),
    });
    expect(await runCli(["event", "codex"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("");
    expect(listRows()).toEqual([
      {
        provider: "codex",
        sessionId: "s1",
        parentSessionId: null,
        status: "working",
        title: null,
        project: "project-x",
        logicalSlot: 1,
        ghosttyTerminalId: null,
        backgroundOutstanding: 0,
        transcriptPath: null,
        model: null,
        originKind: null,
        originRef: null,
        originSubagent: 0,
        unreadSince: null,
        openedAt: NOW,
        updatedAt: NOW,
      },
    ]);
  });

  test("returns zero with an invalid_input diagnostic for malformed JSON", async () => {
    initRegistry();
    const harness = makeHarness({ stdin: stdinOf('{"hook_event_name":"SessionStart",') });
    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("");
    expect(harness.diagnostics).toEqual([
      { timestamp: NOW, component: "cli", code: "invalid_input", provider: "claude" },
    ]);
    expect(listRows()).toEqual([]);
  });

  test("returns zero with an invalid_input diagnostic for non-object JSON", async () => {
    initRegistry();
    const harness = makeHarness({ stdin: stdinOf('["not","an","object"]') });
    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(harness.diagnostics).toEqual([
      { timestamp: NOW, component: "cli", code: "invalid_input", provider: "claude" },
    ]);
  });

  test("accepts exactly 65,536 stdin bytes and rejects 65,537", async () => {
    initRegistry();
    const prefix = '{"hook_event_name":"SessionStart","session_id":"s1","title":"';
    const suffix = '"}';
    const exact = `${prefix}${"x".repeat(MAX_STDIN_BYTES - prefix.length - suffix.length)}${suffix}`;
    expect(new TextEncoder().encode(exact).byteLength).toBe(MAX_STDIN_BYTES);

    const withinLimit = makeHarness({ stdin: stdinOf(exact) });
    expect(await runCli(["event", "claude"], withinLimit.deps)).toBe(0);
    expect(withinLimit.diagnostics).toEqual([]);
    expect(listRows()).toHaveLength(1);

    const overLimit = makeHarness({ stdin: stdinOf(`${exact.slice(0, -2)}x"}`) });
    expect(new TextEncoder().encode(`${exact.slice(0, -2)}x"}`).byteLength).toBe(MAX_STDIN_BYTES + 1);
    expect(await runCli(["event", "claude"], overLimit.deps)).toBe(0);
    expect(overLimit.stdout()).toBe("");
    expect(overLimit.diagnostics).toEqual([
      { timestamp: NOW, component: "cli", code: "invalid_input", provider: "claude" },
    ]);
  });

  test("stops reading stdin as soon as the byte cap is exceeded", async () => {
    initRegistry();
    let pulls = 0;
    const chunk = new Uint8Array(40_000);
    const stdin = (async function* () {
      pulls += 1;
      yield chunk;
      pulls += 1;
      yield chunk;
      pulls += 1;
      yield chunk;
    })();
    const harness = makeHarness({ stdin });
    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(harness.diagnostics.map((record) => record.code)).toEqual(["invalid_input"]);
    // 2 chunks cross 65,536 bytes; the third chunk is never pulled.
    expect(pulls).toBe(2);
  });

  test("returns zero for unsupported or missing providers without touching stdin", async () => {
    initRegistry();
    let pulled = false;
    const stdin = (async function* () {
      pulled = true;
      yield new Uint8Array(1);
    })();

    const unsupported = makeHarness({ stdin });
    expect(await runCli(["event", "bogus"], unsupported.deps)).toBe(0);
    expect(unsupported.stdout()).toBe("");
    expect(unsupported.diagnostics).toEqual([
      { timestamp: NOW, component: "cli", code: "unsupported_provider", provider: "bogus" },
    ]);

    const missing = makeHarness({ stdin });
    expect(await runCli(["event"], missing.deps)).toBe(0);
    expect(missing.diagnostics).toEqual([{ timestamp: NOW, component: "cli", code: "unsupported_provider" }]);
    expect(pulled).toBe(false);
  });

  test.each(["pi", "omp", "zcode", "deepseek"] as const)("event %s is accepted", async (provider) => {
    initRegistry();
    const harness = makeHarness({
      stdin: stdinOf(JSON.stringify({ hook_event_name: "Stop", session_id: `${provider}-1` })),
    });

    expect(await runCli(["event", provider], harness.deps)).toBe(0);
    expect(harness.diagnostics).toEqual([]);
  });

  test("usage lists every provider key", async () => {
    const harness = makeHarness();

    expect(await runCli(["bogus-command"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("event <claude|codex|kimi|pi|omp|zcode|deepseek>");
  });

  test("returns zero for extra event arguments", async () => {
    initRegistry();
    const harness = makeHarness({ stdin: stdinOf(startEvent("s1")) });
    expect(await runCli(["event", "claude", "extra"], harness.deps)).toBe(0);
    expect(harness.diagnostics).toEqual([
      { timestamp: NOW, component: "cli", code: "invalid_input", provider: "claude" },
    ]);
    expect(listRows()).toEqual([]);
  });

  test("returns zero with a missing_database diagnostic and never creates the file", async () => {
    const harness = makeHarness({ stdin: stdinOf(startEvent("s1")) });
    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("");
    expect(harness.diagnostics).toEqual([
      {
        timestamp: NOW,
        component: "cli",
        code: "missing_database",
        provider: "claude",
        sessionId: "s1",
      },
    ]);
    expect(existsSync(paths.database)).toBe(false);
  });

  test("returns zero with an unsupported_schema diagnostic for a future user_version", async () => {
    initRegistry();
    const raw = new Database(paths.database);
    try {
      raw.exec("PRAGMA user_version = 99");
    } finally {
      raw.close();
    }

    const harness = makeHarness({ stdin: stdinOf(startEvent("s1")) });
    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("");
    expect(harness.diagnostics).toEqual([
      {
        timestamp: NOW,
        component: "cli",
        code: "unsupported_schema",
        provider: "claude",
        sessionId: "s1",
      },
    ]);
  });
});

describe("event contention retry", () => {
  const busyError = (): Error & { code: string } => sqliteError("SQLITE_BUSY", "database is locked");

  test("retries once after a 25 ms delay and applies on the second attempt", async () => {
    initRegistry();
    let applyCalls = 0;
    const applyEvents: typeof applyRegistryEvents = (db, events) => {
      applyCalls += 1;
      if (applyCalls === 1) {
        throw busyError();
      }
      return applyRegistryEvents(db, events);
    };
    const harness = makeHarness({ stdin: stdinOf(startEvent("s1")), applyEvents });
    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("");
    expect(applyCalls).toBe(2);
    expect(harness.delays).toEqual([25]);
    expect(harness.diagnostics).toEqual([]);
    expect(listRows().map((row) => row.sessionId)).toEqual(["s1"]);
  });

  test("gives up after the second busy failure with a sqlite_busy diagnostic", async () => {
    initRegistry();
    let applyCalls = 0;
    const applyEvents: typeof applyRegistryEvents = () => {
      applyCalls += 1;
      throw busyError();
    };
    const harness = makeHarness({ stdin: stdinOf(startEvent("s1")), applyEvents });
    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("");
    expect(applyCalls).toBe(2);
    expect(harness.delays).toEqual([25]);
    expect(harness.diagnostics).toEqual([
      {
        timestamp: NOW,
        component: "cli",
        code: "sqlite_busy",
        provider: "claude",
        sessionId: "s1",
      },
    ]);
    expect(listRows()).toEqual([]);
  });

  test("does not retry non-contention failures", async () => {
    initRegistry();
    let applyCalls = 0;
    const applyEvents: typeof applyRegistryEvents = () => {
      applyCalls += 1;
      throw sqliteError("SQLITE_CONSTRAINT", "constraint failed");
    };
    const harness = makeHarness({ stdin: stdinOf(startEvent("s1")), applyEvents });
    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(applyCalls).toBe(1);
    expect(harness.delays).toEqual([]);
    expect(harness.diagnostics).toEqual([
      {
        timestamp: NOW,
        component: "cli",
        code: "internal_error",
        provider: "claude",
        sessionId: "s1",
      },
    ]);
  });
});

describe("diagnostic records", () => {
  test("contain only timestamp, component, code, provider, and bounded session ID", async () => {
    initRegistry();
    const harness = makeHarness({ stdin: stdinOf("not json") });
    await runCli(["event", "claude"], harness.deps);
    await runCli(["event", "bogus"], harness.deps);

    const missingDbPaths = resolveAppPaths(join(tempHome, "nested", "missing"));
    const missingDb = makeHarness({
      paths: missingDbPaths,
      stdin: stdinOf(startEvent("s1")),
    });
    await runCli(["event", "claude"], missingDb.deps);

    const records = [...harness.diagnostics, ...missingDb.diagnostics];
    expect(records.length).toBe(3);
    for (const record of records) {
      for (const key of Object.keys(record)) {
        expect(DIAGNOSTIC_KEYS.has(key)).toBe(true);
      }
      expect(record.timestamp).toBe(NOW);
      expect(record.component).toBe("cli");
      if (record.sessionId !== undefined) {
        expect(Array.from(record.sessionId).length).toBeLessThanOrEqual(256);
      }
    }
  });

  test("file diagnostics never contain raw payload sentinels or caught error text", async () => {
    initRegistry();
    const fileDiagnostics = createFileDiagnostics(paths.logsDirectory);

    const malformed = makeHarness({
      diagnostics: fileDiagnostics,
      stdin: stdinOf('{"session_id":"s1","prompt":"SENTINEL_RAW_PAYLOAD",'),
    });
    expect(await runCli(["event", "claude"], malformed.deps)).toBe(0);

    const busyWithSentinel = makeHarness({
      diagnostics: fileDiagnostics,
      stdin: stdinOf(startEvent("s2")),
      applyEvents: () => {
        throw sqliteError("SQLITE_BUSY", "database is locked by SENTINEL_ERROR_TEXT");
      },
    });
    expect(await runCli(["event", "claude"], busyWithSentinel.deps)).toBe(0);

    const logFile = join(paths.logsDirectory, "cli.log");
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("invalid_input");
    expect(content).toContain("sqlite_busy");
    expect(content).not.toContain("SENTINEL");

    // Every line stays one bounded JSON record of allowlisted keys.
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        expect(DIAGNOSTIC_KEYS.has(key)).toBe(true);
      }
    }
  });

  test("a clean event run writes no diagnostic file content", async () => {
    initRegistry();
    const fileDiagnostics = createFileDiagnostics(paths.logsDirectory);
    const harness = makeHarness({
      diagnostics: fileDiagnostics,
      stdin: stdinOf(startEvent("s1", { prompt: "SENTINEL_FIELD" })),
    });
    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    const logFile = join(paths.logsDirectory, "cli.log");
    if (existsSync(logFile)) {
      expect(readFileSync(logFile, "utf8")).not.toContain("SENTINEL");
    }
  });

  test("rotates component.log to component.log.1 before an append would exceed 256 KiB", () => {
    mkdirSync(paths.logsDirectory, { recursive: true });
    const logFile = join(paths.logsDirectory, "cli.log");
    const rotated = join(paths.logsDirectory, "cli.log.1");
    writeFileSync(logFile, "x".repeat(256 * 1024 - 10));

    const sink = createFileDiagnostics(paths.logsDirectory);
    sink({ timestamp: NOW, component: "cli", code: "invalid_input", provider: "claude" });

    expect(statSync(rotated).size).toBe(256 * 1024 - 10);
    expect(statSync(logFile).size).toBeLessThan(256 * 1024);
    expect(JSON.parse(readFileSync(logFile, "utf8").trim())).toEqual({
      timestamp: NOW,
      component: "cli",
      code: "invalid_input",
      provider: "claude",
    });
  });

  test("file diagnostics create the logs directory when init never ran", async () => {
    const harness = makeHarness({
      diagnostics: createFileDiagnostics(paths.logsDirectory),
      stdin: stdinOf(startEvent("s1")),
    });
    expect(await runCli(["event", "claude"], harness.deps)).toBe(0);
    expect(harness.diagnostics).toEqual([]);
    const content = readFileSync(join(paths.logsDirectory, "cli.log"), "utf8");
    expect(content).toContain("missing_database");
    expect(existsSync(paths.database)).toBe(false);
  });
});

describe("sessions commands", () => {
  const seed = (): void => {
    initRegistry();
    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      const at = (second: number): string => `2026-08-06T00:00:${String(second).padStart(2, "0")}.000Z`;
      const events: RegistryEvent[] = [
        {
          kind: "SessionStart",
          provider: "kimi",
          sessionId: "b",
          title: "B",
          project: null,
          ghosttyTerminalId: null,
          transcriptPath: null,
          model: null,
          observedAt: at(1),
        },
        {
          kind: "SessionStart",
          provider: "claude",
          sessionId: "a",
          title: null,
          project: null,
          ghosttyTerminalId: null,
          transcriptPath: null,
          model: null,
          observedAt: at(2),
        },
        {
          kind: "SubagentStart",
          provider: "claude",
          sessionId: "c2",
          parentSessionId: "a",
          title: null,
          project: null,
          observedAt: at(3),
        },
        {
          kind: "SubagentStart",
          provider: "claude",
          sessionId: "c1",
          parentSessionId: "a",
          title: null,
          project: null,
          observedAt: at(4),
        },
      ];
      applyRegistryEvents(db, events);
    } finally {
      db.close();
    }
  };

  test("sessions list prints ActiveSession JSON ordered by slot then identity", async () => {
    seed();
    const harness = makeHarness();
    expect(await runCli(["sessions", "list"], harness.deps)).toBe(0);
    expect(harness.stderr()).toBe("");
    const listed = JSON.parse(harness.stdout()) as {
      provider: string;
      sessionId: string;
      parentSessionId: string | null;
      logicalSlot: number | null;
      ghosttyTerminalId: string | null;
    }[];
    expect(
      listed.map((row) => [row.provider, row.sessionId, row.parentSessionId, row.logicalSlot, row.ghosttyTerminalId]),
    ).toEqual([
      ["kimi", "b", null, 1, null],
      ["claude", "a", null, 2, null],
      ["claude", "c1", "a", null, null],
      ["claude", "c2", "a", null, null],
    ]);
  });

  test("sessions list prints an empty array for an empty registry", async () => {
    initRegistry();
    const harness = makeHarness();
    expect(await runCli(["sessions", "list"], harness.deps)).toBe(0);
    expect(JSON.parse(harness.stdout())).toEqual([]);
  });

  test("sessions list returns nonzero when the database is missing or unsupported", async () => {
    const missing = makeHarness();
    expect(await runCli(["sessions", "list"], missing.deps)).not.toBe(0);
    expect(missing.stdout()).toBe("");
    expect(missing.stderr()).not.toBe("");

    initRegistry();
    const raw = new Database(paths.database);
    try {
      raw.exec("PRAGMA user_version = 99");
    } finally {
      raw.close();
    }
    const unsupported = makeHarness();
    expect(await runCli(["sessions", "list"], unsupported.deps)).not.toBe(0);
    expect(unsupported.stdout()).toBe("");
    expect(unsupported.stderr()).not.toBe("");
  });

  test("sessions clear removes one identity with its descendants and is idempotent", async () => {
    seed();
    const harness = makeHarness();
    expect(await runCli(["sessions", "clear", "claude", "a"], harness.deps)).toBe(0);
    expect(listRows().map((row) => [row.provider, row.sessionId])).toEqual([["kimi", "b"]]);

    expect(await runCli(["sessions", "clear", "claude", "a"], harness.deps)).toBe(0);
    expect(listRows().map((row) => row.sessionId)).toEqual(["b"]);
  });

  test("sessions clear-all empties the registry", async () => {
    seed();
    const harness = makeHarness();
    expect(await runCli(["sessions", "clear-all"], harness.deps)).toBe(0);
    expect(listRows()).toEqual([]);
  });

  test("sessions prune deletes only sessions older than the age cutoff", async () => {
    seed();
    // Seeds are timestamped 2026-08-06; a clock a day later ages them all out.
    const harness = makeHarness({ now: () => "2026-08-07T00:00:00.000Z" });
    expect(await runCli(["sessions", "prune", "1"], harness.deps)).toBe(0);
    expect(harness.stderr()).toBe("");
    expect(harness.stdout()).toBe("pruned 2 sessions\n");
    expect(listRows()).toEqual([]);
  });

  test("sessions prune defaults to 24 hours and keeps fresh sessions", async () => {
    seed();
    const harness = makeHarness();
    expect(await runCli(["sessions", "prune"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("pruned 0 sessions\n");
    expect(listRows()).toHaveLength(4);

    // A row whose last hook is two days old goes; its children cascade; the
    // fresh ones stay.
    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      db.run("UPDATE active_sessions SET updated_at = ? WHERE session_id = ?", ["2026-08-04T00:00:00.000Z", "a"]);
    } finally {
      db.close();
    }
    const later = makeHarness();
    expect(await runCli(["sessions", "prune"], later.deps)).toBe(0);
    expect(later.stdout()).toBe("pruned 1 session\n");
    expect(listRows().map((row) => [row.provider, row.sessionId])).toEqual([["kimi", "b"]]);
  });

  test("sessions prune zero clears everything and rejects malformed usage", async () => {
    seed();
    const harness = makeHarness({ now: () => "2026-08-07T00:00:00.000Z" });
    expect(await runCli(["sessions", "prune", "0"], harness.deps)).toBe(0);
    expect(listRows()).toEqual([]);

    for (const args of [
      ["sessions", "prune", "banana"],
      ["sessions", "prune", "-1"],
      ["sessions", "prune", "1", "extra"],
    ]) {
      const bad = makeHarness();
      expect(await runCli(args, bad.deps)).not.toBe(0);
      expect(bad.stderr()).not.toBe("");
    }
  });

  test("sessions ack clears a session's unread state", async () => {
    initRegistry();
    const start = makeHarness({ stdin: stdinOf(startEvent("a1")) });
    expect(await runCli(["event", "claude"], start.deps)).toBe(0);
    expect(listRows()[0]).toMatchObject({ status: "idle", unreadSince: null });

    // A turn finishing is the unread result the user has not viewed yet.
    const stop = makeHarness({ stdin: stdinOf(JSON.stringify({ hook_event_name: "Stop", session_id: "a1" })) });
    expect(await runCli(["event", "claude"], stop.deps)).toBe(0);
    expect(listRows()[0]).toMatchObject({ status: "idle", unreadSince: NOW });

    const harness = makeHarness();
    expect(await runCli(["sessions", "ack", "claude", "a1"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toBe("");
    expect(listRows()[0]).toMatchObject({ status: "idle", unreadSince: null });

    // Acknowledging an already-read session is a no-op that still exits zero.
    expect(await runCli(["sessions", "ack", "claude", "a1"], harness.deps)).toBe(0);
    expect(listRows()[0]?.unreadSince).toBeNull();
  });

  test("sessions ack validates args", async () => {
    initRegistry();
    for (const args of [
      ["sessions", "ack", "bogus", "x"],
      ["sessions", "ack", "claude"],
      ["sessions", "ack", "claude", ""],
      ["sessions", "ack", "claude", "s1", "extra"],
    ]) {
      const harness = makeHarness();
      expect(await runCli(args, harness.deps)).toBe(1);
      expect(harness.stderr()).toContain("sessions ack <provider> <session-id>");
      expect(harness.stdout()).toBe("");
    }
  });

  test("sessions clear targets only the exact provider/session composite identity", async () => {
    initRegistry();
    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      applyRegistryEvents(db, [
        {
          kind: "SessionStart",
          provider: "claude",
          sessionId: "shared",
          title: null,
          project: null,
          ghosttyTerminalId: null,
          transcriptPath: null,
          model: null,
          observedAt: NOW,
        },
        {
          kind: "SessionStart",
          provider: "kimi",
          sessionId: "shared",
          title: null,
          project: null,
          ghosttyTerminalId: null,
          transcriptPath: null,
          model: null,
          observedAt: NOW,
        },
      ]);
    } finally {
      db.close();
    }

    const harness = makeHarness();
    expect(await runCli(["sessions", "clear", "claude", "shared"], harness.deps)).toBe(0);
    // The kimi row with the same session ID survives, slot uncompacted.
    expect(listRows().map((row) => [row.provider, row.sessionId, row.logicalSlot])).toEqual([["kimi", "shared", 2]]);
  });

  test("sessions clear and clear-all reject an unsupported schema without mutating rows", async () => {
    seed();
    const before = listRows();
    const raw = new Database(paths.database);
    try {
      raw.exec("PRAGMA user_version = 99");
    } finally {
      raw.close();
    }

    const clear = makeHarness();
    expect(await runCli(["sessions", "clear", "claude", "a"], clear.deps)).not.toBe(0);
    expect(clear.stdout()).toBe("");
    expect(clear.stderr()).not.toBe("");

    const clearAll = makeHarness();
    expect(await runCli(["sessions", "clear-all"], clearAll.deps)).not.toBe(0);
    expect(clearAll.stdout()).toBe("");
    expect(clearAll.stderr()).not.toBe("");

    const restore = new Database(paths.database);
    try {
      restore.exec("PRAGMA user_version = 8");
    } finally {
      restore.close();
    }
    expect(listRows()).toEqual(before);
  });

  test("sessions commands reject malformed usage with nonzero and stderr", async () => {
    initRegistry();
    for (const args of [
      ["sessions"],
      ["sessions", "bogus"],
      ["sessions", "list", "extra"],
      ["sessions", "clear", "claude"],
      ["sessions", "clear", "bogus", "s1"],
      ["sessions", "clear", "claude", "s1", "extra"],
      ["sessions", "ack", "bogus", "s1"],
      ["sessions", "ack", "claude", "s1", "extra"],
      ["sessions", "clear-all", "extra"],
    ]) {
      const harness = makeHarness();
      expect(await runCli(args, harness.deps)).not.toBe(0);
      expect(harness.stderr()).not.toBe("");
      expect(harness.stdout()).toBe("");
    }
  });
});

describe("usage and routing", () => {
  test("no arguments and unknown commands are usage errors", async () => {
    for (const args of [[], ["bogus"], ["init", "extra"]]) {
      const harness = makeHarness();
      expect(await runCli(args, harness.deps)).not.toBe(0);
      expect(harness.stderr()).not.toBe("");
      expect(harness.stdout()).toBe("");
    }
  });
});

describe("daemon command", () => {
  test("routes to the projection daemon with the resolved paths and diagnostics sink", async () => {
    const harness = makeHarness();
    let seenPaths: AppPaths | undefined;
    let seenDiagnostics: unknown;
    harness.deps.runDaemon = (daemonPaths, diagnostics) => {
      seenPaths = daemonPaths;
      seenDiagnostics = diagnostics;
      return 0;
    };
    expect(await runCli(["daemon"], harness.deps)).toBe(0);
    expect(seenPaths).toBe(paths);
    expect(seenDiagnostics).toBe(harness.deps.diagnostics);
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toBe("");
  });

  test("rejects extra arguments with usage and never starts the daemon", async () => {
    const harness = makeHarness();
    let started = false;
    harness.deps.runDaemon = () => {
      started = true;
      return 0;
    };
    expect(await runCli(["daemon", "extra"], harness.deps)).not.toBe(0);
    expect(started).toBe(false);
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).not.toBe("");
  });
});

describe("two-process event smoke", () => {
  test("two simultaneous Bun processes allocate distinct positive logical slots", async () => {
    initRegistry();
    const helper = join(import.meta.dir, "helpers", "event-process.ts");
    const spawn = (sessionId: string) =>
      Bun.spawn([process.execPath, helper, paths.database, sessionId], {
        stdout: "pipe",
        stderr: "pipe",
      });
    const first = spawn("process-a");
    const second = spawn("process-b");
    const [exitA, exitB, errA, errB] = await Promise.all([
      first.exited,
      second.exited,
      new Response(first.stderr).text(),
      new Response(second.stderr).text(),
    ]);
    expect(exitA).toBe(0);
    expect(exitB).toBe(0);
    expect(errA).toBe("");
    expect(errB).toBe("");

    const rows = listRows();
    expect(rows.map((row) => row.sessionId).sort()).toEqual(["process-a", "process-b"]);
    const slots = rows.map((row) => row.logicalSlot);
    for (const slot of slots) {
      expect(typeof slot).toBe("number");
      expect(slot).toBeGreaterThan(0);
    }
    expect(new Set(slots).size).toBe(2);
  });
});
