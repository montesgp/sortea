import { randomUUID } from 'node:crypto';
import { and, eq, schema as s } from '@sortea/db';
import { computeEntryAllocation } from '@sortea/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	adminHeaders,
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

/**
 * Chances per product (S5): configured per variant in the campaign rules while
 * they are editable, frozen when the campaign opens, and shown to buyers only
 * from the locked rules (FR-CAMP-05/06, AC-08).
 */
let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'chances');
	other = await createTenant(ctx, 'chances-other');
});
afterAll(() => ctx.close());

const rulesUrl = () => `/admin/campaigns/${tenant.campaignId}/rules`;

async function storedRules() {
	const rows = await ctx.db.withTenant(tenant.id, (tx) =>
		tx.select().from(s.campaignRuleVersions).where(eq(s.campaignRuleVersions.campaignId, tenant.campaignId))
	);
	return rows.map((row) => ({ version: row.version, status: row.status, entryRule: row.entryRule, bodyMarkdown: row.bodyMarkdown }));
}

async function quote(lines: { variantId: string; quantity: number }[], campaignSlug?: string) {
	const response = await ctx.app.inject({ method: 'POST', url: '/checkout/quote', headers: headers(tenant), payload: { lines, campaignSlug } });
	expect(response.statusCode).toBe(200);
	return response.json();
}

