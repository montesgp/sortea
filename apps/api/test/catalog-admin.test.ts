import { randomUUID } from 'node:crypto';
import { eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, openCampaign, orderByReference, placeOrder, type TenantFixture, type TestContext } from './helpers';

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
const financeId = randomUUID();
const adminId = randomUUID();

interface Product {
	id: string;
	slug: string;
	status: string;
	kind: string;
	kindLocked: boolean;
	variants: { id: string; sku: string; priceMinor: number; currency: string; stock: number | null; active: boolean }[];
}

const asAdmin = () => adminHeaders(ctx, tenant, adminId);

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, auth?: Record<string, string>) {
	return ctx.app.inject({ method, url, headers: auth ?? (await asAdmin()), payload: payload as Record<string, unknown> | undefined });
}

const productBody = (slug: string) => ({ slug, name: 'Guía de mantenimiento', description: 'Guía en PDF para el service de la moto.', kind: 'digital' });
const variantBody = (sku: string, priceMinor = 900_000) => ({ sku, name: 'PDF', priceMinor, stock: null, maxPerOrder: 3 });

async function publicSlugs(target = tenant) {
	const response = await ctx.app.inject({ method: 'GET', url: '/public/products', headers: headers(target) });
	return (response.json().products as { slug: string }[]).map((product) => product.slug);
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'catalog');
	other = await createTenant(ctx, 'catalog-other');
	await ctx.db.withPlatform((db) =>
		db.insert(s.organizationMembers).values([
			{ organizationId: tenant.id, userId: financeId, email: `finance@${tenant.host}`, role: 'finance_manager' },
			{ organizationId: tenant.id, userId: adminId, email: `admin@${tenant.host}`, role: 'org_admin' }
		])
	);
});
afterAll(() => ctx.close());

