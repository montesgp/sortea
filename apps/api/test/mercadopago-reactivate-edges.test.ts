import { randomUUID } from 'node:crypto';
import { and, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadMercadoPago } from '../src/payments/integrations';
import { ProviderError } from '../src/payments/provider';
import { checkoutBody, createTenant, createTestContext, headers, orderByReference, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

// Edge cases of returning to a previous Mercado Pago account and of webhooks
// with several signing accounts (odd/tasks/mercadopago-account-switch.md S6, S7).
let ctx: TestContext;
let auth: Record<string, string>;
const platformAdmin = '00000000-0000-4000-8000-00000000a0c9';
const lines: string[] = [];

beforeAll(async () => {
	ctx = await createTestContext({ logStream: { write: (line) => void lines.push(line) } });
	await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: platformAdmin, email: 'probe@test' }).onConflictDoNothing());
	auth = { 'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN, authorization: `Bearer ${await ctx.signAdmin(platformAdmin, 'probe@test')}` };
});
afterAll(() => ctx.close());

const token = () => `TEST-${randomUUID().replaceAll('-', '')}`;
const secret = () => `whsec-${randomUUID().replaceAll('-', '')}`;
const url = (tenant: TenantFixture) => `/platform/organizations/${tenant.id}/integrations/mercadopago`;
const connect = (tenant: TenantFixture, accessToken: string, webhookSecret: string) =>
	ctx.app.inject({ method: 'PUT', url: url(tenant), headers: auth, payload: { mode: 'sandbox', accessToken, webhookSecret } });
const activate = (tenant: TenantFixture, integrationId: string) => ctx.app.inject({ method: 'POST', url: `${url(tenant)}/${integrationId}/activate`, headers: auth });
const accounts = (tenant: TenantFixture) =>
	ctx.db.withPlatform((db) =>
		db.select().from(s.organizationIntegrations).where(and(eq(s.organizationIntegrations.organizationId, tenant.id), eq(s.organizationIntegrations.provider, 'mercadopago'))).orderBy(s.organizationIntegrations.createdAt)
	);
const active = async (tenant: TenantFixture) => (await ctx.db.withTenant(tenant.id, (tx) => loadMercadoPago(tx, tenant.id, ctx.deps.keyRing)))!;
const audits = (tenant: TenantFixture, action: string) =>
	ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.organizationId, tenant.id), eq(s.auditEvents.action, action))));
const events = (tenant: TenantFixture, paymentId: string) =>
	ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.paymentEvents).where(eq(s.paymentEvents.providerPaymentId, paymentId)));

async function switched(label: string) {
	const tenant = await createTenant(ctx, label);
	const old = await active(tenant);
	const next = { accessToken: token(), webhookSecret: secret() };
	expect((await connect(tenant, next.accessToken, next.webhookSecret)).statusCode).toBe(200);
	return { tenant, old, next, current: await active(tenant) };
}

