# Four New Providers — P2 pi + omp shims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring pi and oh-my-pi (omp) sessions onto the grid via one shared shim template shape installed at two paths — pi/omp extension files that normalize native events into the canonical wire contract — plus the omp title resolver, installer shim distribution, docs, and live verification.

**Architecture:** Each shim is a single dependency-free TypeScript file (structural host interfaces declared locally, no imports from pi/omp packages, so jiti loads it bare) that spawns the installed helper detached with the canonical payload on stdin. Churn-prone host-event mapping lives in these user-side files, not in the released daemon (spec Approach A). The daemon side is unchanged except titles.ts's omp slot reader. Tests execute each shim directly under `bun test` against a fake structural host + fake spawn port.

**Tech Stack:** Bun, `bun:test`, TypeScript strict, Biome, pi/omp extension hosts (jiti-loaded). No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-15-four-new-providers-design.md` (revision 3). Binding sections: §pi (P2), §omp (P2), §Install, §Build gate, §Testing (shim harness), §Physical verification (pi/omp bullets), §Out of scope (no pi/omp subagent rows for pi, no permission surface on pi, no StopFailure on omp, no background arming).
- Style: 2 spaces, double quotes, semicolons, 120 columns. Biome strict rules apply to `extensions/**` from Task 1 onward; the ONLY override is `noDefaultExport: off` for the two shim entrypoints (the host contract is a default-exported factory).
- tsconfig strictness applies to `extensions/**` from Task 1: `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` (bracket access), `verbatimModuleSyntax`, `erasableSyntaxOnly` (no enums), `noUncheckedIndexedAccess`.
- Shims are dependency-free: `node:` imports only; host API types declared locally as structural interfaces.
- Wire contract (spec §Decoder): canonical event names; only allowlisted payload keys (`hook_event_name`, `session_id`, `agent_id`, `agent_type`, `cwd`, `title`, `transcript_path`, `tool_name`, `is_interrupt`); **omit-don't-null** (absent fields are simply absent); never spread a host payload into a wire payload.
- Privacy contract: shims never read tool input/output content, prompt text, or error bodies — names and lifecycle only.
- Every shim handler body is try/caught (telemetry never breaks the host session); the helper is spawned detached, stdin piped, `unref`ed, never awaited.
- Stage only the exact files each task lists; never `git add -A`.
- Gate after every task: `bun test` for the touched test file(s) + `bun run typecheck`; gate at plan end: `bun run check`.
- Live-environment actions are gated: running pi/omp sessions, installing hooks/shims into `~/.pi`/`~/.omp`, and `bun scripts/install-local.ts` happen only in Task 3's fixture capture (read-only-ish: one throwaway omp session) and Task 6 (deploy + live probes). Ask the user before the Task 6 deploy.
- Live-pinned surface: pi/omp payload accessor field paths, omp's tool-event parity pair, and the omp title slot framing are research-derived; each lives behind one named constant/function so a correction is a one-line change. Verify against the installed packages where the task says so.
- Model allocation (Paseo profiles): implementer-default (GLM) for Tasks 1-5; reviewer (Sol) gates every task; Task 6 is escalation-tier (Fable) — live-environment verification with judgment-heavy honesty requirements.

---

### Task 1: Build gate + pi shim + harness tests

**Files:**
- Create: `extensions/pi/stream-deck-agents.ts`
- Create: `test/pi-shim.test.ts`
- Modify: `tsconfig.json` (include)
- Modify: `biome.json` (includes + one override)

**Interfaces:**
- Consumes: the canonical decoder contract (P0): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `StopFailure`, `SessionTitleChanged`, `SessionEnd`; payload keys `hook_event_name`, `session_id`, `cwd`, `transcript_path`, `title`, `tool_name`.
- Produces: `createExtension(host: PiHost, spawnPort?: SpawnPort): void` (named export, tests use it) + a default export calling it (host contract). `SpawnPort = (json: string) => void`. Tasks 2 copies this shape for omp; Task 4's installer substitutes the `__STREAM_DECK_AGENTS_EXECUTABLE__` token.

- [ ] **Step 1: Add the build gate for extensions**

In `tsconfig.json`, extend the include:

```json
    "include": ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts", "extensions/**/*.ts"]
```

In `biome.json`, extend `files.includes` and add one override at the end of the `overrides` array:

```json
    "includes": ["src/**", "test/**", "scripts/**", "extensions/**", "*.json", "*.mjs"]
```

```json
    {
      "includes": ["extensions/pi/stream-deck-agents.ts", "extensions/omp/stream-deck-agents.ts"],
      "linter": { "rules": { "style": { "noDefaultExport": "off" } } }
    }
```

(The omp path doesn't exist yet — the override covers it when Task 2 lands it.)

- [ ] **Step 2: Write the failing harness tests**

Create `test/pi-shim.test.ts`. The harness: a fake structural host capturing `on()` registrations, a fake spawn capturing JSON strings, and a `fire()` helper driving handlers with a TUI ctx (or a ghost ctx). The tests pin: event mapping, ghost filtering, the terminal-outcome latch in both orderings, omit-don't-null, and the interactive-source filter.

```ts
import { describe, expect, test } from "bun:test";
import { createExtension, type PiContext, type PiHost } from "../extensions/pi/stream-deck-agents";

type WirePayload = Record<string, unknown>;
type Handler = (event: unknown, ctx: PiContext) => void;

const TUI_CTX: PiContext = {
  mode: "tui",
  sessionManager: {
    getSessionId: () => "pi-s1",
    getSessionFile: () => "/sessions/pi-s1.jsonl",
  },
};

const GHOST_CTX: PiContext = {
  mode: "print",
  sessionManager: {
    getSessionId: () => "pi-ghost",
    getSessionFile: () => undefined,
  },
};

const makeHarness = (options: { sessionName?: string } = {}) => {
  const handlers = new Map<string, Handler[]>();
  const sent: WirePayload[] = [];
  const host: PiHost = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getSessionName: () => options.sessionName,
  };
  createExtension(host, (json) => sent.push(JSON.parse(json) as WirePayload));
  const fire = (event: string, payload: Record<string, unknown> = {}, ctx: PiContext = TUI_CTX): void => {    for (const handler of handlers.get(event) ?? []) {
      handler(payload, ctx);
    }
  };
  return { sent, fire };
};

