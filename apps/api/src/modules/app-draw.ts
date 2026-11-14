import { randomInt } from 'node:crypto';
import { and, asc, count, eq, max, publishOpsEvent, schema as s, type Tx } from '@sortea/db';
import { appDrawCandidateText, drawAppUnit, padEntryNumber } from '@sortea/domain';
import { sha256Hex } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorType, requireAdminAny } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { ApiError, notFound, parse } from '../lib/errors';
import {
	appDrawCandidates,
	appDrawContext,
	appDrawGate,
	appDrawMessages,
	appDrawUnits,
	campaignForAwards,
	insertSlotAwards,
	maskedHolders,
	notAwarding,
	requireNoPendingPrizeDraw,
	roundTiradas,
	storedAppDraw
} from './awards';

/**
 * Prizes drawn in the application (ADR 0024 as amended by odd/tasks/draw-room.md
 * T3; S4, S5). Once the round's Quiniela draw is recorded, an operator picks one
 * drawable unit (vacant, or whose winner was passed over) and the server draws
 * ONE winner among the eligible coupons that hold no award, with
 * `crypto.randomInt`. The tirada, the award, the public log entry and the audit
 * are stored in one transaction before answering, so the presentation screen
 * only reveals a decided result and a reload replays it. No alternates come
 * from the app. Holders appear only as masked names ("Ju*** P."): never the
 * full name, document, email or phone.
 *
 * The one-shot run of every vacancy (ADR 0024 before the amendment) no longer
 * draws; a stored one is still replayed and published.
 */

type Campaign = typeof s.campaigns.$inferSelect;
type AppDrawRow = typeof s.appDraws.$inferSelect;
type TiradaRow = typeof s.appUnitDraws.$inferSelect;

/** Operators and the draw host (`draws.run`, draw-room T4) run every route of the in-app draw. */
const drawRoles = ['campaigns.operate', 'draws.run'] as const;

/** The note each award carries, as the Quiniela ones name their extract. */
const awardNote = 'Sorteo en la app';

function campaignView(campaign: Campaign) {
	return { id: campaign.id, title: campaign.title, round: campaign.currentRound, entryDigits: campaign.entryDigits, timezone: campaign.timezone };
}

/** A stored one-shot draw as the presentation screen replays it: ordered picks, and every candidate to spin through. */
async function drawView(tx: Tx, campaign: Campaign, record: AppDrawRow) {
	const [prizes, holders] = await Promise.all([
		tx.select({ id: s.prizes.id, title: s.prizes.title }).from(s.prizes).where(eq(s.prizes.campaignId, campaign.id)),
		maskedHolders(tx, campaign.id)
	]);
	const masked = (entryNumber: number) => holders.get(entryNumber)?.maskedName ?? '***';
	const pad = (entryNumber: number) => padEntryNumber(entryNumber, campaign.entryDigits);
	return {
		campaign: campaignView(campaign),
		round: record.round,
		drawnAt: record.drawnAt,
		candidateCount: record.candidateCount,
		candidateSha256: record.candidateSha256,
		picks: record.picks.map((pick) => ({
			prizeId: pick.prizeId,
			prizeTitle: prizes.find((prize) => prize.id === pick.prizeId)?.title ?? '',
			slot: pick.slot,
			role: pick.role,
			rank: pick.rank,
			entryNumber: pad(pick.entryNumber),
			maskedName: masked(pick.entryNumber)
		})),
		candidates: record.candidates.map((entryNumber) => ({ entryNumber: pad(entryNumber), maskedName: masked(entryNumber) }))
	};
}

/** One tirada as the winners table lists it; `withCandidates` adds every candidate for the reel. */
async function tiradaViews(tx: Tx, campaign: Campaign, rows: readonly TiradaRow[], withCandidates: boolean) {
	if (rows.length === 0) return [];
	const [prizes, holders] = await Promise.all([
		tx.select({ id: s.prizes.id, title: s.prizes.title }).from(s.prizes).where(eq(s.prizes.campaignId, campaign.id)),
		maskedHolders(tx, campaign.id)
	]);
	const coupon = (entryNumber: number) => ({ entryNumber: padEntryNumber(entryNumber, campaign.entryDigits), maskedName: holders.get(entryNumber)?.maskedName ?? '***' });
	return rows.map((row) => ({
		round: row.round,
		sequence: row.sequence,
		attempt: row.attempt,
		prizeId: row.prizeId,
		prizeTitle: prizes.find((prize) => prize.id === row.prizeId)?.title ?? '',
		slot: row.slot,
		drawnAt: row.drawnAt,
		candidateCount: row.candidateCount,
		candidateSha256: row.candidateSha256,
		pick: coupon(row.entryNumber),
		...(withCandidates ? { candidates: row.candidates.map(coupon) } : {})
	}));
}

