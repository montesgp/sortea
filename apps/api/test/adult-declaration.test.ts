import { count, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkoutBody, createTenant, createTestContext, headers, openCampaign, orderByReference, placeOrder, type TenantFixture, type TestContext } from './helpers';

/**
 * Adults only (S11): a purchase that gives chances needs the buyer's declaration of being
 * 18 or older. It is recorded with the purchase; without it the API stores nothing.
 */
let ctx: TestContext;
let tenant: TenantFixture;

const buyer = (document: string, firstName: string) => ({
	documentType: 'DNI',
	documentNumber: document,
	firstName,
	lastName: 'Mayor',
	email: `${firstName.toLowerCase()}@example.com`,
	province: 'Neuquén',
	city: 'Zapala'
});

async function consentsOf(reference: string) {
	const order = await orderByReference(ctx, tenant, reference);
	return ctx.db.withTenant(tenant.id, (tx) =>
		tx
			.select({ purpose: s.contactConsents.purpose, granted: s.contactConsents.granted, policyVersion: s.contactConsents.policyVersion, source: s.contactConsents.source })
			.from(s.contactConsents)
			.where(eq(s.contactConsents.orderId, order.id))
	);
}

/** Everything a checkout writes: orders (and the chances they reserve), contacts, consents and order audit events. */
async function stored() {
	return ctx.db.withTenant(tenant.id, async (tx) => {
		const [orders] = await tx.select({ value: count() }).from(s.orders);
		const [contacts] = await tx.select({ value: count() }).from(s.contacts);
		const [consents] = await tx.select({ value: count() }).from(s.contactConsents);
		const [audits] = await tx.select({ value: count() }).from(s.auditEvents).where(eq(s.auditEvents.action, 'order.created'));
		return { orders: orders!.value, contacts: contacts!.value, consents: consents!.value, audits: audits!.value };
	});
}

async function remainingCoupons(): Promise<number> {
	const quote = await ctx.app.inject({
		method: 'POST',
		url: '/checkout/quote',
		headers: headers(tenant),
		payload: { lines: [{ variantId: tenant.manualVariantId, quantity: 1 }], campaignSlug: tenant.campaignSlug }
	});
	return quote.json().chances.remaining as number;
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'adults');
	await openCampaign(ctx, tenant);
});
afterAll(() => ctx.close());

describe('adult declaration at checkout (S11)', () => {
	it('refuses a purchase with chances without the declaration and stores nothing', async () => {
		await placeOrder(ctx, tenant, { buyer: buyer('32.000.001', 'Ana') });
		const before = await stored();
		const remaining = await remainingCoupons();

		for (const consents of [
			{ terms: true, privacy: true, marketingEmail: false },
			{ terms: true, privacy: true, marketingEmail: false, winnerPublicity: true, adultDeclaration: false }
		]) {
			const response = await ctx.app.inject({
				method: 'POST',
				url: '/checkout/orders',
				headers: headers(tenant),
				payload: checkoutBody(tenant, { buyer: buyer('32.000.002', 'Berta'), consents })
			});
			expect(response.statusCode, response.body).toBe(400);
			expect(response.json().error).toMatchObject({
				code: 'adult_declaration_required',
				message: 'Para recibir chances tenés que declarar que sos mayor de 18 años'
			});
		}

		expect(await stored()).toEqual(before);
		expect(await remainingCoupons()).toBe(remaining);
	});

	it('records the declaration with the purchase that gives chances', async () => {
		const order = await placeOrder(ctx, tenant, {
			buyer: buyer('32.000.003', 'Carla'),
			consents: { terms: true, privacy: true, marketingEmail: false, adultDeclaration: true }
		});
		expect(await consentsOf(order.reference)).toContainEqual({ purpose: 'adult_declaration', granted: true, policyVersion: 't1', source: 'checkout' });
	});

	it('neither requires nor records it for a purchase without chances', async () => {
		for (const adultDeclaration of [false, true]) {
			const response = await ctx.app.inject({
				method: 'POST',
				url: '/checkout/orders',
				headers: headers(tenant),
				payload: checkoutBody(tenant, {
					lines: [{ variantId: tenant.stickerVariantId, quantity: 1 }],
					buyer: buyer(`32.000.01${adultDeclaration ? 1 : 0}`, 'Dora'),
					delivery: { method: 'pickup' },
					consents: { terms: true, privacy: true, marketingEmail: false, adultDeclaration }
				})
			});
			expect(response.statusCode, response.body).toBe(201);
			expect((await consentsOf(response.json().reference)).map((consent) => consent.purpose).sort()).toEqual(['marketing_email', 'privacy', 'terms']);
		}
	});

	it('keeps the terms, privacy, marketing and winner publicity consents as before', async () => {
		const order = await placeOrder(ctx, tenant, {
			buyer: buyer('32.000.004', 'Eva'),
			consents: { terms: true, privacy: true, marketingEmail: true, winnerPublicity: true, adultDeclaration: true }
		});
		const consents = (await consentsOf(order.reference)).filter((consent) => consent.purpose !== 'adult_declaration');
		expect(consents.sort((a, b) => a.purpose.localeCompare(b.purpose))).toEqual([
			{ purpose: 'marketing_email', granted: true, policyVersion: 'p1', source: 'checkout' },
			{ purpose: 'privacy', granted: true, policyVersion: 'p1', source: 'checkout' },
			{ purpose: 'terms', granted: true, policyVersion: 't1', source: 'checkout' },
			{ purpose: 'winner_publicity', granted: true, policyVersion: 'p1', source: 'checkout' }
		]);
		// The required consents are still checked first, by the contract.
		const refused = await ctx.app.inject({
			method: 'POST',
			url: '/checkout/orders',
			headers: headers(tenant),
			payload: checkoutBody(tenant, { buyer: buyer('32.000.005', 'Fede'), consents: { terms: true, privacy: false, marketingEmail: false, adultDeclaration: true } })
		});
		expect(refused.statusCode).toBe(400);
		expect(refused.json().error.code).not.toBe('adult_declaration_required');
	});
});
