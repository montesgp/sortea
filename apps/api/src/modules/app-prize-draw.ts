import { and, asc, count, eq, inArray, max, publishOpsEvent, schema as s, type Tx } from '@sortea/db';
import { appDrawCandidateText, drandRoundTime, commitDrandRound, drandRoundUrl, padEntryNumber, quicknet, slotState } from '@sortea/domain';
import { drawFromBeacon, sha256Hex } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context';
import { actorType, requireAdminAny, type AdminContext } from '../lib/admin-context';
import { audit } from '../lib/audit';
import type { Beacon } from '../lib/drand';
import { ApiError, notFound, parse } from '../lib/errors';
import {
	appDrawCandidateCount,
	appDrawCandidates,
	appPrizePendingMessage,
	appPrizeUnits,
	campaignForAwards,
	insertSlotAwards,
	maskedHolders,
	notAwarding,
	pendingPrizeDraw,
	prizeOrder,
	roundManifest,
	slotVoids
} from './awards';

/**
 * `app` prizes drawn whole in the application (ADR 0026; odd/tasks/draw-room.md
 * T8, S6-S8, L7). One click on "Sortear" is one tirada: it gives a winner to
 * every pending unit of the prize, among the eligible coupons that hold no
 * award, with no Quiniela.
 *
 * 1. Commit, in one transaction under the campaign row lock: the units, the
 *    candidates and their SHA-256, and the first drand quicknet round published
 *    after now. Nobody knows that round's randomness yet.
 * 2. Outside any transaction, wait for the round and read it from the relays
 *    (verified by the beacon client), a bounded number of times.
 * 3. Reveal, in a second transaction under the lock: the round's signature and
 *    randomness, the picks of `drawFromBeacon`, and one winner award per unit.
 *
 * When the round cannot be read in time the tirada stays committed (202) and a
 * later click resumes it with the same round, never another one. While it is
 * pending nothing else awards a coupon in the campaign, so the reveal can always
 * award what the committed list gives. Holders appear only as masked names.
 */

type Campaign = typeof s.campaigns.$inferSelect;
type CommitRow = typeof s.appPrizeDraws.$inferSelect;
type RevealRow = typeof s.appPrizeDrawReveals.$inferSelect;

/** Operators and the draw host (`draws.run`, draw-room T4) run every route of the in-app draw. */
const drawRoles = ['campaigns.operate', 'draws.run'] as const;

/** Wait after the round's publication before the first read, then reads and pauses: about 15 seconds at most. */
const publicationMarginMs = 300;
const readAttempts = 4;
const retryPauseMs = 1_000;
const readBudgetMs = 15_000;

export const appPrizeDrawMessages = {
	not_app_prize: 'Este premio no se sortea en la aplicación: se carga a mano o sale de la Quiniela',
	no_pending_units: 'Todas las unidades de este premio ya tienen ganador: no hay nada para sortear',
	no_candidates: 'No quedan cupones sin premio para sortear este premio',
	manifest_required: 'Falta el manifiesto publicado',
	nothing_left: 'No quedan premios para sortear en la aplicación'
} as const;

function campaignView(campaign: Campaign) {
	return { id: campaign.id, title: campaign.title, round: campaign.currentRound, entryDigits: campaign.entryDigits, timezone: campaign.timezone, awardOrder: campaign.awardOrder };
}

/** The drand round's address on the first configured relay, for anyone to read it. */
function roundUrl(deps: AppDeps, round: number) {
	return drandRoundUrl(deps.drand.relays[0] ?? 'https://api.drand.sh', round);
}

