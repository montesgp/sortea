import { describe, expect, it } from 'vitest';
import { formatMoney, money, priceCart, type CatalogEntry } from '../src';

const now = new Date('2026-10-14T12:00:00Z');

function entry(overrides: Partial<CatalogEntry> & Pick<CatalogEntry, 'variantId'>): CatalogEntry {
	return {
		productId: `product-${overrides.variantId}`,
		name: 'Manual técnico',
		kind: 'digital',
		unitPriceMinor: 1_200_000,
		currency: 'ARS',
		active: true,
		stock: null,
		maxPerOrder: 5,
		availableFrom: null,
		availableUntil: null,
		...overrides
	};
}

const catalog = new Map(
	[
		entry({ variantId: 'manual' }),
		entry({ variantId: 'sticker', name: 'Calcomanía', kind: 'physical', unitPriceMinor: 350_000, stock: 3 }),
		entry({ variantId: 'retired', active: false })
	].map((item) => [item.variantId, item])
);

describe('priceCart', () => {
	it('computes totals from the catalog, ignoring anything the browser might claim', () => {
		const result = priceCart([{ variantId: 'manual', quantity: 2 }], catalog, { now });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.total).toEqual(money(2_400_000, 'ARS'));
		expect(result.requiresDelivery).toBe(false);
	});

	it('adds the delivery fee only when a physical item is in the cart', () => {
		const digital = priceCart([{ variantId: 'manual', quantity: 1 }], catalog, { now, deliveryFeeMinor: 500_000 });
		const mixed = priceCart(
			[
				{ variantId: 'manual', quantity: 1 },
				{ variantId: 'sticker', quantity: 1 }
			],
			catalog,
			{ now, deliveryFeeMinor: 500_000 }
		);
		expect(digital.ok && digital.total.amountMinor).toBe(1_200_000);
		expect(mixed.ok && mixed.total.amountMinor).toBe(1_200_000 + 350_000 + 500_000);
		expect(mixed.ok && mixed.requiresDelivery).toBe(true);
	});

	it('rejects unknown, inactive, duplicated and over-stock lines', () => {
		const result = priceCart(
			[
				{ variantId: 'ghost', quantity: 1 },
				{ variantId: 'retired', quantity: 1 },
				{ variantId: 'sticker', quantity: 4 },
				{ variantId: 'manual', quantity: 1 },
				{ variantId: 'manual', quantity: 1 }
			],
			catalog,
			{ now }
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.map((error) => error.code)).toEqual([
			'unknown_variant',
			'inactive_variant',
			'insufficient_stock',
			'duplicate_line'
		]);
	});

	it('rejects zero, fractional and above-limit quantities', () => {
		for (const quantity of [0, 1.5, 6]) {
			const result = priceCart([{ variantId: 'manual', quantity }], catalog, { now });
			expect(result.ok).toBe(false);
		}
	});

	it('respects the sale window', () => {
		const windowed = new Map([
			['late', entry({ variantId: 'late', availableUntil: new Date('2026-10-01T00:00:00Z') })]
		]);
		const result = priceCart([{ variantId: 'late', quantity: 1 }], windowed, { now });
		expect(result.ok).toBe(false);
	});

	it('rejects an empty cart', () => {
		expect(priceCart([], catalog, { now })).toEqual({ ok: false, errors: [{ code: 'empty_cart' }] });
	});
});

describe('formatMoney', () => {
	it('formats ARS without cents when the amount is whole', () => {
		expect(formatMoney(money(1_200_000, 'ARS')).replace(/\s/g, ' ')).toBe('$ 12.000');
	});
});
