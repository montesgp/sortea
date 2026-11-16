import type { Cookies } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { readCart, setLine, writeCart } from './cart';

// odd/tasks/limits-and-correction.md S2: the cart cookie holds what the variant allows, not a fixed 20.

function cookieJar(): Cookies {
	const values = new Map<string, string>();
	return {
		get: (name: string) => values.get(name),
		set: (name: string, value: string) => void values.set(name, value),
		delete: (name: string) => void values.delete(name)
	} as unknown as Cookies;
}

const A = '0b8e8f52-3c1f-4c55-9a43-2f1d8a2b7c10';

describe('cart cookie', () => {
	it('keeps 99 units of a line', () => {
		const cookies = cookieJar();
		writeCart(cookies, setLine({ lines: [], campaign: null }, A, 99));
		expect(readCart(cookies)).toEqual({ lines: [{ variantId: A, quantity: 99 }], campaign: null });
	});

	it('stops a line at the technical ceiling of 1000 and removes it at zero', () => {
		expect(setLine({ lines: [], campaign: null }, A, 5000).lines).toEqual([{ variantId: A, quantity: 1000 }]);
		expect(setLine({ lines: [{ variantId: A, quantity: 3 }], campaign: null }, A, 0).lines).toEqual([]);
	});
});
