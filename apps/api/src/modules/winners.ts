import { and, count, eq, inArray, schema as s, type Tx } from '@sortea/db';
import { slotState, type SlotAward } from '@sortea/domain';
import { awardSource, prizeOrder, publishedRounds, type AwardSource } from './awards';

/** A winner's public identity: never document, email, phone or address (S5, owner-feedback-2026-11-14 S3). */
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
	/** `app_draw` is labelled "Sorteo en la app" (ADR 0024). */
	source: AwardSource;
	entryNumber: number;
	delivered: boolean;
	/** Always published with the results: no consent is asked (owner-feedback-2026-11-14 S3). */
	identity: PublicWinnerIdentity;
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
 * winner, or the alternate who took the unit after the winner was passed over,
 * with name, city and chances. Only those fields leave the API.
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

	const identities = await winnerIdentities(tx, campaignId, holders.flatMap(({ held }) => held.map(({ entry }) => entry)));

	return holders.map(({ prize, held }) => ({
		position: prize.position,
		title: prize.title,
		quantity: prize.quantity,
		delivered: held.filter((unit) => unit.delivered).length,
		units: held.map(({ award, entry, delivered }) => ({
			slot: award.slot,
			round: award.round,
			role: award.role,
			source: awardSource(award, prize),
			entryNumber: entry.entryNumber,
			delivered,
			identity: identities.get(entry.id)!
		}))
	}));
}

/**
 * The public identity of each given coupon's holder, keyed by entry id: the
 * buyer's name and city from the purchase holding the coupon, and the chances
 * the person holds in the campaign (owner-feedback-2026-11-14 S3: no consent).
 * The caller decides which coupons qualify: winners once results are published
 * (S5), award holders during the live draw (S7).
 */
export async function winnerIdentities(
	tx: Tx,
	campaignId: string,
	entries: readonly Pick<typeof s.participationEntries.$inferSelect, 'id' | 'contactId' | 'orderId'>[]
): Promise<Map<string, PublicWinnerIdentity>> {
	const contactIds = [...new Set(entries.map((entry) => entry.contactId))];
	const orderIds = [...new Set(entries.map((entry) => entry.orderId))];
	const [orders, chances] = contactIds.length
		? await Promise.all([
				tx.select({ id: s.orders.id, buyer: s.orders.buyer }).from(s.orders).where(inArray(s.orders.id, orderIds)),
				tx
					.select({ contactId: s.participationEntries.contactId, value: count() })
					.from(s.participationEntries)
					.where(and(eq(s.participationEntries.campaignId, campaignId), eq(s.participationEntries.status, 'eligible'), inArray(s.participationEntries.contactId, contactIds)))
					.groupBy(s.participationEntries.contactId)
			])
		: [[], []];

	const identities = new Map<string, PublicWinnerIdentity>();
	for (const entry of entries) {
		const buyer = orders.find((order) => order.id === entry.orderId)?.buyer;
		if (!buyer) continue;
		identities.set(entry.id, {
			name: `${buyer.firstName} ${buyer.lastName}`.trim(),
			city: buyer.city ?? null,
			chances: chances.find((row) => row.contactId === entry.contactId)?.value ?? 0
		});
	}
	return identities;
}