/** One tirada as the draw room shows it; `withCandidates` adds every candidate for the reel. */
async function tiradaViews(tx: Tx, deps: AppDeps, campaign: Campaign, rows: readonly CommitRow[], withCandidates: boolean) {
	if (rows.length === 0) return [];
	const [prizes, reveals, holders] = await Promise.all([
		tx.select({ id: s.prizes.id, title: s.prizes.title }).from(s.prizes).where(eq(s.prizes.campaignId, campaign.id)),
		tx.select().from(s.appPrizeDrawReveals).where(inArray(s.appPrizeDrawReveals.drawId, rows.map((row) => row.id))),
		maskedHolders(tx, campaign.id)
	]);
	const coupon = (entryNumber: number) => ({ entryNumber: padEntryNumber(entryNumber, campaign.entryDigits), maskedName: holders.get(entryNumber)?.maskedName ?? '***' });
	return rows.map((row) => {
		const reveal = reveals.find((candidate) => candidate.drawId === row.id) ?? null;
		return {
			prizeId: row.prizeId,
			prizeTitle: prizes.find((prize) => prize.id === row.prizeId)?.title ?? '',
			round: row.round,
			sequence: row.sequence,
			attempt: row.attempt,
			state: reveal ? ('drawn' as const) : ('committed' as const),
			units: row.slots,
			drandRound: row.drandRound,
			drandRoundAt: drandRoundTime(row.drandRound),
			committedAt: row.committedAt,
			candidateCount: row.candidateCount,
			candidateSha256: row.candidateSha256,
			beacon: reveal ? { signature: reveal.signature, randomness: reveal.randomness, url: roundUrl(deps, row.drandRound) } : null,
			picks: reveal ? reveal.picks.map((pick) => ({ slot: pick.slot, ...coupon(pick.entryNumber) })) : null,
			revealedAt: reveal?.revealedAt ?? null,
			...(withCandidates ? { candidates: row.candidates.map(coupon) } : {})
		};
	});
}

async function tiradaResult(tx: Tx, deps: AppDeps, campaign: Campaign, row: CommitRow) {
	const [view] = await tiradaViews(tx, deps, campaign, [row], true);
	return { campaign: campaignView(campaign), ...view! };
}

/** "el premio tiene ganador", "ganador para la unidad 3", "ganadores para las unidades 1, 2, 3, 4 y 5". */
function filledText(slots: readonly number[], quantity: number): string {
	if (quantity === 1) return 'el premio tiene ganador';
	if (slots.length === 1) return `ganador para la unidad ${slots[0]}`;
	return `ganadores para las unidades ${slots.slice(0, -1).join(', ')} y ${slots.at(-1)}`;
}

/**
 * Why `prize` cannot be drawn now, else null: the campaign is not awarding, has
 * no published manifest for its round, another prize's tirada is pending, the
 * prize has no pending unit, or no coupon is left.
 */
function refusal(input: {
	campaign: Campaign;
	manifest: boolean;
	pending: CommitRow | null;
	pendingTitle: string;
	prizeId: string;
	units: number;
	candidateCount: number;
}): ApiError | null {
	if (input.campaign.status !== 'awarding') return notAwarding();
	if (!input.manifest) return new ApiError(409, 'manifest_required', appPrizeDrawMessages.manifest_required);
	if (input.pending && input.pending.prizeId !== input.prizeId) return new ApiError(409, 'app_draw_pending', appPrizePendingMessage(input.pendingTitle));
	if (input.pending) return null;
	if (input.units === 0) return new ApiError(409, 'no_pending_units', appPrizeDrawMessages.no_pending_units);
	if (input.candidateCount === 0) return new ApiError(409, 'no_candidates', appPrizeDrawMessages.no_candidates);
	return null;
}

/**
 * The `app` prizes in the campaign's award order (draw-room T2), each with its
 * units, its state (`pending` units to draw, `committed` while its tirada waits
 * for the round, `drawn` when nothing is left), its tiradas and why it cannot
 * be drawn now. The coupons in play are counted, never listed.
 */
