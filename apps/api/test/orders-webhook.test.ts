import { createHmac, randomUUID } from 'node:crypto';
import { eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
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

// Checkout Pro through the Orders API (odd/tasks/mercadopago-orders-api.md, S1, S2, S4).
// One Mercado Pago order per checkout; its id (ORD...) is the stored provider payment id.

let ctx: TestContext;
let tenant: TenantFixture;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'orders');
	await openCampaign(ctx, tenant);
});
afterAll(() => ctx.close());

const events = (orderId: string) => ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.paymentEvents).where(eq(s.paymentEvents.providerPaymentId, orderId)));
const paymentRows = (orderId: string) => ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.payments).where(eq(s.payments.orderId, orderId)));
const entriesOf = (orderId: string) =>
	ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.participationEntries).where(eq(s.participationEntries.orderId, orderId)));

describe('checkout creates a Mercado Pago order (S1)', () => {
	it('sends the order rules to Mercado Pago with the order account and keeps the order id', async () => {
		const create = vi.spyOn(ctx.simulator, 'createCheckout');
		let placed;
		let calls;
		try {
			placed = await placeOrder(ctx, tenant);
			calls = [...create.mock.calls];
		} finally {
			create.mockRestore();
		}
		const stored = await orderByReference(ctx, tenant, placed.reference);
		expect(placed.checkoutId).toMatch(/^ORD[0-9A-Z]+$/);
		expect(stored.providerCheckoutId).toBe(placed.checkoutId);
		expect(calls).toHaveLength(1);
		const [, request] = calls[0]!;
		expect(request).toMatchObject({
			orderReference: placed.reference,
			idempotencyKey: stored.id,
			// The fixture account is a sandbox account: the adapter will leave the real buyer out.
			sandbox: true,
			payer: { email: 'juana@example.com', firstName: 'Juana', lastName: 'Pérez', documentType: 'DNI', documentNumber: '30123456' },
			expiresAt: stored.expiresAt,
			statementDescriptor: 'orders'
		});
		expect(request.items.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0)).toBe(stored.totalMinor);
		expect(request.returnUrls.success).toContain(`/checkout/resultado?ref=${placed.reference}`);
		expect(new URL(placed.redirectUrl).pathname).toBe('/pago-simulado');
	});
});

