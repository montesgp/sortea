import { randomUUID } from 'node:crypto';
import { and, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, checkoutBody, createTenant, createTestContext, headers, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

// S10 (odd/tasks/owner-feedback-2026-11-10.md): a product nobody ordered is deleted for good from
// the list; one with orders is archived, so its buyers' receipts and downloads keep working; one a
// campaign may still sell is refused until it leaves the campaign.

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'removal');
	other = await createTenant(ctx, 'removal-other');
});
afterAll(() => ctx.close());

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, auth?: Record<string, string>) {
	return ctx.app.inject({ method, url, headers: auth ?? (await adminHeaders(ctx, tenant)), payload: payload as Record<string, unknown> | undefined });
}

/** A digital product on sale with one variant and one file, as `pnpm db:product-file` leaves it. */
async function digitalProduct(slug: string) {
	const created = await call('POST', '/admin/products', { slug, name: `Guía ${slug}`, description: 'Guía en PDF para el service.', kind: 'digital' });
	expect(created.statusCode, created.body).toBe(201);
	const productId = created.json().id as string;
	const variant = await call('POST', `/admin/products/${productId}/variants`, { sku: slug.toUpperCase(), name: 'PDF', priceMinor: 500_000, stock: null, maxPerOrder: 3 });
	const variantId = variant.json().variants[0].id as string;
	expect((await call('POST', `/admin/products/${productId}/status`, { status: 'active' })).statusCode).toBe(200);
	const storagePath = `${tenant.id}/${productId}/0123456789abcdef.pdf`;
	await ctx.db.withTenant(tenant.id, (tx) =>
		tx.insert(s.productAssets).values({ organizationId: tenant.id, productId, storagePath, filename: `${slug}.pdf`, contentType: 'application/pdf', sizeBytes: 2048 })
	);
	return { productId, variantId, storagePath };
}

async function productRow(target: TenantFixture, id: string) {
	const [row] = await ctx.db.withTenant(target.id, (tx) => tx.select().from(s.products).where(eq(s.products.id, id)));
	return row ?? null;
}

async function audits(action: string, targetId: string) {
	return ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.action, action), eq(s.auditEvents.targetId, targetId))));
}

async function publicSlugs() {
	const response = await ctx.app.inject({ method: 'GET', url: '/public/products', headers: headers(tenant) });
	return (response.json().products as { slug: string }[]).map((product) => product.slug);
}

async function listIds(query = '') {
	const response = await call('GET', `/admin/products${query}`);
	expect(response.statusCode, response.body).toBe(200);
	return response.json() as { archivedCount: number; products: { id: string; status: string }[] };
}

describe('deleting a product nobody ordered (S10)', () => {
	it('previews the outcome, then deletes the product, its variants, offers and file', async () => {
		const { productId, variantId, storagePath } = await digitalProduct('borrable');
		const [offer] = await ctx.db.withTenant(tenant.id, async (tx) => {
			const rows = await tx.insert(s.offers).values({ organizationId: tenant.id, kind: 'upsell', anchorProductId: productId, title: 'Llevá también' }).returning({ id: s.offers.id });
			await tx.insert(s.offerItems).values({ organizationId: tenant.id, offerId: rows[0]!.id, variantId });
			return rows;
		});

		const preview = await call('GET', `/admin/products/${productId}/removal`);
		expect(preview.statusCode, preview.body).toBe(200);
		expect(preview.json()).toMatchObject({ outcome: 'delete', product: { id: productId, name: 'Guía borrable', status: 'active' } });
		expect(preview.json().message).toContain('se elimina definitivamente');

		const removed = await call('DELETE', `/admin/products/${productId}`);
		expect(removed.statusCode, removed.body).toBe(200);
		expect(removed.json()).toMatchObject({ outcome: 'deleted' });
		expect(removed.json().message).toBe('Producto eliminado: Guía borrable');

		expect(await productRow(tenant, productId)).toBeNull();
		const leftovers = await ctx.db.withTenant(tenant.id, async (tx) => ({
			variants: await tx.select().from(s.productVariants).where(eq(s.productVariants.productId, productId)),
			assets: await tx.select().from(s.productAssets).where(eq(s.productAssets.productId, productId)),
			offers: await tx.select().from(s.offers).where(eq(s.offers.id, offer!.id)),
			items: await tx.select().from(s.offerItems).where(eq(s.offerItems.variantId, variantId))
		}));
		expect(leftovers).toEqual({ variants: [], assets: [], offers: [], items: [] });
		// The file leaves the bucket once the rows are gone.
		expect(ctx.files.removed).toContain(storagePath);
		expect((await listIds()).products.some((product) => product.id === productId)).toBe(false);
		expect(await publicSlugs()).not.toContain('borrable');

		const [event] = await audits('product.deleted', productId);
		expect(event!.metadata).toMatchObject({ slug: 'borrable', name: 'Guía borrable', variants: 1, files: 1 });
		expect((await call('DELETE', `/admin/products/${productId}`)).statusCode).toBe(404);
	});
});

