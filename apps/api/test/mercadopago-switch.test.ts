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

	it('organization roles cannot switch, see or disconnect accounts', async () => {
		const tenant = await createTenant(ctx, 'switch-roles');
		for (const roleHeaders of [await adminHeaders(ctx, tenant), await adminHeaders(ctx, tenant, tenant.operatorId)]) {
			expect(
				(await ctx.app.inject({ method: 'PUT', url: url(tenant), headers: roleHeaders, payload: { mode: 'sandbox', accessToken: token(), webhookSecret: secret() } }))
					.statusCode
			).toBe(403);
			expect((await ctx.app.inject({ method: 'GET', url: `/platform/organizations/${tenant.id}`, headers: roleHeaders })).statusCode).toBe(403);
			expect((await ctx.app.inject({ method: 'DELETE', url: url(tenant), headers: roleHeaders })).statusCode).toBe(403);
		}
		expect(await accounts(tenant)).toHaveLength(1);
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

	it('refunds and chargebacks of orders of the retired account arrive through its webhook', async () => {
		const tenant = await createTenant(ctx, 'switch-refund');
		const [a, b] = [await placeOrder(ctx, tenant), await placeOrder(ctx, tenant)];
		const [pa, pb] = [ctx.simulator.pay(a.preferenceId, 'approved'), ctx.simulator.pay(b.preferenceId, 'approved')];
		for (const payment of [pa, pb]) expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
		await switchAccount(tenant);
		ctx.simulator.setStatus(pa.id, 'refunded');
		ctx.simulator.setStatus(pb.id, 'charged_back');
		for (const payment of [pa, pb]) expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
		expect((await orderByReference(ctx, tenant, a.reference)).status).toBe('refunded');
		expect((await orderByReference(ctx, tenant, b.reference)).status).toBe('charged_back');
	});

	it('confirms an order of the retired account when the new account shares its webhook secret', async () => {
		const tenant = await createTenant(ctx, 'switch-shared-secret');
		const order = await placeOrder(ctx, tenant);
		// The new account is configured with the same secret as the old one, so both validate the signature.
		const response = await connect(tenant, token(), tenant.webhookSecret);
		expect(response.statusCode, response.body).toBe(200);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');

		expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('paid');
		expect((await events(tenant, payment.id)).map((event) => event.outcome)).toEqual(['paid']);

		// A refund of that payment, already recorded, is read with its order's account first.
		ctx.simulator.setStatus(payment.id, 'refunded');
		const reads = vi.spyOn(ctx.simulator, 'getPayment');
		try {
			expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
			expect(reads).toHaveBeenCalledTimes(1);
		} finally {
			reads.mockRestore();
		}
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('refunded');
	});

	it('the payment simulator notifies an order of the retired account with that account secret', async () => {
		const tenant = await createTenant(ctx, 'switch-simulator');
		const order = await placeOrder(ctx, tenant);
		await switchAccount(tenant);
		const response = await ctx.app.inject({ method: 'POST', url: '/dev/simulator/pay', headers: headers(tenant), payload: { preferenceId: order.preferenceId, outcome: 'approved' } });
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().webhookStatus).toBe(200);
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('paid');
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

	it('a checkout waiting for a switch is created and charged with the new account', async () => {
		const tenant = await createTenant(ctx, 'switch-reverse');
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let locked!: () => void;
		const isLocked = new Promise<void>((resolve) => (locked = resolve));
		// Holds the organization row, so the switch queues first and the checkout behind it.
		const holder = ctx.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				await tx.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, tenant.id)).for('update');
				locked();
				await held;
			})
		);
		await isLocked;
		const next = { accessToken: token(), webhookSecret: secret() };
		const switching = connect(tenant, next.accessToken, next.webhookSecret);
		await new Promise((resolve) => setTimeout(resolve, 400));
		const checkout = ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant) });
		await new Promise((resolve) => setTimeout(resolve, 400));
		release();
		await holder;
		const [switched, placed] = await Promise.all([switching, checkout]);
		expect(switched.statusCode).toBe(200);
		expect(placed.statusCode, placed.body).toBe(201);
		expect((await orderByReference(ctx, tenant, placed.json().reference)).paymentIntegrationId).toBe((await active(tenant)).id);
		const preferenceId = new URL(placed.json().redirectUrl).searchParams.get('pref')!;
		expect(ctx.simulator.preferences.get(preferenceId)!.accessToken).toBe(next.accessToken);
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

	it('reconciliation finds a lost refund of an order of a retired account days later', async () => {
		const tenant = await createTenant(ctx, 'switch-lost-refund');
		const financeId = randomUUID();
		await ctx.db.withPlatform((db) =>
			db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: financeId, email: `finance@${tenant.host}`, role: 'finance_manager' })
		);
		const tick = (minutes = 1) => (ctx.clock.now = new Date(ctx.clock.now.getTime() + minutes * 60_000));
		const run = async () => {
			tick();
			const response = await ctx.app.inject({ method: 'POST', url: '/admin/reconciliation/runs', headers: await adminHeaders(ctx, tenant, financeId), payload: {} });
			expect(response.statusCode, response.body).toBe(200);
		};
		tick();
		const order = await placeOrder(ctx, tenant);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
		await switchAccount(tenant);
		await run();
		tick(3 * 24 * 60);
		await run();
		// Refunded at Mercado Pago; the webhook is lost.
		ctx.simulator.setStatus(payment.id, 'refunded');
		await run();
		const open = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.reconciliationItems).where(eq(s.reconciliationItems.status, 'open')));
		expect(open.map((item) => [item.kind, item.providerPaymentId])).toContainEqual(['refund_not_applied', payment.id]);
	});

	it('searches a retired account only while it has orders created within the chargeback horizon', async () => {
		const tenant = await createTenant(ctx, 'switch-horizon');
		const financeId = randomUUID();
		await ctx.db.withPlatform((db) =>
			db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: financeId, email: `finance@${tenant.host}`, role: 'finance_manager' })
		);
		const old = await active(tenant);
		const order = await placeOrder(ctx, tenant);
		await switchAccount(tenant);
		const day = 86_400_000;
		const searchedTokens = async (ageDays: number) => {
			const at = new Date(ctx.clock.now.getTime() - ageDays * day);
			await ctx.db.withTenant(tenant.id, (tx) => tx.update(s.orders).set({ createdAt: at, updatedAt: at, expiresAt: new Date(at.getTime() + 3_600_000) }).where(eq(s.orders.reference, order.reference)));
			const searches = vi.spyOn(ctx.simulator, 'searchPayments');
			try {
				ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
				const response = await ctx.app.inject({ method: 'POST', url: '/admin/reconciliation/runs', headers: await adminHeaders(ctx, tenant, financeId), payload: {} });
				expect(response.statusCode, response.body).toBe(200);
				return new Set(searches.mock.calls.map(([credentials]) => credentials.accessToken));
			} finally {
				searches.mockRestore();
			}
		};

		expect((await searchedTokens(179)).has(old.credentials.accessToken)).toBe(true);
		const outside = await searchedTokens(181);
		expect(outside.has(old.credentials.accessToken)).toBe(false);
		expect(outside.has((await active(tenant)).credentials.accessToken)).toBe(true);
	});
});

