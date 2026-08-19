import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths } from "../src/core/paths";
import { ProjectionError, type ProjectionRow, projectRows, readProjection } from "../src/core/projection";
import { applyRegistryEvents } from "../src/core/registry";
import { initializeDatabase, openRegistryDatabase } from "../src/core/schema";
import { writeSnapshotAtomically } from "../src/core/snapshot";
import {
  type Provider,
  parseSessionSnapshot,
  type SessionOriginKind,
  type SessionSnapshotV2,
  type SessionStatus,
} from "../src/protocol";

const row = (
  sessionId: string,
  options: {
    provider?: Provider;
    parent?: string | null;
    status?: SessionStatus;
    title?: string | null;
    project?: string | null;
    slot?: number | null;
    ghosttyTerminalId?: string | null;
    originKind?: SessionOriginKind | null;
    originRef?: string | null;
    originSubagent?: number;
    unreadSince?: string | null;
    statusSince?: string | null;
    activityLine?: string | null;
    transcriptPath?: string | null;
    originParentRef?: string | null;
  } = {},
): ProjectionRow => {
  const parent = options.parent ?? null;
  return {
    provider: options.provider ?? "claude",
    sessionId,
    parentSessionId: parent,
    status: options.status ?? "idle",
    title: options.title ?? null,
    project: options.project ?? null,
    logicalSlot: options.slot === undefined ? (parent === null ? 1 : null) : options.slot,
    ghosttyTerminalId: options.ghosttyTerminalId ?? null,
    model: null,
    originKind: options.originKind ?? null,
    originRef: options.originRef ?? null,
    originSubagent: options.originSubagent ?? 0,
    // Unread by default so idle roots stay visible; tests exercising the
    // visibility filter pass null explicitly (a `??` default would swallow it).
    unreadSince: options.unreadSince === undefined ? "2026-08-16T00:00:00.000Z" : options.unreadSince,
    statusSince: options.statusSince ?? null,
    activityLine: options.activityLine ?? null,
    transcriptPath: options.transcriptPath ?? null,
    originParentRef: options.originParentRef ?? null,
  };
};

const projectionErrorCode = (rows: ProjectionRow[]): string => {
  try {
    projectRows(rows);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectionError);
    return (error as ProjectionError).code;
  }
  throw new Error("expected projectRows to throw ProjectionError");
};

