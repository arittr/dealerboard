import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths } from "../src/core/paths";
import { readProjection } from "../src/core/projection";
import {
  acknowledgeSession,
  applyEvenerCollectorUpdate,
  applyRegistryEvents,
  clearAllSessions,
  clearSession,
  listSessions,
  pruneStaleSessions,
  sweepExpiredResults,
  syncPaseoStates,
  updateSessionActivityLines,
  updateSessionModels,
  updateSessionTitles,
  viewSession,
} from "../src/core/registry";
import { initializeDatabase, openRegistryDatabase } from "../src/core/schema";
import type { Provider, RegistryEvent, SessionOrigin } from "../src/protocol";

let tempHome: string;
let db: Database;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "dealerboard-registry-"));
  const paths = resolveAppPaths(tempHome);
  initializeDatabase(paths);
  db = openRegistryDatabase(paths.database, "readwrite");
});

afterEach(() => {
  db.close();
  rmSync(tempHome, { recursive: true, force: true });
});

const at = (second: number): string => `2026-08-06T00:00:${String(second).padStart(2, "0")}.000Z`;

const start = (
  sessionId: string,
  options: {
    provider?: Provider;
    title?: string | null;
    project?: string | null;
    ghosttyTerminalId?: string | null;
    transcriptPath?: string | null;
    model?: string | null;
    at?: string;
    origin?: SessionOrigin | null;
  } = {},
): Extract<RegistryEvent, { kind: "SessionStart" }> => ({
  kind: "SessionStart",
  provider: options.provider ?? "claude",
  sessionId,
  title: options.title ?? null,
  project: options.project ?? null,
  ghosttyTerminalId: options.ghosttyTerminalId ?? null,
  transcriptPath: options.transcriptPath ?? null,
  model: options.model ?? null,
  observedAt: options.at ?? at(1),
  ...(options.origin !== undefined ? { origin: options.origin } : {}),
});

const subStart = (
  sessionId: string,
  parentSessionId: string,
  options: {
    provider?: Provider;
    title?: string | null;
    project?: string | null;
    model?: string | null;
    at?: string;
  } = {},
): Extract<RegistryEvent, { kind: "SubagentStart" }> => ({
  kind: "SubagentStart",
  provider: options.provider ?? "claude",
  sessionId,
  parentSessionId,
  title: options.title ?? null,
  project: options.project ?? null,
  model: options.model ?? null,
  observedAt: options.at ?? at(1),
});

const simple = (
  kind:
    | "Activity"
    | "Attention"
    | "Stop"
    | "StopFailure"
    | "SessionEnd"
    | "SubagentStop"
    | "BackgroundWorkStarted"
    | "BackgroundWorkCleared",
  sessionId: string,
  options: { provider?: Provider; at?: string } = {},
): RegistryEvent => ({
  kind,
  provider: options.provider ?? "claude",
  sessionId,
  observedAt: options.at ?? at(1),
});

type Row = {
  provider: Provider;
  session_id: string;
  parent_session_id: string | null;
  status: string;
  title: string | null;
  project: string | null;
  logical_slot: number | null;
  opened_at: string;
  updated_at: string;
  ghostty_terminal_id: string | null;
  background_outstanding: number;
  transcript_path: string | null;
  model: string | null;
  origin_kind: string | null;
  origin_ref: string | null;
  origin_subagent: number;
  unread_since: string | null;
  acked_at: string | null;
  status_since: string | null;
  origin_parent_ref: string | null;
  activity_line: string | null;
  done_since: string | null;
  viewed_since: string | null;
  ended_at: string | null;
};

const getRow = (sessionId: string, provider: Provider = "claude"): Row | null =>
  db
    .query("SELECT * FROM active_sessions WHERE provider = ? AND session_id = ?")
    .get(provider, sessionId) as Row | null;

const allRows = (): Row[] => db.query("SELECT * FROM active_sessions ORDER BY provider, session_id").all() as Row[];

const countRows = (): number => {
  const row = db.query("SELECT COUNT(*) AS n FROM active_sessions").get() as { n: number } | null;
  if (row === null) {
    throw new Error("COUNT(*) must return one row");
  }
  return row.n;
};

const identities = (): string[] =>
  allRows()
    .map((row) => `${row.provider}:${row.session_id}:${row.parent_session_id ?? "root"}`)
    .sort();

const evenerUpdate = (
  events: RegistryEvent[],
  activeChildSessionIds: readonly string[] | null,
): Parameters<typeof applyEvenerCollectorUpdate>[1] => ({ events, activeChildSessionIds });

describe("applyRegistryEvents", () => {
  test("reconciles an observed status without changing the unread ledger", () => {
    applyRegistryEvents(db, [start("evener-1", { provider: "evener", at: at(1) })]);
    applyRegistryEvents(db, [simple("Stop", "evener-1", { provider: "evener", at: at(2) })]);
    expect(getRow("evener-1", "evener")).toMatchObject({
      status: "idle",
      unread_since: at(2),
      status_since: at(1),
    });

    expect(
      applyRegistryEvents(db, [
        {
          kind: "SessionStatusObserved",
          provider: "evener",
          sessionId: "evener-1",
          status: "waiting",
          observedAt: at(3),
        },
      ]),
    ).toEqual(["applied"]);
    expect(getRow("evener-1", "evener")).toMatchObject({
      status: "waiting",
      unread_since: at(2),
      status_since: at(3),
      updated_at: at(3),
    });

    expect(
      applyRegistryEvents(db, [
        {
          kind: "SessionStatusObserved",
          provider: "evener",
          sessionId: "evener-1",
          status: "waiting",
          observedAt: at(4),
        },
      ]),
    ).toEqual(["ignored"]);
    expect(getRow("evener-1", "evener")?.updated_at).toBe(at(3));
  });

  test("drives one session through idle, working, waiting, idle, error, and closed", () => {
    expect(applyRegistryEvents(db, [start("s1", { title: "First", project: "proj", at: at(1) })])).toEqual(["applied"]);
    expect(getRow("s1")).toEqual({
      provider: "claude",
      session_id: "s1",
      parent_session_id: null,
      status: "idle",
      title: "First",
      project: "proj",
      logical_slot: 1,
      opened_at: at(1),
      updated_at: at(1),
      ghostty_terminal_id: null,
      background_outstanding: 0,
      transcript_path: null,
      model: null,
      origin_kind: null,
      origin_ref: null,
      origin_subagent: 0,
      unread_since: null,
      acked_at: null,
      status_since: at(1),
      origin_parent_ref: null,
      activity_line: null,
      done_since: null,
      viewed_since: null,
      ended_at: null,
    });

    expect(applyRegistryEvents(db, [simple("Activity", "s1", { at: at(2) })])).toEqual(["applied"]);
    expect(getRow("s1")).toMatchObject({
      status: "working",
      logical_slot: 1,
      opened_at: at(1),
      updated_at: at(2),
    });

    expect(applyRegistryEvents(db, [simple("Attention", "s1", { at: at(3) })])).toEqual(["applied"]);
    expect(getRow("s1")).toMatchObject({ status: "waiting", logical_slot: 1, updated_at: at(3) });

    expect(applyRegistryEvents(db, [simple("Stop", "s1", { at: at(4) })])).toEqual(["applied"]);
    expect(getRow("s1")).toMatchObject({ status: "idle", logical_slot: 1, updated_at: at(4) });

    expect(applyRegistryEvents(db, [simple("StopFailure", "s1", { at: at(5) })])).toEqual(["applied"]);
    expect(getRow("s1")).toMatchObject({ status: "error", logical_slot: 1, updated_at: at(5) });

    expect(applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(6) })])).toEqual(["applied"]);
    expect(getRow("s1")).toBeNull();
    expect(countRows()).toBe(0);
  });

  test("never recreates a closed session from late non-start events", () => {
    applyRegistryEvents(db, [start("s1")]);
    applyRegistryEvents(db, [simple("SessionEnd", "s1")]);

    for (const kind of [
      "Activity",
      "Attention",
      "Stop",
      "StopFailure",
      "SessionEnd",
      "SubagentStop",
      "BackgroundWorkStarted",
      "BackgroundWorkCleared",
    ] as const) {
      expect(applyRegistryEvents(db, [simple(kind, "s1", { at: at(2) })])).toEqual(["ignored"]);
    }
    expect(getRow("s1")).toBeNull();
    expect(countRows()).toBe(0);
  });

  test("allocates the lowest free slot and never moves existing slots", () => {
    expect(applyRegistryEvents(db, [start("s1"), start("s2"), start("s3")])).toEqual(["applied", "applied", "applied"]);
    expect(getRow("s1")?.logical_slot).toBe(1);
    expect(getRow("s2")?.logical_slot).toBe(2);
    expect(getRow("s3")?.logical_slot).toBe(3);

    // Deleting slot 2 releases exactly that hole for the next new identity.
    applyRegistryEvents(db, [simple("SessionEnd", "s2")]);
    expect(applyRegistryEvents(db, [start("s4")])).toEqual(["applied"]);
    expect(getRow("s4")?.logical_slot).toBe(2);

    // Status and metadata changes never reassign slots.
    applyRegistryEvents(db, [
      simple("Activity", "s1", { at: at(2) }),
      simple("Attention", "s3", { at: at(2) }),
      start("s4", { title: "renamed", at: at(3) }),
    ]);
    expect(getRow("s1")).toMatchObject({ status: "working", logical_slot: 1 });
    expect(getRow("s3")).toMatchObject({ status: "waiting", logical_slot: 3 });
    expect(getRow("s4")).toMatchObject({ title: "renamed", logical_slot: 2 });
  });

  test("repeating SessionStart preserves the slot and opened_at while resetting to idle", () => {
    applyRegistryEvents(db, [start("s1", { title: "original", project: "a", at: at(1) }), start("s2", { at: at(2) })]);
    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(3) })]);

    expect(applyRegistryEvents(db, [start("s1", { title: "renamed", project: "b", at: at(4) })])).toEqual(["applied"]);
    expect(getRow("s1")).toEqual({
      provider: "claude",
      session_id: "s1",
      parent_session_id: null,
      status: "idle",
      title: "renamed",
      project: "b",
      logical_slot: 1,
      opened_at: at(1),
      updated_at: at(4),
      ghostty_terminal_id: null,
      background_outstanding: 0,
      transcript_path: null,
      model: null,
      origin_kind: null,
      origin_ref: null,
      origin_subagent: 0,
      unread_since: null,
      acked_at: null,
      status_since: at(4),
      origin_parent_ref: null,
      activity_line: null,
      done_since: null,
      viewed_since: null,
      ended_at: null,
    });
    expect(getRow("s2")?.logical_slot).toBe(2);
  });

  test("children receive a null slot and parent deletion cascades through nested descendants", () => {
    applyRegistryEvents(db, [start("parent")]);

    expect(applyRegistryEvents(db, [subStart("child", "parent", { title: "c" })])).toEqual(["applied"]);
    expect(getRow("child")).toMatchObject({
      parent_session_id: "parent",
      logical_slot: null,
      status: "idle",
      title: "c",
    });

    // A repeated SubagentStart resets the existing child to idle in place.
    applyRegistryEvents(db, [simple("Activity", "child", { at: at(2) })]);
    expect(applyRegistryEvents(db, [subStart("child", "parent", { title: "c2", at: at(3) })])).toEqual(["applied"]);
    expect(getRow("child")).toMatchObject({
      parent_session_id: "parent",
      logical_slot: null,
      status: "idle",
      title: "c2",
      opened_at: at(1),
      updated_at: at(3),
    });

    expect(applyRegistryEvents(db, [subStart("grandchild", "child")])).toEqual(["applied"]);
    expect(getRow("grandchild")).toMatchObject({
      parent_session_id: "child",
      logical_slot: null,
    });
    expect(countRows()).toBe(3);

    expect(applyRegistryEvents(db, [simple("SessionEnd", "parent")])).toEqual(["applied"]);
    expect(countRows()).toBe(0);
  });

  test("stores and backfills a child model without null-clearing it", () => {
    applyRegistryEvents(db, [start("parent"), subStart("child", "parent", { model: "model-a", at: at(2) })]);
    expect(getRow("child")?.model).toBe("model-a");

    applyRegistryEvents(db, [subStart("child", "parent", { model: null, at: at(3) })]);
    expect(getRow("child")?.model).toBe("model-a");

    applyRegistryEvents(db, [subStart("child", "parent", { model: "model-b", at: at(4) })]);
    expect(getRow("child")?.model).toBe("model-b");
  });

  test("SessionModelChanged updates only model on existing roots and children", () => {
    applyRegistryEvents(db, [start("root", { model: "root-a", at: at(1) }), subStart("child", "root", { at: at(2) })]);
    const rootBefore = getRow("root");
    const childBefore = getRow("child");
    if (rootBefore === null || childBefore === null) {
      throw new Error("model-change fixtures must exist");
    }

    expect(
      applyRegistryEvents(db, [
        { kind: "SessionModelChanged", provider: "claude", sessionId: "root", model: "root-b", observedAt: at(3) },
        { kind: "SessionModelChanged", provider: "claude", sessionId: "child", model: "child-b", observedAt: at(4) },
      ]),
    ).toEqual(["applied", "applied"]);

    expect(getRow("root")).toEqual({ ...rootBefore, model: "root-b" });
    expect(getRow("child")).toEqual({ ...childBefore, model: "child-b" });
  });

  test("SessionModelChanged ignores unknown, unchanged, empty, and oversized models", () => {
    applyRegistryEvents(db, [start("root", { model: "stable", at: at(1) })]);
    expect(
      applyRegistryEvents(db, [
        { kind: "SessionModelChanged", provider: "claude", sessionId: "missing", model: "new", observedAt: at(2) },
        { kind: "SessionModelChanged", provider: "claude", sessionId: "root", model: "stable", observedAt: at(3) },
        { kind: "SessionModelChanged", provider: "claude", sessionId: "root", model: "", observedAt: at(4) },
        {
          kind: "SessionModelChanged",
          provider: "claude",
          sessionId: "root",
          model: "m".repeat(257),
          observedAt: at(5),
        },
      ]),
    ).toEqual(["ignored", "ignored", "ignored", "ignored"]);
    expect(getRow("root")?.model).toBe("stable");
  });

  test("a facts update cannot promote a child whose start had no valid parent", () => {
    expect(
      applyRegistryEvents(db, [
        subStart("orphan", "missing", { model: "child-model", at: at(1) }),
        {
          kind: "SessionModelChanged",
          provider: "claude",
          sessionId: "orphan",
          model: "child-model",
          observedAt: at(2),
        },
      ]),
    ).toEqual(["ignored", "ignored"]);
    expect(getRow("orphan")).toBeNull();
  });

  test("persists a Claude terminal target until a repeated SessionStart clears it", () => {
    applyRegistryEvents(db, [start("bound", { ghosttyTerminalId: "terminal-a" })]);
    applyRegistryEvents(db, [simple("Activity", "bound", { at: at(2) })]);
    expect(listSessions(db)[0]?.ghosttyTerminalId).toBe("terminal-a");

    applyRegistryEvents(db, [start("bound", { ghosttyTerminalId: null, at: at(3) })]);
    expect(listSessions(db)[0]).toMatchObject({
      sessionId: "bound",
      logicalSlot: 1,
      ghosttyTerminalId: null,
    });
  });

  test("normalizes non-Claude terminal targets to null", () => {
    applyRegistryEvents(db, [
      start("codex", { provider: "codex", ghosttyTerminalId: "terminal-codex" }),
      start("kimi", { provider: "kimi", ghosttyTerminalId: "terminal-kimi" }),
    ]);

    expect(listSessions(db).map((session) => session.ghosttyTerminalId)).toEqual([null, null]);
  });

  test("preserves a root terminal target through subagent and status events", () => {
    applyRegistryEvents(db, [start("parent", { ghosttyTerminalId: "terminal-parent" })]);
    applyRegistryEvents(db, [subStart("child", "parent"), simple("Attention", "parent", { at: at(2) })]);

    expect(getRow("parent")?.ghostty_terminal_id).toBe("terminal-parent");
    expect(getRow("child")?.ghostty_terminal_id).toBeNull();
  });

  test("deletes a terminal target with its row through session end and repair", () => {
    applyRegistryEvents(db, [start("ended", { ghosttyTerminalId: "terminal-ended" })]);
    applyRegistryEvents(db, [simple("SessionEnd", "ended")]);
    expect(getRow("ended")).toBeNull();

    applyRegistryEvents(db, [start("repaired", { ghosttyTerminalId: "terminal-repaired" })]);
    expect(clearSession(db, "claude", "repaired")).toBe("applied");
    expect(getRow("repaired")).toBeNull();
  });

  test("ignores self-parenting with no mutation at all", () => {
    expect(applyRegistryEvents(db, [subStart("x", "x")])).toEqual(["ignored"]);
    expect(countRows()).toBe(0);
  });

  test("ignores a child whose parent is missing, leaving prior rows untouched", () => {
    applyRegistryEvents(db, [start("p")]);
    const before = allRows();
    expect(applyRegistryEvents(db, [subStart("c", "ghost")])).toEqual(["ignored"]);
    expect(allRows()).toEqual(before);
  });

  test("ignores cross-provider parentage", () => {
    applyRegistryEvents(db, [start("p", { provider: "claude" })]);
    const before = allRows();
    expect(applyRegistryEvents(db, [subStart("c", "p", { provider: "kimi" })])).toEqual(["ignored"]);
    expect(allRows()).toEqual(before);
  });

  test("ignores a top-level identity becoming a child", () => {
    applyRegistryEvents(db, [start("a"), start("b")]);
    applyRegistryEvents(db, [simple("Activity", "a", { at: at(2) })]);
    const before = allRows();

    expect(applyRegistryEvents(db, [subStart("a", "b", { at: at(3) })])).toEqual(["ignored"]);
    expect(allRows()).toEqual(before);
    expect(getRow("a")).toMatchObject({
      parent_session_id: null,
      status: "working",
      logical_slot: 1,
    });
  });

  test("ignores a child identity becoming top-level", () => {
    applyRegistryEvents(db, [start("p"), subStart("c", "p")]);
    applyRegistryEvents(db, [simple("Activity", "c", { at: at(2) })]);
    const before = allRows();

    expect(applyRegistryEvents(db, [start("c", { title: "nope", at: at(3) })])).toEqual(["ignored"]);
    expect(allRows()).toEqual(before);
    expect(getRow("c")).toMatchObject({
      parent_session_id: "p",
      status: "working",
      logical_slot: null,
    });
  });

  test("ignores a prospective cycle when re-parenting an existing child", () => {
    applyRegistryEvents(db, [start("a"), subStart("b", "a"), subStart("c", "b")]);
    const before = allRows();

    // Re-parenting b under its own descendant would close a cycle.
    expect(applyRegistryEvents(db, [subStart("b", "c", { at: at(2) })])).toEqual(["ignored"]);
    expect(allRows()).toEqual(before);
    expect(getRow("b")?.parent_session_id).toBe("a");
  });

  test("commits valid sibling events in one transaction while ignoring the invalid one", () => {
    expect(applyRegistryEvents(db, [start("ok"), subStart("bad", "ghost")])).toEqual(["applied", "ignored"]);
    expect(getRow("ok")?.logical_slot).toBe(1);
    expect(getRow("bad")).toBeNull();
  });

  test("restricts SessionEnd to top-level rows and SubagentStop to child rows", () => {
    applyRegistryEvents(db, [start("p"), subStart("c", "p")]);

    expect(applyRegistryEvents(db, [simple("SessionEnd", "c")])).toEqual(["ignored"]);
    expect(getRow("c")).not.toBeNull();

    expect(applyRegistryEvents(db, [simple("SubagentStop", "p")])).toEqual(["ignored"]);
    expect(getRow("p")).not.toBeNull();

    // SubagentStop cascades through the child's own descendants.
    applyRegistryEvents(db, [subStart("g", "c")]);
    expect(applyRegistryEvents(db, [simple("SubagentStop", "c")])).toEqual(["applied"]);
    expect(getRow("c")).toBeNull();
    expect(getRow("g")).toBeNull();
    expect(getRow("p")).toMatchObject({ parent_session_id: null, logical_slot: 1 });

    expect(applyRegistryEvents(db, [simple("SessionEnd", "p")])).toEqual(["applied"]);
    expect(countRows()).toBe(0);
  });
});

