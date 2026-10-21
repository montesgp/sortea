import { and, asc, desc, eq, inArray, publishOpsEvent, schema as s, type BuyerSnapshot, type Tx } from '@sortea/db';
import {
	canDecide,
	canMoveFulfillment,
	canRecordSlot,
	checkSlotResult,
	couponPoolSize,
	formatEntryNumber,
	inCouponPool,
	maskEmail,
	matchQuinielaDraw,
	padEntryNumber,
	parseManifest,
	quinielaConfirmInputSchema,
	quinielaDigestPayload,
	quinielaDrawInputSchema,
	quinielaEntryDigits,
	slotResolved,
	slotState,
	type QuinielaDrawInput,
	type SlotAward
} from '@sortea/domain';
import { sha256Hex } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorType, requireAdmin, type AdminContext } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { ApiError, notFound, parse } from '../lib/errors';

/**
 * Award operations (FR-CAMP-03/04, FR-OPS-04, AC-06). People record the
 * result of the authorized mechanism; the platform checks it against the
 * published manifest and keeps every later decision on record.
 */

/** Coupons start at 0000; the campaign's pool bounds them (ADR 0014 §1). */
const entryNumber = z.coerce.number().int().min(0).max(999_999);
const slotBody = z.object({
	winner: entryNumber,
	alternates: z.array(entryNumber).max(20).default([]),
	notes: z.string().trim().max(1000).optional()
});
const decisionBody = z
	.object({ decision: z.enum(['accepted', 'declined', 'void']), notes: z.string().trim().max(1000).optional() })
	.refine((value) => value.decision === 'accepted' || (value.notes?.length ?? 0) >= 5, {
		message: 'Explicá el motivo del rechazo o la anulación',
		path: ['notes']
	});
const fulfillmentBody = z.object({
	status: z.enum(['pending', 'scheduled', 'delivered', 'failed']),
	scheduledFor: z.coerce.date().nullable().optional(),
	deliveredAt: z.coerce.date().optional(),
	evidenceUrl: z.url({ protocol: /^https$/ }).nullable().optional(),
	notes: z.string().trim().max(1000).nullable().optional()
});

type AwardRow = typeof s.prizeAwards.$inferSelect;

/** Prize order everywhere awards are listed or drawn: position, then creation, then id (ADR 0014 §4). */
export const prizeOrder = [asc(s.prizes.position), asc(s.prizes.createdAt), asc(s.prizes.id)] as const;
type FulfillmentRow = typeof s.prizeFulfillments.$inferSelect;

async function campaignForAwards(tx: Tx, campaignId: string, lock = false) {
	const query = tx.select().from(s.campaigns).where(eq(s.campaigns.id, campaignId));
	const [campaign] = lock ? await query.for('update') : await query;
	if (!campaign) throw notFound('Campaña');
	return campaign;
}

function requireAwarding(campaign: { status: string }) {
	if (campaign.status !== 'awarding') {
		throw new ApiError(409, 'not_awarding', 'Las adjudicaciones se registran con la campaña en adjudicación, después de publicar el manifiesto');
	}
}

async function drawFlags(tx: Tx, campaignId: string) {
	const events = await tx.select({ kind: s.drawEvents.kind }).from(s.drawEvents).where(eq(s.drawEvents.campaignId, campaignId));
	return {
		mechanismRecorded: events.some((event) => event.kind === 'mechanism_recorded'),
		resultsPublished: events.some((event) => event.kind === 'result_published')
	};
}

function toSlotAward(award: AwardRow, fulfillment: FulfillmentRow | null | undefined): SlotAward {
	return { id: award.id, role: award.role, rank: award.rank, status: award.status, fulfillmentStatus: fulfillment?.status ?? null };
}

async function campaignAwards(tx: Tx, campaignId: string) {
	return tx
		.select({ award: s.prizeAwards, fulfillment: s.prizeFulfillments })
		.from(s.prizeAwards)
		.leftJoin(s.prizeFulfillments, eq(s.prizeFulfillments.awardId, s.prizeAwards.id))
		.where(eq(s.prizeAwards.campaignId, campaignId));
}

