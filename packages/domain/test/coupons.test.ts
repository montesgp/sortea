import { describe, expect, it } from 'vitest';
import { couponPoolSize, formatEntryNumber, inCouponPool, padEntryNumber, couponParseMessage, parseCouponNumber, remainingCoupons, couponShortfall, couponsRunningLow } from '../src';

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

// odd/tasks/limits-and-correction.md T3, S3: a purchase never takes more chances than remain.
describe('couponShortfall (S3)', () => {
	it('is null while the chances fit, and says how many remain when they do not', () => {
		expect(couponShortfall({ title: 'Moto 0 km', remaining: 15, requested: 15 })).toBeNull();
		expect(couponShortfall({ title: 'Moto 0 km', remaining: 0, requested: 0 })).toBeNull();
		expect(couponShortfall({ title: 'Moto 0 km', remaining: 3, requested: 15 })).toBe('Quedan 3 cupones para Moto 0 km y tu carrito suma 15 chances. Quitá algunos productos para continuar');
		expect(couponShortfall({ title: 'Moto 0 km', remaining: 1, requested: 2 })).toBe('Queda 1 cupón para Moto 0 km y tu carrito suma 2 chances. Quitá algunos productos para continuar');
		expect(couponShortfall({ title: 'Moto 0 km', remaining: 0, requested: 1 })).toBe('Se agotaron los cupones de Moto 0 km. Quitá los productos que dan chances para continuar');
	});
});

// odd/tasks/limits-and-correction.md T4, S4: the admin is warned once 80% of the coupons are used.
describe('couponsRunningLow (S4)', () => {
	it('warns from 80% used (allocated plus reserved), with what remains', () => {
		expect(couponsRunningLow({ title: 'Moto', entryDigits: 4, nextEntryNumber: 7_999, reserved: 0 })).toBeNull();
		expect(couponsRunningLow({ title: 'Moto', entryDigits: 4, nextEntryNumber: 7_000, reserved: 1_000 })).toBe('Se usó el 80% de los cupones de Moto: quedan 2.000.');
		expect(couponsRunningLow({ title: 'Moto', entryDigits: 1, nextEntryNumber: 9, reserved: 0 })).toBe('Se usó el 80% de los cupones de Moto: quedan 1.');
		expect(couponsRunningLow({ title: 'Moto', entryDigits: 1, nextEntryNumber: 8, reserved: 2 })).toBe('Se agotaron los cupones de Moto: no entran más compras con chances.');
	});
});