async function tiradaResult(tx: Tx, campaign: Campaign, row: TiradaRow) {
	const [view] = await tiradaViews(tx, campaign, [row], true);
	return { campaign: campaignView(campaign), ...view! };
}

/**
 * "Entre 5 cupones sin premio." for the public log. No hash: each tirada's list is the previous one
 * minus its pick, so its hash would reveal the earlier picks; hash and picks go public with the results.
 */
function drawDetail(record: Pick<AppDrawRow, 'candidateCount'>): string {
	const coupons = record.candidateCount === 1 ? '1 cupón' : `${record.candidateCount} cupones`;
	return `Entre ${coupons} sin premio.`;
}

/** "Sorteo en la app: Moto", "Sorteo en la app: $100.000, unidad 2", with the round from round 2 on. */
function tiradaTitle(prize: { title: string; quantity: number }, slot: number, round: number): string {
	const unit = prize.quantity > 1 ? `${prize.title}, unidad ${slot}` : prize.title;
	return `Sorteo en la app: ${unit}${round > 1 ? ` (ronda ${round})` : ''}`;
}

export async function appDrawRoutes(app: FastifyInstance) {
	const { deps } = app;
	const idParams = z.object({ id: z.uuid() });
	const unitBody = z.object({ prizeId: z.uuid(), slot: z.number().int().min(1).max(10_000) });
	const sequenceParams = idParams.extend({ sequence: z.coerce.number().int().min(1).max(100_000) });

	/** The drawable units and the candidates, computed on the spot and written nowhere; usable before each tirada. */
	app.get('/admin/campaigns/:id/app-draw/preview', async (request) => {
		const admin = await requireAdminAny(request, drawRoles);
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await campaignForAwards(tx, id);
			const { units, candidates } = await appDrawContext(tx, campaign);
			const numbers = candidates.map((candidate) => candidate.entryNumber);
			return {
				campaign: campaignView(campaign),
				vacant: units.map(({ prizeId, prize, slot, alternatesCount }) => ({ prizeId, prizeTitle: prize, slot, alternatesCount })),
				candidates: candidates.map((candidate) => ({ entryNumber: padEntryNumber(candidate.entryNumber, campaign.entryDigits), maskedName: candidate.maskedName })),
				candidateCount: candidates.length,
				candidateSha256: sha256Hex(appDrawCandidateText(numbers, campaign.entryDigits))
			};
		});
	});

	/**
	 * The one-shot run of ADR 0024: a stored one is replayed (200); a new one is
	 * refused, since tiradas are drawn unit by unit (draw-room T3, L4).
	 */
	app.post('/admin/campaigns/:id/app-draw', async (request) => {
		const admin = await requireAdminAny(request, drawRoles);
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await campaignForAwards(tx, id);
			const stored = await storedAppDraw(tx, campaign);
			if (stored) return drawView(tx, campaign, stored);
			throw new ApiError(409, 'app_draw_per_unit', appDrawMessages.app_draw_per_unit);
		});
	});

	/** The stored one-shot draw of the current round, for its replays. */
	app.get('/admin/campaigns/:id/app-draw', async (request) => {
		const admin = await requireAdminAny(request, drawRoles);
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await campaignForAwards(tx, id);
			const stored = await storedAppDraw(tx, campaign);
			if (!stored) throw new ApiError(404, 'app_draw_missing', appDrawMessages.app_draw_missing);
			return drawView(tx, campaign, stored);
		});
	});

	/**
	 * This round's tiradas in order (the winners table), the units that can be
	 * drawn now and the coupons in play, counted; `reason` says why nothing can
	 * be drawn, else null. Never the candidate list: a replay gives it.
	 */
	app.get('/admin/campaigns/:id/app-draw/units', async (request) => {
		const admin = await requireAdminAny(request, drawRoles);
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await campaignForAwards(tx, id);
			return { campaign: campaignView(campaign), ...(await appDrawUnitsView(tx, campaign)) };
		});
	});

	/** One stored tirada of this round with its candidates, for the reel and its replays. */
	app.get('/admin/campaigns/:id/app-draw/units/:sequence', async (request) => {
		const admin = await requireAdminAny(request, drawRoles);
		const { id, sequence } = parse(sequenceParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await campaignForAwards(tx, id);
			const [row] = await tx
				.select()
				.from(s.appUnitDraws)
				.where(and(eq(s.appUnitDraws.campaignId, campaign.id), eq(s.appUnitDraws.round, campaign.currentRound), eq(s.appUnitDraws.sequence, sequence)));
			if (!row) throw notFound('Sorteo en la app');
			return tiradaResult(tx, campaign, row);
		});
	});

	/**
	 * Draws one winner for one unit (a tirada): 201 with the pick and every
	 * candidate. A unit with a winner is refused (409 `unit_has_winner`), so a
	 * repeated request never draws twice; the campaign row lock serializes
	 * simultaneous ones, and the unit's attempt index backs it up.
	 */
	app.post('/admin/campaigns/:id/app-draw/units', async (request, reply) => {
		const admin = await requireAdminAny(request, drawRoles);
		const { id } = parse(idParams, request.params);
		const body = parse(unitBody, request.body);
		const result = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await campaignForAwards(tx, id, true);
			if (campaign.status !== 'awarding') throw notAwarding();
			// An `app` prize is drawn whole, with one drand-backed tirada (draw-room T8): never unit by unit, Quiniela or not.
			const [appPrize] = await tx
				.select({ id: s.prizes.id })
				.from(s.prizes)
				.where(and(eq(s.prizes.id, body.prizeId), eq(s.prizes.campaignId, campaign.id), eq(s.prizes.mechanism, 'app')));
			if (appPrize) throw new ApiError(409, 'unit_not_drawable', appDrawMessages.app_prize_whole);
			const [roundDraw] = await tx
				.select({ id: s.quinielaDraws.id })
				.from(s.quinielaDraws)
				.where(and(eq(s.quinielaDraws.campaignId, campaign.id), eq(s.quinielaDraws.round, campaign.currentRound)));
			if (!roundDraw) throw new ApiError(409, 'quiniela_draw_required', appDrawMessages.quiniela_draw_required);
			const [prize] = await tx.select().from(s.prizes).where(and(eq(s.prizes.id, body.prizeId), eq(s.prizes.campaignId, campaign.id)));
			if (!prize) throw notFound('Premio');
			if (body.slot > prize.quantity) throw new ApiError(400, 'invalid_slot', 'Ese premio no tiene tantas unidades');
			if (prize.mechanism !== 'quiniela') throw new ApiError(409, 'unit_not_drawable', appDrawMessages.unit_not_drawable);
			// A committed tirada of an `app` prize fixed its candidates: none of them is taken meanwhile.
			await requireNoPendingPrizeDraw(tx, campaign.id);
			const [declared] = await tx
				.select({ id: s.prizeSlotVoids.id })
				.from(s.prizeSlotVoids)
				.where(and(eq(s.prizeSlotVoids.prizeId, prize.id), eq(s.prizeSlotVoids.slot, body.slot)));
			if (declared) throw new ApiError(409, 'slot_void', appDrawMessages.slot_void);
			// Drawable: nobody recorded (vacant after the Quiniela) or every recorded person passed over (S5).
			if (!(await appDrawUnits(tx, campaign.id)).some((unit) => unit.prizeId === prize.id && unit.slot === body.slot)) {
				throw new ApiError(409, 'unit_has_winner', appDrawMessages.unit_has_winner);
			}
			const candidates = (await appDrawCandidates(tx, campaign.id)).map((candidate) => candidate.entryNumber);
			const entryNumber = drawAppUnit({ candidates, randomIndex: (size) => randomInt(size) });
			if (entryNumber === null) throw new ApiError(409, 'no_candidates', appDrawMessages.no_candidates);

			const [[inRound], [ofUnit], [winners]] = await Promise.all([
				tx.select({ value: count() }).from(s.appUnitDraws).where(and(eq(s.appUnitDraws.campaignId, campaign.id), eq(s.appUnitDraws.round, campaign.currentRound))),
				tx.select({ value: count() }).from(s.appUnitDraws).where(and(eq(s.appUnitDraws.prizeId, prize.id), eq(s.appUnitDraws.slot, body.slot))),
				tx
					.select({ rank: max(s.prizeAwards.rank) })
					.from(s.prizeAwards)
					.where(and(eq(s.prizeAwards.prizeId, prize.id), eq(s.prizeAwards.slot, body.slot), eq(s.prizeAwards.role, 'winner')))
			]);
			const now = deps.now();
			const [record] = await tx
				.insert(s.appUnitDraws)
				.values({
					organizationId: admin.tenant.id,
					campaignId: campaign.id,
					round: campaign.currentRound,
					sequence: (inRound?.value ?? 0) + 1,
					prizeId: prize.id,
					slot: body.slot,
					attempt: (ofUnit?.value ?? 0) + 1,
					candidateSha256: sha256Hex(appDrawCandidateText(candidates, campaign.entryDigits)),
					candidateCount: candidates.length,
					candidates,
					entryNumber,
					drawnAt: now,
					recordedBy: admin.identity.userId
				})
				.returning();
			// Through the award model, so decisions, delivery, the board and the public winners work as for any result.
			// A unit drawn again keeps the winners passed over before it, ranked first.
			await insertSlotAwards(tx, admin, campaign.id, prize.id, body.slot, campaign.currentRound, [{ entryNumber, notes: awardNote }], {
				appUnitDrawId: record!.id,
				winnerRank: (winners?.rank ?? 0) + 1
			});
			await tx.insert(s.drawEvents).values({
				organizationId: admin.tenant.id,
				campaignId: campaign.id,
				kind: 'app_draw',
				round: campaign.currentRound,
				title: tiradaTitle(prize, body.slot, campaign.currentRound),
				detail: drawDetail(record!),
				occurredAt: now,
				recordedBy: admin.identity.userId
			});
			await audit(tx, {
				organizationId: admin.tenant.id,
				actorType: actorType(admin),
				actorId: admin.identity.userId,
				action: 'award.app_unit_drawn',
				targetType: 'prize',
				targetId: prize.id,
				metadata: {
					round: record!.round,
					sequence: record!.sequence,
					slot: record!.slot,
					attempt: record!.attempt,
					candidateCount: record!.candidateCount,
					candidateSha256: record!.candidateSha256,
					entryNumber
				}
			});
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', campaign.id);
			return tiradaResult(tx, campaign, record!);
		});
		return reply.code(201).send(result);
	});
}