describe('products (FR-COM-01)', () => {
	let product: Product;

	it('creates products as drafts, invisible to buyers until activated', async () => {
		const created = await call('POST', '/admin/products', { ...productBody(' Guia-Service '), imageUrl: '/tenants/motogarage/taller.jpg' });
		expect(created.statusCode, created.body).toBe(201);
		product = created.json();
		expect(product).toMatchObject({ slug: 'guia-service', status: 'draft', variants: [] });
		expect(await publicSlugs()).not.toContain('guia-service');

		expect((await call('POST', '/admin/products', productBody('guia-service'))).json().error.code).toBe('slug_taken');
		expect((await call('POST', '/admin/products', { ...productBody('x'), imageUrl: 'http://evil.test/a.png' })).statusCode).toBe(400);
	});

	it('only lets owners and admins manage the catalog', async () => {
		const operator = await adminHeaders(ctx, tenant, tenant.operatorId);
		const finance = await adminHeaders(ctx, tenant, financeId);
		expect((await call('POST', '/admin/products', productBody('nope'), operator)).statusCode).toBe(403);
		expect((await call('POST', '/admin/products', productBody('nope'), finance)).statusCode).toBe(403);
		expect((await call('GET', '/admin/products', undefined, operator)).json().canManage).toBe(false);
		expect((await call('POST', '/admin/products', productBody('owner-made'), await adminHeaders(ctx, tenant))).statusCode).toBe(201);
	});

	it('goes on sale only with an active variant, priced in the organization currency', async () => {
		expect((await call('POST', `/admin/products/${product.id}/status`, { status: 'active' })).json().error.code).toBe('needs_active_variant');

		const withVariant = await call('POST', `/admin/products/${product.id}/variants`, { ...variantBody('GUIA-01'), currency: 'USD' });
		expect(withVariant.statusCode, withVariant.body).toBe(201);
		expect(withVariant.json().variants[0]).toMatchObject({ sku: 'GUIA-01', priceMinor: 900_000, currency: 'ARS' });
		expect((await call('POST', `/admin/products/${product.id}/variants`, variantBody('GUIA-01'))).json().error.code).toBe('sku_taken');
		expect((await call('POST', `/admin/products/${product.id}/variants`, variantBody('GUIA-02', 12.5))).statusCode).toBe(400);

		const active = await call('POST', `/admin/products/${product.id}/status`, { status: 'active' });
		expect(active.statusCode).toBe(200);
		product = active.json();
		expect(await publicSlugs()).toContain('guia-service');
	});

	it('changes prices for new checkouts only; existing orders keep their snapshot', async () => {
		const variant = product.variants[0]!;
		const order = await placeOrder(ctx, tenant, { lines: [{ variantId: variant.id, quantity: 2 }], campaignSlug: undefined });
		expect(order.totalMinor).toBe(1_800_000);

		const repriced = await call('PATCH', `/admin/variants/${variant.id}`, { priceMinor: 1_000_000, stock: 5 });
		expect(repriced.statusCode, repriced.body).toBe(200);
		const quote = await ctx.app.inject({ method: 'POST', url: '/checkout/quote', headers: headers(tenant), payload: { lines: [{ variantId: variant.id, quantity: 2 }], delivery: { method: 'digital' } } });
		expect(quote.json().totalMinor).toBe(2_000_000);
		// A line names its product, and the variant when it is called differently (sizes, formats).
		expect(quote.json().lines[0].name).toBe('Guía de mantenimiento · PDF');
		const [item] = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select({ name: s.orderItems.name }).from(s.orderItems).innerJoin(s.orders, eq(s.orders.id, s.orderItems.orderId)).where(eq(s.orders.reference, order.reference))
		);
		expect(item!.name).toBe('Guía de mantenimiento · PDF');
		const manual = await ctx.app.inject({ method: 'POST', url: '/checkout/quote', headers: headers(tenant), payload: { lines: [{ variantId: tenant.manualVariantId, quantity: 1 }], delivery: { method: 'digital' } } });
		expect(manual.json().lines[0].name).toBe('Manual');
		expect((await orderByReference(ctx, tenant, order.reference)).totalMinor).toBe(1_800_000);

		const audits = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'variant.updated')));
		expect(audits.at(-1)!.metadata).toMatchObject({ priceFrom: 900_000, priceTo: 1_000_000, stockFrom: null, stockTo: 5 });
	});

	it('keeps an active product sellable and its kind fixed once ordered', async () => {
		const variant = product.variants[0]!;
		expect((await call('PATCH', `/admin/variants/${variant.id}`, { active: false })).json().error.code).toBe('last_active_variant');
		expect((await call('PATCH', `/admin/variants/${variant.id}`, { availableFrom: '2026-12-01', availableUntil: '2026-11-01' })).statusCode).toBe(400);

		const detail = (await call('GET', `/admin/products/${product.id}`)).json() as Product;
		expect(detail.kindLocked).toBe(true);
		expect((await call('PATCH', `/admin/products/${product.id}`, { kind: 'physical' })).json().error.code).toBe('kind_locked');
		expect((await call('PATCH', `/admin/products/${product.id}`, { name: 'Guía de service completa' })).statusCode).toBe(200);
	});

	it('archives instead of deleting, and an archived product returns as a draft', async () => {
		expect((await call('POST', `/admin/products/${product.id}/status`, { status: 'archived' })).statusCode).toBe(200);
		expect(await publicSlugs()).not.toContain('guia-service');
		expect((await call('POST', `/admin/products/${product.id}/status`, { status: 'active' })).json().error.code).toBe('invalid_transition');
		expect((await call('POST', `/admin/products/${product.id}/status`, { status: 'draft' })).statusCode).toBe(200);
		const [row] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.products).where(eq(s.products.id, product.id)));
		expect(row).toBeDefined();
	});

	it('never reaches another organization’s products (AC-02)', async () => {
		const outsider = await adminHeaders(ctx, other);
		expect((await call('PATCH', `/admin/products/${product.id}`, { name: 'Hackeado' }, outsider)).statusCode).toBe(404);
		expect((await call('PATCH', `/admin/variants/${product.variants[0]!.id}`, { priceMinor: 1 }, outsider)).statusCode).toBe(404);
		const list = (await call('GET', '/admin/products', undefined, outsider)).json().products as { id: string }[];
		expect(list.some((item) => item.id === product.id)).toBe(false);
		// The same slug is free in another organization.
		expect((await call('POST', '/admin/products', productBody('guia-service'), outsider)).statusCode).toBe(201);
	});
});

