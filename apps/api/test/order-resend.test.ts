import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, or, orgRoles, schema as s, sql } from '@sortea/db';
import { openSecret } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	adminHeaders,
	createTenant,
	createTestContext,
	headers,
	openCampaign,
	orderByReference,
	placeOrder,
	webhookRequest,
	type TenantFixture,
	type TestContext
} from './helpers';

// odd/tasks/checkout-two-steps.md T3, S5: the checkout asks for the email once. When a buyer typed it
// wrong, the owner or support confirms the right one by phone and, from the order, corrects the
// order's email and sends the purchase email again (receipt, downloads, coupons); or just sends it
// again to the same email ("no me llegó").

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;

const buyer = (documentNumber: string, email: string) => ({
	buyer: { documentType: 'DNI', documentNumber, firstName: 'Juana', lastName: 'Pérez', email, phone: '+54 9 11 2345-6789', province: 'Córdoba', city: 'Río Cuarto' }
});

async function paidOrder(target: TenantFixture, documentNumber: string, email: string) {
	const placed = await placeOrder(ctx, target, buyer(documentNumber, email));
	const payment = ctx.simulator.pay(placed.checkoutId, 'approved');
	await ctx.app.inject(webhookRequest(target, payment.id));
	return orderByReference(ctx, target, placed.reference);
}

async function addMember(target: TenantFixture, role: (typeof orgRoles)[number]) {
	const userId = randomUUID();
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: target.id, userId, email: `${role}-${userId.slice(0, 4)}@${target.host}`, role }));
	return adminHeaders(ctx, target, userId);
}