describe('archiving a product with orders (S10)', () => {
	let productId: string;
	let lookupToken: string;
	let orderId: string;

	it('archives instead of deleting and says why', async () => {
		const product = await digitalProduct('vendido');
		productId = product.productId;
		const order = await placeOrder(ctx, tenant, { lines: [{ variantId: product.variantId, quantity: 1 }], campaignSlug: undefined });
		await ctx.app.inject(webhookRequest(tenant, ctx.simulator.pay(order.checkoutId, 'approved').id));
		const session = await ctx.app.inject({ method: 'POST', url: '/lookup/receipt', headers: headers(tenant), payload: { reference: order.reference, accessCode: order.accessCode } });
		lookupToken = session.json().token;
		orderId = (await ctx.app.inject({ method: 'GET', url: '/lookup/me', headers: headers(tenant, { 'x-lookup-token': lookupToken }) })).json().orders[0].id;

		const preview = await call('GET', `/admin/products/${productId}/removal`);
		expect(preview.json()).toMatchObject({ outcome: 'archive', reason: 'ordered' });

		const archived = await call('DELETE', `/admin/products/${productId}`);
		expect(archived.statusCode, archived.body).toBe(200);
		expect(archived.json()).toMatchObject({ outcome: 'archived', reason: 'ordered' });
		expect(archived.json().message).toBe(
			'Guía vendido tiene pedidos, así que no se borra: quedó archivado. Ya no se vende ni aparece en la lista principal (está en Archivados), y los comprobantes y las descargas de quienes lo compraron siguen funcionando.'
		);
		expect((await productRow(tenant, productId))!.status).toBe('archived');
		expect(ctx.files.removed).not.toContain(product.storagePath);

		const [event] = await audits('product.archived', productId);
		expect(event!.metadata).toMatchObject({ from: 'active', reason: 'ordered' });
	});

	it('leaves the shop and the main list, and shows under Archivados', async () => {
		expect(await publicSlugs()).not.toContain('vendido');
		const main = await listIds();
		expect(main.products.some((product) => product.id === productId)).toBe(false);
		expect(main.archivedCount).toBeGreaterThanOrEqual(1);
		const archived = await listIds('?archived=1');
		expect(archived.products.find((product) => product.id === productId)).toMatchObject({ status: 'archived' });
		expect(archived.products.every((product) => product.status === 'archived')).toBe(true);
	});

	it("keeps the buyer's receipt and download working", async () => {
		const me = (await ctx.app.inject({ method: 'GET', url: '/lookup/me', headers: headers(tenant, { 'x-lookup-token': lookupToken }) })).json();
		const order = me.orders.find((entry: { id: string }) => entry.id === orderId);
		expect(order.items).toEqual([expect.objectContaining({ name: 'Guía vendido · PDF' })]);
		expect(order.downloads).toEqual([expect.objectContaining({ filename: 'vendido.pdf' })]);
		const grant = await ctx.app.inject({ method: 'POST', url: '/lookup/downloads', headers: headers(tenant, { 'x-lookup-token': lookupToken }), payload: { orderId, assetId: order.downloads[0].assetId } });
		expect(grant.statusCode, grant.body).toBe(200);
		const download = await ctx.app.inject({ method: 'GET', url: `/downloads/${grant.json().token}`, headers: headers(tenant) });
		expect(download.statusCode, download.body).toBe(200);
		expect(download.json()).toMatchObject({ filename: 'vendido.pdf', url: expect.stringMatching(/^https:\/\/storage\.test\//) });
	});

	it('comes back from the archive as a draft', async () => {
		const restored = await call('POST', `/admin/products/${productId}/status`, { status: 'draft' });
		expect(restored.statusCode, restored.body).toBe(200);
		expect((await listIds()).products.find((product) => product.id === productId)).toMatchObject({ status: 'draft' });
		expect((await listIds('?archived=1')).products.some((product) => product.id === productId)).toBe(false);
		expect(await publicSlugs()).not.toContain('vendido');
		const [event] = await audits('product.status', productId).then((rows) => rows.filter((row) => row.metadata.from === 'archived'));
		expect(event!.metadata).toMatchObject({ from: 'archived', to: 'draft' });
	});
});

describe('a product a campaign may still sell (S10)', () => {
	it('is refused while the campaign rules give chances for it, naming the campaign', async () => {
		const manualProductId = (await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.products).where(eq(s.products.slug, 'manual'))))[0]!.id;
		const preview = await call('GET', `/admin/products/${manualProductId}/removal`);
		expect(preview.json()).toMatchObject({ outcome: 'refuse', reason: 'in_campaign', campaigns: [{ id: tenant.campaignId, title: 'Moto 0 km', status: 'published' }] });

		const refused = await call('DELETE', `/admin/products/${manualProductId}`);
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({
			code: 'product_in_campaign',
			message:
				'Este producto está en la campaña «Moto 0 km». Quitalo de sus productos y de sus chances antes de eliminarlo; si la campaña ya abrió, se puede archivar cuando cierre.',
			details: { campaigns: [{ id: tenant.campaignId, title: 'Moto 0 km', status: 'published' }] }
		});
		expect((await productRow(tenant, manualProductId))!.status).toBe('active');
		expect(await audits('product.deleted', manualProductId)).toEqual([]);
		expect(await audits('product.archived', manualProductId)).toEqual([]);
	});

	it('is refused while the campaign page shows it, and deleted once it leaves the campaign', async () => {
		const { productId } = await digitalProduct('en-campana');
		expect((await call('PATCH', `/admin/campaigns/${tenant.campaignId}`, { productIds: [productId] })).statusCode).toBe(200);
		expect((await call('DELETE', `/admin/products/${productId}`)).json().error.code).toBe('product_in_campaign');
		expect(await productRow(tenant, productId)).not.toBeNull();

		expect((await call('PATCH', `/admin/campaigns/${tenant.campaignId}`, { productIds: [] })).statusCode).toBe(200);
		expect((await call('DELETE', `/admin/products/${productId}`)).json()).toMatchObject({ outcome: 'deleted' });
	});
});

describe('who may remove products (S10, AC-02)', () => {
	it("never reaches another organization's product", async () => {
		const { productId } = await digitalProduct('ajeno');
		const outsider = await adminHeaders(ctx, other);
		expect((await call('DELETE', `/admin/products/${productId}`, undefined, outsider)).statusCode).toBe(404);
		expect((await call('GET', `/admin/products/${productId}/removal`, undefined, outsider)).statusCode).toBe(404);
		expect((await productRow(tenant, productId))!.status).toBe('active');
		const outsiderList = (await call('GET', '/admin/products?archived=1', undefined, outsider)).json().products as { id: string }[];
		expect(outsiderList.some((product) => product.id === productId)).toBe(false);
	});

	it('needs catalog management', async () => {
		const { productId } = await digitalProduct('protegido');
		const operator = await adminHeaders(ctx, tenant, tenant.operatorId);
		expect((await call('DELETE', `/admin/products/${productId}`, undefined, operator)).statusCode).toBe(403);
		expect((await call('GET', `/admin/products/${productId}/removal`, undefined, operator)).statusCode).toBe(403);
		expect(await productRow(tenant, productId)).not.toBeNull();
		expect((await call('DELETE', `/admin/products/${randomUUID()}`)).statusCode).toBe(404);
	});
});

describe('a checkout racing the deletion (S10)', () => {
	it('answers that the cart changed when the deletion commits first, and leaves no order behind', async () => {
		const { productId, variantId } = await digitalProduct('race-delete-first');
		let locked!: () => void;
		let release!: () => void;
		const isLocked = new Promise<void>((resolve) => (locked = resolve));
		const gate = new Promise<void>((resolve) => (release = resolve));
		// Holds the product the way DELETE does, so the checkout reaches it while the deletion is open.
		const deletion = ctx.db.withTenant(tenant.id, async (tx) => {
			await tx.select({ id: s.products.id }).from(s.products).where(eq(s.products.id, productId)).for('update');
			locked();
			await gate;
			await tx.delete(s.productAssets).where(eq(s.productAssets.productId, productId));
			await tx.delete(s.productVariants).where(eq(s.productVariants.productId, productId));
			await tx.delete(s.products).where(eq(s.products.id, productId));
		});
		await isLocked;
		const checkout = ctx.app.inject({
			method: 'POST',
			url: '/checkout/orders',
			headers: headers(tenant),
			payload: checkoutBody(tenant, { lines: [{ variantId, quantity: 1 }], campaignSlug: undefined })
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		release();
		await deletion;
		const response = await checkout;
		expect(response.statusCode, response.body).toBe(409);
		expect(response.json().error.code).toBe('cart_invalid');
		const items = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.orderItems).where(eq(s.orderItems.variantId, variantId)));
		expect(items).toEqual([]);
	});

	it('archives instead of deleting once a checkout has committed', async () => {
		const { productId, variantId } = await digitalProduct('race-checkout-first');
		const order = await ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant, { lines: [{ variantId, quantity: 1 }], campaignSlug: undefined }) });
		expect(order.statusCode, order.body).toBe(201);
		const removed = await call('DELETE', `/admin/products/${productId}`);
		expect(removed.json().outcome).toBe('archived');
		expect((await productRow(tenant, productId))?.status).toBe('archived');
	});
});