describe("applyEvenerCollectorUpdate", () => {
  test("deletes only omitted Evener children in the authoritative active set", () => {
    applyRegistryEvents(db, [
      start("root", { provider: "evener" }),
      subStart("keep", "root", { provider: "evener" }),
      subStart("stale", "root", { provider: "evener" }),
      start("codex-root", { provider: "codex" }),
      subStart("codex-child", "codex-root", { provider: "codex" }),
    ]);

    expect(applyEvenerCollectorUpdate(db, evenerUpdate([], ["keep"]))).toEqual([]);
    expect(identities()).toEqual([
      "codex:codex-child:codex-root",
      "codex:codex-root:root",
      "evener:keep:root",
      "evener:root:root",
    ]);
  });

  test("does not delete omitted children for a null active set", () => {
    applyRegistryEvents(db, [start("root", { provider: "evener" }), subStart("stale", "root", { provider: "evener" })]);

    expect(applyEvenerCollectorUpdate(db, evenerUpdate([], null))).toEqual([]);
    expect(identities()).toEqual(["evener:root:root", "evener:stale:root"]);
  });

  test("deletes every Evener child for an empty authoritative active set", () => {
    applyRegistryEvents(db, [
      start("root", { provider: "evener" }),
      subStart("child", "root", { provider: "evener" }),
      start("codex-root", { provider: "codex" }),
      subStart("codex-child", "codex-root", { provider: "codex" }),
    ]);

    expect(applyEvenerCollectorUpdate(db, evenerUpdate([], []))).toEqual([]);
    expect(identities()).toEqual(["codex:codex-child:codex-root", "codex:codex-root:root", "evener:root:root"]);
  });

  test("a closed root drops its descendants and preserves unrelated sessions", () => {
    applyRegistryEvents(db, [
      start("root", { provider: "evener" }),
      subStart("child", "root", { provider: "evener" }),
      subStart("grandchild", "child", { provider: "evener" }),
      start("other", { provider: "evener" }),
      subStart("other-child", "other", { provider: "evener" }),
      start("codex-root", { provider: "codex" }),
      subStart("codex-child", "codex-root", { provider: "codex" }),
    ]);
    applyRegistryEvents(db, [simple("Stop", "root", { provider: "evener", at: at(2) })]);

    expect(
      applyEvenerCollectorUpdate(
        db,
        evenerUpdate(
          [
            simple("SubagentStop", "grandchild", { provider: "evener", at: at(3) }),
            simple("SubagentStop", "child", { provider: "evener", at: at(3) }),
            simple("SessionEnd", "root", { provider: "evener", at: at(3) }),
          ],
          null,
        ),
      ),
    ).toEqual(["applied", "applied", "applied"]);
    expect(getRow("root", "evener")).toBeNull();
    expect(getRow("child", "evener")).toBeNull();
    expect(getRow("grandchild", "evener")).toBeNull();
    expect(identities()).toEqual([
      "codex:codex-child:codex-root",
      "codex:codex-root:root",
      "evener:other-child:other",
      "evener:other:root",
    ]);
  });

  test("reconciles an omitted child and a new child in one call", () => {
    applyRegistryEvents(db, [start("root", { provider: "evener" }), subStart("A", "root", { provider: "evener" })]);

    expect(
      applyEvenerCollectorUpdate(db, evenerUpdate([subStart("B", "root", { provider: "evener" })], ["B"])),
    ).toEqual(["applied"]);
    expect(identities()).toEqual(["evener:B:root", "evener:root:root"]);
  });

  test("rolls back event mutations and omission deletions together", () => {
    applyRegistryEvents(db, [
      start("root", { provider: "evener" }),
      subStart("keep", "root", { provider: "evener" }),
      subStart("stale", "root", { provider: "evener" }),
    ]);
    db.exec(`
      CREATE TRIGGER fail_evener_stale_delete
      BEFORE DELETE ON active_sessions
      WHEN OLD.provider = 'evener' AND OLD.session_id = 'stale'
      BEGIN
        SELECT RAISE(ABORT, 'blocked stale deletion');
      END
    `);

    expect(() =>
      applyEvenerCollectorUpdate(
        db,
        evenerUpdate([simple("Activity", "root", { provider: "evener", at: at(2) })], ["keep"]),
      ),
    ).toThrow("blocked stale deletion");
    expect(getRow("root", "evener")).toMatchObject({ status: "idle", updated_at: at(1) });
    expect(identities()).toEqual(["evener:keep:root", "evener:root:root", "evener:stale:root"]);
  });
});

describe("background work outstanding", () => {
  test("keeps Stop at working while background work is outstanding and returns to idle once cleared", () => {
    applyRegistryEvents(db, [start("s1")]);
    applyRegistryEvents(db, [simple("Activity", "s1"), simple("BackgroundWorkStarted", "s1", { at: at(2) })]);
    expect(getRow("s1")).toMatchObject({ status: "working", background_outstanding: 1 });

    // The turn that launched the background shell ends: Stop consults the flag.
    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(3) })]);
    expect(getRow("s1")).toMatchObject({ status: "working", background_outstanding: 1, updated_at: at(3) });

    // A typed prompt turn that starts no new background work keeps working too.
    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(4) }), simple("Stop", "s1", { at: at(5) })]);
    expect(getRow("s1")).toMatchObject({ status: "working", background_outstanding: 1 });

    // The completion signal clears the flag; the wake turn's Stop finally idles.
    applyRegistryEvents(db, [
      simple("Activity", "s1", { at: at(6) }),
      simple("BackgroundWorkCleared", "s1", { at: at(6) }),
    ]);
    expect(getRow("s1")).toMatchObject({ status: "working", background_outstanding: 0 });
    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(7) })]);
    expect(getRow("s1")).toMatchObject({ status: "idle", background_outstanding: 0, updated_at: at(7) });
  });

  test("lets a re-armed watcher chain stay working across consecutive turns", () => {
    applyRegistryEvents(db, [start("s1"), simple("BackgroundWorkStarted", "s1")]);

    // Completion of the old shell, then a replacement starts within the wake
    // turn: the flag never drops, so Stop keeps working throughout.
    applyRegistryEvents(db, [
      simple("Activity", "s1", { at: at(2) }),
      simple("BackgroundWorkCleared", "s1", { at: at(2) }),
      simple("BackgroundWorkStarted", "s1", { at: at(3) }),
      simple("Stop", "s1", { at: at(4) }),
    ]);
    expect(getRow("s1")).toMatchObject({ status: "working", background_outstanding: 1, updated_at: at(4) });
  });

  test("never lets the flag alone change a waiting or error status", () => {
    applyRegistryEvents(db, [start("s1"), simple("Attention", "s1")]);
    applyRegistryEvents(db, [simple("BackgroundWorkStarted", "s1", { at: at(2) })]);
    expect(getRow("s1")).toMatchObject({ status: "waiting", background_outstanding: 1 });

    applyRegistryEvents(db, [simple("StopFailure", "s1", { at: at(3) })]);
    expect(getRow("s1")).toMatchObject({ status: "error", background_outstanding: 1 });
  });

  test("resets a stale background flag when the session starts over", () => {
    applyRegistryEvents(db, [start("s1"), simple("BackgroundWorkStarted", "s1", { at: at(2) })]);
    expect(getRow("s1")?.background_outstanding).toBe(1);

    applyRegistryEvents(db, [start("s1", { at: at(3) })]);
    expect(getRow("s1")).toMatchObject({ status: "idle", background_outstanding: 0 });

    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(4) })]);
    expect(getRow("s1")).toMatchObject({ status: "idle" });
  });

  test("ignores background flag events for unknown sessions and exposes the flag in listSessions", () => {
    expect(applyRegistryEvents(db, [simple("BackgroundWorkStarted", "ghost")])).toEqual(["ignored"]);
    expect(applyRegistryEvents(db, [simple("BackgroundWorkCleared", "ghost")])).toEqual(["ignored"]);
    expect(countRows()).toBe(0);

    applyRegistryEvents(db, [start("s1"), simple("BackgroundWorkStarted", "s1", { at: at(2) })]);
    expect(listSessions(db)).toHaveLength(1);
    expect(listSessions(db)[0]).toMatchObject({
      sessionId: "s1",
      status: "idle",
      backgroundOutstanding: 1,
      updatedAt: at(2),
    });
  });
});

describe("unread ledger", () => {
  test("Stop transitioning to idle marks the session unread", () => {
    applyRegistryEvents(db, [start("s1"), simple("Activity", "s1"), simple("Stop", "s1", { at: at(9) })]);
    expect(getRow("s1")?.unread_since).toBe(at(9));
  });

  test("Stop with background work outstanding stays working and does NOT mark unread", () => {
    applyRegistryEvents(db, [start("s1"), simple("BackgroundWorkStarted", "s1"), simple("Stop", "s1")]);
    expect(getRow("s1")?.status).toBe("working");
    expect(getRow("s1")?.unread_since).toBeNull();
  });

  test("StopFailure marks unread", () => {
    applyRegistryEvents(db, [start("s1"), simple("Activity", "s1"), simple("StopFailure", "s1", { at: at(9) })]);
    expect(getRow("s1")?.unread_since).toBe(at(9));
  });

  test("UserPromptSubmit does NOT clear unread (view, not interaction, marks read)", () => {
    applyRegistryEvents(db, [
      start("s1"),
      simple("Activity", "s1"),
      simple("Stop", "s1"),
      {
        kind: "SessionObserved",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: null,
        transcriptPath: null,
        model: null,
        observedAt: at(20),
      },
      simple("Activity", "s1", { at: at(20) }),
    ]);
    expect(getRow("s1")?.unread_since).not.toBeNull();
  });

  test("reused SessionStart clears unread and refreshes origin", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1")]);
    applyRegistryEvents(db, [{ ...start("s1", { at: at(30) }), origin: { kind: "paseo", ref: "agent-1" } }]);
    const row = getRow("s1");
    expect(row?.unread_since).toBeNull();
    expect(row?.origin_kind).toBe("paseo");
    expect(row?.origin_ref).toBe("agent-1");
  });

  test("acknowledgeSession clears unread and stamps acked_at without touching updated_at", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(9) })]);
    const before = getRow("s1")?.updated_at;
    expect(acknowledgeSession(db, "claude", "s1", at(12))).toBe("applied");
    const row = getRow("s1");
    expect(row?.unread_since).toBeNull();
    expect(row?.acked_at).toBe(at(12)); // the gesture instant
    expect(row?.updated_at).toBe(before);
    expect(acknowledgeSession(db, "claude", "s1", at(13))).toBe("ignored"); // already read
    expect(getRow("s1")?.acked_at).toBe(at(12)); // nothing consumed → no advance
  });

  test("acknowledgeSession retires an error row to idle (the error is a result; viewing settles it)", () => {
    applyRegistryEvents(db, [
      start("s1"),
      simple("BackgroundWorkStarted", "s1"),
      simple("StopFailure", "s1", { at: at(9) }),
    ]);
    const before = getRow("s1")?.updated_at;
    expect(acknowledgeSession(db, "claude", "s1", at(12))).toBe("applied");
    const row = getRow("s1");
    expect(row?.status).toBe("idle");
    expect(row?.status_since).toBe(at(12));
    expect(row?.background_outstanding).toBe(0);
    expect(row?.unread_since).toBeNull();
    expect(row?.acked_at).toBe(at(12)); // the retirement is a consumption: gesture time
    expect(row?.updated_at).toBe(before);
  });

  test("acknowledgeSession leaves a non-error status alone", () => {
    applyRegistryEvents(db, [
      start("s1"),
      simple("Stop", "s1", { at: at(5) }),
      simple("Activity", "s1", { at: at(6) }),
    ]);
    expect(getRow("s1")?.unread_since).toBe(at(5)); // prompts never mark read
    expect(acknowledgeSession(db, "claude", "s1", at(8))).toBe("applied");
    const row = getRow("s1");
    expect(row?.status).toBe("working");
    expect(row?.status_since).toBe(at(6));
    expect(row?.unread_since).toBeNull();
  });
});

