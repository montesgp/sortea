import { count, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	checkoutBody,
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

let ctx: TestContext;
let tenant: TenantFixture;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'pay');
	await openCampaign(ctx, tenant);
});
afterAll(() => ctx.close());

async function rowCounts(orderId: string) {
	return ctx.db.withTenant(tenant.id, async (tx) => {
		const [payments] = await tx.select({ value: count() }).from(s.payments).where(eq(s.payments.orderId, orderId));
		const [entries] = await tx.select({ value: count() }).from(s.participationEntries).where(eq(s.participationEntries.orderId, orderId));
		const [ledger] = await tx.select({ value: count() }).from(s.entryLedgerEvents).where(eq(s.entryLedgerEvents.orderId, orderId));
		const outbox = await tx.select().from(s.outboxEvents).where(eq(s.outboxEvents.organizationId, tenant.id));
		return {
			payments: payments!.value,
			entries: entries!.value,
			ledger: ledger!.value,
			paidEvents: outbox.filter((event) => event.topic === 'order.paid' && event.payload.orderId === orderId).length
		};
	});
}

describe('checkout', () => {
	it('prices from the catalog and ignores amounts sent by the browser', async () => {
		const response = await ctx.app.inject({
			method: 'POST',
			url: '/checkout/orders',
			headers: headers(tenant),
			payload: {
				lines: [{ variantId: tenant.manualVariantId, quantity: 1, unitPriceMinor: 1 }],
				total: 1,
				buyer: { documentType: 'DNI', documentNumber: '22333444', firstName: 'A', lastName: 'B', email: 'a@example.com', province: 'Córdoba', city: 'Río Cuarto' },
				delivery: { method: 'digital' },
				consents: { terms: true, privacy: true, marketingEmail: false }
			}
		});
		expect(response.statusCode).toBe(201);
		expect(response.json().totalMinor).toBe(1_200_000);
	});

	it('requires the transactional consents and never pre-assumes marketing', async () => {
		const response = await ctx.app.inject({
			method: 'POST',
			url: '/checkout/orders',
			headers: headers(tenant),
			payload: {
				lines: [{ variantId: tenant.manualVariantId, quantity: 1 }],
				buyer: { documentType: 'DNI', documentNumber: '22333444', firstName: 'A', lastName: 'B', email: 'a@example.com', province: 'Córdoba', city: 'Río Cuarto' },
				delivery: { method: 'digital' },
				consents: { terms: true, privacy: false }
			}
		});
		expect(response.statusCode).toBe(400);
	});

	it('adds the shipping fee for physical items and asks for an address', async () => {
		const missingAddress = await ctx.app.inject({
			method: 'POST',
			url: '/checkout/orders',
			headers: headers(tenant),
			payload: {
				lines: [{ variantId: tenant.stickerVariantId, quantity: 1 }],
				buyer: { documentType: 'DNI', documentNumber: '22333444', firstName: 'A', lastName: 'B', email: 'a@example.com', province: 'Córdoba', city: 'Río Cuarto' },
				delivery: { method: 'shipping' },
				consents: { terms: true, privacy: true, marketingEmail: true }
			}
		});
		expect(missingAddress.statusCode).toBe(400);

		const quote = await ctx.app.inject({
			method: 'POST',
			url: '/checkout/quote',
			headers: headers(tenant),
			payload: { lines: [{ variantId: tenant.stickerVariantId, quantity: 1 }], deliveryMethod: 'shipping' }
		});
		expect(quote.json().totalMinor).toBe(350_000 + 500_000);
	});

	it('S7: stores the buyer province and city with the order, and the receipt check does not echo them', async () => {
		const order = await placeOrder(ctx, tenant);
		const row = await orderByReference(ctx, tenant, order.reference);
		expect(row.buyer).toMatchObject({ province: 'Córdoba', city: 'Río Cuarto' });

		const status = await ctx.app.inject({ method: 'POST', url: '/checkout/orders/status', headers: headers(tenant), payload: { reference: order.reference, accessCode: order.accessCode } });
		expect(status.statusCode).toBe(200);
		expect(status.body).not.toMatch(/Córdoba|Río Cuarto/);
	});

	it('S7: a checkout without a valid province or city is rejected and creates no order', async () => {
		const before = await orderCount();
		const valid = checkoutBody(tenant).buyer as Record<string, unknown>;
		const { province: _province, city: _city, ...withoutLocation } = valid;
		for (const buyer of [withoutLocation, { ...valid, province: 'X' }, { ...valid, city: ' ' }, { ...valid, city: 'x'.repeat(81) }]) {
			const response = await ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant, { buyer }) });
			expect(response.statusCode).toBe(400);
		}
		expect(await orderCount()).toBe(before);
	});

	it('S7: shipping to another city or province than the buyer is rejected and creates no order', async () => {
		const before = await orderCount();
		for (const location of [{ city: 'Rosario', province: 'Santa Fe' }, { city: 'Río Cuarto', province: 'Mendoza' }, { city: 'Rosario', province: 'Córdoba' }]) {
			const address = { street: 'Av. Siempreviva 742', postalCode: '5800', ...location };
			const response = await ctx.app.inject({
				method: 'POST',
				url: '/checkout/orders',
				headers: headers(tenant),
				payload: checkoutBody(tenant, { lines: [{ variantId: tenant.stickerVariantId, quantity: 1 }], delivery: { method: 'shipping', address } })
			});
			expect(response.statusCode, JSON.stringify(location)).toBe(400);
		}
		expect(await orderCount()).toBe(before);
	});

	it('shipping still stores street, postal code, city and province as the delivery address', async () => {
		const address = { street: 'Av. Siempreviva 742', city: 'Río Cuarto', province: 'Córdoba', postalCode: '5800' };
		const order = await placeOrder(ctx, tenant, { lines: [{ variantId: tenant.stickerVariantId, quantity: 1 }], delivery: { method: 'shipping', address } });
		const row = await orderByReference(ctx, tenant, order.reference);
		expect(row.deliveryMethod).toBe('shipping');
		expect(row.deliveryAddress).toEqual(address);
		expect(row.totalMinor).toBe(350_000 + 500_000);
	});
});

