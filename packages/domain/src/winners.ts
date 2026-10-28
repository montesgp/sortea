/**
 * Who a public winners table may name (S5).
 *
 * Every purchase that gives chances records a `winner_publicity` decision: the
 * buyer agrees, or not, to have their name, city and chances published if a
 * coupon of that purchase wins. The decision travels with the purchase, and the
 * person's newer refusals always win:
 *
 * - the identity is published only when the purchase holding the winning
 *   coupon granted it;
 * - a refusal recorded later by the same person (another purchase left the box
 *   unchecked) withdraws it, for every earlier purchase;
 * - a consent recorded later never publishes a purchase that declined. The
 *   document typed at checkout proves no identity (ADR 0004), so anyone could
 *   otherwise expose a winner by buying with their document and checking the box.
 */
export interface PublicityDecision {
	readonly orderId: string;
	readonly granted: boolean;
	readonly recordedAt: Date;
}

/** `decisions` are every `winner_publicity` decision of the person who holds the winning coupon. */
export function winnerIdentityPublic(decisions: readonly PublicityDecision[], winningOrderId: string): boolean {
	const own = decisions.find((decision) => decision.orderId === winningOrderId);
	if (!own?.granted) return false;
	// A refusal recorded at the same instant counts as newer: when in doubt, the identity stays private.
	return !decisions.some((decision) => decision.orderId !== winningOrderId && !decision.granted && decision.recordedAt.getTime() >= own.recordedAt.getTime());
}