describe("projectRows", () => {
  test("returns only top-level rows ordered by stored logical slot, preserving gaps", () => {
    const sessions = projectRows([
      row("a", { slot: 3 }),
      row("b", { slot: 1 }),
      row("c", { parent: "a" }),
      row("d", { slot: 7 }),
      row("e", { parent: "c" }),
    ]);

    expect(sessions.map((session) => session.sessionId)).toEqual(["b", "a", "d"]);
    expect(sessions.map((session) => session.logicalSlot)).toEqual([1, 3, 7]);
  });

  test("counts the full nested subtree as descendants and keeps root metadata", () => {
    const sessions = projectRows([
      row("p", { slot: 2, title: "Parent", project: "proj" }),
      row("c1", { parent: "p" }),
      row("g1", { parent: "c1" }),
      row("c2", { parent: "p" }),
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      provider: "claude",
      sessionId: "p",
      // Live descendants lift an idle root to working.
      status: "working",
      title: "Parent",
      project: "proj",
      descendantCount: 3,
      logicalSlot: 2,
      ghosttyTerminalId: null,
      model: null,
      originKind: null,
      originRef: null,
      originSubagent: false,
      unreadSince: "2026-08-16T00:00:00.000Z",
      statusSince: null,
      activityLine: null,
      transcriptPath: null,
      originParentRef: null,
    });
  });

  test("lifts an idle root with live descendants to at least working", () => {
    const effective = (rows: ProjectionRow[]): SessionStatus | undefined => projectRows(rows)[0]?.status;

    // A descendant row exists only while its subagent runs, even if the child
    // never emits an Activity event of its own.
    expect(effective([row("p", { status: "idle" }), row("c", { parent: "p" })])).toBe("working");
    // The floor does not lower higher-priority statuses.
    expect(effective([row("p", { status: "waiting" }), row("c", { parent: "p", status: "idle" })])).toBe("waiting");
    // An idle root with no descendants stays idle.
    expect(effective([row("p", { status: "idle" })])).toBe("idle");
  });

  test("read-and-idle sessions are hidden; unread-idle, working, waiting, error stay visible", () => {
    const rows = [
      row("read-idle", { status: "idle", unreadSince: null, slot: 1 }),
      row("unread-idle", { status: "idle", unreadSince: "2026-08-16T00:00:00.000Z", slot: 2 }),
      row("busy", { status: "working", unreadSince: null, slot: 3 }),
      row("blocked", { status: "waiting", unreadSince: null, slot: 4 }),
      row("broken", { status: "error", unreadSince: null, slot: 5 }),
    ];
    expect(projectRows(rows).map((session) => session.sessionId)).toEqual(["unread-idle", "busy", "blocked", "broken"]);
  });

  test("a read-idle root with a live child is lifted to working and stays visible", () => {
    const sessions = projectRows([
      row("p", { status: "idle", unreadSince: null }),
      row("c", { parent: "p", status: "idle" }),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: "p", status: "working", descendantCount: 1 });
  });

  test("hidden roots' children still validate topology (no missing-parent error)", () => {
    // A live child lifts its root to working, so a hidden root is childless
    // by definition — but its subtree still counts toward the total-visited
    // reachability check: skipping traversal for hidden roots would flag the
    // leftover rows as a phantom cycle.
    const sessions = projectRows([
      row("hidden", { status: "idle", unreadSince: null, slot: 1 }),
      row("p", { status: "working", slot: 2 }),
      row("c", { parent: "p" }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["p"]);
    expect(sessions[0]?.descendantCount).toBe(1);
  });

  test("origin fields are projected", () => {
    const sessions = projectRows([
      row("s", { originKind: "paseo", originRef: "a1", originSubagent: 1, status: "working" }),
    ]);
    expect(sessions[0]).toMatchObject({ originKind: "paseo", originRef: "a1", originSubagent: true });
  });

  test("projects the data-surface fields from the root row", () => {
    const sessions = projectRows([
      row("s", {
        status: "working",
        unreadSince: "2026-08-19T00:02:00.000Z",
        statusSince: "2026-08-19T00:00:00.000Z",
        activityLine: "Bash git status",
        transcriptPath: "/t/s1.jsonl",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-0",
      }),
    ]);
    expect(sessions[0]).toMatchObject({
      unreadSince: "2026-08-19T00:02:00.000Z",
      statusSince: "2026-08-19T00:00:00.000Z",
      activityLine: "Bash git status",
      transcriptPath: "/t/s1.jsonl",
      originParentRef: "agent-0",
    });
  });

  test("an idle paseo subagent is hidden even when its result is unread", () => {
    // Subagent results are consumed by the orchestrating parent agent, so a
    // finished paseo subagent must not hold the grid as an unread tile.
    const sessions = projectRows([
      row("sub", {
        status: "idle",
        unreadSince: "2026-08-16T00:00:00.000Z",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        slot: 1,
      }),
    ]);
    expect(sessions).toEqual([]);
  });

  test("an active paseo subagent stays visible with its subagent mark", () => {
    for (const status of ["working", "waiting", "error"] as const) {
      const sessions = projectRows([
        row("sub", {
          status,
          unreadSince: null,
          originKind: "paseo",
          originRef: "agent-1",
          originSubagent: 1,
          slot: 1,
        }),
      ]);
      expect(sessions.map((session) => session.sessionId)).toEqual(["sub"]);
      expect(sessions[0]?.originSubagent).toBe(true);
    }
  });

  test("an idle paseo parent with an unread result stays visible", () => {
    const sessions = projectRows([
      row("parent", {
        status: "idle",
        unreadSince: "2026-08-16T00:00:00.000Z",
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["parent"]);
  });

  test("an idle paseo subagent with a live child is lifted to working and stays visible", () => {
    const sessions = projectRows([
      row("sub", {
        status: "idle",
        unreadSince: "2026-08-16T00:00:00.000Z",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        slot: 1,
      }),
      row("grandchild", { parent: "sub", status: "idle" }),
    ]);
    expect(sessions.map((session) => ({ id: session.sessionId, status: session.status }))).toEqual([
      { id: "sub", status: "working" },
    ]);
  });

  test("reduces effective status by error > waiting > working > idle across the subtree", () => {
    const effective = (rows: ProjectionRow[]): SessionStatus | undefined => projectRows(rows)[0]?.status;

    expect(effective([row("p", { status: "idle" })])).toBe("idle");
    expect(effective([row("p", { status: "idle" }), row("c", { parent: "p", status: "working" })])).toBe("working");
    expect(effective([row("p", { status: "working" }), row("c", { parent: "p", status: "waiting" })])).toBe("waiting");
    expect(
      effective([
        row("p", { status: "waiting" }),
        row("c", { parent: "p", status: "idle" }),
        row("g", { parent: "c", status: "error" }),
      ]),
    ).toBe("error");
  });

  test("keeps effective status and descendant counts independent between roots", () => {
    const sessions = projectRows([
      row("a", { slot: 1, status: "error" }),
      row("b", { slot: 2, status: "idle" }),
      row("c", { parent: "b", status: "working" }),
    ]);

    expect(sessions.map((session) => [session.sessionId, session.status])).toEqual([
      ["a", "error"],
      ["b", "working"],
    ]);
    expect(sessions.map((session) => session.descendantCount)).toEqual([0, 1]);
  });

  test("treats the same session id under different providers as distinct identities", () => {
    const sessions = projectRows([row("shared"), row("shared", { provider: "kimi", slot: 2 })]);

    expect(sessions.map((session) => [session.provider, session.sessionId])).toEqual([
      ["claude", "shared"],
      ["kimi", "shared"],
    ]);
  });

  test("projects an empty registry to an empty list", () => {
    expect(projectRows([])).toEqual([]);
  });

  test("publishes the exact nullable terminal target from a Claude root", () => {
    expect(projectRows([row("bound", { ghosttyTerminalId: "terminal-bound" })])[0]).toMatchObject({
      ghosttyTerminalId: "terminal-bound",
    });
    expect(projectRows([row("unbound")])[0]).toMatchObject({ ghosttyTerminalId: null });
  });

  test("rejects duplicate identities", () => {
    expect(projectionErrorCode([row("a"), row("a")])).toBe("duplicate-identity");
  });

  test("rejects a child whose parent is missing", () => {
    expect(projectionErrorCode([row("p"), row("c", { parent: "ghost" })])).toBe("missing-parent");
  });

  test("rejects a cross-provider parent edge", () => {
    expect(projectionErrorCode([row("p"), row("c", { provider: "kimi", parent: "p" })])).toBe("cross-provider-parent");
  });

  test("rejects cycles detached from any root and terminates", () => {
    // Self-cycle.
    expect(projectionErrorCode([row("a", { parent: "a" })])).toBe("cycle");
    // Two-node cycle.
    expect(projectionErrorCode([row("a", { parent: "b" }), row("b", { parent: "a" })])).toBe("cycle");
    // A long cycle terminates within the row-count bound instead of walking forever.
    const longCycle = Array.from({ length: 64 }, (_, index) => row(`n${index}`, { parent: `n${(index + 1) % 64}` }));
    expect(projectionErrorCode(longCycle)).toBe("cycle");
    // A cycle plus a healthy tree rejects the whole projection, never partial output.
    expect(projectionErrorCode([row("ok"), row("x", { parent: "y" }), row("y", { parent: "x" })])).toBe("cycle");
  });

  test("rejects a child row carrying a slot", () => {
    expect(projectionErrorCode([row("p"), row("c", { parent: "p", slot: 5 })])).toBe("child-with-slot");
  });

  test("rejects terminal targets on child and non-Claude rows", () => {
    expect(
      projectionErrorCode([row("parent"), row("child", { parent: "parent", ghosttyTerminalId: "terminal-child" })]),
    ).toBe("child-with-terminal-binding");
    expect(projectionErrorCode([row("codex", { provider: "codex", ghosttyTerminalId: "terminal-codex" })])).toBe(
      "non-claude-terminal-binding",
    );
  });

  test("rejects top-level rows without a positive slot", () => {
    expect(projectionErrorCode([row("a", { slot: null })])).toBe("top-level-without-positive-slot");
    expect(projectionErrorCode([row("a", { slot: 0 })])).toBe("top-level-without-positive-slot");
    expect(projectionErrorCode([row("a", { slot: -2 })])).toBe("top-level-without-positive-slot");
  });
});

describe("readProjection", () => {
  test("projects one consistent snapshot from a separately committed writer", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "stream-deck-agents-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);

      // The writer commits in its own transactions before the reader connects.
      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "parent",
            title: "Parent",
            project: "proj",
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-06T00:00:01.000Z",
          },
          {
            kind: "SubagentStart",
            provider: "claude",
            sessionId: "child",
            parentSessionId: "parent",
            title: null,
            project: null,
            observedAt: "2026-08-06T00:00:02.000Z",
          },
          {
            kind: "SubagentStart",
            provider: "claude",
            sessionId: "grandchild",
            parentSessionId: "child",
            title: null,
            project: null,
            observedAt: "2026-08-06T00:00:03.000Z",
          },
        ]);
        applyRegistryEvents(writer, [
          {
            kind: "Activity",
            provider: "claude",
            sessionId: "parent",
            observedAt: "2026-08-06T00:00:04.000Z",
          },
          {
            kind: "Attention",
            provider: "claude",
            sessionId: "child",
            observedAt: "2026-08-06T00:00:05.000Z",
          },
          {
            kind: "StopFailure",
            provider: "claude",
            sessionId: "grandchild",
            observedAt: "2026-08-06T00:00:06.000Z",
          },
        ]);
      } finally {
        writer.close();
      }

      // The daemon's read side: a strictly read-only connection.
      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        const snapshot = readProjection(reader);
        expect(snapshot.schemaVersion).toBe(2);
        expect(snapshot.health).toEqual({ status: "ok" });
        expect(snapshot.sessions).toEqual([
          {
            provider: "claude",
            sessionId: "parent",
            status: "error",
            title: "Parent",
            project: "proj",
            descendantCount: 2,
            logicalSlot: 1,
            ghosttyTerminalId: null,
            model: null,
            originKind: null,
            originRef: null,
            originSubagent: false,
            unreadSince: null,
            statusSince: "2026-08-06T00:00:04.000Z",
            activityLine: null,
            transcriptPath: null,
            originParentRef: null,
          },
        ]);
        // The snapshot satisfies the published v2 contract.
        expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("projects the widened provider set end to end (grid-blackout regression)", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "stream-deck-agents-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);

      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "pi",
            sessionId: "p1",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-06T00:00:01.000Z",
          },
          {
            kind: "SessionStart",
            provider: "omp",
            sessionId: "o1",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-06T00:00:02.000Z",
          },
          {
            kind: "SubagentStart",
            provider: "omp",
            sessionId: "o1c",
            parentSessionId: "o1",
            title: null,
            project: null,
            observedAt: "2026-08-06T00:00:03.000Z",
          },
          {
            kind: "SessionStart",
            provider: "zcode",
            sessionId: "z1",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-06T00:00:04.000Z",
          },
          {
            kind: "SessionStart",
            provider: "deepseek",
            sessionId: "d1",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-06T00:00:05.000Z",
          },
          {
            kind: "SessionStart",
            provider: "grok",
            sessionId: "g1",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-06T00:00:05.500Z",
          },
          // The projection hides read-and-idle sessions, so p1/z1/d1/g1 must
          // land an unread result to stay visible; o1 is lifted by its live
          // child either way.
          {
            kind: "Stop",
            provider: "pi",
            sessionId: "p1",
            observedAt: "2026-08-06T00:00:06.000Z",
          },
          {
            kind: "Stop",
            provider: "zcode",
            sessionId: "z1",
            observedAt: "2026-08-06T00:00:07.000Z",
          },
          {
            kind: "Stop",
            provider: "deepseek",
            sessionId: "d1",
            observedAt: "2026-08-06T00:00:08.000Z",
          },
          {
            kind: "Stop",
            provider: "grok",
            sessionId: "g1",
            observedAt: "2026-08-06T00:00:08.500Z",
          },
        ]);
      } finally {
        writer.close();
      }

      // The daemon's read side: a strictly read-only connection.
      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        const snapshot = readProjection(reader);
        expect(snapshot.sessions.map((session) => session.provider)).toEqual([
          "pi",
          "omp",
          "zcode",
          "deepseek",
          "grok",
        ]);
        expect(snapshot.sessions[1]?.descendantCount).toBe(1);
        expect(snapshot.sessions[1]?.status).toBe("working"); // live child lifts the tree
        expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("carries the stored model through to the snapshot", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "stream-deck-agents-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);

      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "kimi",
            sessionId: "with-model",
            title: "Titled",
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-06T00:00:01.000Z",
          },
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "without-model",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-06T00:00:02.000Z",
          },
          // The projection hides read-and-idle sessions; a Stop lands an
          // unread result so both stay visible.
          {
            kind: "Stop",
            provider: "kimi",
            sessionId: "with-model",
            observedAt: "2026-08-06T00:00:03.000Z",
          },
          {
            kind: "Stop",
            provider: "claude",
            sessionId: "without-model",
            observedAt: "2026-08-06T00:00:04.000Z",
          },
        ]);
        // Registry model storage lands in a later task; set the column directly.
        writer.run("UPDATE active_sessions SET model = 'k3' WHERE provider = 'kimi' AND session_id = 'with-model'");
      } finally {
        writer.close();
      }

      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        const snapshot = readProjection(reader);
        expect(snapshot.sessions.map((session) => [session.sessionId, session.model])).toEqual([
          ["with-model", "k3"],
          ["without-model", null],
        ]);
        expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("carries the data-surface columns through to the snapshot end to end", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "stream-deck-agents-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);

      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "s1",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: "/transcripts/s1.jsonl",
            model: null,
            observedAt: "2026-08-06T00:00:01.000Z",
          },
          { kind: "Stop", provider: "claude", sessionId: "s1", observedAt: "2026-08-06T00:00:02.000Z" },
        ]);
        // activity_line and origin_parent_ref are written by the maintenance
        // pass and the Paseo overlay, never by hook events; set them directly.
        writer.run(
          "UPDATE active_sessions SET activity_line = 'Bash git status', origin_parent_ref = 'agent-0' WHERE provider = 'claude' AND session_id = 's1'",
        );
      } finally {
        writer.close();
      }

      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        const snapshot = readProjection(reader);
        expect(snapshot.sessions[0]).toMatchObject({
          unreadSince: "2026-08-06T00:00:02.000Z",
          statusSince: "2026-08-06T00:00:01.000Z",
          activityLine: "Bash git status",
          transcriptPath: "/transcripts/s1.jsonl",
          originParentRef: "agent-0",
        });
        // The snapshot satisfies the published v2 contract.
        expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("writeSnapshotAtomically", () => {
  const snapshotA: SessionSnapshotV2 = {
    schemaVersion: 2,
    health: { status: "ok" },
    sessions: [],
  };
  const snapshotB: SessionSnapshotV2 = {
    schemaVersion: 2,
    health: { status: "ok" },
    sessions: [
      {
        provider: "claude",
        sessionId: "s1",
        status: "waiting",
        title: "Session",
        project: "proj",
        descendantCount: 2,
        logicalSlot: 3,
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
      },
    ],
  };

  test("publishes A then B: the file parses as exactly B, mode 0600, no temp sibling", () => {
    const dir = mkdtempSync(join(tmpdir(), "stream-deck-agents-snapshot-"));
    try {
      const target = join(dir, "snapshot-v2.json");

      writeSnapshotAtomically(target, snapshotA);
      const beforeRead = readFileSync(target, "utf8");
      // A reader before replacement sees only complete valid JSON: exactly A.
      expect(beforeRead.endsWith("\n")).toBe(true);
      expect(parseSessionSnapshot(JSON.parse(beforeRead))).toEqual(snapshotA);

      writeSnapshotAtomically(target, snapshotB);
      const afterRead = readFileSync(target, "utf8");
      // A reader after replacement sees only complete valid JSON: exactly B.
      expect(afterRead.endsWith("\n")).toBe(true);
      expect(parseSessionSnapshot(JSON.parse(afterRead))).toEqual(snapshotB);

      // Restrictive permissions on the replaced file.
      expect(statSync(target).mode & 0o777).toBe(0o600);

      // No temporary sibling remains after either publication.
      expect(readdirSync(dir)).toEqual(["snapshot-v2.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleans the temporary sibling in finally when publication fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "stream-deck-agents-snapshot-"));
    try {
      // A directory at the target path makes renameSync over it fail.
      const target = join(dir, "snapshot-v2.json");
      mkdirSync(target);

      expect(() => writeSnapshotAtomically(target, snapshotA)).toThrow();

      // The failed publication left no temporary sibling behind.
      expect(readdirSync(dir)).toEqual(["snapshot-v2.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
