import { and, asc, count, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../src/payments/provider';
import {
	adminHeaders,
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

/**
 * The coupon pool (ADR 0014 §1, S1/S5): coupons 0 … 10^digits − 1 allocated in
 * order, pending orders reserve what the cart quoted, checkout refuses carts that
 * do not fit, and a payment that confirms with no room left is flagged for refund.
 */
let ctx: TestContext;
const start = new Date('2026-10-25T15:00:00Z');

beforeAll(async () => {
	ctx = await createTestContext();
});
beforeEach(() => {
	ctx.clock.now = start;
});
afterAll(() => ctx.close());

let tenantCount = 0;
/** An open campaign whose pool holds 10^digits coupons. */
async function poolTenant(digits?: number): Promise<TenantFixture> {
	const tenant = await createTenant(ctx, `pool${++tenantCount}`);
	await openCampaign(ctx, tenant);
	if (digits !== undefined) {
		await ctx.db.withTenant(tenant.id, (tx) => tx.update(s.campaigns).set({ entryDigits: digits }).where(eq(s.campaigns.id, tenant.campaignId)));
	}
	return tenant;
}

let buyer = 0;
/** A different buyer each time, so nothing depends on identity caps. */
function newBuyer() {
	buyer++;
	return { documentType: 'DNI', documentNumber: `4000${String(buyer).padStart(4, '0')}`, firstName: 'B', lastName: 'C', email: `b${buyer}@example.com`, province: 'Córdoba', city: 'Río Cuarto' };
}

function order(tenant: TenantFixture, quantity: number) {
	return placeOrder(ctx, tenant, { lines: [{ variantId: tenant.manualVariantId, quantity }], buyer: newBuyer() });
}

/** Like `order`, but returns the response instead of throwing on a refusal. */
function tryOrder(tenant: TenantFixture, quantity: number) {
	return ctx.app.inject({
		method: 'POST',
		url: '/checkout/orders',
		headers: headers(tenant),
		payload: checkoutBody(tenant, { lines: [{ variantId: tenant.manualVariantId, quantity }], buyer: newBuyer() })
	});
}

const preferenceOf = (response: { json(): { redirectUrl: string } }) => new URL(response.json().redirectUrl).searchParams.get('pref')!;

async function pay(tenant: TenantFixture, preferenceId: string) {
	const payment = ctx.simulator.pay(preferenceId, 'approved');
	await ctx.app.inject(webhookRequest(tenant, payment.id));
	return payment;
}

async function quote(tenant: TenantFixture, quantity: number) {
	const response = await ctx.app.inject({
		method: 'POST',
		url: '/checkout/quote',
		headers: headers(tenant),
		payload: { lines: [{ variantId: tenant.manualVariantId, quantity }], campaignSlug: tenant.campaignSlug }
	});
	expect(response.statusCode).toBe(200);
	return response.json();
}

async function numbersOf(tenant: TenantFixture, reference: string) {
	const placed = await orderByReference(ctx, tenant, reference);
	const rows = await ctx.db.withTenant(tenant.id, (tx) =>
		tx.select({ number: s.participationEntries.entryNumber }).from(s.participationEntries).where(eq(s.participationEntries.orderId, placed.id)).orderBy(asc(s.participationEntries.entryNumber))
	);
	return rows.map((row) => row.number);
}

async function campaignOf(tenant: TenantFixture) {
	const [campaign] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.campaigns).where(eq(s.campaigns.id, tenant.campaignId)));
	return campaign!;
}

describe('allocation', () => {
	it('starts new campaigns at 0000 and pads numbers to the campaign digits', async () => {
		const tenant = await poolTenant();
		expect((await campaignOf(tenant)).entryDigits).toBe(4);
		const first = await order(tenant, 2);
		await pay(tenant, first.preferenceId);
		expect(await numbersOf(tenant, first.reference)).toEqual([0, 1]);

		const status = await ctx.app.inject({
			method: 'POST',
			url: '/checkout/orders/status',
			headers: headers(tenant),
			payload: { reference: first.reference, accessCode: first.accessCode }
		});
		expect(status.json()).toMatchObject({ entries: [0, 1], entryDigits: 4 });

		// Every surface that lists coupons carries the digits to pad them with.
		const auth = await adminHeaders(ctx, tenant);
		const placed = await orderByReference(ctx, tenant, first.reference);
		const detail = (await ctx.app.inject({ method: 'GET', url: `/admin/orders/${placed.id}`, headers: auth })).json();
		expect(detail).toMatchObject({ entries: [{ number: 0 }, { number: 1 }], entryDigits: 4 });
		const awards = (await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${tenant.campaignId}/awards`, headers: auth })).json();
		expect(awards.campaign.entryDigits).toBe(4);
		const transparency = (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}/transparency`, headers: headers(tenant) })).json();
		expect(transparency.entryDigits).toBe(4);
	});

	it('never allocates a number outside the pool: the last coupon is 10^digits − 1', async () => {
		const tenant = await poolTenant(1);
		const a = await order(tenant, 5);
		const b = await order(tenant, 5);
		await pay(tenant, a.preferenceId);
		await pay(tenant, b.preferenceId);
		expect([...(await numbersOf(tenant, a.reference)), ...(await numbersOf(tenant, b.reference))]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect((await campaignOf(tenant)).nextEntryNumber).toBe(10);
	});
});

