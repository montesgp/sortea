import { count, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, checkoutBody, createTenant, createTestContext, headers, orderByReference, placeOrder, type TenantFixture, type TestContext } from './helpers';

// Owner feedback 2026-11-10 S8: "El telefono en el form de checkout de carrito lo hacemos
// requerido porque ahi nos tenemos que comunicar para avisar al ganador." The API refuses a
// purchase without a usable phone and stores nothing; orders created before keep theirs empty.

let ctx: TestContext;
let tenant: TenantFixture;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'phone');
});
afterAll(() => ctx.close());

/** Everything a checkout writes: orders, contacts and consents. */
async function stored() {
	return ctx.db.withTenant(tenant.id, async (tx) => {
		const [orders] = await tx.select({ value: count() }).from(s.orders);
		const [contacts] = await tx.select({ value: count() }).from(s.contacts);
		const [consents] = await tx.select({ value: count() }).from(s.contactConsents);
		return { orders: orders!.value, contacts: contacts!.value, consents: consents!.value };
	});
}

const buyer = (phone: unknown) => {
	const { phone: _phone, ...rest } = checkoutBody(tenant).buyer as Record<string, unknown>;
	return phone === undefined ? rest : { ...rest, phone };
};
const checkout = (phone: unknown) => ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant, { buyer: buyer(phone) }) });

describe('checkout phone (S8)', () => {
	it('refuses a purchase without a phone, saying why, and stores nothing', async () => {
		const before = await stored();
		for (const phone of [undefined, '', '   ', null]) {
			const response = await checkout(phone);
			expect(response.statusCode, String(phone)).toBe(400);
			expect(response.json().error, String(phone)).toMatchObject({ code: 'phone_required', message: 'Ingresá tu teléfono: lo usamos para avisarte si ganás' });
		}
		expect(await stored()).toEqual(before);
	});

	it('refuses a phone it cannot use with its own message, and stores nothing', async () => {
		const before = await stored();
		const response = await checkout('llamame');
		expect(response.statusCode).toBe(400);
		expect(response.json().error).toMatchObject({ code: 'invalid_phone', message: 'Revisá el teléfono, por ejemplo +54 9 11 2345-6789' });
		expect(await stored()).toEqual(before);
	});

	it('with other fields wrong too, refuses with every field error, the phone among them, and stores nothing', async () => {
		const before = await stored();
		for (const phone of ['llamame', undefined]) {
			const payload = checkoutBody(tenant, { buyer: { ...buyer(phone), email: 'no-es-un-email' } });
			const response = await ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload });
			expect(response.statusCode, String(phone)).toBe(400);
			const error = response.json().error;
			expect(error, String(phone)).toMatchObject({ code: 'invalid_request', message: 'Revisá los datos enviados' });
			const fields = Object.keys(error.details.fieldErrors);
			expect(fields, String(phone)).toEqual(['buyer']);
			const messages = JSON.stringify(error.details);
			expect(messages, String(phone)).toMatch(/email/i);
			expect(messages, String(phone)).toContain(phone === undefined ? 'Ingresá tu teléfono' : 'Revisá el teléfono');
		}
		expect(await stored()).toEqual(before);
	});

	it('stores the phone, trimmed, on the order and the contact, in Argentine or international format', async () => {
		for (const [index, phone] of ['  011 4567-8901 ', '+598 99 123 456'].entries()) {
			const order = await placeOrder(ctx, tenant, { buyer: { ...buyer(phone), documentNumber: `3344455${index}`, email: `tel${index}@example.com` } });
			const row = await orderByReference(ctx, tenant, order.reference);
			expect(row.buyer.phone).toBe(phone.trim());
			const [contact] = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ phone: s.contacts.phone }).from(s.contacts).where(eq(s.contacts.id, row.contactId)));
			expect(contact!.phone).toBe(phone.trim());
		}
	});

	it('an order created before the phone was required still opens in the panel, without a phone', async () => {
		const order = await placeOrder(ctx, tenant, { buyer: { ...buyer('+54 9 11 2345-6789'), documentNumber: '33444666', email: 'antes@example.com' } });
		const row = await orderByReference(ctx, tenant, order.reference);
		await ctx.db.withTenant(tenant.id, (tx) => tx.update(s.orders).set({ buyer: { ...row.buyer, phone: null } }).where(eq(s.orders.id, row.id)));
		const detail = await ctx.app.inject({ method: 'GET', url: `/admin/orders/${row.id}`, headers: await adminHeaders(ctx, tenant) });
		expect(detail.statusCode).toBe(200);
		expect(detail.json()).toMatchObject({ reference: order.reference, buyer: { firstName: 'Juana', phone: null } });
	});
});