describe('disconnecting with several accounts (S4)', () => {
	it('is refused while the retired account has a payment in progress, and deletes every account otherwise', async () => {
		const tenant = await createTenant(ctx, 'switch-disconnect');
		const order = await placeOrder(ctx, tenant);
		await switchAccount(tenant);

		const refused = await disconnect(tenant);
		expect(refused.statusCode).toBe(409);
		// The pending order belongs to the retired account, so the message names no account.
		expect(refused.json().error).toMatchObject({ code: 'payments_in_progress' });
		expect(refused.json().error.message).toMatch(/^Hay 1 pago en curso\. Esperá a que venza \(.+\) para desvincular Mercado Pago\.$/);
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

describe('going back to a previous account (S6)', () => {
	const activate = (tenant: TenantFixture, integrationId: string, requestHeaders = auth) =>
		ctx.app.inject({ method: 'POST', url: `${url(tenant)}/${integrationId}/activate`, headers: requestHeaders });

	/** A tenant switched once: its first account is retired, the second one active. */
	async function switched(label: string) {
		const tenant = await createTenant(ctx, label);
		const old = await active(tenant);
		const next = await switchAccount(tenant);
		return { tenant, old, next, current: await active(tenant) };
	}

	it('makes the previous account active and retires the current one, with credentials untouched, and audits it', async () => {
		const { tenant, old, next, current } = await switched('back-ok');
		const before = await accounts(tenant);
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);

		const response = await activate(tenant, old.id);
		expect(response.statusCode, response.body).toBe(200);
		const listed = (response.json().integrations as { id: string; isActive: boolean }[]).map((integration) => [integration.id, integration.isActive]);
		expect(listed.sort()).toEqual([[old.id, true], [current.id, false]].sort());

		const after = await accounts(tenant);
		const back = after.find((row) => row.id === old.id)!;
		const retired = after.find((row) => row.id === current.id)!;
		expect(back).toMatchObject({
			isActive: true,
			retiredAt: null,
			status: 'verified',
			lastVerifiedAt: ctx.clock.now,
			version: before.find((row) => row.id === old.id)!.version
		});
		expect(retired).toMatchObject({ isActive: false, retiredAt: ctx.clock.now });
		for (const row of after) expect(row.sealedSecrets).toBe(before.find((previous) => previous.id === row.id)!.sealedSecrets);
		expect((await active(tenant)).credentials).toEqual(old.credentials);

		const [event] = await audits(tenant, 'integration.mercadopago_reactivated');
		expect(event).toMatchObject({
			actorId: platformAdmin,
			targetId: old.id,
			metadata: { mode: 'sandbox', collectorId: old.collectorId, retiredIntegrationId: current.id, previousCollectorId: current.collectorId }
		});
		for (const value of [old.credentials.accessToken, old.credentials.webhookSecret, next.accessToken, next.webhookSecret]) {
			expect(JSON.stringify(event)).not.toContain(value);
		}
	});

	it('pins orders created after it to the reactivated account, while earlier orders keep theirs', async () => {
		const tenant = await createTenant(ctx, 'back-pinned');
		const old = await active(tenant);
		const first = await placeOrder(ctx, tenant);
		const next = await switchAccount(tenant);
		const current = await active(tenant);
		const middle = await placeOrder(ctx, tenant);
		expect((await activate(tenant, old.id)).statusCode).toBe(200);
		const last = await placeOrder(ctx, tenant);

		expect((await orderByReference(ctx, tenant, first.reference)).paymentIntegrationId).toBe(old.id);
		expect((await orderByReference(ctx, tenant, middle.reference)).paymentIntegrationId).toBe(current.id);
		expect((await orderByReference(ctx, tenant, last.reference)).paymentIntegrationId).toBe(old.id);
		expect(ctx.simulator.preferences.get(last.preferenceId)!.accessToken).toBe(old.credentials.accessToken);

		// The order of the account just retired is still confirmed with it.
		const payment = ctx.simulator.pay(middle.preferenceId, 'approved');
		expect((await ctx.app.inject(webhookRequest(tenant, payment.id, next.webhookSecret))).statusCode).toBe(200);
		expect((await orderByReference(ctx, tenant, middle.reference)).status).toBe('paid');
	});

	it('changes nothing when Mercado Pago refuses the stored credentials or cannot be reached', async () => {
		const { tenant, old } = await switched('back-refused');
		const before = await accounts(tenant);
		for (const [status, expected] of [
			[401, { statusCode: 400, code: 'credentials_rejected' }],
			[403, { statusCode: 400, code: 'credentials_rejected' }],
			[500, { statusCode: 502, code: 'provider_unreachable' }]
		] as const) {
			const spy = vi.spyOn(ctx.simulator, 'verifyAccount').mockRejectedValueOnce(new ProviderError('refused', status));
			try {
				const response = await activate(tenant, old.id);
				expect(response.statusCode).toBe(expected.statusCode);
				expect(response.json().error.code).toBe(expected.code);
				if (expected.code === 'credentials_rejected') {
					expect(response.json().error.message).toBe(
						`Mercado Pago rechazó las credenciales guardadas de esta cuenta (HTTP ${status}). Para volver a usarla, conectala de nuevo con credenciales nuevas en «Cambiar de cuenta».`
					);
				}
				expect(spy).toHaveBeenCalledWith(old.credentials);
			} finally {
				spy.mockRestore();
			}
		}
		expect(await accounts(tenant)).toEqual(before);
		expect(await audits(tenant, 'integration.mercadopago_reactivated')).toEqual([]);
	});

	it('refuses an account whose credentials now answer for another merchant, and changes nothing', async () => {
		const { tenant, old } = await switched('back-collector');
		const before = await accounts(tenant);
		const spy = vi.spyOn(ctx.simulator, 'verifyAccount').mockResolvedValueOnce({ collectorId: 'another-merchant', nickname: null });
		try {
			const response = await activate(tenant, old.id);
			expect(response.statusCode).toBe(409);
			expect(response.json().error.code).toBe('collector_mismatch');
		} finally {
			spy.mockRestore();
		}
		expect(await accounts(tenant)).toEqual(before);
		expect(await audits(tenant, 'integration.mercadopago_reactivated')).toEqual([]);
	});

	it('answers 404 for an unknown account or another organization account, and 409 for the active one', async () => {
		const { tenant, current } = await switched('back-scope');
		const other = await switched('back-other');
		const before = [await accounts(tenant), await accounts(other.tenant)];
		const verify = vi.spyOn(ctx.simulator, 'verifyAccount');
		try {
			expect((await activate(tenant, other.old.id)).statusCode).toBe(404);
			expect((await activate(tenant, randomUUID())).statusCode).toBe(404);
			const already = await activate(tenant, current.id);
			expect(already.statusCode).toBe(409);
			expect(already.json().error.code).toBe('already_active');
			expect(verify).not.toHaveBeenCalled();
		} finally {
			verify.mockRestore();
		}
		expect([await accounts(tenant), await accounts(other.tenant)]).toEqual(before);
	});

	it('organization roles cannot reactivate an account', async () => {
		const { tenant, old } = await switched('back-roles');
		const before = await accounts(tenant);
		for (const roleHeaders of [await adminHeaders(ctx, tenant), await adminHeaders(ctx, tenant, tenant.operatorId)]) {
			expect((await activate(tenant, old.id, roleHeaders)).statusCode).toBe(403);
		}
		expect(await accounts(tenant)).toEqual(before);
	});

	it('a checkout in progress makes the reactivation wait, and its order stays on the account it started with', async () => {
		const tenant = await createTenant(ctx, 'back-race');
		await openCampaign(ctx, tenant);
		const old = await active(tenant);
		await switchAccount(tenant);
		const current = await active(tenant);
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let locked!: () => void;
		const isLocked = new Promise<void>((resolve) => (locked = resolve));
		// Holds the campaign row, so the checkout waits holding the organization FOR SHARE.
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
		let activatedWhileHeld = false;
		const activating = activate(tenant, old.id).then((response) => {
			activatedWhileHeld = !released;
			return response;
		});
		await new Promise((resolve) => setTimeout(resolve, 400));
		released = true;
		release();
		await holder;
		const placed = await checkout;
		const activated = await activating;
		expect(placed.statusCode, placed.body).toBe(201);
		expect(activated.statusCode, activated.body).toBe(200);
		expect(activatedWhileHeld).toBe(false);

		expect((await orderByReference(ctx, tenant, placed.json().reference)).paymentIntegrationId).toBe(current.id);
		const following = await placeOrder(ctx, tenant);
		expect((await orderByReference(ctx, tenant, following.reference)).paymentIntegrationId).toBe(old.id);
	});

	it('connecting a previous account again with its credentials still rotates it into the active account', async () => {
		const tenant = await createTenant(ctx, 'back-connect');
		const first = await switchAccount(tenant);
		const [, firstRow] = await accounts(tenant);
		await switchAccount(tenant);
		const response = await connect(tenant, first.accessToken, first.webhookSecret);
		expect(response.statusCode, response.body).toBe(200);
		const rows = await accounts(tenant);
		expect(rows).toHaveLength(3);
		expect(rows.filter((row) => row.isActive)).toEqual([expect.objectContaining({ id: firstRow!.id, version: firstRow!.version + 1, retiredAt: null })]);
		const rotated = (await audits(tenant, 'integration.mercadopago_updated')).find(
			(event) => event.targetId === firstRow!.id && event.metadata.version === firstRow!.version + 1
		);
		expect(rotated!.metadata).toMatchObject({ collectorId: simulatorCollectorId(first.accessToken), retiredIntegrationId: rows[2]!.id });
	});
});

describe('webhook with several signing accounts (S7)', () => {
	/** The tenant's first account is retired and the active one shares its webhook secret. */
	async function sharedSecret(label: string) {
		const tenant = await createTenant(ctx, label);
		const order = await placeOrder(ctx, tenant);
		const activeToken = token();
		const response = await connect(tenant, activeToken, tenant.webhookSecret);
		expect(response.statusCode, response.body).toBe(200);
		return { tenant, order, activeToken };
	}
	/** Payment reads fail with a 500 for the tokens `fails` picks, and with a 404 when `missing` is set. */
	const reads = (fails: (accessToken: string) => boolean, missing = false) => {
		const read = ctx.simulator.getPayment;
		return vi.spyOn(ctx.simulator, 'getPayment').mockImplementation(async (credentials, id) => {
			if (fails(credentials.accessToken)) throw new ProviderError('upstream failure', 500);
			if (missing) throw new ProviderError('not found', 404);
			return read(credentials, id);
		});
	};

	it('keeps searching after a provider error from one account and confirms with the account that has the payment', async () => {
		const { tenant, order, activeToken } = await sharedSecret('s7-next');
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		const spy = reads((accessToken) => accessToken === activeToken);
		try {
			expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
		}
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('paid');
		expect((await events(tenant, payment.id)).map((event) => event.outcome)).toEqual(['paid']);
	});

	it('answers 503 when every signing account fails', async () => {
		const { tenant, order } = await sharedSecret('s7-all');
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		const spy = reads(() => true);
		try {
			const response = await ctx.app.inject(webhookRequest(tenant, payment.id));
			expect(response.statusCode).toBe(503);
			expect(response.json()).toEqual({ error: { code: 'provider_unavailable' } });
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
		}
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('pending_payment');
		expect(await events(tenant, payment.id)).toEqual([expect.objectContaining({ outcome: 'provider_error', detail: 'upstream failure' })]);
	});

	it('answers 503 when one account fails and the others do not have the payment', async () => {
		const { tenant, order, activeToken } = await sharedSecret('s7-mixed');
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		const spy = reads((accessToken) => accessToken === activeToken, true);
		try {
			expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(503);
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
		}
		expect((await events(tenant, payment.id)).map((event) => event.outcome)).toEqual(['provider_error']);
	});

	it('every signing account answering 404 is still payment_not_found', async () => {
		const { tenant, order } = await sharedSecret('s7-missing');
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		const spy = reads(() => false, true);
		try {
			expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
		} finally {
			spy.mockRestore();
		}
		expect((await events(tenant, payment.id)).map((event) => event.outcome)).toEqual(['payment_not_found']);
	});

	it('a single signing account that fails still answers 503', async () => {
		const tenant = await createTenant(ctx, 's7-single');
		const order = await placeOrder(ctx, tenant);
		await switchAccount(tenant);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		const spy = reads(() => true);
		try {
			const response = await ctx.app.inject(webhookRequest(tenant, payment.id));
			expect(response.statusCode).toBe(503);
			expect(response.json()).toEqual({ error: { code: 'provider_unavailable' } });
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
		expect(await events(tenant, payment.id)).toEqual([expect.objectContaining({ outcome: 'provider_error', detail: 'upstream failure' })]);
	});
});