describe("pi shim event mapping", () => {
  test("session_start emits SessionStart with cwd, transcript path, and title", () => {
    const { sent, fire } = makeHarness({ sessionName: "Fix the widget" });
    fire("session_start");
    expect(sent).toEqual([
      {
        hook_event_name: "SessionStart",
        session_id: "pi-s1",
        cwd: process.cwd(),
        transcript_path: "/sessions/pi-s1.jsonl",
        title: "Fix the widget",
      },
    ]);
  });

  test("interactive input emits UserPromptSubmit; scripted input emits nothing", () => {
    const { sent, fire } = makeHarness();
    fire("input", { source: "interactive" });
    fire("input", { source: "queued" });
    expect(sent).toEqual([{ hook_event_name: "UserPromptSubmit", session_id: "pi-s1" }]);
  });

  test("tool execution emits Pre/PostToolUse with the tool name", () => {
    const { sent, fire } = makeHarness();
    fire("tool_execution_start", { toolName: "Bash" });
    fire("tool_execution_end", { toolName: "Bash" });
    expect(sent.map((payload) => payload["hook_event_name"])).toEqual(["PreToolUse", "PostToolUse"]);
    expect(sent[0]?.["tool_name"]).toBe("Bash");
  });

  test("session_info_changed pushes SessionTitleChanged only when a name exists", () => {
    const named = makeHarness({ sessionName: "Renamed" });
    named.fire("session_info_changed");
    expect(named.sent).toEqual([
      { hook_event_name: "SessionTitleChanged", session_id: "pi-s1", title: "Renamed" },
    ]);

    const unnamed = makeHarness({ sessionName: undefined });
    unnamed.fire("session_info_changed");
    expect(unnamed.sent).toEqual([]);
  });

  test("session_shutdown emits SessionEnd for every reason", () => {
    const { sent, fire } = makeHarness();
    fire("session_shutdown", { reason: "quit" });
    fire("session_shutdown", { reason: "new" });
    expect(sent.map((payload) => payload["hook_event_name"])).toEqual(["SessionEnd", "SessionEnd"]);
  });
});

describe("pi shim terminal-outcome latch", () => {
  test("a clean turn settles to Stop", () => {
    const { sent, fire } = makeHarness();
    fire("agent_end", { stopReason: "end" });
    fire("agent_settled");
    expect(sent).toEqual([{ hook_event_name: "Stop", session_id: "pi-s1" }]);
  });

  test("an errored turn settles to StopFailure exactly once (upstream order: agent_end then agent_settled)", () => {
    const { sent, fire } = makeHarness();
    fire("agent_end", { stopReason: "error" });
    fire("agent_settled");
    expect(sent).toEqual([{ hook_event_name: "StopFailure", session_id: "pi-s1" }]);
  });

  test("the latch clears: the next clean turn emits Stop", () => {
    const { sent, fire } = makeHarness();
    fire("agent_end", { stopReason: "error" });
    fire("agent_settled");
    fire("agent_end", { stopReason: "end" });
    fire("agent_settled");
    expect(sent.map((payload) => payload["hook_event_name"])).toEqual(["StopFailure", "Stop"]);
  });
});

