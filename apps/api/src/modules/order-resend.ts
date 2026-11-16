import { and, count, eq, gt, ne, publishOpsEvent, schema as s, sql, type Tx } from '@sortea/db';
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
				await audit(tx, { ...actor, action: 'order.email_corrected', metadata: { from: maskEmail(previous), to: maskEmail(to), contactEmailUpdated } });
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
