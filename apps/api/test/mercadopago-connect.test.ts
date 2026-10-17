import { randomUUID } from 'node:crypto';
import { and, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../src/payments/provider';
import { simulatorCollectorId } from '../src/payments/simulator';
import { adminHeaders, checkoutBody, createTenant, createTestContext, headers, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

// A platform admin connects an organization's Mercado Pago account in one
// step and can disconnect it later (odd/tasks/mercadopago-connect.md, S1-S4).
// Tests run against the payment simulator, which accepts TEST- tokens only.

let ctx: TestContext;
let auth: Record<string, string>;
const platformAdmin = '00000000-0000-4000-8000-00000000a0c1';

beforeAll(async () => {
	ctx = await createTestContext();
	await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: platformAdmin, email: 'connect@test' }).onConflictDoNothing());
	auth = { 'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN, authorization: `Bearer ${await ctx.signAdmin(platformAdmin, 'connect@test')}` };
});
afterAll(() => ctx.close());

const url = (tenant: TenantFixture) => `/platform/organizations/${tenant.id}/integrations/mercadopago`;
const connect = (tenant: TenantFixture, accessToken: string, mode: 'sandbox' | 'production' = 'sandbox') =>
	ctx.app.inject({ method: 'PUT', url: url(tenant), headers: auth, payload: { mode, accessToken, webhookSecret: 'whsec-connect-0123456789' } });
const disconnect = (tenant: TenantFixture, as: Record<string, string> = auth) => ctx.app.inject({ method: 'DELETE', url: url(tenant), headers: as });
const integrations = (tenant: TenantFixture) =>
	ctx.db.withPlatform((db) =>
		db
			.select()
			.from(s.organizationIntegrations)
			.where(and(eq(s.organizationIntegrations.organizationId, tenant.id), eq(s.organizationIntegrations.provider, 'mercadopago')))
	);
const audits = (tenant: TenantFixture, action: string) =>
	ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.organizationId, tenant.id), eq(s.auditEvents.action, action))));
const token = () => `TEST-${randomUUID().replaceAll('-', '')}`;

describe('connect (S1, S2)', () => {
	it('checks the credentials with Mercado Pago and stores them connected, with the merchant and the webhook URL', async () => {
		const tenant = await createTenant(ctx, 'connect-ok');
		const accessToken = token();
		const response = await connect(tenant, accessToken);
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.webhookUrl).toBe(`http://api.test/webhooks/mercadopago/${tenant.id}`);
		const sandbox = body.integrations.find((integration: { mode: string }) => integration.mode === 'sandbox');
		expect(sandbox).toMatchObject({ status: 'verified', isActive: true, collectorId: simulatorCollectorId(accessToken), lastError: null });
		expect(sandbox.lastVerifiedAt).not.toBeNull();
		expect(response.body).not.toContain(accessToken);
		expect(await audits(tenant, 'integration.mercadopago_updated')).toHaveLength(1);
	});

	it('refuses credentials Mercado Pago rejects, says why and keeps the account already connected', async () => {
		const tenant = await createTenant(ctx, 'connect-bad');
		const before = await integrations(tenant);
		const response = await connect(tenant, 'APP_USR-1234567890-rejected-by-provider');
		expect(response.statusCode).toBe(400);
		expect(response.json().error).toMatchObject({
			code: 'credentials_rejected',
			message: 'Mercado Pago rechazó las credenciales (HTTP 401). Revisá el access token y el entorno elegido.'
		});
		expect(await integrations(tenant)).toEqual(before);
		expect(await audits(tenant, 'integration.mercadopago_updated')).toHaveLength(0);
	});

	it('does not switch to another account while an order awaits payment, but the same account can be saved again', async () => {
		const tenant = await createTenant(ctx, 'connect-busy');
		const first = token();
		expect((await connect(tenant, first)).statusCode).toBe(200);
		await placeOrder(ctx, tenant);

		const other = await connect(tenant, token());
		expect(other.statusCode).toBe(409);
		expect(other.json().error).toMatchObject({ code: 'payments_in_progress' });
		expect(other.json().error.message).toMatch(/^Hay 1 pago en curso con la cuenta actual\. Esperá a que venza \(.+\) para cambiarla\.$/);
		const [current] = await integrations(tenant);
		expect(current!.publicConfig.collectorId).toBe(simulatorCollectorId(first));

		expect((await connect(tenant, first)).statusCode).toBe(200);
	});
});

describe('connect when Mercado Pago fails or the caller is not staff (S1)', () => {
	it.each([
		['a server error', new ProviderError('down', 503)],
		['a rate limit', new ProviderError('slow down', 429)],
		['no answer', new ProviderError('no answer', null)],
		['a network failure', new TypeError('fetch failed')]
	])('answers 502 on %s and stores nothing', async (_label, failure) => {
		const tenant = await createTenant(ctx, `connect-down-${randomUUID().slice(0, 6)}`);
		const before = await integrations(tenant);
		const spy = vi.spyOn(ctx.simulator, 'verifyAccount').mockRejectedValueOnce(failure);
		const accessToken = token();
		try {
			const response = await connect(tenant, accessToken);
			expect(response.statusCode).toBe(502);
			expect(response.json().error).toMatchObject({ code: 'provider_unreachable', message: 'No pudimos conectar con Mercado Pago. Probá de nuevo en unos minutos.' });
			expect(response.body).not.toContain(accessToken);
		} finally {
			spy.mockRestore();
		}
		expect(await integrations(tenant)).toEqual(before);
		expect(await audits(tenant, 'integration.mercadopago_updated')).toHaveLength(0);
	});

	it('tenant admins cannot connect and nothing changes', async () => {
		const tenant = await createTenant(ctx, 'connect-auth');
		const before = await integrations(tenant);
		const response = await ctx.app.inject({
			method: 'PUT',
			url: url(tenant),
			headers: await adminHeaders(ctx, tenant),
			payload: { mode: 'sandbox', accessToken: token(), webhookSecret: 'whsec-connect-0123456789' }
		});
		expect(response.statusCode).toBe(403);
		expect(await integrations(tenant)).toEqual(before);
	});

	it('the audit trail never carries the secrets', async () => {
		const tenant = await createTenant(ctx, 'connect-audit');
		const accessToken = token();
		expect((await connect(tenant, accessToken)).statusCode).toBe(200);
		expect((await disconnect(tenant)).statusCode).toBe(200);
		const events = [...(await audits(tenant, 'integration.mercadopago_updated')), ...(await audits(tenant, 'integration.mercadopago_disconnected'))];
		expect(events).toHaveLength(2);
		expect(JSON.stringify(events)).not.toContain(accessToken);
		expect(JSON.stringify(events)).not.toContain('whsec-connect');
	});
});

