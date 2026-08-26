import { describe, expect, test } from "bun:test";
import type { PlacedCard } from "../app/src/board";
import {
  identityOf,
  interactiveBoardCard,
  resolveBoardCard,
  resolveInteractiveBoardCard,
  type SessionIdentity,
} from "../app/src/tile-identity";
import type { ProjectedSession } from "../src/protocol";

const session = (
  provider: string,
  sessionId: string,
  title: string,
  overrides: Partial<ProjectedSession> = {},
): ProjectedSession => ({
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
  ...overrides,
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
  displayOnly: false,
  descendantBadge: session.descendantCount,
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
    expect(ref).toEqual({ index: 1, card: b });
  });

  test("a vanished session never resolves to the card that shifted into its index", () => {
    const pressed: SessionIdentity = { provider: "claude", sessionId: "a" };
    const before = [placedCard(session("claude", "a", "A")), placedCard(session("codex", "b", "B"))];
    expect(resolveBoardCard(before, pressed)?.card.session.sessionId).toBe("a");
    const after = [placedCard(session("codex", "b", "B"))];
    expect(resolveBoardCard(after, pressed)).toBeNull();
    // B now sits at A's old index 0, but resolves only under its own identity.
    expect(resolveBoardCard(after, { provider: "codex", sessionId: "b" })?.index).toBe(0);
  });

  test("the same session id under another provider is a different card", () => {
    const cards = [placedCard(session("codex", "shared", "Codex card"))];
    expect(resolveBoardCard(cards, { provider: "claude", sessionId: "shared" })).toBeNull();
  });

  test("display-only cards are rejected immediately and after identity re-resolution", () => {
    const before = placedCard(session("evener", "child", "Child"));
    const identity = identityOf(before.session);
    const native = { ...before, displayOnly: true };
    expect(interactiveBoardCard(native)).toBeNull();
    expect(resolveInteractiveBoardCard([native], identity)).toBeNull();
  });

  test("root and Paseo cards remain interactive", () => {
    const root = placedCard(session("evener", "root", "Root"));
    const paseo = placedCard(
      session("codex", "paseo", "Paseo", {
        originKind: "paseo",
        originRef: "agent-1",
        originSubagent: true,
      }),
    );
    expect(interactiveBoardCard(root)).toBe(root);
    expect(interactiveBoardCard(paseo)).toBe(paseo);
  });
});
