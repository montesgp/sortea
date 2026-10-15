import { describe, expect, it } from 'vitest';
import { minorToInput, parseMoneyInput } from './catalog';

describe('amounts typed in es-AR', () => {
	it('reads thousands separators, decimal commas and currency signs', () => {
		expect(parseMoneyInput('12000')).toBe(1_200_000);
		expect(parseMoneyInput('12.000')).toBe(1_200_000);
		expect(parseMoneyInput('$ 1.234,56')).toBe(123_456);
		expect(parseMoneyInput('12000,5')).toBe(1_200_050);
		expect(parseMoneyInput('12.5')).toBe(1_250);
		expect(parseMoneyInput('0,10')).toBe(10);
	});

	it('rejects what is not an amount', () => {
		expect(parseMoneyInput('')).toBeNull();
		expect(parseMoneyInput('doce')).toBeNull();
		expect(parseMoneyInput('12,345')).toBeNull();
		expect(parseMoneyInput('-100')).toBeNull();
		expect(parseMoneyInput('1.2.3')).toBeNull();
	});

	it('round-trips through the input format', () => {
		for (const minor of [1_200_000, 1_200_050, 10, 0]) expect(parseMoneyInput(minorToInput(minor))).toBe(minor);
	});
});
