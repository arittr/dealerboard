import { describe, expect, test } from "bun:test";
import {
  countUnreadSessions,
  msUntilStale,
  reduceSnapshotRead,
  type SnapshotRead,
  STALE_SNAPSHOT_AGE_MS,
} from "../app/src/snapshot-view";
import type { ProjectedAgentNode, ProjectedSession, SessionSnapshotV2 } from "../src/protocol";

const healthy = (
  sessions: SessionSnapshotV2["sessions"] = [],
  agents: SessionSnapshotV2["agents"] = null,
): SessionSnapshotV2 => ({
  schemaVersion: 2,
  health: { status: "ok" },
  sessions,
  agents,
});

const readOf = (mtimeMs: number, value: unknown): SnapshotRead => {
  if (typeof value === "object" && value !== null && "agents" in value && value["agents"] === null) {
    const { agents: _agents, ...raw } = value as SessionSnapshotV2;
    return { mtimeMs, contents: JSON.stringify(raw) };
  }
  return { mtimeMs, contents: JSON.stringify(value) };
};

const NOW = 100_000;
const FRESH = NOW - 5_000;

describe("reduceSnapshotRead", () => {
  test("a fresh healthy read renders live and becomes last-good", () => {
    const result = reduceSnapshotRead(readOf(FRESH, healthy()), null, NOW);
    expect(result.view.degraded).toBe(false);
    expect(result.lastGood).not.toBeNull();
  });

  test("a stale read degrades and keeps the last-good snapshot", () => {
    const primed = reduceSnapshotRead(readOf(FRESH, healthy()), null, NOW);
    const lastGood = primed.lastGood;
    if (lastGood === null) {
      throw new Error("expected a fresh healthy read to become last-good");
    }
    const stale = reduceSnapshotRead(readOf(NOW - 5_000, healthy()), lastGood, NOW + 20_000);
    expect(stale.view.degraded).toBe(true);
    expect(stale.view.snapshot).toBe(lastGood);
    expect(stale.lastGood).toBe(lastGood);
  });

  test("a staleness boundary at exactly the threshold is not stale", () => {
    const result = reduceSnapshotRead(readOf(FRESH, healthy()), null, FRESH + 10_000);
    expect(result.view.degraded).toBe(false);
  });

  test("a missing read with no last-good degrades to the empty snapshot", () => {
    const result = reduceSnapshotRead(null, null, NOW);
    expect(result.view.degraded).toBe(true);
    expect(result.view.snapshot.sessions).toHaveLength(0);
    expect(result.view.snapshot.health.status).toBe("error");
  });

  test("an unparseable read degrades and keeps last-good", () => {
    const primed = reduceSnapshotRead(readOf(FRESH, healthy()), null, NOW);
    const result = reduceSnapshotRead({ mtimeMs: FRESH, contents: "{not json" }, primed.lastGood, NOW);
    expect(result.view.degraded).toBe(true);
    expect(result.lastGood).not.toBeNull();
  });

  test("an explicitly unhealthy snapshot never becomes last-good", () => {
    const primed = reduceSnapshotRead(readOf(FRESH, healthy()), null, NOW);
    const lastGood = primed.lastGood;
    if (lastGood === null) {
      throw new Error("expected a fresh healthy read to become last-good");
    }
    const unhealthy = { schemaVersion: 2, health: { status: "error", message: "boom" }, sessions: [] };
    const result = reduceSnapshotRead(readOf(FRESH, unhealthy), lastGood, NOW);
    expect(result.view.degraded).toBe(true);
    expect(result.view.snapshot).toBe(lastGood);
  });

  test("a cyclic graph degrades to the exact last-good snapshot", () => {
    const primed = reduceSnapshotRead(readOf(FRESH, healthy()), null, NOW);
    const lastGood = primed.lastGood;
    if (lastGood === null) {
      throw new Error("expected a fresh healthy read to become last-good");
    }
    const cycle: ProjectedAgentNode[] = [
      {
        provider: "claude",
        sessionId: "a",
        role: "subagent",
        lineage: "native",
        parent: { provider: "claude", sessionId: "b" },
        status: "working",
        title: null,
        project: null,
        model: null,
        openedAt: "2026-08-26T05:00:00.000Z",
        statusSince: null,
        activityLine: null,
        unreadSince: null,
        logicalSlot: null,
        ghosttyTerminalId: null,
        transcriptPath: null,
        originKind: null,
        originRef: null,
        originSubagent: false,
        originParentRef: null,
      },
      {
        provider: "claude",
        sessionId: "b",
        role: "subagent",
        lineage: "native",
        parent: { provider: "claude", sessionId: "a" },
        status: "working",
        title: null,
        project: null,
        model: null,
        openedAt: "2026-08-26T05:00:00.000Z",
        statusSince: null,
        activityLine: null,
        unreadSince: null,
        logicalSlot: null,
        ghosttyTerminalId: null,
        transcriptPath: null,
        originKind: null,
        originRef: null,
        originSubagent: false,
        originParentRef: null,
      },
    ];
    const result = reduceSnapshotRead(readOf(FRESH, healthy([], cycle)), lastGood, NOW);
    expect(result.view.degraded).toBe(true);
    expect(result.view.snapshot).toBe(lastGood);
    expect(result.lastGood).toBe(lastGood);
  });
});

