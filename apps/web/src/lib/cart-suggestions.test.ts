import { describe, expect, it } from 'vitest';
import type { PublicChances } from './chances.js';
import { cartSuggestions } from './cart-suggestions.js';
import type { Product } from './server/types.js';

// Owner feedback 2026-11-15 S5: the cart suggests every other product that gives
// chances in the campaign, whatever was added first, plus the extras the shop
// configured; never what the cart already holds.

const variant = (id: string, priceMinor = 500_000, inStock = true) => ({ id, name: 'Única', priceMinor, currency: 'ARS', inStock, maxPerOrder: 5 });
const product = (id: string, name: string, variants = [variant(`${id}-v`)], upsells: Product['upsells'] = []): Product => ({
	id,
	slug: id,
	name,
	description: 'x',
	kind: 'digital',
	imageUrl: null,
	variants,
	upsells
});

// As in production: the sticker was added after the offers were set, so it has none and none points to it.
const manual = product('manual', 'Manual técnico', undefined, [{ variantId: 'checklist-v', pitch: 'Ideal para acompañar el manual.', title: 'Sumá' }]);
const checklist = product('checklist', 'Checklist de viaje', undefined, [{ variantId: 'manual-v', pitch: 'Despieces y torques en PDF.', title: 'Sumá' }]);
const sticker = product('sticker', 'Calcomanía digital');
const shirt = product('shirt', 'Remera', [variant('shirt-s', 4_500_000), variant('shirt-m', 4_500_000)]);
const chances: PublicChances = { campaign: { slug: 'wave', title: 'Honda Wave' }, perUnit: { 'manual-v': 15, 'checklist-v': 3, 'sticker-v': 1 }, maxPerIdentity: null };

const names = (list: ReturnType<typeof cartSuggestions>) => list.map((item) => item.name);

describe('cart suggestions (S5)', () => {
	it('suggests every other product of the campaign when the sticker is added first, with no offer configured', () => {
		const list = cartSuggestions([manual, checklist, sticker, shirt], chances, ['sticker-v']);
		expect(names(list)).toEqual(['Manual técnico', 'Checklist de viaje']);
		// The pitch the shop wrote for a product follows it wherever it is suggested.
		expect(list.find((item) => item.name === 'Checklist de viaje')).toMatchObject({ variantId: 'checklist-v', pitch: 'Ideal para acompañar el manual.', chances: { count: 3, campaign: 'Honda Wave' } });
		expect(list.find((item) => item.name === 'Manual técnico')).toMatchObject({ pitch: 'Despieces y torques en PDF.', chances: { count: 15 } });
	});

	it('suggests the sticker from the manual too, and never what the cart holds', () => {
		expect(names(cartSuggestions([manual, checklist, sticker], chances, ['manual-v']))).toEqual(['Checklist de viaje', 'Calcomanía digital']);
		expect(names(cartSuggestions([manual, checklist, sticker], chances, ['manual-v', 'sticker-v', 'checklist-v']))).toEqual([]);
	});

	it('adds the configured extras that give no chances after the campaign products, each product once', () => {
		const withShirt = { ...manual, upsells: [...manual.upsells, { variantId: 'shirt-s', pitch: 'Elegí tu talle.', title: 'Sumá' }] };
		const list = cartSuggestions([withShirt, checklist, sticker, shirt], chances, ['manual-v']);
		expect(names(list)).toEqual(['Checklist de viaje', 'Calcomanía digital', 'Remera']);
		// Several options: added through its chooser, priced "desde".
		expect(list.at(-1)).toMatchObject({ product: { id: 'shirt' }, priceMinor: 4_500_000, pitch: 'Elegí tu talle.', chances: null });
	});

	it('skips products without stock, and offers only the configured extras while no campaign gives chances', () => {
		const soldOut = product('sticker', 'Calcomanía digital', [variant('sticker-v', 550_000, false)]);
		expect(names(cartSuggestions([manual, checklist, soldOut], chances, ['manual-v']))).toEqual(['Checklist de viaje']);
		expect(names(cartSuggestions([manual, checklist, sticker], null, ['sticker-v']))).toEqual([]);
		expect(names(cartSuggestions([manual, checklist, sticker], null, ['manual-v']))).toEqual(['Checklist de viaje']);
	});
});