describe('returning to a previous account: edge cases (S6)', () => {
	it('refuses a legacy previous account without a collector with collector_mismatch, and changes nothing', async () => {
		const { tenant, old } = await switched('p-legacy');
		await ctx.db.withPlatform((db) => db.update(s.organizationIntegrations).set({ publicConfig: { simulator: 'true' } }).where(eq(s.organizationIntegrations.id, old.id)));
		const before = await accounts(tenant);
		const response = await activate(tenant, old.id);
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe('collector_mismatch');
		expect(response.json().error.message).toContain('sin identificar');
		expect(await accounts(tenant)).toEqual(before);
	});

	it('answers 404 and activates nothing when the accounts are disconnected while the credentials are checked', async () => {
		const { tenant, old } = await switched('p-disc');
		const original = ctx.simulator.verifyAccount.bind(ctx.simulator);
		const spy = vi.spyOn(ctx.simulator, 'verifyAccount').mockImplementationOnce(async (credentials) => {
			const off = await ctx.app.inject({ method: 'DELETE', url: url(tenant), headers: auth });
			expect(off.statusCode, off.body).toBe(200);
			return original(credentials);
		});
		try {
			const response = await activate(tenant, old.id);
			expect(response.statusCode).toBe(404);
		} finally {
			spy.mockRestore();
		}
		expect(await accounts(tenant)).toEqual([]);
		expect(await audits(tenant, 'integration.mercadopago_reactivated')).toEqual([]);
	});

	it('answers 409 already_active when the same account is reconnected while it is checked, keeping one active account', async () => {
		const { tenant, old } = await switched('p-rot');
		const original = ctx.simulator.verifyAccount.bind(ctx.simulator);
		let nested = false;
		const spy = vi.spyOn(ctx.simulator, 'verifyAccount').mockImplementation(async (credentials) => {
			if (!nested) {
				nested = true;
				const again = await connect(tenant, old.credentials.accessToken, old.credentials.webhookSecret);
				expect(again.statusCode, again.body).toBe(200);
			}
			return original(credentials);
		});
		try {
			const response = await activate(tenant, old.id);
			expect(response.statusCode).toBe(409);
			expect(response.json().error.code).toBe('already_active');
		} finally {
			spy.mockRestore();
		}
		const rows = await accounts(tenant);
		expect(rows.filter((row) => row.isActive).map((row) => row.id)).toEqual([old.id]);
		expect(await audits(tenant, 'integration.mercadopago_reactivated')).toEqual([]);
	});

	it('refuses invalid ids: a non-uuid account 400, an unknown organization 404, no credentials 401', async () => {
		const { tenant, old } = await switched('p-ids');
		expect((await ctx.app.inject({ method: 'POST', url: `${url(tenant)}/abc/activate`, headers: auth })).statusCode).toBe(400);
		expect((await ctx.app.inject({ method: 'POST', url: `/platform/organizations/${randomUUID()}/integrations/mercadopago/${old.id}/activate`, headers: auth })).statusCode).toBe(404);
		expect((await ctx.app.inject({ method: 'POST', url: `${url(tenant)}/${old.id}/activate` })).statusCode).toBe(401);
	});

	it('never exposes a token or webhook secret in the response, the audit or the logs, on success and on refusals', async () => {
		const { tenant, old, next } = await switched('p-leak');
		lines.length = 0;
		for (const status of [401, 500]) {
			const spy = vi.spyOn(ctx.simulator, 'verifyAccount').mockRejectedValueOnce(new ProviderError(`boom ${old.credentials.accessToken}`, status));
			try {
				const refused = await activate(tenant, old.id);
				expect(refused.body).not.toContain(old.credentials.accessToken);
			} finally {
				spy.mockRestore();
			}
		}
		const response = await activate(tenant, old.id);
		expect(response.statusCode).toBe(200);
		const everything = [response.body, JSON.stringify(await audits(tenant, 'integration.mercadopago_reactivated')), lines.join('\n')].join('\n');
		for (const value of [old.credentials.accessToken, old.credentials.webhookSecret, next.accessToken, next.webhookSecret]) expect(everything).not.toContain(value);
		expect(Object.keys(response.json().integrations[0]).sort()).toEqual(
			['collectorId', 'id', 'isActive', 'keyVersion', 'lastError', 'lastVerifiedAt', 'mode', 'provider', 'retiredAt', 'secretHint', 'simulator', 'status', 'version'].sort()
		);
	});

	it('creates a checkout queued behind a reactivation with the reactivated account, without deadlock', async () => {
		const { tenant, old } = await switched('p-reverse');
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let locked!: () => void;
		const isLocked = new Promise<void>((resolve) => (locked = resolve));
		const holder = ctx.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				await tx.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, tenant.id)).for('update');
				locked();
				await held;
			})
		);
		await isLocked;
		const activating = activate(tenant, old.id);
		await new Promise((resolve) => setTimeout(resolve, 400));
		const checkout = ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant) });
		await new Promise((resolve) => setTimeout(resolve, 400));
		release();
		await holder;
		const [activated, placed] = await Promise.all([activating, checkout]);
		expect(activated.statusCode, activated.body).toBe(200);
		expect(placed.statusCode, placed.body).toBe(201);
		expect((await orderByReference(ctx, tenant, placed.json().reference)).paymentIntegrationId).toBe(old.id);
		const preferenceId = new URL(placed.json().redirectUrl).searchParams.get('pref')!;
		expect(ctx.simulator.preferences.get(preferenceId)!.accessToken).toBe(old.credentials.accessToken);
	});
});

describe('webhooks with several signing accounts: edge cases (S7)', () => {
	async function shared(label: string) {
		const tenant = await createTenant(ctx, label);
		const order = await placeOrder(ctx, tenant);
		const activeToken = token();
		expect((await connect(tenant, activeToken, tenant.webhookSecret)).statusCode).toBe(200);
		return { tenant, order, activeToken, payment: ctx.simulator.pay(order.preferenceId, 'approved') };
	}

	it('answers 503 when the first signer returns 404 and the next one fails', async () => {
		const { tenant, order, activeToken, payment } = await shared('p-404-500');
		const calls: string[] = [];
		const spy = vi.spyOn(ctx.simulator, 'getPayment').mockImplementation(async (credentials) => {
			calls.push(credentials.accessToken === activeToken ? 'active' : 'old');
			if (credentials.accessToken === activeToken) throw new ProviderError('not found', 404);
			throw new ProviderError('upstream failure', 502);
		});
		try {
			expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(503);
		} finally {
			spy.mockRestore();
		}
		expect(calls).toEqual(['active', 'old']);
		expect(await events(tenant, payment.id)).toEqual([expect.objectContaining({ outcome: 'provider_error', detail: 'upstream failure' })]);
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('pending_payment');
	});

	it('skips a network error from one signer when another has the payment', async () => {
		const { tenant, order, activeToken, payment } = await shared('p-net');
		const read = ctx.simulator.getPayment.bind(ctx.simulator);
		const spy = vi.spyOn(ctx.simulator, 'getPayment').mockImplementation(async (credentials, id) => {
			if (credentials.accessToken === activeToken) throw new TypeError('fetch failed');
			return read(credentials, id);
		});
		try {
			expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
		} finally {
			spy.mockRestore();
		}
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('paid');
		expect((await events(tenant, payment.id)).map((event) => event.outcome)).toEqual(['paid']);
	});
});