describe('prizes (FR-CAMP-03, FR-CAMP-06)', () => {
	const prizeBody = { kind: 'product', title: 'Casco firmado', declaredValueMinor: 25_000_000, quantity: 2, alternatesCount: 1 };

	it('adds, edits and removes prizes while the campaign is not open', async () => {
		const owner = await adminHeaders(ctx, tenant);
		const added = await call('POST', `/admin/campaigns/${tenant.campaignId}/prizes`, prizeBody, owner);
		expect(added.statusCode, added.body).toBe(201);
		const prizes = added.json().prizes as { id: string; title: string; position: number; currency: string }[];
		expect(prizes).toHaveLength(4);
		const helmet = prizes.find((prize) => prize.title === 'Casco firmado')!;
		expect(helmet).toMatchObject({ position: 4, currency: 'ARS' });

		const edited = await call('PATCH', `/admin/prizes/${helmet.id}`, { quantity: 3, conditions: 'Retiro en el taller.' }, owner);
		expect(edited.json().prizes.find((prize: { id: string }) => prize.id === helmet.id)).toMatchObject({ quantity: 3, conditions: 'Retiro en el taller.' });

		expect((await call('DELETE', `/admin/prizes/${helmet.id}`, undefined, owner)).json().prizes).toHaveLength(3);
		const audits = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ action: s.auditEvents.action }).from(s.auditEvents).where(eq(s.auditEvents.targetId, tenant.campaignId)));
		expect(audits.map((event) => event.action)).toEqual(expect.arrayContaining(['prize.created', 'prize.updated', 'prize.deleted']));
	});

	it('keeps at least one prize on a published campaign', async () => {
		const owner = await adminHeaders(ctx, tenant);
		const { prizes } = (await call('GET', `/admin/campaigns/${tenant.campaignId}/prizes`, undefined, owner)).json() as { prizes: { id: string }[] };
		expect((await call('DELETE', `/admin/prizes/${prizes[0]!.id}`, undefined, owner)).statusCode).toBe(200);
		expect((await call('DELETE', `/admin/prizes/${prizes[1]!.id}`, undefined, owner)).statusCode).toBe(200);
		expect((await call('DELETE', `/admin/prizes/${prizes[2]!.id}`, undefined, owner)).json().error.code).toBe('last_prize');
	});

	it('freezes prizes once the campaign opens', async () => {
		const owner = await adminHeaders(ctx, tenant);
		await openCampaign(ctx, tenant);
		const view = (await call('GET', `/admin/campaigns/${tenant.campaignId}/prizes`, undefined, owner)).json() as { editable: boolean; prizes: { id: string }[] };
		expect(view.editable).toBe(false);
		expect((await call('POST', `/admin/campaigns/${tenant.campaignId}/prizes`, prizeBody, owner)).json().error.code).toBe('prizes_locked');
		expect((await call('PATCH', `/admin/prizes/${view.prizes[0]!.id}`, { quantity: 99 }, owner)).json().error.code).toBe('prizes_locked');
		expect((await call('DELETE', `/admin/prizes/${view.prizes[0]!.id}`, undefined, owner)).json().error.code).toBe('prizes_locked');
	});

	it('lets operators read prizes but not change them', async () => {
		const operator = await adminHeaders(ctx, tenant, tenant.operatorId);
		expect((await call('GET', `/admin/campaigns/${tenant.campaignId}/prizes`, undefined, operator)).statusCode).toBe(200);
		expect((await call('POST', `/admin/campaigns/${other.campaignId}/prizes`, prizeBody, operator)).statusCode).toBe(403);
	});
});