describe("pi shim ghost filter", () => {
  test("a non-TUI process without a session file emits nothing for any event", () => {
    const { sent, fire } = makeHarness({ sessionName: "Ghost" });
    fire("session_start", {}, GHOST_CTX);
    fire("input", { source: "interactive" }, GHOST_CTX);
    fire("tool_execution_start", { toolName: "Bash" }, GHOST_CTX);
    fire("agent_end", { stopReason: "error" }, GHOST_CTX);
    fire("agent_settled", {}, GHOST_CTX);
    fire("session_info_changed", {}, GHOST_CTX);
    fire("session_shutdown", {}, GHOST_CTX);
    expect(sent).toEqual([]);
  });

  test("a ghost agent_end never latches the visible session", () => {
    const { sent, fire } = makeHarness();
    fire("agent_end", { stopReason: "error" }, GHOST_CTX);
    fire("agent_end", { stopReason: "end" });
    fire("agent_settled");
    expect(sent).toEqual([{ hook_event_name: "Stop", session_id: "pi-s1" }]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/pi-shim.test.ts`
Expected: FAIL — the module doesn't exist (import error).

- [ ] **Step 4: Implement the pi shim**

Create `extensions/pi/stream-deck-agents.ts`. The first line is the managed marker (Task 4's installer owns it); the helper path is the install-time token; payload accessor field paths (`readSource`, `readStopReason`, `readToolName`) are the live-pinned surface — verify them against the installed pi package's types (`~/.pi` or the npm package's extension types) before committing and adjust the accessor bodies if needed.

```ts
// stream-deck-agents: managed shim v1
/**
 * Reports pi session lifecycle to the stream-deck-agents daemon.
 *
 * Dependency-free by contract: no imports from pi packages (jiti loads this
 * file bare); the host surface is declared as local structural interfaces.
 * The daemon's decoder owns the canonical contract — this file only
 * normalizes pi's native events into it. Telemetry never breaks the host:
 * every handler is fail-soft and the helper spawn is fire-and-forget.
 */

import { spawn } from "node:child_process";

/** Substituted by scripts/install-local.ts at copy time. */
const HELPER = "__STREAM_DECK_AGENTS_EXECUTABLE__";
const HELPER_ARGS = ["event", "pi"] as const;

export type SpawnPort = (json: string) => void;

/** The slice of pi's ExtensionAPI this shim reads — structural, never imported. */
export type PiContext = {
  mode: string;
  sessionManager: {
    getSessionId(): string | undefined;
    getSessionFile(): string | undefined;
  };
};

export type PiHost = {
  on(event: string, handler: (event: unknown, ctx: PiContext) => void): void;
  getSessionName(): string | undefined;
};

type WirePayload = {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  title?: string;
  tool_name?: string;
};

/** Narrow a host event payload to a readable record; anything else reads as empty. */
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Live-pinned accessor: pi's input event source field. */
const readSource = (event: unknown): string | undefined => {
  const source = asRecord(event)["source"];
  return typeof source === "string" ? source : undefined;
};

/** Live-pinned accessor: pi's agent_end stop reason (drives the latch). */
const readStopReason = (event: unknown): string | undefined => {
  const stopReason = asRecord(event)["stopReason"];
  return typeof stopReason === "string" ? stopReason : undefined;
};

/** Live-pinned accessor: pi's tool execution events carry the tool's name. */
const readToolName = (event: unknown): string | undefined => {
  const toolName = asRecord(event)["toolName"];
  return typeof toolName === "string" ? toolName : undefined;
};

const defaultSpawn: SpawnPort = (json) => {
  try {
    const child = spawn(HELPER, [...HELPER_ARGS], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {
      // Helper missing or unspawnable: the grid simply doesn't update.
    });
    child.stdin?.on("error", () => {
      // EPIPE if the helper exits first — irrelevant to the host.
    });
    child.stdin?.end(json);
    child.unref();
  } catch {
    // Never let telemetry surface in the host process.
  }
};

export const createExtension = (host: PiHost, spawnPort: SpawnPort = defaultSpawn): void => {
  const emit = (payload: WirePayload): void => {
    try {
      spawnPort(JSON.stringify(payload));
    } catch {
      // A broken port must never break the host session.
    }
  };

  /**
   * Ghost filter: extensions load in every pi process — print/json/rpc modes
   * and subagent subprocesses included. Only interactive TUI sessions with a
   * session file are grid-visible.
   */
  const liveSession = (ctx: PiContext): { sessionId: string; sessionFile: string } | undefined => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (ctx.mode !== "tui" || sessionId === undefined || sessionFile === undefined) {
      return undefined;
    }
    return { sessionId, sessionFile };
  };

  // Terminal-outcome latch: pi fires agent_end BEFORE agent_settled, and the
  // registry's applyStop unconditionally rewrites status — StopFailure-then-Stop
  // would flash the error tile and settle idle. Latch an errored agent_end and
  // emit exactly one terminal event at agent_settled.
  let errorLatched = false;

  host.on("session_start", (_event: unknown, ctx: PiContext) => {
    try {
      const session = liveSession(ctx);
      if (session === undefined) {
        return;
      }
      const title = host.getSessionName();
      emit({
        hook_event_name: "SessionStart",
        session_id: session.sessionId,
        cwd: process.cwd(),
        transcript_path: session.sessionFile,
        // omit-don't-null: no title key at all for unnamed sessions
        ...(title === undefined ? {} : { title }),
      });
    } catch {
      // fail-soft
    }
  });

  host.on("input", (event: unknown, ctx: PiContext) => {
    try {
      const session = liveSession(ctx);
      if (session === undefined) {
        return;
      }
      if (readSource(event) !== "interactive") {
        return;
      }
      emit({ hook_event_name: "UserPromptSubmit", session_id: session.sessionId });
    } catch {
      // fail-soft
    }
  });

  // Deliberately tool_execution_start/end, not tool_call: tool_call is
  // fail-closed on throw, and telemetry must never be able to block a tool.
  host.on("tool_execution_start", (event: unknown, ctx: PiContext) => {
    try {
      const session = liveSession(ctx);
      if (session === undefined) {
        return;
      }
      const toolName = readToolName(event);
      emit({
        hook_event_name: "PreToolUse",
        session_id: session.sessionId,
        ...(toolName === undefined ? {} : { tool_name: toolName }),
      });
    } catch {
      // fail-soft
    }
  });

  host.on("tool_execution_end", (event: unknown, ctx: PiContext) => {
    try {
      const session = liveSession(ctx);
      if (session === undefined) {
        return;
      }
      const toolName = readToolName(event);
      emit({
        hook_event_name: "PostToolUse",
        session_id: session.sessionId,
        ...(toolName === undefined ? {} : { tool_name: toolName }),
      });
    } catch {
      // fail-soft
    }
  });

  host.on("agent_end", (event: unknown, ctx: PiContext) => {
    try {
      if (liveSession(ctx) === undefined) {
        return;
      }
      if (readStopReason(event) === "error") {
        errorLatched = true;
      }
    } catch {
      // fail-soft
    }
  });

  host.on("agent_settled", (_event: unknown, ctx: PiContext) => {
    try {
      const session = liveSession(ctx);
      if (session === undefined) {
        return;
      }
      emit({ hook_event_name: errorLatched ? "StopFailure" : "Stop", session_id: session.sessionId });
      errorLatched = false;
    } catch {
      // fail-soft
    }
  });

  host.on("session_info_changed", (_event: unknown, ctx: PiContext) => {
    try {
      const session = liveSession(ctx);
      if (session === undefined) {
        return;
      }
      const title = host.getSessionName();
      if (title === undefined) {
        return;
      }
      emit({ hook_event_name: "SessionTitleChanged", session_id: session.sessionId, title });
    } catch {
      // fail-soft
    }
  });

  host.on("session_shutdown", (_event: unknown, ctx: PiContext) => {
    try {
      const session = liveSession(ctx);
      if (session === undefined) {
        return;
      }
      // Every reason — /new, /resume, /fork open a fresh session under a new
      // id, and the old row would otherwise linger as a dead tile until the
      // prune. The following session_start (or late-join) re-registers.
      emit({ hook_event_name: "SessionEnd", session_id: session.sessionId });
    } catch {
      // fail-soft
    }
  });
};

/** pi's extension contract: a default-exported factory invoked with the ExtensionAPI. */
export default function streamDeckAgents(host: PiHost): void {
  createExtension(host);
}
```

- [ ] **Step 5: Run tests to verify they pass, and the gate covers the shim**

Run: `bun test test/pi-shim.test.ts && bun run typecheck && bun run lint`
Expected: PASS; typecheck and lint cover `extensions/pi/stream-deck-agents.ts` (prove lint coverage with `node_modules/.bin/biome lint extensions/pi/stream-deck-agents.ts` — it must report the file checked, not ignored).

Also verify the pinned accessors against the installed pi's extension types (find its types under `~/.pi` or the global npm package) and record in your report which payload fields the installed build actually carries (`source`, `stopReason`, `toolName` spellings). If they differ, adjust the accessor bodies — one line each — and re-run the tests.

- [ ] **Step 6: Commit**

```bash
git add extensions/pi/stream-deck-agents.ts test/pi-shim.test.ts tsconfig.json biome.json
git commit -m "feat(extensions): pi shim normalizing native events to the wire contract"
```

---

### Task 2: omp shim + harness tests

**Files:**
- Create: `extensions/omp/stream-deck-agents.ts`
- Create: `test/omp-shim.test.ts`

**Interfaces:**
- Consumes: the Task 1 shape (`SpawnPort`, structural host pattern, ghost filter, omit-don't-null, managed marker + helper token). Decoder contract adds: `PermissionRequest`, `SubagentStart` (wire: `session_id` = parent session id, `agent_id` = child identity, optional `agent_type`, `cwd`), `SubagentStop` (wire: `session_id`, `agent_id`).
- Produces: `createExtension(host: OmpHost, spawnPort?: SpawnPort): void` + default export → `~/.omp/agent/extensions/stream-deck-agents.ts`. Task 3's resolver reads the session file the shim reports as `transcript_path`.

**Implementation-time parity probe (do it FIRST, record the answer in your report):** omp is a pi fork — check the installed `@oh-my-pi/pi-coding-agent` types (global npm root or `~/.omp`) for whether `tool_execution_start` / `tool_execution_end` exist with pi's payload shape. If yes, use them (fork parity, never fail-closed). If no, use `tool_call` / `tool_result` with the already-try/caught bodies. The chosen pair lives in exactly one place:

```ts
const TOOL_EVENTS = { start: "tool_execution_start", end: "tool_execution_end" } as const;
```

- [ ] **Step 1: Write the failing harness tests**

Create `test/omp-shim.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createExtension, type OmpContext, type OmpHost, TOOL_EVENTS } from "../extensions/omp/stream-deck-agents";

type WirePayload = Record<string, unknown>;

const TUI_CTX: OmpContext = {
  hasUI: true,
  sessionManager: {
    getSessionId: () => "omp-s1",
    getSessionFile: () => "/sessions/omp-s1.jsonl",
  },
};

const GHOST_CTX: OmpContext = {
  hasUI: false,
  sessionManager: {
    getSessionId: () => "omp-ghost",
    getSessionFile: () => undefined,
  },
};

const makeHarness = () => {
  const handlers = new Map<string, ((event: unknown, ctx: OmpContext) => unknown)[]>();
  const busHandlers = new Map<string, ((payload: unknown) => void)[]>();
  const sent: WirePayload[] = [];
  const host: OmpHost = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: {
      on(event, handler) {
        busHandlers.set(event, [...(busHandlers.get(event) ?? []), handler]);
      },
    },
  };
  createExtension(host, (json) => sent.push(JSON.parse(json) as WirePayload));
  const fire = (event: string, payload: unknown = {}, ctx: OmpContext = TUI_CTX): unknown[] => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(handler(payload, ctx));
    }
    return results;
  };
  const fireBus = (event: string, payload: unknown): void => {
    for (const handler of busHandlers.get(event) ?? []) {
      handler(payload);
    }
  };
  return { sent, fire, fireBus };
};

