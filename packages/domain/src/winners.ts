/**
 * Who a winner's public identity covers (S5; owner-feedback-2026-11-14 S3).
 *
 * Every winner and alternate is published with name, city and chances, with no
 * consent to ask: the identity must match the delivery, which may be recorded
 * on video. Never the document, address, email or phone, which stay in the
 * panel for the delivery. The `winner_publicity` decisions stored before S3
 * stay in `contact_consents` and are no longer read.
 *
 * The live coupon lookup and the draw room name only a coupon that holds an
 * award (winner or alternate, any round). A coupon that merely plays the draw
 * shows no identity until the draw is recorded.
 */
export function liveIdentityApplies(input: { holdsAward: boolean }): boolean {
	return input.holdsAward;
}