describe("done ledger", () => {
  test("Stop transitioning to idle stamps done_since", () => {
    applyRegistryEvents(db, [start("s1"), simple("Activity", "s1"), simple("Stop", "s1", { at: at(9) })]);
    expect(getRow("s1")?.done_since).toBe(at(9));
  });

  test("Stop with background work outstanding does NOT stamp done_since", () => {
    applyRegistryEvents(db, [start("s1"), simple("BackgroundWorkStarted", "s1"), simple("Stop", "s1")]);
    expect(getRow("s1")?.done_since).toBeNull();
  });

  test("a later Stop restamps done_since to the latest result", () => {
    applyRegistryEvents(db, [
      start("s1"),
      simple("Stop", "s1", { at: at(5) }),
      simple("Activity", "s1", { at: at(6) }),
      simple("Stop", "s1", { at: at(9) }),
    ]);
    expect(getRow("s1")?.done_since).toBe(at(9));
  });

  test("StopFailure does not stamp done_since (the error status carries the visibility)", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(9) })]);
    expect(getRow("s1")?.done_since).toBeNull();
  });

  test("SessionStatusObserved settling to idle does not stamp done_since (repair, not a result)", () => {
    applyRegistryEvents(db, [start("s1"), simple("Activity", "s1")]);
    applyRegistryEvents(db, [
      { kind: "SessionStatusObserved", provider: "claude", sessionId: "s1", status: "idle", observedAt: at(9) },
    ]);
    expect(getRow("s1")?.done_since).toBeNull();
  });

  test("reused SessionStart clears done_since (the session starts a new life)", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(getRow("s1")?.done_since).toBe(at(5));
    applyRegistryEvents(db, [start("s1", { at: at(30) })]);
    expect(getRow("s1")?.done_since).toBeNull();
  });

  test("acknowledgeSession clears done_since alongside unread", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(acknowledgeSession(db, "claude", "s1", at(8))).toBe("applied");
    const row = getRow("s1");
    expect(row?.unread_since).toBeNull();
    expect(row?.done_since).toBeNull();
  });

  test("dismissal applies on a done row a dealerboard view already marked read", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: at(5) }),
    ]);
    // A dealerboard view clears the badge; the done card stays on the board.
    expect(viewSession(db, "claude", "s1", at(9))).toBe("applied");
    expect(getRow("s1")?.unread_since).toBeNull();
    expect(getRow("s1")?.done_since).toBe(at(5));
    // The explicit dismissal gesture still applies and takes the card off.
    expect(acknowledgeSession(db, "claude", "s1", at(12))).toBe("applied");
    expect(getRow("s1")?.done_since).toBeNull();
    // A second ack with nothing left to clear reports ignored.
    expect(acknowledgeSession(db, "claude", "s1", at(13))).toBe("ignored");
  });

  test("acknowledgeSession settling an error clears a lingering done_since from an earlier turn", () => {
    applyRegistryEvents(db, [
      start("s1"),
      simple("Stop", "s1", { at: at(5) }),
      simple("Activity", "s1", { at: at(6) }),
      simple("StopFailure", "s1", { at: at(9) }),
    ]);
    expect(getRow("s1")?.done_since).toBe(at(5));
    expect(acknowledgeSession(db, "claude", "s1", at(12))).toBe("applied");
    const row = getRow("s1");
    expect(row?.status).toBe("idle");
    expect(row?.done_since).toBeNull();
  });
});

describe("origin", () => {
  test("SessionStart stores origin; a null new origin keeps the existing one", () => {
    applyRegistryEvents(db, [{ ...start("s1"), origin: { kind: "paseo", ref: "a1" } }]);
    applyRegistryEvents(db, [start("s1", { at: at(30) })]); // no origin evidence
    expect(getRow("s1")?.origin_kind).toBe("paseo");
  });

  test("a fresh terminal origin overrides a stale paseo origin and clears the subagent bit", () => {
    applyRegistryEvents(db, [{ ...start("s1"), origin: { kind: "paseo", ref: "a1" } }]);
    db.run("UPDATE active_sessions SET origin_subagent = 1 WHERE provider = 'claude' AND session_id = 's1'");
    applyRegistryEvents(db, [{ ...start("s1", { at: at(30) }), origin: { kind: "terminal", ref: "ghostty" } }]);
    const row = getRow("s1");
    expect(row?.origin_kind).toBe("terminal");
    expect(row?.origin_subagent).toBe(0);
  });

  const observedWithOrigin = (sessionId: string, origin: SessionOrigin | null, atSecond: number): RegistryEvent => ({
    kind: "SessionObserved",
    provider: "claude",
    sessionId,
    title: null,
    project: null,
    transcriptPath: null,
    model: null,
    origin,
    observedAt: at(atSecond),
  });

  test("SessionObserved refreshes origin on an existing row without touching updated_at", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) })]);
    const before = getRow("s1")?.updated_at;

    expect(applyRegistryEvents(db, [observedWithOrigin("s1", { kind: "terminal", ref: "ghostty" }, 2)])).toEqual([
      "applied",
    ]);
    expect(getRow("s1")).toMatchObject({
      origin_kind: "terminal",
      origin_ref: "ghostty",
      origin_subagent: 0,
      updated_at: before,
    });
  });

  test("an observed origin replaces a stale one and resets the subagent bit (SessionStart semantics)", () => {
    applyRegistryEvents(db, [{ ...start("s1"), origin: { kind: "paseo", ref: "a1" } }]);
    db.run("UPDATE active_sessions SET origin_subagent = 1 WHERE provider = 'claude' AND session_id = 's1'");

    expect(applyRegistryEvents(db, [observedWithOrigin("s1", { kind: "terminal", ref: "ghostty" }, 2)])).toEqual([
      "applied",
    ]);
    expect(getRow("s1")).toMatchObject({ origin_kind: "terminal", origin_ref: "ghostty", origin_subagent: 0 });
  });

  test("a same-origin observed is ignored (honest bookkeeping, no churn)", () => {
    applyRegistryEvents(db, [{ ...start("s1"), origin: { kind: "terminal", ref: "ghostty" } }]);

    expect(applyRegistryEvents(db, [observedWithOrigin("s1", { kind: "terminal", ref: "ghostty" }, 2)])).toEqual([
      "ignored",
    ]);
    expect(getRow("s1")).toMatchObject({ origin_kind: "terminal", origin_ref: "ghostty", origin_subagent: 0 });
  });

  test("fresh SessionStart origin evidence clears a stored origin_parent_ref with the subagent bit", () => {
    applyRegistryEvents(db, [{ ...start("s1"), origin: { kind: "paseo", ref: "a1" } }]);
    db.run(
      "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE provider = 'claude' AND session_id = 's1'",
    );

    applyRegistryEvents(db, [{ ...start("s1", { at: at(30) }), origin: { kind: "terminal", ref: "ghostty" } }]);
    expect(getRow("s1")).toMatchObject({ origin_kind: "terminal", origin_subagent: 0, origin_parent_ref: null });
  });

  test("a fresh observed origin clears origin_parent_ref too", () => {
    applyRegistryEvents(db, [{ ...start("s1"), origin: { kind: "paseo", ref: "a1" } }]);
    db.run(
      "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE provider = 'claude' AND session_id = 's1'",
    );

    expect(applyRegistryEvents(db, [observedWithOrigin("s1", { kind: "terminal", ref: "ghostty" }, 2)])).toEqual([
      "applied",
    ]);
    expect(getRow("s1")).toMatchObject({ origin_kind: "terminal", origin_subagent: 0, origin_parent_ref: null });
  });

  test("a same-origin observed clears a stale origin_parent_ref (parent-only reset)", () => {
    applyRegistryEvents(db, [{ ...start("s1"), origin: { kind: "terminal", ref: "ghostty" } }]);
    db.run("UPDATE active_sessions SET origin_parent_ref = 'agent-0' WHERE provider = 'claude' AND session_id = 's1'");

    expect(applyRegistryEvents(db, [observedWithOrigin("s1", { kind: "terminal", ref: "ghostty" }, 2)])).toEqual([
      "applied",
    ]);
    expect(getRow("s1")).toMatchObject({
      origin_kind: "terminal",
      origin_ref: "ghostty",
      origin_subagent: 0,
      origin_parent_ref: null,
    });
  });

  test("an observed without origin evidence preserves the stored origin and is ignored", () => {
    applyRegistryEvents(db, [{ ...start("s1"), origin: { kind: "terminal", ref: "ghostty" } }]);

    expect(applyRegistryEvents(db, [observedWithOrigin("s1", null, 2)])).toEqual(["ignored"]);
    expect(getRow("s1")).toMatchObject({ origin_kind: "terminal", origin_ref: "ghostty" });
  });
});

describe("repair commands", () => {
  test("clearSession deletes exactly one composite identity plus descendants", () => {
    applyRegistryEvents(db, [
      start("shared", { provider: "claude" }),
      start("shared", { provider: "kimi" }),
      start("other"),
      subStart("c", "shared"),
    ]);
    expect(getRow("shared")?.logical_slot).toBe(1);
    expect(getRow("shared", "kimi")?.logical_slot).toBe(2);
    expect(getRow("other")?.logical_slot).toBe(3);

    expect(clearSession(db, "claude", "shared")).toBe("applied");
    expect(getRow("shared")).toBeNull();
    expect(getRow("c")).toBeNull();
    // The same session id under another provider and every other row survive.
    expect(getRow("shared", "kimi")).toMatchObject({ logical_slot: 2 });
    expect(getRow("other")).toMatchObject({ logical_slot: 3 });

    expect(clearSession(db, "claude", "shared")).toBe("ignored");

    expect(clearAllSessions(db)).toBe("applied");
    expect(countRows()).toBe(0);
  });

  test("clearSession deletes resolved Paseo-linked descendants too", () => {
    applyRegistryEvents(db, [
      { ...start("orchestrator"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("worker-a"), origin: { kind: "paseo", ref: "agent-a" } },
      { ...start("worker-b"), origin: { kind: "paseo", ref: "agent-b" } },
      { ...start("unrelated"), origin: { kind: "paseo", ref: "agent-z" } },
    ]);
    db.run(
      "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id IN ('worker-a', 'worker-b')",
    );
    applyRegistryEvents(db, [simple("Stop", "worker-a", { at: at(5) }), simple("Stop", "worker-b", { at: at(6) })]);

    expect(clearSession(db, "claude", "orchestrator")).toBe("applied");
    // The whole Paseo subtree is gone; unrelated roots survive.
    expect(allRows().map((row) => row.session_id)).toEqual(["unrelated"]);
  });

  test("clearSession follows only resolved links: an ambiguous ref keeps the alleged child", () => {
    applyRegistryEvents(db, [
      { ...start("dup-a"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("dup-b"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("worker"), origin: { kind: "paseo", ref: "agent-1" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'worker'");

    expect(clearSession(db, "claude", "dup-a")).toBe("applied");
    expect(
      allRows()
        .map((row) => row.session_id)
        .sort(),
    ).toEqual(["dup-b", "worker"]);
  });
});

describe("transcript paths", () => {
  test("persists the transcript path on start and refreshes it on restart", () => {
    applyRegistryEvents(db, [start("s1", { transcriptPath: "/Users/test/.claude/projects/p/one.jsonl" })]);
    expect(getRow("s1")?.transcript_path).toBe("/Users/test/.claude/projects/p/one.jsonl");

    applyRegistryEvents(db, [start("s1", { transcriptPath: "/Users/test/.claude/projects/p/two.jsonl", at: at(2) })]);
    expect(getRow("s1")?.transcript_path).toBe("/Users/test/.claude/projects/p/two.jsonl");

    // A late-join insert carries the path too.
    applyRegistryEvents(db, [
      {
        kind: "SessionObserved",
        provider: "codex",
        sessionId: "c1",
        title: null,
        project: "proj",
        transcriptPath: "/Users/test/.codex/sessions/rollout-1.jsonl",
        model: null,
        observedAt: at(3),
      },
    ]);
    expect(getRow("c1", "codex")?.transcript_path).toBe("/Users/test/.codex/sessions/rollout-1.jsonl");

    // An observed event backfills the path on an existing row that predates
    // it, without touching title, project, or updated_at.
    applyRegistryEvents(db, [start("s2", { at: at(4) })]);
    expect(
      applyRegistryEvents(db, [
        {
          kind: "SessionObserved",
          provider: "claude",
          sessionId: "s2",
          title: null,
          project: null,
          transcriptPath: "/Users/test/.claude/projects/p/s2.jsonl",
          model: null,
          observedAt: at(5),
        },
      ]),
    ).toEqual(["applied"]);
    expect(getRow("s2")).toMatchObject({
      title: null,
      project: null,
      transcript_path: "/Users/test/.claude/projects/p/s2.jsonl",
      updated_at: at(4),
    });

    // Status events never disturb the stored path.
    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(6) })]);
    expect(getRow("s1")?.transcript_path).toBe("/Users/test/.claude/projects/p/two.jsonl");
  });
});

describe("model", () => {
  const observed = (
    sessionId: string,
    options: { provider?: Provider; model?: string | null; transcriptPath?: string | null; at?: string } = {},
  ): RegistryEvent => ({
    kind: "SessionObserved",
    provider: options.provider ?? "kimi",
    sessionId,
    title: null,
    project: null,
    transcriptPath: options.transcriptPath ?? null,
    model: options.model ?? null,
    observedAt: options.at ?? at(2),
  });

  test("SessionStart stores a reported model", () => {
    applyRegistryEvents(db, [start("k1", { provider: "kimi", model: "k3" })]);
    expect(getRow("k1", "kimi")?.model).toBe("k3");
    expect(listSessions(db)[0]).toMatchObject({ sessionId: "k1", model: "k3" });
  });

  test("a SessionStart with null model does not clear a stored model", () => {
    applyRegistryEvents(db, [start("k1", { provider: "kimi", model: "k3", at: at(1) })]);
    expect(applyRegistryEvents(db, [start("k1", { provider: "kimi", model: null, at: at(2) })])).toEqual(["applied"]);
    expect(getRow("k1", "kimi")?.model).toBe("k3");
  });

  test("SessionObserved backfills a null model and overwrites on difference", () => {
    // Start with no model reported.
    applyRegistryEvents(db, [start("k1", { provider: "kimi", model: null, at: at(1) })]);
    expect(getRow("k1", "kimi")?.model).toBeNull();

    // A non-null observed model fills the absence.
    expect(applyRegistryEvents(db, [observed("k1", { model: "k3", at: at(2) })])).toEqual(["applied"]);
    expect(getRow("k1", "kimi")?.model).toBe("k3");

    // A non-null, different observed model overwrites (mirrors transcript_path).
    expect(applyRegistryEvents(db, [observed("k1", { model: "other", at: at(3) })])).toEqual(["applied"]);
    expect(getRow("k1", "kimi")?.model).toBe("other");

    // A null observed model is an ignored no-op: null never clears.
    expect(applyRegistryEvents(db, [observed("k1", { model: null, at: at(4) })])).toEqual(["ignored"]);
    expect(getRow("k1", "kimi")?.model).toBe("other");
    expect(getRow("k1", "kimi")?.updated_at).toBe(at(1));
  });
});

describe("updateSessionTitles", () => {
  test("writes only differing titles without touching updated_at", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) }), start("s2", { title: "Kept", at: at(2) })]);

    expect(
      updateSessionTitles(db, [
        { provider: "claude", sessionId: "s1", title: "Resolved title" },
        { provider: "claude", sessionId: "s2", title: "Kept" },
        { provider: "claude", sessionId: "ghost", title: "Nope" },
      ]),
    ).toBe(1);

    expect(getRow("s1")).toMatchObject({ title: "Resolved title", updated_at: at(1) });
    expect(getRow("s2")).toMatchObject({ title: "Kept", updated_at: at(2) });

    // A second identical pass changes nothing.
    expect(updateSessionTitles(db, [{ provider: "claude", sessionId: "s1", title: "Resolved title" }])).toBe(0);
    expect(getRow("s1")).toMatchObject({ title: "Resolved title", updated_at: at(1) });
  });
});

describe("updateSessionModels", () => {
  test("writes only differing models without touching updated_at", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) }), start("s2", { model: "k3", at: at(2) })]);

    expect(
      updateSessionModels(db, [
        { provider: "claude", sessionId: "s1", model: "claude-fable-5" },
        { provider: "claude", sessionId: "s2", model: "k3" },
        { provider: "claude", sessionId: "ghost", model: "nope" },
      ]),
    ).toBe(1);

    expect(getRow("s1")).toMatchObject({ model: "claude-fable-5", updated_at: at(1) });
    expect(getRow("s2")).toMatchObject({ model: "k3", updated_at: at(2) });

    // A second identical pass changes nothing.
    expect(updateSessionModels(db, [{ provider: "claude", sessionId: "s1", model: "claude-fable-5" }])).toBe(0);
    expect(getRow("s1")).toMatchObject({ model: "claude-fable-5", updated_at: at(1) });
  });
});