export async function appPrizesView(tx: Tx, deps: AppDeps, campaign: Campaign) {
	const [prizes, rows, voids, commits, manifest, pending] = await Promise.all([
		tx.select().from(s.prizes).where(and(eq(s.prizes.campaignId, campaign.id), eq(s.prizes.mechanism, 'app'))).orderBy(...prizeOrder),
		tx
			.select({ award: s.prizeAwards, fulfillment: s.prizeFulfillments.status })
			.from(s.prizeAwards)
			.leftJoin(s.prizeFulfillments, eq(s.prizeFulfillments.awardId, s.prizeAwards.id))
			.where(eq(s.prizeAwards.campaignId, campaign.id)),
		slotVoids(tx, campaign.id),
		tx.select().from(s.appPrizeDraws).where(eq(s.appPrizeDraws.campaignId, campaign.id)).orderBy(asc(s.appPrizeDraws.round), asc(s.appPrizeDraws.sequence)),
		roundManifest(tx, campaign),
		pendingPrizeDraw(tx, campaign.id)
	]);
	if (campaign.awardOrder === 'last_to_first') prizes.reverse();
	const ready = campaign.status === 'awarding' && Boolean(manifest);
	const candidateCount = ready ? await appDrawCandidateCount(tx, campaign.id) : null;
	const views = await tiradaViews(tx, deps, campaign, commits, false);
	const pendingTitle = prizes.find((prize) => prize.id === pending?.prizeId)?.title ?? '';
	const listed = prizes.map((prize) => {
		const units = Array.from({ length: prize.quantity }, (_, index) => index + 1).map((slot) => {
			if (voids.some((row) => row.prizeId === prize.id && row.slot === slot)) return { slot, state: 'void' as const };
			const awards = rows
				.filter(({ award }) => award.prizeId === prize.id && award.slot === slot)
				.map(({ award, fulfillment }) => ({ id: award.id, role: award.role, rank: award.rank, status: award.status, fulfillmentStatus: fulfillment }));
			const state = slotState(awards).state;
			return { slot, state: state === 'empty' ? ('pending' as const) : state === 'exhausted' ? ('exhausted' as const) : ('held' as const) };
		});
		const pendingUnits = units.filter((unit) => unit.state === 'pending' || unit.state === 'exhausted').map((unit) => unit.slot);
		const error = refusal({ campaign, manifest: Boolean(manifest), pending, pendingTitle, prizeId: prize.id, units: pendingUnits.length, candidateCount: candidateCount ?? 0 });
		return {
			prizeId: prize.id,
			prizeTitle: prize.title,
			position: prize.position,
			quantity: prize.quantity,
			state: pending?.prizeId === prize.id ? ('committed' as const) : pendingUnits.length > 0 ? ('pending' as const) : ('drawn' as const),
			units,
			pendingUnits,
			tiradas: views.filter((view) => view.prizeId === prize.id),
			reason: error?.message ?? null
		};
	});
	// Why nothing at all can be drawn now, when no prize can.
	const general = !ready
		? (refusal({ campaign, manifest: Boolean(manifest), pending: null, pendingTitle: '', prizeId: '', units: 1, candidateCount: 1 })?.message ?? null)
		: listed.some((prize) => prize.reason === null)
			? null
			: listed.every((prize) => prize.state === 'drawn')
				? appPrizeDrawMessages.nothing_left
				: (listed.find((prize) => prize.state !== 'drawn')?.reason ?? null);
	return { campaign: campaignView(campaign), prizes: listed, candidateCount, reason: general };
}

/**
 * Waits for the committed round and reads it: first at its publication time,
 * then again after a pause, `readAttempts` times within `readBudgetMs`. Null
 * when it is still not available, so the tirada stays pending.
 */
async function awaitBeacon(deps: AppDeps, drandRound: number): Promise<Beacon | null> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
	const deadline = Date.now() + readBudgetMs;
	const ahead = drandRoundTime(drandRound).getTime() - deps.now().getTime();
	if (ahead > -publicationMarginMs) await sleep(Math.min(ahead, quicknet.period * 1000) + publicationMarginMs);
	for (let attempt = 1; attempt <= readAttempts; attempt++) {
		const beacon = await deps.drand.fetchRound(drandRound, deadline);
		if (beacon) return beacon;
		if (attempt < readAttempts && Date.now() < deadline) await sleep(retryPauseMs);
	}
	return null;
}

