/**
 * Pointer-down capture for board gestures. A pending press binds the pressed
 * card's identity AND its causality watermark at pointer-DOWN: a snapshot
 * ingested mid-stroke re-renders the grid, and reading the stamp at release
 * could consume a result the user never saw. Flick and sheet dismissals
 * consume `pending.watermark`, never the re-resolved card's current stamp.
 */

import type { PlacedCard } from "./board";
import type { GestureWatermark } from "./bridge";
import type { GesturePoint } from "./gestures";
import { identityOf, interactiveBoardCard, type SessionIdentity } from "./tile-identity";

export type PendingPress = {
  identity: SessionIdentity;
  point: GesturePoint;
  /** The unread stamp the pressed card showed at pointer-down (`{ unreadSince: null }` when it showed no badge — still causal, never the unconditional bare null). */
  watermark: GestureWatermark;
};

export const capturePendingPress = (
  cards: readonly PlacedCard[],
  index: number,
  point: GesturePoint,
): PendingPress | null => {
  const card = interactiveBoardCard(cards[index]);
  if (card === null) {
    return null;
  }
  return { identity: identityOf(card.session), point, watermark: { unreadSince: card.session.unreadSince } };
};
