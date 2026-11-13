import { and, asc, count, desc, eq, inArray, notExists, publishOpsEvent, schema as s, sql, type BuyerSnapshot, type Tx } from '@sortea/db';
import {
	canDeclareSlotVoid,
	canDecide,
	canMoveFulfillment,
	canRecordSlot,
	checkSlotResult,
	couponPoolSize,
	formatEntryNumber,
	inCouponPool,
	maskEmail,
	maskHolderName,
	matchQuinielaDraw,
	padEntryNumber,
	parseManifest,
	quinielaConfirmInputSchema,
	quinielaDigestPayload,
	quinielaDrawInputSchema,
	quinielaEntryDigits,
	slotResolved,
	slotState,
	vacantQuinielaSlots,
	type QuinielaDrawInput,
	type SlotAward,
	type SlotState
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
const voidBody = z.object({ reason: z.string().trim().min(5).max(1000) });
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

export async function campaignForAwards(tx: Tx, campaignId: string, lock = false) {
	const query = tx.select().from(s.campaigns).where(eq(s.campaigns.id, campaignId));
	const [campaign] = lock ? await query.for('update') : await query;
	if (!campaign) throw notFound('Campaña');
	return campaign;
}

export const notAwarding = () => new ApiError(409, 'not_awarding', 'Las adjudicaciones se registran con la campaña en adjudicación, después de publicar el manifiesto');

function requireAwarding(campaign: { status: string }) {
	if (campaign.status !== 'awarding') throw notAwarding();
}

/** The rounds whose results are published (a `result_published` entry of the round). */
export async function publishedRounds(tx: Tx, campaignId: string): Promise<Set<number>> {
	const events = await tx
		.select({ round: s.drawEvents.round })
		.from(s.drawEvents)
		.where(and(eq(s.drawEvents.campaignId, campaignId), eq(s.drawEvents.kind, 'result_published')));
	return new Set(events.map((event) => event.round));
}

/**
 * Whether an award can be decided or delivered (ADR 0014 §5): the current
 * round's while the campaign is awarding, as always; an earlier round's once
 * its results are published, from the reopening (`open`) through `awarding`,
 * so a new round never freezes the winners of the previous ones.
 */
function awardOperable(campaign: { status: string; currentRound: number }, round: number, published: ReadonlySet<number>): boolean {
	if (round === campaign.currentRound) return campaign.status === 'awarding';
	return round < campaign.currentRound && published.has(round) && ['open', 'closed', 'awarding'].includes(campaign.status);
}

async function requireAwardOperable(tx: Tx, campaign: { id: string; status: string; currentRound: number }, award: { round: number }) {
	if (!awardOperable(campaign, award.round, await publishedRounds(tx, campaign.id))) throw notAwarding();
}

/**
 * `resultsPublished` is any round's: a result typed in by hand is frozen once
 * results were ever published. `roundResultsPublished` is the given round's
 * only, so publishing round 1 does not stop the draw of round 2 (ADR 0014 §5).
 */
async function drawFlags(tx: Tx, campaignId: string, round: number) {
	const events = await tx.select({ kind: s.drawEvents.kind, round: s.drawEvents.round }).from(s.drawEvents).where(eq(s.drawEvents.campaignId, campaignId));
	return {
		mechanismRecorded: events.some((event) => event.kind === 'mechanism_recorded'),
		resultsPublished: events.some((event) => event.kind === 'result_published'),
		roundResultsPublished: events.some((event) => event.kind === 'result_published' && event.round === round)
	};
}

/** The published manifest of the campaign's current round. */
export async function roundManifest(tx: Tx, campaign: { id: string; currentRound: number }) {
	const [row] = await tx
		.select()
		.from(s.drawManifests)
		.where(and(eq(s.drawManifests.campaignId, campaign.id), eq(s.drawManifests.round, campaign.currentRound)));
	return row?.publishedAt ? row : null;
}

/**
 * Quiniela units left without a winner once a Quiniela draw was recorded
 * (ADR 0014 §5), in prize order. Empty before any draw: those units are pending.
 */
export async function vacantSlots(tx: Tx, campaignId: string) {
	const [prizes, winners, [draw], voids] = await Promise.all([
		tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaignId)).orderBy(...prizeOrder),
		tx
			.select({ prizeId: s.prizeAwards.prizeId, slot: s.prizeAwards.slot, round: s.prizeAwards.round })
			.from(s.prizeAwards)
			.where(and(eq(s.prizeAwards.campaignId, campaignId), eq(s.prizeAwards.role, 'winner'))),
		tx.select({ id: s.quinielaDraws.id }).from(s.quinielaDraws).where(eq(s.quinielaDraws.campaignId, campaignId)).limit(1),
		slotVoids(tx, campaignId)
	]);
	if (!draw) return [];
	// A unit declared void is resolved: it is neither drawn again nor in the way of finishing (T13).
	return vacantQuinielaSlots(prizes, winners, undefined, voids)
		.map(({ prize, slot }) => ({ prizeId: prize.id, prize: prize.title, quantity: prize.quantity, alternatesCount: prize.alternatesCount, slot }));
}

