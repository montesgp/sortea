import { randomBytes } from 'node:crypto';
import { and, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMercadoPagoProvider } from '../src/payments/mercadopago';
import type { PaymentProvider } from '../src/payments/provider';
import { simulatorCollectorId, type PaymentSimulator } from '../src/payments/simulator';
import {
	adminHeaders,
	createTenant,
	createTestContext,
	enrolAuthenticator,
	headers,
	placeOrder,
	switchMercadoPago,
	webhookRequest,
	type Authenticator,
	type TenantFixture,
	type TestContext
} from './helpers';

/**
 * Owner decision 2026-11-07: the compliance demo mode (ADR 0013) also runs with
 * Mercado Pago test accounts, whose money is fictitious, and never with a
 * production account. Mercado Pago says which accounts are test users: GET
 * /users/me lists `test_user` among their tags.
 *
 * Orders and payments run on the simulator; the account check runs through the
 * real adapter over a fake fetch, so the tags are read as in production.
 */
const TEST_USER_TAGS = ['user_product_seller', 'test_user', 'normal'];
const SELLER_TAGS = ['user_product_seller', 'normal'];
const tags = new Map<string, string[]>();

function withUsersMe(simulator: PaymentSimulator): PaymentProvider {
	const usersMe = createMercadoPagoProvider((async (_input: string | URL | Request, init: RequestInit = {}) => {
		const token = String((init.headers as Record<string, string>).authorization).replace('Bearer ', '');
		// The simulator's merchant for the token, so its payments match the account.
		return Response.json({ id: simulatorCollectorId(token), nickname: 'TESTUSER', tags: tags.get(token) ?? [] });
	}) as typeof fetch);
	return { ...simulator, verifyAccount: usersMe.verifyAccount };
}

let ctx: TestContext;
let platform: Record<string, string>;
let authenticator: Authenticator;
const platformAdmin = '00000000-0000-4000-8000-00000000a0d7';
const WEBHOOK_SECRET = 'whsec-test-accounts-0123456789';

beforeAll(async () => {
	ctx = await createTestContext({ complianceDemo: true, payments: withUsersMe });
	await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: platformAdmin, email: 'test-accounts@test' }).onConflictDoNothing());
	platform = { 'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN, authorization: `Bearer ${await ctx.signAdmin(platformAdmin, 'test-accounts@test')}` };
	authenticator = await enrolAuthenticator(ctx, platformAdmin);
});
afterAll(() => ctx.close());

/** Credentials of a real Mercado Pago account, tagged by /users/me as a test user or not. */
function account(kind: 'test' | 'production'): string {
	const accessToken = `APP_USR-${randomBytes(16).toString('hex')}`;
	tags.set(accessToken, kind === 'test' ? TEST_USER_TAGS : SELLER_TAGS);
	return accessToken;
}

const integrationsUrl = (tenant: TenantFixture) => `/platform/organizations/${tenant.id}/integrations/mercadopago`;
const connect = (tenant: TenantFixture, accessToken: string) =>
	ctx.app.inject({ method: 'PUT', url: integrationsUrl(tenant), headers: platform, payload: { mode: 'production', accessToken, webhookSecret: WEBHOOK_SECRET } });
/** Switches to another account: connected as the backup, then made the principal with the admin's code. */
const switchTo = (tenant: TenantFixture, accessToken: string) =>
	switchMercadoPago(ctx, tenant, platform, authenticator, { mode: 'production', accessToken, webhookSecret: WEBHOOK_SECRET });
const reactivate = (tenant: TenantFixture, integrationId: string) =>
	ctx.app.inject({ method: 'POST', url: `${integrationsUrl(tenant)}/${integrationId}/activate`, headers: platform, payload: { code: authenticator.code() } });
const consoleAccounts = async (tenant: TenantFixture) =>
	(await ctx.app.inject({ method: 'GET', url: `/platform/organizations/${tenant.id}`, headers: platform })).json().integrations as {
		id: string;
		isActive: boolean;
		simulator: boolean;
		testUser: boolean;
	}[];
const activeAccount = async (tenant: TenantFixture) => (await consoleAccounts(tenant)).find((integration) => integration.isActive)!;

