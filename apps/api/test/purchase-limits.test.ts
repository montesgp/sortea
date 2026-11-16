import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, placeOrder, type TenantFixture, type TestContext } from './helpers';

// odd/tasks/limits-and-correction.md T2, S2: "recien desde el celu quise agregar para un test 99 calcos y
// me setea a 20". There is no fixed cap of 20 per line: the variant's "Máximo por compra", set in the
// back office up to 1000, is the only per-order limit.

let ctx: TestContext;
let tenant: TenantFixture;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'limits');
});
afterAll(() => ctx.close());

async function call(method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) {
	return ctx.app.inject({ method, url, headers: await adminHeaders(ctx, tenant), payload });
}

/** A digital sticker on sale with the given "Máximo por compra". */
async function sticker(slug: string, maxPerOrder: number) {
	const created = await call('POST', '/admin/products', { slug, name: `Calco ${slug}`, description: 'Calcomanía digital para descargar.', kind: 'digital' });
	const productId = created.json().id as string;
	const variant = await call('POST', `/admin/products/${productId}/variants`, { sku: slug.toUpperCase(), name: 'Digital', priceMinor: 550_000, stock: null, maxPerOrder });
	expect(variant.statusCode, variant.body).toBe(201);
	expect((await call('POST', `/admin/products/${productId}/status`, { status: 'active' })).statusCode).toBe(200);
	return variant.json().variants[0].id as string;
}

const quote = (variantId: string, quantity: number) =>
	ctx.app.inject({ method: 'POST', url: '/checkout/quote', headers: headers(tenant), payload: { lines: [{ variantId, quantity }] } });

describe('the per-order limit is the variant\'s "Máximo por compra" (S2)', () => {
	it('quotes and orders 99 of a variant with a limit of 100', async () => {
		const variantId = await sticker('calco-99', 100);
		const quoted = await quote(variantId, 99);
		expect(quoted.statusCode).toBe(200);
		expect(quoted.json()).toMatchObject({ ok: true, lines: [{ variantId, quantity: 99, lineTotalMinor: 99 * 550_000 }] });

		const order = await placeOrder(ctx, tenant, { lines: [{ variantId, quantity: 99 }], campaignSlug: undefined });
		expect(order.totalMinor).toBe(99 * 550_000);
	});

	it('refuses more than the variant allows with its limit', async () => {
		const variantId = await sticker('calco-100', 100);
		expect((await quote(variantId, 101)).json()).toEqual({ ok: false, errors: [{ code: 'over_max_per_order', variantId, max: 100 }] });
	});

	it('the back office accepts a limit up to 1000, and a cart line of 1000', async () => {
		const variantId = await sticker('calco-1000', 1000);
		expect((await quote(variantId, 1000)).json()).toMatchObject({ ok: true, lines: [{ quantity: 1000 }] });
		expect((await quote(variantId, 1001)).statusCode).toBe(400);

		const created = await call('POST', '/admin/products', { slug: 'calco-1001', name: 'Calco 1001', description: 'Calcomanía digital para descargar.', kind: 'digital' });
		const refused = await call('POST', `/admin/products/${created.json().id}/variants`, { sku: 'C1001', name: 'Digital', priceMinor: 550_000, stock: null, maxPerOrder: 1001 });
		expect(refused.statusCode).toBe(400);
	});
});
