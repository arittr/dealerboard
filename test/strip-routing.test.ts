import { describe, expect, test } from "bun:test";
import { routeForSession } from "../app/src/routing";
import type { ProjectedSession } from "../src/protocol";

const session = (overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: "session-1",
  status: "idle",
  title: "A session",
  project: "stream-deck-agents",
  descendantCount: 0,
  logicalSlot: 1,
  ghosttyTerminalId: null,
  model: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  unreadSince: null,
  statusSince: null,
  activityLine: null,
  transcriptPath: null,
  originParentRef: null,
  ...overrides,
});

describe("routeForSession", () => {
  test("a paseo origin with a ref routes to paseo regardless of provider", () => {
    expect(routeForSession(session({ provider: "claude", originKind: "paseo", originRef: "agent-42" }))).toEqual({
      kind: "paseo",
      agentId: "agent-42",
    });
  });

  test("a paseo origin without a ref falls through to provider routing", () => {
    expect(routeForSession(session({ provider: "codex", originKind: "paseo", originRef: null }))).toEqual({
      kind: "url",
      url: "codex://threads/session-1",
    });
  });

  test("claude with a ghostty terminal routes to ghostty focus", () => {
    expect(routeForSession(session({ provider: "claude", ghosttyTerminalId: "term-9" }))).toEqual({
      kind: "ghostty",
      terminalId: "term-9",
    });
  });

  test("claude without a ghostty terminal flashes", () => {
    expect(routeForSession(session({ provider: "claude" }))).toEqual({ kind: "flash" });
  });

  test("codex routes to its thread deep link, url-encoded", () => {
    expect(routeForSession(session({ provider: "codex", sessionId: "thread 7" }))).toEqual({
      kind: "url",
      url: "codex://threads/thread%207",
    });
  });

  test("kimi routes to the local kimi web session url", () => {
    expect(routeForSession(session({ provider: "kimi" }))).toEqual({
      kind: "url",
      url: "http://127.0.0.1:58627/sessions/session-1",
    });
  });

  test("providers without an activation binding flash", () => {
    for (const provider of ["pi", "omp", "zcode", "deepseek", "grok"] as const) {
      expect(routeForSession(session({ provider }))).toEqual({ kind: "flash" });
    }
  });
});
