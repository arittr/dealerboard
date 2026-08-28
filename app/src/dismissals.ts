/**
 * Locally-dismissed slats: a flick fires a dismiss whose settlement travels
 * registry → daemon snapshot → push before the row actually leaves the data.
 * Hiding the flicked identity locally bridges that round-trip so the card
 * never pops back for a beat between the animation and the ingest. An entry
 * expires after DISMISS_TTL_MS, so a row the registry refused to settle
 * honestly returns on a later ingest instead of staying silently hidden.
 * The entry also carries the flick's causal watermark: the registry refuses
 * an ack whose watermark predates the row's current result (a newer result
 * landed in transit and is protected), and the ingested snapshot then shows
 * that identity with an unread stamp NEWER than the watermark — the signal
 * that the dismissal was rejected. The hide ends the moment that shows, so
 * the protected result returns at once, badged, instead of hiding for the
 * TTL. flickRemoves is the dismiss-eligibility predicate the whole app
 * shares (flick and action sheet alike): error, or idle holding done/unread
 * — active working/waiting cards can never be dismissed.
 */

import type { Provider, SessionSnapshotV2 } from "../../src/protocol";
import type { BoardSession } from "./board";
import type { GestureWatermark } from "./bridge";

export const DISMISS_TTL_MS = 5_000;

/** True when an ack would take the slat off the board: a retired error or an undismissed idle result. */
export const flickRemoves = (session: BoardSession): boolean =>
  session.status === "error" ||
  (session.status === "idle" && (session.unreadSince !== null || session.doneSince !== null));

const identityKey = (provider: string, sessionId: string): string => `${provider}\u0000${sessionId}`;

export type Dismissals = {
  /** Hide the identity until the TTL, or until a snapshot shows it with a result newer than `watermark`. */
  dismiss: (provider: Provider, sessionId: string, nowMs: number, watermark: GestureWatermark) => void;
  /** The snapshot with active dismissals (and their descendants) hidden; the same object when none are active. */
  filterSnapshot: (snapshot: SessionSnapshotV2, nowMs: number) => SessionSnapshotV2;
};

type Dismissal = { expiresAt: number; watermark: GestureWatermark };

/** True when the snapshot publishes this identity with an unread stamp newer than the flick consumed. */
const surfacedNewerResult = (snapshot: SessionSnapshotV2, key: string, watermark: GestureWatermark): boolean => {
  const newer = (unreadSince: string | null): boolean =>
    unreadSince !== null && (watermark.unreadSince === null || unreadSince > watermark.unreadSince);
  return (
    snapshot.sessions.some(
      (entry) => identityKey(entry.provider, entry.sessionId) === key && newer(entry.unreadSince),
    ) ||
    (snapshot.agents ?? []).some(
      (node) => identityKey(node.provider, node.sessionId) === key && newer(node.unreadSince),
    )
  );
};

export const createDismissals = (): Dismissals => {
  const dismissals = new Map<string, Dismissal>();

  /** The identities still hidden for this snapshot; expired and rejected entries are dropped on the way. */
  const activeKeys = (snapshot: SessionSnapshotV2, nowMs: number): Set<string> => {
    const active = new Set<string>();
    for (const [key, entry] of dismissals) {
      if (nowMs >= entry.expiresAt || surfacedNewerResult(snapshot, key, entry.watermark)) {
        dismissals.delete(key);
      } else {
        active.add(key);
      }
    }
    return active;
  };

  return {
    dismiss: (provider, sessionId, nowMs, watermark) => {
      dismissals.set(identityKey(provider, sessionId), { expiresAt: nowMs + DISMISS_TTL_MS, watermark });
    },
    filterSnapshot: (snapshot, nowMs) => {
      const active = activeKeys(snapshot, nowMs);
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
