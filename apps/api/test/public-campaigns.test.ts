import { and, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, createTestContext, headers, type TenantFixture, type TestContext } from './helpers';

let ctx: TestContext;
let tenant: TenantFixture;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'pubcamp');
	await ctx.db.withPlatform((db) => db.update(s.prizes).set({ imageUrl: 'https://cdn.example.com/moto.jpg' }).where(and(eq(s.prizes.campaignId, tenant.campaignId), eq(s.prizes.position, 1))));
});
afterAll(() => ctx.close());

describe('public campaign list (S8)', () => {
	it('lists the prizes of each campaign with only their public face', async () => {
		const response = await ctx.app.inject({ method: 'GET', url: '/public/campaigns', headers: headers(tenant) });
		expect(response.statusCode).toBe(200);
		const [campaign] = response.json().campaigns;
		expect(campaign.slug).toBe(tenant.campaignSlug);
		expect(campaign.prizes).toEqual([
			{ position: 1, kind: 'vehicle', title: 'Moto', quantity: 1, imageUrl: 'https://cdn.example.com/moto.jpg' },
			{ position: 2, kind: 'cash', title: '$100.000', quantity: 10, imageUrl: null },
			{ position: 3, kind: 'product', title: 'Kit', quantity: 5, imageUrl: null }
		]);
		expect(campaign.mainPrize).toBe('Moto');
		expect(campaign.prizeCount).toBe(16);
		// Nothing internal: no ids, tenants, alternates or rules.
		const body = response.body;
		expect(body).not.toContain(tenant.id);
		expect(body).not.toContain(tenant.campaignId);
		expect(body).not.toMatch(/organizationId|alternatesCount|campaignId|"id"/);
	});
});
