import { randomUUID } from 'node:crypto';
import { and, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadMercadoPago } from '../src/payments/integrations';
import { ProviderError } from '../src/payments/provider';
import { simulatorCollectorId } from '../src/payments/simulator';
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

// Platform staff switch an organization's Mercado Pago account while it sells
// (odd/tasks/mercadopago-account-switch.md, S1, S2, S4). Each order is charged,
// confirmed and reconciled with the account that was active when it was created.

let ctx: TestContext;
let auth: Record<string, string>;
const platformAdmin = '00000000-0000-4000-8000-00000000a0c2';

beforeAll(async () => {
	ctx = await createTestContext();
	await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: platformAdmin, email: 'switch@test' }).onConflictDoNothing());
	auth = { 'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN, authorization: `Bearer ${await ctx.signAdmin(platformAdmin, 'switch@test')}` };
});
afterAll(() => ctx.close());

const token = () => `TEST-${randomUUID().replaceAll('-', '')}`;
const secret = () => `whsec-${randomUUID().replaceAll('-', '')}`;
const url = (tenant: TenantFixture) => `/platform/organizations/${tenant.id}/integrations/mercadopago`;
const connect = (tenant: TenantFixture, accessToken: string, webhookSecret: string) =>
	ctx.app.inject({ method: 'PUT', url: url(tenant), headers: auth, payload: { mode: 'sandbox', accessToken, webhookSecret } });
const disconnect = (tenant: TenantFixture) => ctx.app.inject({ method: 'DELETE', url: url(tenant), headers: auth });
const accounts = (tenant: TenantFixture) =>
	ctx.db.withPlatform((db) =>
		db
			.select()
			.from(s.organizationIntegrations)
			.where(and(eq(s.organizationIntegrations.organizationId, tenant.id), eq(s.organizationIntegrations.provider, 'mercadopago')))
			.orderBy(s.organizationIntegrations.createdAt)
	);
/** The active account with its opened credentials, as the API sees it. */
const active = async (tenant: TenantFixture) => (await ctx.db.withTenant(tenant.id, (tx) => loadMercadoPago(tx, tenant.id, ctx.deps.keyRing)))!;
const audits = (tenant: TenantFixture, action: string) =>
	ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.organizationId, tenant.id), eq(s.auditEvents.action, action))));
const events = (tenant: TenantFixture, paymentId: string) =>
	ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.paymentEvents).where(eq(s.paymentEvents.providerPaymentId, paymentId)));

/** Switches the tenant to a new simulated account and returns its credentials. */
async function switchAccount(tenant: TenantFixture) {
	const credentials = { accessToken: token(), webhookSecret: secret() };
	const response = await connect(tenant, credentials.accessToken, credentials.webhookSecret);
	expect(response.statusCode, response.body).toBe(200);
	return credentials;
}

describe('switching the account while selling (S1, S4)', () => {
	it('is allowed while an order awaits payment, audited, and the previous account is kept retired', async () => {
		const tenant = await createTenant(ctx, 'switch-ok');
		const old = await active(tenant);
		const [before] = await accounts(tenant);
		await placeOrder(ctx, tenant);

		const next = await switchAccount(tenant);

		const [retired, current] = await accounts(tenant);
		expect(retired).toMatchObject({ id: old.id, isActive: false, sealedSecrets: before!.sealedSecrets });
		expect(retired!.retiredAt).not.toBeNull();
		expect(current).toMatchObject({ isActive: true, retiredAt: null, publicConfig: { collectorId: simulatorCollectorId(next.accessToken) } });
		const [event] = await audits(tenant, 'integration.mercadopago_updated');
		expect(event).toMatchObject({
			actorId: platformAdmin,
			targetId: current!.id,
			metadata: { collectorId: simulatorCollectorId(next.accessToken), retiredIntegrationId: old.id, previousCollectorId: old.collectorId }
		});
		expect(JSON.stringify(event)).not.toContain(next.accessToken);
	});

	it('rotating the same merchant credentials updates that account instead of adding one', async () => {
		const tenant = await createTenant(ctx, 'switch-rotate');
		const first = await switchAccount(tenant);
		const [, account] = await accounts(tenant);
		const spy = vi.spyOn(ctx.simulator, 'verifyAccount').mockResolvedValueOnce({ collectorId: simulatorCollectorId(first.accessToken), nickname: null });
		try {
			await switchAccount(tenant);
		} finally {
			spy.mockRestore();
		}
		const rows = await accounts(tenant);
		expect(rows).toHaveLength(2);
		expect(rows.filter((row) => row.isActive)).toEqual([expect.objectContaining({ id: account!.id, version: account!.version + 1, retiredAt: null })]);
		expect(rows.find((row) => row.id === account!.id)!.sealedSecrets).not.toBe(account!.sealedSecrets);
	});
});

