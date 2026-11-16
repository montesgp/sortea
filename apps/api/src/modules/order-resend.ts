import { and, count, eq, gt, inArray, isNull, ne, or, publishOpsEvent, schema as s, sql, type Tx } from '@sortea/db';
import { maskEmail, orderResendSchema } from '@sortea/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorType, requireAdmin } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { ApiError, notFound, parse } from '../lib/errors';
import { enqueue } from '../lib/outbox';

const idParams = z.object({ id: z.uuid() });

/** Resends of one order in 24 hours: enough for "no me llegó" and a correction or two, not a mail cannon. */
export const RESENDS_PER_DAY = 5;
const DAY_MS = 24 * 3_600_000;

const resendPrefix = (orderId: string) => `order.paid:resend:${orderId}:`;

/**
 * Whether the order has a purchase email to send again: it is paid and its `order.paid`
 * email was enqueued when the payment was confirmed. The worker sends it only for paid orders.
 */
export async function resendable(tx: Tx, order: { id: string; status: string }): Promise<boolean> {
	if (order.status !== 'paid') return false;
	const [event] = await tx.select({ id: s.outboxEvents.id }).from(s.outboxEvents).where(eq(s.outboxEvents.dedupeKey, `order.paid:${order.id}`));
	return Boolean(event);
}

/**
 * Corrects an order's email and sends its purchase email again (odd/tasks/checkout-two-steps.md S5).
 * The checkout asks for the email once; when a buyer typed it wrong, the owner or support confirms
 * the right one by phone and sends the receipt, the download links and the coupons to it. The same
 * `order.paid` handler of the worker builds the email from the order, so it carries the same receipt
 * and coupons, with fresh download links.
 *
 * Only that order's email changes. The person's own email (the contact's, where Consultar sends the
 * code that opens every purchase of the document) follows only when it is the mistyped one, no other
 * purchase of the person uses it and no Consultar code ever proved it reachable: then the old address
 * was only this typo. Otherwise it stays, and the corrected email gets its own Consultar code, which
 * opens the purchases made with it (owner feedback 2026-11-15b L5).
 *
 * A correction also closes what the mistyped address received (odd/tasks/limits-and-correction.md S1):
 * the order's download links issued before it, and the open Consultar codes and sessions sent to that
 * address for this person. The receipt's access code is never emailed (only the buyer's own browser
 * and the result page have it), so it has nothing to close.
 */
export async function orderResendRoutes(app: FastifyInstance) {
	const { deps } = app;

	app.post('/admin/orders/:id/resend', async (request) => {
		const admin = await requireAdmin(request, 'orders.view');
		admin.assert('orders.resend');
		const { id } = parse(idParams, request.params);
		const body = parse(orderResendSchema, request.body, (issues) =>
			issues.some((issue) => issue.path[0] === 'email') ? new ApiError(400, 'invalid_email', 'Ingresá un email válido') : null
		);
		const now = deps.now();

		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			// Locked, so concurrent resends of one order are counted one after the other.
			const [order] = await tx.select().from(s.orders).where(eq(s.orders.id, id)).for('update');
			if (!order) throw notFound('Orden');
			const dedupeKey = `${resendPrefix(order.id)}${body.requestId}`;
			const sent = (since: Date) =>
				tx
					.select({ value: count() })
					.from(s.outboxEvents)
					.where(and(sql`${s.outboxEvents.dedupeKey} like ${`${resendPrefix(order.id)}%`}`, gt(s.outboxEvents.createdAt, since)))
					.then(([row]) => row?.value ?? 0);

			// The same request again (a reload, a double click) answers as the first time and sends nothing.
			const [repeated] = await tx.select({ payload: s.outboxEvents.payload }).from(s.outboxEvents).where(eq(s.outboxEvents.dedupeKey, dedupeKey));
			if (repeated) {
				return {
					to: String(repeated.payload.to),
					emailCorrected: repeated.payload.emailCorrected === true,
					resendsLeft: Math.max(0, RESENDS_PER_DAY - (await sent(new Date(now.getTime() - DAY_MS))))
				};
			}

			if (!(await resendable(tx, order))) {
				throw new ApiError(409, 'order_not_resendable', 'Esta compra no tiene un email de compra para reenviar: solo se reenvían las compras pagadas.');
			}
			const recent = await sent(new Date(now.getTime() - DAY_MS));
			if (recent >= RESENDS_PER_DAY) {
				throw new ApiError(429, 'resend_limit', `Ya reenviaste esta compra ${RESENDS_PER_DAY} veces en las últimas 24 horas. Probá de nuevo más tarde.`);
			}

			const previous = order.buyer.email;
			const to = body.email ?? previous;
			const emailCorrected = to !== previous;
			const actor = { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, targetType: 'order', targetId: order.id } as const;
			if (emailCorrected) {
				await tx
					.update(s.orders)
					.set({ buyer: { ...order.buyer, email: to }, updatedAt: now })
					.where(eq(s.orders.id, order.id));
				const contactEmailUpdated = await followContact(tx, order, previous, to, now);
				const closed = await closeOldAddress(tx, order, previous, contactEmailUpdated, now);
				await audit(tx, { ...actor, action: 'order.email_corrected', metadata: { from: maskEmail(previous), to: maskEmail(to), contactEmailUpdated, ...closed } });
				await publishOpsEvent(tx, admin.tenant.id, 'order.updated', order.id);
			}
			// The worker reads the address from the order; the masked `to` only answers a repeated request.
			await enqueue(tx, admin.tenant.id, 'order.paid', dedupeKey, { orderId: order.id, resend: true, to: maskEmail(to), emailCorrected }, now);
			await audit(tx, { ...actor, action: 'order.purchase_resent', metadata: { to: maskEmail(to), emailCorrected, requestId: body.requestId } });
			return { to: maskEmail(to), emailCorrected, resendsLeft: RESENDS_PER_DAY - recent - 1 };
		});
	});
}

