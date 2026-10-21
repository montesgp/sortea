import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { PublicChances } from '#lib/chances.js';
import type { Product } from '#lib/server/types.js';
import CartPage from '../../routes/(site)/carrito/+page.svelte';
import ChancesBadge from './ChancesBadge.svelte';
import ProductCard from './ProductCard.svelte';
import VariantFields from './VariantFields.svelte';

// S3 (feedback 2026-10-17): while a campaign accepts participations, product
// cards, the variant chooser and the cart show the chances a purchase earns in
// a highlighted badge. The numbers come from the API's locked rules.

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/** The text of every highlighted chances badge in the markup. */
function badges(html: string): string[] {
	const found: string[] = [];
	const pattern = /<p[^>]*class="[^"]*chances-badge[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
	for (let match = pattern.exec(html); match; match = pattern.exec(html)) found.push(text(match[1]!));
	return found;
}

const variant = (id: string, name: string, priceMinor = 3_500_000) => ({ id, name, priceMinor, currency: 'ARS', inStock: true, maxPerOrder: 5 });
const product = (variants: Product['variants']): Product => ({ id: 'p1', slug: 'remera', name: 'Remera MotoGarage', description: 'Algodón.', kind: 'physical', imageUrl: null, variants, upsells: [] });
const chances = (perUnit: Record<string, number>): PublicChances => ({ campaign: { slug: 'tornado-300', title: 'Honda Tornado 300 0 km' }, perUnit, maxPerIdentity: null });

describe('chances badge', () => {
	it('words one chance and several, with an optional lead', () => {
		expect(badges(render(ChancesBadge, { props: { count: 1, campaign: 'Moto 0 km' } }).body)).toEqual(['+1 chance para Moto 0 km']);
		expect(badges(render(ChancesBadge, { props: { count: 6, campaign: 'Moto 0 km', lead: 'Con esta compra sumás' } }).body)).toEqual([
			'Con esta compra sumás +6 chances para Moto 0 km'
		]);
	});
});

describe('product card', () => {
	it('highlights the chances one unit earns', () => {
		const { body } = render(ProductCard, { props: { product: product([variant('m', 'Talle M')]), chances: chances({ m: 3 }) } });
		expect(badges(body)).toEqual(['+3 chances para Honda Tornado 300 0 km']);
	});

	it('says "hasta" when the variants earn different chances', () => {
		const { body } = render(ProductCard, { props: { product: product([variant('s', 'Talle S'), variant('m', 'Talle M')]), chances: chances({ s: 1, m: 2 }) } });
		expect(badges(body)).toEqual(['Hasta +2 chances para Honda Tornado 300 0 km']);
	});

	it('shows no chances while no campaign accepts participations, or when the product earns none', () => {
		expect(text(render(ProductCard, { props: { product: product([variant('m', 'Talle M')]), chances: null } }).body)).not.toMatch(/chance/i);
		expect(text(render(ProductCard, { props: { product: product([variant('m', 'Talle M')]), chances: chances({ other: 4 }) } }).body)).not.toMatch(/chance/i);
	});
});

describe('cart', () => {
	const quote = (counted: { lines: { variantId: string; chances: number }[]; total: number } | null) => ({
		ok: true,
		currency: 'ARS',
		lines: [
			{ variantId: 'm', name: 'Remera MotoGarage · Talle M', kind: 'physical' as const, quantity: 2, unitPriceMinor: 3_500_000, lineTotalMinor: 7_000_000 },
			{ variantId: 'sticker', name: 'Calcomanía', kind: 'physical' as const, quantity: 1, unitPriceMinor: 500_000, lineTotalMinor: 500_000 }
		],
		subtotalMinor: 7_500_000,
		totalMinor: 7_500_000,
		requiresDelivery: true,
		chances: counted && { campaign: { slug: 'tornado-300', title: 'Honda Tornado 300 0 km' }, maxPerIdentity: null, remaining: 10_000, ...counted }
	});
	const cart = (counted: Parameters<typeof quote>[0]) =>
		render(CartPage, { props: { data: { empty: false, quote: quote(counted), upsells: [], limits: {}, problemLines: [] }, form: null } as never }).body;

	it('highlights the chances of each line and the total the API counted', () => {
		const body = cart({ lines: [{ variantId: 'm', chances: 6 }], total: 6 });
		expect(badges(body)).toEqual(['+6 chances para Honda Tornado 300 0 km', 'Con esta compra sumás +6 chances para Honda Tornado 300 0 km']);
	});

	it('shows no chances while no campaign accepts participations', () => {
		expect(text(cart(null))).not.toMatch(/chance/i);
	});

	// Owner feedback 2026-10-21: a suggestion says what it adds before it is in the cart.
	const suggestion = (name: string, grants: { count: number; upTo: boolean; campaign: string } | null) => ({
		variantId: name,
		name,
		kind: 'physical',
		pitch: null,
		priceMinor: 700_000,
		currency: 'ARS',
		product: null,
		chances: grants
	});
	const withSuggestions = (upsells: ReturnType<typeof suggestion>[]) =>
		render(CartPage, { props: { data: { empty: false, quote: quote(null), upsells, limits: {}, problemLines: [], chances: null }, form: null } as never }).body;

	it('highlights the chances each suggestion adds, "up to" when its options differ', () => {
		const body = withSuggestions([
			suggestion('Calcomanía MotoGarage', { count: 1, upTo: false, campaign: 'Honda Tornado 300 0 km' }),
			suggestion('Remera MotoGarage', { count: 10, upTo: true, campaign: 'Honda Tornado 300 0 km' })
		]);
		expect(badges(body)).toEqual(['+1 chance para Honda Tornado 300 0 km', 'Hasta +10 chances para Honda Tornado 300 0 km']);
	});

	it('a suggestion that earns nothing shows no chances', () => {
		expect(text(withSuggestions([suggestion('Pase anual de socios', null)]))).not.toMatch(/chance/i);
	});
});

describe('variant chooser fields', () => {
	it('highlights the chances of the chosen option times the quantity', () => {
		const { body } = render(VariantFields, {
			props: { product: product([variant('s', 'Talle S'), variant('m', 'Talle M')]), idPrefix: 'x', selectedId: 'm', quantity: 2, chances: chances({ s: 1, m: 3 }) }
		});
		expect(badges(body)).toEqual(['Sumás +6 chances para Honda Tornado 300 0 km']);
	});

	it('shows no chances for an option that earns none', () => {
		const { body } = render(VariantFields, {
			props: { product: product([variant('s', 'Talle S'), variant('m', 'Talle M')]), idPrefix: 'x', selectedId: 's', quantity: 2, chances: chances({ m: 3 }) }
		});
		expect(text(body)).not.toMatch(/chance/i);
	});
});