/** Stores the reveal and the awards once the round is read; null when another request revealed it first. */
async function reveal(tx: Tx, deps: AppDeps, admin: AdminContext, campaign: Campaign, commit: CommitRow, beacon: Beacon): Promise<RevealRow | null> {
	const [existing] = await tx.select({ id: s.appPrizeDrawReveals.id }).from(s.appPrizeDrawReveals).where(eq(s.appPrizeDrawReveals.drawId, commit.id));
	if (existing) return null;
	const picks = drawFromBeacon({ randomness: beacon.randomness, candidateSha256: commit.candidateSha256, candidates: commit.candidates, count: commit.slots.length }).map((entryNumber, index) => ({
		slot: commit.slots[index]!,
		entryNumber
	}));
	const now = deps.now();
	const [row] = await tx
		.insert(s.appPrizeDrawReveals)
		.values({
			organizationId: admin.tenant.id,
			campaignId: campaign.id,
			drawId: commit.id,
			drandRound: commit.drandRound,
			signature: beacon.signature,
			randomness: beacon.randomness,
			picks,
			revealedAt: now
		})
		.returning();
	const [prize] = await tx.select().from(s.prizes).where(eq(s.prizes.id, commit.prizeId));
	for (const pick of picks) {
		// A unit drawn again keeps the winners passed over before it, ranked first.
		const [winners] = await tx
			.select({ rank: max(s.prizeAwards.rank) })
			.from(s.prizeAwards)
			.where(and(eq(s.prizeAwards.prizeId, commit.prizeId), eq(s.prizeAwards.slot, pick.slot), eq(s.prizeAwards.role, 'winner')));
		await insertSlotAwards(tx, admin, campaign.id, commit.prizeId, pick.slot, commit.round, [{ entryNumber: pick.entryNumber, notes: `Sorteo en la app (drand ${commit.drandRound})` }], {
			appPrizeDrawId: commit.id,
			winnerRank: (winners?.rank ?? 0) + 1
		});
	}
	await tx.insert(s.drawEvents).values({
		organizationId: admin.tenant.id,
		campaignId: campaign.id,
		kind: 'app_draw',
		round: commit.round,
		title: `Sorteo en la app: ${prize!.title}${commit.round > 1 ? ` (ronda ${commit.round})` : ''}`,
		// The units filled; the coupons go public with the round's results.
		detail: `Ronda ${commit.drandRound} de drand: ${filledText(picks.map((pick) => pick.slot), prize!.quantity)}.`,
		occurredAt: now,
		recordedBy: admin.identity.userId
	});
	await audit(tx, {
		organizationId: admin.tenant.id,
		actorType: actorType(admin),
		actorId: admin.identity.userId,
		action: 'award.app_draw_revealed',
		targetType: 'prize',
		targetId: commit.prizeId,
		metadata: { round: commit.round, sequence: commit.sequence, attempt: commit.attempt, drandRound: commit.drandRound, randomness: beacon.randomness, picks }
	});
	await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', campaign.id);
	return row!;
}

