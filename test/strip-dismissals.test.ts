import { describe, expect, test } from "bun:test";
import type { GestureWatermark } from "../app/src/bridge";
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
  doneSince: null,
  pendingResults: 0,
  endedAt: null,
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
  doneSince: null,
  pendingResults: 0,
  endedAt: null,
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

/** The flick's pointer-down watermark: the stamp the card showed when the gesture began. */
const seen = (unreadSince: string | null = null): GestureWatermark => ({ unreadSince });

describe("flickRemoves", () => {
  test("an error slat is removable: ack retires the failure", () => {
    expect(flickRemoves(session("s1", { status: "error" }))).toBe(true);
  });

  test("an idle unread slat is removable: ack takes it off the board", () => {
    expect(flickRemoves(session("s1", { status: "idle", unreadSince: "2026-08-26T05:00:00.000Z" }))).toBe(true);
  });

  test("a done-and-read idle slat is removable: the done card persists until this gesture", () => {
    expect(flickRemoves(session("s1", { status: "idle", doneSince: "2026-08-26T05:00:00.000Z" }))).toBe(true);
  });

  test("an idle slat with neither stamp is not removable (nothing for the ack to settle)", () => {
    expect(flickRemoves(session("s1", { status: "idle" }))).toBe(false);
  });

  test("a live slat is not removable, unread or not", () => {
    expect(flickRemoves(session("s1", { status: "working" }))).toBe(false);
    expect(flickRemoves(session("s1", { status: "working", unreadSince: "2026-08-26T05:00:00.000Z" }))).toBe(false);
    expect(flickRemoves(session("s1", { status: "waiting" }))).toBe(false);
  });

  test("an active card with a stale unread badge is still not flickable (regression pin)", () => {
    expect(flickRemoves(session("s1", { status: "working", unreadSince: "2026-08-26T05:00:00.000Z" }))).toBe(false);
    expect(flickRemoves(session("s1", { status: "waiting", doneSince: "2026-08-26T05:00:00.000Z" }))).toBe(false);
  });

  test("an ended card holding a result is flickable (regression pin)", () => {
    expect(
      flickRemoves(
        session("s1", {
          status: "idle",
          doneSince: "2026-08-26T05:00:00.000Z",
          endedAt: "2026-08-26T06:00:00.000Z",
        }),
      ),
    ).toBe(true);
  });

  test("a roll-up-held parent is flickable via its aggregated done stamp (regression pin)", () => {
    // Task 9 publishes the descendant's done as the parent's doneSince; the
    // app cannot and need not tell the difference.
    expect(
      flickRemoves(session("s1", { status: "idle", doneSince: "2026-08-26T05:00:00.000Z", pendingResults: 0 })),
    ).toBe(true);
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
    dismissals.dismiss("claude", "s2", 0, seen());
    const filtered = dismissals.filterSnapshot(snapshot([session("s1"), session("s2")], [node("s1"), node("s2")]), 100);
    expect(filtered.sessions.map((entry) => entry.sessionId)).toEqual(["s1"]);
    expect(filtered.agents?.map((entry) => entry.sessionId)).toEqual(["s1"]);
  });

  test("a dismissed node's descendants are hidden with it", () => {
    const dismissals = createDismissals();
    dismissals.dismiss("claude", "s2", 0, seen());
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
    dismissals.dismiss("claude", "s1", 0, seen());
    const input = snapshot([session("s1", { status: "error" })]);
    expect(dismissals.filterSnapshot(input, DISMISS_TTL_MS - 1).sessions).toEqual([]);
    expect(dismissals.filterSnapshot(input, DISMISS_TTL_MS).sessions.map((entry) => entry.sessionId)).toEqual(["s1"]);
  });

  test("providers never collide on a shared session id", () => {
    const dismissals = createDismissals();
    dismissals.dismiss("qwen", "shared", 0, seen());
    const filtered = dismissals.filterSnapshot(
      snapshot([session("shared"), session("shared", { provider: "qwen" })]),
      100,
    );
    expect(filtered.sessions.map((entry) => entry.provider)).toEqual(["claude"]);
  });
});

describe("a causally rejected flick", () => {
  const AT_5 = "2026-08-26T05:00:00.000Z";
  const AT_9 = "2026-08-26T05:09:00.000Z";

  test("returns the card at once when a snapshot shows a result newer than the flick's watermark", () => {
    // The flick consumed at(5); a result at(9) landed in transit, so the
    // registry protected it and refused the ack. The next snapshot shows the
    // newer badge: the local hide ends immediately, badged — not after 5s.
    const dismissals = createDismissals();
    dismissals.dismiss("claude", "s1", 0, seen(AT_5));
    const surfaced = snapshot([session("s1", { status: "idle", unreadSince: AT_9 })]);
    expect(dismissals.filterSnapshot(surfaced, 100).sessions.map((entry) => entry.sessionId)).toEqual(["s1"]);
    // The cancellation sticks: a later snapshot is not re-hidden by the old entry.
    const later = snapshot([session("s1", { status: "idle", unreadSince: null })]);
    expect(dismissals.filterSnapshot(later, 200).sessions.map((entry) => entry.sessionId)).toEqual(["s1"]);
  });

  test("keeps the hide for the TTL while nothing newer than the watermark shows", () => {
    const dismissals = createDismissals();
    dismissals.dismiss("claude", "s1", 0, seen(AT_5));
    // The ack is still in flight: the snapshot shows the very stamp the
    // flick consumed. Then it settles: no stamp at all. Hidden throughout.
    const inFlight = snapshot([session("s1", { status: "idle", unreadSince: AT_5 })]);
    expect(dismissals.filterSnapshot(inFlight, 100).sessions).toEqual([]);
    const settled = snapshot([session("s1", { status: "idle", unreadSince: null })]);
    expect(dismissals.filterSnapshot(settled, DISMISS_TTL_MS - 1).sessions).toEqual([]);
    expect(dismissals.filterSnapshot(settled, DISMISS_TTL_MS).sessions.map((entry) => entry.sessionId)).toEqual(["s1"]);
  });

  test("a null-stamp watermark (no badge at press) is cancelled by any result that lands after", () => {
    const dismissals = createDismissals();
    dismissals.dismiss("claude", "s1", 0, seen(null));
    const surfaced = snapshot([session("s1", { status: "idle", unreadSince: AT_9 })]);
    expect(dismissals.filterSnapshot(surfaced, 100).sessions.map((entry) => entry.sessionId)).toEqual(["s1"]);
  });

  test("a newer result on the identity's agent node cancels the hide too", () => {
    // A subagent card lives in the agent graph only; its own newer stamp is
    // the signal that its dismissal was refused.
    const dismissals = createDismissals();
    dismissals.dismiss("claude", "s2", 0, seen(AT_5));
    const agents = [
      node("s1"),
      node("s2", {
        role: "subagent",
        lineage: "paseo",
        parent: { provider: "claude", sessionId: "s1" },
        status: "idle",
        unreadSince: AT_9,
      }),
    ];
    const filtered = dismissals.filterSnapshot(snapshot([session("s1")], agents), 100);
    expect(filtered.agents?.map((entry) => entry.sessionId)).toEqual(["s1", "s2"]);
  });
});
