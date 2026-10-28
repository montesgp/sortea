import { and, asc, count, eq, inArray, schema as s, type Tx } from '@sortea/db';
import { slotState, winnerIdentityPublic, type PublicityDecision, type SlotAward } from '@sortea/domain';
import { prizeOrder, publishedRounds } from './awards';

/** A winner's public identity: never document, email, phone or address (S5). */
export interface PublicWinnerIdentity {
	name: string;
	city: string | null;
	/** Eligible coupons the person holds in the campaign, from every purchase. */
	chances: number;
}

export interface PublicWinnerUnit {
	slot: number;
	round: number;
	role: 'winner' | 'alternate';
	entryNumber: number;
	delivered: boolean;
	/** Null unless the purchase holding the coupon consented and the person did not withdraw it later. */
	identity: PublicWinnerIdentity | null;
}

export interface PublicWinnersPrize {
	position: number;
	title: string;
	quantity: number;
	delivered: number;
	units: PublicWinnerUnit[];
}

/**
 * The public winners table of a campaign (S5), or null while no round's results
 * are published. Awards are public with their round's results, as on the
 * transparency page (ADR 0014 §5). Each unit lists the person holding it: the
 * winner, or the alternate who took the unit after the winner was passed over.
 * The consent check runs here, so a withheld identity never leaves the API.
 */
export async function publicWinners(tx: Tx, campaignId: string): Promise<PublicWinnersPrize[] | null> {
	const published = await publishedRounds(tx, campaignId);
	if (published.size === 0) return null;
	const [prizes, rows] = await Promise.all([
		tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaignId)).orderBy(...prizeOrder),
		tx
			.select({ award: s.prizeAwards, fulfillment: s.prizeFulfillments, entry: s.participationEntries })
			.from(s.prizeAwards)
			.innerJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
			.leftJoin(s.prizeFulfillments, eq(s.prizeFulfillments.awardId, s.prizeAwards.id))
			.where(and(eq(s.prizeAwards.campaignId, campaignId), inArray(s.prizeAwards.round, [...published])))
	]);

	const holders = prizes.map((prize) => {
		const bySlot = new Map<number, typeof rows>();
		for (const row of rows.filter(({ award }) => award.prizeId === prize.id)) bySlot.set(row.award.slot, [...(bySlot.get(row.award.slot) ?? []), row]);
		const held = [...bySlot.entries()]
			.sort(([a], [b]) => a - b)
			.flatMap(([, slotRows]) => {
				const state = slotState(slotRows.map(({ award, fulfillment }): SlotAward => ({ id: award.id, role: award.role, rank: award.rank, status: award.status, fulfillmentStatus: fulfillment?.status ?? null })));
				if (state.state === 'empty' || state.state === 'exhausted') return [];
				return [{ ...slotRows.find(({ award }) => award.id === state.award.id)!, delivered: state.state === 'delivered' }];
			});
		return { prize, held };
	});

	const contactIds = [...new Set(holders.flatMap(({ held }) => held.map(({ entry }) => entry.contactId)))];
	const orderIds = [...new Set(holders.flatMap(({ held }) => held.map(({ entry }) => entry.orderId)))];
	const [decisions, orders, chances] = contactIds.length
		? await Promise.all([
				tx
					.select({ contactId: s.contactConsents.contactId, orderId: s.contactConsents.orderId, granted: s.contactConsents.granted, recordedAt: s.contactConsents.recordedAt })
					.from(s.contactConsents)
					.where(and(eq(s.contactConsents.purpose, 'winner_publicity'), inArray(s.contactConsents.contactId, contactIds)))
					.orderBy(asc(s.contactConsents.recordedAt)),
				tx.select({ id: s.orders.id, buyer: s.orders.buyer }).from(s.orders).where(inArray(s.orders.id, orderIds)),
				tx
					.select({ contactId: s.participationEntries.contactId, value: count() })
					.from(s.participationEntries)
					.where(and(eq(s.participationEntries.campaignId, campaignId), eq(s.participationEntries.status, 'eligible'), inArray(s.participationEntries.contactId, contactIds)))
					.groupBy(s.participationEntries.contactId)
			])
		: [[], [], []];

	const decisionsOf = (contactId: string): PublicityDecision[] =>
		decisions.filter((decision) => decision.contactId === contactId && decision.orderId).map((decision) => ({ orderId: decision.orderId!, granted: decision.granted, recordedAt: decision.recordedAt }));
	const identityOf = (entry: typeof s.participationEntries.$inferSelect): PublicWinnerIdentity | null => {
		if (!winnerIdentityPublic(decisionsOf(entry.contactId), entry.orderId)) return null;
		const buyer = orders.find((order) => order.id === entry.orderId)?.buyer;
		if (!buyer) return null;
		return {
			name: `${buyer.firstName} ${buyer.lastName}`.trim(),
			city: buyer.city ?? null,
			chances: chances.find((row) => row.contactId === entry.contactId)?.value ?? 0
		};
	};

	return holders.map(({ prize, held }) => ({
		position: prize.position,
		title: prize.title,
		quantity: prize.quantity,
		delivered: held.filter((unit) => unit.delivered).length,
		units: held.map(({ award, entry, delivered }) => ({
			slot: award.slot,
			round: award.round,
			role: award.role,
			entryNumber: entry.entryNumber,
			delivered,
			identity: identityOf(entry)
		}))
	}));
}
