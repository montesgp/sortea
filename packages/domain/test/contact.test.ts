import { describe, expect, it } from 'vitest';
import { normalizeWhatsApp, publicContact, whatsappLink, whatsappNumberSchema } from '../src';

describe('WhatsApp contact number (S5)', () => {
	it('normalizes an Argentine mobile written with spaces and dashes to wa.me digits', () => {
		expect(normalizeWhatsApp('+54 9 2478 40-7084')).toBe('5492478407084');
		expect(normalizeWhatsApp('5492478407084')).toBe('5492478407084');
		expect(normalizeWhatsApp('0054 9 (2478) 40.7084')).toBe('5492478407084');
	});

	it('accepts an Argentine line without the mobile 9 and other countries in international form', () => {
		expect(normalizeWhatsApp('+54 2478 407084')).toBe('542478407084');
		expect(normalizeWhatsApp('+598 99 123 456')).toBe('59899123456');
		expect(normalizeWhatsApp('+1 (415) 555-0100')).toBe('14155550100');
	});

	it('rejects numbers without a country code, with letters, or with the wrong length', () => {
		for (const value of ['2478 40-7084', '011 15 4444-5555', '+54 9 2478 40-708', '+54 9 2478 40-70845', '+54 9 2478 CALL', '+0 123 4567', '+1234567', '+1234567890123456', '', '++5492478407084']) {
			expect(normalizeWhatsApp(value), value).toBeNull();
		}
	});

	it('the schema stores digits, clears with an empty value and explains the format in Spanish', () => {
		expect(whatsappNumberSchema.parse(' +54 9 2478 40-7084 ')).toBe('5492478407084');
		expect(whatsappNumberSchema.parse('')).toBeNull();
		const result = whatsappNumberSchema.safeParse('2478 40-7084');
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toBe('Ingresá el número con código de país, por ejemplo +54 9 2478 40-7084');
	});

	it('links to wa.me only for a valid number, with an optional prefilled text', () => {
		expect(whatsappLink('5492478407084')).toBe('https://wa.me/5492478407084');
		expect(whatsappLink('+54 9 2478 40-7084', 'Hola, vengo desde la web')).toBe('https://wa.me/5492478407084?text=Hola%2C%20vengo%20desde%20la%20web');
		expect(whatsappLink(undefined)).toBeNull();
		expect(whatsappLink('no es un número')).toBeNull();
	});

	it('a saved number of any country keeps its link and stays public', () => {
		for (const [typed, digits] of [['+598 99 123 456', '59899123456'], ['+1 (415) 555-0100', '14155550100'], ['+54 9 2478 40-7084', '5492478407084']]) {
			const stored = whatsappNumberSchema.parse(typed);
			expect(stored).toBe(digits);
			expect(publicContact({ whatsapp: stored })).toEqual({ whatsapp: digits });
			expect(whatsappLink(stored)).toBe(`https://wa.me/${digits}`);
		}
		expect(publicContact({ whatsapp: '0598991234' })).toEqual({});
	});
});
