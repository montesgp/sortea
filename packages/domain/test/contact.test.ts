import { describe, expect, it } from 'vitest';
import { mapsLink, mapsUrlSchema, normalizeWhatsApp, publicContact, publicSocial, socialLinksSchema, socialNetworks, whatsappLink, whatsappNumberSchema } from '../src';

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

describe('social links (S8, feedback 2026-10-18)', () => {
	it('keeps an https link of its own network, with or without www', () => {
		expect(
			socialLinksSchema.parse({
				instagram: 'https://www.instagram.com/motogaragearrecifes/',
				tiktok: ' https://www.tiktok.com/@tallermotogarage ',
				youtube: 'https://youtube.com/@Tallermotogarage',
				facebook: 'https://facebook.com/motogarage'
			})
		).toEqual({
			instagram: 'https://www.instagram.com/motogaragearrecifes/',
			tiktok: 'https://www.tiktok.com/@tallermotogarage',
			youtube: 'https://youtube.com/@Tallermotogarage',
			facebook: 'https://facebook.com/motogarage'
		});
		expect(socialLinksSchema.parse({ youtube: 'https://youtu.be/abc', facebook: 'https://m.facebook.com/x' })).toEqual({ youtube: 'https://youtu.be/abc', facebook: 'https://m.facebook.com/x' });
	});

	it('an empty field removes that network', () => {
		expect(socialLinksSchema.parse({ instagram: '', tiktok: '  ', youtube: undefined })).toEqual({});
	});

	it('refuses http, another network\'s address and look-alike hosts, saying which field', () => {
		for (const [field, value] of [
			['instagram', 'http://instagram.com/x'],
			['tiktok', 'https://www.instagram.com/x'],
			['youtube', 'https://youtube.com.evil.test/x'],
			['facebook', 'https://notfacebook.com/x'],
			['instagram', 'instagram.com/x'],
			['tiktok', `https://www.tiktok.com/${'x'.repeat(300)}`]
		] as const) {
			const result = socialLinksSchema.safeParse({ [field]: value });
			expect(result.success, `${field} ${value}`).toBe(false);
			expect(result.error?.issues[0]?.path).toEqual([field]);
			expect(result.error?.issues[0]?.message).toBe(`Pegá el enlace completo de tu perfil de ${socialNetworks[field]}, empezando por https://`);
		}
	});

	it('the public site only ever sees valid links of the four networks', () => {
		expect(publicSocial({ instagram: 'https://instagram.com/a', tiktok: 'javascript:alert(1)', other: 'https://x.test' } as never)).toEqual({ instagram: 'https://instagram.com/a' });
	});
});

describe('Google Maps location link (S3, feedback 2026-10-30)', () => {
	it('keeps an https link on a Google Maps host', () => {
		for (const value of [
			'https://maps.app.goo.gl/3PR5ZLqycPPozsAe7',
			'https://goo.gl/maps/abc123',
			'https://www.google.com/maps/place/Arrecifes',
			'https://google.com/maps?q=-34.06,-60.10',
			'https://www.google.com.ar/maps/place/Arrecifes',
			'https://maps.google.com/?q=Arrecifes',
			'https://maps.google.com.ar/maps?q=Arrecifes'
		]) {
			expect(mapsUrlSchema.parse(` ${value} `), value).toBe(value);
			expect(mapsLink(value), value).toBe(value);
		}
	});

	it('an empty value clears it', () => {
		expect(mapsUrlSchema.parse('')).toBeNull();
		expect(mapsUrlSchema.parse('   ')).toBeNull();
	});

	it('refuses http, other hosts, look-alikes and non-map Google pages, in Spanish', () => {
		for (const value of [
			'http://maps.app.goo.gl/3PR5ZLqycPPozsAe7',
			'https://www.openstreetmap.org/#map=15/-34.06/-60.10',
			'https://maps.app.goo.gl.evil.test/x',
			'https://evilmaps.google.com/x',
			'https://goo.gl/abc123',
			'https://www.google.com/search?q=motogarage',
			'https://www.google.com/mapsevil',
			'https://user:pass@maps.app.goo.gl/x',
			'https://maps.app.goo.gl:8443/x',
			'maps.app.goo.gl/3PR5ZLqycPPozsAe7',
			'javascript:alert(1)',
			`https://maps.app.goo.gl/${'x'.repeat(500)}`
		]) {
			const result = mapsUrlSchema.safeParse(value);
			expect(result.success, value).toBe(false);
			expect(result.error?.issues[0]?.message).toBe('Pegá el enlace de Google Maps completo, empezando por https://');
			expect(mapsLink(value), value).toBeNull();
		}
	});

	it('the public contact exposes only a valid map link', () => {
		expect(publicContact({ city: 'Arrecifes', mapsUrl: 'https://maps.app.goo.gl/3PR5ZLqycPPozsAe7' })).toEqual({ city: 'Arrecifes', mapsUrl: 'https://maps.app.goo.gl/3PR5ZLqycPPozsAe7' });
		expect(publicContact({ mapsUrl: 'https://evil.test/maps' })).toEqual({});
		expect(publicContact({ mapsUrl: 42 })).toEqual({});
	});
});