describe("omp shim event mapping", () => {
  test("session_start emits SessionStart with cwd and transcript path", () => {
    const { sent, fire } = makeHarness();
    fire("session_start");
    expect(sent).toEqual([
      {
        hook_event_name: "SessionStart",
        session_id: "omp-s1",
        cwd: process.cwd(),
        transcript_path: "/sessions/omp-s1.jsonl",
      },
    ]);
  });

  test("interactive input emits UserPromptSubmit", () => {
    const { sent, fire } = makeHarness();
    fire("input", { source: "interactive" });
    expect(sent).toEqual([{ hook_event_name: "UserPromptSubmit", session_id: "omp-s1" }]);
  });

  test("tool events emit Pre/PostToolUse, normalizing ask to AskUserQuestion (exact wire JSON, host fields not forwarded)", () => {
    const { sent, fire } = makeHarness();
    fire(TOOL_EVENTS.start, { toolName: "read", input: { path: "/etc/passwd" } });
    fire(TOOL_EVENTS.start, { toolName: "ask" });
    fire(TOOL_EVENTS.end, { toolName: "ask", result: "private" });
    expect(sent).toEqual([
      { hook_event_name: "PreToolUse", session_id: "omp-s1", tool_name: "read" },
      { hook_event_name: "PreToolUse", session_id: "omp-s1", tool_name: "AskUserQuestion" },
      { hook_event_name: "PostToolUse", session_id: "omp-s1", tool_name: "AskUserQuestion" },
    ]);
  });

  test("omit-don't-null: absent host fields produce absent wire keys", () => {
    const { sent, fire, fireBus } = makeHarness();
    fire("session_start");
    fire(TOOL_EVENTS.start, {});
    fireBus("task:subagent:lifecycle", { id: "agent-9", phase: "started" });
    expect("tool_name" in (sent[1] ?? {})).toBe(false);
    expect("agent_type" in (sent[2] ?? {})).toBe(false);
  });

  test("tool_approval_requested emits PermissionRequest and the handler returns undefined", () => {
    const { sent, fire } = makeHarness();
    const results = fire("tool_approval_requested", { toolName: "bash" });
    expect(sent).toEqual([{ hook_event_name: "PermissionRequest", session_id: "omp-s1" }]);
    for (const result of results) {
      expect(result).toBeUndefined();
    }
  });

  test("session_stop emits Stop; session_shutdown emits SessionEnd (exact wire JSON)", () => {
    const { sent, fire } = makeHarness();
    fire("session_stop", { reason: "finished", durationMs: 42 });
    fire("session_shutdown", { reason: "quit" });
    expect(sent).toEqual([
      { hook_event_name: "Stop", session_id: "omp-s1" },
      { hook_event_name: "SessionEnd", session_id: "omp-s1" },
    ]);
  });
});

describe("omp shim ghost filter and identity refresh", () => {
  test("a headless session (no UI, no session file) emits nothing", () => {
    const { sent, fire } = makeHarness();
    fire("session_start", {}, GHOST_CTX);
    fire("input", { source: "interactive" }, GHOST_CTX);
    fire(TOOL_EVENTS.start, { toolName: "read" }, GHOST_CTX);
    fire("session_stop", {}, GHOST_CTX);
    expect(sent).toEqual([]);
  });

  test("session_switch re-parents: bus subagent rows follow the visible session (exact wire JSON)", () => {
    const { sent, fire, fireBus } = makeHarness();
    fire("session_start");
    const otherCtx: OmpContext = {
      hasUI: true,
      sessionManager: {
        getSessionId: () => "omp-s2",
        getSessionFile: () => "/sessions/omp-s2.jsonl",
      },
    };
    fire("session_switch", {}, otherCtx);
    fireBus("task:subagent:lifecycle", { id: "agent-1", agent_name: "explore", phase: "started" });
    expect(sent).toEqual([
      {
        hook_event_name: "SessionStart",
        session_id: "omp-s1",
        cwd: process.cwd(),
        transcript_path: "/sessions/omp-s1.jsonl",
      },
      {
        hook_event_name: "SubagentStart",
        session_id: "omp-s2",
        agent_id: "agent-1",
        agent_type: "explore",
        cwd: process.cwd(),
      },
    ]);
  });

  test("a headless child's lifecycle event with no visible session emits nothing", () => {
    const { sent, fireBus } = makeHarness();
    fireBus("task:subagent:lifecycle", { id: "agent-1", phase: "started" });
    expect(sent).toEqual([]);
  });

  test("every event is filtered by each ghost predicate independently", () => {
    const events = [
      "session_start",
      "input",
      TOOL_EVENTS.start,
      TOOL_EVENTS.end,
      "tool_approval_requested",
      "session_stop",
      "session_shutdown",
      "session_switch",
    ];
    const ghostNoUI: OmpContext = {
      hasUI: false,
      sessionManager: { getSessionId: () => "g1", getSessionFile: () => "/sessions/g1.jsonl" },
    };
    const ghostNoFile: OmpContext = {
      hasUI: true,
      sessionManager: { getSessionId: () => undefined, getSessionFile: () => undefined },
    };
    for (const ghost of [ghostNoUI, ghostNoFile]) {
      const { sent, fire, fireBus } = makeHarness();
      for (const event of events) {
        fire(event, { source: "interactive", toolName: "read" }, ghost);
      }
      fireBus("task:subagent:lifecycle", { id: "a1", agent_name: "explore", phase: "started" });
      expect(sent).toEqual([]);
    }
  });
});

describe("omp shim subagent lifecycle", () => {
  test("started emits SubagentStart; completed/failed/aborted emit SubagentStop (exact wire JSON)", () => {
    const { sent, fire, fireBus } = makeHarness();
    fire("session_start");
    fireBus("task:subagent:lifecycle", { id: "agent-1", agent_name: "explore", phase: "started", progress: "50%" });
    fireBus("task:subagent:lifecycle", { id: "agent-1", phase: "completed" });
    fireBus("task:subagent:lifecycle", { id: "agent-2", phase: "failed" });
    fireBus("task:subagent:lifecycle", { id: "agent-3", phase: "aborted" });
    expect(sent).toEqual([
      {
        hook_event_name: "SessionStart",
        session_id: "omp-s1",
        cwd: process.cwd(),
        transcript_path: "/sessions/omp-s1.jsonl",
      },
      {
        hook_event_name: "SubagentStart",
        session_id: "omp-s1",
        agent_id: "agent-1",
        agent_type: "explore",
        cwd: process.cwd(),
      },
      { hook_event_name: "SubagentStop", session_id: "omp-s1", agent_id: "agent-1" },
      { hook_event_name: "SubagentStop", session_id: "omp-s1", agent_id: "agent-2" },
      { hook_event_name: "SubagentStop", session_id: "omp-s1", agent_id: "agent-3" },
    ]);
  });

  test("lifecycle payloads with an empty id are skipped", () => {
    const { sent, fire, fireBus } = makeHarness();
    fire("session_start");
    fireBus("task:subagent:lifecycle", { id: "", phase: "started" });
    expect(sent).toHaveLength(1); // the SessionStart only
  });
});
```

Note: the test imports the shim's exported `TOOL_EVENTS` and fires `TOOL_EVENTS.start` / `.end` — the harness must not hardcode the pair, or the parity probe's answer can't change it in one place. (`fire` returns handler results so the approval test can assert `undefined`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/omp-shim.test.ts`
Expected: FAIL — the module doesn't exist.

