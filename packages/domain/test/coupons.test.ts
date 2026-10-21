import { describe, expect, it } from 'vitest';
import { couponPoolSize, formatEntryNumber, inCouponPool, padEntryNumber, remainingCoupons } from '../src';

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
