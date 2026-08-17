import { describe, expect, test } from "bun:test";
import {
  type ProjectedSession,
  type Provider,
  parseSessionSnapshot,
  type RegistryEvent,
  type SessionOriginKind,
  type SessionSnapshotV2,
  type SessionStatus,
} from "../src/protocol";

const valid: SessionSnapshotV2 = {
  schemaVersion: 2,
  health: { status: "ok" },
  sessions: [
    {
      provider: "claude",
      sessionId: "session-1",
      status: "waiting",
      title: "Review",
      project: "stream-deck-agents",
      descendantCount: 2,
      logicalSlot: 1,
      ghosttyTerminalId: "terminal-1",
      model: null,
      originKind: null,
      originRef: null,
      originSubagent: false,
    },
  ],
};

const firstSession = (): ProjectedSession => {
  const session = valid.sessions[0];
  if (session === undefined) {
    throw new Error("test fixture must contain one session");
  }
  return session;
};

const withSession = (mutation: Partial<ProjectedSession>): unknown => ({
  ...valid,
  sessions: [{ ...firstSession(), ...mutation }],
});

const titleEvent: RegistryEvent = {
  kind: "SessionTitleChanged",
  provider: "pi",
  sessionId: "s1",
  title: "Renamed session",
  observedAt: "2026-08-06T00:00:00.000Z",
};
void titleEvent;