- [ ] **Step 3: Implement the omp shim**

Create `extensions/omp/stream-deck-agents.ts`:

```ts
// stream-deck-agents: managed shim v1
/**
 * Reports oh-my-pi (omp) session lifecycle to the stream-deck-agents daemon.
 *
 * Dependency-free by contract (jiti loads this file bare); the host surface
 * is declared as local structural interfaces. omp hosts MANY sessions per
 * process, including headless ones — the shim emits only for sessions with a
 * UI and a session file, and re-reads the current identity on every
 * session_start and session_switch (the subagent bus handler has no ctx, so
 * a stale captured id would mis-parent rows). Telemetry never breaks the
 * host: every handler is fail-soft, the approval handler is observe-only,
 * and the helper spawn is fire-and-forget.
 */

import { spawn } from "node:child_process";

/** Substituted by scripts/install-local.ts at copy time. */
const HELPER = "__STREAM_DECK_AGENTS_EXECUTABLE__";
const HELPER_ARGS = ["event", "omp"] as const;

/**
 * Tool-event pair — pinned by the implementation-time parity probe against
 * the installed omp package. Prefer pi's fork-parity pair; fall back to
 * tool_call/tool_result (both handler bodies stay fully try/caught — those
 * events are fail-closed on throw). Exported so the harness fires the same
 * pair instead of hardcoding it.
 */
export const TOOL_EVENTS = { start: "tool_execution_start", end: "tool_execution_end" } as const;

export type SpawnPort = (json: string) => void;

export type OmpContext = {
  hasUI: boolean;
  sessionManager: {
    getSessionId(): string | undefined;
    getSessionFile(): string | undefined;
  };
};

export type OmpHost = {
  on(event: string, handler: (event: unknown, ctx: OmpContext) => unknown): void;
  events: {
    on(event: string, handler: (payload: unknown) => void): void;
  };
};

type WirePayload = {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  agent_id?: string;
  agent_type?: string;
};

/** Narrow a host payload to a readable record; anything else reads as empty. */
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const readString = (value: unknown, key: string): string | undefined => {
  const field = asRecord(value)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
};

/** Live-pinned accessor: omp's input event source field (pi fork parity). */
const readSource = (event: unknown): string | undefined => readString(event, "source");

/** Live-pinned accessor: omp's tool events carry the tool's name. */
const readToolName = (event: unknown): string | undefined => readString(event, "toolName");

/** omp's question tool normalizes to the decoder's existing waiting rule. */
const normalizeToolName = (name: string | undefined): string | undefined =>
  name === "ask" ? "AskUserQuestion" : name;

const defaultSpawn: SpawnPort = (json) => {
  try {
    const child = spawn(HELPER, [...HELPER_ARGS], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(json);
    child.unref();
  } catch {
    // Never let telemetry surface in the host process.
  }
};

export const createExtension = (host: OmpHost, spawnPort: SpawnPort = defaultSpawn): void => {
  const emit = (payload: WirePayload): void => {
    try {
      spawnPort(JSON.stringify(payload));
    } catch {
      // A broken port must never break the host session.
    }
  };

  // The current GRID-VISIBLE session identity. Undefined when the foreground
  // session is headless or file-less. Refreshed on session_start and
  // session_switch; the subagent bus handler has no ctx and reads this.
  let current: { sessionId: string; sessionFile: string } | undefined;

  const refresh = (ctx: OmpContext): void => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    current =
      ctx.hasUI && sessionId !== undefined && sessionFile !== undefined ? { sessionId, sessionFile } : undefined;
  };

  host.on("session_start", (_event: unknown, ctx: OmpContext) => {
    try {
      refresh(ctx);
      if (current === undefined) {
        return;
      }
      emit({
        hook_event_name: "SessionStart",
        session_id: current.sessionId,
        cwd: process.cwd(),
        transcript_path: current.sessionFile,
      });
    } catch {
      // fail-soft
    }
  });

  host.on("session_switch", (_event: unknown, ctx: OmpContext) => {
    try {
      // Identity follows the visible session; the row itself re-registers on
      // the next prompt via late-join if it was pruned.
      refresh(ctx);
    } catch {
      // fail-soft
    }
  });

  host.on("input", (event: unknown, ctx: OmpContext) => {
    try {
      refresh(ctx);
      if (current === undefined || readSource(event) !== "interactive") {
        return;
      }
      emit({ hook_event_name: "UserPromptSubmit", session_id: current.sessionId });
    } catch {
      // fail-soft
    }
  });

  host.on(TOOL_EVENTS.start, (event: unknown, ctx: OmpContext) => {
    try {
      refresh(ctx);
      if (current === undefined) {
        return;
      }
      const toolName = normalizeToolName(readToolName(event));
      emit({
        hook_event_name: "PreToolUse",
        session_id: current.sessionId,
        ...(toolName === undefined ? {} : { tool_name: toolName }),
      });
    } catch {
      // fail-soft
    }
  });

  host.on(TOOL_EVENTS.end, (event: unknown, ctx: OmpContext) => {
    try {
      refresh(ctx);
      if (current === undefined) {
        return;
      }
      const toolName = normalizeToolName(readToolName(event));
      emit({
        hook_event_name: "PostToolUse",
        session_id: current.sessionId,
        ...(toolName === undefined ? {} : { tool_name: toolName }),
      });
    } catch {
      // fail-soft
    }
  });

  host.on("tool_approval_requested", (_event: unknown, ctx: OmpContext) => {
    try {
      refresh(ctx);
      if (current === undefined) {
        return undefined;
      }
      // Observe-only: this handler exists to see the event. Never intercept —
      // the return value is undefined and the approval UX is unchanged.
      emit({ hook_event_name: "PermissionRequest", session_id: current.sessionId });
      return undefined;
    } catch {
      return undefined;
    }
  });

  // session_stop is awaited by omp — the helper spawn is detached and this
  // handler never blocks on it.
  host.on("session_stop", (_event: unknown, ctx: OmpContext) => {
    try {
      refresh(ctx);
      if (current === undefined) {
        return;
      }
      emit({ hook_event_name: "Stop", session_id: current.sessionId });
    } catch {
      // fail-soft
    }
  });

  // Verified 2026-08-15: session_shutdown is process-exit only; session
  // switches fire session_switch instead (handled above).
  host.on("session_shutdown", (_event: unknown, ctx: OmpContext) => {
    try {
      refresh(ctx);
      if (current === undefined) {
        return;
      }
      emit({ hook_event_name: "SessionEnd", session_id: current.sessionId });
    } catch {
      // fail-soft
    }
  });

  host.events.on("task:subagent:lifecycle", (payload: unknown) => {
    try {
      // No ctx on the bus — the refreshed foreground identity is the parent.
      if (current === undefined) {
        return;
      }
      const childId = readString(payload, "id");
      if (childId === undefined) {
        return;
      }
      const phase = readString(payload, "phase");
      if (phase === "started") {
        // The payload id is an agent/registry identity, NOT a session-manager
        // session id — the two namespaces never mix on the wire (agent_id).
        const agentName = readString(payload, "agent_name");
        emit({
          hook_event_name: "SubagentStart",
          session_id: current.sessionId,
          agent_id: childId,
          cwd: process.cwd(),
          ...(agentName === undefined ? {} : { agent_type: agentName }),
        });
      } else if (phase === "completed" || phase === "failed" || phase === "aborted") {
        emit({ hook_event_name: "SubagentStop", session_id: current.sessionId, agent_id: childId });
      }
    } catch {
      // fail-soft
    }
  });
};

/** omp's extension contract: a default-exported factory invoked with the ExtensionAPI. */
export default function streamDeckAgents(host: OmpHost): void {
  createExtension(host);
}
```

