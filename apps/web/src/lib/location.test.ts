import { describe, expect, it, vi } from 'vitest';
import { cityOptionLabel, countryGroups, debounce, OTHER_PROVINCE, resolveProvince, subdivisionCode } from './location';

// S6, S7 (feedback 2026-10-18): the checkout picks a country (Argentina first among
// Latin America), suggests provinces and cities, and always takes a typed place.

describe('country groups', () => {
	it('puts Latin America first, then every other country, with Spanish names in Spanish order', () => {
		const groups = countryGroups(['US', 'UY', 'AR', 'ES', 'BR', 'DE', 'MX']);
		expect(groups).toEqual([
			{
				label: 'Latinoamérica',
				countries: [
					{ code: 'AR', name: 'Argentina' },
					{ code: 'BR', name: 'Brasil' },
					{ code: 'MX', name: 'México' },
					{ code: 'UY', name: 'Uruguay' }
				]
			},
			{
				label: 'Resto del mundo',
				countries: [
					{ code: 'DE', name: 'Alemania' },
					{ code: 'ES', name: 'España' },
					{ code: 'US', name: 'Estados Unidos' }
				]
			}
		]);
	});

	it('always offers the organization country, even before the reference data is imported', () => {
		expect(countryGroups([])).toEqual([{ label: 'Latinoamérica', countries: [{ code: 'AR', name: 'Argentina' }] }]);
	});
});

describe('province', () => {
	it('takes the chosen subdivision, or the typed one when the buyer picked "other" or the list is missing', () => {
		expect(resolveProvince('Santa Fe', 'algo')).toBe('Santa Fe');
		expect(resolveProvince(OTHER_PROVINCE, '  Isla Martín García ')).toBe('Isla Martín García');
		expect(resolveProvince('', 'Región Nueva')).toBe('Región Nueva');
		expect(resolveProvince(undefined, undefined)).toBe('');
		expect(resolveProvince(OTHER_PROVINCE, '')).toBe('');
	});

	it('finds the code of a chosen subdivision to narrow the city search', () => {
		const list = [
			{ code: '21', name: 'Santa Fe' },
			{ code: '05', name: 'Córdoba' }
		];
		expect(subdivisionCode(list, 'Córdoba')).toBe('05');
		expect(subdivisionCode(list, OTHER_PROVINCE)).toBeUndefined();
		expect(subdivisionCode(list, 'Mendoza')).toBeUndefined();
	});
});

describe('city suggestions', () => {
	it('names the subdivision only when no province narrows the search', () => {
		const city = { id: 1, name: 'Rosario', subdivision: { code: '21', name: 'Santa Fe' } };
		expect(cityOptionLabel(city, false)).toBe('Rosario, Santa Fe');
		expect(cityOptionLabel(city, true)).toBe('Rosario');
		expect(cityOptionLabel({ ...city, subdivision: null }, false)).toBe('Rosario');
	});

	it('waits until the buyer stops typing', () => {
		vi.useFakeTimers();
		const calls: string[] = [];
		const search = debounce((value: string) => calls.push(value), 250);
		search('r');
		search('ro');
		vi.advanceTimersByTime(200);
		search('ros');
		expect(calls).toEqual([]);
		vi.advanceTimersByTime(250);
		expect(calls).toEqual(['ros']);
		vi.useRealTimers();
	});
});