describe('orders keep their account (S2)', () => {
	it('confirms the order placed before the switch with the old account, and charges the next one to the new account', async () => {
		const tenant = await createTenant(ctx, 'switch-pinned');
		const old = await active(tenant);
		const before = await placeOrder(ctx, tenant);
		const next = await switchAccount(tenant);
		const current = await active(tenant);

		expect((await orderByReference(ctx, tenant, before.reference)).paymentIntegrationId).toBe(old.id);
		const oldPayment = ctx.simulator.pay(before.preferenceId, 'approved');
		expect(oldPayment.collectorId).toBe(old.collectorId);
		// Signed with the old account's secret; readable only with the old account's token.
		expect((await ctx.app.inject(webhookRequest(tenant, oldPayment.id))).statusCode).toBe(200);
		expect((await orderByReference(ctx, tenant, before.reference)).status).toBe('paid');
		expect((await events(tenant, oldPayment.id)).map((event) => event.outcome)).toEqual(['paid']);

		const after = await placeOrder(ctx, tenant);
		expect((await orderByReference(ctx, tenant, after.reference)).paymentIntegrationId).toBe(current.id);
		expect(ctx.simulator.preferences.get(after.preferenceId)!.accessToken).toBe(next.accessToken);
		const newPayment = ctx.simulator.pay(after.preferenceId, 'approved');
		expect((await ctx.app.inject(webhookRequest(tenant, newPayment.id, next.webhookSecret))).statusCode).toBe(200);
		expect((await orderByReference(ctx, tenant, after.reference)).status).toBe('paid');
	});

	it('refuses a payment of the old account for an order created with the new one', async () => {
		const tenant = await createTenant(ctx, 'switch-mismatch');
		const old = await active(tenant);
		await switchAccount(tenant);
		const order = await placeOrder(ctx, tenant);
		const { request } = ctx.simulator.preferences.get(order.preferenceId)!;
		// Someone pays the new order's reference into the old account.
		const preference = await ctx.simulator.createPreference(old.credentials, { ...request, idempotencyKey: randomUUID() });
		const payment = ctx.simulator.pay(preference.id, 'approved');

		const response = await ctx.app.inject(webhookRequest(tenant, payment.id));
		expect(response.statusCode).toBe(200);
		const stored = await orderByReference(ctx, tenant, order.reference);
		expect(stored.status).toBe('pending_payment');
		expect(await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.payments).where(eq(s.payments.orderId, stored.id)))).toEqual([]);
		expect((await events(tenant, payment.id)).map((event) => event.outcome)).toEqual(['merchant_mismatch']);
		const [rejected] = await audits(tenant, 'payment.rejected_mismatch');
		expect(rejected).toMatchObject({ targetId: stored.id, metadata: { reason: 'merchant_mismatch', providerPaymentId: payment.id } });
	});

	it('answers 401 when no account of the organization signed the notification', async () => {
		const tenant = await createTenant(ctx, 'switch-unsigned');
		const order = await placeOrder(ctx, tenant);
		await switchAccount(tenant);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		const response = await ctx.app.inject(webhookRequest(tenant, payment.id, secret()));
		expect(response.statusCode).toBe(401);
		expect(response.json()).toEqual({ error: { code: 'invalid_signature' } });
		expect(await events(tenant, payment.id)).toEqual([expect.objectContaining({ outcome: 'rejected_signature', signatureValid: false, detail: 'bad_signature' })]);
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('pending_payment');
	});

	it('a checkout in progress makes the switch wait, and its order stays on the old account', async () => {
		const tenant = await createTenant(ctx, 'switch-race');
		await openCampaign(ctx, tenant);
		const old = await active(tenant);
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let locked!: () => void;
		const isLocked = new Promise<void>((resolve) => (locked = resolve));
		// Holds the campaign row, which the checkout locks after it has read the account.
		const holder = ctx.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				await tx.select({ id: s.campaigns.id }).from(s.campaigns).where(eq(s.campaigns.id, tenant.campaignId)).for('update');
				locked();
				await held;
			})
		);
		await isLocked;
		const checkout = ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant) });
		await new Promise((resolve) => setTimeout(resolve, 400));
		let released = false;
		let switchedWhileHeld = false;
		const next = { accessToken: token(), webhookSecret: secret() };
		const switching = connect(tenant, next.accessToken, next.webhookSecret).then((response) => {
			switchedWhileHeld = !released;
			return response;
		});
		await new Promise((resolve) => setTimeout(resolve, 400));
		released = true;
		release();
		await holder;
		const placed = await checkout;
		const switched = await switching;
		expect(placed.statusCode, placed.body).toBe(201);
		expect(switched.statusCode, switched.body).toBe(200);
		expect(switchedWhileHeld).toBe(false);

		const order = await orderByReference(ctx, tenant, placed.json().reference);
		expect(order.paymentIntegrationId).toBe(old.id);
		const preferenceId = new URL(placed.json().redirectUrl).searchParams.get('pref')!;
		expect(ctx.simulator.preferences.get(preferenceId)!.accessToken).toBe(old.credentials.accessToken);
		const following = await placeOrder(ctx, tenant);
		expect((await orderByReference(ctx, tenant, following.reference)).paymentIntegrationId).toBe((await active(tenant)).id);
	});
});