async function orderCount() {
	const [row] = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ value: count() }).from(s.orders));
	return row!.value;
}

describe('payment confirmation', () => {
	it('AC-01: ten duplicate webhooks confirm the order exactly once', async () => {
		const order = await placeOrder(ctx, tenant);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		const responses = await Promise.all(Array.from({ length: 10 }, () => ctx.app.inject(webhookRequest(tenant, payment.id))));
		expect(responses.map((response) => response.statusCode)).toEqual(Array(10).fill(200));

		const row = await orderByReference(ctx, tenant, order.reference);
		expect(row.status).toBe('paid');
		expect(await rowCounts(row.id)).toEqual({ payments: 1, entries: 2, ledger: 2, paidEvents: 1 });
	});

	it('AC-03: the browser return alone does not confirm anything', async () => {
		const order = await placeOrder(ctx, tenant);
		const status = await ctx.app.inject({
			method: 'POST',
			url: '/checkout/orders/status',
			headers: headers(tenant),
			payload: { reference: order.reference, accessCode: order.accessCode }
		});
		expect(status.json().status).toBe('pending_payment');
		// A payment that exists only in a crafted webhook body is ignored: the API re-reads the provider.
		const forged = await ctx.app.inject(webhookRequest(tenant, '123456789'));
		expect(forged.statusCode).toBe(200);
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('pending_payment');
	});

	it('rejects notifications with an invalid signature without touching the order', async () => {
		const order = await placeOrder(ctx, tenant);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		const response = await ctx.app.inject(webhookRequest(tenant, payment.id, 'wrong-secret'));
		expect(response.statusCode).toBe(401);
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('pending_payment');
		const events = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.paymentEvents).where(eq(s.paymentEvents.providerPaymentId, payment.id)));
		expect(events.map((event) => [event.signatureValid, event.outcome])).toEqual([[false, 'rejected_signature']]);
	});

	it('does not confirm a payment whose amount differs from the order', async () => {
		const order = await placeOrder(ctx, tenant);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		ctx.simulator.payments.set(payment.id, { ...ctx.simulator.payments.get(payment.id)!, amountMinor: 100 });
		await ctx.app.inject(webhookRequest(tenant, payment.id));
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('pending_payment');
	});

	it('a rejected payment can be followed by an approved retry', async () => {
		const order = await placeOrder(ctx, tenant);
		const rejected = ctx.simulator.pay(order.preferenceId, 'rejected');
		await ctx.app.inject(webhookRequest(tenant, rejected.id));
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('payment_failed');
		const approved = ctx.simulator.pay(order.preferenceId, 'approved');
		await ctx.app.inject(webhookRequest(tenant, approved.id));
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('paid');
	});

	it('a refund voids participations through the ledger without deleting them', async () => {
		const order = await placeOrder(ctx, tenant);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		await ctx.app.inject(webhookRequest(tenant, payment.id));
		ctx.simulator.setStatus(payment.id, 'refunded');
		await ctx.app.inject(webhookRequest(tenant, payment.id));

		const row = await orderByReference(ctx, tenant, order.reference);
		expect(row.status).toBe('refunded');
		const entries = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.participationEntries).where(eq(s.participationEntries.orderId, row.id)));
		expect(entries.map((entry) => entry.status)).toEqual(['void', 'void']);
		const ledger = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.entryLedgerEvents).where(eq(s.entryLedgerEvents.orderId, row.id)));
		expect(ledger.map((event) => event.event).sort()).toEqual(['allocated', 'allocated', 'voided', 'voided']);
	});

	it('creates no participations for purchases while the campaign is not open', async () => {
		const other = await createTenant(ctx, 'closedgate');
		const order = await placeOrder(ctx, other);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		await ctx.app.inject(webhookRequest(other, payment.id));
		const row = await orderByReference(ctx, other, order.reference);
		expect(row.status).toBe('paid');
		const entries = await ctx.db.withTenant(other.id, (tx) => tx.select().from(s.participationEntries));
		expect(entries).toEqual([]);
	});

	it('decrements tracked stock once', async () => {
		const order = await placeOrder(ctx, tenant, {
			lines: [{ variantId: tenant.stickerVariantId, quantity: 1 }],
			delivery: { method: 'pickup' }
		});
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		await Promise.all([ctx.app.inject(webhookRequest(tenant, payment.id)), ctx.app.inject(webhookRequest(tenant, payment.id))]);
		const [variant] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.productVariants).where(eq(s.productVariants.id, tenant.stickerVariantId)));
		expect(variant!.stock).toBe(1);
	});
});
