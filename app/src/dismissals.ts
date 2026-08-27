/**
 * Locally-dismissed slats: a flick fires an ack whose settlement travels
 * registry → daemon snapshot → push before the row actually leaves the data.
 * Hiding the flicked identity locally bridges that round-trip so the card
 * never pops back for a beat between the animation and the ingest. An entry
 * expires after DISMISS_TTL_MS, so a row the registry refused to settle
 * honestly returns on a later ingest instead of staying silently hidden.
 */

import type { Provider, SessionSnapshotV2 } from "../../src/protocol";
import type { BoardSession } from "./board";

export const DISMISS_TTL_MS = 5_000;

/** True when an ack would take the slat off the board: a retired error or an undismissed idle result. */
export const flickRemoves = (session: BoardSession): boolean =>
  session.status === "error" ||
  (session.status === "idle" && (session.unreadSince !== null || session.doneSince !== null));

const identityKey = (provider: string, sessionId: string): string => `${provider}\u0000${sessionId}`;

export type Dismissals = {
  dismiss: (provider: Provider, sessionId: string, nowMs: number) => void;
  /** The snapshot with active dismissals (and their descendants) hidden; the same object when none are active. */
  filterSnapshot: (snapshot: SessionSnapshotV2, nowMs: number) => SessionSnapshotV2;
};

export const createDismissals = (): Dismissals => {
  const expiresAt = new Map<string, number>();

  const activeKeys = (nowMs: number): Set<string> => {
    const active = new Set<string>();
    for (const [key, expiry] of expiresAt) {
      if (nowMs >= expiry) {
        expiresAt.delete(key);
      } else {
        active.add(key);
      }
    }
    return active;
  };

  return {
    dismiss: (provider, sessionId, nowMs) => {
      expiresAt.set(identityKey(provider, sessionId), nowMs + DISMISS_TTL_MS);
    },
    filterSnapshot: (snapshot, nowMs) => {
      const active = activeKeys(nowMs);
      if (active.size === 0) {
        return snapshot;
      }
      // Agents arrive parents-before-children (the projection's DFS order),
      // so one pass drops a dismissed node's subtree along with it.
      const dropped = new Set<string>();
      const hidden = (provider: string, sessionId: string, parent: { provider: string; sessionId: string } | null) => {
        const key = identityKey(provider, sessionId);
        if (active.has(key) || (parent !== null && dropped.has(identityKey(parent.provider, parent.sessionId)))) {
          dropped.add(key);
          return true;
        }
        return false;
      };
      const agents =
        snapshot.agents === null
          ? null
          : snapshot.agents.filter((node) => !hidden(node.provider, node.sessionId, node.parent));
      return {
        ...snapshot,
        sessions: snapshot.sessions.filter((entry) => {
          const key = identityKey(entry.provider, entry.sessionId);
          return !active.has(key) && !dropped.has(key);
        }),
        agents,
      };
    },
  };
};