describe("updateSessionActivityLines", () => {
  test("writes only differing activity lines without touching updated_at", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) }), start("s2", { at: at(2) })]);
    db.run("UPDATE active_sessions SET activity_line = 'Bash ls' WHERE provider = 'claude' AND session_id = 's2'");

    expect(
      updateSessionActivityLines(db, [
        { provider: "claude", sessionId: "s1", activityLine: "Read /src/core/registry.ts" },
        { provider: "claude", sessionId: "s2", activityLine: "Bash ls" },
        { provider: "claude", sessionId: "ghost", activityLine: "Nope" },
      ]),
    ).toBe(1);

    expect(getRow("s1")).toMatchObject({ activity_line: "Read /src/core/registry.ts", updated_at: at(1) });
    expect(getRow("s2")).toMatchObject({ activity_line: "Bash ls", updated_at: at(2) });

    // A second identical pass changes nothing.
    expect(
      updateSessionActivityLines(db, [
        { provider: "claude", sessionId: "s1", activityLine: "Read /src/core/registry.ts" },
      ]),
    ).toBe(0);
    expect(getRow("s1")).toMatchObject({ activity_line: "Read /src/core/registry.ts", updated_at: at(1) });
  });
});

describe("syncPaseoStates", () => {
  const FLAG_AT = "2026-08-06T00:10:00.000Z";

  const paseoState = (overrides: {
    sessionId?: string;
    requiresAttention?: boolean;
    isSubagent?: boolean;
    parentAgentId?: string | null;
    attentionTimestamp?: string | null;
    updatedAt?: string | null;
    archivedAt?: string | null;
    lastStatus?: "initializing" | "idle" | "running" | "error" | "closed" | null;
  }) => ({
    provider: "claude" as const,
    sessionId: overrides.sessionId ?? "s1",
    agentId: "a1",
    requiresAttention: overrides.requiresAttention ?? true,
    isSubagent: overrides.isSubagent ?? false,
    parentAgentId: overrides.parentAgentId ?? null,
    attentionTimestamp: overrides.attentionTimestamp ?? null,
    updatedAt: overrides.updatedAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
    lastStatus: overrides.lastStatus ?? null,
    title: null,
  });

  test("stamps origin and mirrors attention one way: flags set unread, cleared flags are inert", () => {
    applyRegistryEvents(db, [start("s1")]);

    // Flagged: unread adopts the record's attention timestamp.
    const changed = syncPaseoStates(db, [paseoState({ attentionTimestamp: FLAG_AT })]);
    expect(changed).toBe(1);
    expect(getRow("s1")).toMatchObject({
      origin_kind: "paseo",
      origin_ref: "a1",
      origin_subagent: 0,
      unread_since: FLAG_AT,
    });

    // Cleared with a later record write: a passive Paseo view is inert —
    // board ledgers only clear through dealerboard gestures or archive.
    const cleared = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: "2026-08-06T00:12:00.000Z" }),
    ]);
    expect(cleared).toBe(0);
    expect(getRow("s1")?.unread_since).toBe(FLAG_AT);
  });

  test("falls back to updatedAt as the flag time when attentionTimestamp is absent", () => {
    applyRegistryEvents(db, [start("s1")]);
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: null, updatedAt: FLAG_AT })])).toBe(1);
    expect(getRow("s1")?.unread_since).toBe(FLAG_AT);
  });

  test("a cleared record never touches ledgers — stale or fresh (passive views are inert)", () => {
    const stopAt = at(5);
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: stopAt })]);
    expect(getRow("s1")?.unread_since).toBe(stopAt);

    // Stamp origin first so the cleared passes below have nothing else to write.
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: "2026-08-06T00:00:01.000Z" })])).toBe(1);

    // Stale cleared record: inert.
    expect(syncPaseoStates(db, [paseoState({ requiresAttention: false, updatedAt: "2026-08-06T00:00:02.000Z" })])).toBe(
      0,
    );
    // Fresh cleared record: still inert — only a dealerboard gesture or an
    // archive clears board ledgers.
    expect(syncPaseoStates(db, [paseoState({ requiresAttention: false, updatedAt: "2026-08-06T00:00:09.000Z" })])).toBe(
      0,
    );
    expect(getRow("s1")?.unread_since).toBe(stopAt);
    expect(getRow("s1")?.done_since).toBe(stopAt);
  });

  test("a flagged record never overwrites an existing unread timestamp and never touches updated_at", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) }), simple("Stop", "s1", { at: at(5) })]);
    const before = getRow("s1")?.updated_at;

    // Flag time newer than the local Stop: local news is at least as new — keep.
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: FLAG_AT })])).toBe(1);
    expect(getRow("s1")?.unread_since).toBe(at(5));

    // Flag time older than the local Stop: keep the first-news timestamp (no regress, no churn).
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: "2026-08-06T00:00:02.000Z" })])).toBe(0);
    expect(getRow("s1")?.unread_since).toBe(at(5));
    expect(getRow("s1")?.updated_at).toBe(before);
  });

  test("missing timestamps skip the unread write entirely but still stamp origin", () => {
    applyRegistryEvents(db, [start("s1")]);

    // Flagged with no timestamps at all: origin lands, unread stays null.
    expect(syncPaseoStates(db, [paseoState({})])).toBe(1);
    expect(getRow("s1")).toMatchObject({ origin_kind: "paseo", origin_ref: "a1", unread_since: null });

    // Cleared with no updatedAt is inert like every cleared record.
    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(5) })]);
    expect(syncPaseoStates(db, [paseoState({ requiresAttention: false })])).toBe(0);
    expect(getRow("s1")?.unread_since).toBe(at(5));
  });

  test("an acked row never resurrects unread from a stale flagged record", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: at(5) }),
    ]);
    expect(acknowledgeSession(db, "claude", "s1", at(8))).toBe("applied");
    expect(getRow("s1")?.unread_since).toBeNull();

    // The record still flags attention raised before the ack: the acked_at
    // watermark suppresses the resurrection (the old one-sync-cycle window).
    const staleFlag = "2026-08-06T00:00:02.000Z";
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: staleFlag })])).toBe(0);
    expect(getRow("s1")?.unread_since).toBeNull();

    // A flag raised after the ack is fresh news and re-flags normally.
    const freshFlag = "2026-08-06T00:00:09.000Z";
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: freshFlag })])).toBe(1);
    expect(getRow("s1")?.unread_since).toBe(freshFlag);
  });

  test("an archived agent behaves as viewed: clears unread despite a live attention flag, never sets it", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(getRow("s1")?.unread_since).toBe(at(5));

    // Archived after the local Stop while requiresAttention is still true:
    // archiving is the user's terminal gesture, so unread clears.
    const archived = paseoState({ attentionTimestamp: FLAG_AT, archivedAt: "2026-08-06T00:00:09.000Z" });
    expect(syncPaseoStates(db, [archived])).toBe(1);
    expect(getRow("s1")?.unread_since).toBeNull();

    // The still-flagged archived record on a later pass must not resurrect.
    expect(syncPaseoStates(db, [archived])).toBe(0);
    expect(getRow("s1")?.unread_since).toBeNull();

    // Local news newer than the archive stamp is kept: a stale archive is
    // not proof the user saw the newer result.
    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(20) })]);
    expect(syncPaseoStates(db, [archived])).toBe(0);
    expect(getRow("s1")?.unread_since).toBe(at(20));
  });

  test("an archive stamp newer than updatedAt is the clear-proof time", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);

    // updatedAt predates the Stop (stale alone) but archivedAt postdates it:
    // the later of the two proves the viewing.
    const archived = paseoState({
      requiresAttention: false,
      updatedAt: at(2),
      archivedAt: at(9),
    });
    expect(syncPaseoStates(db, [archived])).toBe(1);
    expect(getRow("s1")?.unread_since).toBeNull();
  });

  test("an archived record retires an error row (archiving is the user's terminal gesture)", () => {
    applyRegistryEvents(db, [
      start("s1"),
      simple("BackgroundWorkStarted", "s1"),
      simple("StopFailure", "s1", { at: at(9) }),
    ]);
    const before = getRow("s1")?.updated_at;

    const archivedAt = "2026-08-06T00:11:00.000Z";
    const changed = syncPaseoStates(db, [
      paseoState({
        requiresAttention: false,
        updatedAt: "2026-08-06T00:10:00.000Z",
        archivedAt,
        lastStatus: "error",
      }),
    ]);
    expect(changed).toBeGreaterThan(0);
    const row = getRow("s1");
    expect(row?.status).toBe("idle");
    expect(row?.status_since).toBe(archivedAt); // the later of archivedAt/updatedAt
    expect(row?.background_outstanding).toBe(0);
    expect(row?.unread_since).toBeNull();
    expect(row?.updated_at).toBe(before);
  });

  test("a cleared record without an archive keeps an error row's failure visible", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(9) })]);
    // The passive view is inert: the failure stays up with its unread badge.
    syncPaseoStates(db, [paseoState({ requiresAttention: false, updatedAt: "2026-08-06T00:10:00.000Z" })]);
    expect(getRow("s1")).toMatchObject({ status: "error", unread_since: at(9) });
  });

  test("a stale archived record does not retire a newer error", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(9) })]);
    // Archive stamped before the failure is not proof the user saw this error.
    syncPaseoStates(db, [paseoState({ requiresAttention: false, updatedAt: at(2), archivedAt: at(3) })]);
    expect(getRow("s1")).toMatchObject({ status: "error", unread_since: at(9) });
  });

  test("acknowledgeSession retires an error row a dealerboard view already marked read", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(9) })]);
    // A dealerboard view clears the badge; the failure stays up.
    expect(viewSession(db, "claude", "s1", "2026-08-06T00:10:00.000Z")).toBe("applied");
    expect(getRow("s1")).toMatchObject({ status: "error", unread_since: null });

    expect(getRow("s1")?.acked_at).toBe("2026-08-06T00:10:00.000Z"); // the view's gesture time
    const dismissedAt = "2026-08-06T00:12:00.000Z";
    expect(acknowledgeSession(db, "claude", "s1", dismissedAt)).toBe("applied");
    // Retiring the error is itself a consumption: acked_at advances to the
    // dismiss gesture's instant.
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: dismissedAt, acked_at: dismissedAt });
  });

  test("is a no-op when nothing differs (the reprojection fast-path stays quiet)", () => {
    applyRegistryEvents(db, [start("s1")]);

    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: FLAG_AT })])).toBe(1);
    // Identical state on a later pass: unread keeps its flag-time timestamp
    // and the difference guard suppresses the update entirely.
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: FLAG_AT })])).toBe(0);

    const read = paseoState({ requiresAttention: false, updatedAt: "2026-08-06T00:13:00.000Z" });
    // A passive view is inert: the repeated cleared record never counts.
    expect(syncPaseoStates(db, [read])).toBe(0);
    expect(syncPaseoStates(db, [read])).toBe(0);
    expect(getRow("s1")?.updated_at).toBe(at(1));
  });

  test("marks subagents, restricts to top-level rows, and skips unknown identities", () => {
    applyRegistryEvents(db, [start("s1"), subStart("c1", "s1")]);

    const changed = syncPaseoStates(db, [
      paseoState({ isSubagent: true, attentionTimestamp: FLAG_AT }),
      // A child identity is out of scope: the sync touches top-level rows only.
      paseoState({ sessionId: "c1", attentionTimestamp: FLAG_AT }),
      // No row is ever created for an unknown identity.
      paseoState({ sessionId: "missing", attentionTimestamp: FLAG_AT }),
    ]);
    expect(changed).toBe(1);
    expect(getRow("s1")?.origin_subagent).toBe(1);
    expect(getRow("c1")).toMatchObject({ origin_kind: null, unread_since: null });
    expect(getRow("missing")).toBeNull();
    expect(countRows()).toBe(2);
  });

  test("stamps the dispatching agent's id as origin_parent_ref and clears it when the record goes top-level", () => {
    applyRegistryEvents(db, [start("s1")]);

    expect(
      syncPaseoStates(db, [paseoState({ isSubagent: true, parentAgentId: "agent-0", attentionTimestamp: FLAG_AT })]),
    ).toBe(1);
    expect(getRow("s1")).toMatchObject({ origin_subagent: 1, origin_parent_ref: "agent-0" });

    // Identical state on the next pass: the difference guard covers the new column.
    expect(
      syncPaseoStates(db, [paseoState({ isSubagent: true, parentAgentId: "agent-0", attentionTimestamp: FLAG_AT })]),
    ).toBe(0);

    // The record loses its parent: both subagent marks clear in one write.
    expect(syncPaseoStates(db, [paseoState({ isSubagent: false, attentionTimestamp: FLAG_AT })])).toBe(1);
    expect(getRow("s1")).toMatchObject({ origin_subagent: 0, origin_parent_ref: null });
  });

  test("the cleared-flag branch keeps origin_parent_ref in sync too", () => {
    applyRegistryEvents(db, [start("s1")]);
    expect(
      syncPaseoStates(db, [paseoState({ isSubagent: true, parentAgentId: "agent-0", attentionTimestamp: FLAG_AT })]),
    ).toBe(1);

    // Viewed in Paseo (cleared flag): the passive view never touches
    // ledgers, but a changed parent ref still re-stamps origin.
    expect(
      syncPaseoStates(db, [
        paseoState({
          requiresAttention: false,
          isSubagent: true,
          parentAgentId: "agent-1",
          updatedAt: "2026-08-06T00:12:00.000Z",
        }),
      ]),
    ).toBe(1);
    expect(getRow("s1")).toMatchObject({ unread_since: FLAG_AT, origin_parent_ref: "agent-1" });
  });

  test("retires a stuck working row when a settled record postdates its last hook", () => {
    applyRegistryEvents(db, [start("s1"), simple("Activity", "s1", { at: at(3) })]);

    // A running record never settles anything; this pass only stamps origin.
    expect(
      syncPaseoStates(db, [paseoState({ requiresAttention: false, lastStatus: "running", updatedAt: at(4) })]),
    ).toBe(1);
    expect(getRow("s1")?.status).toBe("working");

    // The agent settled after the row's last hook: the missed Stop is repaired.
    expect(syncPaseoStates(db, [paseoState({ requiresAttention: false, lastStatus: "idle", updatedAt: at(6) })])).toBe(
      1,
    );
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(6), updated_at: at(3) });

    // The same settled record on a later pass changes nothing further.
    expect(syncPaseoStates(db, [paseoState({ requiresAttention: false, lastStatus: "idle", updatedAt: at(6) })])).toBe(
      0,
    );
  });

  test("a settled record at or before the row's last hook never settles it", () => {
    applyRegistryEvents(db, [start("s1"), simple("Activity", "s1", { at: at(5) })]);

    // Older record: a new turn may have started since Paseo last wrote.
    syncPaseoStates(db, [paseoState({ requiresAttention: false, lastStatus: "idle", updatedAt: at(4) })]);
    expect(getRow("s1")?.status).toBe("working");

    // Equal stamps are ambiguous ordering: the settle needs strictly newer news.
    syncPaseoStates(db, [paseoState({ requiresAttention: false, lastStatus: "idle", updatedAt: at(5) })]);
    expect(getRow("s1")?.status).toBe("working");
  });

  test("a settled record leaves a background-armed row working", () => {
    applyRegistryEvents(db, [
      start("s1"),
      simple("Activity", "s1", { at: at(3) }),
      simple("BackgroundWorkStarted", "s1", { at: at(4) }),
    ]);
    syncPaseoStates(db, [paseoState({ requiresAttention: false, lastStatus: "idle", updatedAt: at(6) })]);
    expect(getRow("s1")?.status).toBe("working");
  });

  test("settles a background-armed row only past the caller's grace cutoff", () => {
    applyRegistryEvents(db, [
      start("s1"),
      simple("Activity", "s1", { at: at(3) }),
      simple("BackgroundWorkStarted", "s1", { at: at(4) }),
      // The Stop keeps the row working: a background shell is outstanding.
      simple("Stop", "s1", { at: at(5) }),
    ]);
    expect(getRow("s1")).toMatchObject({ status: "working", background_outstanding: 1 });

    const settledRecord = paseoState({ requiresAttention: false, lastStatus: "idle", updatedAt: at(6) });

    // The row's last hook is not older than the cutoff yet: the background
    // claim stands and the row keeps working.
    syncPaseoStates(db, [settledRecord], at(4));
    expect(getRow("s1")?.status).toBe("working");

    // Past the cutoff the lost completion is presumed: retire and disarm, so
    // a later Stop cannot re-stick the row.
    expect(syncPaseoStates(db, [settledRecord], at(8))).toBe(1);
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(6), background_outstanding: 0 });
  });

  test("retires a stuck waiting row when the agent closed", () => {
    applyRegistryEvents(db, [start("s1"), simple("Attention", "s1", { at: at(3) })]);
    expect(getRow("s1")?.status).toBe("waiting");

    syncPaseoStates(db, [paseoState({ requiresAttention: false, lastStatus: "closed", updatedAt: at(6) })]);
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(6) });
  });

  test("never settles an error row: the failure stays visible", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(3) })]);
    syncPaseoStates(db, [paseoState({ requiresAttention: false, lastStatus: "idle", updatedAt: at(6) })]);
    expect(getRow("s1")?.status).toBe("error");
  });

  test("a record without a settled status or a timestamp never settles", () => {
    applyRegistryEvents(db, [start("s1"), simple("Activity", "s1", { at: at(3) })]);

    syncPaseoStates(db, [paseoState({ requiresAttention: false, lastStatus: null, updatedAt: at(6) })]);
    expect(getRow("s1")?.status).toBe("working");

    syncPaseoStates(db, [paseoState({ requiresAttention: false, lastStatus: "idle", updatedAt: null })]);
    expect(getRow("s1")?.status).toBe("working");
  });

  test("a fresh cleared record leaves both ledgers untouched (passive views are inert)", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: at(5) }),
    ]);
    expect(syncPaseoStates(db, [paseoState({ requiresAttention: false, updatedAt: at(9) })])).toBe(0);
    expect(getRow("s1")?.unread_since).toBe(at(5));
    expect(getRow("s1")?.done_since).toBe(at(5));
  });

  test("an archived record clears done_since (archiving is the user's terminal gesture)", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    const archived = paseoState({ requiresAttention: false, archivedAt: "2026-08-06T00:00:09.000Z" });
    expect(syncPaseoStates(db, [archived])).toBe(1);
    expect(getRow("s1")?.done_since).toBeNull();
    // The same archived record on a later pass has nothing left to clear.
    expect(syncPaseoStates(db, [archived])).toBe(0);
  });

  test("a stale archived record does not clear a newer done_since", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    // The archive predates the Stop: the freshness guard keeps the result,
    // and an archived record never stamps origin — the pass changes nothing.
    expect(
      syncPaseoStates(db, [paseoState({ requiresAttention: false, archivedAt: "2026-08-06T00:00:02.000Z" })]),
    ).toBe(0);
    expect(getRow("s1")?.done_since).toBe(at(5));
  });

  test("the settled-record repair stamps unread+done so the repaired settlement badges", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Activity", "s1", { at: at(2) }),
    ]);
    const changed = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: at(9), lastStatus: "idle" }),
    ]);
    expect(changed).toBe(1); // exactly the settlement repair; origin already matches
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      unread_since: at(9),
      done_since: at(9),
      viewed_since: null,
    });
  });

  test("an archived settled record retires without stamping done_since", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) }), simple("Activity", "s1", { at: at(2) })]);
    expect(
      syncPaseoStates(db, [paseoState({ requiresAttention: false, lastStatus: "running", updatedAt: at(3) })]),
    ).toBe(1);
    expect(
      syncPaseoStates(db, [
        paseoState({
          requiresAttention: false,
          lastStatus: "idle",
          updatedAt: "2026-08-06T00:10:00.000Z",
          archivedAt: "2026-08-06T00:10:00.000Z",
        }),
      ]),
    ).toBe(2); // the archive un-stamps origin; the repair retires the row
    const row = getRow("s1");
    expect(row?.status).toBe("idle");
    expect(row?.done_since).toBeNull();
  });

  test("un-stamps a row abandoned by provider-session rotation so the agent's ref has one carrier", () => {
    // The agent's provider session rotated s1 → s2 without a SessionEnd for
    // s1, so both rows carry the hook-stamped ref — the duplicate that makes
    // the projection roll-up drop the ref as ambiguous.
    applyRegistryEvents(db, [
      start("s1", { title: "Old life", model: "m1", at: at(1), origin: { kind: "paseo", ref: "a1" } }),
      simple("Activity", "s1", { at: at(3) }),
      simple("Stop", "s1", { at: at(5) }),
      start("s2", { at: at(6), origin: { kind: "paseo", ref: "a1" } }),
    ]);

    const changed = syncPaseoStates(db, [
      paseoState({ sessionId: "s2", isSubagent: true, parentAgentId: "agent-0", attentionTimestamp: FLAG_AT }),
    ]);

    // The current joined row carries the agent's metadata.
    expect(getRow("s2")).toMatchObject({
      origin_kind: "paseo",
      origin_ref: "a1",
      origin_subagent: 1,
      origin_parent_ref: "agent-0",
    });
    // The abandoned row stays — not deleted, not acknowledged — with its
    // origin stamps cleared and retired to idle: its ledger, title, model,
    // slot, and prune lease (updated_at) keep their values.
    expect(getRow("s1")).toMatchObject({
      origin_kind: null,
      origin_ref: null,
      origin_subagent: 0,
      origin_parent_ref: null,
      status: "idle",
      title: "Old life",
      model: "m1",
      logical_slot: 1,
      unread_since: at(5),
      status_since: at(5),
      updated_at: at(5),
    });
    expect(countRows()).toBe(2);
    expect(changed).toBe(2);

    // An identical later pass changes nothing (the reprojection fast-path stays quiet).
    expect(
      syncPaseoStates(db, [
        paseoState({ sessionId: "s2", isSubagent: true, parentAgentId: "agent-0", attentionTimestamp: FLAG_AT }),
      ]),
    ).toBe(0);
  });

  test("retires a read active row abandoned by provider-session rotation", () => {
    applyRegistryEvents(db, [
      start("s1", { at: at(1), origin: { kind: "paseo", ref: "a1" } }),
      simple("Activity", "s1", { at: at(3) }),
      start("s2", { at: at(6) }),
    ]);

    expect(getRow("s1")).toMatchObject({ status: "working", unread_since: null, status_since: at(3) });
    db.run("UPDATE active_sessions SET background_outstanding = 1 WHERE provider = 'claude' AND session_id = 's1'");

    expect(syncPaseoStates(db, [paseoState({ sessionId: "s2", requiresAttention: false, updatedAt: at(7) })])).toBe(2);

    expect(getRow("s1")).toMatchObject({
      origin_kind: null,
      origin_ref: null,
      status: "idle",
      background_outstanding: 0,
      unread_since: null,
      status_since: at(7),
      updated_at: at(3),
    });
    expect(getRow("s2")).toMatchObject({ origin_kind: "paseo", origin_ref: "a1" });
  });

  test("the rotation cleanup never touches other agents' refs or ref-free rows", () => {
    applyRegistryEvents(db, [
      start("s1", { at: at(1), origin: { kind: "paseo", ref: "b1" } }),
      start("s2", { at: at(2), origin: { kind: "paseo", ref: "a1" } }),
      start("s3", { at: at(3) }),
    ]);

    // No duplicate exists: the current joined row is a1's only carrier, so the
    // sync writes exactly the attention mirror and nothing else.
    expect(syncPaseoStates(db, [paseoState({ sessionId: "s2", attentionTimestamp: FLAG_AT })])).toBe(1);
    expect(getRow("s1")).toMatchObject({ origin_kind: "paseo", origin_ref: "b1" });
    expect(getRow("s2")).toMatchObject({ origin_kind: "paseo", origin_ref: "a1", unread_since: FLAG_AT });
    expect(getRow("s3")).toMatchObject({ origin_kind: null, origin_ref: null });
  });

  test("an archived record cascades the ledger clear (incl. viewed_since) to Paseo descendants", () => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "a1" } },
      { ...start("child"), origin: { kind: "paseo", ref: "a2" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'a1' WHERE session_id = 'child'");
    applyRegistryEvents(db, [simple("Stop", "parent", { at: at(5) }), simple("Stop", "child", { at: at(6) })]);
    viewSession(db, "claude", "child", at(7)); // child has a live view clock too

    const archived = syncPaseoStates(db, [
      paseoState({ sessionId: "parent", requiresAttention: false, updatedAt: at(8), archivedAt: at(9) }),
    ]);
    expect(archived).toBeGreaterThan(0);
    expect(getRow("parent")).toMatchObject({ unread_since: null, done_since: null, viewed_since: null });
    expect(getRow("child")).toMatchObject({ unread_since: null, done_since: null, viewed_since: null });
    expect(countRows()).toBe(2); // archive clears ledgers, never deletes rows
  });

  test("archiving unlinks the agent: active descendants become orphan roots", () => {
    // Spec edge case "Parent archived with active descendants": the parent's
    // ledgers clear and its card goes; still-active children render as
    // orphan roots instead of promoting the archived parent back onto the
    // board through the status roll-up.
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "a1" } },
      { ...start("child"), origin: { kind: "paseo", ref: "a2" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'a1' WHERE session_id = 'child'");
    applyRegistryEvents(db, [simple("Activity", "child", { at: at(5) })]); // child is working

    const archived = syncPaseoStates(db, [
      paseoState({ sessionId: "parent", requiresAttention: false, updatedAt: at(8), archivedAt: at(9) }),
      // The child's own live record still reports its parent agent.
      {
        ...paseoState({
          sessionId: "child",
          isSubagent: true,
          parentAgentId: "a1",
          requiresAttention: false,
          updatedAt: at(8),
        }),
        agentId: "a2",
      },
    ]);
    expect(archived).toBeGreaterThan(0);
    // The archived row loses its origin representation entirely — that is
    // what breaks the link (the child's own record still names a1).
    expect(getRow("parent")).toMatchObject({ origin_kind: null, origin_ref: null, origin_subagent: 0 });
    expect(getRow("child")).toMatchObject({ origin_kind: "paseo", origin_ref: "a2", origin_parent_ref: "a1" });
  });

  test("a stale archive un-stamps the parent but never clears newer descendant news", () => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "a1" } },
      { ...start("child"), origin: { kind: "paseo", ref: "a2" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'a1' WHERE session_id = 'child'");
    applyRegistryEvents(db, [simple("Stop", "child", { at: at(12) })]);

    const archived = syncPaseoStates(db, [
      paseoState({ sessionId: "parent", requiresAttention: false, updatedAt: at(8), archivedAt: at(9) }),
    ]);
    // The archive is terminal for the parent's representation of the agent:
    // its origin un-stamps, which is a counted change. But the freshness
    // guard (clearTime at(9) is not newer than the child's at(12)) protects
    // the result that landed after the archive.
    expect(archived).toBeGreaterThan(0);
    expect(getRow("parent")).toMatchObject({ origin_kind: null, origin_ref: null, origin_subagent: 0 });
    expect(getRow("child")).toMatchObject({ unread_since: at(12), done_since: at(12) });
  });

  test("a fresh attention flag that lands an unread stamp cancels the view clock", () => {
    // The card was viewed (clock running); a fresh flag is new news — the
    // card is unviewed again, so the expiry sweep must never see a row with
    // an unread stamp AND a live view clock.
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: at(5) }),
    ]);
    viewSession(db, "claude", "s1", at(8));
    const changed = syncPaseoStates(db, [paseoState({ attentionTimestamp: at(9) })]);
    expect(changed).toBe(1);
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), viewed_since: null });
  });

  test("a flag that lands an unread stamp also holds the card: done_since adopts the flag time", () => {
    // An idle row with no result of its own: the flag is the result the
    // user must process, so it holds the card until dismissed or expired —
    // not just until the badge is cleared.
    applyRegistryEvents(db, [{ ...start("s1"), origin: { kind: "paseo", ref: "a1" } }]);
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: FLAG_AT })])).toBe(1);
    expect(getRow("s1")).toMatchObject({ unread_since: FLAG_AT, done_since: FLAG_AT });
  });

  test("a flag-held card survives its view and is released by the expiry sweep", () => {
    applyRegistryEvents(db, [{ ...start("s1"), origin: { kind: "paseo", ref: "a1" } }]);
    syncPaseoStates(db, [paseoState({ attentionTimestamp: FLAG_AT })]);
    const viewedAt = "2026-08-06T01:00:00.000Z";
    expect(viewSession(db, "claude", "s1", viewedAt)).toBe("applied");
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: FLAG_AT, viewed_since: viewedAt });
    // The projection still publishes the card: the done hold keeps it.
    expect(readProjection(db).sessions.map((session) => session.sessionId)).toEqual(["s1"]);
    // 24h after the view the sweep dismisses it, and the card leaves.
    expect(sweepExpiredResults(db, "2026-08-07T01:00:00.000Z", "2026-08-07T01:00:30.000Z")).toBe(1);
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: null, viewed_since: null });
    expect(readProjection(db).sessions).toEqual([]);
  });

  test("a flag on a row already holding done keeps the earlier done stamp", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: at(5) }),
    ]);
    viewSession(db, "claude", "s1", at(8));
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: at(9) })])).toBe(1);
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(5), viewed_since: null });
  });

  test("a flag that lands no unread stamp stamps no done hold either", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: at(5) }),
    ]);
    expect(acknowledgeSession(db, "claude", "s1", at(8))).toBe("applied");
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: null });
    // Stale flag (predates the ack): suppressed — no unread, no done.
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: at(2) })])).toBe(0);
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: null });
  });

  test("the settled-record repair never resurrects a result dismissed after the record", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Activity", "s1", { at: at(2) }),
    ]);
    // The record was written at at(5)…
    // …but the user's dismiss lands after it, and the sync processes later.
    applyRegistryEvents(db, [simple("StopFailure", "s1", { at: at(4) })]);
    viewSession(db, "claude", "s1", at(6));
    expect(acknowledgeSession(db, "claude", "s1", at(7))).toBe("applied");
    const changed = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: at(5), lastStatus: "idle" }),
    ]);
    // The row is idle now, so the settle guard (status IN working/waiting)
    // already refuses; this pins that nothing re-stamps either ledger.
    expect(changed).toBe(0);
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: null });
  });

  test("the repair stamps a missed result whose record postdates the user's gesture (no suppression)", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Activity", "s1", { at: at(2) }),
    ]);
    // A paseo flag raised unread at at(3); the user dismissed it at at(6) —
    // acked_at advances to the gesture instant.
    syncPaseoStates(db, [paseoState({ attentionTimestamp: at(3) })]);
    expect(acknowledgeSession(db, "claude", "s1", at(6))).toBe("applied");
    expect(getRow("s1")?.acked_at).toBe(at(6));
    // The settled record reports the turn finished at at(7): after the
    // gesture, so the missed result must surface, not be suppressed.
    const changed = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: at(7), lastStatus: "idle" }),
    ]);
    expect(changed).toBe(1);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      unread_since: at(7),
      done_since: at(7),
      viewed_since: null,
    });
  });

  test("the repair retires without stamping when the record predates the user's gesture", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Activity", "s1", { at: at(2) }),
    ]);
    syncPaseoStates(db, [paseoState({ attentionTimestamp: at(3) })]);
    expect(acknowledgeSession(db, "claude", "s1", at(6))).toBe("applied");
    expect(getRow("s1")?.acked_at).toBe(at(6));
    // A record written at at(5) — before the dismiss gesture — still proves
    // the turn ended (retirement applies), but whatever it reports the user
    // had already dismissed: no ledger write.
    const changed = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: at(5), lastStatus: "idle" }),
    ]);
    expect(changed).toBe(1);
    expect(getRow("s1")).toMatchObject({ status: "idle", unread_since: null, done_since: null, viewed_since: null });
  });

  test("a flag trailing the local Stop by milliseconds cannot resurrect a just-viewed card", () => {
    // Paseo stamps attention for a turn-end slightly AFTER the local Stop.
    // The user views the card before the flag syncs: the next sync must
    // neither re-badge the card nor cancel its view clock.
    const stopAt = "2026-08-06T00:00:01.000Z";
    const trailingFlag = "2026-08-06T00:00:01.350Z";
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: stopAt }),
    ]);
    expect(viewSession(db, "claude", "s1", at(5))).toBe("applied");
    expect(getRow("s1")).toMatchObject({ unread_since: null, viewed_since: at(5), acked_at: at(5) });
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: trailingFlag })])).toBe(0);
    expect(getRow("s1")).toMatchObject({ unread_since: null, viewed_since: at(5), done_since: stopAt });
  });

  test("a flag trailing the local Stop cannot resurrect a flick-dismissed card", () => {
    const stopAt = "2026-08-06T00:00:01.000Z";
    const trailingFlag = "2026-08-06T00:00:01.350Z";
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: stopAt }),
    ]);
    expect(acknowledgeSession(db, "claude", "s1", at(5), { unreadSince: stopAt })).toBe("applied");
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: null, acked_at: at(5) });
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: trailingFlag })])).toBe(0);
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: null });
    // A flag raised after the gesture is fresh news and re-badges (holding the card).
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: at(9) })])).toBe(1);
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(9) });
  });

  test("the repair never regresses a flag-stamped unread newer than the settle", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Activity", "s1", { at: at(2) }),
    ]);
    // A flag raises unread at at(9) — news newer than the row's last hook —
    // and holds the card with a done stamp at the same instant.
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: at(9) })])).toBe(1);
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(9) });

    // The settled record at at(5) postdates the row's last hook (so the
    // retirement applies) but predates the unread stamp: the settle is
    // stale news — no ledger write, and the view clock stays untouched.
    const changed = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: at(5), lastStatus: "idle" }),
    ]);
    expect(changed).toBe(1); // the retirement alone
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      status_since: at(5),
      unread_since: at(9),
      done_since: at(9),
      viewed_since: null,
    });
  });

  test("the rotation cleanup never clears ledgers (a retired carrier keeps its results)", () => {
    applyRegistryEvents(db, [
      { ...start("old-carrier"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "old-carrier", { at: at(5) }),
    ]);
    // The agent rotated to a new provider session; the old carrier un-stamps.
    const changed = syncPaseoStates(db, [
      {
        provider: "codex",
        sessionId: "new-carrier",
        agentId: "a1",
        requiresAttention: false,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: at(9),
        archivedAt: null,
        lastStatus: null,
        title: null,
      },
    ]);
    expect(changed).toBeGreaterThan(0);
    expect(getRow("old-carrier")).toMatchObject({
      origin_kind: null,
      origin_ref: null,
      status: "idle",
      unread_since: at(5), // the results survive the rotation
      done_since: at(5),
    });
  });
});

