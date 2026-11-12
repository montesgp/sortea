import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../src/payments/provider';
import { createTenant, createTestContext, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

// Owner feedback 2026-11-11b S9 (T2): a rejected Mercado Pago notification must show in the
// service logs, not only in app.payment_events, without secrets, signatures or buyer data.

let ctx: TestContext;
let tenant: TenantFixture;
const lines: string[] = [];

type Entry = { level: number; msg?: string; organizationId?: string; topic?: string; dataId?: string; requestId?: string; outcome?: string; reason?: string; orderReference?: string };

const webhookEntries = () => lines.map((line) => JSON.parse(line) as Entry).filter((entry) => entry.msg?.startsWith('mercadopago webhook'));

beforeAll(async () => {
	ctx = await createTestContext({ logStream: { write: (line) => void lines.push(line) } });
	tenant = await createTenant(ctx, 'whlogs');
	await openCampaign(ctx, tenant);
});
afterAll(() => ctx.close());

describe('webhook logs (S9)', () => {
	it('a notification with a bad signature is logged at warn with its reason and no secret, signature or buyer data', async () => {
		const order = await placeOrder(ctx, tenant);
		ctx.simulator.pay(order.checkoutId, 'approved');
		const request = webhookRequest(tenant, order.checkoutId, 'not-the-secret');
		lines.length = 0;
		const response = await ctx.app.inject(request);
		expect(response.statusCode).toBe(401);

		expect(webhookEntries()).toEqual([
			expect.objectContaining({
				level: 40,
				msg: 'mercadopago webhook rejected',
				organizationId: tenant.id,
				topic: 'order',
				dataId: order.checkoutId,
				requestId: request.headers['x-request-id'],
				outcome: 'rejected_signature',
				reason: 'bad_signature'
			})
		]);
		const v1 = request.headers['x-signature'].split('v1=')[1]!;
		const all = lines.join('\n');
		expect(all).not.toContain(v1);
		expect(all).not.toContain(tenant.webhookSecret);
		expect(all).not.toMatch(/juana@example\.com|Pérez|30123456|TEST-/);
	});

	it('a notification without a signature header is logged at warn as missing_header', async () => {
		const order = await placeOrder(ctx, tenant);
		const request = webhookRequest(tenant, order.checkoutId);
		lines.length = 0;
		const response = await ctx.app.inject({ ...request, headers: { 'x-request-id': request.headers['x-request-id'] } });
		expect(response.statusCode).toBe(401);
		expect(webhookEntries()).toEqual([expect.objectContaining({ level: 40, outcome: 'rejected_signature', reason: 'missing_header', dataId: order.checkoutId })]);
	});

	it('a paid order is logged at info with its order reference', async () => {
		const order = await placeOrder(ctx, tenant);
		ctx.simulator.pay(order.checkoutId, 'approved');
		const request = webhookRequest(tenant, order.checkoutId);
		lines.length = 0;
		const response = await ctx.app.inject(request);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ ok: true });

		expect(webhookEntries()).toEqual([
			expect.objectContaining({
				level: 30,
				msg: 'mercadopago webhook applied',
				organizationId: tenant.id,
				topic: 'order',
				dataId: order.checkoutId,
				requestId: request.headers['x-request-id'],
				outcome: 'paid',
				orderReference: order.reference
			})
		]);
		expect(lines.join('\n')).not.toMatch(/juana@example\.com|Pérez|30123456|TEST-/);
	});

	it('a provider failure while reading the order is logged at warn with the provider message', async () => {
		const order = await placeOrder(ctx, tenant);
		const reads = vi.spyOn(ctx.simulator, 'getOrder').mockRejectedValue(new ProviderError('Mercado Pago order read failed (500)', 500));
		lines.length = 0;
		try {
			const response = await ctx.app.inject(webhookRequest(tenant, order.checkoutId));
			expect(response.statusCode).toBe(503);
		} finally {
			reads.mockRestore();
		}
		expect(webhookEntries()).toEqual([
			expect.objectContaining({ level: 40, msg: 'mercadopago webhook rejected', outcome: 'provider_error', reason: 'Mercado Pago order read failed (500)', dataId: order.checkoutId })
		]);
	});

	it('an order no signing account has is logged at warn as payment_not_found', async () => {
		lines.length = 0;
		const response = await ctx.app.inject(webhookRequest(tenant, 'ORDSIMNOTHERE0001'));
		expect(response.statusCode).toBe(200);
		expect(webhookEntries()).toEqual([expect.objectContaining({ level: 40, outcome: 'payment_not_found', dataId: 'ORDSIMNOTHERE0001' })]);
	});

	it('an organization without a Mercado Pago account is logged at warn and still answers 404', async () => {
		const bare = await createTenant(ctx, 'whbare', { mercadoPago: false });
		lines.length = 0;
		const response = await ctx.app.inject(webhookRequest(bare, 'ORDSIMANY0001'));
		expect(response.statusCode).toBe(404);
		expect(webhookEntries()).toEqual([expect.objectContaining({ level: 40, organizationId: bare.id, outcome: 'no_payment_account', dataId: 'ORDSIMANY0001' })]);
	});

	it('a notification of another topic is not logged as a rejection', async () => {
		const order = await placeOrder(ctx, tenant);
		lines.length = 0;
		const response = await ctx.app.inject(webhookRequest(tenant, order.checkoutId, tenant.webhookSecret, 'payment'));
		expect(response.statusCode).toBe(200);
		expect(webhookEntries().filter((entry) => entry.level >= 40)).toEqual([]);
	});
});