/** The units of a campaign declared void ("desierto"; ADR 0024 §7, T13). */
export async function slotVoids(tx: Tx, campaignId: string) {
	return tx.select().from(s.prizeSlotVoids).where(eq(s.prizeSlotVoids.campaignId, campaignId));
}

/** How an award was decided: the in-app draw of a vacancy (ADR 0024), the Quiniela match, or typed in by hand. */
export type AwardSource = 'app_draw' | 'quiniela' | 'manual';
export function awardSource(award: { appDrawId: string | null }, prize: { mechanism: 'quiniela' | 'manual' }): AwardSource {
	return award.appDrawId ? 'app_draw' : prize.mechanism;
}

/** The in-app draw of the campaign's current round, if it ran (ADR 0024). */
export async function storedAppDraw(tx: Tx, campaign: { id: string; currentRound: number }) {
	const [row] = await tx
		.select()
		.from(s.appDraws)
		.where(and(eq(s.appDraws.campaignId, campaign.id), eq(s.appDraws.round, campaign.currentRound)));
	return row ?? null;
}

/** An eligible coupon with no award, with its holder's masked name: the only identity the draw screen shows (ADR 0024). */
export interface AppDrawCandidate {
	entryNumber: number;
	maskedName: string;
}

/** Every coupon of the campaign with the masked name of its purchase's buyer, by number. */
export async function maskedHolders(tx: Tx, campaignId: string): Promise<Map<number, { status: 'eligible' | 'void'; id: string; maskedName: string }>> {
	const rows = await tx
		.select({ id: s.participationEntries.id, entryNumber: s.participationEntries.entryNumber, status: s.participationEntries.status, buyer: s.orders.buyer })
		.from(s.participationEntries)
		.innerJoin(s.orders, eq(s.orders.id, s.participationEntries.orderId))
		.where(eq(s.participationEntries.campaignId, campaignId));
	return new Map(rows.map((row) => [row.entryNumber, { id: row.id, status: row.status, maskedName: maskHolderName(row.buyer.firstName, row.buyer.lastName) }]));
}

export const appDrawMessages = {
	quiniela_draw_required: 'Primero registrá el resultado de la Quiniela de esta ronda',
	no_vacant_prizes: 'No hay premios vacantes para sortear en la aplicación',
	no_candidates: 'No quedan cupones sin premio para sortear los premios vacantes',
	app_draw_exists: 'Los premios vacantes de esta ronda ya se sortearon en la aplicación',
	app_draw_missing: 'Los premios vacantes de esta ronda todavía no se sortearon en la aplicación'
} as const;

/**
 * The eligible coupons that hold no award in any role or round: the in-app
 * draw's candidates (ADR 0024 §2), counted in the database without listing
 * them, so a board over thousands of coupons stays cheap (T13, L18).
 */