describe("pruneStaleSessions", () => {
  test("deletes top-level rows older than the cutoff and cascades to children", () => {
    applyRegistryEvents(db, [
      start("old", { at: "2026-08-01T00:00:00.000Z" }),
      subStart("old-child", "old", { at: "2026-08-01T00:00:01.000Z" }),
      start("fresh", { at: "2026-08-06T00:00:00.000Z" }),
    ]);

    expect(pruneStaleSessions(db, "2026-08-05T00:00:00.000Z")).toBe(1);
    expect(getRow("old")).toBeNull();
    expect(getRow("old-child")).toBeNull();
    expect(getRow("fresh")).toMatchObject({ logical_slot: 2 });

    // A second pass at the same cutoff is a no-op.
    expect(pruneStaleSessions(db, "2026-08-05T00:00:00.000Z")).toBe(0);
    expect(countRows()).toBe(1);
  });

  test("keeps a stale top-level row whose subagent is still inside the lease", () => {
    applyRegistryEvents(db, [
      start("old", { at: "2026-08-01T00:00:00.000Z" }),
      subStart("old-child", "old", { at: "2026-08-01T00:00:01.000Z" }),
    ]);
    // The subagent keeps producing hooks long after the parent's own went quiet.
    applyRegistryEvents(db, [simple("Activity", "old-child", { at: "2026-08-06T00:00:00.000Z" })]);

    expect(pruneStaleSessions(db, "2026-08-05T00:00:00.000Z")).toBe(0);
    expect(getRow("old")).not.toBeNull();
    expect(getRow("old-child")).not.toBeNull();
  });

  test("keeps a stale top-level row when a deeper descendant is still inside the lease", () => {
    applyRegistryEvents(db, [
      start("root", { at: "2026-08-01T00:00:00.000Z" }),
      subStart("mid", "root", { at: "2026-08-01T00:00:01.000Z" }),
      subStart("leaf", "mid", { at: "2026-08-06T00:00:00.000Z" }),
    ]);

    expect(pruneStaleSessions(db, "2026-08-05T00:00:00.000Z")).toBe(0);
    expect(countRows()).toBe(3);
  });

  test("a live session pruned by mistake late-joins through SessionObserved", () => {
    applyRegistryEvents(db, [start("s1", { at: "2026-08-01T00:00:00.000Z" })]);
    expect(pruneStaleSessions(db, "2026-08-05T00:00:00.000Z")).toBe(1);
    expect(countRows()).toBe(0);

    expect(
      applyRegistryEvents(db, [
        {
          kind: "SessionObserved",
          provider: "claude",
          sessionId: "s1",
          title: null,
          project: "proj",
          transcriptPath: null,
          model: null,
          observedAt: at(1),
        },
        simple("Activity", "s1", { at: at(2) }),
      ]),
    ).toEqual(["applied", "applied"]);
    expect(getRow("s1")).toMatchObject({ status: "working", logical_slot: 1 });
  });

  test("zcode rows prune on the 1h lease while other providers keep the 24h one", () => {
    const T0 = "2026-08-06T00:00:00.000Z";
    const nowMs = Date.parse(T0) + 2 * 60 * 60 * 1000; // "now" is 2h after T0
    const thirtyMinutesAgo = new Date(nowMs - 30 * 60 * 1000).toISOString();

    applyRegistryEvents(db, [
      start("z-old", { provider: "zcode", at: T0 }), // 2h stale — past both leases
      start("c-old", { provider: "claude", at: T0 }), // 2h stale — inside the 24h lease
      start("z-fresh", { provider: "zcode", at: thirtyMinutesAgo }), // inside the 1h lease
    ]);

    const defaultCutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    const zcodeCutoff = new Date(nowMs - 60 * 60 * 1000).toISOString();

    expect(pruneStaleSessions(db, defaultCutoff, zcodeCutoff)).toBe(1);
    expect(listSessions(db).map((session) => session.sessionId)).toEqual(["c-old", "z-fresh"]);
  });

  test("a single cutoff applies to every provider (operator override shape)", () => {
    const T0 = "2026-08-06T00:00:00.000Z";
    applyRegistryEvents(db, [start("z-old", { provider: "zcode", at: T0 })]);

    const singleCutoff = new Date(Date.parse(T0) + 60 * 1000).toISOString(); // 1min after T0

    expect(pruneStaleSessions(db, singleCutoff)).toBe(1);
    expect(listSessions(db)).toEqual([]);
  });

  test("skips any tree containing an unviewed row, no matter how stale", () => {
    applyRegistryEvents(db, [
      start("stale-unviewed", { at: "2026-08-01T00:00:00.000Z" }),
      simple("Stop", "stale-unviewed", { at: "2026-08-01T00:00:01.000Z" }),
      start("stale-viewed", { at: "2026-08-01T00:00:00.000Z" }),
      simple("Stop", "stale-viewed", { at: "2026-08-01T00:00:01.000Z" }),
    ]);
    viewSession(db, "claude", "stale-viewed", "2026-08-01T02:00:00.000Z");

    // The daemon's order on one tick: the sweep dismisses the long-expired
    // view first, then prune sees a stale row with nothing holding it.
    expect(sweepExpiredResults(db, "2026-08-26T00:00:00.000Z", "2026-08-27T00:00:00.000Z")).toBe(1);
    expect(pruneStaleSessions(db, "2026-08-27T00:00:00.000Z")).toBe(1);
    expect(allRows().map((row) => row.session_id)).toEqual(["stale-unviewed"]);
  });

  test("removes a legacy ended session even while its result is fresh and unviewed", () => {
    applyRegistryEvents(db, [
      start("ended", { at: "2026-08-06T00:00:00.000Z" }),
      simple("Stop", "ended", { at: "2026-08-06T00:00:01.000Z" }),
    ]);
    db.run("UPDATE active_sessions SET ended_at = '2026-08-06T00:00:02.000Z' WHERE session_id = 'ended'");

    expect(pruneStaleSessions(db, "2026-08-01T00:00:00.000Z")).toBe(1);
    expect(getRow("ended")).toBeNull();
  });

  test("an unviewed zcode row survives its 1h TTL", () => {
    applyRegistryEvents(db, [
      start("z1", { provider: "zcode", at: "2026-08-26T00:00:00.000Z" }),
      simple("Stop", "z1", { provider: "zcode", at: "2026-08-26T00:00:01.000Z" }),
    ]);
    expect(pruneStaleSessions(db, "2026-08-26T03:00:00.000Z", "2026-08-26T01:00:00.000Z")).toBe(0);
    expect(countRows()).toBe(1);
  });

  test("an unviewed child keeps its stale native tree", () => {
    applyRegistryEvents(db, [
      start("parent", { at: "2026-08-01T00:00:00.000Z" }),
      subStart("child", "parent", { at: "2026-08-01T00:00:01.000Z" }),
    ]);
    db.run("UPDATE active_sessions SET unread_since = '2026-08-01T00:00:02.000Z' WHERE session_id = 'child'");
    expect(pruneStaleSessions(db, "2026-08-27T00:00:00.000Z")).toBe(0);
    expect(countRows()).toBe(2);
  });

  test("an unviewed Paseo descendant keeps its whole resolved tree, ancestors included", () => {
    // Paseo descendants are separate root rows; the unviewed one must keep
    // its stale ancestors, not orphan them.
    applyRegistryEvents(db, [
      { ...start("orchestrator", { at: "2026-08-01T00:00:00.000Z" }), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("worker", { at: "2026-08-01T00:00:01.000Z" }), origin: { kind: "paseo", ref: "agent-1" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'worker'");
    applyRegistryEvents(db, [simple("Stop", "worker", { at: "2026-08-01T00:00:02.000Z" })]);

    expect(pruneStaleSessions(db, "2026-08-27T00:00:00.000Z")).toBe(0);
    expect(
      allRows()
        .map((row) => row.session_id)
        .sort(),
    ).toEqual(["orchestrator", "worker"]);

    // Once the result is viewed, its clock holds the whole component until
    // the sweep dismisses it (a standalone prune alone leaves the overdue
    // clock in place); then nothing holds the stale tree and it all goes.
    viewSession(db, "claude", "worker", "2026-08-01T01:00:00.000Z");
    expect(pruneStaleSessions(db, "2026-08-27T00:00:00.000Z")).toBe(0);
    expect(countRows()).toBe(2);
    expect(sweepExpiredResults(db, "2026-08-26T00:00:00.000Z", "2026-08-27T00:00:00.000Z")).toBe(1);
    expect(pruneStaleSessions(db, "2026-08-27T00:00:00.000Z")).toBe(2);
    expect(countRows()).toBe(0);
  });

  test("an ambiguous ref never links for prune either: the unviewed row keeps only itself", () => {
    applyRegistryEvents(db, [
      { ...start("dup-a", { at: "2026-08-01T00:00:00.000Z" }), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("dup-b", { at: "2026-08-01T00:00:00.000Z" }), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("worker", { at: "2026-08-01T00:00:01.000Z" }), origin: { kind: "paseo", ref: "agent-1" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'worker'");
    applyRegistryEvents(db, [simple("Stop", "worker", { at: "2026-08-01T00:00:02.000Z" })]);

    // agent-0 is ambiguous, so the worker is its own root: it keeps itself
    // (unviewed) but not the two stale alleged parents.
    expect(pruneStaleSessions(db, "2026-08-27T00:00:00.000Z")).toBe(2);
    expect(allRows().map((row) => row.session_id)).toEqual(["worker"]);
  });

  test("an unviewed row keeps its whole connected component — Paseo siblings and stale descendants included", () => {
    // The tree is kept or pruned as one unit, like native trees today: one
    // unviewed member (worker-a) keeps the orchestrator, its viewed sibling
    // worker-b, and the orchestrator's own stale done child worker-c.
    applyRegistryEvents(db, [
      { ...start("orchestrator", { at: "2026-08-01T00:00:00.000Z" }), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("worker-a", { at: "2026-08-01T00:00:01.000Z" }), origin: { kind: "paseo", ref: "agent-a" } },
      { ...start("worker-b", { at: "2026-08-01T00:00:01.000Z" }), origin: { kind: "paseo", ref: "agent-b" } },
      { ...start("worker-c", { at: "2026-08-01T00:00:01.000Z" }), origin: { kind: "paseo", ref: "agent-c" } },
    ]);
    db.run(
      "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id IN ('worker-a', 'worker-b', 'worker-c')",
    );
    applyRegistryEvents(db, [
      simple("Stop", "worker-a", { at: "2026-08-01T00:00:02.000Z" }),
      simple("Stop", "worker-b", { at: "2026-08-01T00:00:03.000Z" }),
      simple("Stop", "worker-c", { at: "2026-08-01T00:00:04.000Z" }),
    ]);
    viewSession(db, "claude", "worker-b", "2026-08-01T01:00:00.000Z");
    viewSession(db, "claude", "worker-c", "2026-08-01T01:00:00.000Z");

    expect(pruneStaleSessions(db, "2026-08-27T00:00:00.000Z")).toBe(0);
    expect(countRows()).toBe(4);
  });

  test("a live Paseo child keeps its quiet parent from being pruned", () => {
    // Lease protection also follows the component: the child's fresh
    // updated_at keeps the whole linked tree, not just itself.
    applyRegistryEvents(db, [
      { ...start("orchestrator", { at: "2026-08-01T00:00:00.000Z" }), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("worker", { at: "2026-08-26T00:00:00.000Z" }), origin: { kind: "paseo", ref: "agent-1" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'worker'");
    applyRegistryEvents(db, [simple("Activity", "worker", { at: "2026-08-27T00:30:00.000Z" })]);

    expect(pruneStaleSessions(db, "2026-08-27T00:00:00.000Z")).toBe(0);
    expect(countRows()).toBe(2);
  });

  describe("the live view clock", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const iso = (ms: number): string => new Date(ms).toISOString();

    test("a viewed result inside its post-view window survives prune however stale its lease", () => {
      // The result landed long ago (lease long expired) and was viewed
      // recently: the 24h post-view expiry owns its removal, not the prune.
      const viewedAt = "2026-08-26T00:00:00.000Z";
      applyRegistryEvents(db, [
        start("s1", { at: "2026-08-01T00:00:00.000Z" }),
        simple("Stop", "s1", { at: "2026-08-01T00:00:01.000Z" }),
      ]);
      viewSession(db, "claude", "s1", viewedAt);

      // 23:59 after the view — the daemon's tick order: sweep, then prune.
      const nearlyExpiredMs = Date.parse(viewedAt) + DAY_MS - 60_000;
      expect(sweepExpiredResults(db, iso(nearlyExpiredMs - DAY_MS), iso(nearlyExpiredMs))).toBe(0);
      expect(pruneStaleSessions(db, iso(nearlyExpiredMs - DAY_MS))).toBe(0);
      expect(getRow("s1")).toMatchObject({ done_since: "2026-08-01T00:00:01.000Z", viewed_since: viewedAt });

      // Past the window: the sweep dismisses, then prune removes the stale row.
      const expiredMs = Date.parse(viewedAt) + DAY_MS + 60_000;
      expect(sweepExpiredResults(db, iso(expiredMs - DAY_MS), iso(expiredMs))).toBe(1);
      expect(pruneStaleSessions(db, iso(expiredMs - DAY_MS))).toBe(1);
      expect(getRow("s1")).toBeNull();
    });

    test("a viewed error card is held by its clock too", () => {
      applyRegistryEvents(db, [
        start("s1", { at: "2026-08-01T00:00:00.000Z" }),
        simple("StopFailure", "s1", { at: "2026-08-01T00:00:01.000Z" }),
      ]);
      viewSession(db, "claude", "s1", "2026-08-26T00:00:00.000Z");
      expect(pruneStaleSessions(db, "2026-08-25T00:00:00.000Z")).toBe(0);
      expect(getRow("s1")).toMatchObject({ status: "error", viewed_since: "2026-08-26T00:00:00.000Z" });
    });

    test("a viewed zcode result outlives its 1h lease until view + 24h", () => {
      applyRegistryEvents(db, [
        start("z1", { provider: "zcode", at: "2026-08-26T00:00:00.000Z" }),
        simple("Stop", "z1", { provider: "zcode", at: "2026-08-26T00:00:01.000Z" }),
      ]);
      viewSession(db, "zcode", "z1", "2026-08-26T00:30:00.000Z");
      // 2h after the result: past the zcode lease, inside the view window.
      expect(pruneStaleSessions(db, "2026-08-25T02:00:00.000Z", "2026-08-26T01:00:00.000Z")).toBe(0);
      expect(countRows()).toBe(1);
    });

    test("a viewed row with no held result is not a clock: a stale bare view is pruned", () => {
      // Viewing an active card stamps viewed_since without a result to hold;
      // once the session goes quiet past its lease there is nothing to keep.
      applyRegistryEvents(db, [
        start("s1", { at: "2026-08-01T00:00:00.000Z" }),
        simple("Activity", "s1", { at: "2026-08-01T00:00:01.000Z" }),
      ]);
      viewSession(db, "claude", "s1", "2026-08-26T00:00:00.000Z");
      expect(getRow("s1")).toMatchObject({ status: "working", viewed_since: "2026-08-26T00:00:00.000Z" });
      expect(pruneStaleSessions(db, "2026-08-25T00:00:00.000Z")).toBe(1);
    });

    test("a clocked Paseo child keeps its stale parent (component closure)", () => {
      applyRegistryEvents(db, [
        { ...start("orchestrator", { at: "2026-08-01T00:00:00.000Z" }), origin: { kind: "paseo", ref: "agent-0" } },
        { ...start("worker", { at: "2026-08-01T00:00:01.000Z" }), origin: { kind: "paseo", ref: "agent-1" } },
      ]);
      db.run(
        "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'worker'",
      );
      applyRegistryEvents(db, [simple("Stop", "worker", { at: "2026-08-01T00:00:02.000Z" })]);
      viewSession(db, "claude", "worker", "2026-08-26T00:00:00.000Z");
      expect(pruneStaleSessions(db, "2026-08-25T00:00:00.000Z")).toBe(0);
      expect(countRows()).toBe(2);
    });
  });
});

describe("listSessions", () => {
  test("returns the ActiveSession shape ordered by slot first, then identity", () => {
    applyRegistryEvents(db, [
      start("b", { provider: "kimi", title: "B", at: at(1) }),
      start("a", { provider: "claude", at: at(2) }),
      subStart("c2", "a", { at: at(3) }),
      subStart("c1", "a", { at: at(4) }),
    ]);

    expect(listSessions(db)).toEqual([
      {
        provider: "kimi",
        sessionId: "b",
        parentSessionId: null,
        status: "idle",
        title: "B",
        project: null,
        logicalSlot: 1,
        ghosttyTerminalId: null,
        backgroundOutstanding: 0,
        transcriptPath: null,
        model: null,
        originKind: null,
        originRef: null,
        originSubagent: 0,
        unreadSince: null,
        openedAt: at(1),
        updatedAt: at(1),
      },
      {
        provider: "claude",
        sessionId: "a",
        parentSessionId: null,
        status: "idle",
        title: null,
        project: null,
        logicalSlot: 2,
        ghosttyTerminalId: null,
        backgroundOutstanding: 0,
        transcriptPath: null,
        model: null,
        originKind: null,
        originRef: null,
        originSubagent: 0,
        unreadSince: null,
        openedAt: at(2),
        updatedAt: at(2),
      },
      {
        provider: "claude",
        sessionId: "c1",
        parentSessionId: "a",
        status: "idle",
        title: null,
        project: null,
        logicalSlot: null,
        ghosttyTerminalId: null,
        backgroundOutstanding: 0,
        transcriptPath: null,
        model: null,
        originKind: null,
        originRef: null,
        originSubagent: 0,
        unreadSince: null,
        openedAt: at(4),
        updatedAt: at(4),
      },
      {
        provider: "claude",
        sessionId: "c2",
        parentSessionId: "a",
        status: "idle",
        title: null,
        project: null,
        logicalSlot: null,
        ghosttyTerminalId: null,
        backgroundOutstanding: 0,
        transcriptPath: null,
        model: null,
        originKind: null,
        originRef: null,
        originSubagent: 0,
        unreadSince: null,
        openedAt: at(3),
        updatedAt: at(3),
      },
    ]);
  });
});

describe("SessionTitleChanged", () => {
  const titleChanged = (sessionId: string, title: string, second = 5): RegistryEvent => ({
    kind: "SessionTitleChanged",
    provider: "pi",
    sessionId,
    title,
    observedAt: at(second),
  });

  test("retitles an existing row without touching status or updated_at", () => {
    applyRegistryEvents(db, [start("s1", { provider: "pi", title: "Old", at: at(1) })]);
    applyRegistryEvents(db, [{ kind: "Activity", provider: "pi", sessionId: "s1", observedAt: at(2) }]);

    expect(applyRegistryEvents(db, [titleChanged("s1", "New title")])).toEqual(["applied"]);

    const row = listSessions(db)[0];
    expect(row?.title).toBe("New title");
    expect(row?.status).toBe("working");
    expect(row?.updatedAt).toBe(at(2));
  });

  test("is ignored for an unknown identity and never creates a row", () => {
    expect(applyRegistryEvents(db, [titleChanged("ghost", "Nope")])).toEqual(["ignored"]);
    expect(listSessions(db)).toEqual([]);
  });

  test("is ignored when the stored title already matches", () => {
    applyRegistryEvents(db, [start("s1", { provider: "pi", title: "Same", at: at(1) })]);
    expect(applyRegistryEvents(db, [titleChanged("s1", "Same")])).toEqual(["ignored"]);
  });
});

describe("paseo-owned titles", () => {
  // A Paseo rename must not oscillate with the provider's own title stream:
  // the overlay rewrites its record title every pass, so any provider-side
  // write to a paseo-origin row flashes for up to one pass and then loses.
  const renameTo = (title: string): number =>
    syncPaseoStates(db, [
      {
        provider: "claude",
        sessionId: "s1",
        agentId: "a1",
        requiresAttention: false,
        isSubagent: false,
        parentAgentId: null,
        attentionTimestamp: null,
        updatedAt: at(2),
        archivedAt: null,
        title,
        lastStatus: null,
      },
    ]);

  test("a paseo-origin row ignores provider retitle events", () => {
    applyRegistryEvents(db, [start("s1", { title: "auto", at: at(1), origin: { kind: "paseo", ref: "a1" } })]);
    renameTo("d2 impl");
    const event: RegistryEvent = {
      kind: "SessionTitleChanged",
      provider: "claude",
      sessionId: "s1",
      title: "auto",
      observedAt: at(5),
    };
    expect(applyRegistryEvents(db, [event])).toEqual(["ignored"]);
    expect(getRow("s1")?.title).toBe("d2 impl");
  });

  test("the resolver write-back skips paseo-origin rows and still writes plain ones", () => {
    applyRegistryEvents(db, [
      start("s1", { title: "auto", at: at(1), origin: { kind: "paseo", ref: "a1" } }),
      start("s2", { title: "plain", at: at(1) }),
    ]);
    renameTo("d2 impl");
    const changed = updateSessionTitles(db, [
      { provider: "claude", sessionId: "s1", title: "resolved ai title" },
      { provider: "claude", sessionId: "s2", title: "resolved ai title" },
    ]);
    expect(changed).toBe(1);
    expect(getRow("s1")?.title).toBe("d2 impl");
    expect(getRow("s2")?.title).toBe("resolved ai title");
  });

  test("a reused SessionStart keeps a paseo-origin row's title", () => {
    applyRegistryEvents(db, [start("s1", { title: "auto", at: at(1), origin: { kind: "paseo", ref: "a1" } })]);
    renameTo("d2 impl");
    applyRegistryEvents(db, [start("s1", { title: "auto again", at: at(9), origin: { kind: "paseo", ref: "a1" } })]);
    expect(getRow("s1")?.title).toBe("d2 impl");
    // The reuse still resets the rest of its metadata contract.
    expect(getRow("s1")?.status).toBe("idle");
  });
});

describe("status_since", () => {
  test("initializes at SessionStart and restamps on each own-status transition", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) })]);
    expect(getRow("s1")?.status_since).toBe(at(1));

    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(2) })]);
    expect(getRow("s1")).toMatchObject({ status: "working", status_since: at(2) });

    applyRegistryEvents(db, [simple("Attention", "s1", { at: at(3) })]);
    expect(getRow("s1")).toMatchObject({ status: "waiting", status_since: at(3) });

    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(4) })]);
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(4) });

    applyRegistryEvents(db, [simple("StopFailure", "s1", { at: at(5) })]);
    expect(getRow("s1")).toMatchObject({ status: "error", status_since: at(5) });
  });

  test("a repeated same-status event moves updated_at but never status_since", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) }), simple("Activity", "s1", { at: at(2) })]);
    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(3) })]);
    expect(getRow("s1")).toMatchObject({ status: "working", status_since: at(2), updated_at: at(3) });
  });

  test("BackgroundWorkStarted/Cleared never restamp status_since", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) }), simple("Activity", "s1", { at: at(2) })]);
    applyRegistryEvents(db, [
      simple("BackgroundWorkStarted", "s1", { at: at(3) }),
      simple("BackgroundWorkCleared", "s1", { at: at(4) }),
    ]);
    expect(getRow("s1")).toMatchObject({ status: "working", status_since: at(2), updated_at: at(4) });
  });

  test("a Stop held working by background work does not restamp; the later idle Stop does", () => {
    applyRegistryEvents(db, [
      start("s1", { at: at(1) }),
      simple("Activity", "s1", { at: at(2) }),
      simple("BackgroundWorkStarted", "s1", { at: at(3) }),
    ]);
    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(4) })]);
    expect(getRow("s1")).toMatchObject({ status: "working", status_since: at(2) });

    applyRegistryEvents(db, [
      simple("BackgroundWorkCleared", "s1", { at: at(5) }),
      simple("Stop", "s1", { at: at(6) }),
    ]);
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(6) });
  });

  test("a background-held Stop that changes status (waiting→working) restamps status_since", () => {
    applyRegistryEvents(db, [
      start("s1", { at: at(1) }),
      simple("Activity", "s1", { at: at(2) }),
      simple("BackgroundWorkStarted", "s1", { at: at(3) }),
      simple("Attention", "s1", { at: at(4) }),
    ]);
    expect(getRow("s1")).toMatchObject({ status: "waiting", status_since: at(4) });

    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(5) })]);
    expect(getRow("s1")).toMatchObject({ status: "working", status_since: at(5), unread_since: null });
  });

  test("a reused SessionStart restamps only when its idle-reset changes the status", () => {
    applyRegistryEvents(db, [start("s1", { at: at(1) }), simple("Activity", "s1", { at: at(2) })]);
    applyRegistryEvents(db, [start("s1", { at: at(3) })]);
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(3) });

    // Already idle: a further reuse keeps the stamp while moving updated_at.
    applyRegistryEvents(db, [start("s1", { at: at(4) })]);
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(3), updated_at: at(4) });
  });

  test("a late-join SessionObserved insert initializes status_since", () => {
    applyRegistryEvents(db, [
      {
        kind: "SessionObserved",
        provider: "claude",
        sessionId: "s1",
        title: null,
        project: null,
        transcriptPath: null,
        model: null,
        observedAt: at(2),
      },
    ]);
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(2) });
  });

  test("SubagentStart initializes a child row's status_since and restamps on its idle reset", () => {
    applyRegistryEvents(db, [start("p", { at: at(1) }), subStart("c", "p", { at: at(2) })]);
    expect(getRow("c")?.status_since).toBe(at(2));

    applyRegistryEvents(db, [simple("Activity", "c", { at: at(3) }), subStart("c", "p", { at: at(4) })]);
    expect(getRow("c")).toMatchObject({ status: "idle", status_since: at(4) });
  });
});

