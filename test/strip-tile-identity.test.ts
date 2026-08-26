import { describe, expect, test } from "bun:test";
import type { PlacedCard } from "../app/src/board";
import { identityOf, resolveBoardCard, type SessionIdentity } from "../app/src/tile-identity";
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
  lastEventAt: null,
});

describe("identityOf", () => {
  test("captures the provider/session pair that owns a row", () => {
    const claude = session("claude", "s1", "Claude session");
    expect(identityOf(claude)).toEqual({ provider: "claude", sessionId: "s1" });
    const kimi = session("kimi", "s1", "Kimi session");
    expect(identityOf(kimi)).not.toEqual(identityOf(claude));
  });
});

const placedCard = (session: ProjectedSession): PlacedCard => ({
  session,
  label: session.title ?? "",
  subagent: false,
  parentProject: null,
  degraded: false,
  indent: false,
  spine: "none",
  column: 0,
  row: 0,
});

describe("resolveBoardCard", () => {
  test("resolves the identity's card, following it to its current index", () => {
    const a = placedCard(session("claude", "a", "A"));
    const b = placedCard(session("codex", "b", "B"));
    const ref = resolveBoardCard([a, b], { provider: "codex", sessionId: "b" });
    expect(ref).toEqual({ index: 1, session: b.session, label: "B" });
  });

  test("a vanished session never resolves to the card that shifted into its index", () => {
    const pressed: SessionIdentity = { provider: "claude", sessionId: "a" };
    const before = [placedCard(session("claude", "a", "A")), placedCard(session("codex", "b", "B"))];
    expect(resolveBoardCard(before, pressed)?.session.sessionId).toBe("a");
    const after = [placedCard(session("codex", "b", "B"))];
    expect(resolveBoardCard(after, pressed)).toBeNull();
    // B now sits at A's old index 0, but resolves only under its own identity.
    expect(resolveBoardCard(after, { provider: "codex", sessionId: "b" })?.index).toBe(0);
  });

  test("the same session id under another provider is a different card", () => {
    const cards = [placedCard(session("codex", "shared", "Codex card"))];
    expect(resolveBoardCard(cards, { provider: "claude", sessionId: "shared" })).toBeNull();
  });
});
