/**
 * Identity-based tile resolution for deferred tile actions. A long press
 * fires ~500ms after pointerdown, and a pushed snapshot can re-render the
 * grid in between: a dense tile index captured at press time may then point
 * at a different session, silently retargeting the action sheet — and its
 * destructive Clear — at the wrong row. Deferred actions are therefore
 * bound to the pressed session's identity (provider + session id) and
 * resolved against the current cards at fire time; a vanished session
 * resolves to null and the action is cancelled, never retargeted.
 */

import type { ProjectedSession, Provider } from "../../src/protocol";
import type { PlacedCard } from "./board";

/** The stable identity of a registry row: a session id is unique per provider. */
export type SessionIdentity = { readonly provider: Provider; readonly sessionId: string };

export const identityOf = (session: ProjectedSession): SessionIdentity => ({
  provider: session.provider,
  sessionId: session.sessionId,
});

/** The card currently representing this identity, at its current index — or
 *  null when the session is no longer on the board. */
export const resolveBoardCard = (
  cards: readonly PlacedCard[],
  identity: SessionIdentity,
): { index: number; session: ProjectedSession; label: string } | null => {
  for (const [index, card] of cards.entries()) {
    if (card.session.provider === identity.provider && card.session.sessionId === identity.sessionId) {
      return { index, session: card.session, label: card.label };
    }
  }
  return null;
};
