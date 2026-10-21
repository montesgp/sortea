import { eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * Local compliance demo mode (ADR 0013): a campaign marked as demo can be
 * rehearsed end to end while its approvals are pending. Approvals are never
 * written, a rejection still closes the gate, and nothing changes without the
 * mode or for a campaign that is not a demo.
 */
let demo: TestContext;
let normal: TestContext;

beforeAll(async () => {
	demo = await createTestContext({ complianceDemo: true });
	normal = await createTestContext();
});
afterAll(async () => {
	await demo.close();
	await normal.close();
});

async function markDemo(ctx: TestContext, tenant: TenantFixture) {
	await ctx.db.withTenant(tenant.id, (tx) => tx.update(s.campaigns).set({ isDemo: true }).where(eq(s.campaigns.id, tenant.campaignId)));
}

async function approvals(ctx: TestContext, tenant: TenantFixture) {
	const rows = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.campaignApprovals).where(eq(s.campaignApprovals.campaignId, tenant.campaignId)));
	return rows.map((row) => [row.kind, row.status, row.reference, row.decidedAt]).sort();
}

const open = async (ctx: TestContext, tenant: TenantFixture) =>
	ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/transition`, headers: await adminHeaders(ctx, tenant), payload: { to: 'open' } });

const site = async (ctx: TestContext, tenant: TenantFixture) => (await ctx.app.inject({ method: 'GET', url: '/public/site', headers: headers(tenant) })).json();

describe('with the demo mode on (S2, S4)', () => {
	let tenant: TenantFixture;
	beforeAll(async () => {
		tenant = await createTenant(demo, 'demo-on');
		await markDemo(demo, tenant);
	});

	it('a demo campaign opens with pending approvals, and the approvals stay pending', async () => {
		const response = await open(demo, tenant);
		expect(response.statusCode).toBe(200);
		expect(response.json().status).toBe('open');
		expect(response.json().gate).toEqual({ allowed: true, missing: ['legal', 'psp'], rejected: [], demo: true });
		expect(await approvals(demo, tenant)).toEqual([
			['legal', 'pending', null, null],
			['psp', 'pending', null, null]
		]);
	});

	it('the shop shows its chances and the campaign accepts participations', async () => {
		const products = (await demo.app.inject({ method: 'GET', url: '/public/products', headers: headers(tenant) })).json();
		expect(products.chances).toEqual({ campaign: { slug: tenant.campaignSlug, title: 'Moto 0 km' }, perUnit: { [tenant.manualVariantId]: 1 }, maxPerIdentity: null });
		const campaign = (await demo.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}`, headers: headers(tenant) })).json();
		expect(campaign.acceptingParticipations).toBe(true);
		expect(campaign.compliance.allowed).toBe(true);
		expect(campaign.compliance.demo).toBe(true);
		expect(campaign.compliance.approvals.map((approval: { status: string }) => approval.status)).toEqual(['pending', 'pending']);
	});

	it('a simulated purchase allocates numbered chances', async () => {
		const order = await placeOrder(demo, tenant);
		const payment = demo.simulator.pay(order.preferenceId, 'approved');
		await demo.app.inject(webhookRequest(tenant, payment.id));
		const status = (
			await demo.app.inject({ method: 'POST', url: '/checkout/orders/status', headers: headers(tenant), payload: { reference: order.reference, accessCode: order.accessCode } })
		).json();
		expect(status.status).toBe('paid');
		expect(status.entries).toHaveLength(2);
	});

	it('every public page can say the site is a demo', async () => {
		expect((await site(demo, tenant)).complianceDemo).toBe(true);
	});
});

describe('the demo mode does not reach other campaigns (S2, S3)', () => {
	it('a campaign that is not a demo still cannot open without approvals', async () => {
		const tenant = await createTenant(demo, 'demo-not-marked');
		const response = await open(demo, tenant);
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe('compliance_gate_closed');
		expect(response.json().error.details.missing).toEqual(['legal', 'psp']);
	});

	it('a rejected approval still closes a demo campaign', async () => {
		const tenant = await createTenant(demo, 'demo-rejected');
		await markDemo(demo, tenant);
		const rejected = await demo.app.inject({
			method: 'PUT',
			url: `/admin/campaigns/${tenant.campaignId}/approvals/psp`,
			headers: await adminHeaders(demo, tenant),
			payload: { status: 'rejected', reference: 'EXP-psp-1', authority: 'Mercado Pago' }
		});
		expect(rejected.statusCode).toBe(200);
		const response = await open(demo, tenant);
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe('compliance_gate_closed');
	});
});

describe('with the demo mode off (S3)', () => {
	let tenant: TenantFixture;
	beforeAll(async () => {
		tenant = await createTenant(normal, 'demo-off');
		await markDemo(normal, tenant);
	});

	it('AC-12: a demo campaign cannot open without approvals', async () => {
		const response = await open(normal, tenant);
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe('compliance_gate_closed');
		expect(response.json().error.details.missing).toEqual(['legal', 'psp']);
	});

	it('the shop promises no chances and the site is not a demo', async () => {
		const products = (await normal.app.inject({ method: 'GET', url: '/public/products', headers: headers(tenant) })).json();
		expect(products.chances).toBeNull();
		expect((await site(normal, tenant)).complianceDemo).toBe(false);
		const campaign = (await normal.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}`, headers: headers(tenant) })).json();
		expect(campaign.compliance).toMatchObject({ allowed: false, demo: false });
	});
});