export async function appPrizeDrawRoutes(app: FastifyInstance) {
	const { deps } = app;
	const idParams = z.object({ id: z.uuid() });
	const prizeParams = idParams.extend({ prizeId: z.uuid() });

	app.get('/admin/campaigns/:id/app-draw/prizes', async (request) => {
		const admin = await requireAdminAny(request, drawRoles);
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => appPrizesView(tx, deps, await campaignForAwards(tx, id)));
	});

	/**
	 * One tirada of an `app` prize: 201 with the picks once its round is read
	 * and revealed, 202 with the committed tirada while the round is not
	 * available, 200 when another request revealed it meanwhile. A click while
	 * the prize's tirada is pending resumes it with the same round.
	 */
	app.post('/admin/campaigns/:id/app-draw/prizes/:prizeId', async (request, reply) => {
		const admin = await requireAdminAny(request, drawRoles);
		const params = parse(prizeParams, request.params);
		const commit = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await campaignForAwards(tx, params.id, true);
			if (campaign.status !== 'awarding') throw notAwarding();
			const [prize] = await tx.select().from(s.prizes).where(and(eq(s.prizes.id, params.prizeId), eq(s.prizes.campaignId, campaign.id)));
			if (!prize) throw notFound('Premio');
			if (prize.mechanism !== 'app') throw new ApiError(409, 'not_app_prize', appPrizeDrawMessages.not_app_prize);
			const [manifest, pending] = await Promise.all([roundManifest(tx, campaign), pendingPrizeDraw(tx, campaign.id)]);
			// The pending tirada of this prize resumes with its round; another prize's waits for it.
			const [pendingPrize] = pending && pending.prizeId !== prize.id ? await tx.select({ title: s.prizes.title }).from(s.prizes).where(eq(s.prizes.id, pending.prizeId)) : [];
			const early = refusal({ campaign, manifest: Boolean(manifest), pending, pendingTitle: pendingPrize?.title ?? '', prizeId: prize.id, units: 1, candidateCount: 1 });
			if (early) throw early;
			if (pending) return pending;

			const slots = (await appPrizeUnits(tx, campaign.id)).filter((unit) => unit.prizeId === prize.id).map((unit) => unit.slot);
			const candidates = (await appDrawCandidates(tx, campaign.id)).map((candidate) => candidate.entryNumber);
			const refused = refusal({ campaign, manifest: true, pending: null, pendingTitle: '', prizeId: prize.id, units: slots.length, candidateCount: candidates.length });
			if (refused) throw refused;

			const [[inRound], [ofPrize]] = await Promise.all([
				tx.select({ value: count() }).from(s.appPrizeDraws).where(and(eq(s.appPrizeDraws.campaignId, campaign.id), eq(s.appPrizeDraws.round, campaign.currentRound))),
				tx.select({ value: count() }).from(s.appPrizeDraws).where(eq(s.appPrizeDraws.prizeId, prize.id))
			]);
			const now = deps.now();
			// The first round published after the commitment: its randomness does not exist yet.
			const drandRound = commitDrandRound(now);
			const [row] = await tx
				.insert(s.appPrizeDraws)
				.values({
					organizationId: admin.tenant.id,
					campaignId: campaign.id,
					round: campaign.currentRound,
					sequence: (inRound?.value ?? 0) + 1,
					prizeId: prize.id,
					attempt: (ofPrize?.value ?? 0) + 1,
					slots,
					drandChain: quicknet.chainHash,
					drandRound,
					candidateSha256: sha256Hex(appDrawCandidateText(candidates, campaign.entryDigits)),
					candidateCount: candidates.length,
					candidates,
					committedAt: now,
					committedBy: admin.identity.userId
				})
				.returning();
			const coupons = candidates.length === 1 ? '1 cupón' : `${candidates.length} cupones`;
			await tx.insert(s.drawEvents).values({
				organizationId: admin.tenant.id,
				campaignId: campaign.id,
				kind: 'app_draw',
				round: campaign.currentRound,
				title: `Sorteo en la app comprometido: ${prize.title}${campaign.currentRound > 1 ? ` (ronda ${campaign.currentRound})` : ''}`,
				// No hash and no list: they go public with the round's results (R1-tirada-pick-leak).
				detail: `Ronda ${drandRound} de drand, entre ${coupons} sin premio.`,
				occurredAt: now,
				recordedBy: admin.identity.userId
			});
			await audit(tx, {
				organizationId: admin.tenant.id,
				actorType: actorType(admin),
				actorId: admin.identity.userId,
				action: 'award.app_draw_committed',
				targetType: 'prize',
				targetId: prize.id,
				metadata: { round: row!.round, sequence: row!.sequence, attempt: row!.attempt, slots, drandRound, candidateCount: row!.candidateCount, candidateSha256: row!.candidateSha256 }
			});
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', campaign.id);
			return row!;
		});

		const beacon = await awaitBeacon(deps, commit.drandRound);
		const { status, body } = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await campaignForAwards(tx, params.id, true);
			if (!beacon) return { status: 202, body: await tiradaResult(tx, deps, campaign, commit) };
			const revealed = await reveal(tx, deps, admin, campaign, commit, beacon);
			return { status: revealed ? 201 : 200, body: await tiradaResult(tx, deps, campaign, commit) };
		});
		return reply.code(status).send(body);
	});
}

/** Every tirada of a campaign's `app` prizes with its reveal, by round then sequence (for the public transparency page). */
export async function campaignPrizeDraws(tx: Tx, campaignId: string) {
	const [commits, reveals] = await Promise.all([
		tx.select().from(s.appPrizeDraws).where(eq(s.appPrizeDraws.campaignId, campaignId)).orderBy(asc(s.appPrizeDraws.round), asc(s.appPrizeDraws.sequence)),
		tx.select().from(s.appPrizeDrawReveals).where(eq(s.appPrizeDrawReveals.campaignId, campaignId))
	]);
	return commits.map((commit) => ({ commit, reveal: reveals.find((row) => row.drawId === commit.id) ?? null }));
}