Note for the implementer: omp's extension host may deliver ctx with `hasUI` absent on some events — treat `undefined` as UI-present only if the installed types say so; otherwise require `hasUI === true` strictly and record the choice in your report.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/omp-shim.test.ts && bun run typecheck && bun run lint`
Expected: PASS; typecheck + lint clean (the noDefaultExport override already covers this path from Task 1).

- [ ] **Step 5: Commit**

```bash
git add extensions/omp/stream-deck-agents.ts test/omp-shim.test.ts
git commit -m "feat(extensions): omp shim with approval, subagent, and session-switch coverage"
```

---

### Task 3: omp title resolver (256-byte slot reader)

**Files:**
- Modify: `src/core/titles.ts`
- Test: `test/titles.test.ts`
- Create: `test/fixtures/omp-session.jsonl` (captured from the installed omp — see Step 1)

**Interfaces:**
- Consumes: omp rows carry `transcript_path` (the session JSONL) from Task 2's SessionStart payload; the daemon's 2s titles cadence already calls the resolver.
- Produces: `TitleResolverDependencies` gains `readHead?: (path: string, maxBytes: number) => string | null` (injected for tests; default reads the file head). omp titles resolve from the fixed 256-byte title slot at the head of the session file, (mtime,size)-cached per path (the file is append-only — caching is sound here, unlike zcode's WAL). The slot framing is fixture-pinned: `OMP_SLOT_BYTES` and the parse live behind one function each.

- [ ] **Step 1: Capture the fixture (live, read-only-ish)**

omp is installed on this machine. Run one throwaway omp session (`omp` with a trivial prompt in a temp directory) so it writes a session JSONL under `~/.omp/agent/sessions/` (find the actual sessions dir from the installed package's paths). Copy the smallest resulting file to `test/fixtures/omp-session.jsonl`. This touches `~/.omp` (a throwaway session) — allowed per the plan's Global Constraints.

Inspect the head of the file (`xxd | head`) and record in your report: the exact slot framing (padding bytes, record shape, field names). If reality differs from the planned parser below, adjust `parseOmpTitleSlot` — it is the single pin point — and describe the actual framing in the module comment and your report.

- [ ] **Step 2: Write the failing tests**

In `test/titles.test.ts`, extend `makeResolver`: the seed gains `heads?: Record<string, string>` and the resolver construction gains `readHead: (path) => { headReads += 1; return heads.get(path) ?? null; }` (plus a `headReads()` counter on the returned fs object). All existing tests keep passing.

Append:

```ts
describe("omp session-file titles", () => {
  const ompTarget = (overrides: Partial<TitleTarget> = {}): TitleTarget => ({
    provider: "omp",
    sessionId: "o1",
    title: null,
    transcriptPath: "/sessions/o1.jsonl",
    ...overrides,
  });

  test("reads the title slot from a real captured omp session file", () => {
    // Real defaults, real fixture file — no fs fakes.
    const resolver = createTitleResolver({
      codexIndexPath: "/nonexistent/.codex/session_index.jsonl",
      zcodeDatabasePath: "/nonexistent/.zcode/cli/db/db.sqlite",
    });
    const updates = resolver.resolve([{ provider: "omp", sessionId: "o1", title: null, transcriptPath: FIXTURE_PATH }]);
    expect(updates).toEqual([{ provider: "omp", sessionId: "o1", title: FIXTURE_TITLE }]);
  });

  test("caches per path on mtime and size", () => {
    const { resolver, fs } = makeResolver({
      zcodeDatabasePath: "/nonexistent/.zcode/cli/db/db.sqlite",
      stats: { "/sessions/o1.jsonl": { mtimeMs: 100, size: 900 } },
      heads: { "/sessions/o1.jsonl": `${slotRecord("Auto-titled session")}${"\n"}` },
    });
    expect(resolver.resolve([ompTarget()])).toEqual([
      { provider: "omp", sessionId: "o1", title: "Auto-titled session" },
    ]);
    expect(fs.headReads()).toBe(1);

    expect(resolver.resolve([ompTarget({ title: "Auto-titled session" })])).toEqual([]);
    expect(fs.headReads()).toBe(1);

    fs.stats.set("/sessions/o1.jsonl", { mtimeMs: 200, size: 1200 });
    fs.heads.set("/sessions/o1.jsonl", slotRecord("Retitled"));
    expect(resolver.resolve([ompTarget({ title: "Auto-titled session" })])).toEqual([
      { provider: "omp", sessionId: "o1", title: "Retitled" },
    ]);
    expect(fs.headReads()).toBe(2);
  });

  test("falls back to the first parseable JSONL title line after the slot", () => {
    const { resolver } = makeResolver({
      stats: { "/sessions/o1.jsonl": { mtimeMs: 100, size: 900 } },
      heads: { "/sessions/o1.jsonl": `${"\0".repeat(OMP_SLOT_BYTES)}${JSON.stringify({ type: "message" })}\n${JSON.stringify({ title: "Fallback title" })}\n` },
    });
    expect(resolver.resolve([ompTarget()])).toEqual([{ provider: "omp", sessionId: "o1", title: "Fallback title" }]);
  });

  test("no slot and no fallback line resolves nothing; a missing file never throws", () => {
    const { resolver } = makeResolver({
      stats: { "/sessions/o1.jsonl": { mtimeMs: 100, size: 900 } },
      heads: { "/sessions/o1.jsonl": `${"\0".repeat(OMP_SLOT_BYTES)}${JSON.stringify({ type: "message" })}\n` },
    });
    expect(resolver.resolve([ompTarget()])).toEqual([]);

    const missing = makeResolver();
    expect(missing.resolver.resolve([ompTarget()])).toEqual([]);
  });

  test("skips omp rows without a transcript path", () => {
    const { resolver, fs } = makeResolver();
    expect(resolver.resolve([ompTarget({ transcriptPath: null })])).toEqual([]);
    expect(fs.headReads()).toBe(0);
  });
});
```

with harness additions at the top of the describe:

```ts
const FIXTURE_PATH = join(import.meta.dir, "fixtures", "omp-session.jsonl");
// The title stored in the captured fixture (read it once and paste the value
// here as a string literal — the test must pin it, not re-derive it).
const FIXTURE_TITLE = "<captured title>";

const slotRecord = (title: string): string => {
  const record = JSON.stringify({ type: "title", title });
  return record + " ".repeat(OMP_SLOT_BYTES - record.length);
};
```

(`OMP_SLOT_BYTES` is imported from src/core/titles. New imports: `join` from node:path.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/titles.test.ts`
Expected: FAIL — omp targets resolve nothing (no omp branch), `OMP_SLOT_BYTES`/`readHead` don't exist.

- [ ] **Step 4: Implement the omp resolver**

In `src/core/titles.ts`:

(a) Dependencies and the default head reader:

```ts
export type TitleResolverDependencies = {
  codexIndexPath: string;
  /** zcode's SQLite store; resolved by the caller (ZCODE_HOME override lives in cli.ts). */
  zcodeDatabasePath: string;
  statPath?: (path: string) => FileStat | null;
  readTail?: (path: string, maxBytes: number) => string | null;
  readWhole?: (path: string) => string | null;
  readHead?: (path: string, maxBytes: number) => string | null;
};
```

```ts
const defaultReadHead = (path: string, maxBytes: number): string | null => {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // A close failure has no bearing on the read result.
      }
    }
  }
};
```

(b) The parser — the fixture-pinned pin point:

```ts
/** omp's session JSONL reserves a fixed-size title slot at the head. */
export const OMP_SLOT_BYTES = 256;
const OMP_HEAD_BYTES = 4 * 1024;

