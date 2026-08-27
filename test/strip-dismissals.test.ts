import { describe, expect, test } from "bun:test";
import { createDismissals, DISMISS_TTL_MS, flickRemoves } from "../app/src/dismissals";
import type { ProjectedAgentNode, ProjectedSession, SessionSnapshotV2 } from "../src/protocol";

const session = (sessionId: string, overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId,
  project: null,
  title: sessionId,
  model: null,
  status: "working",
  originKind: null,
  originRef: null,
  originSubagent: false,
  unreadSince: null,
  statusSince: null,
  activityLine: null,
  transcriptPath: null,
  originParentRef: null,
  ghosttyTerminalId: null,
  descendantCount: 0,
  logicalSlot: 1,
  lastEventAt: null,
  ...overrides,
});

const node = (sessionId: string, overrides: Partial<ProjectedAgentNode> = {}): ProjectedAgentNode => ({
  provider: "claude",
  sessionId,
  role: "primary",
  lineage: null,
  parent: null,
  status: "working",
  title: sessionId,
  project: null,
  model: null,
  openedAt: "2026-08-26T05:00:00.000Z",
  statusSince: null,
  activityLine: null,
  unreadSince: null,
  logicalSlot: 1,
  ghosttyTerminalId: null,
  transcriptPath: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  originParentRef: null,
  lastEventAt: null,
  ...overrides,
});

const snapshot = (sessions: ProjectedSession[], agents: ProjectedAgentNode[] | null = null): SessionSnapshotV2 => ({
  schemaVersion: 2,
  health: { status: "ok" },
  sessions,
  agents,
});

describe("flickRemoves", () => {
  test("an error slat is removable: ack retires the failure", () => {
    expect(flickRemoves(session("s1", { status: "error" }))).toBe(true);
  });

  test("an idle unread slat is removable: ack takes it off the board", () => {
    expect(flickRemoves(session("s1", { status: "idle", unreadSince: "2026-08-26T05:00:00.000Z" }))).toBe(true);
  });

  test("a live slat is not removable, unread or not", () => {
    expect(flickRemoves(session("s1", { status: "working" }))).toBe(false);
    expect(flickRemoves(session("s1", { status: "working", unreadSince: "2026-08-26T05:00:00.000Z" }))).toBe(false);
    expect(flickRemoves(session("s1", { status: "waiting" }))).toBe(false);
  });
});

describe("createDismissals", () => {
  test("an untouched snapshot passes through by identity", () => {
    const dismissals = createDismissals();
    const input = snapshot([session("s1")]);
    expect(dismissals.filterSnapshot(input, 0)).toBe(input);
  });

  test("a dismissed identity is hidden from both the session list and the agent graph", () => {
    const dismissals = createDismissals();
    dismissals.dismiss("claude", "s2", 0);
    const filtered = dismissals.filterSnapshot(snapshot([session("s1"), session("s2")], [node("s1"), node("s2")]), 100);
    expect(filtered.sessions.map((entry) => entry.sessionId)).toEqual(["s1"]);
    expect(filtered.agents?.map((entry) => entry.sessionId)).toEqual(["s1"]);
  });

  test("a dismissed node's descendants are hidden with it", () => {
    const dismissals = createDismissals();
    dismissals.dismiss("claude", "s2", 0);
    const agents = [
      node("s1"),
      node("s2", { role: "subagent", lineage: "paseo", parent: { provider: "claude", sessionId: "s1" } }),
      node("s3", { role: "subagent", lineage: "native", parent: { provider: "claude", sessionId: "s2" } }),
    ];
    const filtered = dismissals.filterSnapshot(snapshot([session("s1")], agents), 100);
    expect(filtered.agents?.map((entry) => entry.sessionId)).toEqual(["s1"]);
  });

  test("a dismissal expires: the card returns when the registry did not settle it", () => {
    const dismissals = createDismissals();
    dismissals.dismiss("claude", "s1", 0);
    const input = snapshot([session("s1", { status: "error" })]);
    expect(dismissals.filterSnapshot(input, DISMISS_TTL_MS - 1).sessions).toEqual([]);
    expect(dismissals.filterSnapshot(input, DISMISS_TTL_MS).sessions.map((entry) => entry.sessionId)).toEqual(["s1"]);
  });

  test("providers never collide on a shared session id", () => {
    const dismissals = createDismissals();
    dismissals.dismiss("qwen", "shared", 0);
    const filtered = dismissals.filterSnapshot(
      snapshot([session("shared"), session("shared", { provider: "qwen" })]),
      100,
    );
    expect(filtered.sessions.map((entry) => entry.provider)).toEqual(["claude"]);
  });
});