describe('capacity and reservations', () => {
	it('the quote reports what remains: pool minus allocated minus unexpired reservations', async () => {
		const tenant = await poolTenant(1);
		expect((await quote(tenant, 1)).chances).toMatchObject({ total: 1, remaining: 10 });

		const pending = await order(tenant, 4);
		expect((await orderByReference(ctx, tenant, pending.reference)).reservedEntries).toBe(4);
		expect((await quote(tenant, 1)).chances.remaining).toBe(6);

		const paid = await order(tenant, 3);
		await pay(tenant, paid.preferenceId);
		expect((await quote(tenant, 1)).chances.remaining).toBe(3);

		// An expired pending order frees its reservation.
		ctx.clock.now = new Date(start.getTime() + 61 * 60_000);
		expect((await quote(tenant, 1)).chances.remaining).toBe(7);
	});

	it('refuses with 409 pool_exhausted a cart asking for more chances than remain, leaving nothing behind', async () => {
		const tenant = await poolTenant(1);
		await order(tenant, 4);
		await order(tenant, 4);
		const before = await ctx.db.withTenant(tenant.id, async (tx) => ({
			orders: (await tx.select({ value: count() }).from(s.orders))[0]!.value,
			contacts: (await tx.select({ value: count() }).from(s.contacts))[0]!.value,
			stock: (await tx.select({ stock: s.productVariants.stock }).from(s.productVariants).where(eq(s.productVariants.id, tenant.stickerVariantId)))[0]!.stock
		}));

		const refused = await ctx.app.inject({
			method: 'POST',
			url: '/checkout/orders',
			headers: headers(tenant),
			payload: checkoutBody(tenant, {
				lines: [
					{ variantId: tenant.manualVariantId, quantity: 3 },
					{ variantId: tenant.stickerVariantId, quantity: 1 }
				],
				buyer: { documentType: 'DNI', documentNumber: '41999888', firstName: 'N', lastName: 'O', email: 'n@example.com', province: 'Córdoba', city: 'Río Cuarto' },
				delivery: { method: 'pickup' }
			})
		});
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({
			code: 'pool_exhausted',
			message: 'Quedan 2 cupones para Moto 0 km y tu carrito suma 3 chances. Quitá algunos productos para continuar'
		});

		const after = await ctx.db.withTenant(tenant.id, async (tx) => ({
			orders: (await tx.select({ value: count() }).from(s.orders))[0]!.value,
			contacts: (await tx.select({ value: count() }).from(s.contacts))[0]!.value,
			stock: (await tx.select({ stock: s.productVariants.stock }).from(s.productVariants).where(eq(s.productVariants.id, tenant.stickerVariantId)))[0]!.stock
		}));
		expect(after).toEqual(before);
		expect((await campaignOf(tenant)).nextEntryNumber).toBe(0);

		// What fits is still accepted.
		await order(tenant, 2);
		expect((await quote(tenant, 1)).chances.remaining).toBe(0);
	});

	it('a rejected payment keeps its reservation while the order can still be approved', async () => {
		const tenant = await poolTenant(1);
		const rejected = await order(tenant, 5);
		const attempt = ctx.simulator.pay(rejected.preferenceId, 'rejected');
		await ctx.app.inject(webhookRequest(tenant, attempt.id));
		expect((await orderByReference(ctx, tenant, rejected.reference)).status).toBe('payment_failed');
		expect((await quote(tenant, 1)).chances.remaining).toBe(5);

		const b = await tryOrder(tenant, 5);
		expect(b.statusCode).toBe(201);
		const c = await tryOrder(tenant, 5);
		expect(c.statusCode).toBe(409);
		expect(c.json().error.code).toBe('pool_exhausted');

		// The buyer retries within the TTL and gets the coupons the order reserved.
		await pay(tenant, rejected.preferenceId);
		expect(await numbersOf(tenant, rejected.reference)).toEqual([0, 1, 2, 3, 4]);
		await pay(tenant, preferenceOf(b));
		expect(await numbersOf(tenant, b.json().reference)).toEqual([5, 6, 7, 8, 9]);
	});

	it('an order whose payment could not be started releases its reservation', async () => {
		const tenant = await poolTenant(1);
		const createPreference = ctx.simulator.createPreference;
		ctx.simulator.createPreference = async () => {
			throw new ProviderError('unavailable', 503);
		};
		try {
			const failed = await tryOrder(tenant, 5);
			expect(failed.statusCode).toBe(502);
			expect(failed.json().error.code).toBe('payment_provider_error');
		} finally {
			ctx.simulator.createPreference = createPreference;
		}
		const [stored] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.orders).where(eq(s.orders.campaignId, tenant.campaignId)));
		expect(stored).toMatchObject({ status: 'pending_payment', reservedEntries: 0 });
		expect((await quote(tenant, 1)).chances.remaining).toBe(10);
	});

	it('concurrent checkouts never reserve more than the pool, and their numbers stay inside it', async () => {
		const tenant = await poolTenant(1);
		const responses = await Promise.all(Array.from({ length: 7 }, () => tryOrder(tenant, 2)));
		const accepted = responses.filter((response) => response.statusCode === 201);
		const refused = responses.filter((response) => response.statusCode === 409);
		expect(accepted).toHaveLength(5);
		expect(refused).toHaveLength(2);
		expect(refused.every((response) => response.json().error.code === 'pool_exhausted')).toBe(true);

		for (const response of accepted) await pay(tenant, preferenceOf(response));
		const numbers = (await Promise.all(accepted.map((response) => numbersOf(tenant, response.json().reference)))).flat().sort((a, b) => a - b);
		expect(numbers).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});
});