function resend(orderId: string, auth: Record<string, string>, payload: Record<string, unknown> = {}) {
	return ctx.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/resend`, headers: auth, payload: { requestId: randomUUID(), ...payload } });
}

async function resendEvents(target: TenantFixture, orderId: string) {
	return ctx.db.withTenant(target.id, (tx) =>
		tx.select().from(s.outboxEvents).where(sql`${s.outboxEvents.dedupeKey} like ${`order.paid:resend:${orderId}:%`}`).orderBy(asc(s.outboxEvents.createdAt))
	);
}

async function auditRows(target: TenantFixture, orderId: string, action: string) {
	return ctx.db.withTenant(target.id, (tx) =>
		tx
			.select()
			.from(s.auditEvents)
			.where(and(eq(s.auditEvents.action, action), eq(s.auditEvents.targetId, orderId)))
			.orderBy(desc(s.auditEvents.createdAt))
	);
}

async function contactOf(target: TenantFixture, contactId: string) {
	const [contact] = await ctx.db.withTenant(target.id, (tx) => tx.select().from(s.contacts).where(eq(s.contacts.id, contactId)));
	return contact!;
}

/** The Consultar code each address gets for a request, read from the sealed outbox payloads. */
async function lookupCodes(documentNumber: string) {
	const started = await ctx.app.inject({ method: 'POST', url: '/lookup/start', headers: headers(tenant), payload: { documentType: 'DNI', documentNumber } });
	expect(started.statusCode).toBe(200);
	const { challengeId } = started.json() as { challengeId: string };
	const codes = await ctx.db.withTenant(tenant.id, async (tx) => {
		const rows = await tx
			.select({ id: s.lookupChallenges.id, email: s.lookupChallenges.email, contactEmail: s.contacts.email })
			.from(s.lookupChallenges)
			.leftJoin(s.contacts, eq(s.contacts.id, s.lookupChallenges.contactId))
			.where(or(eq(s.lookupChallenges.groupId, challengeId), eq(s.lookupChallenges.id, challengeId)));
		const found: Record<string, string> = {};
		for (const row of rows) {
			const [event] = await tx.select().from(s.outboxEvents).where(eq(s.outboxEvents.dedupeKey, `lookup.otp:${row.id}`));
			if (event) found[row.email ?? row.contactEmail!] = openSecret(ctx.deps.keyRing, String(event.payload.sealedCode), `otp:${row.id}`);
		}
		return found;
	});
	return { challengeId, codes };
}

async function lookupReferences(challengeId: string, code: string) {
	const verified = await ctx.app.inject({ method: 'POST', url: '/lookup/verify', headers: headers(tenant), payload: { challengeId, code } });
	expect(verified.statusCode).toBe(200);
	const me = await ctx.app.inject({ method: 'GET', url: '/lookup/me', headers: headers(tenant, { 'x-lookup-token': verified.json().token }) });
	return (me.json().orders as { reference: string }[]).map((order) => order.reference).sort();
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'order-resend');
	other = await createTenant(ctx, 'order-resend-other');
	await openCampaign(ctx, tenant);
});
afterAll(() => ctx.close());

describe('who may resend a purchase (S5)', () => {
	it('the owner and support resend, every other role gets 403 and nothing changes', async () => {
		const order = await paidOrder(tenant, '30100100', 'matriz@example.com');
		for (const role of orgRoles) {
			const auth = role === 'org_owner' ? await adminHeaders(ctx, tenant) : await addMember(tenant, role);
			const response = await resend(order.id, auth, { email: `${role.replace('_', '-')}@example.com` });
			if (role === 'org_owner' || role === 'support_agent') {
				expect(response.statusCode, role).toBe(200);
			} else {
				expect(response.statusCode, role).toBe(403);
				expect(response.json().error.code, role).toBe('forbidden');
			}
		}
		const events = await resendEvents(tenant, order.id);
		expect(events).toHaveLength(2);
		// The last allowed role, support, left its email on the order.
		expect((await orderByReference(ctx, tenant, order.reference)).buyer.email).toBe('support-agent@example.com');
	});
});

describe('resending to the same email ("no me llegó")', () => {
	it('enqueues the purchase email again through the outbox, to the order email, and audits it masked', async () => {
		const order = await paidOrder(tenant, '30200200', 'nollego@example.com');
		const response = await resend(order.id, await adminHeaders(ctx, tenant));
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ to: 'no*****@example.com', emailCorrected: false, resendsLeft: 4 });

		const [event] = await resendEvents(tenant, order.id);
		// The same topic and handler as the first purchase email: same receipt, coupons and download links.
		expect(event).toMatchObject({ topic: 'order.paid', status: 'pending', payload: { orderId: order.id } });
		expect((await orderByReference(ctx, tenant, order.reference)).buyer.email).toBe('nollego@example.com');
		expect(await auditRows(tenant, order.id, 'order.email_corrected')).toEqual([]);
		const [sent] = await auditRows(tenant, order.id, 'order.purchase_resent');
		expect(sent).toMatchObject({ actorType: 'admin', actorId: tenant.ownerId, targetType: 'order', metadata: { to: 'no*****@example.com', emailCorrected: false } });
		expect(JSON.stringify(sent!.metadata)).not.toContain('nollego@');
	});

	it('the same request twice sends once', async () => {
		const order = await paidOrder(tenant, '30300300', 'dos-veces@example.com');
		const auth = await adminHeaders(ctx, tenant);
		const requestId = randomUUID();
		const first = await resend(order.id, auth, { requestId, email: 'dos.veces@example.com' });
		const second = await resend(order.id, auth, { requestId, email: 'dos.veces@example.com' });
		expect(first.statusCode).toBe(200);
		expect(second.statusCode).toBe(200);
		expect(second.json()).toEqual(first.json());
		expect(await resendEvents(tenant, order.id)).toHaveLength(1);
		expect(await auditRows(tenant, order.id, 'order.purchase_resent')).toHaveLength(1);
		expect(await auditRows(tenant, order.id, 'order.email_corrected')).toHaveLength(1);
	});
});

describe('correcting the email', () => {
	it('changes the email of that order only, trimmed and lowercased, and audits both emails masked', async () => {
		// One person, two paid purchases with the same mistyped email: only the corrected order changes.
		const corrected = await paidOrder(tenant, '30400400', 'pedro@exmaple.com');
		const untouched = await paidOrder(tenant, '30400400', 'pedro@exmaple.com');
		const response = await resend(corrected.id, await adminHeaders(ctx, tenant), { email: '  Pedro@Example.COM ' });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ to: 'pe***@example.com', emailCorrected: true, resendsLeft: 4 });

		expect((await orderByReference(ctx, tenant, corrected.reference)).buyer).toMatchObject({ email: 'pedro@example.com', firstName: 'Juana', lastName: 'Pérez', phone: '+54 9 11 2345-6789' });
		expect((await orderByReference(ctx, tenant, untouched.reference)).buyer.email).toBe('pedro@exmaple.com');
		// The other purchase still uses the old email, so the person's own (first) email stays.
		expect((await contactOf(tenant, corrected.contactId)).email).toBe('pedro@exmaple.com');
		expect(await resendEvents(tenant, untouched.id)).toEqual([]);

		const [change] = await auditRows(tenant, corrected.id, 'order.email_corrected');
		expect(change).toMatchObject({ actorType: 'admin', targetType: 'order', metadata: { from: 'pe***@exmaple.com', to: 'pe***@example.com', contactEmailUpdated: false } });
		const [sent] = await auditRows(tenant, corrected.id, 'order.purchase_resent');
		expect(sent!.metadata).toMatchObject({ to: 'pe***@example.com', emailCorrected: true });
		for (const row of [change!, sent!]) expect(JSON.stringify(row.metadata)).not.toMatch(/pedro@/);
	});

	it("moves the person's own email too when the mistyped one was used only on this order, and Consultar works for the new one", async () => {
		const order = await paidOrder(tenant, '30500500', 'juana@exmaple.com');
		expect((await contactOf(tenant, order.contactId)).email).toBe('juana@exmaple.com');
		const response = await resend(order.id, await adminHeaders(ctx, tenant), { email: 'juana@example.com' });
		expect(response.statusCode).toBe(200);

		expect((await contactOf(tenant, order.contactId)).email).toBe('juana@example.com');
		const [change] = await auditRows(tenant, order.id, 'order.email_corrected');
		expect(change!.metadata).toMatchObject({ contactEmailUpdated: true });

		// The mistyped address gets no Consultar code any more; the corrected one opens the purchase.
		const { challengeId, codes } = await lookupCodes('30500500');
		expect(Object.keys(codes)).toEqual(['juana@example.com']);
		expect(await lookupReferences(challengeId, codes['juana@example.com']!)).toEqual([order.reference]);
	});

	it('keeps Consultar per email when the person keeps other purchases with the old email', async () => {
		const first = await paidOrder(tenant, '30600600', 'ana@exmaple.com');
		const second = await paidOrder(tenant, '30600600', 'ana@exmaple.com');
		expect((await resend(first.id, await adminHeaders(ctx, tenant), { email: 'ana@example.com' })).statusCode).toBe(200);

		const { challengeId, codes } = await lookupCodes('30600600');
		expect(Object.keys(codes).sort()).toEqual(['ana@example.com', 'ana@exmaple.com']);
		// The corrected email opens only the order made with it; the person's own email still opens both.
		expect(await lookupReferences(challengeId, codes['ana@example.com']!)).toEqual([first.reference]);
		const again = await lookupCodes('30600600');
		expect(await lookupReferences(again.challengeId, again.codes['ana@exmaple.com']!)).toEqual([first.reference, second.reference].sort());
	});

	it('refuses an email the checkout would refuse, and changes nothing', async () => {
		const order = await paidOrder(tenant, '30700700', 'valida@example.com');
		for (const email of ['juana', 'juana@', `${'a'.repeat(160)}@example.com`]) {
			const response = await resend(order.id, await adminHeaders(ctx, tenant), { email });
			expect(response.statusCode, email).toBe(400);
			expect(response.json().error, email).toMatchObject({ code: 'invalid_email', message: 'Ingresá un email válido' });
		}
		expect(await resendEvents(tenant, order.id)).toEqual([]);
		expect((await orderByReference(ctx, tenant, order.reference)).buyer.email).toBe('valida@example.com');
		expect(await auditRows(tenant, order.id, 'order.purchase_resent')).toEqual([]);
	});
});

describe('which orders can be resent', () => {
	it('refuses an order that has no purchase email (not paid), in Spanish, and changes nothing', async () => {
		const placed = await placeOrder(ctx, tenant, buyer('30800800', 'pendiente@example.com'));
		const order = await orderByReference(ctx, tenant, placed.reference);
		const response = await resend(order.id, await adminHeaders(ctx, tenant), { email: 'otra@example.com' });
		expect(response.statusCode).toBe(409);
		expect(response.json().error).toEqual({ code: 'order_not_resendable', message: 'Esta compra no tiene un email de compra para reenviar: solo se reenvían las compras pagadas.' });
		expect((await orderByReference(ctx, tenant, order.reference)).buyer.email).toBe('pendiente@example.com');
		expect(await resendEvents(tenant, order.id)).toEqual([]);
	});

	it('refuses a refunded order', async () => {
		const placed = await placeOrder(ctx, tenant, buyer('30810810', 'reintegro@example.com'));
		const payment = ctx.simulator.pay(placed.checkoutId, 'approved');
		await ctx.app.inject(webhookRequest(tenant, payment.id));
		ctx.simulator.setStatus(payment.id, 'refunded');
		await ctx.app.inject(webhookRequest(tenant, payment.id));
		const order = await orderByReference(ctx, tenant, placed.reference);
		expect(order.status).toBe('refunded');
		const response = await resend(order.id, await adminHeaders(ctx, tenant));
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe('order_not_resendable');
	});

	it("answers 404 for another organization's order and changes nothing there", async () => {
		const foreign = await paidOrder(other, '30900900', 'ajena@example.com');
		const response = await resend(foreign.id, await adminHeaders(ctx, tenant), { email: 'robada@example.com' });
		expect(response.statusCode).toBe(404);
		expect((await orderByReference(ctx, other, foreign.reference)).buyer.email).toBe('ajena@example.com');
		expect(await resendEvents(other, foreign.id)).toEqual([]);
	});

	it('the detail tells the panel whether the order can be resent', async () => {
		const paid = await paidOrder(tenant, '31000000', 'detalle@example.com');
		const placed = await placeOrder(ctx, tenant, buyer('31000001', 'detalle2@example.com'));
		const pending = await orderByReference(ctx, tenant, placed.reference);
		const auth = await adminHeaders(ctx, tenant);
		const detail = async (id: string) => (await ctx.app.inject({ method: 'GET', url: `/admin/orders/${id}`, headers: auth })).json();
		expect((await detail(paid.id)).resendable).toBe(true);
		expect((await detail(pending.id)).resendable).toBe(false);
	});
});

describe('rate limit', () => {
	// The order row lock makes the count race-safe (independent verification of T3).
	it('two concurrent requests cannot both take the fifth resend', async () => {
		const order = await paidOrder(tenant, '31200120', 'carrera@example.com');
		const auth = await adminHeaders(ctx, tenant);
		for (let index = 0; index < 4; index++) expect((await resend(order.id, auth)).statusCode).toBe(200);
		const codes = (await Promise.all([resend(order.id, auth), resend(order.id, auth)])).map((response) => response.statusCode).sort();
		expect(codes).toEqual([200, 429]);
		expect(await resendEvents(tenant, order.id)).toHaveLength(5);
	});

	it('allows five resends per order in 24 hours, then 429 in Spanish without sending', async () => {
		const order = await paidOrder(tenant, '31100110', 'limite@example.com');
		const auth = await adminHeaders(ctx, tenant);
		const left: number[] = [];
		for (let index = 0; index < 5; index++) {
			const response = await resend(order.id, auth);
			expect(response.statusCode).toBe(200);
			left.push(response.json().resendsLeft);
		}
		expect(left).toEqual([4, 3, 2, 1, 0]);
		const refused = await resend(order.id, auth, { email: 'otro-limite@example.com' });
		expect(refused.statusCode).toBe(429);
		expect(refused.json().error).toEqual({ code: 'resend_limit', message: 'Ya reenviaste esta compra 5 veces en las últimas 24 horas. Probá de nuevo más tarde.' });
		expect(await resendEvents(tenant, order.id)).toHaveLength(5);
		expect((await orderByReference(ctx, tenant, order.reference)).buyer.email).toBe('limite@example.com');

		const saved = ctx.clock.now;
		ctx.clock.now = new Date(saved.getTime() + 24 * 3_600_000 + 60_000);
		try {
			expect((await resend(order.id, auth)).statusCode).toBe(200);
		} finally {
			ctx.clock.now = saved;
		}
	});
});
