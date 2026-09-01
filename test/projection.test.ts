import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths } from "../src/core/paths";
import {
  type PaseoLineageRow,
  ProjectionError,
  type ProjectionRow,
  projectRows,
  projectSnapshotRows,
  readProjection,
  resolvePaseoParentLinks,
} from "../src/core/projection";
import { applyRegistryEvents, syncPaseoStates } from "../src/core/registry";
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
    model?: string | null;
    openedAt?: string;
    originKind?: SessionOriginKind | null;
    originRef?: string | null;
    originSubagent?: number;
    unreadSince?: string | null;
    doneSince?: string | null;
    endedAt?: string | null;
    statusSince?: string | null;
    activityLine?: string | null;
    transcriptPath?: string | null;
    originParentRef?: string | null;
    lastEventAt?: string | null;
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
    model: options.model ?? null,
    openedAt: options.openedAt ?? "2026-08-26T05:00:00.000Z",
    originKind: options.originKind ?? null,
    originRef: options.originRef ?? null,
    originSubagent: options.originSubagent ?? 0,
    // Unread by default so idle roots stay visible; tests exercising the
    // visibility filter pass null explicitly (a `??` default would swallow it).
    unreadSince: options.unreadSince === undefined ? "2026-08-16T00:00:00.000Z" : options.unreadSince,
    doneSince: options.doneSince ?? null,
    endedAt: options.endedAt ?? null,
    statusSince: options.statusSince ?? null,
    activityLine: options.activityLine ?? null,
    transcriptPath: options.transcriptPath ?? null,
    originParentRef: options.originParentRef ?? null,
    lastEventAt: options.lastEventAt ?? null,
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
      doneSince: null,
      pendingResults: 0,
      endedAt: null,
      statusSince: null,
      activityLine: null,
      transcriptPath: null,
      originParentRef: null,
      lastEventAt: null,
    });
  });

  test("publishes the row's lastEventAt on the projected session", () => {
    const projected = projectRows([row("s1", { status: "working", lastEventAt: "2026-08-25T05:10:08.055Z" })]);
    expect(projected[0]?.lastEventAt).toBe("2026-08-25T05:10:08.055Z");
    expect(projectRows([row("s1", { status: "working", lastEventAt: null })])[0]?.lastEventAt).toBeNull();
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

  test("a done-and-read idle root stays visible with doneSince exposed", () => {
    const doneAt = "2026-08-16T00:05:00.000Z";
    const projected = projectRows([
      row("done-read", { status: "idle", unreadSince: null, doneSince: doneAt, slot: 1 }),
    ]);
    expect(projected.map((session) => session.sessionId)).toEqual(["done-read"]);
    expect(projected[0]?.doneSince).toBe(doneAt);
  });

  test("an idle paseo subagent with a done stamp stays hidden while its parent holds the roll-up", () => {
    const sessions = projectRows([
      row("parent", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
      row("sub", {
        status: "idle",
        unreadSince: null,
        doneSince: "2026-08-16T00:05:00.000Z",
        originKind: "paseo",
        originRef: "a1",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["parent"]);
  });

  test("a native subagent node carries a null doneSince while its root exposes the stamp", () => {
    const doneAt = "2026-08-16T00:05:00.000Z";
    const { agents } = projectSnapshotRows([
      row("p", { status: "working", unreadSince: null, doneSince: doneAt, slot: 1 }),
      row("c", { parent: "p", status: "working", doneSince: doneAt }),
    ]);
    expect(agents.find((agent) => agent.sessionId === "p")?.doneSince).toBe(doneAt);
    expect(agents.find((agent) => agent.sessionId === "c")?.doneSince).toBeNull();
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

  test("a stored roborev-origin root reads back as a plain primary", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);
      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "review",
            title: null,
            project: "kernel-d3-sdd",
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: "claude-opus-4-8",
            origin: { kind: "roborev", ref: "shim" },
            observedAt: "2026-08-27T00:00:01.000Z",
          },
          {
            kind: "Activity",
            provider: "claude",
            sessionId: "review",
            observedAt: "2026-08-27T00:00:02.000Z",
          },
        ]);
      } finally {
        writer.close();
      }

      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        const snapshot = readProjection(reader);
        expect(snapshot.sessions[0]).toMatchObject({
          sessionId: "review",
          originKind: "roborev",
          originRef: "shim",
          originSubagent: false,
        });
        expect(snapshot.agents?.[0]).toMatchObject({
          sessionId: "review",
          originKind: "roborev",
          role: "primary",
          lineage: null,
          parent: null,
        });
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
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

  test("an idle paseo subagent is hidden even when its result is unread — the parent carries it", () => {
    // Subagent results are consumed by the orchestrating parent agent, so a
    // finished paseo subagent must not hold the grid as an unread tile; the
    // roll-up holds the root ancestor with a badge instead.
    const sessions = projectRows([
      row("parent", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
      row("sub", {
        status: "idle",
        unreadSince: "2026-08-16T00:00:00.000Z",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["parent"]);
    expect(sessions[0]).toMatchObject({ pendingResults: 1, unreadSince: "2026-08-16T00:00:00.000Z" });
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

  test("a working paseo subagent retains its read-idle paseo parent across top-level rows", () => {
    // Paseo lineage spans separate top-level rows via originRef/originParentRef,
    // not parentSessionId: the parent's stored row stays read-and-idle, but the
    // active descendant holds it on the grid with a lifted effective status.
    const sessions = projectRows([
      row("parent", {
        status: "idle",
        unreadSince: null,
        statusSince: "2026-08-25T00:00:00.000Z",
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
      row("sub", {
        status: "working",
        unreadSince: null,
        statusSince: "2026-08-25T00:00:05.000Z",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      }),
    ]);

    expect(sessions.map((session) => [session.sessionId, session.status])).toEqual([
      ["parent", "working"],
      ["sub", "working"],
    ]);
    // Only the effective status rolls up; stored ledger fields are untouched.
    expect(sessions[0]).toMatchObject({
      unreadSince: null,
      statusSince: "2026-08-25T00:00:00.000Z",
    });
  });

  test("nested cross-provider paseo lineage retains every ancestor with priority aggregation", () => {
    const sessions = projectRows([
      row("grand", {
        provider: "claude",
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-g",
        originSubagent: 0,
        slot: 1,
      }),
      row("mid", {
        provider: "codex",
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-m",
        originSubagent: 1,
        originParentRef: "agent-g",
        slot: 2,
      }),
      row("waiter", {
        provider: "kimi",
        status: "waiting",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-w",
        originSubagent: 1,
        originParentRef: "agent-m",
        slot: 3,
      }),
      row("failed", {
        provider: "pi",
        status: "error",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-e",
        originSubagent: 1,
        originParentRef: "agent-m",
        slot: 4,
      }),
    ]);

    expect(sessions.map((session) => [session.sessionId, session.status])).toEqual([
      ["grand", "error"],
      ["mid", "error"],
      ["waiter", "waiting"],
      ["failed", "error"],
    ]);
  });

  test("a finished subagent's ledger holds its read-idle parent; viewing empties the badge but done keeps the card", () => {
    const parent = () =>
      row("parent", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      });
    const sub = (status: SessionStatus, unreadSince: string | null, doneSince: string | null = null) =>
      row("sub", {
        status,
        unreadSince,
        doneSince,
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      });

    // An unread finished subagent holds the parent with a badge.
    const rolled = projectRows([parent(), sub("idle", "2026-08-25T00:00:09.000Z", "2026-08-25T00:00:09.000Z")]);
    expect(rolled.map((session) => session.sessionId)).toEqual(["parent"]);
    expect(rolled[0]).toMatchObject({ pendingResults: 1, unreadSince: "2026-08-25T00:00:09.000Z" });

    // Viewed (unread cleared) but done: the badge empties, the card stays —
    // and the parent's published doneSince carries the hold so downstream
    // gestures (flickRemoves) can dismiss it.
    const viewed = projectRows([parent(), sub("idle", null, "2026-08-25T00:00:09.000Z")]);
    expect(viewed.map((session) => session.sessionId)).toEqual(["parent"]);
    expect(viewed[0]).toMatchObject({ pendingResults: 0, unreadSince: null, doneSince: "2026-08-25T00:00:09.000Z" });

    // While the subagent works, both show (active cards unchanged).
    expect(projectRows([parent(), sub("working", null)]).map((session) => session.sessionId)).toEqual([
      "parent",
      "sub",
    ]);

    // No ledger anywhere: the parent hides again.
    expect(projectRows([parent()])).toEqual([]);
  });

  test("missing, ambiguous, and cyclic paseo lineage stays bounded without blacking out active rows", () => {
    // A dangling originParentRef stops that walk; the subagent still projects.
    expect(
      projectRows([
        row("orphan", {
          status: "working",
          unreadSince: null,
          originKind: "paseo",
          originRef: "agent-1",
          originSubagent: 1,
          originParentRef: "ghost",
          slot: 1,
        }),
      ]).map((session) => session.sessionId),
    ).toEqual(["orphan"]);

    // Ambiguous duplicate originRefs never link, so no ancestor is lifted.
    expect(
      projectRows([
        row("dup-a", {
          status: "idle",
          unreadSince: null,
          originKind: "paseo",
          originRef: "agent-0",
          originSubagent: 0,
          slot: 1,
        }),
        row("dup-b", {
          status: "idle",
          unreadSince: null,
          originKind: "paseo",
          originRef: "agent-0",
          originSubagent: 0,
          slot: 2,
        }),
        row("sub", {
          status: "working",
          unreadSince: null,
          originKind: "paseo",
          originRef: "agent-1",
          originSubagent: 1,
          originParentRef: "agent-0",
          slot: 3,
        }),
      ]).map((session) => session.sessionId),
    ).toEqual(["sub"]);

    // Lineage cycles (self-referencing and mutual) terminate and leave
    // otherwise valid active rows projected.
    expect(
      projectRows([
        row("self-loop", {
          status: "working",
          unreadSince: null,
          originKind: "paseo",
          originRef: "agent-s",
          originSubagent: 1,
          originParentRef: "agent-s",
          slot: 1,
        }),
        row("loop-a", {
          status: "working",
          unreadSince: null,
          originKind: "paseo",
          originRef: "agent-x",
          originSubagent: 1,
          originParentRef: "agent-y",
          slot: 2,
        }),
        row("loop-b", {
          status: "working",
          unreadSince: null,
          originKind: "paseo",
          originRef: "agent-y",
          originSubagent: 1,
          originParentRef: "agent-x",
          slot: 3,
        }),
        row("healthy", { status: "working", unreadSince: null, slot: 4 }),
      ]).map((session) => session.sessionId),
    ).toEqual(["self-loop", "loop-a", "loop-b", "healthy"]);
  });

  test("a non-paseo root with a matching originRef is never treated as a paseo ancestor", () => {
    // Lineage is paseo-only: a terminal-origin row whose ref collides with
    // an active subagent's originParentRef must stay a read-and-idle hidden
    // root, not be lifted and projected as working.
    const sessions = projectRows([
      row("terminal-root", {
        status: "idle",
        unreadSince: null,
        originKind: "terminal",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
      row("sub", {
        status: "working",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["sub"]);
  });

  test("a non-paseo root sharing a ref does not poison a valid paseo parent's unique link", () => {
    // Malformed metadata — a ref with no origin kind — is not a paseo root,
    // so it must not make agent-0 ambiguous for the valid paseo parent.
    const sessions = projectRows([
      row("parent", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
      row("kindless", {
        status: "idle",
        unreadSince: null,
        originKind: null,
        originRef: "agent-0",
        originSubagent: 0,
        slot: 2,
      }),
      row("sub", {
        status: "working",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 3,
      }),
    ]);
    expect(sessions.map((session) => [session.sessionId, session.status])).toEqual([
      ["parent", "working"],
      ["sub", "working"],
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

  test("archived parent with active descendants: the children surface as orphan roots", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);
      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "parent",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            origin: { kind: "paseo", ref: "a1" },
            observedAt: "2026-08-06T00:00:01.000Z",
          },
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "child",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            origin: { kind: "paseo", ref: "a2" },
            observedAt: "2026-08-06T00:00:02.000Z",
          },
        ]);
        writer.run(
          "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'a1' WHERE session_id = 'child'",
        );
        applyRegistryEvents(writer, [
          { kind: "Activity", provider: "claude", sessionId: "child", observedAt: "2026-08-06T00:00:05.000Z" },
        ]);
        syncPaseoStates(writer, [
          {
            provider: "claude",
            sessionId: "parent",
            agentId: "a1",
            requiresAttention: false,
            isSubagent: false,
            parentAgentId: null,
            attentionTimestamp: null,
            updatedAt: "2026-08-06T00:00:08.000Z",
            archivedAt: "2026-08-06T00:00:09.000Z",
            lastStatus: null,
            title: null,
          },
          {
            provider: "claude",
            sessionId: "child",
            agentId: "a2",
            requiresAttention: false,
            isSubagent: true,
            parentAgentId: "a1",
            attentionTimestamp: null,
            updatedAt: "2026-08-06T00:00:08.000Z",
            archivedAt: null,
            lastStatus: null,
            title: null,
          },
        ]);
      } finally {
        writer.close();
      }
      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        const snapshot = readProjection(reader);
        // The archived parent is gone from the board; the active child is
        // its own card (parentless in the graph), not a promotion of the
        // archived parent.
        expect(snapshot.sessions.map((session) => session.sessionId)).toEqual(["child"]);
        expect(snapshot.sessions[0]).toMatchObject({ status: "working", originSubagent: true });
        expect(snapshot.agents?.find((node) => node.sessionId === "child")?.parent).toBeNull();
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("an idle parent with two finished idle subagents stays visible with pendingResults and aggregated unread", () => {
    const sessions = projectRows([
      row("parent", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
      row("sub-a", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:05.000Z",
        doneSince: "2026-08-25T00:00:05.000Z",
        originKind: "paseo",
        originRef: "agent-a",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      }),
      row("sub-b", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:09.000Z",
        doneSince: "2026-08-25T00:00:09.000Z",
        originKind: "paseo",
        originRef: "agent-b",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 3,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["parent"]);
    expect(sessions[0]).toMatchObject({ pendingResults: 2, unreadSince: "2026-08-25T00:00:09.000Z" });
  });

  test("roll-up reaches the root ancestor at nested depth", () => {
    const sessions = projectRows([
      row("grand", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-g",
        originSubagent: 0,
        slot: 1,
      }),
      row("mid", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-m",
        originSubagent: 1,
        originParentRef: "agent-g",
        slot: 2,
      }),
      row("leaf", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:09.000Z",
        doneSince: "2026-08-25T00:00:09.000Z",
        originKind: "paseo",
        originRef: "agent-l",
        originSubagent: 1,
        originParentRef: "agent-m",
        slot: 3,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["grand"]);
    expect(sessions[0]).toMatchObject({ pendingResults: 1, unreadSince: "2026-08-25T00:00:09.000Z" });
  });

  test("aggregated root unread takes the latest stamp across own and descendants", () => {
    const sessions = projectRows([
      row("parent", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:01.000Z",
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
      row("sub", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:09.000Z",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      }),
    ]);
    // The resolvable idle subagent is hidden by this task's own rule —
    // only the parent card publishes, and the child's newer stamp is what
    // the parent's aggregated unread reports.
    expect(sessions.map((session) => session.sessionId)).toEqual(["parent"]);
    expect(sessions[0]).toMatchObject({ pendingResults: 1, unreadSince: "2026-08-25T00:00:09.000Z" });
  });

  test("fail-safe promotion: a finished subagent with a dangling parent ref renders as its own card", () => {
    const sessions = projectRows([
      row("orphan", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:09.000Z",
        doneSince: "2026-08-25T00:00:09.000Z",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "ghost",
        slot: 1,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["orphan"]);
    expect(sessions[0]).toMatchObject({ pendingResults: 0, unreadSince: "2026-08-25T00:00:09.000Z" });
  });

  test("fail-safe promotion: cyclic lineage surfaces every result-bearing row", () => {
    const sessions = projectRows([
      row("loop-a", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:01.000Z",
        doneSince: "2026-08-25T00:00:01.000Z",
        originKind: "paseo",
        originRef: "agent-x",
        originSubagent: 1,
        originParentRef: "agent-y",
        slot: 1,
      }),
      row("loop-b", {
        status: "idle",
        unreadSince: null,
        doneSince: "2026-08-25T00:00:02.000Z",
        originKind: "paseo",
        originRef: "agent-y",
        originSubagent: 1,
        originParentRef: "agent-x",
        slot: 2,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId).sort()).toEqual(["loop-a", "loop-b"]);
  });

  test("fail-safe promotion: a done subagent whose parent row was deleted renders as its own card", () => {
    // The parent's origin_ref no longer exists in the registry.
    const sessions = projectRows([
      row("sub", {
        status: "idle",
        unreadSince: null,
        doneSince: "2026-08-25T00:00:09.000Z",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-gone",
        slot: 1,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["sub"]);
  });

  test("an ended root publishes endedAt and stays visible by its ledgers", () => {
    const sessions = projectRows([
      row("ended", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:09.000Z",
        doneSince: "2026-08-25T00:00:09.000Z",
        endedAt: "2026-08-25T00:01:00.000Z",
        slot: 1,
      }),
    ]);
    expect(sessions[0]).toMatchObject({ sessionId: "ended", endedAt: "2026-08-25T00:01:00.000Z" });
  });

  test("an active subagent's own news is not double-counted into its parent's badge", () => {
    // Sub is working (its own card) while holding unread news (a result
    // landed, then work resumed). Its own card carries the badge; the parent
    // must not also count it, or the rail would double-count.
    const sessions = projectRows([
      row("parent", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
      row("sub", {
        status: "working",
        unreadSince: "2026-08-25T00:00:05.000Z",
        doneSince: "2026-08-25T00:00:05.000Z",
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["parent", "sub"]);
    expect(sessions[0]).toMatchObject({ sessionId: "parent", pendingResults: 0, unreadSince: null, doneSince: null });
    expect(sessions[1]).toMatchObject({ sessionId: "sub", unreadSince: "2026-08-25T00:00:05.000Z" });
  });

  test("roll-up stops at an active subagent: its finished children badge its own card, not the root's", () => {
    // The leaf is a finished idle subagent of mid; mid is working (its own
    // card). The leaf rolls up to mid — the nearest visible card — and the
    // root counts neither.
    const sessions = projectRows([
      row("root", {
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-0",
        originSubagent: 0,
        slot: 1,
      }),
      row("mid", {
        status: "working",
        originKind: "paseo",
        originRef: "agent-m",
        originSubagent: 1,
        originParentRef: "agent-0",
        slot: 2,
      }),
      row("leaf", {
        status: "idle",
        unreadSince: "2026-08-25T00:00:09.000Z",
        doneSince: "2026-08-25T00:00:09.000Z",
        originKind: "paseo",
        originRef: "agent-l",
        originSubagent: 1,
        originParentRef: "agent-m",
        slot: 3,
      }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(["root", "mid"]);
    expect(sessions[0]).toMatchObject({ sessionId: "root", pendingResults: 0, unreadSince: null });
    expect(sessions[1]).toMatchObject({ sessionId: "mid", pendingResults: 1, unreadSince: "2026-08-25T00:00:09.000Z" });
  });
});

describe("projectSnapshotRows", () => {
  test("projects mixed native and Paseo hierarchy with per-node facts", () => {
    const result = projectSnapshotRows([
      row("root", {
        provider: "evener",
        slot: 1,
        status: "idle",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-root",
        model: "gpt-5.6-sol",
        openedAt: "2026-08-26T05:00:00.000Z",
      }),
      row("native", {
        provider: "evener",
        parent: "root",
        status: "idle",
        model: "claude-opus-4.1",
        openedAt: "2026-08-26T05:00:02.000Z",
        statusSince: "2026-08-26T05:00:02.000Z",
      }),
      row("native-nested", {
        provider: "evener",
        parent: "native",
        status: "waiting",
        model: "gpt-5.6-terra",
        openedAt: "2026-08-26T05:00:03.000Z",
      }),
      row("paseo", {
        provider: "codex",
        slot: 2,
        status: "working",
        unreadSince: null,
        originKind: "paseo",
        originRef: "agent-paseo",
        originSubagent: 1,
        originParentRef: "agent-root",
        openedAt: "2026-08-26T05:00:01.000Z",
      }),
      row("paseo-native", {
        provider: "codex",
        parent: "paseo",
        status: "error",
        model: "gemini-3-pro",
        openedAt: "2026-08-26T05:00:04.000Z",
      }),
    ]);

    expect(result.agents.map((node) => node.sessionId)).toEqual([
      "root",
      "paseo",
      "paseo-native",
      "native",
      "native-nested",
    ]);
    expect(result.agents.map((node) => [node.sessionId, node.status])).toEqual([
      ["root", "error"],
      ["paseo", "error"],
      ["paseo-native", "error"],
      ["native", "waiting"],
      ["native-nested", "waiting"],
    ]);
    expect(result.agents.find((node) => node.sessionId === "paseo")?.parent).toEqual({
      provider: "evener",
      sessionId: "root",
    });
    expect(result.agents.find((node) => node.sessionId === "native")?.parent).toEqual({
      provider: "evener",
      sessionId: "root",
    });
  });

  test("native nodes remove independent routing and unread facts", () => {
    const { agents } = projectSnapshotRows([
      row("root", { status: "working", slot: 1 }),
      row("child", {
        parent: "root",
        title: "Child title",
        project: "child-project",
        model: "child-model",
        openedAt: "2026-08-26T05:00:01.000Z",
        statusSince: "2026-08-26T05:00:02.000Z",
        activityLine: "Read child.ts",
        unreadSince: "2026-08-26T05:01:00.000Z",
        transcriptPath: "/tmp/child.jsonl",
        originKind: "paseo",
        originRef: "should-not-publish",
        originSubagent: 1,
        originParentRef: "should-not-publish",
      }),
    ]);

    expect(agents.find((node) => node.sessionId === "child")).toMatchObject({
      role: "subagent",
      lineage: "native",
      logicalSlot: null,
      ghosttyTerminalId: null,
      transcriptPath: null,
      originKind: null,
      originRef: null,
      originSubagent: false,
      originParentRef: null,
      unreadSince: null,
      title: "Child title",
      project: "child-project",
      model: "child-model",
      openedAt: "2026-08-26T05:00:01.000Z",
      statusSince: "2026-08-26T05:00:02.000Z",
      activityLine: "Read child.ts",
    });
  });

  test("graph nodes publish the row's lastEventAt", () => {
    const { agents } = projectSnapshotRows([
      row("root", { status: "working", slot: 1, lastEventAt: "2026-08-26T20:21:51.337Z" }),
      row("child", { parent: "root", status: "working", lastEventAt: "2026-08-26T20:21:30.280Z" }),
    ]);
    expect(agents.find((node) => node.sessionId === "root")?.lastEventAt).toBe("2026-08-26T20:21:51.337Z");
    expect(agents.find((node) => node.sessionId === "child")?.lastEventAt).toBe("2026-08-26T20:21:30.280Z");
  });

  test("missing, ambiguous, and cyclic Paseo parentage becomes parentless", () => {
    const { agents } = projectSnapshotRows([
      row("missing", {
        provider: "claude",
        slot: 1,
        status: "working",
        originKind: "paseo",
        originRef: "missing-child",
        originSubagent: 1,
        originParentRef: "absent",
      }),
      row("dup-a", { provider: "codex", slot: 2, status: "working", originKind: "paseo", originRef: "dup" }),
      row("dup-b", { provider: "kimi", slot: 3, status: "working", originKind: "paseo", originRef: "dup" }),
      row("ambiguous", {
        provider: "pi",
        slot: 4,
        status: "working",
        originKind: "paseo",
        originRef: "ambiguous-child",
        originSubagent: 1,
        originParentRef: "dup",
      }),
      row("cycle-a", {
        provider: "omp",
        slot: 5,
        status: "working",
        originKind: "paseo",
        originRef: "cycle-a",
        originSubagent: 1,
        originParentRef: "cycle-b",
      }),
      row("cycle-b", {
        provider: "qwen",
        slot: 6,
        status: "working",
        originKind: "paseo",
        originRef: "cycle-b",
        originSubagent: 1,
        originParentRef: "cycle-a",
      }),
    ]);

    for (const id of ["missing", "ambiguous", "cycle-a", "cycle-b"]) {
      expect(agents.find((node) => node.sessionId === id)?.parent).toBeNull();
    }
  });

  test("legacy sessions and duplicate graph roots agree", () => {
    const result = projectSnapshotRows([
      row("root", { status: "idle", unreadSince: null }),
      row("child", { parent: "root", status: "waiting", model: "child-model" }),
    ]);
    const legacy = result.sessions[0];
    const graphRoot = result.agents.find((node) => node.sessionId === "root");
    expect(graphRoot).toMatchObject({
      provider: legacy?.provider,
      sessionId: legacy?.sessionId,
      status: legacy?.status,
      title: legacy?.title,
      project: legacy?.project,
      model: legacy?.model,
      logicalSlot: legacy?.logicalSlot,
    });
    expect(legacy?.descendantCount).toBe(1);
  });

  test("orders equal-timestamp Paseo siblings by provider then session ID", () => {
    const { agents } = projectSnapshotRows([
      row("root", {
        provider: "evener",
        slot: 1,
        status: "working",
        originKind: "paseo",
        originRef: "root-agent",
      }),
      row("bravo", {
        provider: "codex",
        slot: 2,
        status: "working",
        originKind: "paseo",
        originRef: "codex-bravo",
        originSubagent: 1,
        originParentRef: "root-agent",
      }),
      row("alpha", {
        provider: "claude",
        slot: 3,
        status: "working",
        originKind: "paseo",
        originRef: "claude-alpha",
        originSubagent: 1,
        originParentRef: "root-agent",
      }),
      row("alpha", {
        provider: "codex",
        slot: 4,
        status: "working",
        originKind: "paseo",
        originRef: "codex-alpha",
        originSubagent: 1,
        originParentRef: "root-agent",
      }),
    ]);

    expect(agents.map((node) => [node.provider, node.sessionId])).toEqual([
      ["evener", "root"],
      ["claude", "alpha"],
      ["codex", "alpha"],
      ["codex", "bravo"],
    ]);
  });
});

describe("readProjection", () => {
  test("projects one consistent snapshot from a separately committed writer", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
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
            model: null,
            observedAt: "2026-08-06T00:00:02.000Z",
          },
          {
            kind: "SubagentStart",
            provider: "claude",
            sessionId: "grandchild",
            parentSessionId: "child",
            title: null,
            project: null,
            model: null,
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
            doneSince: null,
            pendingResults: 0,
            endedAt: null,
            statusSince: "2026-08-06T00:00:04.000Z",
            activityLine: null,
            transcriptPath: null,
            originParentRef: null,
            lastEventAt: "2026-08-06T00:00:04.000Z",
          },
        ]);
        expect(snapshot.agents).toEqual([
          {
            provider: "claude",
            sessionId: "parent",
            role: "primary",
            lineage: null,
            parent: null,
            status: "error",
            title: "Parent",
            project: "proj",
            model: null,
            openedAt: "2026-08-06T00:00:01.000Z",
            statusSince: "2026-08-06T00:00:04.000Z",
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
            lastEventAt: "2026-08-06T00:00:04.000Z",
          },
          {
            provider: "claude",
            sessionId: "child",
            role: "subagent",
            lineage: "native",
            parent: { provider: "claude", sessionId: "parent" },
            status: "error",
            title: null,
            project: null,
            model: null,
            openedAt: "2026-08-06T00:00:02.000Z",
            statusSince: "2026-08-06T00:00:05.000Z",
            activityLine: null,
            unreadSince: null,
            doneSince: null,
            pendingResults: 0,
            endedAt: null,
            logicalSlot: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            originKind: null,
            originRef: null,
            originSubagent: false,
            originParentRef: null,
            lastEventAt: "2026-08-06T00:00:05.000Z",
          },
          {
            provider: "claude",
            sessionId: "grandchild",
            role: "subagent",
            lineage: "native",
            parent: { provider: "claude", sessionId: "child" },
            status: "error",
            title: null,
            project: null,
            model: null,
            openedAt: "2026-08-06T00:00:03.000Z",
            statusSince: "2026-08-06T00:00:06.000Z",
            activityLine: null,
            unreadSince: null,
            doneSince: null,
            pendingResults: 0,
            endedAt: null,
            logicalSlot: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            originKind: null,
            originRef: null,
            originSubagent: false,
            originParentRef: null,
            lastEventAt: "2026-08-06T00:00:06.000Z",
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
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
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
            model: null,
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
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
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
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
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

  test("a Stop's done stamp round-trips into the published snapshot", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);
      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "finished",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-26T05:00:00.000Z",
          },
          { kind: "Stop", provider: "claude", sessionId: "finished", observedAt: "2026-08-26T05:01:00.000Z" },
        ]);
      } finally {
        writer.close();
      }
      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        const snapshot = readProjection(reader);
        expect(snapshot.sessions).toHaveLength(1);
        expect(snapshot.sessions[0]).toMatchObject({
          sessionId: "finished",
          status: "idle",
          doneSince: "2026-08-26T05:01:00.000Z",
        });
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("rejects a corrupt done_since and rolls back the read transaction", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);
      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "bad-done-since",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-26T05:00:00.000Z",
          },
        ]);
        // A blob defeats the column's text affinity, unlike an integer,
        // which SQLite would quietly store as the string '42'.
        writer.run("UPDATE active_sessions SET done_since = x'00' WHERE session_id = 'bad-done-since'");
      } finally {
        writer.close();
      }
      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        expect(() => readProjection(reader)).toThrow(new ProjectionError("corrupt-row"));
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("rejects corrupt opened_at and rolls back the read transaction", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);

      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "bad-opened-at",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-26T05:00:00.000Z",
          },
        ]);
        writer.run("UPDATE active_sessions SET opened_at = 'not-a-time' WHERE session_id = 'bad-opened-at'");
      } finally {
        writer.close();
      }

      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        expect(() => readProjection(reader)).toThrow(new ProjectionError("corrupt-row"));
        expect(() => {
          reader.exec("BEGIN");
          reader.exec("ROLLBACK");
        }).not.toThrow();
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("an ended root publishes endedAt through the snapshot", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);
      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "ended",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-26T05:00:00.000Z",
          },
          { kind: "Stop", provider: "claude", sessionId: "ended", observedAt: "2026-08-26T05:01:00.000Z" },
        ]);
        writer.run("UPDATE active_sessions SET ended_at = ? WHERE provider = 'claude' AND session_id = 'ended'", [
          "2026-08-26T05:02:00.000Z",
        ]);
      } finally {
        writer.close();
      }
      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        const snapshot = readProjection(reader);
        expect(snapshot.sessions[0]).toMatchObject({
          sessionId: "ended",
          endedAt: "2026-08-26T05:02:00.000Z",
          pendingResults: 0,
        });
        expect(snapshot.agents?.[0]).toMatchObject({
          sessionId: "ended",
          endedAt: "2026-08-26T05:02:00.000Z",
          pendingResults: 0,
        });
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("rejects a corrupt ended_at and rolls back the read transaction", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "dealerboard-projection-"));
    try {
      const paths = resolveAppPaths(tempHome);
      initializeDatabase(paths);
      const writer = openRegistryDatabase(paths.database, "readwrite");
      try {
        applyRegistryEvents(writer, [
          {
            kind: "SessionStart",
            provider: "claude",
            sessionId: "bad-ended-at",
            title: null,
            project: null,
            ghosttyTerminalId: null,
            transcriptPath: null,
            model: null,
            observedAt: "2026-08-26T05:00:00.000Z",
          },
        ]);
        writer.run("UPDATE active_sessions SET ended_at = x'00' WHERE session_id = 'bad-ended-at'");
      } finally {
        writer.close();
      }
      const reader = openRegistryDatabase(paths.database, "readonly");
      try {
        expect(() => readProjection(reader)).toThrow(new ProjectionError("corrupt-row"));
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
    agents: [],
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
        doneSince: null,
        pendingResults: 0,
        endedAt: null,
        statusSince: null,
        activityLine: null,
        transcriptPath: null,
        originParentRef: null,
        lastEventAt: null,
      },
    ],
    agents: [],
  };

  test("publishes A then B: the file parses as exactly B, mode 0600, no temp sibling", () => {
    const dir = mkdtempSync(join(tmpdir(), "dealerboard-snapshot-"));
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
    const dir = mkdtempSync(join(tmpdir(), "dealerboard-snapshot-"));
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

describe("resolvePaseoParentLinks", () => {
  const row = (
    sessionId: string,
    originRef: string | null,
    originParentRef: string | null,
    originSubagent = 1,
    provider: Provider = "claude",
  ): PaseoLineageRow => ({ provider, sessionId, originRef, originSubagent, originParentRef });

  test("links a subagent to the unique carrier of its parent ref", () => {
    const links = resolvePaseoParentLinks([row("p", "agent-0", null, 0), row("s", "agent-1", "agent-0")]);
    expect(links.get("claude\u0000s")).toBe("claude\u0000p");
  });

  test("an ambiguous ref never links", () => {
    const links = resolvePaseoParentLinks([
      row("dup-a", "agent-0", null, 0),
      row("dup-b", "agent-0", null, 0),
      row("s", "agent-1", "agent-0"),
    ]);
    expect(links.size).toBe(0);
  });

  test("cycle members lose their parent edge", () => {
    const links = resolvePaseoParentLinks([
      row("a", "agent-x", "agent-y"),
      row("b", "agent-y", "agent-x"),
      row("p", "agent-0", null, 0),
      row("s", "agent-1", "agent-0"),
    ]);
    expect(links.has("claude\u0000a")).toBe(false);
    expect(links.has("claude\u0000b")).toBe(false);
    expect(links.get("claude\u0000s")).toBe("claude\u0000p");
  });
});
