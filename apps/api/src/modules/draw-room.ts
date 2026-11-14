import { and, count, desc, eq, inArray, schema as s, sql, type Tx } from '@sortea/db';
import { maskHolderName, padEntryNumber, resolveMediaRefs, slotState, type SlotAward } from '@sortea/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/admin-context';
import { notFound, parse } from '../lib/errors';
import type { AppDeps } from '../context';
import { appDrawUnitsView } from './app-draw';
import { appPrizesView } from './app-prize-draw';
import { awardSource, prizeOrder, roundManifest } from './awards';
import { consentedIdentities } from './winners';

/**
 * The draw room (odd/tasks/draw-room.md T4; S3, S4): what the person running
 * the live draw needs and nothing else, read with `draws.run`. The campaign's
 * general data, its prizes, the eligible coupons counted, the round's manifest
 * hash, the round's Quiniela, the winners table and the in-app draw state.
 * Holders appear by masked name ("Ju*** P."), and by public name, city and
 * chances only when their consent allows it, the rule of the live coupon lookup
 * (`consentedIdentities`). Never emails, documents, phones, addresses, amounts,
 * orders, finance, audit or settings.
 */

type Campaign = typeof s.campaigns.$inferSelect;

/**
 * The campaigns with a draw to run or to show: open (on sale, the draw ahead),
 * closed, awarding and fulfilled. Drafts, campaigns in review or published but
 * not open yet, and archived ones have no draw room.
 */
export const drawRoomStatuses = ['open', 'closed', 'awarding', 'fulfilled'] as const;

async function drawRoomCampaign(tx: Tx, id: string): Promise<Campaign> {
	const [campaign] = await tx
		.select()
		.from(s.campaigns)
		.where(and(eq(s.campaigns.id, id), inArray(s.campaigns.status, [...drawRoomStatuses])));
	if (!campaign) throw notFound('Campaña');
	return campaign;
}

/** Who holds each prize unit now, in prize order then unit: the winner, or the alternate who took it. */
async function winnersTable(tx: Tx, campaign: Campaign) {
	const [prizes, rows] = await Promise.all([
		tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaign.id)).orderBy(...prizeOrder),
		tx
			.select({ award: s.prizeAwards, fulfillment: s.prizeFulfillments, entry: s.participationEntries, buyer: s.orders.buyer })
			.from(s.prizeAwards)
			.innerJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
			.innerJoin(s.orders, eq(s.orders.id, s.participationEntries.orderId))
			.leftJoin(s.prizeFulfillments, eq(s.prizeFulfillments.awardId, s.prizeAwards.id))
			.where(eq(s.prizeAwards.campaignId, campaign.id))
	]);
	const held = prizes.flatMap((prize) => {
		const slots = [...new Set(rows.filter(({ award }) => award.prizeId === prize.id).map(({ award }) => award.slot))].sort((a, b) => a - b);
		return slots.flatMap((slot) => {
			const slotRows = rows.filter(({ award }) => award.prizeId === prize.id && award.slot === slot);
			const state = slotState(slotRows.map(({ award, fulfillment }): SlotAward => ({ id: award.id, role: award.role, rank: award.rank, status: award.status, fulfillmentStatus: fulfillment?.status ?? null })));
			if (state.state === 'empty' || state.state === 'exhausted') return [];
			return [{ prize, ...slotRows.find(({ award }) => award.id === state.award.id)! }];
		});
	});
	const identities = await consentedIdentities(tx, campaign.id, held.map(({ entry }) => entry));
	return held.map(({ prize, award, entry, buyer }) => ({
		prizeId: prize.id,
		prizeTitle: prize.title,
		position: prize.position,
		slot: award.slot,
		round: award.round,
		role: award.role,
		source: awardSource(award, prize),
		entryNumber: padEntryNumber(entry.entryNumber, campaign.entryDigits),
		maskedName: maskHolderName(buyer.firstName, buyer.lastName),
		identity: identities.get(entry.id) ?? null
	}));
}

/** Everything the draw room shows of one campaign; `deps.media.publicUrl` resolves library images. */
export async function drawRoomView(tx: Tx, campaign: Campaign, deps: AppDeps) {
	const publicUrl = deps.media.publicUrl;
	const [prizes, [eligible], manifest, [quiniela], winners, appDraw, appPrizes] = await Promise.all([
		tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaign.id)).orderBy(...prizeOrder),
		tx
			.select({ value: count() })
			.from(s.participationEntries)
			.where(and(eq(s.participationEntries.campaignId, campaign.id), eq(s.participationEntries.status, 'eligible'))),
		roundManifest(tx, campaign),
		tx
			.select()
			.from(s.quinielaDraws)
			.where(and(eq(s.quinielaDraws.campaignId, campaign.id), eq(s.quinielaDraws.round, campaign.currentRound))),
		winnersTable(tx, campaign),
		appDrawUnitsView(tx, campaign),
		appPrizesView(tx, deps, campaign)
	]);
	return {
		campaign: {
			id: campaign.id,
			slug: campaign.slug,
			title: campaign.title,
			subtitle: campaign.subtitle,
			status: campaign.status,
			timezone: campaign.timezone,
			drawAt: campaign.drawAt,
			entryDigits: campaign.entryDigits,
			awardOrder: campaign.awardOrder,
			round: campaign.currentRound
		},
		prizes: prizes.map((prize) => ({
			id: prize.id,
			position: prize.position,
			title: prize.title,
			quantity: prize.quantity,
			mechanism: prize.mechanism,
			imageUrl: resolveMediaRefs(prize.imageUrl, publicUrl)
		})),
		coupons: { eligible: eligible?.value ?? 0 },
		manifest: manifest ? { round: manifest.round, sha256: manifest.sha256, eligibleCount: manifest.eligibleCount, publishedAt: manifest.publishedAt } : null,
		quinielaDraw: quiniela ? { round: quiniela.round, source: quiniela.source, drawnAt: quiniela.drawnAt, extracts: quiniela.extracts, evidenceUrl: quiniela.evidenceUrl } : null,
		winners,
		appDraw,
		/** The `app` prizes drawn whole with a drand round (draw-room T8), without the candidate lists. */
		appPrizes: { prizes: appPrizes.prizes, candidateCount: appPrizes.candidateCount, reason: appPrizes.reason }
	};
}

export async function drawRoomRoutes(app: FastifyInstance) {
	const { deps } = app;

	/** The organization's campaigns with a draw room, the latest draw first (no date yet last). */
	app.get('/admin/draw-room/campaigns', async (request) => {
		const admin = await requireAdmin(request, 'draws.run');
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaigns = await tx
				.select()
				.from(s.campaigns)
				.where(inArray(s.campaigns.status, [...drawRoomStatuses]))
				.orderBy(sql`${s.campaigns.drawAt} desc nulls last`, desc(s.campaigns.closesAt), desc(s.campaigns.createdAt));
			return {
				campaigns: campaigns.map((campaign) => ({
					id: campaign.id,
					slug: campaign.slug,
					title: campaign.title,
					subtitle: campaign.subtitle,
					status: campaign.status,
					timezone: campaign.timezone,
					drawAt: campaign.drawAt,
					round: campaign.currentRound
				}))
			};
		});
	});

	app.get('/admin/draw-room/campaigns/:id', async (request) => {
		const admin = await requireAdmin(request, 'draws.run');
		const { id } = parse(z.object({ id: z.uuid() }), request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => drawRoomView(tx, await drawRoomCampaign(tx, id), deps));
	});
}
