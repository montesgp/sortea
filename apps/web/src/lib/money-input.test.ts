import { describe, expect, it } from 'vitest';
import { moneyInputValue, parseMoneyInput } from './money-input';

// odd/tasks/campaign-finance.md S2: expenses are typed in pesos as people write them in Argentina
// (dot for thousands, comma for centavos) and sent to the API in integer minor units.

describe('parseMoneyInput', () => {
	it.each([
		['12500', 1_250_000],
		['12.500', 1_250_000],
		['12500,50', 1_250_050],
		['12.500,50', 1_250_050],
		['12.500,5', 1_250_050],
		['1.234.567', 123_456_700],
		['0,99', 99],
		['  $ 12.500  ', 1_250_000],
		['$12.500,05', 1_250_005]
	])('reads %j as %i centavos', (text, minor) => {
		expect(parseMoneyInput(text)).toEqual({ ok: true, value: minor });
	});

	it.each(['', '   ', 'abc', '12,500,5', '12.50', '1.2345', '12500,505', '-500', '12 500', '1e5', ',50', '12.500,', '.500'])('refuses %j with a message in Spanish', (text) => {
		const result = parseMoneyInput(text);
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ message: expect.stringMatching(/^(Escribí el monto en pesos|Indicá el monto)/) });
	});

	it('refuses zero', () => {
		expect(parseMoneyInput('0')).toEqual({ ok: false, message: 'Indicá un monto mayor que cero' });
		expect(parseMoneyInput('0,00')).toEqual({ ok: false, message: 'Indicá un monto mayor que cero' });
	});

	it('refuses an amount above the expense limit, without losing precision', () => {
		expect(parseMoneyInput('10.000.000.000')).toEqual({ ok: true, value: 1_000_000_000_000 });
		expect(parseMoneyInput('10.000.000.000,01')).toEqual({ ok: false, message: 'El monto es demasiado grande' });
		expect(parseMoneyInput('99999999999999999999')).toEqual({ ok: false, message: 'El monto es demasiado grande' });
	});

	it('says how to write it', () => {
		expect(parseMoneyInput('12.50')).toEqual({ ok: false, message: 'Escribí el monto en pesos, por ejemplo 12.500 o 12500,50' });
		expect(parseMoneyInput('')).toEqual({ ok: false, message: 'Indicá el monto del gasto' });
	});
});

describe('moneyInputValue', () => {
	it('writes minor units back as the field shows them, and reads back the same amount', () => {
		expect(moneyInputValue(1_250_000)).toBe('12.500');
		expect(moneyInputValue(1_250_050)).toBe('12.500,50');
		expect(moneyInputValue(1_250_005)).toBe('12.500,05');
		expect(moneyInputValue(99)).toBe('0,99');
		for (const minor of [1, 99, 100, 1_250_050, 123_456_789, 1_000_000_000_000]) expect(parseMoneyInput(moneyInputValue(minor))).toEqual({ ok: true, value: minor });
	});
});