export async function appDrawCandidateCount(tx: Tx, campaignId: string): Promise<number> {
	const [row] = await tx
		.select({ value: count() })
		.from(s.participationEntries)
		.where(
			and(
				eq(s.participationEntries.campaignId, campaignId),
				eq(s.participationEntries.status, 'eligible'),
				notExists(tx.select({ one: sql`1` }).from(s.prizeAwards).where(eq(s.prizeAwards.entryId, s.participationEntries.id)))
			)
		);
	return row?.value ?? 0;
}

/**
 * Whether the in-app draw of the current round can run (ADR 0024): an
 * awarding campaign whose round's Quiniela draw is recorded, its vacant units
 * in prize order, and at least one candidate, counted. Refuses with the reason
 * otherwise. Does not look at a stored draw: callers check `storedAppDraw` first.
 */
async function appDrawGate(tx: Tx, campaign: { id: string; status: string; currentRound: number }) {
	requireAwarding(campaign);
	const [roundDraw] = await tx
		.select({ id: s.quinielaDraws.id })
		.from(s.quinielaDraws)
		.where(and(eq(s.quinielaDraws.campaignId, campaign.id), eq(s.quinielaDraws.round, campaign.currentRound)));
	if (!roundDraw) throw new ApiError(409, 'quiniela_draw_required', appDrawMessages.quiniela_draw_required);
	const vacant = await vacantSlots(tx, campaign.id);
	if (vacant.length === 0) throw new ApiError(409, 'no_vacant_prizes', appDrawMessages.no_vacant_prizes);
	const candidateCount = await appDrawCandidateCount(tx, campaign.id);
	if (candidateCount === 0) throw new ApiError(409, 'no_candidates', appDrawMessages.no_candidates);
	return { vacant, candidateCount };
}

/**
 * What the in-app draw of the current round would draw: `appDrawGate`, then
 * every candidate (eligible, no award in any role or round) with its masked
 * name, ascending. Only the draw screen lists them; the board and the campaign
 * detail count (T13).
 */
export async function appDrawContext(tx: Tx, campaign: { id: string; status: string; currentRound: number }) {
	const { vacant } = await appDrawGate(tx, campaign);
	const [holders, awarded] = await Promise.all([
		maskedHolders(tx, campaign.id),
		tx.select({ entryId: s.prizeAwards.entryId }).from(s.prizeAwards).where(eq(s.prizeAwards.campaignId, campaign.id))
	]);
	const taken = new Set(awarded.map((row) => row.entryId));
	const candidates: AppDrawCandidate[] = [...holders.entries()]
		.filter(([, holder]) => holder.status === 'eligible' && !taken.has(holder.id))
		.map(([entryNumber, holder]) => ({ entryNumber, maskedName: holder.maskedName }))
		.sort((a, b) => a.entryNumber - b.entryNumber);
	if (candidates.length === 0) throw new ApiError(409, 'no_candidates', appDrawMessages.no_candidates);
	return { vacant, candidates };
}

/**
 * Whether the current round's vacancies can be drawn in the application now
 * (`ready`), were drawn (`drawn`), or not (`unavailable`, with the reason), for
 * the back office to offer the action (L14: it replaces reopening), with the
 * coupons in play: counted while `ready` (0 when none is left), the stored
 * draw's once `drawn`. It never lists the candidates (T13, L18).
 */
export async function appDrawState(tx: Tx, campaign: { id: string; status: string; currentRound: number }) {
	const stored = await storedAppDraw(tx, campaign);
	if (stored) return { state: 'drawn' as const, round: stored.round, drawnAt: stored.drawnAt, reason: null, candidateCount: stored.candidateCount };
	try {
		const { candidateCount } = await appDrawGate(tx, campaign);
		return { state: 'ready' as const, round: campaign.currentRound, drawnAt: null, reason: null, candidateCount };
	} catch (error) {
		if (error instanceof ApiError) {
			return { state: 'unavailable' as const, round: campaign.currentRound, drawnAt: null, reason: error.message, candidateCount: error.code === 'no_candidates' ? 0 : null };
		}
		throw error;
	}
}

