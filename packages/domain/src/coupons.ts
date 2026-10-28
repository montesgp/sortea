/**
 * The coupon pool of a campaign (ADR 0014 §1). Each chance is a coupon numbered
 * within 0 … 10^digits − 1, the range of the official draw that decides the
 * prizes, and is always shown zero-padded to the campaign's digits.
 */

/** Digits of new campaigns: 0000–9999. */
export const defaultEntryDigits = 4;
/** Upper bound for `entry_digits`; the database enforces 1..6 as well. */
export const maxEntryDigits = 6;

export function couponPoolSize(entryDigits: number): number {
	return 10 ** entryDigits;
}

export function inCouponPool(entryNumber: number, entryDigits: number): boolean {
	return Number.isInteger(entryNumber) && entryNumber >= 0 && entryNumber < couponPoolSize(entryDigits);
}

/**
 * Coupons still available. Numbers are allocated sequentially, so everything below
 * `nextEntryNumber` is taken; `reserved` is the chances of unexpired pending orders.
 */
export function remainingCoupons(input: { entryDigits: number; nextEntryNumber: number; reserved: number }): number {
	return Math.max(0, couponPoolSize(input.entryDigits) - input.nextEntryNumber - input.reserved);
}

/** "0042" for 42 with 4 digits. */
export function padEntryNumber(entryNumber: number, entryDigits: number): string {
	return String(entryNumber).padStart(entryDigits, '0');
}

/** "N.º 0042": how a coupon appears to buyers and admins. */
export function formatEntryNumber(entryNumber: number, entryDigits: number): string {
	return `N.º ${padEntryNumber(entryNumber, entryDigits)}`;
}

export type CouponParse = { ok: true; entryNumber: number } | { ok: false; reason: 'empty' | 'not_a_number' | 'out_of_pool' };

/**
 * A coupon typed by an operator (S7): "42", "0042", "00 42", "#42" and
 * "N.º 0042" all name coupon 42. Spaces are ignored so a number read aloud in
 * groups still works; the result must fall inside the campaign's pool.
 */
export function parseCouponNumber(input: string, entryDigits: number): CouponParse {
	const text = input.replace(/\s+/g, '').replace(/^(#|N\.º)/i, '');
	if (!text) return { ok: false, reason: 'empty' };
	if (!/^\d+$/.test(text)) return { ok: false, reason: 'not_a_number' };
	const entryNumber = Number(text);
	if (!inCouponPool(entryNumber, entryDigits)) return { ok: false, reason: 'out_of_pool' };
	return { ok: true, entryNumber };
}

/** What an operator reads when a typed coupon cannot be searched (S7). */
export function couponParseMessage(reason: Extract<CouponParse, { ok: false }>['reason'], entryDigits: number): string {
	if (reason === 'out_of_pool') return `Los cupones de esta campaña van del ${padEntryNumber(0, entryDigits)} al ${padEntryNumber(couponPoolSize(entryDigits) - 1, entryDigits)}`;
	return `Escribí el número de cupón, por ejemplo ${padEntryNumber(42, entryDigits)}`;
}