describe('chances in the campaign editor', () => {
	it('lists every variant of the organization to configure, and only those', async () => {
		const detail = (await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${tenant.campaignId}`, headers: await adminHeaders(ctx, tenant) })).json();
		expect(detail.chanceVariants.map((variant: { id: string; productName: string; name: string }) => [variant.productName, variant.name]).sort()).toEqual([
			['Calcomanía', 'Calcomanía'],
			['Manual', 'Manual']
		]);
		expect(detail.chanceVariants.some((variant: { id: string }) => variant.id === other.manualVariantId)).toBe(false);
	});

	it('saves chances per unit into the editable rules without retyping the text; zero means the variant does not participate', async () => {
		const before = await storedRules();
		const response = await ctx.app.inject({
			method: 'PUT',
			url: rulesUrl(),
			headers: await adminHeaders(ctx, tenant),
			payload: { entriesPerUnit: { [tenant.manualVariantId]: 3, [tenant.stickerVariantId]: 0 }, maxEntriesPerIdentity: 50 }
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().rules[0].entryRule).toEqual({ mode: 'per_unit', entriesPerUnit: { [tenant.manualVariantId]: 3 }, maxEntriesPerIdentity: 50 });
		const after = await storedRules();
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({ version: 1, status: 'draft', bodyMarkdown: before[0]!.bodyMarkdown });
	});

	it('rejects variants of another organization or unknown ids and leaves the rules unchanged', async () => {
		const auth = await adminHeaders(ctx, tenant);
		const before = await storedRules();
		for (const variantId of [other.manualVariantId, '00000000-0000-4000-8000-000000000000']) {
			const response = await ctx.app.inject({ method: 'PUT', url: rulesUrl(), headers: auth, payload: { entriesPerUnit: { [tenant.manualVariantId]: 2, [variantId]: 1 } } });
			expect(response.statusCode).toBe(400);
			expect(response.json().error.code).toBe('unknown_variant');
		}
		expect(await storedRules()).toEqual(before);
	});

	it('accepts only whole chances from 0 to 100', async () => {
		const auth = await adminHeaders(ctx, tenant);
		const before = await storedRules();
		for (const chances of [101, -1, 1.5]) {
			const response = await ctx.app.inject({ method: 'PUT', url: rulesUrl(), headers: auth, payload: { entriesPerUnit: { [tenant.manualVariantId]: chances } } });
			expect(response.statusCode).toBe(400);
		}
		expect(await storedRules()).toEqual(before);
	});

	it('uses the rules permission: an operator cannot change chances', async () => {
		const response = await ctx.app.inject({
			method: 'PUT',
			url: rulesUrl(),
			headers: await adminHeaders(ctx, tenant, tenant.operatorId),
			payload: { entriesPerUnit: { [tenant.manualVariantId]: 9 } }
		});
		expect(response.statusCode).toBe(403);
	});

	it('the product shows which campaigns grant chances and how many per unit', async () => {
		const product = (
			await ctx.app.inject({ method: 'GET', url: `/admin/products/${(await productIdOf(tenant.manualVariantId))}`, headers: await adminHeaders(ctx, tenant) })
		).json();
		expect(product.chances).toEqual([
			{
				campaignId: tenant.campaignId,
				campaignTitle: 'Moto 0 km',
				campaignStatus: 'published',
				locked: false,
				perUnit: { [tenant.manualVariantId]: 3 }
			}
		]);
		const sticker = (
			await ctx.app.inject({ method: 'GET', url: `/admin/products/${(await productIdOf(tenant.stickerVariantId))}`, headers: await adminHeaders(ctx, tenant) })
		).json();
		expect(sticker.chances).toEqual([]);
	});
});

describe('chances shown to buyers', () => {
	it('shows nothing while the rules are not locked: buying more does not presume more chances (FR-CAMP-05)', async () => {
		const products = (await ctx.app.inject({ method: 'GET', url: '/public/products', headers: headers(tenant) })).json();
		expect(products.chances).toBeNull();
		const detail = (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}`, headers: headers(tenant) })).json();
		expect(detail.chancesPerUnit).toEqual({});
		expect((await quote([{ variantId: tenant.manualVariantId, quantity: 2 }], tenant.campaignSlug)).chances).toBeNull();
	});

	it('once open, exposes the locked chances per unit for the campaign accepting participations', async () => {
		await openCampaign(ctx, tenant);
		const products = (await ctx.app.inject({ method: 'GET', url: '/public/products', headers: headers(tenant) })).json();
		expect(products.chances).toEqual({ campaign: { slug: tenant.campaignSlug, title: 'Moto 0 km' }, perUnit: { [tenant.manualVariantId]: 3 }, maxPerIdentity: 50 });
		const detail = (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}`, headers: headers(tenant) })).json();
		expect(detail.chancesPerUnit).toEqual({ [tenant.manualVariantId]: 3 });
		expect(detail.maxChancesPerIdentity).toBe(50);
	});

	it('the cart quote counts chances on the server with the locked rule: two units give double', async () => {
		const one = await quote([{ variantId: tenant.manualVariantId, quantity: 1 }]);
		const lines = [
			{ variantId: tenant.manualVariantId, quantity: 2 },
			{ variantId: tenant.stickerVariantId, quantity: 1 }
		];
		const two = await quote(lines, tenant.campaignSlug);
		expect(one.chances.total).toBe(3);
		expect(two.chances).toEqual({
			campaign: { slug: tenant.campaignSlug, title: 'Moto 0 km' },
			lines: [
				{ variantId: tenant.manualVariantId, chances: 6 },
				{ variantId: tenant.stickerVariantId, chances: 0 }
			],
			total: computeEntryAllocation({ mode: 'per_unit', entriesPerUnit: { [tenant.manualVariantId]: 3 }, maxEntriesPerIdentity: 50 }, lines, 0),
			maxPerIdentity: 50,
			// Coupons left in the pool (ADR 0014 §1); coupon-pool.test.ts checks the count.
			remaining: expect.any(Number)
		});
		expect(two.chances.total).toBe(2 * one.chances.total);
	});

	it('a purchase from the shop (no campaign chosen) earns the chances the cart showed', async () => {
		const shown = await quote([{ variantId: tenant.manualVariantId, quantity: 2 }]);
		const order = await placeOrder(ctx, tenant, { campaignSlug: undefined });
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		await ctx.app.inject(webhookRequest(tenant, payment.id));
		const status = (
			await ctx.app.inject({ method: 'POST', url: '/checkout/orders/status', headers: headers(tenant), payload: { reference: order.reference, accessCode: order.accessCode } })
		).json();
		expect(status.status).toBe('paid');
		expect(status.entries).toHaveLength(shown.chances.total);
	});

	it('AC-08: after opening, chances cannot change silently', async () => {
		const before = await storedRules();
		const response = await ctx.app.inject({
			method: 'PUT',
			url: rulesUrl(),
			headers: await adminHeaders(ctx, tenant),
			payload: { entriesPerUnit: { [tenant.manualVariantId]: 10 } }
		});
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe('rules_locked_requires_material_change_process');
		expect(await storedRules()).toEqual(before);
		expect((await quote([{ variantId: tenant.manualVariantId, quantity: 1 }])).chances.total).toBe(3);
	});
});

describe('a stale campaign named by the cart', () => {
	// The cart cookie keeps the slug of the campaign page the buyer added from; that campaign can close later.
	it('quotes the campaign accepting participations, the same one the shop card names', async () => {
		await ctx.db.withTenant(tenant.id, (tx) =>
			tx.insert(s.campaigns).values({
				organizationId: tenant.id,
				slug: 'vieja',
				title: 'Campaña anterior',
				summary: 'Ya cerró',
				status: 'closed',
				timezone: 'America/Argentina/Buenos_Aires',
				opensAt: new Date('2026-08-01T00:00:00Z'),
				closesAt: new Date('2026-09-01T00:00:00Z')
			})
		);
		const lines = [{ variantId: tenant.manualVariantId, quantity: 2 }];
		const current = await quote(lines);
		expect(current.chances.campaign.slug).toBe(tenant.campaignSlug);
		expect((await quote(lines, 'vieja')).chances).toEqual(current.chances);
		expect((await quote(lines, 'no-existe')).chances).toEqual(current.chances);
	});

	it('links the order to the current campaign and its locked rule, so it earns the chances quoted', async () => {
		const locked = (await storedRules()).find((rule) => rule.status === 'locked')!;
		const [lockedRow] = await ctx.db.withTenant(tenant.id, (tx) =>
			tx
				.select({ id: s.campaignRuleVersions.id })
				.from(s.campaignRuleVersions)
				.where(and(eq(s.campaignRuleVersions.campaignId, tenant.campaignId), eq(s.campaignRuleVersions.version, locked.version)))
		);
		for (const campaignSlug of ['vieja', 'no-existe']) {
			const order = await orderByReference(ctx, tenant, (await placeOrder(ctx, tenant, { campaignSlug })).reference);
			expect({ campaignId: order.campaignId, ruleVersionId: order.ruleVersionId }).toEqual({ campaignId: tenant.campaignId, ruleVersionId: lockedRow!.id });
		}
	});
});

describe('rules superseded while a payment is pending', () => {
	it('keeps allocating nothing under the old rule, but leaves an audit trail', async () => {
		const order = await placeOrder(ctx, tenant, { campaignSlug: undefined, buyer: { documentType: 'DNI', documentNumber: '31.555.444', firstName: 'Ana', lastName: 'Gómez', email: 'ana@example.com', province: 'Córdoba', city: 'Río Cuarto' } });
		const announced = await ctx.app.inject({
			method: 'PUT',
			url: rulesUrl(),
			headers: await adminHeaders(ctx, tenant),
			payload: { entriesPerUnit: { [tenant.manualVariantId]: 4 }, announcement: 'Se suma una chance por manual.' }
		});
		expect(announced.statusCode).toBe(200);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		await ctx.app.inject(webhookRequest(tenant, payment.id));
		const status = (
			await ctx.app.inject({ method: 'POST', url: '/checkout/orders/status', headers: headers(tenant), payload: { reference: order.reference, accessCode: order.accessCode } })
		).json();
		expect(status.status).toBe('paid');
		expect(status.entries).toHaveLength(0);
		const row = await orderByReference(ctx, tenant, order.reference);
		const audits = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.action, 'entries.not_allocated'), eq(s.auditEvents.targetId, row.id)))
		);
		expect(audits).toHaveLength(1);
		expect(audits[0]!.metadata).toMatchObject({ reason: 'rule_superseded', ruleVersionId: row.ruleVersionId });
	});
});

describe('chances table of the campaign editor', () => {
	it('lists active variants of active products, plus hidden variants that already grant chances', async () => {
		const list = await createTenant(ctx, 'chances-list');
		const ids = { archived: randomUUID(), draft: randomUUID(), retired: randomUUID(), retiredWithChances: randomUUID() };
		const products = { archived: randomUUID(), draft: randomUUID() };
		const manualProduct = await productIdIn(list, list.manualVariantId);
		await ctx.db.withTenant(list.id, async (tx) => {
			await tx.insert(s.products).values([
				{ id: products.archived, organizationId: list.id, slug: 'viejo', name: 'Archivado', description: 'x', kind: 'digital', status: 'archived' },
				{ id: products.draft, organizationId: list.id, slug: 'borrador', name: 'Borrador', description: 'x', kind: 'digital', status: 'draft' }
			]);
			await tx.insert(s.productVariants).values([
				{ id: ids.archived, organizationId: list.id, productId: products.archived, sku: 'A', name: 'Archivado', priceMinor: 100 },
				{ id: ids.draft, organizationId: list.id, productId: products.draft, sku: 'D', name: 'Borrador', priceMinor: 100 },
				{ id: ids.retired, organizationId: list.id, productId: manualProduct, sku: 'R1', name: 'Edición retirada', priceMinor: 100, active: false },
				{ id: ids.retiredWithChances, organizationId: list.id, productId: manualProduct, sku: 'R2', name: 'Edición con chances', priceMinor: 100, active: false }
			]);
		});
		const auth = await adminHeaders(ctx, list);
		const saved = await ctx.app.inject({
			method: 'PUT',
			url: `/admin/campaigns/${list.campaignId}/rules`,
			headers: auth,
			payload: { entriesPerUnit: { [list.manualVariantId]: 1, [ids.retiredWithChances]: 2 } }
		});
		expect(saved.statusCode).toBe(200);
		const detail = (await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${list.campaignId}`, headers: auth })).json();
		expect(detail.chanceVariants.map((variant: { id: string }) => variant.id).sort()).toEqual(
			[list.manualVariantId, list.stickerVariantId, ids.retiredWithChances].sort()
		);
	});
});