describe('disconnect (S3)', () => {
	it('erases the credentials, audits it and the checkout says payments are not enabled', async () => {
		const tenant = await createTenant(ctx, 'disconnect-ok');
		const response = await disconnect(tenant);
		expect(response.statusCode).toBe(200);
		expect(response.json().integrations).toEqual([]);
		expect(await integrations(tenant)).toEqual([]);
		const [event] = await audits(tenant, 'integration.mercadopago_disconnected');
		expect(event).toMatchObject({ actorType: 'platform_admin', actorId: platformAdmin });

		const checkout = await ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant) });
		expect(checkout.statusCode).toBe(503);
		expect(checkout.json().error).toMatchObject({ code: 'payments_unavailable', message: 'Los pagos todavía no están habilitados para este sitio' });
	});

	it('is refused while an order awaits payment, and allowed once it expires', async () => {
		const tenant = await createTenant(ctx, 'disconnect-busy');
		await placeOrder(ctx, tenant);
		const refused = await disconnect(tenant);
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({ code: 'payments_in_progress' });
		expect(refused.json().error.message).toMatch(/^Hay 1 pago en curso con la cuenta actual\. Esperá a que venza \(.+\) para desvincularla\.$/);
		expect(await integrations(tenant)).toHaveLength(1);

		const saved = ctx.clock.now;
		ctx.clock.now = new Date(saved.getTime() + 61 * 60_000);
		try {
			expect((await disconnect(tenant)).statusCode).toBe(200);
		} finally {
			ctx.clock.now = saved;
		}
		expect(await integrations(tenant)).toEqual([]);
	});

	it('is refused while a payment is still being credited, even after its order expired', async () => {
		const tenant = await createTenant(ctx, 'disconnect-credit');
		const order = await placeOrder(ctx, tenant);
		const payment = ctx.simulator.pay(order.preferenceId, 'in_process');
		expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
		const saved = ctx.clock.now;
		ctx.clock.now = new Date(saved.getTime() + 61 * 60_000);
		try {
			const refused = await disconnect(tenant);
			expect(refused.statusCode).toBe(409);
			expect(refused.json().error).toMatchObject({
				code: 'payments_in_progress',
				message: 'Hay 1 pago en acreditación con la cuenta actual. Esperá a que se apruebe o se rechace para desvincularla.'
			});
		} finally {
			ctx.clock.now = saved;
		}
		expect(await integrations(tenant)).toHaveLength(1);
	});

	it('a checkout that starts while the account is being disconnected does not use the erased credentials', async () => {
		const tenant = await createTenant(ctx, 'disconnect-race');
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let locked!: () => void;
		const isLocked = new Promise<void>((resolve) => (locked = resolve));
		// Stands in for a disconnect that holds the organization row, then erases the account.
		const holder = ctx.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				await tx.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, tenant.id)).for('update');
				locked();
				await held;
				await tx.delete(s.organizationIntegrations).where(eq(s.organizationIntegrations.organizationId, tenant.id));
			})
		);
		await isLocked;
		const checkout = ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant) });
		await new Promise((resolve) => setTimeout(resolve, 400));
		release();
		await holder;
		const response = await checkout;
		expect(response.statusCode).toBe(503);
		expect(response.json().error).toMatchObject({ code: 'payments_unavailable' });
		expect(await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.orders))).toEqual([]);
	});

	it('only platform staff can disconnect; an organization without an account answers 404', async () => {
		const tenant = await createTenant(ctx, 'disconnect-auth');
		expect((await disconnect(tenant, await adminHeaders(ctx, tenant))).statusCode).toBe(403);
		expect(await integrations(tenant)).toHaveLength(1);
		expect((await disconnect(tenant)).statusCode).toBe(200);
		expect((await disconnect(tenant)).statusCode).toBe(404);
	});
});

describe('checkout (S4)', () => {
	it('needs an account whose merchant is known, except the simulator', async () => {
		const tenant = await createTenant(ctx, 'checkout-unverified');
		await ctx.db.withPlatform((db) =>
			db.update(s.organizationIntegrations).set({ publicConfig: {}, status: 'configured' }).where(eq(s.organizationIntegrations.organizationId, tenant.id))
		);
		const refused = await ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant) });
		expect(refused.statusCode).toBe(503);
		expect(refused.json().error).toMatchObject({ code: 'payments_unavailable' });
		expect(await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.orders))).toEqual([]);

		await ctx.db.withPlatform((db) =>
			db.update(s.organizationIntegrations).set({ publicConfig: { simulator: 'true' } }).where(eq(s.organizationIntegrations.organizationId, tenant.id))
		);
		expect((await ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant) })).statusCode).toBe(201);
	});
});