export const slotVoidMessages = {
	slot_already_void: 'Esta unidad ya fue declarada desierta',
	slot_not_voidable: 'Solo se declara desierta una unidad vacante sin cupones para sortear o una sin suplentes disponibles',
	app_draw_possible: 'Todavía hay cupones sin premio: sorteá la unidad en la aplicación antes de declararla desierta',
	manual_results_open: 'Hay resultados cargados a mano que todavía se pueden corregir: decidí sobre sus ganadores antes de declarar desierta una unidad vacante',
	reason_required: 'Explicá por qué la unidad queda desierta'
} as const;

/**
 * Whether a unit can be declared void now (T13): `canDeclareSlotVoid` with the
 * unit's state ("vacant" when the recorded draw left it without a winner)
 * and the coupons without a prize counted now. `appDraw` is the board's state
 * when known: its count is live except once `drawn` (then it is the stored
 * draw's), so a drawn round is counted again. A vacancy also waits for every
 * manual result that can still be corrected (`manualResultsOpen`).
 */
async function slotVoidCheck(
	tx: Tx,
	campaign: { id: string },
	slot: { state: SlotState['state'] | 'vacant'; declared: boolean },
	appDraw?: { state: string; candidateCount: number | null }
) {
	const needsCount = !slot.declared && slot.state === 'vacant';
	const live = appDraw && appDraw.state !== 'drawn' ? appDraw.candidateCount : null;
	const candidates = needsCount ? (live ?? (await appDrawCandidateCount(tx, campaign.id))) : 0;
	const open = needsCount && candidates === 0 && (await manualResultsOpen(tx, campaign.id));
	return canDeclareSlotVoid({ state: slot.state, declared: slot.declared, candidates, manualResultsOpen: open });
}

/**
 * Whether some manual result holds awards and can still be corrected with
 * `PUT …/awards/:prizeId/slots/:slot` (the same `canRecordSlot` it checks). A
 * correction replaces the slot's awards and can give coupons back to the
 * in-app draw, so a vacancy is not declared void while one is open (T13).
 */
async function manualResultsOpen(tx: Tx, campaignId: string): Promise<boolean> {
	const [rows, published] = await Promise.all([
		tx
			.select({ award: s.prizeAwards, fulfillment: s.prizeFulfillments })
			.from(s.prizeAwards)
			.innerJoin(s.prizes, eq(s.prizes.id, s.prizeAwards.prizeId))
			.leftJoin(s.prizeFulfillments, eq(s.prizeFulfillments.awardId, s.prizeAwards.id))
			.where(and(eq(s.prizeAwards.campaignId, campaignId), eq(s.prizes.mechanism, 'manual'))),
		publishedRounds(tx, campaignId)
	]);
	const slots = new Map<string, SlotAward[]>();
	for (const row of rows) {
		const key = `${row.award.prizeId}#${row.award.slot}`;
		slots.set(key, [...(slots.get(key) ?? []), toSlotAward(row.award, row.fulfillment)]);
	}
	return [...slots.values()].some((awards) => canRecordSlot(awards, published.size > 0));
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
	const [prizes, rows, voids] = await Promise.all([
		tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaignId)),
		campaignAwards(tx, campaignId),
		slotVoids(tx, campaignId)
	]);
	let unresolved = 0;
	for (const prize of prizes) {
		for (let slot = 1; slot <= prize.quantity; slot++) {
			// Declared void: nobody gets it, and the record says why (T13).
			if (voids.some((declared) => declared.prizeId === prize.id && declared.slot === slot)) continue;
			const awards = rows.filter((row) => row.award.prizeId === prize.id && row.award.slot === slot).map((row) => toSlotAward(row.award, row.fulfillment));
			if (!slotResolved(awards)) unresolved++;
		}
	}
	return unresolved;
}