describe('payment checks that still hold', () => {
	it('refuses a payment of another merchant for an order of the account that notified it', async () => {
		const tenant = await createTenant(ctx, 'switch-collector');
		const order = await placeOrder(ctx, tenant);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		const spy = vi.spyOn(ctx.simulator, 'getPayment').mockResolvedValueOnce({ ...payment, collectorId: 'another-merchant' });
		try {
			expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
		} finally {
			spy.mockRestore();
		}
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('pending_payment');
		expect((await events(tenant, payment.id)).map((event) => event.outcome)).toEqual(['merchant_mismatch']);
	});

	it('an order created before accounts were recorded is confirmed by the account whose signature and merchant match', async () => {
		const tenant = await createTenant(ctx, 'switch-legacy');
		const order = await placeOrder(ctx, tenant);
		const stored = await orderByReference(ctx, tenant, order.reference);
		await ctx.db.withTenant(tenant.id, (tx) => tx.update(s.orders).set({ paymentIntegrationId: null }).where(eq(s.orders.id, stored.id)));
		await switchAccount(tenant);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('paid');
	});
});

describe('reconciliation with several accounts (S2)', () => {
	it('finds the payments of the old and the new account, and a retired account Mercado Pago refuses becomes an item', async () => {
		const tenant = await createTenant(ctx, 'switch-recon');
		const financeId = randomUUID();
		await ctx.db.withPlatform((db) =>
			db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: financeId, email: `finance@${tenant.host}`, role: 'finance_manager' })
		);
		const old = await active(tenant);
		const tick = () => (ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000));
		tick();
		const before = await placeOrder(ctx, tenant);
		// Both webhooks are lost: only reconciliation can find these payments.
		const oldPayment = ctx.simulator.pay(before.preferenceId, 'approved');
		await switchAccount(tenant);
		tick();
		const after = await placeOrder(ctx, tenant);
		const newPayment = ctx.simulator.pay(after.preferenceId, 'approved');
		tick();

		const run = async () => {
			tick();
			const response = await ctx.app.inject({ method: 'POST', url: '/admin/reconciliation/runs', headers: await adminHeaders(ctx, tenant, financeId), payload: {} });
			expect(response.statusCode, response.body).toBe(200);
			return response.json() as { status: string; summary: { examined: number } };
		};
		const items = () => ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.reconciliationItems).where(eq(s.reconciliationItems.status, 'open')));

		const first = await run();
		expect(first.status).toBe('completed');
		expect(first.summary.examined).toBe(2);
		const found = await items();
		expect(found.map((item) => [item.kind, item.providerPaymentId]).sort()).toEqual(
			[
				['payment_missing_in_system', oldPayment.id],
				['payment_missing_in_system', newPayment.id]
			].sort()
		);

		const search = ctx.simulator.searchPayments;
		// Mercado Pago no longer accepts the old account's token.
		const spy = vi.spyOn(ctx.simulator, 'searchPayments').mockImplementation(async (credentials, window) => {
			if (credentials.accessToken === old.credentials.accessToken) throw new ProviderError('unauthorized', 401);
			return search(credentials, window);
		});
		try {
			const second = await run();
			expect(second.status).toBe('completed');
		} finally {
			spy.mockRestore();
		}
		const unavailable = (await items()).filter((item) => item.kind === 'account_unavailable');
		expect(unavailable).toEqual([
			expect.objectContaining({ severity: 'critical', fingerprint: `account_unavailable:${old.id}`, providerPaymentId: null, observed: { status: 401 } })
		]);
		expect(unavailable[0]!.expected).toMatchObject({ collectorId: old.collectorId });

		// Once the account answers again, the item clears by itself.
		await run();
		expect((await items()).filter((item) => item.kind === 'account_unavailable')).toEqual([]);
	});
});

describe('disconnecting with several accounts (S4)', () => {
	it('is refused while the retired account has a payment in progress, and deletes every account otherwise', async () => {
		const tenant = await createTenant(ctx, 'switch-disconnect');
		const order = await placeOrder(ctx, tenant);
		await switchAccount(tenant);

		const refused = await disconnect(tenant);
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({ code: 'payments_in_progress' });
		expect(await accounts(tenant)).toHaveLength(2);

		const saved = ctx.clock.now;
		ctx.clock.now = new Date(saved.getTime() + 61 * 60_000);
		try {
			expect((await disconnect(tenant)).statusCode).toBe(200);
		} finally {
			ctx.clock.now = saved;
		}
		expect(await accounts(tenant)).toEqual([]);
		expect((await orderByReference(ctx, tenant, order.reference)).paymentIntegrationId).toBeNull();
	});
});
