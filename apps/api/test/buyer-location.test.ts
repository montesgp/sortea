import { count, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkoutBody, createTenant, createTestContext, headers, loadGeoReference, orderByReference, placeOrder, type TenantFixture, type TestContext } from './helpers';

// S6, S7 (feedback 2026-10-18): buyers from any country, with the province and
// city chosen from the suggestions or typed by hand. Shipping stays inside the
// organization's country (Argentina); elsewhere the buyer gets digital products or pickup.

let ctx: TestContext;
let tenant: TenantFixture;

beforeAll(async () => {
	ctx = await createTestContext();
	await loadGeoReference(ctx);
	tenant = await createTenant(ctx, 'location');
});
afterAll(() => ctx.close());

async function orderCount() {
	const [row] = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ value: count() }).from(s.orders));
	return row!.value;
}

const buyer = (location: Record<string, string>) => ({ ...(checkoutBody(tenant).buyer as Record<string, unknown>), ...location });
const checkout = (payload: Record<string, unknown>) =>
	ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant, payload) });

describe('buyer country (S6, S7)', () => {
	it('keeps the Argentine checkout as it was and records the country as Argentina', async () => {
		const order = await placeOrder(ctx, tenant);
		const row = await orderByReference(ctx, tenant, order.reference);
		expect(row.buyer).toMatchObject({ country: 'AR', province: 'Córdoba', city: 'Río Cuarto' });
	});

	it('takes a buyer from another country for a digital order, with places typed by hand', async () => {
		const order = await placeOrder(ctx, tenant, { buyer: buyer({ country: 'uy', province: '  Montevideo ', city: 'Pueblo Inventado' }) });
		const row = await orderByReference(ctx, tenant, order.reference);
		expect(row.buyer).toMatchObject({ country: 'UY', province: 'Montevideo', city: 'Pueblo Inventado' });
		expect(row.deliveryMethod).toBe('digital');
	});

	it('takes an Argentine province or city that is not in the list (S7)', async () => {
		const order = await placeOrder(ctx, tenant, { buyer: buyer({ country: 'AR', province: 'Provincia que no figura', city: 'Paraje Nuevo' }) });
		expect((await orderByReference(ctx, tenant, order.reference)).buyer).toMatchObject({ country: 'AR', province: 'Provincia que no figura', city: 'Paraje Nuevo' });
	});

	it('offers pickup to a buyer from another country', async () => {
		const order = await placeOrder(ctx, tenant, {
			lines: [{ variantId: tenant.stickerVariantId, quantity: 1 }],
			buyer: buyer({ country: 'CL', province: 'Ñuble', city: 'Chillán' }),
			delivery: { method: 'pickup' }
		});
		const row = await orderByReference(ctx, tenant, order.reference);
		expect(row).toMatchObject({ deliveryMethod: 'pickup', deliveryAddress: null, totalMinor: 350_000 });
		expect(row.buyer).toMatchObject({ country: 'CL', province: 'Ñuble', city: 'Chillán' });
	});

	it('refuses home shipping outside Argentina with a clear message and creates no order', async () => {
		const before = await orderCount();
		const location = { country: 'UY', province: 'Montevideo', city: 'Montevideo' };
		const response = await checkout({
			lines: [{ variantId: tenant.stickerVariantId, quantity: 1 }],
			buyer: buyer(location),
			delivery: { method: 'shipping', address: { street: 'Av. 18 de Julio 1000', postalCode: '11100', province: location.province, city: location.city } }
		});
		expect(response.statusCode).toBe(400);
		expect(response.json().error).toMatchObject({
			code: 'shipping_unavailable_country',
			message: 'El envío a domicilio es solo dentro de Argentina. Podés retirar tu pedido o comprar productos digitales'
		});
		expect(await orderCount()).toBe(before);
	});

	it('refuses a country that is not in the reference data, or is not a code, and creates no order', async () => {
		const before = await orderCount();
		const unknown = await checkout({ buyer: buyer({ country: 'ZZ' }) });
		expect(unknown.statusCode).toBe(400);
		expect(unknown.json().error).toMatchObject({ code: 'unknown_country', message: 'Elegí un país de la lista' });
		for (const country of ['Uruguay', 'URY', '']) {
			const response = await checkout({ buyer: buyer({ country }) });
			expect(response.statusCode, country).toBe(400);
			expect(response.json().error.code).toBe('invalid_request');
		}
		expect(await orderCount()).toBe(before);
	});

	it('still ships inside Argentina only to the buyer city and province', async () => {
		const before = await orderCount();
		const response = await checkout({
			lines: [{ variantId: tenant.stickerVariantId, quantity: 1 }],
			buyer: buyer({ country: 'AR' }),
			delivery: { method: 'shipping', address: { street: 'Av. Siempreviva 742', postalCode: '2000', city: 'Rosario', province: 'Santa Fe' } }
		});
		expect(response.statusCode).toBe(400);
		expect(await orderCount()).toBe(before);
	});
});
