import { eq, schema as s } from '@sortea/db';
import { openSecret } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrationOwner } from '../src/payments/integrations';
import {
	adminHeaders,
	createTenant,
	createTestContext,
	headers,
	openCampaign,
	placeOrder,
	webhookRequest,
	type TenantFixture,
	type TestContext
} from './helpers';

let ctx: TestContext;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let paidOrder: Awaited<ReturnType<typeof placeOrder>>;

beforeAll(async () => {
	ctx = await createTestContext();
	tenantA = await createTenant(ctx, 'alpha');
	tenantB = await createTenant(ctx, 'beta');
	await openCampaign(ctx, tenantA);
	paidOrder = await placeOrder(ctx, tenantA);
	const payment = ctx.simulator.pay(paidOrder.preferenceId, 'approved');
	await ctx.app.inject(webhookRequest(tenantA, payment.id));
});
afterAll(() => ctx.close());

/** Reads the OTP the worker would email, straight from the sealed outbox payload. */
async function deliveredCode(tenant: TenantFixture, challengeId: string): Promise<string | null> {
	const [event] = await ctx.db.withTenant(tenant.id, (tx) =>
		tx.select().from(s.outboxEvents).where(eq(s.outboxEvents.dedupeKey, `lookup.otp:${challengeId}`))
	);
	return event ? openSecret(ctx.deps.keyRing, String(event.payload.sealedCode), `otp:${challengeId}`) : null;
}

