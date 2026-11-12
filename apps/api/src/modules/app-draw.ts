import { randomInt } from 'node:crypto';
import { asc, eq, publishOpsEvent, schema as s, type Tx } from '@sortea/db';
import { appDrawCandidateText, drawVacantSlots, padEntryNumber } from '@sortea/domain';
import { sha256Hex } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorType, requireAdmin } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { ApiError, parse } from '../lib/errors';
import { appDrawContext, appDrawMessages, campaignForAwards, insertSlotAwards, maskedHolders, storedAppDraw } from './awards';

/**
 * Vacant prizes drawn in the application (ADR 0024; odd/tasks/owner-feedback-2026-11-11b.md,
 * T9, L14). When the round's Quiniela draw leaves units vacant, an operator
 * draws them among the eligible coupons that hold no award. The server picks
 * with `crypto.randomInt` and stores the awards, the record, the public log
 * entry and the audit in one transaction before answering, so the
 * presentation screen only reveals a decided result and a reload replays it.
 * Holders appear only as masked names ("Ju*** P."): never the full name,
 * document, email or phone.
 */

type Campaign = typeof s.campaigns.$inferSelect;
type AppDrawRow = typeof s.appDraws.$inferSelect;

/** The note each award carries, as the Quiniela ones name their extract. */
const awardNote = 'Sorteo en la app';

function campaignView(campaign: Campaign) {
	return { id: campaign.id, title: campaign.title, round: campaign.currentRound, entryDigits: campaign.entryDigits, timezone: campaign.timezone };
}

/** The stored draw as the presentation screen replays it: ordered picks, and every candidate to spin through. */
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

/** "Entre 5 cupones sin premio. SHA-256 de la lista de cupones: …." for the public log; the picks go public with the results. */
function drawDetail(record: Pick<AppDrawRow, 'candidateCount' | 'candidateSha256'>): string {
	const coupons = record.candidateCount === 1 ? '1 cupón' : `${record.candidateCount} cupones`;
	return `Entre ${coupons} sin premio. SHA-256 de la lista de cupones: ${record.candidateSha256}.`;
}

export async function appDrawRoutes(app: FastifyInstance) {
	const { deps } = app;
	const idParams = z.object({ id: z.uuid() });

	/** The vacant units and the candidates, computed on the spot and written nowhere. */
	app.get('/admin/campaigns/:id/app-draw/preview', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.operate');
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await campaignForAwards(tx, id);
			if (await storedAppDraw(tx, campaign)) throw new ApiError(409, 'app_draw_exists', appDrawMessages.app_draw_exists);
			const { vacant, candidates } = await appDrawContext(tx, campaign);
			const numbers = candidates.map((candidate) => candidate.entryNumber);
			return {
				campaign: campaignView(campaign),
				vacant: vacant.map(({ prizeId, prize, slot, alternatesCount }) => ({ prizeId, prizeTitle: prize, slot, alternatesCount })),
				candidates: candidates.map((candidate) => ({ entryNumber: padEntryNumber(candidate.entryNumber, campaign.entryDigits), maskedName: candidate.maskedName })),
				candidateCount: candidates.length,
				candidateSha256: sha256Hex(appDrawCandidateText(numbers, campaign.entryDigits))
			};
		});
	});

	/**
	 * Runs the draw once per campaign round: 201 with the result the first
	 * time, then 200 with the stored one, never drawing again.
	 */
	app.post('/admin/campaigns/:id/app-draw', async (request, reply) => {
		const admin = await requireAdmin(request, 'campaigns.operate');
		const { id } = parse(idParams, request.params);
		const { created, view } = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			// The row lock serializes concurrent runs; the unique round index backs it up.
			const campaign = await campaignForAwards(tx, id, true);
			const stored = await storedAppDraw(tx, campaign);
			if (stored) return { created: false, view: await drawView(tx, campaign, stored) };

			const { vacant, candidates } = await appDrawContext(tx, campaign);
			const numbers = candidates.map((candidate) => candidate.entryNumber);
			const picks = drawVacantSlots({
				slots: vacant.map(({ prizeId, slot, alternatesCount }) => ({ prizeId, slot, alternatesCount })),
				candidates: numbers,
				randomIndex: (size) => randomInt(size)
			});
			const now = deps.now();
			const [record] = await tx
				.insert(s.appDraws)
				.values({
					organizationId: admin.tenant.id,
					campaignId: campaign.id,
					round: campaign.currentRound,
					candidateSha256: sha256Hex(appDrawCandidateText(numbers, campaign.entryDigits)),
					candidateCount: numbers.length,
					candidates: numbers,
					picks,
					drawnAt: now,
					recordedBy: admin.identity.userId
				})
				.returning();
			// Through the award model, so decisions, delivery, the board and the public winners work as for any result.
			for (const { prizeId, slot } of vacant) {
				const seats = picks.filter((pick) => pick.prizeId === prizeId && pick.slot === slot).sort((a, b) => (a.role === b.role ? a.rank - b.rank : a.role === 'winner' ? -1 : 1));
				if (seats.length === 0) continue;
				await insertSlotAwards(tx, admin, campaign.id, prizeId, slot, campaign.currentRound, seats.map((pick) => ({ entryNumber: pick.entryNumber, notes: awardNote })), record!.id);
			}
			await tx.insert(s.drawEvents).values({
				organizationId: admin.tenant.id,
				campaignId: campaign.id,
				kind: 'app_draw',
				round: campaign.currentRound,
				title: campaign.currentRound > 1 ? `Sorteo en la app de los premios vacantes de la ronda ${campaign.currentRound}` : 'Sorteo en la app de los premios vacantes',
				detail: drawDetail(record!),
				occurredAt: now,
				recordedBy: admin.identity.userId
			});
			await audit(tx, {
				organizationId: admin.tenant.id,
				actorType: actorType(admin),
				actorId: admin.identity.userId,
				action: 'award.app_draw_recorded',
				targetType: 'campaign',
				targetId: campaign.id,
				metadata: { round: campaign.currentRound, candidateCount: record!.candidateCount, candidateSha256: record!.candidateSha256, picks }
			});
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', campaign.id);
			return { created: true, view: await drawView(tx, campaign, record!) };
		});
		return reply.code(created ? 201 : 200).send(view);
	});

	/** The stored result of the current round, for the presentation screen and its reloads. */
	app.get('/admin/campaigns/:id/app-draw', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.operate');
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await campaignForAwards(tx, id);
			const stored = await storedAppDraw(tx, campaign);
			if (!stored) throw new ApiError(404, 'app_draw_missing', appDrawMessages.app_draw_missing);
			return drawView(tx, campaign, stored);
		});
	});
}

/** Every in-app draw of a campaign, oldest round first (for the public transparency page). */
export async function campaignAppDraws(tx: Tx, campaignId: string) {
	return tx.select().from(s.appDraws).where(eq(s.appDraws.campaignId, campaignId)).orderBy(asc(s.appDraws.round));
}