describe('order notifications (S2)', () => {
	it('an order notification confirms the order from the order read with its account', async () => {
		const order = await placeOrder(ctx, tenant);
		const paid = ctx.simulator.pay(order.checkoutId, 'approved');
		expect(paid.id).toBe(order.checkoutId);
		const response = await ctx.app.inject(webhookRequest(tenant, order.checkoutId));
		expect(response.statusCode).toBe(200);

		const stored = await orderByReference(ctx, tenant, order.reference);
		expect(stored.status).toBe('paid');
		expect((await paymentRows(stored.id)).map((row) => [row.providerPaymentId, row.status, row.statusDetail])).toEqual([[order.checkoutId, 'approved', 'accredited']]);
		expect((await entriesOf(stored.id)).map((entry) => entry.status)).toEqual(['eligible', 'eligible']);
		expect((await events(order.checkoutId)).map((event) => [event.topic, event.outcome, event.signatureValid])).toEqual([['order', 'paid', true]]);
	});

	it('validates the signature over the order id lowercased, as Mercado Pago signs it', async () => {
		const order = await placeOrder(ctx, tenant);
		ctx.simulator.pay(order.checkoutId, 'approved');
		const sign = (id: string, requestId: string) =>
			createHmac('sha256', tenant.webhookSecret).update(`id:${id};request-id:${requestId};ts:1793000000;`).digest('hex');
		const notify = (v1: string, requestId: string) =>
			ctx.app.inject({
				method: 'POST',
				url: `/webhooks/mercadopago/${tenant.id}?data.id=${order.checkoutId}&type=order`,
				headers: { 'x-signature': `ts=1793000000,v1=${v1}`, 'x-request-id': requestId },
				payload: { action: 'order.processed', type: 'order', data: { id: order.checkoutId } }
			});

		const upper = randomUUID();
		expect((await notify(sign(order.checkoutId, upper), upper)).statusCode).toBe(401);
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('pending_payment');

		const lower = randomUUID();
		expect((await notify(sign(order.checkoutId.toLowerCase(), lower), lower)).statusCode).toBe(200);
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('paid');
	});

	it('notifications of other topics answer 200 and change nothing, signed or not', async () => {
		const order = await placeOrder(ctx, tenant);
		ctx.simulator.pay(order.checkoutId, 'approved');
		const reads = vi.spyOn(ctx.simulator, 'getOrder');
		try {
			for (const request of [
				webhookRequest(tenant, order.checkoutId, tenant.webhookSecret, 'payment'),
				webhookRequest(tenant, order.checkoutId, tenant.webhookSecret, 'merchant_order'),
				webhookRequest(tenant, order.checkoutId, 'not-the-secret', 'payment')
			]) {
				const response = await ctx.app.inject(request);
				expect(response.statusCode).toBe(200);
				expect(response.json()).toEqual({ ok: true });
			}
			expect(reads).not.toHaveBeenCalled();
		} finally {
			reads.mockRestore();
		}
		const stored = await orderByReference(ctx, tenant, order.reference);
		expect(stored.status).toBe('pending_payment');
		expect(await paymentRows(stored.id)).toEqual([]);
		expect((await events(order.checkoutId)).map((event) => [event.topic, event.outcome, event.signatureValid])).toEqual([
			['payment', 'ignored_topic', true],
			['merchant_order', 'ignored_topic', true],
			['payment', 'ignored_topic', false]
		]);
	});

	it('the notification of an order nobody tried to pay yet records nothing', async () => {
		const order = await placeOrder(ctx, tenant);
		const response = await ctx.app.inject(webhookRequest(tenant, order.checkoutId));
		expect(response.statusCode).toBe(200);
		const stored = await orderByReference(ctx, tenant, order.reference);
		expect(stored.status).toBe('pending_payment');
		expect(await paymentRows(stored.id)).toEqual([]);
		expect((await events(order.checkoutId)).map((event) => event.outcome)).toEqual(['no_payment']);
	});

	it('refunded and charged-back orders void their coupons through the ledger', async () => {
		const [refunded, chargedBack] = [await placeOrder(ctx, tenant), await placeOrder(ctx, tenant)];
		for (const order of [refunded, chargedBack]) {
			ctx.simulator.pay(order.checkoutId, 'approved');
			expect((await ctx.app.inject(webhookRequest(tenant, order.checkoutId))).statusCode).toBe(200);
		}
		ctx.simulator.setStatus(refunded.checkoutId, 'refunded');
		ctx.simulator.setStatus(chargedBack.checkoutId, 'charged_back');
		for (const order of [refunded, chargedBack]) expect((await ctx.app.inject(webhookRequest(tenant, order.checkoutId))).statusCode).toBe(200);

		for (const [order, status, reason] of [
			[refunded, 'refunded', 'Pago reintegrado'],
			[chargedBack, 'charged_back', 'Contracargo del pago']
		] as const) {
			const stored = await orderByReference(ctx, tenant, order.reference);
			expect(stored.status).toBe(status);
			expect((await entriesOf(stored.id)).map((entry) => entry.status)).toEqual(['void', 'void']);
			const voided = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.entryLedgerEvents).where(eq(s.entryLedgerEvents.orderId, stored.id)));
			expect(voided.filter((event) => event.event === 'voided').map((event) => event.reason)).toEqual([reason, reason]);
			const [row] = await paymentRows(stored.id);
			expect(row).toMatchObject({ status, providerPaymentId: order.checkoutId });
			// The first approval time is kept when the order is refunded or charged back.
			expect(row!.approvedAt).not.toBeNull();
		}
	});

	it('an order of another seller never confirms', async () => {
		const order = await placeOrder(ctx, tenant);
		const paid = ctx.simulator.pay(order.checkoutId, 'approved');
		const read = vi.spyOn(ctx.simulator, 'getOrder').mockResolvedValue({ ...paid, collectorId: '999999999' });
		try {
			expect((await ctx.app.inject(webhookRequest(tenant, order.checkoutId))).statusCode).toBe(200);
		} finally {
			read.mockRestore();
		}
		const stored = await orderByReference(ctx, tenant, order.reference);
		expect(stored.status).toBe('pending_payment');
		expect(await paymentRows(stored.id)).toEqual([]);
		expect((await events(order.checkoutId)).map((event) => event.outcome)).toEqual(['merchant_mismatch']);
	});

	it('replays of the same order keep one payment row and a later refund still applies', async () => {
		const order = await placeOrder(ctx, tenant);
		ctx.simulator.pay(order.checkoutId, 'approved');
		for (let copy = 0; copy < 3; copy++) expect((await ctx.app.inject(webhookRequest(tenant, order.checkoutId))).statusCode).toBe(200);
		ctx.simulator.setStatus(order.checkoutId, 'refunded');
		expect((await ctx.app.inject(webhookRequest(tenant, order.checkoutId))).statusCode).toBe(200);

		const stored = await orderByReference(ctx, tenant, order.reference);
		expect(stored.status).toBe('refunded');
		expect((await paymentRows(stored.id)).map((row) => [row.providerPaymentId, row.status])).toEqual([[order.checkoutId, 'refunded']]);
		expect((await events(order.checkoutId)).map((event) => event.outcome)).toEqual(['paid', 'no_change', 'no_change', 'refunded']);
	});

	it('a payment id stored for one order never overwrites it nor confirms another order (T9)', async () => {
		const first = await placeOrder(ctx, tenant);
		ctx.simulator.pay(first.checkoutId, 'approved');
		expect((await ctx.app.inject(webhookRequest(tenant, first.checkoutId))).statusCode).toBe(200);
		const firstStored = await orderByReference(ctx, tenant, first.reference);
		const before = await paymentRows(firstStored.id);

		// The provider answers the first order's id with a paid read of the second order.
		const second = await placeOrder(ctx, tenant);
		const paidSecond = ctx.simulator.pay(second.checkoutId, 'approved');
		const read = vi.spyOn(ctx.simulator, 'getOrder').mockResolvedValue({ ...paidSecond, id: first.checkoutId, statusDetail: 'other_detail' });
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		let response;
		try {
			response = await ctx.app.inject(webhookRequest(tenant, first.checkoutId));
		} finally {
			read.mockRestore();
		}
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ ok: true });

		expect(await paymentRows(firstStored.id)).toEqual(before);
		expect((await orderByReference(ctx, tenant, first.reference)).status).toBe('paid');
		const secondStored = await orderByReference(ctx, tenant, second.reference);
		expect(secondStored.status).toBe('pending_payment');
		expect(await paymentRows(secondStored.id)).toEqual([]);
		expect(await entriesOf(secondStored.id)).toEqual([]);
		expect((await events(first.checkoutId)).map((event) => event.outcome)).toEqual(['paid', 'payment_order_mismatch']);
		const audits = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.targetId, secondStored.id)));
		expect(audits.filter((event) => event.action.startsWith('payment.') || event.action.startsWith('order.paid')).map((event) => [event.action, event.metadata])).toEqual([
			['payment.rejected_mismatch', { reason: 'payment_order_mismatch', providerPaymentId: first.checkoutId, storedOrderId: firstStored.id }]
		]);
	});

	it('the local simulator pays and refunds through order notifications signed with the order account', async () => {
		const order = await placeOrder(ctx, tenant);
		const page = await ctx.app.inject({ method: 'GET', url: `/dev/simulator/orders/${order.checkoutId}`, headers: headers(tenant) });
		expect(page.statusCode, page.body).toBe(200);
		expect(page.json()).toMatchObject({ id: order.checkoutId, reference: order.reference, totalMinor: order.totalMinor });

		const paid = await ctx.app.inject({ method: 'POST', url: '/dev/simulator/pay', headers: headers(tenant), payload: { orderId: order.checkoutId, outcome: 'approved' } });
		expect(paid.statusCode, paid.body).toBe(200);
		expect(paid.json()).toMatchObject({ orderId: order.checkoutId, webhookStatus: 200 });
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('paid');

		const refunded = await ctx.app.inject({ method: 'POST', url: '/dev/simulator/payment-status', headers: headers(tenant), payload: { reference: order.reference, status: 'refunded' } });
		expect(refunded.json()).toEqual({ webhookStatus: 200 });
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('refunded');
		expect((await events(order.checkoutId)).map((event) => [event.topic, event.outcome])).toEqual([
			['order', 'paid'],
			['order', 'refunded']
		]);
	});
});
