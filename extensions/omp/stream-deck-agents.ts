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
 * the installed omp package (verified: @oh-my-pi/pi-coding-agent 17.3.4
 * carries pi's tool_execution_start/end with the same payloads). Prefer pi's
 * fork-parity pair; fall back to tool_call/tool_result (both handler bodies
 * stay fully try/caught — those events are fail-closed on throw). Exported
 * so the harness fires the same pair instead of hardcoding it.
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
const normalizeToolName = (name: string | undefined): string | undefined => (name === "ask" ? "AskUserQuestion" : name);

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
    // Fail-safe disarm: clear FIRST, before any potentially throwing
    // operation, so a getter that throws mid-refresh can never leave the
    // previous session's identity armed for the ctx-less bus handler.
    current = undefined;
    // Reject non-true hasUI before touching the session manager (an absent
    // hasUI reads headless — conservative, and the installed types say the
    // field is a required boolean on every event's ctx).
    if (ctx.hasUI !== true) {
      return;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionId !== undefined && sessionFile !== undefined) {
      current = { sessionId, sessionFile };
    }
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

  // Verified 2026-08-15 against omp 17.3.4: session_shutdown is process-exit
  // only; session switches fire session_switch instead (handled above).
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
      // Live-pinned against omp 17.3.4 (src/task/types.ts
      // SubagentLifecyclePayload): the phase field is `status` and the agent
      // name field is `agent` — the brief's `phase`/`agent_name` spellings do
      // not exist in any installed build (17.2.11 and 17.3.4 agree).
      const status = readString(payload, "status");
      if (status === "started") {
        // The payload id is an agent/registry identity, NOT a session-manager
        // session id — the two namespaces never mix on the wire (agent_id).
        const agentName = readString(payload, "agent");
        emit({
          hook_event_name: "SubagentStart",
          session_id: current.sessionId,
          agent_id: childId,
          cwd: process.cwd(),
          ...(agentName === undefined ? {} : { agent_type: agentName }),
        });
      } else if (status === "completed" || status === "failed" || status === "aborted") {
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
