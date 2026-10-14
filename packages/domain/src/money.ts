/**
 * Money is always an integer amount of minor units (centavos for ARS).
 * Floating point never touches an amount that is persisted or charged.
 */
export type CurrencyCode = 'ARS' | 'USD';

export interface Money {
	readonly amountMinor: number;
	readonly currency: CurrencyCode;
}

export function money(amountMinor: number, currency: CurrencyCode): Money {
	if (!Number.isSafeInteger(amountMinor)) {
		throw new RangeError(`Money amounts must be safe integers in minor units, got ${amountMinor}`);
	}
	return { amountMinor, currency };
}

export function addMoney(a: Money, b: Money): Money {
	assertSameCurrency(a, b);
	return money(a.amountMinor + b.amountMinor, a.currency);
}

export function multiplyMoney(value: Money, quantity: number): Money {
	if (!Number.isSafeInteger(quantity) || quantity < 0) {
		throw new RangeError(`Quantity must be a non-negative integer, got ${quantity}`);
	}
	return money(value.amountMinor * quantity, value.currency);
}

export function assertSameCurrency(a: Money, b: Money): void {
	if (a.currency !== b.currency) {
		throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
	}
}

/** Converts a provider decimal amount (e.g. Mercado Pago `transaction_amount`) to minor units. */
export function decimalToMinor(amount: number): number {
	return Math.round(amount * 100);
}

export function minorToDecimal(amountMinor: number): number {
	return amountMinor / 100;
}

export function formatMoney(value: Money, locale = 'es-AR'): string {
	const hasCents = value.amountMinor % 100 !== 0;
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: value.currency,
		minimumFractionDigits: hasCents ? 2 : 0,
		maximumFractionDigits: 2
	}).format(minorToDecimal(value.amountMinor));
}
