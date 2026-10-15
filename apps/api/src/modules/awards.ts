import { and, asc, eq, inArray, publishOpsEvent, schema as s, type Tx } from '@sortea/db';
import {
	canDecide,
	canMoveFulfillment,
	canRecordSlot,
	checkSlotResult,
	maskEmail,
	parseManifest,
	slotResolved,
	slotState,
	type SlotAward
} from '@sortea/domain';
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

const entryNumber = z.coerce.number().int().min(1).max(100_000_000);
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
		tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaignId)).orderBy(asc(s.prizes.position)),
		tx
			.select({
				award: s.prizeAwards,
				fulfillment: s.prizeFulfillments,
				entryNumber: s.participationEntries.entryNumber,
				entryStatus: s.participationEntries.status,
				contact: s.contacts
			})
			.from(s.prizeAwards)
			.leftJoin(s.prizeFulfillments, eq(s.prizeFulfillments.awardId, s.prizeAwards.id))
			.leftJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
			.leftJoin(s.contacts, eq(s.contacts.id, s.participationEntries.contactId))
			.where(eq(s.prizeAwards.campaignId, campaignId)),
		drawFlags(tx, campaignId)
	]);
	if (showPii && rows.length > 0) {
		await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action: 'awards.pii_viewed', targetType: 'campaign', targetId: campaignId });
	}

	const canOperate = admin.permissions.includes('campaigns.operate') && campaign.status === 'awarding';
	return {
		campaign: { id: campaign.id, title: campaign.title, status: campaign.status, timezone: campaign.timezone },
		...flags,
		canOperate,
		piiVisible: showPii,
		prizes: prizes.map((prize) => ({
			id: prize.id,
			position: prize.position,
			kind: prize.kind,
			title: prize.title,
			quantity: prize.quantity,
			alternatesCount: prize.alternatesCount,
			slots: Array.from({ length: prize.quantity }, (_, index) => {
				const slot = index + 1;
				const slotRows = rows.filter((row) => row.award.prizeId === prize.id && row.award.slot === slot);
				const awards = slotRows.map((row) => toSlotAward(row.award, row.fulfillment));
				const state = slotState(awards);
				const activeId = 'award' in state ? state.award.id : null;
				return {
					slot,
					state: state.state,
					canRecord: canOperate && flags.mechanismRecorded && canRecordSlot(awards, flags.resultsPublished),
					awards: slotRows
						.sort((a, b) => (a.award.role === b.award.role ? a.award.rank - b.award.rank : a.award.role === 'winner' ? -1 : 1))
						.map(({ award, fulfillment, entryNumber, entryStatus, contact }) => ({
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
									? { name: `${contact.firstName} ${contact.lastName}`, email: contact.email, phone: contact.phone }
									: { name: `${contact.firstName} ${contact.lastName.slice(0, 1)}.`, email: maskEmail(contact.email), phone: null }
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

function slotMessage(reason: string, entry?: number): string {
	const messages: Record<string, string> = {
		too_many_alternates: 'Hay más suplentes que los que prevén las bases para este premio',
		duplicate_entry: `La participación ${entry} está repetida en este premio`,
		not_in_manifest: `La participación ${entry} no está en el manifiesto publicado`,
		not_eligible: `La participación ${entry} figura anulada en el manifiesto publicado`,
		already_awarded: `La participación ${entry} ya tiene otro premio en esta campaña`
	};
	return messages[reason] ?? 'Revisá los números de participación';
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
			if (params.slot > prize.quantity) throw new ApiError(400, 'invalid_slot', 'Ese premio no tiene tantas unidades');

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
			if (!check.ok) throw new ApiError(409, check.reason, slotMessage(check.reason, check.entryNumber));

			const numbers = [body.winner, ...body.alternates];
			const entries = await tx
				.select({ id: s.participationEntries.id, number: s.participationEntries.entryNumber })
				.from(s.participationEntries)
				.where(and(eq(s.participationEntries.campaignId, campaign.id), inArray(s.participationEntries.entryNumber, numbers)));
			const entryId = new Map(entries.map((entry) => [entry.number, entry.id]));

			if (inSlot.length > 0) {
				await tx.delete(s.prizeAwards).where(inArray(s.prizeAwards.id, inSlot.map((row) => row.award.id)));
			}
			await tx.insert(s.prizeAwards).values(
				numbers.map((number, index) => ({
					organizationId: admin.tenant.id,
					campaignId: campaign.id,
					prizeId: prize.id,
					slot: params.slot,
					role: index === 0 ? ('winner' as const) : ('alternate' as const),
					rank: index === 0 ? 1 : index,
					entryId: entryId.get(number) ?? null,
					recordedBy: admin.identity.userId,
					notes: index === 0 ? (body.notes ?? null) : null
				}))
			);
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