/** A tenant whose fixture campaign is a demo, connected to a real Mercado Pago account of the given kind. */
async function demoTenant(label: string, kind: 'test' | 'production'): Promise<TenantFixture> {
	const tenant = await createTenant(ctx, label, { mercadoPago: false });
	await ctx.db.withTenant(tenant.id, (tx) => tx.update(s.campaigns).set({ isDemo: true }).where(eq(s.campaigns.id, tenant.campaignId)));
	const connected = await connect(tenant, account(kind));
	expect(connected.statusCode).toBe(200);
	return { ...tenant, webhookSecret: WEBHOOK_SECRET };
}

const open = async (tenant: TenantFixture) =>
	ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/transition`, headers: await adminHeaders(ctx, tenant), payload: { to: 'open' } });
const adminCampaign = async (tenant: TenantFixture) =>
	(await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${tenant.campaignId}`, headers: await adminHeaders(ctx, tenant) })).json();
const shopChances = async (tenant: TenantFixture) => (await ctx.app.inject({ method: 'GET', url: '/public/products', headers: headers(tenant) })).json().chances;
const site = async (tenant: TenantFixture) => (await ctx.app.inject({ method: 'GET', url: '/public/site', headers: headers(tenant) })).json();
const publicCompliance = async (tenant: TenantFixture) =>
	(await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}`, headers: headers(tenant) })).json().compliance;

async function payAndConfirm(tenant: TenantFixture, order: { reference: string; accessCode: string; checkoutId: string }) {
	const payment = ctx.simulator.pay(order.checkoutId, 'approved');
	expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
	return (
		await ctx.app.inject({ method: 'POST', url: '/checkout/orders/status', headers: headers(tenant), payload: { reference: order.reference, accessCode: order.accessCode } })
	).json() as { status: string; entries: number[] };
}

const notAllocated = (tenant: TenantFixture) =>
	ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.organizationId, tenant.id), eq(s.auditEvents.action, 'entries.not_allocated'))));

describe('connecting records whether Mercado Pago reports a test user', () => {
	it('a test account is recorded and shown as a test account; a production account is not', async () => {
		const test = await demoTenant('mp-test-user', 'test');
		expect(await activeAccount(test)).toMatchObject({ simulator: false, testUser: true });
		const production = await demoTenant('mp-production-user', 'production');
		expect(await activeAccount(production)).toMatchObject({ simulator: false, testUser: false });
		const [row] = await ctx.db.withPlatform((db) =>
			db.select().from(s.organizationIntegrations).where(and(eq(s.organizationIntegrations.organizationId, test.id), eq(s.organizationIntegrations.isActive, true)))
		);
		expect(row!.publicConfig.testUser).toBe('true');
	});

	it('reactivating records what Mercado Pago says now', async () => {
		const tenant = await demoTenant('mp-reactivate-tags', 'test');
		const testAccount = await activeAccount(tenant);
		expect((await switchTo(tenant, account('production'))).statusCode).toBe(200);
		// Mercado Pago no longer reports the first account as a test user.
		const [row] = await ctx.db.withPlatform((db) => db.select().from(s.organizationIntegrations).where(eq(s.organizationIntegrations.id, testAccount.id)));
		const accessToken = [...tags.entries()].find(([token]) => simulatorCollectorId(token) === row!.publicConfig.collectorId)![0];
		tags.set(accessToken, SELLER_TAGS);
		expect((await reactivate(tenant, testAccount.id)).statusCode).toBe(200);
		expect(await activeAccount(tenant)).toMatchObject({ id: testAccount.id, testUser: false });
		expect((await open(tenant)).statusCode).toBe(409);
	});
});

describe('with a verified Mercado Pago test account the demo waiver applies', () => {
	let tenant: TenantFixture;
	beforeAll(async () => {
		tenant = await demoTenant('mp-test-waiver', 'test');
	});

	it('the demo campaign opens with pending approvals, said to run on Mercado Pago test payments', async () => {
		const response = await open(tenant);
		expect(response.statusCode).toBe(200);
		expect(response.json().gate).toEqual({ allowed: true, missing: ['legal', 'psp'], rejected: [], demo: true });
		expect(response.json().demoPayments).toBe('mercadopago_test');
		expect((await adminCampaign(tenant)).approvals.map((approval: { status: string }) => approval.status)).toEqual(['pending', 'pending']);
	});

	it('the shop shows its chances and every public page says it is a demo with test payments', async () => {
		expect(await shopChances(tenant)).toMatchObject({ campaign: { slug: tenant.campaignSlug } });
		expect(await site(tenant)).toMatchObject({ complianceDemo: true, demoPayments: 'mercadopago_test' });
		expect(await publicCompliance(tenant)).toMatchObject({ allowed: true, demo: true });
	});

	it('a test payment earns numbered chances', async () => {
		const status = await payAndConfirm(tenant, await placeOrder(ctx, tenant));
		expect(status.status).toBe('paid');
		expect(status.entries).toHaveLength(2);
	});
});

describe('with a production Mercado Pago account there is no waiver', () => {
	let tenant: TenantFixture;
	beforeAll(async () => {
		tenant = await demoTenant('mp-production-no-waiver', 'production');
	});

	it('AC-12: the demo campaign cannot open without approvals', async () => {
		const response = await open(tenant);
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe('compliance_gate_closed');
		expect(response.json().error.details.missing).toEqual(['legal', 'psp']);
		expect((await adminCampaign(tenant)).demoPayments).toBeNull();
	});

	it('the shop promises no chances, the site is not a demo and a payment earns none', async () => {
		expect(await shopChances(tenant)).toBeNull();
		expect(await site(tenant)).toMatchObject({ complianceDemo: false, demoPayments: null });
		expect(await publicCompliance(tenant)).toMatchObject({ allowed: false, demo: false });
		const status = await payAndConfirm(tenant, await placeOrder(ctx, tenant));
		expect(status).toMatchObject({ status: 'paid', entries: [] });
	});
});

describe('switching to a production account removes the waiver at once', () => {
	it('the gate closes, the shop stops promising chances and an order started on the test account earns none', async () => {
		const tenant = await demoTenant('mp-switch-to-production', 'test');
		expect((await open(tenant)).statusCode).toBe(200);
		const order = await placeOrder(ctx, tenant);

		expect((await switchTo(tenant, account('production'))).statusCode).toBe(200);
		const detail = await adminCampaign(tenant);
		expect(detail.gate).toEqual({ allowed: false, missing: ['legal', 'psp'], rejected: [] });
		expect(detail.demoPayments).toBeNull();
		expect(await shopChances(tenant)).toBeNull();
		expect(await site(tenant)).toMatchObject({ complianceDemo: false, demoPayments: null });

		const status = await payAndConfirm(tenant, order);
		expect(status).toMatchObject({ status: 'paid', entries: [] });
		expect((await notAllocated(tenant)).map((event) => event.metadata)).toEqual([expect.objectContaining({ gateAllowed: false })]);
	});
});

describe('confirmation grants no waived chances for a payment taken by a production account', () => {
	it('defense in depth: the active test account does not cover an order pinned to a production account', async () => {
		const tenant = await demoTenant('mp-pinned-production', 'test');
		const testAccount = await activeAccount(tenant);
		expect((await open(tenant)).statusCode).toBe(200);
		expect((await switchTo(tenant, account('production'))).statusCode).toBe(200);
		const order = await placeOrder(ctx, tenant);
		// Simulates an order that took the campaign while charged by the production account.
		await ctx.db.withTenant(tenant.id, async (tx) => {
			const [rule] = await tx
				.select({ id: s.campaignRuleVersions.id })
				.from(s.campaignRuleVersions)
				.where(and(eq(s.campaignRuleVersions.campaignId, tenant.campaignId), eq(s.campaignRuleVersions.status, 'locked')));
			await tx.update(s.orders).set({ campaignId: tenant.campaignId, ruleVersionId: rule!.id }).where(eq(s.orders.reference, order.reference));
		});
		expect((await reactivate(tenant, testAccount.id)).statusCode).toBe(200);
		expect((await adminCampaign(tenant)).gate.demo).toBe(true);

		const status = await payAndConfirm(tenant, order);
		expect(status).toMatchObject({ status: 'paid', entries: [] });
		expect((await notAllocated(tenant)).map((event) => event.metadata)).toEqual([expect.objectContaining({ reason: 'demo_requires_test_account' })]);
	});
});
