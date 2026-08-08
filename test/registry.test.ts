import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths } from "../src/core/paths";
import { applyRegistryEvents, clearAllSessions, clearSession, listSessions } from "../src/core/registry";
import { initializeDatabase, openRegistryDatabase } from "../src/core/schema";
import type { Provider, RegistryEvent } from "../src/protocol";

let tempHome: string;
let db: Database;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "stream-deck-agents-registry-"));
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
    at?: string;
  } = {},
): RegistryEvent => ({
  kind: "SessionStart",
  provider: options.provider ?? "claude",
  sessionId,
  title: options.title ?? null,
  project: options.project ?? null,
  ghosttyTerminalId: options.ghosttyTerminalId ?? null,
  observedAt: options.at ?? at(1),
});

const subStart = (
  sessionId: string,
  parentSessionId: string,
  options: { provider?: Provider; title?: string | null; project?: string | null; at?: string } = {},
): RegistryEvent => ({
  kind: "SubagentStart",
  provider: options.provider ?? "claude",
  sessionId,
  parentSessionId,
  title: options.title ?? null,
  project: options.project ?? null,
  observedAt: options.at ?? at(1),
});

const simple = (
  kind: "Activity" | "Attention" | "Stop" | "StopFailure" | "SessionEnd" | "SubagentStop",
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

describe("applyRegistryEvents", () => {
  test("drives one session through idle, working, waiting, idle, error, and absent", () => {
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

  test("never recreates an ended session from late non-start events", () => {
    applyRegistryEvents(db, [start("s1")]);
    applyRegistryEvents(db, [simple("SessionEnd", "s1")]);

    for (const kind of ["Activity", "Attention", "Stop", "StopFailure", "SessionEnd", "SubagentStop"] as const) {
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
        openedAt: at(3),
        updatedAt: at(3),
      },
    ]);
  });
});
