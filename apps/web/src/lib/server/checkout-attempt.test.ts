import type { Cookies } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { checkoutAttempt, checkoutDone, lastCheckoutDone, markCheckoutDone, newCheckoutAttempt } from './checkout-attempt';
import { saveReceipt } from './receipt';

// Owner feedback 2026-10-30: a checkout page that already created its order
// (the browser's Back button shows it again) never creates a second one.

function cookieJar(): Cookies {
	const values = new Map<string, string>();
	return {
		get: (name: string) => values.get(name),
		set: (name: string, value: string) => void values.set(name, value),
		delete: (name: string) => void values.delete(name)
	} as unknown as Cookies;
}

const A = '0b8e8f52-3c1f-4c55-9a43-2f1d8a2b7c10';
const B = '5f0c3e2a-9d7b-4e8f-8a6c-1b2d3e4f5a6b';

describe('checkout attempt', () => {
	it('issues a fresh id for each page and accepts only such ids back', () => {
		const first = newCheckoutAttempt();
		expect(first).not.toBe(newCheckoutAttempt());
		expect(checkoutAttempt(first)).toBe(first);
		for (const value of [undefined, '', 'abc', `${A}x`, 42]) expect(checkoutAttempt(value)).toBeNull();
	});

	it('remembers an attempt as done with its order, linking the receipt only when this browser holds it', () => {
		const cookies = cookieJar();
		expect(checkoutDone(cookies, A)).toBeNull();
		expect(lastCheckoutDone(cookies)).toBeNull();
		markCheckoutDone(cookies, A, 'MG-AAAA1111');
		expect(checkoutDone(cookies, A)).toEqual({ reason: 'done', reference: null });
		saveReceipt(cookies, { reference: 'MG-AAAA1111', accessCode: 'X1' });
		expect(checkoutDone(cookies, A)).toEqual({ reason: 'done', reference: 'MG-AAAA1111' });
		expect(checkoutDone(cookies, B)).toBeNull();
	});

	it('keeps the latest attempts first and only a few of them', () => {
		const cookies = cookieJar();
		const attempts = Array.from({ length: 7 }, () => newCheckoutAttempt());
		attempts.forEach((attempt, index) => markCheckoutDone(cookies, attempt, `MG-${index}`));
		saveReceipt(cookies, { reference: 'MG-6', accessCode: 'X1' });
		expect(lastCheckoutDone(cookies)).toEqual({ reason: 'done', reference: 'MG-6' });
		expect(checkoutDone(cookies, attempts[6]!)).not.toBeNull();
		expect(checkoutDone(cookies, attempts[2]!)).not.toBeNull();
		expect(checkoutDone(cookies, attempts[1]!)).toBeNull();
	});

	it('reads nothing from a broken or foreign cookie', () => {
		const cookies = cookieJar();
		for (const value of ['{broken', '{"attempt":1}', JSON.stringify([{ attempt: 'abc', reference: 'MG-1' }])]) {
			cookies.set('sortea_checkout_done', value, { path: '/' });
			expect(lastCheckoutDone(cookies)).toBeNull();
			expect(checkoutDone(cookies, A)).toBeNull();
		}
	});
});
