import { describe, expect, it } from 'vitest';
import { entriesPerUnitFromProductForm, productChanceRows } from './product-chances';

const variant = (id: string, name: string, productId: string, productName: string, active = true) => ({ id, name, active, productId, productName, productStatus: 'active' });

const variants = [
	variant('manual', 'Manual técnico', 'p-manual', 'Manual técnico'),
	variant('remera-s', 'Talle S', 'p-remera', 'Remera'),
	variant('remera-m', 'Talle M', 'p-remera', 'Remera'),
	variant('remera-xl', 'Talle XL', 'p-remera', 'Remera'),
	variant('sticker', 'Calcomanía', 'p-sticker', 'Calcomanía')
];

// S1 (owner feedback 2026-10-22): one chances value per product, applied to all its variants.
describe('chances table, one row per product', () => {
	it('groups the variants of each product in catalog order', () => {
		const rows = productChanceRows(variants, { manual: 15, 'remera-s': 10, 'remera-m': 10, 'remera-xl': 10 });
		expect(rows.map((row) => [row.productId, row.variantIds, row.perUnit, row.mixed])).toEqual([
			['p-manual', ['manual'], 15, false],
			['p-remera', ['remera-s', 'remera-m', 'remera-xl'], 10, false],
			['p-sticker', ['sticker'], 0, false]
		]);
		expect(rows[1]).toMatchObject({ productName: 'Remera', onSale: true });
	});

	it('shows the highest value when the variants of a product differ, with each variant value', () => {
		const [, remera] = productChanceRows(variants, { 'remera-xl': 10, 'remera-m': 3 });
		expect(remera).toMatchObject({ perUnit: 10, mixed: true });
		expect(remera!.variants).toEqual([
			{ name: 'Talle S', perUnit: 0 },
			{ name: 'Talle M', perUnit: 3 },
			{ name: 'Talle XL', perUnit: 10 }
		]);
	});

	it('reads a product as on sale while any of its variants is', () => {
		const rows = productChanceRows(
			[variant('a', 'A', 'p', 'P', false), variant('b', 'B', 'p', 'P', true), { ...variant('c', 'C', 'q', 'Q'), productStatus: 'archived' }],
			{}
		);
		expect(rows.map((row) => row.onSale)).toEqual([true, false]);
	});
});

describe('chances form, expanded to every variant', () => {
	const form = (entries: [string, string][]) => {
		const data = new FormData();
		for (const [key, value] of entries) data.append(key, value);
		return data;
	};

	it('applies the value typed for a product to each of its variants', () => {
		const result = entriesPerUnitFromProductForm(
			form([
				['chances.p-manual', '15'],
				['variant.p-manual', 'manual'],
				['chances.p-remera', '10'],
				['variant.p-remera', 'remera-s'],
				['variant.p-remera', 'remera-m'],
				['variant.p-remera', 'remera-xl'],
				['chances.p-sticker', ''],
				['variant.p-sticker', 'sticker'],
				['maxEntriesPerIdentity', '50']
			])
		);
		expect(result).toEqual({ ok: true, entriesPerUnit: { manual: 15, 'remera-s': 10, 'remera-m': 10, 'remera-xl': 10, sticker: 0 } });
	});

	it('refuses values outside 0 to 100 or not whole', () => {
		const message = 'Las chances por unidad son un número entero de 0 a 100';
		for (const value of ['-1', '101', '2.5', 'diez']) {
			expect(entriesPerUnitFromProductForm(form([['chances.p-remera', value], ['variant.p-remera', 'remera-s']]))).toEqual({ ok: false, message });
		}
	});
});