/**
 * Moves the contact's email to the corrected one when the old one was only this order's typo:
 * the contact has it, no other order of the contact uses it, and no Consultar code sent to it was
 * ever verified. Returns whether it moved.
 */
async function followContact(tx: Tx, order: typeof s.orders.$inferSelect, previous: string, next: string, now: Date): Promise<boolean> {
	const [contact] = await tx.select().from(s.contacts).where(eq(s.contacts.id, order.contactId)).for('update');
	if (!contact || contact.email !== previous || contact.emailVerifiedAt) return false;
	const [elsewhere] = await tx
		.select({ id: s.orders.id })
		.from(s.orders)
		.where(and(eq(s.orders.contactId, order.contactId), ne(s.orders.id, order.id), eq(sql`${s.orders.buyer}->>'email'`, previous)))
		.limit(1);
	if (elsewhere) return false;
	await tx.update(s.contacts).set({ email: next, updatedAt: now }).where(eq(s.contacts.id, contact.id));
	return true;
}

/**
 * Ends what the mistyped address received, in the correction's transaction. Rows are kept and only
 * expired, so the history stays:
 * - the order's download grants issued so far: the links of the first email and of any resend to the
 *   old address; the resend's own grants are issued by the worker afterwards and keep working;
 * - the open Consultar requests with a code sent to the old address for this contact: the codes sent
 *   to it as another email of the person, and the person's own codes when the person's email moved
 *   with the correction. A request closes whole, as when one of its codes is used;
 * - the open Consultar sessions opened with those codes.
 * Other people who use the same address keep theirs: everything is scoped to this order's contact.
 */
async function closeOldAddress(tx: Tx, order: typeof s.orders.$inferSelect, previous: string, contactMoved: boolean, now: Date) {
	const grants = await tx
		.update(s.downloadGrants)
		.set({ expiresAt: now })
		.where(and(eq(s.downloadGrants.orderId, order.id), gt(s.downloadGrants.expiresAt, now)))
		.returning({ id: s.downloadGrants.id });

	const challenges = s.lookupChallenges;
	const sentToOld = await tx
		.select({ id: challenges.id, groupId: challenges.groupId })
		.from(challenges)
		.where(
			and(
				eq(challenges.contactId, order.contactId),
				isNull(challenges.consumedAt),
				gt(challenges.expiresAt, now),
				or(eq(challenges.email, previous), contactMoved ? isNull(challenges.email) : undefined)
			)
		)
		.for('update');
	// Codes created before requests had several stand alone: their request is their own id.
	const requests = [...new Set(sentToOld.map((code) => code.groupId ?? code.id))];
	if (requests.length) {
		await tx
			.update(challenges)
			.set({ expiresAt: now })
			.where(and(or(inArray(challenges.groupId, requests), inArray(challenges.id, requests)), gt(challenges.expiresAt, now)));
	}

	const sessions = s.lookupSessions;
	const sessionsClosed = await tx
		.update(sessions)
		.set({ expiresAt: now })
		.where(
			and(
				eq(sessions.contactId, order.contactId),
				gt(sessions.expiresAt, now),
				or(eq(sessions.email, previous), contactMoved ? and(isNull(sessions.email), isNull(sessions.orderId)) : undefined)
			)
		)
		.returning({ id: sessions.id });

	return { downloadLinksEnded: grants.length, lookupRequestsClosed: requests.length, lookupSessionsClosed: sessionsClosed.length };
}
