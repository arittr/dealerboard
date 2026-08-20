/**
 * Identity-based tile resolution for deferred tile actions. A long press
 * fires ~500ms after pointerdown, and a pushed snapshot can re-render the
 * grid in between: a dense tile index captured at press time may then point
 * at a different session, silently retargeting the action sheet — and its
 * destructive Clear — at the wrong row. Deferred actions are therefore
 * bound to the pressed session's identity (provider + session id) and
 * resolved against the current keys at fire time; a vanished session
 * resolves to null and the action is cancelled, never retargeted.
 */

import type { KeyModel } from "../../src/plugin/layout";
import type { ProjectedSession, Provider } from "../../src/protocol";

/** The stable identity of a registry row: a session id is unique per provider. */
export type SessionIdentity = { readonly provider: Provider; readonly sessionId: string };

export const identityOf = (session: ProjectedSession): SessionIdentity => ({
  provider: session.provider,
  sessionId: session.sessionId,
});

export type SessionTileRef = {
  /** Dense index the session's tile currently occupies in the visible keys. */
  readonly index: number;
  readonly session: ProjectedSession;
  readonly label: string;
};

/**
 * The tile currently representing this identity, at its current index — or
 * null when the session is no longer on the grid.
 */
export const resolveSessionTile = (keys: readonly KeyModel[], identity: SessionIdentity): SessionTileRef | null => {
  for (let index = 0; index < keys.length; index += 1) {
    const model = keys[index];
    if (model === undefined || model.kind !== "session") {
      continue;
    }
    if (model.session.provider === identity.provider && model.session.sessionId === identity.sessionId) {
      return { index, session: model.session, label: model.label };
    }
  }
  return null;
};