describe("viewSession", () => {
  test("clears the unread badge, stamps viewed_since, and leaves done_since and status untouched", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(viewSession(db, "claude", "s1", at(8))).toBe("applied");
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      unread_since: null,
      done_since: at(5),
      viewed_since: at(8),
      updated_at: at(5), // view is a maintenance write: the prune lease stays put
    });
  });

  test("the card stays held by done_since after viewing (view is not a dismissal)", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    const row = getRow("s1");
    expect(row?.done_since).toBe(at(5));
    expect(row).not.toBeNull(); // nothing deletes on view
  });

  test("re-viewing restamps viewed_since (the 24h clock restarts)", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    expect(viewSession(db, "claude", "s1", at(30))).toBe("applied");
    expect(getRow("s1")?.viewed_since).toBe(at(30));
  });

  test("viewing an error card clears the badge but keeps the error status", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    expect(viewSession(db, "claude", "s1", at(8))).toBe("applied");
    expect(getRow("s1")).toMatchObject({ status: "error", unread_since: null, viewed_since: at(8) });
  });

  test("viewing an active card is harmless: badge clears, viewed stamps, status stays", () => {
    applyRegistryEvents(db, [start("s1"), simple("Activity", "s1", { at: at(5) })]);
    expect(viewSession(db, "claude", "s1", at(8))).toBe("applied");
    expect(getRow("s1")).toMatchObject({ status: "working", viewed_since: at(8) });
  });

  test("viewing an unknown session is ignored", () => {
    expect(viewSession(db, "claude", "missing", at(8))).toBe("ignored");
  });

  test("cascades to done/unread descendants along Paseo lineage at the same instant", () => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("child-a"), origin: { kind: "paseo", ref: "agent-a" } },
      { ...start("child-b"), origin: { kind: "paseo", ref: "agent-b" } },
    ]);
    // Overlay-style parent links: children carry the parent's ref.
    db.run(
      "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id IN ('child-a', 'child-b')",
    );
    applyRegistryEvents(db, [simple("Stop", "child-a", { at: at(5) }), simple("Stop", "child-b", { at: at(6) })]);

    expect(viewSession(db, "claude", "parent", at(9))).toBe("applied");
    expect(getRow("child-a")).toMatchObject({ unread_since: null, viewed_since: at(9), done_since: at(5) });
    expect(getRow("child-b")).toMatchObject({ unread_since: null, viewed_since: at(9), done_since: at(6) });
  });

  test("the cascade skips descendants holding no ledger", () => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("child"), origin: { kind: "paseo", ref: "agent-c" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'child'");
    viewSession(db, "claude", "parent", at(9));
    expect(getRow("child")?.viewed_since).toBeNull(); // active child: no ledger, no stamp
  });

  test("a causal watermark consumes the seen result and protects a newer one", () => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("old"), origin: { kind: "paseo", ref: "agent-old" } },
      { ...start("new"), origin: { kind: "paseo", ref: "agent-new" } },
    ]);
    db.run(
      "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id IN ('old', 'new')",
    );
    applyRegistryEvents(db, [simple("Stop", "old", { at: at(5) }), simple("Stop", "new", { at: at(9) })]);

    // The gesture was issued from a snapshot whose unread stamp was at(5).
    expect(viewSession(db, "claude", "parent", at(12), { unreadSince: at(5) })).toBe("applied");
    expect(getRow("old")).toMatchObject({ unread_since: null, viewed_since: at(12) });
    // The newer result landed after the snapshot: it survives, unviewed.
    expect(getRow("new")).toMatchObject({ unread_since: at(9), viewed_since: null, done_since: at(9) });
  });

  test("a causal watermark protecting the target leaves it untouched and ignored", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(9) })]);
    expect(viewSession(db, "claude", "s1", at(12), { unreadSince: at(5) })).toBe("ignored");
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), viewed_since: null });
  });

  test("a causal view from a null-unread snapshot protects a result that lands in transit", () => {
    // The gesture's snapshot showed no unread — then a result arrives before
    // the view executes. The null-stamp watermark must not consume it.
    applyRegistryEvents(db, [start("s1")]);
    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(9) })]); // lands in transit
    expect(viewSession(db, "claude", "s1", at(12), { unreadSince: null })).toBe("ignored");
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(9), viewed_since: null });
  });

  test("a causal-null view on a genuinely read row still stamps the clock", () => {
    // No unread at snapshot time and none in transit: the view matches what
    // the user saw, so the expiry clock starts.
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    expect(viewSession(db, "claude", "s1", at(12), { unreadSince: null })).toBe("applied");
    expect(getRow("s1")).toMatchObject({ viewed_since: at(12), done_since: at(5) });
  });

  test("viewing that consumes a result advances acked_at to the gesture instant", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: at(5) }),
    ]);
    expect(viewSession(db, "claude", "s1", at(12))).toBe("applied");
    expect(getRow("s1")?.acked_at).toBe(at(12)); // the gesture, not the consumed stamp

    // Any flag at or before the gesture synced late cannot resurrect the
    // badge (the Paseo mirror's guard is strictly newer-than), but news
    // raised after the gesture can.
    const flag = (attentionTimestamp: string) => ({
      provider: "claude" as const,
      sessionId: "s1",
      agentId: "a1",
      requiresAttention: true,
      isSubagent: false,
      parentAgentId: null,
      attentionTimestamp,
      updatedAt: null,
      archivedAt: null,
      lastStatus: null,
      title: null,
    });
    expect(syncPaseoStates(db, [flag(at(5))])).toBe(0);
    expect(syncPaseoStates(db, [flag(at(12))])).toBe(0);
    expect(getRow("s1")?.unread_since).toBeNull();
    expect(syncPaseoStates(db, [flag(at(15))])).toBe(1);
    expect(getRow("s1")?.unread_since).toBe(at(15));
  });

  test("a view that consumes nothing leaves acked_at alone", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: at(5) }),
    ]);
    viewSession(db, "claude", "s1", at(8));
    const ackedAfterFirstView = getRow("s1")?.acked_at;
    expect(viewSession(db, "claude", "s1", at(20))).toBe("applied"); // restamps the clock
    expect(getRow("s1")?.acked_at).toBe(ackedAfterFirstView); // nothing consumed → no advance
  });

  test("an ambiguous origin ref never links: the alleged child is not mutated through the parent", () => {
    // Projection refuses ambiguous refs (two roots share agent-0), so the
    // destructive walk must refuse them too — the child is its own root (R7).
    applyRegistryEvents(db, [
      { ...start("dup-a"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("dup-b"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("child"), origin: { kind: "paseo", ref: "agent-c" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'child'");
    applyRegistryEvents(db, [simple("Stop", "child", { at: at(5) })]);

    expect(viewSession(db, "claude", "dup-a", at(9))).toBe("applied");
    expect(getRow("child")).toMatchObject({ unread_since: at(5), viewed_since: null }); // untouched
  });

  test("a cyclic lineage is not walked: cycle members keep their own results", () => {
    applyRegistryEvents(db, [
      { ...start("loop-a"), origin: { kind: "paseo", ref: "agent-x" } },
      { ...start("loop-b"), origin: { kind: "paseo", ref: "agent-y" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-y' WHERE session_id = 'loop-a'");
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-x' WHERE session_id = 'loop-b'");
    applyRegistryEvents(db, [simple("Stop", "loop-b", { at: at(5) })]);

    // Projection strips cycle members' parent edges, so loop-b is not a
    // descendant of loop-a for mutation purposes either.
    expect(viewSession(db, "claude", "loop-a", at(9))).toBe("applied");
    expect(getRow("loop-b")).toMatchObject({ unread_since: at(5), viewed_since: null });
  });

  test("a fresh Stop cancels the view clock (the card is unviewed again)", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(12) })]);
    expect(getRow("s1")).toMatchObject({ unread_since: at(12), done_since: at(12), viewed_since: null });
  });

  test("a fresh StopFailure cancels the view clock", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    applyRegistryEvents(db, [simple("StopFailure", "s1", { at: at(12) })]);
    expect(getRow("s1")).toMatchObject({ status: "error", unread_since: at(12), viewed_since: null });
  });
});

describe("acknowledgeSession as dismiss", () => {
  const paseoFamily = (): void => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("child-a"), origin: { kind: "paseo", ref: "agent-a" } },
      { ...start("child-b"), origin: { kind: "paseo", ref: "agent-b" } },
    ]);
    db.run(
      "UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id IN ('child-a', 'child-b')",
    );
    applyRegistryEvents(db, [simple("Stop", "child-a", { at: at(5) }), simple("Stop", "child-b", { at: at(6) })]);
  };

  test("dismissing the parent cascades: whole subtree drops its ledgers, rows remain", () => {
    paseoFamily();
    const rowsBefore = countRows();
    expect(acknowledgeSession(db, "claude", "parent", at(9))).toBe("applied");
    for (const id of ["parent", "child-a", "child-b"]) {
      expect(getRow(id)).toMatchObject({ unread_since: null, done_since: null });
    }
    expect(countRows()).toBe(rowsBefore); // dismiss never deletes
  });

  test("the cascade retires an error descendant with the parent", () => {
    applyRegistryEvents(db, [
      { ...start("parent"), origin: { kind: "paseo", ref: "agent-0" } },
      { ...start("child"), origin: { kind: "paseo", ref: "agent-c" } },
    ]);
    db.run("UPDATE active_sessions SET origin_subagent = 1, origin_parent_ref = 'agent-0' WHERE session_id = 'child'");
    applyRegistryEvents(db, [simple("StopFailure", "child", { at: at(5) })]);

    expect(acknowledgeSession(db, "claude", "parent", at(9))).toBe("applied");
    expect(getRow("child")).toMatchObject({ status: "idle", unread_since: null, background_outstanding: 0 });
  });

  test("dismiss clears viewed_since alongside the ledgers", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    expect(acknowledgeSession(db, "claude", "s1", at(12))).toBe("applied");
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: null, viewed_since: null });
  });

  test("a causal watermark consumes the seen result and protects a newer one", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(7) }), simple("Stop", "s1", { at: at(9) })]);
    // The gesture was issued from a snapshot showing the at(5) stamp.
    expect(acknowledgeSession(db, "claude", "s1", at(12), { unreadSince: at(5) })).toBe("ignored");
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(9) });
  });

  test("a causal-null dismiss consumes nothing and protects a result that lands in transit", () => {
    // The snapshot showed no unread; a result lands before the dismiss runs.
    applyRegistryEvents(db, [start("s1")]);
    applyRegistryEvents(db, [simple("Stop", "s1", { at: at(9) })]); // in transit
    expect(acknowledgeSession(db, "claude", "s1", at(12), { unreadSince: null })).toBe("ignored");
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(9) }); // survives
  });

  test("a watermark at the stamp consumes it (inclusive)", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(acknowledgeSession(db, "claude", "s1", at(12), { unreadSince: at(5) })).toBe("applied");
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: null });
  });

  test("a watermark only retires an error the user actually saw", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    expect(acknowledgeSession(db, "claude", "s1", at(12), { unreadSince: at(3) })).toBe("ignored");
    expect(getRow("s1")?.status).toBe("error");
    expect(acknowledgeSession(db, "claude", "s1", at(12), { unreadSince: at(5) })).toBe("applied");
    expect(getRow("s1")?.status).toBe("idle");
  });

  test("a causal-null dismiss retires a viewed error the snapshot showed", () => {
    // The error was viewed (badge cleared) — the snapshot showed an error
    // card with no unread — so the dismiss still settles it.
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    expect(acknowledgeSession(db, "claude", "s1", at(12), { unreadSince: null })).toBe("applied");
    expect(getRow("s1")).toMatchObject({ status: "idle", status_since: at(12) });
  });

  test("cascade with a watermark: the seen child clears, the newer child holds the board", () => {
    paseoFamily();
    applyRegistryEvents(db, [simple("Activity", "child-b", { at: at(7) }), simple("Stop", "child-b", { at: at(9) })]);
    expect(acknowledgeSession(db, "claude", "parent", at(12), { unreadSince: at(6) })).toBe("applied");
    expect(getRow("child-a")).toMatchObject({ unread_since: null, done_since: null });
    expect(getRow("child-b")).toMatchObject({ unread_since: at(9), done_since: at(9) });
  });

  test("a causal-null dismiss consumes a viewed done card the snapshot showed", () => {
    // The done card was viewed (badge cleared, clock running) — the snapshot
    // showed it with no unread. The null-stamp watermark must still consume
    // the done hold: consumption keys on the result identity (unread), and
    // the done hold follows the result.
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8));
    expect(acknowledgeSession(db, "claude", "s1", at(12), { unreadSince: null })).toBe("applied");
    expect(getRow("s1")).toMatchObject({ unread_since: null, done_since: null, viewed_since: null });
  });

  test("dismiss advances acked_at to the gesture instant, so a flag synced late stays suppressed", () => {
    applyRegistryEvents(db, [
      { ...start("s1"), origin: { kind: "paseo", ref: "a1" } },
      simple("Stop", "s1", { at: at(5) }),
    ]);
    expect(acknowledgeSession(db, "claude", "s1", at(12))).toBe("applied");
    expect(getRow("s1")?.acked_at).toBe(at(12)); // the gesture, not the consumed stamp at(5)

    const flag = (attentionTimestamp: string) => ({
      provider: "claude" as const,
      sessionId: "s1",
      agentId: "a1",
      requiresAttention: true,
      isSubagent: false,
      parentAgentId: null,
      attentionTimestamp,
      updatedAt: null,
      archivedAt: null,
      lastStatus: null,
      title: null,
    });
    // The delayed sync of the very flag the user dismissed: no resurrection.
    expect(syncPaseoStates(db, [flag(at(5))])).toBe(0);
    expect(getRow("s1")?.unread_since).toBeNull();
    // A flag raised after the consumed result is fresh news and re-badges.
    expect(syncPaseoStates(db, [flag(at(15))])).toBe(1);
    expect(getRow("s1")?.unread_since).toBe(at(15));
  });
});