describe("parseSessionSnapshot", () => {
  test("accepts a minimal valid snapshot and returns an equal, newly constructed value", () => {
    const result = parseSessionSnapshot(valid);
    expect(result).toEqual(valid);
    expect(result).not.toBe(valid);
    expect(result.health).not.toBe(valid.health);
    expect(result.sessions).not.toBe(valid.sessions);
    expect(result.sessions[0]).not.toBe(firstSession());
  });

  test("accepts the optional bounded health.message, null title/project, and empty sessions", () => {
    const withMessage = parseSessionSnapshot({
      ...valid,
      health: { status: "error", message: "database busy" },
      sessions: [],
    });
    expect(withMessage.health).toEqual({ status: "error", message: "database busy" });
    expect(withMessage.sessions).toEqual([]);

    const withNulls = parseSessionSnapshot(withSession({ title: null, project: null }));
    expect(withNulls.sessions[0]?.title).toBeNull();
    expect(withNulls.sessions[0]?.project).toBeNull();
  });

  test("rejects a wrong or coerced schemaVersion", () => {
    expect(() => parseSessionSnapshot({ ...valid, schemaVersion: 1 })).toThrow();
    expect(() => parseSessionSnapshot({ ...valid, schemaVersion: 0 })).toThrow();
    expect(() => parseSessionSnapshot({ ...valid, schemaVersion: "1" })).toThrow();
  });

  test("rejects non-object input", () => {
    for (const input of [null, undefined, "snapshot", 42, true, [], () => {}]) {
      expect(() => parseSessionSnapshot(input)).toThrow();
    }
  });

  test("rejects absent required properties", () => {
    const { health: _health, ...noHealth } = valid;
    expect(() => parseSessionSnapshot(noHealth)).toThrow();
    const { sessions: _sessions, ...noSessions } = valid;
    expect(() => parseSessionSnapshot(noSessions)).toThrow();
    const { schemaVersion: _schemaVersion, ...noVersion } = valid;
    expect(() => parseSessionSnapshot(noVersion)).toThrow();

    const required: Array<keyof ProjectedSession> = [
      "provider",
      "sessionId",
      "status",
      "title",
      "project",
      "descendantCount",
      "logicalSlot",
      "ghosttyTerminalId",
    ];
    for (const key of required) {
      const session = { ...firstSession() } as Partial<ProjectedSession>;
      delete session[key];
      expect(() => parseSessionSnapshot({ ...valid, sessions: [session] })).toThrow();
    }
  });

  test("rejects unknown providers and statuses", () => {
    expect(() => parseSessionSnapshot(withSession({ provider: "gpt" as Provider }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ provider: "" as Provider }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ status: "stopped" as SessionStatus }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ status: "WAITING" as SessionStatus }))).toThrow();
    expect(() => parseSessionSnapshot({ ...valid, health: { status: "degraded" } })).toThrow();
  });

  test("requires a nullable Claude Ghostty terminal ID in schema v2", () => {
    expect(parseSessionSnapshot(withSession({ ghosttyTerminalId: null })).sessions[0]?.ghosttyTerminalId).toBeNull();
    expect(() => parseSessionSnapshot(withSession({ ghosttyTerminalId: "" }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ ghosttyTerminalId: "x".repeat(257) }))).toThrow();

    const session = { ...firstSession() } as Partial<ProjectedSession>;
    delete session.ghosttyTerminalId;
    expect(() => parseSessionSnapshot({ ...valid, sessions: [session] })).toThrow();
  });

  test("defaults a missing model key to null", () => {
    // Cross-version tolerance: snapshots written before the model field
    // existed parse cleanly, reporting no model.
    const session = { ...firstSession() } as Partial<ProjectedSession>;
    delete session.model;
    const result = parseSessionSnapshot({ ...valid, sessions: [session] });
    expect(result.sessions[0]?.model).toBeNull();
  });

  test("accepts a bounded string model", () => {
    expect(parseSessionSnapshot(withSession({ model: "claude-fable-5" })).sessions[0]?.model).toBe("claude-fable-5");
    expect(parseSessionSnapshot(withSession({ model: null })).sessions[0]?.model).toBeNull();
  });

  test("rejects an invalid model", () => {
    expect(() => parseSessionSnapshot(withSession({ model: 42 as unknown as string }))).toThrow(
      "session.model must be null or a bounded string",
    );
    expect(() => parseSessionSnapshot(withSession({ model: "m".repeat(257) }))).toThrow();
    // A present undefined is an invalid value, not a missing key.
    expect(() => parseSessionSnapshot(withSession({ model: undefined as unknown as string }))).toThrow(
      "session.model must be null or a bounded string",
    );
  });

  test("parseSession defaults missing origin fields (old daemon snapshot still parses)", () => {
    // A snapshot from a daemon predating the origin fields carries none of
    // the three keys; parsing must default rather than reject.
    const session = { ...firstSession() } as Partial<ProjectedSession>;
    delete session.originKind;
    delete session.originRef;
    delete session.originSubagent;
    const parsed = parseSessionSnapshot({ ...valid, sessions: [session] });
    expect(parsed.sessions[0]).toMatchObject({
      originKind: null,
      originRef: null,
      originSubagent: false,
    });

    // Present-and-valid origin evidence flows through unchanged.
    const explicit = parseSessionSnapshot(
      withSession({ originKind: "paseo", originRef: "agent-1", originSubagent: true }),
    );
    expect(explicit.sessions[0]).toMatchObject({
      originKind: "paseo",
      originRef: "agent-1",
      originSubagent: true,
    });
  });

  test("parseSession rejects an unknown originKind", () => {
    expect(() => parseSessionSnapshot(withSession({ originKind: "bogus" as SessionOriginKind }))).toThrow(
      "invalid session snapshot",
    );
    expect(() => parseSessionSnapshot(withSession({ originKind: 7 as unknown as SessionOriginKind }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ originKind: null }))).not.toThrow();
    expect(() => parseSessionSnapshot(withSession({ originRef: 7 as unknown as string }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ originRef: "x".repeat(257) }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ originSubagent: "yes" as unknown as boolean }))).toThrow();
  });

  test("rejects non-Claude activation targets and every non-v2 schema", () => {
    expect(() => parseSessionSnapshot(withSession({ provider: "codex", ghosttyTerminalId: "terminal-1" }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ provider: "kimi", ghosttyTerminalId: "terminal-1" }))).toThrow();
    expect(() => parseSessionSnapshot({ ...valid, schemaVersion: 1 })).toThrow();
    expect(() => parseSessionSnapshot({ ...valid, schemaVersion: 3 })).toThrow();
    expect(() => parseSessionSnapshot({ ...valid, schemaVersion: "2" })).toThrow();
  });

  test("rejects negative or non-integer descendantCount", () => {
    expect(() => parseSessionSnapshot(withSession({ descendantCount: -1 }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ descendantCount: 1.5 }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ descendantCount: "2" as unknown as number }))).toThrow();
  });

  test("rejects non-positive or non-integer logicalSlot", () => {
    expect(() => parseSessionSnapshot({ ...valid, sessions: [{ ...firstSession(), logicalSlot: 0 }] })).toThrow();
    expect(() => parseSessionSnapshot(withSession({ logicalSlot: -2 }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ logicalSlot: 1.5 }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ logicalSlot: "1" as unknown as number }))).toThrow();
  });

  test("rejects duplicate logical slots in one snapshot", () => {
    expect(() =>
      parseSessionSnapshot({
        ...valid,
        sessions: [firstSession(), { ...firstSession(), sessionId: "session-2" }],
      }),
    ).toThrow();

    const distinct = parseSessionSnapshot({
      ...valid,
      sessions: [firstSession(), { ...firstSession(), sessionId: "session-2", logicalSlot: 2 }],
    });
    expect(distinct.sessions).toHaveLength(2);
  });

  test("rejects strings longer than 256 code points, counted as code points", () => {
    const boundary = "a".repeat(256);
    const overBound = "a".repeat(257);
    expect(parseSessionSnapshot(withSession({ sessionId: boundary })).sessions[0]?.sessionId).toBe(boundary);
    expect(() => parseSessionSnapshot(withSession({ sessionId: overBound }))).toThrow();

    // Astral characters count once per code point, not per UTF-16 code unit.
    const astral = "😀".repeat(256);
    expect(astral.length).toBe(512);
    expect(parseSessionSnapshot(withSession({ title: astral })).sessions[0]?.title).toBe(astral);
    expect(() => parseSessionSnapshot(withSession({ title: `${astral}😀` }))).toThrow();

    expect(() => parseSessionSnapshot(withSession({ project: overBound }))).toThrow();
  });

  test("rejects unbounded or wrongly typed health.message", () => {
    expect(() => parseSessionSnapshot({ ...valid, health: { status: "ok", message: "m".repeat(257) } })).toThrow();
    expect(() =>
      parseSessionSnapshot({ ...valid, health: { status: "ok", message: 7 as unknown as string } }),
    ).toThrow();
    expect(() =>
      parseSessionSnapshot({ ...valid, health: { status: "ok", message: null as unknown as string } }),
    ).toThrow();
  });

  test("does not silently coerce values", () => {
    expect(() => parseSessionSnapshot(withSession({ sessionId: 123 as unknown as string }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ title: undefined as unknown as null }))).toThrow();
    expect(() => parseSessionSnapshot(withSession({ title: 0 as unknown as null }))).toThrow();
    expect(() => parseSessionSnapshot({ ...valid, sessions: "none" as unknown as [] })).toThrow();
    expect(() => parseSessionSnapshot({ ...valid, health: "ok" as unknown as object })).toThrow();
  });

  test.each(["pi", "omp", "zcode", "deepseek", "grok"] as const)("accepts provider %s", (provider) => {
    const result = parseSessionSnapshot(withSession({ provider, ghosttyTerminalId: null }));
    expect(result.sessions[0]?.provider).toBe(provider);
  });

  test("still rejects an unknown provider", () => {
    expect(() => parseSessionSnapshot(withSession({ provider: "vscode" as never }))).toThrow(
      "session.provider is not a known provider",
    );
  });
});