/**
 * This round's tiradas in order, the units that can be drawn now and the
 * coupons in play, counted; `reason` says why nothing can be drawn, else null.
 * The units route and the draw room (draw-room T4) show the same.
 */
export async function appDrawUnitsView(tx: Tx, campaign: Campaign) {
	const tiradas = await tiradaViews(tx, campaign, await roundTiradas(tx, campaign), false);
	const gate = await appDrawGate(tx, campaign).then(
		({ candidateCount }) => ({ candidateCount, reason: null }),
		(error: unknown) => {
			if (!(error instanceof ApiError)) throw error;
			return { candidateCount: error.code === 'no_candidates' ? 0 : null, reason: error.message };
		}
	);
	// The units are listed once the round's Quiniela is in, also when no coupon is left to draw them.
	const listed = campaign.status === 'awarding' && gate.reason !== appDrawMessages.quiniela_draw_required;
	const units = listed ? await appDrawUnits(tx, campaign.id) : [];
	return {
		tiradas,
		units: units.map(({ prizeId, prize, slot, state }) => ({ prizeId, prizeTitle: prize, slot, state })),
		...gate
	};
}

/** Every one-shot in-app draw of a campaign, oldest round first (for the public transparency page). */
export async function campaignAppDraws(tx: Tx, campaignId: string) {
	return tx.select().from(s.appDraws).where(eq(s.appDraws.campaignId, campaignId)).orderBy(asc(s.appDraws.round));
}

/** Every tirada of a campaign, by round then sequence (for the public transparency page). */
export async function campaignTiradas(tx: Tx, campaignId: string) {
	return tx.select().from(s.appUnitDraws).where(eq(s.appUnitDraws.campaignId, campaignId)).orderBy(asc(s.appUnitDraws.round), asc(s.appUnitDraws.sequence));
}