describe('two open campaigns closing at the same time', () => {
	it('counts purchases for the same one every time: ties break by id', async () => {
		const tie = await createTenant(ctx, 'chances-tie');
		// A lower id than the fixture's, inserted and opened later.
		const secondId = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
		await ctx.db.withTenant(tie.id, async (tx) => {
			const [fixture] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, tie.campaignId));
			await tx.insert(s.campaigns).values({ ...fixture!, id: secondId, slug: 'moto-b', title: 'Moto B', createdAt: undefined, updatedAt: undefined } as typeof s.campaigns.$inferInsert);
			await tx.insert(s.campaignApprovals).values([
				{ organizationId: tie.id, campaignId: secondId, kind: 'legal' },
				{ organizationId: tie.id, campaignId: secondId, kind: 'psp' }
			]);
			await tx.insert(s.campaignRuleVersions).values({
				organizationId: tie.id,
				campaignId: secondId,
				version: 1,
				bodyMarkdown: 'Bases de prueba con texto suficiente.',
				eligibility: { minAge: 18, residency: 'AR', excluded: [] },
				entryRule: { mode: 'per_unit', entriesPerUnit: { [tie.manualVariantId]: 5 }, maxEntriesPerIdentity: null }
			});
			await tx.insert(s.prizes).values({ organizationId: tie.id, campaignId: secondId, position: 1, kind: 'product', title: 'Kit', declaredValueMinor: 5_000_000, quantity: 1 });
		});
		await openCampaign(ctx, tie);
		await openCampaign(ctx, { ...tie, campaignId: secondId });
		const products = (await ctx.app.inject({ method: 'GET', url: '/public/products', headers: headers(tie) })).json();
		expect(products.chances.campaign.slug).toBe('moto-b');
	});
});

async function productIdIn(target: TenantFixture, variantId: string): Promise<string> {
	const [variant] = await ctx.db.withTenant(target.id, (tx) => tx.select().from(s.productVariants).where(eq(s.productVariants.id, variantId)));
	return variant!.productId;
}

async function productIdOf(variantId: string): Promise<string> {
	const [variant] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.productVariants).where(eq(s.productVariants.id, variantId)));
	return variant!.productId;
}