/**
 * Parse the auto-generated title from the head of an omp session file. omp
 * reserves a fixed 256-byte slot at byte 0 holding a padded
 * `{"type":"title","title":...}` record (framing pinned by the captured
 * fixture test/fixtures/omp-session.jsonl); older/smaller files fall back to
 * the first parseable JSONL line after the slot carrying a `title` field.
 */
const ompTitleFromHead = (head: string): string | null => {
  const slot = head.slice(0, OMP_SLOT_BYTES).replace(/[\0\s]+$/u, "");
  try {
    const parsed: unknown = JSON.parse(slot);
    if (
      isRecord(parsed) &&
      parsed["type"] === "title" &&
      typeof parsed["title"] === "string" &&
      parsed["title"].length > 0
    ) {
      return boundTitle(parsed["title"]);
    }
  } catch {
    // Not a parseable slot record — fall through to the JSONL fallback.
  }
  for (const line of head.slice(OMP_SLOT_BYTES).split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed["title"] === "string" && parsed["title"].length > 0) {
        return boundTitle(parsed["title"]);
      }
    } catch {
      // Malformed line — keep scanning.
    }
  }
  return null;
};
```

(c) The omp branch in `createTitleResolver`, mirroring the Claude cache shape:

```ts
  const readHead = dependencies.readHead ?? defaultReadHead;
  const ompCache = new Map<string, FileStat & { title: string | null }>();

  const ompTitle = (path: string): string | null => {
    const stat = statPath(path);
    if (stat === null) {
      return null;
    }
    const cached = ompCache.get(path);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.title;
    }
    // The session file is append-only, so stat-identity caching is sound here
    // (unlike zcode's WAL store, which bypasses the main file entirely).
    const head = readHead(path, OMP_HEAD_BYTES);
    const title = head === null ? null : ompTitleFromHead(head);
    ompCache.set(path, { ...stat, title });
    return title;
  };
```

and in `resolve`:

```ts
        } else if (target.provider === "omp" && target.transcriptPath !== null) {
          resolved = ompTitle(target.transcriptPath);
        }
```

(d) Module docstring: the bullet list gains omp ("omp: the 256-byte title slot at the head of the session JSONL at the row's transcript_path, (mtime,size)-cached — the file is append-only").

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/titles.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/titles.ts test/titles.test.ts test/fixtures/omp-session.jsonl
git commit -m "feat(titles): resolve omp titles from the session-file slot"
```

---

### Task 4: Installer distributes the shims

**Files:**
- Modify: `scripts/install-local.ts`

**Interfaces:**
- Consumes: the two shim templates (Tasks 1-2) carrying the `__STREAM_DECK_AGENTS_EXECUTABLE__` token and the `// stream-deck-agents: managed shim v1` first-line marker.
- Produces: install order …→ plugin install → **shims last** (auto-discovered shims never activate before the compatible daemon and plugin are live). The installer installs its own shim files into provider extension dirs; it still never edits provider **config files**.

- [ ] **Step 1: Implement the shim install step**

In `scripts/install-local.ts`:

(a) Constants (near the existing token constants):

```ts
const SHIM_MARKER = "// stream-deck-agents: managed shim v1";
const SHIM_NAME = "stream-deck-agents.ts";
const SHIM_TARGETS = [
  { provider: "pi", homeDir: ".pi" },
  { provider: "omp", homeDir: ".omp" },
] as const;
const SHIM_MODE = 0o600;
```

(b) The step function (after the plugin install step — shims go last):

```ts
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
```

(c) Call it as the final step in `main()`, after the plugin install step. Printing uses `process.stdout.write`, matching the installer's existing convention (scripts/install-local.ts:151).

(d) Update the header comment: add the shim step to the numbered list, and change the contract sentence to "installs its own shim files into provider extension dirs; it still never edits provider **config files**".

(e) Imports needed: `existsSync`, `renameSync` from node:fs (add to the existing import), nothing else.

- [ ] **Step 2: Verify statically**

Run: `bun run typecheck && bun run lint && bun test`
Expected: clean (the installer has no unit tests — the live run is Task 6).

Prove the token wiring without deploying: a focused bun -e probe that imports nothing from scripts/ but reads `extensions/pi/stream-deck-agents.ts` and asserts it starts with the marker and contains the token:

```sh
bun -e 'const s = require("node:fs").readFileSync("extensions/pi/stream-deck-agents.ts", "utf8"); if (!s.startsWith("// stream-deck-agents: managed shim v1")) throw new Error("marker missing"); if (!s.includes("__STREAM_DECK_AGENTS_EXECUTABLE__")) throw new Error("token missing");'
```

- [ ] **Step 3: Commit**

```bash
git add scripts/install-local.ts
git commit -m "feat(scripts): install managed pi/omp shims last"
```

---

### Task 5: Docs — pi/omp sections + conventions

**Files:**
- Modify: `docs/hook-configuration.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: Tasks 1-4 (shim behavior, install mechanics, ownership markers).
- Produces: user-facing setup/maintenance docs for pi and omp; current conventions.

- [ ] **Step 1: Add the pi and omp sections to `docs/hook-configuration.md`**

Insert `## pi` and `## oh-my-pi (omp)` sections after the ZCode section, before `## After every provider`. These are NOT config-edit sections — the shim is installer-placed — so they use a shorter shape than the ritual sections. Content requirements:

