import { and, eq, schema as s, type Tx } from '@sortea/db';
import { couponParseMessage, liveIdentityApplies, padEntryNumber, parseCouponNumber, parseManifest } from '@sortea/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorType, requireAdmin } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { ApiError, notFound, parse } from '../lib/errors';
import { prizeOrder, roundManifest } from './awards';
import { consentedIdentities, type PublicWinnerIdentity } from './winners';

/**
 * Live coupon lookup (S7). On draw night the stream shows the official
 * Quiniela and an operator types each extract: one request answers whether
 * the coupon was sold, whether it plays the current round's draw or already
 * holds an award, and who holds it. The identity follows the winner publicity
 * consent (T6) and is limited to name, city and chances for every role, owners
 * included: this answer is shown on a public stream.
 */

export type LookupIdentity = ({ visibility: 'shown' } & PublicWinnerIdentity) | { visibility: 'withheld' } | { visibility: 'not_applicable' };

const query = z.object({ coupon: z.string().max(40).default('') });

/** The manifest status of one coupon in the current round's published manifest; undefined while there is none. */
async function manifestStatus(tx: Tx, campaign: { id: string; currentRound: number }, entryNumber: number) {
	const manifest = await roundManifest(tx, campaign);
	if (!manifest) return undefined;
	return parseManifest(manifest.content).entries.find((entry) => entry.entryNumber === entryNumber)?.status ?? null;
}

export async function couponLookupRoutes(app: FastifyInstance) {
	const { deps } = app;

	/** What the live screen needs before the first search: no coupon, no holder. */
	app.get('/admin/campaigns/:id/coupon-lookup/context', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.operate');
		const { id } = parse(z.object({ id: z.uuid() }), request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [campaign] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, id));
			if (!campaign) throw notFound('Campaña');
			return { id: campaign.id, title: campaign.title, status: campaign.status, entryDigits: campaign.entryDigits, round: campaign.currentRound };
		});
	});

	app.get('/admin/campaigns/:id/coupon-lookup', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.operate');
		const { id } = parse(z.object({ id: z.uuid() }), request.params);
		const { coupon } = parse(query, request.query);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [campaign] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, id));
			if (!campaign) throw notFound('Campaña');
			const parsed = parseCouponNumber(coupon, campaign.entryDigits);
			if (!parsed.ok) throw new ApiError(400, 'invalid_coupon', couponParseMessage(parsed.reason, campaign.entryDigits));
			const { entryNumber } = parsed;

			const [[entry], status] = await Promise.all([
				tx
					.select()
					.from(s.participationEntries)
					.where(and(eq(s.participationEntries.campaignId, campaign.id), eq(s.participationEntries.entryNumber, entryNumber))),
				manifestStatus(tx, campaign, entryNumber)
			]);
			const awards = entry
				? await tx
						.select({ award: s.prizeAwards, prize: s.prizes })
						.from(s.prizeAwards)
						.innerJoin(s.prizes, eq(s.prizes.id, s.prizeAwards.prizeId))
						.where(and(eq(s.prizeAwards.campaignId, campaign.id), eq(s.prizeAwards.entryId, entry.id)))
						.orderBy(...prizeOrder, s.prizeAwards.round, s.prizeAwards.slot)
				: [];

			let identity: LookupIdentity = { visibility: 'not_applicable' };
			if (entry && liveIdentityApplies({ holdsAward: awards.length > 0, manifestStatus: status ?? null })) {
				const shown = (await consentedIdentities(tx, campaign.id, [entry])).get(entry.id);
				identity = shown ? { visibility: 'shown', ...shown } : { visibility: 'withheld' };
			}
			const outcome = !entry ? 'not_sold' : entry.status;

			// The coupon and the outcome only: never who holds it.
			await audit(tx, {
				organizationId: admin.tenant.id,
				actorType: actorType(admin),
				actorId: admin.identity.userId,
				action: 'campaign.coupon_looked_up',
				targetType: 'campaign',
				targetId: campaign.id,
				metadata: { entryNumber, outcome, identity: identity.visibility, awards: awards.length }
			});

			return {
				campaign: { id: campaign.id, title: campaign.title, entryDigits: campaign.entryDigits, round: campaign.currentRound, status: campaign.status },
				coupon: { entryNumber, label: padEntryNumber(entryNumber, campaign.entryDigits) },
				outcome,
				manifest: status === undefined ? null : { round: campaign.currentRound, status },
				awards: awards.map(({ award, prize }) => ({
					prize: prize.title,
					position: prize.position,
					slot: award.slot,
					round: award.round,
					role: award.role,
					rank: award.rank,
					status: award.status
				})),
				identity
			};
		});
	});
}
