import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, createTestContext, headers, openCampaign, type TenantFixture, type TestContext } from './helpers';

// Owner feedback 2026-11-15b S11: bots must not run public actions in bulk. Each public endpoint
// that costs work or reveals something has its own per-client limit on top of the global one, and
// the client address that keys them is believed only when the web relays it.

let ctx: TestContext;
let tenant: TenantFixture;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'abuse-limits');
	await openCampaign(ctx, tenant);
});
afterAll(() => ctx.close());

/** Status codes of `count` identical requests from one client address. */
async function burst(count: number, request: (client: Record<string, string>) => InjectOptions, ip: string): Promise<number[]> {
	const statuses: number[] = [];
	for (let index = 0; index < count; index++) statuses.push((await ctx.app.inject(request({ 'x-client-ip': ip }))).statusCode);
	return statuses;
}

describe('per-client limits on public actions (S11)', () => {
	it('quotes a cart at most 60 times a minute', async () => {
		const statuses = await burst(
			62,
			(client) => ({ method: 'POST', url: '/checkout/quote', headers: headers(tenant, client), payload: { lines: [{ variantId: tenant.manualVariantId, quantity: 1 }], deliveryMethod: 'digital' } }),
			'198.51.100.10'
		);
		expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
		expect(statuses.slice(60)).toEqual([429, 429]);
	});

	it('asks for download links from Consultar at most 30 times in ten minutes', async () => {
		const statuses = await burst(
			32,
			(client) => ({ method: 'POST', url: '/lookup/downloads', headers: headers(tenant, { ...client, 'x-lookup-token': 'not-a-session-token-at-all' }), payload: { orderId: tenant.campaignId, assetId: tenant.campaignId } }),
			'198.51.100.11'
		);
		expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
		expect(statuses.slice(30)).toEqual([429, 429]);
	});

	it('serves a tracking link at most 60 times a minute', async () => {
		const statuses = await burst(62, (client) => ({ method: 'GET', url: '/public/tracking-links/nope1234', headers: headers(tenant, client) }), '198.51.100.12');
		expect(statuses.slice(0, 60).every((status) => status === 404)).toBe(true);
		expect(statuses.slice(60)).toEqual([429, 429]);
	});

	it('serves a manifest or a candidate list at most 30 times a minute', async () => {
		const statuses = await burst(32, (client) => ({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}/manifest`, headers: headers(tenant, client) }), '198.51.100.13');
		expect(statuses.slice(0, 30).every((status) => status !== 429)).toBe(true);
		expect(statuses.slice(30)).toEqual([429, 429]);
	});

	it('counts a client relayed by the web apart from another one', async () => {
		const other = await burst(1, (client) => ({ method: 'GET', url: '/public/tracking-links/nope1234', headers: headers(tenant, client) }), '198.51.100.99');
		expect(other).toEqual([404]);
	});
});

describe('client address of public routes (S11)', () => {
	it('ignores an address header sent without the internal token, so it cannot dodge a limit', async () => {
		// Webhooks are public: a caller could rotate x-client-ip to get a fresh bucket each time.
		const statuses: number[] = [];
		for (let index = 0; index < 302; index++) {
			const response = await ctx.app.inject({
				method: 'POST',
				url: `/webhooks/mercadopago/${tenant.id}`,
				headers: { 'x-client-ip': `203.0.113.${index % 250}`, 'content-type': 'application/json' },
				payload: {}
			});
			statuses.push(response.statusCode);
		}
		expect(statuses.slice(300)).toEqual([429, 429]);
	});
});