describe('a payment that confirms with no room left', () => {
	it('keeps the purchase, allocates nothing, audits it and raises a critical refund item', async () => {
		const tenant = await poolTenant(1);
		const late = await order(tenant, 5);
		// Its reservation expires; two other orders take the whole pool.
		ctx.clock.now = new Date(start.getTime() + 61 * 60_000);
		const b = await order(tenant, 5);
		const c = await order(tenant, 5);

		const payment = await pay(tenant, late.preferenceId);
		const placed = await orderByReference(ctx, tenant, late.reference);
		expect(placed.status).toBe('paid');
		expect(await numbersOf(tenant, late.reference)).toEqual([]);
		expect((await campaignOf(tenant)).nextEntryNumber).toBe(0);

		const [audit] = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.action, 'entries.pool_exhausted'), eq(s.auditEvents.targetId, placed.id)))
		);
		expect(audit?.metadata).toMatchObject({ requested: 5, remaining: 0 });
		const items = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.reconciliationItems).where(eq(s.reconciliationItems.orderId, placed.id)));
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			kind: 'pool_exhausted',
			severity: 'critical',
			status: 'open',
			orderReference: late.reference,
			providerPaymentId: payment.id,
			expected: { entries: 5 },
			observed: { remaining: 0 }
		});

		// A repeated webhook raises nothing new; the reserved orders still get their coupons.
		await ctx.app.inject(webhookRequest(tenant, payment.id));
		expect(await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.reconciliationItems).where(eq(s.reconciliationItems.orderId, placed.id)))).toHaveLength(1);
		await pay(tenant, b.preferenceId);
		await pay(tenant, c.preferenceId);
		expect(await numbersOf(tenant, b.reference)).toEqual([0, 1, 2, 3, 4]);
		expect(await numbersOf(tenant, c.reference)).toEqual([5, 6, 7, 8, 9]);
	});

	it('concurrent duplicate webhooks raise one item and one audit', async () => {
		const tenant = await poolTenant(1);
		const late = await order(tenant, 5);
		ctx.clock.now = new Date(start.getTime() + 61 * 60_000);
		await order(tenant, 5);
		await order(tenant, 5);

		const payment = ctx.simulator.pay(late.preferenceId, 'approved');
		await Promise.all(Array.from({ length: 5 }, () => ctx.app.inject(webhookRequest(tenant, payment.id))));
		const placed = await orderByReference(ctx, tenant, late.reference);
		const items = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.reconciliationItems).where(eq(s.reconciliationItems.orderId, placed.id)));
		expect(items).toHaveLength(1);
		const audits = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.action, 'entries.pool_exhausted'), eq(s.auditEvents.targetId, placed.id)))
		);
		expect(audits).toHaveLength(1);
	});
});

describe('a sold-out campaign', () => {
	it('promises no chances and says the coupons are sold out; products without chances still sell', async () => {
		const tenant = await poolTenant(1);
		await pay(tenant, (await order(tenant, 5)).preferenceId);
		const open = (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}`, headers: headers(tenant) })).json();
		expect(open).toMatchObject({ soldOut: false, couponsRemaining: 5, entryDigits: 1 });
		await pay(tenant, (await order(tenant, 5)).preferenceId);

		const products = (await ctx.app.inject({ method: 'GET', url: '/public/products', headers: headers(tenant) })).json();
		expect(products.chances).toBeNull();
		const campaign = (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}`, headers: headers(tenant) })).json();
		expect(campaign).toMatchObject({ soldOut: true, couponsRemaining: 0, chancesPerUnit: {}, qualifyingVariants: [] });
		expect((await quote(tenant, 1)).chances).toMatchObject({ total: 1, remaining: 0 });

		const refused = await ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant) });
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({
			code: 'pool_exhausted',
			message: 'Se agotaron los cupones de Moto 0 km. Quitá los productos que dan chances para continuar'
		});
		await placeOrder(ctx, tenant, { lines: [{ variantId: tenant.stickerVariantId, quantity: 1 }], delivery: { method: 'pickup' } });
	});
});