describe('private lookup (AC-07)', () => {
	it('answers identically for known and unknown documents', async () => {
		const known = await ctx.app.inject({ method: 'POST', url: '/lookup/start', headers: headers(tenantA), payload: { documentType: 'DNI', documentNumber: '30123456' } });
		const unknown = await ctx.app.inject({ method: 'POST', url: '/lookup/start', headers: headers(tenantA), payload: { documentType: 'DNI', documentNumber: '40999888' } });
		expect(known.statusCode).toBe(unknown.statusCode);
		expect(Object.keys(known.json())).toEqual(Object.keys(unknown.json()));
		expect(known.json().message).toBe(unknown.json().message);
		expect(await deliveredCode(tenantA, unknown.json().challengeId)).toBeNull();
	});

	it('grants access only with the code sent to the buyer', async () => {
		const start = await ctx.app.inject({ method: 'POST', url: '/lookup/start', headers: headers(tenantA), payload: { documentType: 'DNI', documentNumber: '30.123.456' } });
		const { challengeId } = start.json();
		const wrong = await ctx.app.inject({ method: 'POST', url: '/lookup/verify', headers: headers(tenantA), payload: { challengeId, code: '000000' } });
		expect(wrong.statusCode).toBe(400);

		const code = await deliveredCode(tenantA, challengeId);
		const verified = await ctx.app.inject({ method: 'POST', url: '/lookup/verify', headers: headers(tenantA), payload: { challengeId, code } });
		expect(verified.statusCode).toBe(200);

		const me = await ctx.app.inject({ method: 'GET', url: '/lookup/me', headers: headers(tenantA, { 'x-lookup-token': verified.json().token }) });
		const body = me.json();
		expect(body.orders.some((order: { reference: string }) => order.reference === paidOrder.reference)).toBe(true);
		expect(body.campaigns[0].entries).toHaveLength(2);
		expect(JSON.stringify(body)).not.toContain('30123456');

		const reused = await ctx.app.inject({ method: 'POST', url: '/lookup/verify', headers: headers(tenantA), payload: { challengeId, code } });
		expect(reused.statusCode).toBe(400);
	});

	it('locks a challenge after five wrong codes, even if the sixth is right', async () => {
		const start = await ctx.app.inject({ method: 'POST', url: '/lookup/start', headers: headers(tenantA), payload: { documentType: 'DNI', documentNumber: '30123456' } });
		const { challengeId } = start.json();
		const code = await deliveredCode(tenantA, challengeId);
		for (let attempt = 0; attempt < 5; attempt++) {
			await ctx.app.inject({ method: 'POST', url: '/lookup/verify', headers: headers(tenantA), payload: { challengeId, code: code === '111111' ? '222222' : '111111' } });
		}
		const late = await ctx.app.inject({ method: 'POST', url: '/lookup/verify', headers: headers(tenantA), payload: { challengeId, code } });
		expect(late.statusCode).toBe(400);
	});

	it('rate limits lookup starts per client', async () => {
		const client = { 'x-client-ip': '203.0.113.7' };
		const statuses = [];
		for (let attempt = 0; attempt < 7; attempt++) {
			const response = await ctx.app.inject({ method: 'POST', url: '/lookup/start', headers: headers(tenantA, client), payload: { documentType: 'DNI', documentNumber: `4000000${attempt}` } });
			statuses.push(response.statusCode);
		}
		expect(statuses.slice(0, 5)).toEqual(Array(5).fill(200));
		expect(statuses.slice(5)).toEqual([429, 429]);
	});

	it('issues downloads only for paid orders of the session holder', async () => {
		const session = await ctx.app.inject({
			method: 'POST',
			url: '/lookup/receipt',
			headers: headers(tenantA),
			payload: { reference: paidOrder.reference, accessCode: paidOrder.accessCode }
		});
		const token = session.json().token;
		const me = (await ctx.app.inject({ method: 'GET', url: '/lookup/me', headers: headers(tenantA, { 'x-lookup-token': token }) })).json();
		expect(me.holder.scope).toBe('order');
		const order = me.orders[0];
		const grant = await ctx.app.inject({
			method: 'POST',
			url: '/lookup/downloads',
			headers: headers(tenantA, { 'x-lookup-token': token }),
			payload: { orderId: order.id, assetId: order.downloads[0].assetId }
		});
		const download = await ctx.app.inject({ method: 'GET', url: `/downloads/${grant.json().token}`, headers: headers(tenantA) });
		expect(download.json().url).toMatch(/^https:\/\/storage\.test\//);
	});
});

describe('tenant isolation (AC-02)', () => {
	it('a receipt from tenant A is unknown on tenant B', async () => {
		const response = await ctx.app.inject({
			method: 'POST',
			url: '/checkout/orders/status',
			headers: headers(tenantB),
			payload: { reference: paidOrder.reference, accessCode: paidOrder.accessCode }
		});
		expect(response.statusCode).toBe(404);
	});

	it('an admin of A cannot use B by changing the hostname', async () => {
		const response = await ctx.app.inject({
			method: 'GET',
			url: '/admin/orders',
			headers: { ...headers(tenantB), authorization: (await adminHeaders(ctx, tenantA)).authorization }
		});
		expect(response.statusCode).toBe(403);
	});

	it('a webhook for A sent to B is rejected by B’s secret', async () => {
		const order = await placeOrder(ctx, tenantA);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		const request = webhookRequest(tenantA, payment.id);
		const crossed = await ctx.app.inject({ ...request, url: request.url.replace(tenantA.id, tenantB.id) });
		expect(crossed.statusCode).toBe(401);
	});

	it('B’s credentials cannot read A’s payment even with a valid B signature', async () => {
		const order = await placeOrder(ctx, tenantA);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		const response = await ctx.app.inject(webhookRequest(tenantB, payment.id));
		expect(response.statusCode).toBe(200);
		const [row] = await ctx.db.withTenant(tenantB.id, (tx) => tx.select().from(s.paymentEvents).where(eq(s.paymentEvents.providerPaymentId, payment.id)));
		expect(row?.outcome).toBe('payment_not_found');
	});

	it('requires the internal token for everything except webhooks', async () => {
		const response = await ctx.app.inject({ method: 'GET', url: '/public/site', headers: { 'x-tenant-host': tenantA.host } });
		expect(response.statusCode).toBe(401);
	});

	it('unknown hostnames resolve to nothing', async () => {
		const response = await ctx.app.inject({ method: 'GET', url: '/public/site', headers: headers({ host: 'evil.test' }) });
		expect(response.statusCode).toBe(404);
	});
});

describe('platform credentials (AC-05)', () => {
	it('stores Mercado Pago secrets sealed and never returns them', async () => {
		const platformAdmin = '00000000-0000-4000-8000-00000000a001';
		await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: platformAdmin, email: 'staff@test' }).onConflictDoNothing());
		const auth = { 'x-internal-token': headers(tenantA)['x-internal-token'], authorization: `Bearer ${await ctx.signAdmin(platformAdmin, 'staff@test')}` };
		// Saving checks the token with the provider; the test simulator accepts TEST- tokens only.
		const accessToken = 'TEST-1234567890-secret-value-abcdef';
		const response = await ctx.app.inject({
			method: 'PUT',
			url: `/platform/organizations/${tenantB.id}/integrations/mercadopago`,
			headers: auth,
			payload: { mode: 'sandbox', accessToken, webhookSecret: 'whsec-sandbox-0123456789' }
		});
		expect(response.statusCode).toBe(200);
		expect(response.body).not.toContain(accessToken);
		expect(response.body).not.toContain('whsec-sandbox');
		expect(response.json().integrations.find((integration: { mode: string }) => integration.mode === 'sandbox').secretHint).toBe('TEST••••cdef');

		const [row] = await ctx.db.withPlatform((db) => db.select().from(s.organizationIntegrations).where(eq(s.organizationIntegrations.secretHint, 'TEST••••cdef')));
		expect(row!.sealedSecrets).not.toContain(accessToken);
		expect(JSON.parse(openSecret(ctx.deps.keyRing, row!.sealedSecrets, integrationOwner(tenantB.id, row!.id))).accessToken).toBe(accessToken);
	});

	it('tenant admins cannot reach platform routes', async () => {
		const response = await ctx.app.inject({ method: 'GET', url: '/platform/organizations', headers: await adminHeaders(ctx, tenantA) });
		expect(response.statusCode).toBe(403);
	});
});
