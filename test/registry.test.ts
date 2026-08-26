import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths } from "../src/core/paths";
import {
  acknowledgeSession,
  applyRegistryEvents,
  clearAllSessions,
  clearSession,
  listSessions,
  pruneStaleSessions,
  syncPaseoStates,
  updateSessionActivityLines,
  updateSessionModels,
  updateSessionTitles,
} from "../src/core/registry";
import { initializeDatabase, openRegistryDatabase } from "../src/core/schema";
import type { Provider, RegistryEvent, SessionOrigin } from "../src/protocol";

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
    expect(row?.acked_at).toBe(at(12));
    expect(row?.updated_at).toBe(before);
    expect(acknowledgeSession(db, "claude", "s1", at(13))).toBe("ignored"); // already read
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
});

describe("transcript paths", () => {
  test("persists the transcript path on start and refreshes it on restart", () => {
    applyRegistryEvents(db, [start("s1", { transcriptPath: "/Users/drew/.claude/projects/p/one.jsonl" })]);
    expect(getRow("s1")?.transcript_path).toBe("/Users/drew/.claude/projects/p/one.jsonl");

    applyRegistryEvents(db, [start("s1", { transcriptPath: "/Users/drew/.claude/projects/p/two.jsonl", at: at(2) })]);
    expect(getRow("s1")?.transcript_path).toBe("/Users/drew/.claude/projects/p/two.jsonl");

    // A late-join insert carries the path too.
    applyRegistryEvents(db, [
      {
        kind: "SessionObserved",
        provider: "codex",
        sessionId: "c1",
        title: null,
        project: "proj",
        transcriptPath: "/Users/drew/.codex/sessions/rollout-1.jsonl",
        model: null,
        observedAt: at(3),
      },
    ]);
    expect(getRow("c1", "codex")?.transcript_path).toBe("/Users/drew/.codex/sessions/rollout-1.jsonl");

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
          transcriptPath: "/Users/drew/.claude/projects/p/s2.jsonl",
          model: null,
          observedAt: at(5),
        },
      ]),
    ).toEqual(["applied"]);
    expect(getRow("s2")).toMatchObject({
      title: null,
      project: null,
      transcript_path: "/Users/drew/.claude/projects/p/s2.jsonl",
      updated_at: at(4),
    });

    // Status events never disturb the stored path.
    applyRegistryEvents(db, [simple("Activity", "s1", { at: at(6) })]);
    expect(getRow("s1")?.transcript_path).toBe("/Users/drew/.claude/projects/p/two.jsonl");
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
    title: null,
  });

  test("stamps origin and mirrors attention both ways under the watermark", () => {
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

    // Cleared with a later record write (the user viewed it in Paseo) → unread cleared here.
    const cleared = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: "2026-08-06T00:12:00.000Z" }),
    ]);
    expect(cleared).toBe(1);
    expect(getRow("s1")?.unread_since).toBeNull();
  });

  test("falls back to updatedAt as the flag time when attentionTimestamp is absent", () => {
    applyRegistryEvents(db, [start("s1")]);
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: null, updatedAt: FLAG_AT })])).toBe(1);
    expect(getRow("s1")?.unread_since).toBe(FLAG_AT);
  });

  test("a stale cleared record does not clear newer local news (Stop → stale false)", () => {
    const stopAt = at(5); // 2026-08-06T00:00:05.000Z
    applyRegistryEvents(db, [start("s1"), simple("Stop", "s1", { at: stopAt })]);
    expect(getRow("s1")?.unread_since).toBe(stopAt);

    // Stamp origin first so the cleared passes below have nothing else to write.
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: "2026-08-06T00:00:01.000Z" })])).toBe(1);

    // A cleared record whose updatedAt predates the Stop is stale evidence of
    // viewing: it must not clear the newer local result.
    const stale = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: "2026-08-06T00:00:02.000Z" }),
    ]);
    expect(stale).toBe(0);
    expect(getRow("s1")?.unread_since).toBe(stopAt);

    // A cleared record written after the Stop is fresh proof of viewing.
    const fresh = syncPaseoStates(db, [
      paseoState({ requiresAttention: false, updatedAt: "2026-08-06T00:00:09.000Z" }),
    ]);
    expect(fresh).toBe(1);
    expect(getRow("s1")?.unread_since).toBeNull();
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

    // Cleared with no updatedAt must not clear even a Stop-stamped unread.
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

  test("is a no-op when nothing differs (the reprojection fast-path stays quiet)", () => {
    applyRegistryEvents(db, [start("s1")]);

    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: FLAG_AT })])).toBe(1);
    // Identical state on a later pass: unread keeps its flag-time timestamp
    // and the difference guard suppresses the update entirely.
    expect(syncPaseoStates(db, [paseoState({ attentionTimestamp: FLAG_AT })])).toBe(0);

    const read = paseoState({ requiresAttention: false, updatedAt: "2026-08-06T00:13:00.000Z" });
    expect(syncPaseoStates(db, [read])).toBe(1);
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

    // Viewed in Paseo (cleared flag, fresh updatedAt): unread clears and the
    // parent ref is re-stamped (or kept) by the other branch.
    expect(
      syncPaseoStates(db, [
        paseoState({
          requiresAttention: false,
          isSubagent: true,
          parentAgentId: "agent-0",
          updatedAt: "2026-08-06T00:12:00.000Z",
        }),
      ]),
    ).toBe(1);
    expect(getRow("s1")).toMatchObject({ unread_since: null, origin_parent_ref: "agent-0" });
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
    // The abandoned row stays — not deleted, not acknowledged — with only its
    // origin stamps cleared: ledger, status, timers, slot, metadata, and the
    // prune lease (updated_at) all keep their values.
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