/** Prize units that are neither delivered nor out of alternates. Empty slots count as unresolved. */
export async function unresolvedAwardSlots(tx: Tx, campaignId: string): Promise<number> {
	const [prizes, rows] = await Promise.all([
		tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaignId)),
		campaignAwards(tx, campaignId)
	]);
	let unresolved = 0;
	for (const prize of prizes) {
		for (let slot = 1; slot <= prize.quantity; slot++) {
			const awards = rows.filter((row) => row.award.prizeId === prize.id && row.award.slot === slot).map((row) => toSlotAward(row.award, row.fulfillment));
			if (!slotResolved(awards)) unresolved++;
		}
	}
	return unresolved;
}

async function awardBoard(tx: Tx, admin: AdminContext, campaignId: string) {
	const campaign = await campaignForAwards(tx, campaignId);
	const showPii = admin.permissions.includes('orders.pii');
	const [prizes, rows, flags] = await Promise.all([
		tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaignId)).orderBy(...prizeOrder),
		tx
			.select({
				award: s.prizeAwards,
				fulfillment: s.prizeFulfillments,
				entryNumber: s.participationEntries.entryNumber,
				entryStatus: s.participationEntries.status,
				contact: s.contacts,
				buyer: s.orders.buyer
			})
			.from(s.prizeAwards)
			.leftJoin(s.prizeFulfillments, eq(s.prizeFulfillments.awardId, s.prizeAwards.id))
			.leftJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
			.leftJoin(s.contacts, eq(s.contacts.id, s.participationEntries.contactId))
			.leftJoin(s.orders, eq(s.orders.id, s.participationEntries.orderId))
			.where(eq(s.prizeAwards.campaignId, campaignId)),
		drawFlags(tx, campaignId)
	]);
	if (showPii && rows.length > 0) {
		await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action: 'awards.pii_viewed', targetType: 'campaign', targetId: campaignId });
	}

	const [draw] = await tx.select().from(s.quinielaDraws).where(eq(s.quinielaDraws.campaignId, campaignId)).orderBy(desc(s.quinielaDraws.round)).limit(1);
	const canOperate = admin.permissions.includes('campaigns.operate') && campaign.status === 'awarding';
	return {
		campaign: { id: campaign.id, title: campaign.title, status: campaign.status, timezone: campaign.timezone, entryDigits: campaign.entryDigits },
		...flags,
		canOperate,
		piiVisible: showPii,
		quinielaDraw: draw
			? { round: draw.round, source: draw.source, drawnAt: draw.drawnAt, extracts: draw.extracts, evidenceUrl: draw.evidenceUrl, recordedAt: draw.createdAt }
			: null,
		prizes: prizes.map((prize) => ({
			id: prize.id,
			position: prize.position,
			kind: prize.kind,
			title: prize.title,
			quantity: prize.quantity,
			alternatesCount: prize.alternatesCount,
			mechanism: prize.mechanism,
			slots: Array.from({ length: prize.quantity }, (_, index) => {
				const slot = index + 1;
				const slotRows = rows.filter((row) => row.award.prizeId === prize.id && row.award.slot === slot);
				const awards = slotRows.map((row) => toSlotAward(row.award, row.fulfillment));
				const state = slotState(awards);
				const activeId = 'award' in state ? state.award.id : null;
				return {
					slot,
					// A quiniela slot that the recorded draw left without a match is vacant (ADR 0014 §5).
					state: prize.mechanism === 'quiniela' && draw && state.state === 'empty' ? 'vacant' : state.state,
					// Quiniela prizes come only from the recorded draw, never typed in.
					canRecord: canOperate && prize.mechanism === 'manual' && flags.mechanismRecorded && canRecordSlot(awards, flags.resultsPublished),
					awards: slotRows
						.sort((a, b) => (a.award.role === b.award.role ? a.award.rank - b.award.rank : a.award.role === 'winner' ? -1 : 1))
						.map(({ award, fulfillment, entryNumber, entryStatus, contact, buyer }) => ({
							id: award.id,
							role: award.role,
							rank: award.rank,
							status: award.status,
							entryNumber,
							// A refund after the close voids the entry but not the frozen manifest; people decide.
							entryVoidedAfterClose: entryStatus === 'void',
							active: award.id === activeId,
							notes: award.notes,
							decidedAt: award.decidedAt,
							holder: contact
								? showPii
									? { name: `${contact.firstName} ${contact.lastName}`, email: contact.email, phone: contact.phone, location: holderLocation(buyer, true) }
									: { name: `${contact.firstName} ${contact.lastName.slice(0, 1)}.`, email: maskEmail(contact.email), phone: null, location: holderLocation(buyer, false) }
								: null,
							fulfillment: fulfillment
								? {
										status: fulfillment.status,
										scheduledFor: fulfillment.scheduledFor,
										deliveredAt: fulfillment.deliveredAt,
										evidenceUrl: fulfillment.evidenceUrl,
										notes: fulfillment.notes
									}
								: null
						}))
				};
			})
		}))
	};
}

