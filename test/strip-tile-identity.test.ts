import { describe, expect, test } from "bun:test";
import { identityOf, resolveSessionTile, type SessionIdentity } from "../app/src/tile-identity";
import type { KeyModel } from "../src/plugin/layout";
import type { ProjectedSession } from "../src/protocol";

const session = (provider: string, sessionId: string, title: string): ProjectedSession => ({
  provider: provider as ProjectedSession["provider"],
  sessionId,
  status: "idle",
  title,
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
});

const sessionKey = (session: ProjectedSession): Extract<KeyModel, { kind: "session" }> => ({
  kind: "session",
  session,
  label: session.title ?? "",
  degraded: false,
});

describe("identityOf", () => {
  test("captures the provider/session pair that owns a row", () => {
    const claude = session("claude", "s1", "Claude session");
    expect(identityOf(claude)).toEqual({ provider: "claude", sessionId: "s1" });
    const kimi = session("kimi", "s1", "Kimi session");
    expect(identityOf(kimi)).not.toEqual(identityOf(claude));
  });
});

describe("resolveSessionTile", () => {
  test("resolves the identity's tile, following it to its current index", () => {
    const a = sessionKey(session("claude", "a", "A"));
    const b = sessionKey(session("codex", "b", "B"));
    const ref = resolveSessionTile([a, b], { provider: "codex", sessionId: "b" });
    expect(ref).toEqual({ index: 1, session: b.session, label: "B" });
  });

  test("a vanished session never resolves to the tile that shifted into its index", () => {
    // The regression the review probed: A was pressed, A disappeared before
    // the long-press fired, and B shifted into A's old dense index — the
    // sheet (and its Clear action) must not silently retarget to B.
    const pressed: SessionIdentity = { provider: "claude", sessionId: "a" };
    const before = [sessionKey(session("claude", "a", "A")), sessionKey(session("codex", "b", "B"))];
    expect(resolveSessionTile(before, pressed)?.session.sessionId).toBe("a");
    const after = [sessionKey(session("codex", "b", "B"))];
    expect(resolveSessionTile(after, pressed)).toBeNull();
    // B now sits at A's old index 0, but resolves only under its own identity.
    expect(resolveSessionTile(after, { provider: "codex", sessionId: "b" })?.index).toBe(0);
  });

  test("the same session id under another provider is a different row", () => {
    const keys = [sessionKey(session("codex", "shared", "Codex row"))];
    expect(resolveSessionTile(keys, { provider: "claude", sessionId: "shared" })).toBeNull();
  });

  test("non-session keys are skipped, not misread as tiles", () => {
    const a = sessionKey(session("claude", "a", "A"));
    const keys: readonly KeyModel[] = [{ kind: "blank", degraded: false }, a];
    expect(resolveSessionTile(keys, { provider: "claude", sessionId: "a" })?.index).toBe(1);
  });
});