async function awardBoard(tx: Tx, admin: AdminContext, campaignId: string) {
	const campaign = await campaignForAwards(tx, campaignId);
	const showPii = admin.permissions.includes('orders.pii');
	const [prizes, rows, flags, voids] = await Promise.all([
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
		drawFlags(tx, campaignId, campaign.currentRound),
		slotVoids(tx, campaignId)
	]);
	const appDraw = await appDrawState(tx, campaign);
	if (showPii && rows.length > 0) {
		await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action: 'awards.pii_viewed', targetType: 'campaign', targetId: campaignId });
	}

	const draws = await tx.select().from(s.quinielaDraws).where(eq(s.quinielaDraws.campaignId, campaignId)).orderBy(desc(s.quinielaDraws.round));
	// The current round's draw; units an earlier round's draw left without a match stay vacant until a later one fills them.
	const draw = draws.find((candidate) => candidate.round === campaign.currentRound);
	const canOperate = admin.permissions.includes('campaigns.operate') && campaign.status === 'awarding';
	const published = await publishedRounds(tx, campaignId);
	const operates = admin.permissions.includes('campaigns.operate');
	// Whether a vacant unit can be declared void depends on the campaign, not the unit: decided once (T13).
	const vacantVoid = canOperate ? await slotVoidCheck(tx, campaign, { state: 'vacant', declared: false }, appDraw) : null;
	const vacantVoidable = vacantVoid?.ok === true;
	return {
		campaign: { id: campaign.id, title: campaign.title, status: campaign.status, timezone: campaign.timezone, entryDigits: campaign.entryDigits, round: campaign.currentRound },
		...flags,
		canOperate,
		piiVisible: showPii,
		/** The in-app draw of this round's vacancies (ADR 0024): `ready` to run, `drawn`, or `unavailable` with the reason; and the coupons in play, counted. */
		appDraw,
		/** Why a vacant unit with no coupon left cannot be declared void yet (open manual results), else null. */
		voidBlocked: vacantVoid && !vacantVoid.ok && vacantVoid.reason === 'manual_results_open' ? slotVoidMessages.manual_results_open : null,
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
				const declared = voids.find((row) => row.prizeId === prize.id && row.slot === slot) ?? null;
				// A quiniela slot that the recorded draw left without a match is vacant (ADR 0014 §5).
				const shown = prize.mechanism === 'quiniela' && draws.length > 0 && state.state === 'empty' ? 'vacant' : state.state;
				return {
					slot,
					// Declared void ("desierto", T13): nobody gets it, whatever it held before.
					state: declared ? 'void' : shown,
					// Quiniela prizes come only from the recorded draw, never typed in.
					canRecord: canOperate && !declared && prize.mechanism === 'manual' && flags.mechanismRecorded && canRecordSlot(awards, flags.resultsPublished),
					/** Vacant with nobody left to draw it, or out of alternates: it can be declared void with a reason. */
					canDeclareVoid: canOperate && !declared && (shown === 'exhausted' || (shown === 'vacant' && vacantVoidable)),
					void: declared ? { reason: declared.reason, declaredAt: declared.declaredAt } : null,
					awards: slotRows
						.sort((a, b) => (a.award.role === b.award.role ? a.award.rank - b.award.rank : a.award.role === 'winner' ? -1 : 1))
						.map(({ award, fulfillment, entryNumber, entryStatus, contact, buyer }) => ({
							id: award.id,
							role: award.role,
							rank: award.rank,
							status: award.status,
							source: awardSource(award, prize),
							entryNumber,
							// A refund after the close voids the entry but not the frozen manifest; people decide.
							entryVoidedAfterClose: entryStatus === 'void',
							active: award.id === activeId,
							/** Decisions and delivery are open for it now (current round while awarding, earlier published rounds too). */
							operable: operates && awardOperable(campaign, award.round, published),
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
export async function insertSlotAwards(
	tx: Tx,
	admin: AdminContext,
	campaignId: string,
	prizeId: string,
	slot: number,
	round: number,
	awards: readonly { entryNumber: number; notes: string | null }[],
	appDrawId: string | null = null
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
			notes: award.notes,
			round,
			appDrawId
		}))
	);
}

/** "28/11/2026 22:00": an instant in the campaign's time zone. */
export function campaignDateTime(date: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
	const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? '';
	return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
}

/**
 * Everything a Quiniela draw is matched against (ADR 0014 §3-§5): an awarding
 * campaign with the published manifest of its current round, a 0000–9999
 * pool, at least one quiniela prize, the round's results not published yet,
 * no draw recorded yet for the round, and a draw held after the round's
 * manifest was published. Units awarded in earlier rounds stay as they are.
 */
async function quinielaContext(tx: Tx, campaignId: string, body: QuinielaDrawInput, now: Date, lock: boolean) {
	const campaign = await campaignForAwards(tx, campaignId, lock);
	requireAwarding(campaign);
	const manifestRow = await roundManifest(tx, campaign);
	if (!manifestRow?.publishedAt) throw new ApiError(409, 'manifest_required', 'Falta el manifiesto publicado');
	if (campaign.entryDigits !== quinielaEntryDigits) {
		throw new ApiError(409, 'pool_not_quiniela', `La Quiniela sortea números de ${quinielaEntryDigits} cifras y los cupones de esta campaña tienen ${campaign.entryDigits}`);
	}
	const prizes = await tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaign.id)).orderBy(...prizeOrder);
	if (!prizes.some((prize) => prize.mechanism === 'quiniela')) {
		throw new ApiError(409, 'no_quiniela_prizes', 'Ningún premio de esta campaña se define con el sorteo de la Quiniela');
	}
	// The round's published results are frozen, as for a result typed in by hand; an earlier round's are not in the way.
	if ((await drawFlags(tx, campaign.id, campaign.currentRound)).roundResultsPublished) {
		throw new ApiError(409, 'results_published', 'Los resultados ya se publicaron: el sorteo de la Quiniela ya no se puede registrar');
	}
	// One draw per round.
	const [existing] = await tx
		.select({ id: s.quinielaDraws.id })
		.from(s.quinielaDraws)
		.where(and(eq(s.quinielaDraws.campaignId, campaign.id), eq(s.quinielaDraws.round, campaign.currentRound)));
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
		.select({ prizeId: s.prizeAwards.prizeId, slot: s.prizeAwards.slot, role: s.prizeAwards.role, round: s.prizeAwards.round, entryNumber: s.participationEntries.entryNumber })
		.from(s.prizeAwards)
		.leftJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
		.where(eq(s.prizeAwards.campaignId, campaign.id));
	const awardedNumbers = new Set(awarded.map((row) => row.entryNumber).filter((number): number is number => number !== null));
	// The units still open (no winner, not declared void, T13): every other unit is filled for this draw.
	const open = vacantQuinielaSlots(prizes, awarded.filter((row) => row.role === 'winner'), undefined, await slotVoids(tx, campaign.id));
	const match = matchQuinielaDraw({
		extracts: body.extracts,
		prizes: prizes.map((prize) => ({
			id: prize.id,
			mechanism: prize.mechanism,
			position: prize.position,
			quantity: prize.quantity,
			alternatesCount: prize.alternatesCount,
			createdAt: prize.createdAt,
			filledSlots: Array.from({ length: prize.quantity }, (_, index) => index + 1).filter((slot) => !open.some((unit) => unit.prize.id === prize.id && unit.slot === slot))
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
			const flags = await drawFlags(tx, campaign.id, campaign.currentRound);
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

			const manifestRow = await roundManifest(tx, campaign);
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
			await insertSlotAwards(tx, admin, campaign.id, prize.id, params.slot, campaign.currentRound, [
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

	/**
	 * Declares a unit void ("desierto") with a reason when nobody can win it any
	 * more (ADR 0024 §7; T13, L18). Append-only and audited; the unit then counts
	 * as resolved, so the campaign can finish.
	 */
	app.post('/admin/campaigns/:id/awards/:prizeId/slots/:slot/void', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.operate');
		const params = parse(z.object({ id: z.uuid(), prizeId: z.uuid(), slot: z.coerce.number().int().min(1).max(10_000) }), request.params);
		const body = parse(voidBody, request.body, (issues) =>
			issues.some((issue) => issue.path[0] === 'reason') ? new ApiError(400, 'reason_required', slotVoidMessages.reason_required) : null
		);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await campaignForAwards(tx, params.id, true);
			requireAwarding(campaign);
			const [prize] = await tx.select().from(s.prizes).where(and(eq(s.prizes.id, params.prizeId), eq(s.prizes.campaignId, campaign.id)));
			if (!prize) throw notFound('Premio');
			if (params.slot > prize.quantity) throw new ApiError(400, 'invalid_slot', 'Ese premio no tiene tantas unidades');

			const [declared] = await tx
				.select({ id: s.prizeSlotVoids.id })
				.from(s.prizeSlotVoids)
				.where(and(eq(s.prizeSlotVoids.prizeId, prize.id), eq(s.prizeSlotVoids.slot, params.slot)));
			const inSlot = (await campaignAwards(tx, campaign.id)).filter((row) => row.award.prizeId === prize.id && row.award.slot === params.slot);
			const vacant = (await vacantSlots(tx, campaign.id)).some((unit) => unit.prizeId === prize.id && unit.slot === params.slot);
			const state = vacant ? 'vacant' : slotState(inSlot.map((row) => toSlotAward(row.award, row.fulfillment))).state;
			const check = await slotVoidCheck(tx, campaign, { state, declared: Boolean(declared) });
			if (!check.ok) throw new ApiError(409, check.reason, slotVoidMessages[check.reason]);

			const now = deps.now();
			await tx.insert(s.prizeSlotVoids).values({
				organizationId: admin.tenant.id,
				campaignId: campaign.id,
				prizeId: prize.id,
				slot: params.slot,
				round: campaign.currentRound,
				reason: body.reason,
				declaredBy: admin.identity.userId,
				declaredAt: now
			});
			await audit(tx, {
				organizationId: admin.tenant.id,
				actorType: actorType(admin),
				actorId: admin.identity.userId,
				action: 'award.slot_declared_void',
				targetType: 'prize',
				targetId: prize.id,
				metadata: { slot: params.slot, round: campaign.currentRound, from: state, reason: body.reason }
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
				await insertSlotAwards(tx, admin, campaign.id, prize.id, slot.slot, campaign.currentRound, [
					{ entryNumber: slot.winner.entryNumber, notes: note(slot.winner.extract) },
					...slot.alternates.map((alternate) => ({ entryNumber: alternate.entryNumber, notes: note(alternate.extract) }))
				]);
				for (const number of numbers) used.add(number);
			}
			await tx.insert(s.quinielaDraws).values({
				organizationId: admin.tenant.id,
				campaignId: campaign.id,
				round: campaign.currentRound,
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
				round: campaign.currentRound,
				title: campaign.currentRound > 1 ? `Sorteo de la Quiniela de la ronda ${campaign.currentRound}: ${body.source}` : `Sorteo de la Quiniela: ${body.source}`,
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
				metadata: { round: campaign.currentRound, source: body.source, drawnAt: body.drawnAt.toISOString(), extracts: body.extracts, awarded: match.slots.length - match.vacant.length, vacant: match.vacant.length }
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
			await requireAwardOperable(tx, campaign, award);
			// Alternates are promoted within the award's own round.
			const slot = (await campaignAwards(tx, campaign.id)).filter(
				(row) => row.award.prizeId === award.prizeId && row.award.slot === award.slot && row.award.round === award.round
			);
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
			await requireAwardOperable(tx, campaign, award);
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