/** Where the winning order's buyer lives (S7); without PII permission only the province. */
function holderLocation(buyer: BuyerSnapshot | null, showPii: boolean): string | null {
	if (!buyer) return null;
	if (!showPii) return buyer.province ?? null;
	return [buyer.city, buyer.province].filter(Boolean).join(', ') || null;
}

function slotMessage(reason: string, entryDigits: number, entry?: number): string {
	const coupon = entry === undefined ? '' : formatEntryNumber(entry, entryDigits);
	const messages: Record<string, string> = {
		too_many_alternates: 'Hay más suplentes que los que prevén las bases para este premio',
		duplicate_entry: `La participación ${coupon} está repetida en este premio`,
		not_in_manifest: `La participación ${coupon} no está en el manifiesto publicado`,
		not_eligible: `La participación ${coupon} figura anulada en el manifiesto publicado`,
		already_awarded: `La participación ${coupon} ya tiene otro premio en esta campaña`
	};
	return messages[reason] ?? 'Revisá los números de participación';
}

/**
 * Writes one slot's awards, winner first then alternates by rank. The manual
 * entry and the Quiniela draw both go through here, after `checkSlotResult`.
 */
async function insertSlotAwards(
	tx: Tx,
	admin: AdminContext,
	campaignId: string,
	prizeId: string,
	slot: number,
	awards: readonly { entryNumber: number; notes: string | null }[]
) {
	const numbers = awards.map((award) => award.entryNumber);
	const entries = await tx
		.select({ id: s.participationEntries.id, number: s.participationEntries.entryNumber })
		.from(s.participationEntries)
		.where(and(eq(s.participationEntries.campaignId, campaignId), inArray(s.participationEntries.entryNumber, numbers)));
	const entryId = new Map(entries.map((entry) => [entry.number, entry.id]));
	await tx.insert(s.prizeAwards).values(
		awards.map((award, index) => ({
			organizationId: admin.tenant.id,
			campaignId,
			prizeId,
			slot,
			role: index === 0 ? ('winner' as const) : ('alternate' as const),
			rank: index === 0 ? 1 : index,
			entryId: entryId.get(award.entryNumber) ?? null,
			recordedBy: admin.identity.userId,
			notes: award.notes
		}))
	);
}

/** "28/11/2026 22:00": an instant in the campaign's time zone. */
function campaignDateTime(date: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
	const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? '';
	return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
}

/**
 * Everything a Quiniela draw is matched against (ADR 0014 §3-§4): an awarding
 * campaign with a published manifest, a 0000–9999 pool, at least one quiniela
 * prize, results not published yet, no draw recorded yet for the round, and a
 * draw held after the manifest was published.
 */
