import { describe, expect, it } from 'vitest';
import { buyerCountry, citySearchSchema, countryCodeSchema, countryName, locationSearchKey, organizationCountry, shipsTo } from '../src';

describe('world locations (S6)', () => {
	it('normalizes names for case- and accent-insensitive prefix search', () => {
		expect(locationSearchKey('Río Cuarto')).toBe('rio cuarto');
		expect(locationSearchKey('  SÃO   Paulo ')).toBe('sao paulo');
		expect(locationSearchKey('Ñuble')).toBe('nuble');
		expect(locationSearchKey('rio cuarto')).toBe(locationSearchKey('RÍO CUARTO'));
	});

	it('accepts ISO 3166-1 alpha-2 codes, trimmed and upper-cased', () => {
		expect(countryCodeSchema.parse(' cl ')).toBe('CL');
		expect(countryCodeSchema.safeParse('ARG').success).toBe(false);
		expect(countryCodeSchema.safeParse('A1').success).toBe(false);
		expect(countryCodeSchema.safeParse('').success).toBe(false);
	});

	it('names countries in Spanish', () => {
		expect(countryName('AR')).toBe('Argentina');
		expect(countryName('BR')).toBe('Brasil');
		expect(countryName('US')).toBe('Estados Unidos');
	});

	it('bounds the city search', () => {
		expect(citySearchSchema.parse({ q: ' Ros ' })).toEqual({ q: 'Ros', limit: 10 });
		expect(citySearchSchema.parse({ q: 'Ros', subdivision: '21', limit: '5' })).toEqual({ q: 'Ros', subdivision: '21', limit: 5 });
		expect(citySearchSchema.safeParse({ q: '' }).success).toBe(false);
		expect(citySearchSchema.safeParse({ q: '%%' }).success).toBe(false);
		expect(citySearchSchema.safeParse({ q: 'x'.repeat(81) }).success).toBe(false);
		expect(citySearchSchema.safeParse({ q: 'Ros', limit: 21 }).success).toBe(false);
		expect(citySearchSchema.safeParse({ q: 'Ros', limit: 0 }).success).toBe(false);
		expect(citySearchSchema.safeParse({ q: 'Ros', subdivision: '../x' }).success).toBe(false);
	});

	it('reads orders saved before the country was asked as the organization country', () => {
		expect(organizationCountry).toBe('AR');
		expect(buyerCountry({})).toBe('AR');
		expect(buyerCountry({ country: null })).toBe('AR');
		expect(buyerCountry({ country: 'UY' })).toBe('UY');
	});

	it('ships only inside the organization country', () => {
		expect(shipsTo('AR')).toBe(true);
		expect(shipsTo('UY')).toBe(false);
	});
});
