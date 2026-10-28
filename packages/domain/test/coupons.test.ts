import { describe, expect, it } from 'vitest';
import { couponPoolSize, formatEntryNumber, inCouponPool, padEntryNumber, couponParseMessage, parseCouponNumber, remainingCoupons } from '../src';

describe('coupon pool (ADR 0014 §1)', () => {
	it('holds 0 … 10^digits − 1', () => {
		expect(couponPoolSize(4)).toBe(10_000);
		expect(couponPoolSize(1)).toBe(10);
		expect(inCouponPool(0, 4)).toBe(true);
		expect(inCouponPool(9_999, 4)).toBe(true);
		expect(inCouponPool(10_000, 4)).toBe(false);
		expect(inCouponPool(-1, 4)).toBe(false);
		expect(inCouponPool(1.5, 4)).toBe(false);
	});

	it('remaining is the pool minus allocated numbers minus reserved chances, never negative', () => {
		expect(remainingCoupons({ entryDigits: 4, nextEntryNumber: 0, reserved: 0 })).toBe(10_000);
		expect(remainingCoupons({ entryDigits: 1, nextEntryNumber: 4, reserved: 3 })).toBe(3);
		expect(remainingCoupons({ entryDigits: 1, nextEntryNumber: 10, reserved: 0 })).toBe(0);
		expect(remainingCoupons({ entryDigits: 1, nextEntryNumber: 8, reserved: 5 })).toBe(0);
	});
});

describe('coupon display', () => {
	it('pads to the campaign digits', () => {
		expect(padEntryNumber(42, 4)).toBe('0042');
		expect(padEntryNumber(0, 4)).toBe('0000');
		expect(padEntryNumber(9_999, 4)).toBe('9999');
		expect(padEntryNumber(7, 5)).toBe('00007');
	});

	it('labels a coupon as "N.º 0042"', () => {
		expect(formatEntryNumber(42, 4)).toBe('N.º 0042');
	});
});

describe('parseCouponNumber (S7 live lookup)', () => {
	it('reads a coupon typed with or without zeros, spaces or its label', () => {
		expect(parseCouponNumber('42', 4)).toEqual({ ok: true, entryNumber: 42 });
		expect(parseCouponNumber('0042', 4)).toEqual({ ok: true, entryNumber: 42 });
		expect(parseCouponNumber(' 00 42 ', 4)).toEqual({ ok: true, entryNumber: 42 });
		expect(parseCouponNumber('N.º 0042', 4)).toEqual({ ok: true, entryNumber: 42 });
		expect(parseCouponNumber('#42', 4)).toEqual({ ok: true, entryNumber: 42 });
		expect(parseCouponNumber('0000', 4)).toEqual({ ok: true, entryNumber: 0 });
		expect(parseCouponNumber('9999', 4)).toEqual({ ok: true, entryNumber: 9_999 });
	});

	it('refuses an empty value, anything but digits, and a number outside the pool', () => {
		expect(parseCouponNumber('', 4)).toEqual({ ok: false, reason: 'empty' });
		expect(parseCouponNumber('   ', 4)).toEqual({ ok: false, reason: 'empty' });
		expect(parseCouponNumber('4a2', 4)).toEqual({ ok: false, reason: 'not_a_number' });
		expect(parseCouponNumber('-1', 4)).toEqual({ ok: false, reason: 'not_a_number' });
		expect(parseCouponNumber('4.2', 4)).toEqual({ ok: false, reason: 'not_a_number' });
		expect(parseCouponNumber('10000', 4)).toEqual({ ok: false, reason: 'out_of_pool' });
		expect(parseCouponNumber('12', 1)).toEqual({ ok: false, reason: 'out_of_pool' });
	});
});

describe('couponParseMessage (S7)', () => {
	it('names the pool or shows an example in the campaign digits', () => {
		expect(couponParseMessage('out_of_pool', 4)).toBe('Los cupones de esta campaña van del 0000 al 9999');
		expect(couponParseMessage('empty', 4)).toBe('Escribí el número de cupón, por ejemplo 0042');
		expect(couponParseMessage('not_a_number', 5)).toBe('Escribí el número de cupón, por ejemplo 00042');
	});
});