const session = (overrides: Partial<ProjectedSession>): ProjectedSession => ({
  provider: "claude",
  sessionId: "s1",
  status: "idle",
  title: null,
  project: null,
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

describe("msUntilStale", () => {
  test("a fresh read expires exactly one staleness threshold later", () => {
    expect(msUntilStale(readOf(FRESH, healthy()), NOW)).toBe(5_000);
    expect(msUntilStale(readOf(NOW, healthy()), NOW)).toBe(STALE_SNAPSHOT_AGE_MS);
  });

  test("a read at or past the threshold checks immediately, never negatively", () => {
    // At-threshold is still healthy (the reducer's staleness test is strict),
    // so the clamped zero just re-arms one macrotask later.
    expect(msUntilStale(readOf(FRESH, healthy()), FRESH + STALE_SNAPSHOT_AGE_MS)).toBe(0);
    expect(msUntilStale(readOf(FRESH, healthy()), FRESH + STALE_SNAPSHOT_AGE_MS + 1)).toBe(0);
    expect(msUntilStale(readOf(FRESH, healthy()), FRESH + 60_000)).toBe(0);
  });

  test("no payload never expires", () => {
    expect(msUntilStale(null, NOW)).toBeNull();
  });

  test("expiry and the reducer agree: a zero delay means the next tick degrades", () => {
    const read = readOf(FRESH, healthy());
    const expiry = FRESH + STALE_SNAPSHOT_AGE_MS;
    expect(msUntilStale(read, expiry)).toBe(0);
    // The scheduled check runs no earlier than the expiry instant — by then
    // the strictly-greater test holds, so the re-read renders degraded.
    expect(reduceSnapshotRead(read, null, expiry + 1).view.degraded).toBe(true);
  });
});

describe("countUnreadSessions", () => {
  test("counts exactly the sessions carrying an unread stamp", () => {
    const snapshot = healthy([
      session({ sessionId: "idle-unread", unreadSince: "2026-08-19T00:00:00.000Z" }),
      session({
        sessionId: "working-unread",
        status: "working",
        unreadSince: "2026-08-19T00:01:00.000Z",
        logicalSlot: 2,
      }),
      session({ sessionId: "idle-read", logicalSlot: 3 }),
      session({ sessionId: "error-read", status: "error", logicalSlot: 4 }),
    ]);
    // The old approximation (on-grid idle+error) would count 3; the ledger counts 2.
    expect(countUnreadSessions(snapshot)).toBe(2);
  });

  test("an empty or unread-free snapshot counts zero", () => {
    expect(countUnreadSessions(healthy())).toBe(0);
    expect(countUnreadSessions(healthy([session({})]))).toBe(0);
  });

  test("does not count native graph nodes", () => {
    const native: ProjectedAgentNode = {
      provider: "claude",
      sessionId: "native",
      role: "subagent",
      lineage: "native",
      parent: { provider: "claude", sessionId: "root" },
      status: "idle",
      title: null,
      project: null,
      model: null,
      openedAt: "2026-08-26T05:00:00.000Z",
      statusSince: null,
      activityLine: null,
      unreadSince: null,
      logicalSlot: null,
      ghosttyTerminalId: null,
      transcriptPath: null,
      originKind: null,
      originRef: null,
      originSubagent: false,
      originParentRef: null,
    };
    expect(countUnreadSessions(healthy([session({ unreadSince: "2026-08-26T05:00:00.000Z" })], [native]))).toBe(1);
  });
});