async function quinielaContext(tx: Tx, campaignId: string, body: QuinielaDrawInput, now: Date, lock: boolean) {
	const campaign = await campaignForAwards(tx, campaignId, lock);
	requireAwarding(campaign);
	const [manifestRow] = await tx.select().from(s.drawManifests).where(eq(s.drawManifests.campaignId, campaign.id));
	if (!manifestRow?.publishedAt) throw new ApiError(409, 'manifest_required', 'Falta el manifiesto publicado');
	if (campaign.entryDigits !== quinielaEntryDigits) {
		throw new ApiError(409, 'pool_not_quiniela', `La Quiniela sortea números de ${quinielaEntryDigits} cifras y los cupones de esta campaña tienen ${campaign.entryDigits}`);
	}
	const prizes = await tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaign.id)).orderBy(...prizeOrder);
	if (!prizes.some((prize) => prize.mechanism === 'quiniela')) {
		throw new ApiError(409, 'no_quiniela_prizes', 'Ningún premio de esta campaña se define con el sorteo de la Quiniela');
	}
	const rows = await campaignAwards(tx, campaign.id);
	const quinielaAwards = rows.filter((row) => prizes.some((prize) => prize.id === row.award.prizeId && prize.mechanism === 'quiniela'));
	// Published results are frozen, as for a result typed in by hand.
	if (!canRecordSlot(quinielaAwards.map((row) => toSlotAward(row.award, row.fulfillment)), (await drawFlags(tx, campaign.id)).resultsPublished)) {
		throw new ApiError(409, 'results_published', 'Los resultados ya se publicaron: el sorteo de la Quiniela ya no se puede registrar');
	}
	// One draw per round; the rounds that follow a vacancy come with ADR 0014 §5.
	const [existing] = await tx
		.select({ id: s.quinielaDraws.id })
		.from(s.quinielaDraws)
		.where(and(eq(s.quinielaDraws.campaignId, campaign.id), eq(s.quinielaDraws.round, 1)));
	if (existing) throw new ApiError(409, 'draw_exists', 'El sorteo de la Quiniela de esta ronda ya está registrado');
	// The manifest is published before any selection (ADR 0003): the draw has to come strictly after it, and to have happened.
	if (body.drawnAt.getTime() <= manifestRow.publishedAt.getTime()) {
		throw new ApiError(
			409,
			'draw_before_manifest',
			`El sorteo de la Quiniela tiene que ser posterior a la publicación del manifiesto (${campaignDateTime(manifestRow.publishedAt, campaign.timezone)})`
		);
	}
	if (body.drawnAt > now) throw new ApiError(400, 'draw_in_future', 'La fecha del sorteo no puede ser futura');

	const manifest = new Map(parseManifest(manifestRow.content).entries.map((entry) => [entry.entryNumber, entry.status]));
	const manifestStatus = (entryNumber: number) => manifest.get(entryNumber) ?? null;
	const awarded = await tx
		.select({ prizeId: s.prizeAwards.prizeId, slot: s.prizeAwards.slot, role: s.prizeAwards.role, entryNumber: s.participationEntries.entryNumber })
		.from(s.prizeAwards)
		.leftJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
		.where(eq(s.prizeAwards.campaignId, campaign.id));
	const awardedNumbers = new Set(awarded.map((row) => row.entryNumber).filter((number): number is number => number !== null));
	const match = matchQuinielaDraw({
		extracts: body.extracts,
		prizes: prizes.map((prize) => ({
			id: prize.id,
			mechanism: prize.mechanism,
			position: prize.position,
			quantity: prize.quantity,
			alternatesCount: prize.alternatesCount,
			createdAt: prize.createdAt,
			filledSlots: awarded.filter((row) => row.prizeId === prize.id && row.role === 'winner').map((row) => row.slot)
		})),
		manifestStatus,
		awarded: awardedNumbers
	});
	// What the admin saw in the preview; confirming must recompute the same (ADR 0014 §4).
	const digest = sha256Hex(quinielaDigestPayload(body, match));
	return { campaign, manifestRow, manifestStatus, awardedNumbers, prizes, match, digest };
}

/** "Sorteo del 29/11/2026 a las 21:00. Extractos: 1.º 0042, 2.º 1234, …" for the public log. */
function drawDetail(body: QuinielaDrawInput, timezone: string): string {
	const [day, time] = campaignDateTime(body.drawnAt, timezone).split(' ');
	const extracts = body.extracts.map((number, index) => `${index + 1}.º ${padEntryNumber(number, quinielaEntryDigits)}`).join(', ');
	return `Sorteo del ${day} a las ${time}. Extractos: ${extracts}`;
}

