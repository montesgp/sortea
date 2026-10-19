import { eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, type TenantFixture, type TestContext } from './helpers';

// S2 (feedback 2026-10-18b): the campaign editor chooses the products its page
// shows; with none chosen the page shows every active product.

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
let productIds: Record<string, string>;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'campprod');
	other = await createTenant(ctx, 'campprod-other');
	const rows = await ctx.db.withPlatform((db) => db.select({ id: s.products.id, slug: s.products.slug }).from(s.products).where(eq(s.products.organizationId, tenant.id)));
	productIds = Object.fromEntries(rows.map((row) => [row.slug, row.id]));
});
afterAll(() => ctx.close());

const patch = async (payload: Record<string, unknown>, fixture = tenant) =>
	ctx.app.inject({ method: 'PATCH', url: `/admin/campaigns/${fixture.campaignId}`, headers: await adminHeaders(ctx, fixture), payload });
const publicCampaign = async () => (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}`, headers: headers(tenant) })).json();

describe('products shown on a campaign (S2)', () => {
	it('starts with no choice, which the page reads as every product, and lists the catalog for the editor', async () => {
		expect((await publicCampaign()).productIds).toEqual([]);
		const detail = (await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${tenant.campaignId}`, headers: await adminHeaders(ctx, tenant) })).json();
		expect(detail.productIds).toEqual([]);
		expect(detail.products.map((product: { name: string }) => product.name).sort()).toEqual(['Calcomanía', 'Manual']);
	});

	it('saves the chosen products, once each, and the public page gets them', async () => {
		const response = await patch({ productIds: [productIds.sticker, productIds.sticker] });
		expect(response.statusCode).toBe(200);
		expect(response.json().productIds).toEqual([productIds.sticker]);
		expect((await publicCampaign()).productIds).toEqual([productIds.sticker]);
		const [event] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'campaign.updated')));
		expect(event!.metadata).toMatchObject({ fields: ['productIds'] });
	});

	it('refuses a product of another organization or one that does not exist, and keeps the choice', async () => {
		const [foreign] = await ctx.db.withPlatform((db) => db.select({ id: s.products.id }).from(s.products).where(eq(s.products.organizationId, other.id)));
		for (const id of [foreign!.id, '00000000-0000-4000-8000-000000000000']) {
			const response = await patch({ productIds: [productIds.manual, id] });
			expect(response.statusCode).toBe(400);
			expect(response.json().error).toMatchObject({ code: 'unknown_product', message: 'Elegí productos de tu catálogo' });
		}
		expect((await publicCampaign()).productIds).toEqual([productIds.sticker]);
	});

	it('an empty choice goes back to every product, also once the campaign is open', async () => {
		await ctx.db.withPlatform((db) => db.update(s.campaigns).set({ status: 'open' }).where(eq(s.campaigns.id, tenant.campaignId)));
		expect((await patch({ productIds: [] })).statusCode).toBe(200);
		expect((await publicCampaign()).productIds).toEqual([]);
	});
});
