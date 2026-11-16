import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import CheckoutPage from './+page.svelte';

// odd/tasks/limits-and-correction.md T3, S3: a purchase whose chances exceed the coupons left is refused
// before payment; the checkout says how many remain next to the order summary and keeps what was typed.

const site = {
	organization: { name: 'Taller Demo', slug: 'taller-demo', locale: 'es-AR', timezone: 'America/Argentina/Buenos_Aires', currency: 'ARS' },
	delivery: { pickupEnabled: true, shippingEnabled: false, shippingFeeMinor: 0 }
};
const shortfall = 'Quedan 3 cupones para Moto 0 km y tu carrito suma 15 chances. Quitá algunos productos para continuar';
const quote = (remaining: number, message: string | null) => ({
	ok: true,
	currency: 'ARS',
	lines: [{ variantId: 'm', name: 'Calco digital', kind: 'digital', quantity: 15, unitPriceMinor: 550_000, lineTotalMinor: 15 * 550_000 }],
	subtotalMinor: 15 * 550_000,
	deliveryFeeMinor: 0,
	totalMinor: 15 * 550_000,
	requiresDelivery: false,
	delivery: site.delivery,
	chances: { campaign: { slug: 'moto', title: 'Moto 0 km' }, lines: [{ variantId: 'm', chances: 15 }], total: 15, maxPerIdentity: null, remaining, shortfall: message }
});
const data = (remaining: number, message: string | null) => ({ site, quote: quote(remaining, message), countries: [], subdivisions: [], attempt: null, closed: null });
const body = (props: Record<string, unknown>) => render(CheckoutPage as Component, { props: props as never }).body;
/** The order summary, where the message goes. */
const summary = (html: string) => html.slice(html.indexOf('aria-label="Resumen del pedido"'));

describe('checkout with more chances than coupons left (S3)', () => {
	it('says how many remain next to the order summary, with the way back to the cart', () => {
		const html = body({ data: data(3, shortfall), form: null });
		expect(summary(html)).toContain(`${shortfall}.`);
		expect(summary(html)).toMatch(/<a[^>]*href="\/carrito"[^>]*>Cambiar la cantidad<\/a>/);
	});

	it('says nothing while the chances fit', () => {
		const html = body({ data: data(15, null), form: null });
		expect(html).not.toContain('cupones para Moto 0 km');
		expect(html).not.toContain('Cambiar la cantidad');
	});

	it('after a refused order, shows the API reason in the summary and keeps the buyer data', () => {
		const form = { values: { email: 'juana@example.com', firstName: 'Juana', lastName: 'Pérez' }, errors: {}, message: '', pool: shortfall };
		const html = body({ data: data(15, null), form });
		expect(summary(html)).toContain(`${shortfall}.`);
		expect(html).toMatch(/id="email"[^>]*value="juana@example.com"/);
		expect(html).toMatch(/id="firstName"[^>]*value="Juana"/);
	});
});
