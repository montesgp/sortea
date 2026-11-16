import { describe, expect, it } from 'vitest';
import { addedQuantity, lineLimit, parseAdd } from './cart-add';

const variantId = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';

describe('parseAdd', () => {
	it('adds one unit when the form carries no quantity, as the product cards do', () => {
		expect(parseAdd({ variantId })).toEqual({ ok: true, data: { variantId, quantity: 1, campaign: undefined } });
		expect(parseAdd({ variantId, quantity: '', campaign: '' })).toEqual({ ok: true, data: { variantId, quantity: 1, campaign: undefined } });
	});

	it('accepts a quantity and a campaign from the variant chooser', () => {
		expect(parseAdd({ variantId, quantity: '2', campaign: 'tornado-300' })).toEqual({ ok: true, data: { variantId, quantity: 2, campaign: 'tornado-300' } });
	});

	it('rejects quantities that are not a whole number from 1 to 1000', () => {
		for (const quantity of ['0', '-1', '1.5', '1001', 'dos']) {
			expect(parseAdd({ variantId, quantity }), quantity).toEqual({ ok: false });
		}
	});

	// odd/tasks/limits-and-correction.md S2: no hidden cap of 20 per line.
	it('accepts 99 units', () => {
		expect(parseAdd({ variantId, quantity: '99' })).toEqual({ ok: true, data: { variantId, quantity: 99, campaign: undefined } });
	});

	it('rejects a malformed variant or campaign', () => {
		expect(parseAdd({ variantId: 'remera', quantity: '1' })).toEqual({ ok: false });
		expect(parseAdd({ variantId, campaign: '../admin' })).toEqual({ ok: false });
	});
});

describe('lineLimit', () => {
	it('is the variant limit per order ("Máximo por compra"), within the technical ceiling of 1000 (S2)', () => {
		expect(lineLimit(5)).toBe(5);
		expect(lineLimit(50)).toBe(50);
		expect(lineLimit(100)).toBe(100);
		expect(lineLimit(undefined)).toBe(1000);
	});
});

describe('addedQuantity', () => {
	it('adds the quantity to what the cart already holds', () => {
		expect(addedQuantity(0, 2, 5)).toEqual({ ok: true, quantity: 2 });
		expect(addedQuantity(2, 3, 5)).toEqual({ ok: true, quantity: 5 });
	});

	it('keeps 99 of a variant with a limit of 100 (S2)', () => {
		expect(addedQuantity(0, 99, lineLimit(100))).toEqual({ ok: true, quantity: 99 });
		expect(addedQuantity(99, 2, lineLimit(100))).toEqual({ ok: false, max: 100, message: 'Podés llevar hasta 100 por compra. Ya tenés 99 en el carrito.' });
	});

	it('refuses to go over the limit per order and says how many fit', () => {
		expect(addedQuantity(0, 6, 5)).toEqual({ ok: false, max: 5, message: 'Podés llevar hasta 5 por compra.' });
		expect(addedQuantity(4, 2, 5)).toEqual({ ok: false, max: 5, message: 'Podés llevar hasta 5 por compra. Ya tenés 4 en el carrito.' });
	});
});