describe("SessionEnd deletion", () => {
  test("SessionEnd removes a Roborev session even when it holds an unviewed result", () => {
    applyRegistryEvents(db, [
      start("review", { origin: { kind: "roborev", ref: "shim" } }),
      simple("Stop", "review", { at: at(5) }),
    ]);

    expect(applyRegistryEvents(db, [simple("SessionEnd", "review", { at: at(9) })])).toEqual(["applied"]);
    expect(getRow("review")).toBeNull();
  });

  test("SessionEnd deletes a session even when it holds an unviewed result", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(9) })])).toEqual(["applied"]);
    expect(getRow("s1")).toBeNull();
  });

  test("SessionEnd without an unviewed result deletes the row as today", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", at(8)); // viewed: unread cleared
    expect(applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(9) })])).toEqual(["applied"]);
    expect(getRow("s1")).toBeNull();
  });

  test("SessionStart after close creates a new session life", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(9) })]);
    applyRegistryEvents(db, [start("s1", { at: at(12) })]);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      opened_at: at(12),
      ended_at: null,
      unread_since: null,
      done_since: null,
      viewed_since: null,
    });
  });

  test("a duplicate SessionEnd for an already deleted row is a no-op", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(9) })]);
    expect(applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(15) })])).toEqual(["ignored"]);
    expect(getRow("s1")).toBeNull();
  });

  test("late stop and end events never recreate a closed session", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    const results = applyRegistryEvents(db, [
      simple("SessionEnd", "s1", { at: at(9) }),
      simple("Stop", "s1", { at: at(12) }),
      simple("SessionEnd", "s1", { at: at(15) }),
    ]);
    expect(results).toEqual(["applied", "ignored", "ignored"]);
    expect(getRow("s1")).toBeNull();
    expect(countRows()).toBe(0);
  });

  test("SessionEnd deletes an error-only session", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    expect(applyRegistryEvents(db, [simple("SessionEnd", "s1", { at: at(9) })])).toEqual(["applied"]);
    expect(getRow("s1")).toBeNull();
  });
});

