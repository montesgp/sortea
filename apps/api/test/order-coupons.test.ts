import { eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, openCampaign, orderByReference, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

// Owner feedback 2026-11-11b, S9: "agregar los números y cupón al pedido? No veo que se asignó".
// Every view of one order names its coupons and their campaign, not only the campaign summary.

let ctx: TestContext;
let tenant: TenantFixture;
let paid: Awaited<ReturnType<typeof placeOrder>>;
let pending: Awaited<ReturnType<typeof placeOrder>>;
let entryDigits: number;
let numbers: number[];

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'cupones');
	await openCampaign(ctx, tenant);
	paid = await placeOrder(ctx, tenant);
	await ctx.app.inject(webhookRequest(tenant, ctx.simulator.pay(paid.checkoutId, 'approved').id));
	pending = await placeOrder(ctx, tenant);
	const order = await orderByReference(ctx, tenant, paid.reference);
	const rows = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.participationEntries).where(eq(s.participationEntries.orderId, order.id)));
	numbers = rows.map((row) => row.entryNumber).sort((a, b) => a - b);
	const [campaign] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.campaigns).where(eq(s.campaigns.id, tenant.campaignId)));
	entryDigits = campaign!.entryDigits;
});
afterAll(() => ctx.close());

async function lookupWithReceipt(order: { reference: string; accessCode: string }) {
	const receipt = await ctx.app.inject({ method: 'POST', url: '/lookup/receipt', headers: headers(tenant), payload: { reference: order.reference, accessCode: order.accessCode } });
	const me = await ctx.app.inject({ method: 'GET', url: '/lookup/me', headers: headers(tenant, { 'x-lookup-token': receipt.json().token }) });
	return me.json().orders[0];
}

describe('coupons of an order (S9)', () => {
	it('the buyer lookup lists each order with its coupons and campaign', async () => {
		expect(numbers).toHaveLength(2);
		const order = await lookupWithReceipt(paid);
		expect(order.reference).toBe(paid.reference);
		expect(order.coupons).toEqual({ campaign: 'Moto 0 km', entryDigits, entries: numbers.map((number) => ({ number, status: 'eligible' })) });
	});

	it('an order still waiting for its payment has no coupons yet', async () => {
		const order = await lookupWithReceipt(pending);
		expect(order.status).toBe('pending_payment');
		expect(order.coupons).toBeNull();
	});

	it('the back-office order detail names the campaign of its coupons', async () => {
		const id = (await orderByReference(ctx, tenant, paid.reference)).id;
		const detail = (await ctx.app.inject({ method: 'GET', url: `/admin/orders/${id}`, headers: await adminHeaders(ctx, tenant) })).json();
		expect(detail.entries).toEqual(numbers.map((number) => ({ number, status: 'eligible' })));
		expect(detail.campaignTitle).toBe('Moto 0 km');
	});

	it('the result page status keeps returning the coupons, the campaign and the order date', async () => {
		const status = (await ctx.app.inject({ method: 'POST', url: '/checkout/orders/status', headers: headers(tenant), payload: { reference: paid.reference, accessCode: paid.accessCode } })).json();
		expect(status.entries).toEqual(numbers);
		expect(status.entryDigits).toBe(entryDigits);
		expect(status.chances).toEqual({ count: 2, campaign: 'Moto 0 km' });
		expect(typeof status.createdAt).toBe('string');
	});
});
