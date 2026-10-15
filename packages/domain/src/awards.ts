/**
 * Prize awards and fulfillment (FR-CAMP-03/04, AC-06, DRAW-INTEGRITY 5-6).
 *
 * The platform never selects winners. People record the result of the
 * authorized mechanism, entry numbers are checked against the published
 * manifest, and every later step (verification, alternates, delivery) is a
 * recorded decision. Each prize unit is a slot with its own winner,
 * alternates and delivery, independent of every other slot.
 */
export type AwardRole = 'winner' | 'alternate';
export type AwardStatus = 'pending_verification' | 'accepted' | 'declined' | 'substituted' | 'void';
export type FulfillmentStatus = 'pending' | 'scheduled' | 'delivered' | 'failed';

export interface SlotAward {
	readonly id: string;
	readonly role: AwardRole;
	readonly rank: number;
	readonly status: AwardStatus;
	readonly fulfillmentStatus: FulfillmentStatus | null;
}

/** Winner first, then alternates by rank: the order in which people are offered the prize. */
export function orderSlot<T extends Pick<SlotAward, 'role' | 'rank'>>(awards: readonly T[]): T[] {
	return [...awards].sort((a, b) => (a.role === b.role ? a.rank - b.rank : a.role === 'winner' ? -1 : 1));
}

const passedOver: readonly AwardStatus[] = ['declined', 'void'];

export type SlotState =
	| { readonly state: 'empty' }
	/** Someone holds the slot; `award` is the only one that can be decided. */
	| { readonly state: 'verifying'; readonly award: SlotAward }
	| { readonly state: 'accepted'; readonly award: SlotAward }
	| { readonly state: 'delivered'; readonly award: SlotAward }
	/** Every recorded person declined or was voided: the prize follows the published rules. */
	| { readonly state: 'exhausted' };

export function slotState(awards: readonly SlotAward[]): SlotState {
	if (awards.length === 0) return { state: 'empty' };
	const active = orderSlot(awards).find((award) => !passedOver.includes(award.status));
	if (!active) return { state: 'exhausted' };
	if (active.status === 'accepted') return active.fulfillmentStatus === 'delivered' ? { state: 'delivered', award: active } : { state: 'accepted', award: active };
	return { state: 'verifying', award: active };
}

/** A slot is resolved when its prize was delivered or nobody is left to offer it to. */
export function slotResolved(awards: readonly SlotAward[]): boolean {
	const state = slotState(awards).state;
	return state === 'delivered' || state === 'exhausted';
}

export type AwardDecision = 'accepted' | 'declined' | 'void';

export type DecisionCheck = { ok: true } | { ok: false; reason: 'not_active' | 'already_decided' };

/** Only the person currently holding the slot can be accepted, declined or voided, once. */
export function canDecide(slot: readonly SlotAward[], awardId: string): DecisionCheck {
	const award = slot.find((candidate) => candidate.id === awardId);
	if (!award || award.status !== 'pending_verification') return { ok: false, reason: 'already_decided' };
	const state = slotState(slot);
	if (state.state !== 'verifying' || state.award.id !== awardId) return { ok: false, reason: 'not_active' };
	return { ok: true };
}

/** A slot's result can be re-entered (to fix a typo) only before anyone was decided and before results are published. */
export function canRecordSlot(existing: readonly SlotAward[], resultsPublished: boolean): boolean {
	return !resultsPublished && existing.every((award) => award.status === 'pending_verification');
}

export interface SlotResultInput {
	readonly winner: number;
	readonly alternates: readonly number[];
	readonly alternatesAllowed: number;
}

export type SlotResultCheck =
	| { ok: true }
	| { ok: false; reason: 'too_many_alternates' | 'duplicate_entry' | 'not_in_manifest' | 'not_eligible' | 'already_awarded'; entryNumber?: number };

/**
 * Checks a slot result against the published manifest. `manifestStatus`
 * answers the status an entry number had when the list was frozen;
 * `awardedElsewhere` holds entry numbers already used by other slots.
 */
export function checkSlotResult(
	input: SlotResultInput,
	manifestStatus: (entryNumber: number) => 'eligible' | 'void' | null,
	awardedElsewhere: ReadonlySet<number>
): SlotResultCheck {
	if (input.alternates.length > input.alternatesAllowed) return { ok: false, reason: 'too_many_alternates' };
	const numbers = [input.winner, ...input.alternates];
	const seen = new Set<number>();
	for (const entryNumber of numbers) {
		if (seen.has(entryNumber)) return { ok: false, reason: 'duplicate_entry', entryNumber };
		seen.add(entryNumber);
		const status = manifestStatus(entryNumber);
		if (status === null) return { ok: false, reason: 'not_in_manifest', entryNumber };
		if (status !== 'eligible') return { ok: false, reason: 'not_eligible', entryNumber };
		if (awardedElsewhere.has(entryNumber)) return { ok: false, reason: 'already_awarded', entryNumber };
	}
	return { ok: true };
}

const fulfillmentTransitions: Record<FulfillmentStatus, readonly FulfillmentStatus[]> = {
	pending: ['scheduled', 'delivered', 'failed'],
	scheduled: ['delivered', 'failed', 'pending'],
	failed: ['scheduled', 'pending'],
	delivered: []
};

/** Delivery is final once recorded; a failed attempt can be scheduled again. */
export function canMoveFulfillment(from: FulfillmentStatus | null, to: FulfillmentStatus): boolean {
	if (from === null) return to !== 'failed';
	return from !== to && fulfillmentTransitions[from].includes(to);
}
