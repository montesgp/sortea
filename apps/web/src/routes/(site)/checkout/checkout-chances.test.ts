import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import CheckoutPage from './+page.svelte';

// Console polish 2026-11-11 (S7): wherever the products of a purchase that gives
// chances are listed until the purchase ends, each line says the chances it
// includes, highlighted like the cart's badge, a size smaller in the summary.

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

const manual = '00000000-0000-4000-8000-000000000001';
const sticker = '00000000-0000-4000-8000-000000000002';
const quote = {
	ok: true,
	currency: 'ARS',
	lines: [
		{ variantId: manual, name: 'Manual Taller Demo', kind: 'digital', quantity: 2, unitPriceMinor: 5_000_000, lineTotalMinor: 10_000_000 },
		{ variantId: sticker, name: 'Calcomanía Taller Demo', kind: 'physical', quantity: 1, unitPriceMinor: 700_000, lineTotalMinor: 700_000 }
	],
	subtotalMinor: 10_700_000,
	deliveryFeeMinor: 0,
	totalMinor: 10_700_000,
	requiresDelivery: true,
	chances: { campaign: { slug: 'moto', title: 'Moto 0 km' }, lines: [{ variantId: manual, chances: 30 }], total: 30, maxPerIdentity: null, remaining: 9000 }
};
const site = { organization: { name: 'Taller Demo' }, delivery: { pickupEnabled: true, shippingEnabled: false, shippingFeeMinor: 0 } };

const summary = (data: Record<string, unknown> = {}) => {
	const html = render(CheckoutPage, { props: { data: { quote, countries: ['AR'], subdivisions: [], attempt: null, closed: null, site, ...data }, form: null } as never }).body;
	const aside = html.slice(html.indexOf('aria-label="Resumen del pedido"'));
	return aside.slice(0, aside.indexOf('</aside>'));
};
const text = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('checkout summary: chances per line (S7)', () => {
	it('shows the chances of each line that gives them, and the total, as small badges', () => {
		const html = summary();
		expect(text(html)).toContain('+30 chances para Moto 0 km');
		expect(html.match(/class="chances-badge mini[ "]/g)).toHaveLength(2);
		// The sticker gives no chances: its line has no badge.
		const stickerLine = html.slice(html.indexOf('Calcomanía Taller Demo'));
		expect(stickerLine.slice(0, stickerLine.indexOf('</li>'))).not.toContain('chances-badge');
	});

	it('shows no badge when the purchase gives no chances', () => {
		expect(summary({ quote: { ...quote, chances: null } })).not.toContain('chances-badge');
	});
});