**pi section:**
- What it is: a single extension file the installer places at `~/.pi/agent/extensions/stream-deck-agents.ts`; it reports session lifecycle to the daemon; no pi config edits needed.
- The ownership marker contract: the file's first line is `// stream-deck-agents: managed shim v1`; the installer refuses to overwrite a same-named file without it. If you customize the file, the installer leaves it alone (and your copy stops receiving updates).
- Behavior to expect: tile appears on session start (TUI sessions only — print/json/rpc processes never produce tiles); working on prompt/tool activity; idle when the turn settles; a failed turn shows the error tile and it stays; `/name` retitles the tile; `/new`, `/resume`, `/fork` close the old row and open the new session's; quitting pi removes the tile.
- Known gaps: pi has no permission/question surface — the tile never shows waiting; no subagent rows.
- Verify: start a new pi session and watch the tile appear. Remove: delete the file.

**omp section:**
- Same shape, at `~/.omp/agent/extensions/stream-deck-agents.ts`, plus: approval prompts and omp's ask question show waiting; approval UX is unchanged (the shim observes, never intercepts); subagent runs show the descendant badge; auto-generated titles appear a few seconds after the first message (read from the session file's title slot); switching sessions mid-process keeps parentage correct; quitting removes the tile. Known gap: no error tile (omp has no StopFailure-equivalent event; interrupts settle to idle).
- Note the fork-churn caution: omp ships multiple times per day; if tiles stop updating after an omp upgrade, reinstall (`bun scripts/install-local.ts`) and re-check — the shim's host-event surface is re-verified per upgrade.

- [ ] **Step 2: AGENTS.md conventions**

Update/add in the Conventions section:
- The session-status bullet: pi never shows `waiting` (no permission/question surface); omp never shows `error` (no StopFailure event — interrupts settle as Stop); pi maps `session_shutdown` to SessionEnd for every reason (`/new` etc. re-register via the next start/late-join).
- The titles bullet: pi titles push via `session_info_changed` (`/name`); omp titles pull from the 256-byte title slot at the head of the session JSONL at the row's transcript_path, (mtime,size)-cached (append-only file).
- A new shim bullet: the pi/omp shims (`extensions/{pi,omp}/stream-deck-agents.ts`) are dependency-free structural host files that spawn the helper detached; wire payloads carry only canonical event names + allowlisted keys, omit-don't-null; the installer substitutes the `__STREAM_DECK_AGENTS_EXECUTABLE__` token, writes atomically at 0600, and refuses to overwrite files without the managed marker.

- [ ] **Step 3: Verify and commit**

Run: `bun run typecheck && bun run lint && bun test` — then read both edited docs end-to-end for contradictions with the shipped shims (event names, paths, gaps).

```bash
git add docs/hook-configuration.md AGENTS.md
git commit -m "docs: pi/omp shim sections and conventions"
```

---

### Task 6: Live verification — pi + omp (deploy + probes)

**Files:**
- Create: `docs/verification/<run-date>-pi-omp-p2.md` (dated record; use the actual run date from `date +%F`)

**Interfaces:**
- Consumes: everything above, deployed.
- Produces: the verification record, including the pi agent_settled phase-gate answer.

**This task restarts the user's daemon and plugin and installs into `~/.pi` / `~/.omp`. Ask the user for go-ahead before Step 1.**

- [ ] **Step 1: Deploy**

Run `bun scripts/install-local.ts` from the worktree. Assert in the output: both shim install lines (or the correct skip note if a provider dir is absent), and verify on disk: `~/.pi/agent/extensions/stream-deck-agents.ts` and `~/.omp/agent/extensions/stream-deck-agents.ts` start with the managed marker, contain the substituted executable path (not the token), and are mode 0600. Existing claude/codex/kimi/zcode tiles must keep working after the restart (check `sessions list` shows the surviving rows).

- [ ] **Step 2: pi probes**

Drive the installed pi (`pi --version` first — record the build). Record each probe's method and observed result:

1. New TUI session → tile appears with the PI chip.
2. Prompt → working; turn end → idle.
3. `/name <something>` mid-session → tile retitles.
4. `/new` → old row gone, new row present.
5. A failing turn (e.g. cancel an API call or force an error) → error tile **and it stays** (the latch works).
6. `pi -p "…"` (print mode) and a subagent run → no ghost tiles.
7. **Phase gate:** Escape-abort mid-turn → does the tile reach idle? This answers whether pi fires `agent_settled` after an Escape abort. If not, the tile sticks on working until the next event — record the observed answer plainly (the docs claim only what was observed).

- [ ] **Step 3: omp probes**

Drive the installed omp (record the version — expect a recent one):

1. New session → tile appears with the OM chip.
2. An approval-prompting action → waiting; answer it → working/idle; **the approval UX is unchanged** (observe-only handler confirmed live).
3. An `ask`-tool question → waiting.
4. A subagent run → descendant badge on the parent tile with correct parentage; watch for a double-registered or orphaned top-level child tile (the race probe — run it a couple of times).
5. Auto-title: after the first exchange, the tile picks up omp's generated title within a few seconds.
6. Switch sessions mid-process → subagent rows parent to the visible session.
7. Interrupt a turn → tile settles idle (Stop); quitting omp → row removed (SessionEnd).

- [ ] **Step 4: Record and commit**

Write the dated verification file: builds probed, per-probe method + observed result, divergences (each with a follow-up note), and anything not automatable (recorded as such, never assumed). If a probe contradicts the user docs, fix the docs in the same commit and note it.

```bash
git add docs/verification/<run-date>-pi-omp-p2.md
git commit -m "docs(verification): pi/omp P2 live probes"
```

---

## Self-review notes (controller)

- Spec coverage: §pi → Tasks 1, 5, 6 (template, mapping, latch, ghost filter, payload, interrupt probe, titles push, gaps); §omp → Tasks 2, 3, 5, 6 (template, parity probe, approval observe-only, session_switch identity, subagent lifecycle + namespace separation, titles pull + fixture, gaps); §Install → Task 4 (token, markers, atomic 0600, gating, ordering, header text); §Build gate → Task 1; §Docs pi/omp parts → Task 5; §Testing shim harness → Tasks 1-2 (mapping, ghost, latch both orderings, session_switch refresh, omit-don't-null, race orderings via the bus tests); §Physical verification pi/omp bullets → Task 6.
- Deferred from spec scope (explicitly out): pi subagent rows, background arming, dsh (P3), tile activation bindings.
- Type consistency: `SpawnPort`, `createExtension(host, spawnPort?)`, `PiHost`/`OmpHost` (on + getSessionName / events.on), `PiContext`/`OmpContext`, `TOOL_EVENTS`, `OMP_SLOT_BYTES`, `readHead`, `SHIM_MARKER`/`SHIM_TARGETS` are used identically across tasks and tests.
- Known soft spots by design: pi/omp payload accessor paths and omp tool-event parity are live-pinned at implementation (Tasks 1-2 report the installed reality); the omp slot framing is fixture-pinned (Task 3 Step 1). Each is a one-line/one-function correction point.