describe("RegistryEvent", () => {
  test("the normalized union covers every event kind", () => {
    const observedAt = "2026-08-06T00:00:00.000Z";
    const events: RegistryEvent[] = [
      {
        kind: "SessionStart",
        provider: "claude",
        sessionId: "s1",
        title: "T",
        project: "p",
        ghosttyTerminalId: null,
        transcriptPath: null,
        model: null,
        observedAt,
      },
      {
        kind: "SessionObserved",
        provider: "kimi",
        sessionId: "s1",
        title: null,
        project: "p",
        transcriptPath: null,
        model: null,
        observedAt,
      },
      { kind: "Activity", provider: "codex", sessionId: "s1", observedAt },
      { kind: "Attention", provider: "kimi", sessionId: "s1", observedAt },
      { kind: "Stop", provider: "claude", sessionId: "s1", observedAt },
      { kind: "StopFailure", provider: "claude", sessionId: "s1", observedAt },
      { kind: "SessionEnd", provider: "claude", sessionId: "s1", observedAt },
      {
        kind: "SubagentStart",
        provider: "claude",
        sessionId: "s2",
        parentSessionId: "s1",
        title: null,
        project: null,
        observedAt,
      },
      { kind: "SubagentStop", provider: "claude", sessionId: "s2", observedAt },
    ];
    expect(events.map((event) => event.kind)).toEqual([
      "SessionStart",
      "SessionObserved",
      "Activity",
      "Attention",
      "Stop",
      "StopFailure",
      "SessionEnd",
      "SubagentStart",
      "SubagentStop",
    ]);
  });
});