export async function awardRoutes(app: FastifyInstance) {
	const { deps } = app;
	const idParams = z.object({ id: z.uuid() });

	app.get('/admin/campaigns/:id/awards', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.view');
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, (tx) => awardBoard(tx, admin, id));
	});

	/** Records (or, before any decision and before results are public, re-records) one prize unit. */
	app.put('/admin/campaigns/:id/awards/:prizeId/slots/:slot', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.operate');
		const params = parse(z.object({ id: z.uuid(), prizeId: z.uuid(), slot: z.coerce.number().int().min(1).max(10_000) }), request.params);
		const body = parse(slotBody, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await campaignForAwards(tx, params.id, true);
			requireAwarding(campaign);
			const flags = await drawFlags(tx, campaign.id);
			if (!flags.mechanismRecorded) {
				throw new ApiError(409, 'mechanism_required', 'Registrá primero en el log público el mecanismo de selección autorizado');
			}
			const [prize] = await tx.select().from(s.prizes).where(and(eq(s.prizes.id, params.prizeId), eq(s.prizes.campaignId, campaign.id)));
			if (!prize) throw notFound('Premio');
			if (prize.mechanism === 'quiniela') {
				throw new ApiError(409, 'quiniela_prize', 'Este premio se define con el sorteo de la Quiniela, no se carga a mano');
			}
			if (params.slot > prize.quantity) throw new ApiError(400, 'invalid_slot', 'Ese premio no tiene tantas unidades');
			if (![body.winner, ...body.alternates].every((number) => inCouponPool(number, campaign.entryDigits))) {
				const last = couponPoolSize(campaign.entryDigits) - 1;
				throw new ApiError(400, 'entry_out_of_pool', `Los cupones de esta campaña van del ${formatEntryNumber(0, campaign.entryDigits)} al ${formatEntryNumber(last, campaign.entryDigits)}`);
			}

			const rows = await campaignAwards(tx, campaign.id);
			const inSlot = rows.filter((row) => row.award.prizeId === prize.id && row.award.slot === params.slot);
			if (!canRecordSlot(inSlot.map((row) => toSlotAward(row.award, row.fulfillment)), flags.resultsPublished)) {
				throw new ApiError(409, 'slot_locked', 'Este resultado ya no se puede modificar: hay decisiones tomadas o el resultado ya se publicó');
			}

			const [manifestRow] = await tx.select().from(s.drawManifests).where(eq(s.drawManifests.campaignId, campaign.id));
			if (!manifestRow?.publishedAt) throw new ApiError(409, 'manifest_required', 'Falta el manifiesto publicado');
			const manifest = new Map(parseManifest(manifestRow.content).entries.map((entry) => [entry.entryNumber, entry.status]));

			const otherEntryIds = rows.filter((row) => !(row.award.prizeId === prize.id && row.award.slot === params.slot)).map((row) => row.award.entryId).filter((id): id is string => Boolean(id));
			const otherNumbers = otherEntryIds.length
				? await tx.select({ number: s.participationEntries.entryNumber }).from(s.participationEntries).where(inArray(s.participationEntries.id, otherEntryIds))
				: [];
			const check = checkSlotResult(
				{ winner: body.winner, alternates: body.alternates, alternatesAllowed: prize.alternatesCount },
				(number) => manifest.get(number) ?? null,
				new Set(otherNumbers.map((row) => row.number))
			);
			if (!check.ok) throw new ApiError(409, check.reason, slotMessage(check.reason, campaign.entryDigits, check.entryNumber));

			if (inSlot.length > 0) {
				await tx.delete(s.prizeAwards).where(inArray(s.prizeAwards.id, inSlot.map((row) => row.award.id)));
			}
			await insertSlotAwards(tx, admin, campaign.id, prize.id, params.slot, [
				{ entryNumber: body.winner, notes: body.notes ?? null },
				...body.alternates.map((entryNumber) => ({ entryNumber, notes: null }))
			]);
			await audit(tx, {
				organizationId: admin.tenant.id,
				actorType: actorType(admin),
				actorId: admin.identity.userId,
				action: inSlot.length > 0 ? 'award.slot_corrected' : 'award.slot_recorded',
				targetType: 'prize',
				targetId: prize.id,
				metadata: {
					slot: params.slot,
					winner: body.winner,
					alternates: body.alternates,
					previous: inSlot.length > 0 ? inSlot.map((row) => row.award.entryId) : undefined
				}
			});
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', campaign.id);
			return awardBoard(tx, admin, campaign.id);
		});
	});

	/** What the draw would award, computed on the spot and written nowhere (ADR 0014 §4). */
	app.post('/admin/campaigns/:id/quiniela/preview', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.operate');
		const { id } = parse(idParams, request.params);
		const body = parse(quinielaDrawInputSchema, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const { campaign, prizes, match, digest } = await quinielaContext(tx, id, body, deps.now(), false);
			const title = (prizeId: string) => prizes.find((prize) => prize.id === prizeId)?.title ?? '';
			return {
				entryDigits: campaign.entryDigits,
				extracts: match.extracts,
				slots: match.slots.map((slot) => ({ ...slot, prizeTitle: title(slot.prizeId) })),
				vacant: match.vacant.map((slot) => ({ ...slot, prizeTitle: title(slot.prizeId) })),
				// Sent back on confirmation, which is refused if the result changed meanwhile.
				digest
			};
		});
	});

	/**
	 * Records the draw and awards the quiniela slots it matched, once per round.
	 * Manual prizes are left as they are; the decision and delivery flow
	 * continues as with any recorded result.
	 */
	app.post('/admin/campaigns/:id/quiniela', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.operate');
		const { id } = parse(idParams, request.params);
		const body = parse(quinielaConfirmInputSchema, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const { campaign, manifestRow, manifestStatus, awardedNumbers, prizes, match, digest } = await quinielaContext(tx, id, body, deps.now(), true);
			if (digest !== body.digest) {
				throw new ApiError(409, 'preview_outdated', 'Las coincidencias cambiaron desde la vista previa: volvé a verlas antes de confirmar');
			}
			const used = new Set(awardedNumbers);
			const note = (extract: number) => `Extracto ${extract}.º de la Quiniela`;
			for (const slot of match.slots) {
				if (!slot.winner) continue;
				const prize = prizes.find((candidate) => candidate.id === slot.prizeId)!;
				const numbers = [slot.winner.entryNumber, ...slot.alternates.map((alternate) => alternate.entryNumber)];
				// The same checks as a result typed in by hand.
				const check = checkSlotResult({ winner: numbers[0]!, alternates: numbers.slice(1), alternatesAllowed: prize.alternatesCount }, manifestStatus, used);
				if (!check.ok) throw new ApiError(409, check.reason, slotMessage(check.reason, campaign.entryDigits, check.entryNumber));
				await insertSlotAwards(tx, admin, campaign.id, prize.id, slot.slot, [
					{ entryNumber: slot.winner.entryNumber, notes: note(slot.winner.extract) },
					...slot.alternates.map((alternate) => ({ entryNumber: alternate.entryNumber, notes: note(alternate.extract) }))
				]);
				for (const number of numbers) used.add(number);
			}
			await tx.insert(s.quinielaDraws).values({
				organizationId: admin.tenant.id,
				campaignId: campaign.id,
				round: 1,
				source: body.source,
				drawnAt: body.drawnAt,
				extracts: body.extracts,
				evidenceUrl: body.evidenceUrl,
				manifestSha256: manifestRow.sha256,
				recordedBy: admin.identity.userId
			});
			await tx.insert(s.drawEvents).values({
				organizationId: admin.tenant.id,
				campaignId: campaign.id,
				kind: 'quiniela_draw',
				title: `Sorteo de la Quiniela: ${body.source}`,
				detail: drawDetail(body, campaign.timezone),
				evidenceUrl: body.evidenceUrl,
				occurredAt: deps.now(),
				recordedBy: admin.identity.userId
			});
			await audit(tx, {
				organizationId: admin.tenant.id,
				actorType: actorType(admin),
				actorId: admin.identity.userId,
				action: 'award.quiniela_recorded',
				targetType: 'campaign',
				targetId: campaign.id,
				metadata: { round: 1, source: body.source, drawnAt: body.drawnAt.toISOString(), extracts: body.extracts, awarded: match.slots.length - match.vacant.length, vacant: match.vacant.length }
			});
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', campaign.id);
			return awardBoard(tx, admin, campaign.id);
		});
	});

	app.post('/admin/awards/:id/decision', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.operate');
		const { id } = parse(idParams, request.params);
		const body = parse(decisionBody, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [award] = await tx.select().from(s.prizeAwards).where(eq(s.prizeAwards.id, id));
			if (!award) throw notFound('Adjudicación');
			const campaign = await campaignForAwards(tx, award.campaignId, true);
			requireAwarding(campaign);
			const slot = (await campaignAwards(tx, campaign.id)).filter((row) => row.award.prizeId === award.prizeId && row.award.slot === award.slot);
			const check = canDecide(slot.map((row) => toSlotAward(row.award, row.fulfillment)), id);
			if (!check.ok) {
				throw new ApiError(409, check.reason, check.reason === 'already_decided' ? 'Esta adjudicación ya fue decidida' : 'Primero hay que decidir sobre quien está antes en el orden de suplencia');
			}
			const now = deps.now();
			await tx
				.update(s.prizeAwards)
				.set({ status: body.decision, decidedAt: now, decidedBy: admin.identity.userId, notes: body.notes ?? award.notes })
				.where(eq(s.prizeAwards.id, id));
			if (body.decision === 'accepted') {
				await tx
					.insert(s.prizeFulfillments)
					.values({ organizationId: admin.tenant.id, awardId: id, status: 'pending', updatedBy: admin.identity.userId })
					.onConflictDoNothing({ target: s.prizeFulfillments.awardId });
			}
			await audit(tx, {
				organizationId: admin.tenant.id,
				actorType: actorType(admin),
				actorId: admin.identity.userId,
				action: `award.${body.decision}`,
				targetType: 'prize_award',
				targetId: id,
				metadata: { prizeId: award.prizeId, slot: award.slot, role: award.role, rank: award.rank }
			});
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', campaign.id);
			return awardBoard(tx, admin, campaign.id);
		});
	});

	app.put('/admin/awards/:id/fulfillment', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.operate');
		const { id } = parse(idParams, request.params);
		const body = parse(fulfillmentBody, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [award] = await tx.select().from(s.prizeAwards).where(eq(s.prizeAwards.id, id));
			if (!award) throw notFound('Adjudicación');
			const campaign = await campaignForAwards(tx, award.campaignId, true);
			requireAwarding(campaign);
			if (award.status !== 'accepted') throw new ApiError(409, 'not_accepted', 'Solo se entrega un premio aceptado');
			const [current] = await tx.select().from(s.prizeFulfillments).where(eq(s.prizeFulfillments.awardId, id)).for('update');
			if (!canMoveFulfillment(current?.status ?? null, body.status)) {
				throw new ApiError(409, 'invalid_fulfillment', current?.status === 'delivered' ? 'La entrega ya está registrada y no se modifica' : 'Ese cambio de estado de entrega no está permitido');
			}
			const now = deps.now();
			if (body.status === 'scheduled' && !body.scheduledFor) throw new ApiError(400, 'schedule_required', 'Indicá cuándo se entrega');
			if (body.status === 'delivered' && body.deliveredAt && body.deliveredAt > now) {
				throw new ApiError(400, 'delivery_in_future', 'La fecha de entrega no puede ser futura');
			}
			const values = {
				status: body.status,
				scheduledFor: body.scheduledFor === undefined ? (current?.scheduledFor ?? null) : body.scheduledFor,
				deliveredAt: body.status === 'delivered' ? (body.deliveredAt ?? now) : null,
				evidenceUrl: body.evidenceUrl === undefined ? (current?.evidenceUrl ?? null) : body.evidenceUrl,
				notes: body.notes === undefined ? (current?.notes ?? null) : body.notes,
				updatedBy: admin.identity.userId,
				updatedAt: now
			};
			await tx
				.insert(s.prizeFulfillments)
				.values({ organizationId: admin.tenant.id, awardId: id, ...values })
				.onConflictDoUpdate({ target: s.prizeFulfillments.awardId, set: values });
			await audit(tx, {
				organizationId: admin.tenant.id,
				actorType: actorType(admin),
				actorId: admin.identity.userId,
				action: `fulfillment.${body.status}`,
				targetType: 'prize_award',
				targetId: id,
				metadata: { from: current?.status ?? null, evidence: Boolean(values.evidenceUrl) }
			});
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', campaign.id);
			return awardBoard(tx, admin, campaign.id);
		});
	});
}
