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

/** Live-pinned accessor: agent_end carries no top-level stop reason — the final
 * AssistantMessage's stopReason does ("stop" clean, "error" failed; "aborted"
 * is a user interrupt, not a failure). Verified against pi 0.84.2. */
const readStopReason = (event: unknown): string | undefined => {
  const messages = asRecord(event)["messages"];
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const stopReason = asRecord(messages[messages.length - 1])["stopReason"];
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
