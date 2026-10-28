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
 * - a refusal recorded later by the same person withdraws it, for every
 *   earlier purchase: another purchase left the box unchecked, or the person
 *   asked the organization to withdraw it (a refusal with no purchase,
 *   recorded from the order detail of the panel, S9);
 * - a consent recorded later never publishes a purchase that declined. The
 *   document typed at checkout proves no identity (ADR 0004), so anyone could
 *   otherwise expose a winner by buying with their document and checking the box.
 */
export interface PublicityDecision {
	/** Null for a withdrawal on request, which belongs to no purchase and never grants anything. */
	readonly orderId: string | null;
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

/** What the order detail of the panel says about a purchase's consent (S9). */
export interface OrderPublicity {
	/** Whether a winning coupon of this purchase would show its holder's identity now. */
	publishable: boolean;
	/** Whether any purchase of the person would show it now, so a withdrawal on request would change something. */
	withdrawable: boolean;
	/** The withdrawal on request that took this purchase's consent back, if any. */
	withdrawnAt: Date | null;
}

export function orderPublicity(decisions: readonly PublicityDecision[], orderId: string): OrderPublicity {
	const own = decisions.find((decision) => decision.orderId === orderId);
	const withdrawal = own?.granted
		? decisions
				.filter((decision) => decision.orderId === null && !decision.granted && decision.recordedAt.getTime() >= own.recordedAt.getTime())
				.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())[0]
		: undefined;
	return {
		publishable: winnerIdentityPublic(decisions, orderId),
		withdrawable: decisions.some((decision) => decision.orderId !== null && winnerIdentityPublic(decisions, decision.orderId)),
		withdrawnAt: withdrawal?.recordedAt ?? null
	};
}

/**
 * Whether the live coupon lookup may show a coupon's identity, with the same
 * consent rule as above. The consent reads "si gano", so only a coupon that
 * holds an award (winner or alternate, any round) qualifies. A coupon that
 * merely plays the draw shows no identity until the draw is recorded.
 */
export function liveIdentityApplies(input: { holdsAward: boolean }): boolean {
	return input.holdsAward;
}