describe("sweepExpiredResults", () => {
  const VIEWED = "2026-08-01T00:00:00.000Z";
  const CUTOFF = "2026-08-02T00:00:00.000Z"; // viewed + 24h
  const SWEPT_AT = "2026-08-02T06:00:00.000Z"; // the sweep's own instant

  const seedDoneViewed = (sessionId: string): void => {
    applyRegistryEvents(db, [start(sessionId), simple("Stop", sessionId, { at: at(5) })]);
    viewSession(db, "claude", sessionId, VIEWED);
  };

  test("auto-dismisses a done row viewed older than the cutoff", () => {
    seedDoneViewed("s1");
    expect(sweepExpiredResults(db, CUTOFF, SWEPT_AT)).toBe(1);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      unread_since: null,
      done_since: null,
      viewed_since: null,
    });
  });

  test("retires an error row viewed older than the cutoff, stamping status_since at the sweep instant", () => {
    applyRegistryEvents(db, [start("s1"), simple("StopFailure", "s1", { at: at(5) })]);
    viewSession(db, "claude", "s1", VIEWED);
    expect(sweepExpiredResults(db, CUTOFF, SWEPT_AT)).toBe(1);
    expect(getRow("s1")).toMatchObject({
      status: "idle",
      background_outstanding: 0,
      viewed_since: null,
      status_since: SWEPT_AT, // the retirement time — not the cutoff
    });
  });

  test("an unviewed done row of any age is never swept", () => {
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: at(5) })]);
    expect(sweepExpiredResults(db, "2027-01-01T00:00:00.000Z", SWEPT_AT)).toBe(0);
    expect(getRow("s1")).toMatchObject({ unread_since: at(5), done_since: at(5) });
  });

  test("a row viewed exactly at the cutoff is swept (inclusive)", () => {
    seedDoneViewed("s1");
    expect(sweepExpiredResults(db, VIEWED, SWEPT_AT)).toBe(1);
  });

  test("a viewed row inside the 24h window is kept", () => {
    seedDoneViewed("s1");
    // The cutoff is now − 24h; twelve hours after the view it is still
    // twelve hours before it — the row lives inside its window.
    expect(sweepExpiredResults(db, "2026-07-31T12:00:00.000Z", SWEPT_AT)).toBe(0);
    expect(getRow("s1")?.done_since).toBe(at(5));
  });

  test("a working row with a stale viewed done ledger is never swept", () => {
    // Done lands, the session is viewed, then work resumes — Activity leaves
    // the done ledger in place (status transitions don't clear it), so the
    // row carries an expired view clock AND a done stamp while working.
    applyRegistryEvents(db, [start("busy"), simple("Stop", "busy", { at: at(4) })]);
    viewSession(db, "claude", "busy", VIEWED);
    applyRegistryEvents(db, [simple("Activity", "busy", { at: at(6) })]);
    expect(getRow("busy")).toMatchObject({ status: "working", done_since: at(4), viewed_since: VIEWED });
    expect(sweepExpiredResults(db, CUTOFF, SWEPT_AT)).toBe(0);
    expect(getRow("busy")).toMatchObject({ status: "working", done_since: at(4), viewed_since: VIEWED });
  });

  test("a waiting row with a stale viewed done ledger is never swept", () => {
    applyRegistryEvents(db, [start("blocked"), simple("Stop", "blocked", { at: at(4) })]);
    viewSession(db, "claude", "blocked", VIEWED);
    applyRegistryEvents(db, [simple("Attention", "blocked", { at: at(6) })]);
    expect(getRow("blocked")).toMatchObject({ status: "waiting", done_since: at(4), viewed_since: VIEWED });
    expect(sweepExpiredResults(db, CUTOFF, SWEPT_AT)).toBe(0);
    expect(getRow("blocked")).toMatchObject({ status: "waiting", done_since: at(4), viewed_since: VIEWED });
  });

  test("a new result after the view cancels the sweep (the card is unviewed again)", () => {
    seedDoneViewed("s1");
    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(8) }), simple("Stop", "s1", { at: at(9) })]);
    expect(sweepExpiredResults(db, CUTOFF, SWEPT_AT)).toBe(0);
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(9), viewed_since: null });
  });

  test("a row holding unread news is never swept, even with an expired view clock (defensive)", () => {
    // Every fresh-result path clears viewed_since (Stop/StopFailure in Task
    // 2, the Paseo flag and repair in Task 5) — but if an inconsistent state
    // ever exists, unread means unviewed, and unviewed never expires.
    seedDoneViewed("s1");
    db.run("UPDATE active_sessions SET unread_since = ? WHERE session_id = 's1'", [at(9)]);
    expect(sweepExpiredResults(db, CUTOFF, SWEPT_AT)).toBe(0);
    expect(getRow("s1")).toMatchObject({ unread_since: at(9), done_since: at(5) });
  });
});
