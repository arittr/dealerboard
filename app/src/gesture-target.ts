/**
 * Pointer-down capture for board gestures. A pending press binds the pressed
 * card's identity AND its causality watermark at pointer-DOWN: a snapshot
 * ingested mid-stroke re-renders the grid, and reading the stamp at release
 * could consume a result the user never saw. Every deferred settlement —
 * the tap's view, the flick's dismiss, and the sheet's Open and Dismiss —
 * resolves the pressed IDENTITY against the current cards (a card that
 * left the grid cancels; the card that took its index is never retargeted)
 * and consumes `pending.watermark`, never the re-resolved card's current
 * stamp.
 */

import type { PlacedCard } from "./board";
import type { GestureWatermark } from "./bridge";
import type { GesturePoint } from "./gestures";
import { identityOf, interactiveBoardCard, resolveInteractiveBoardCard, type SessionIdentity } from "./tile-identity";

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

/** A pending press settled against the current cards: the pressed identity's card at its current index, paired with the pointer-down watermark. */
export type SettledPress = {
  index: number;
  card: PlacedCard;
  watermark: GestureWatermark;
};

/**
 * Settle a pending press at fire time (click, flick, or long-press). The
 * card is the identity's CURRENT one — routing and eligibility read the
 * facts now on the board — while the watermark stays the captured one.
 * Null when the pressed card is no longer interactive on the grid.
 */
export const resolvePendingPress = (cards: readonly PlacedCard[], pending: PendingPress): SettledPress | null => {
  const ref = resolveInteractiveBoardCard(cards, pending.identity);
  return ref === null ? null : { index: ref.index, card: ref.card, watermark: pending.watermark };
};
