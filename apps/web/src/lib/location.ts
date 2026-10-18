import { countryName, organizationCountry } from '@sortea/domain';

/**
 * The checkout's location fields (S6, S7, ADR 0012): a country, then province and
 * city suggested from our GeoNames copy. Suggestions never restrict: a typed place
 * is always accepted.
 */

export interface CountryOption {
	code: string;
	name: string;
}

export interface SubdivisionOption {
	code: string;
	name: string;
}

export interface CityOption {
	id: number;
	name: string;
	subdivision: SubdivisionOption | null;
}

/** Home shipping stays inside the organization's country; elsewhere there is pickup and digital products (ADR 0012). */
export const SHIPPING_ONLY_HOME = `El envío a domicilio es solo dentro de ${countryName(organizationCountry)}`;

/** The province select's choice for "not in the list": the typed field is used instead. */
export const OTHER_PROVINCE = '__otra__';

const latinAmerica = new Set(['AR', 'BO', 'BR', 'CL', 'CO', 'CR', 'CU', 'DO', 'EC', 'GT', 'HN', 'MX', 'NI', 'PA', 'PE', 'PR', 'PY', 'SV', 'UY', 'VE']);

/** Latin America first, then the rest, each in Spanish alphabetical order. The organization's country is always there. */
export function countryGroups(codes: string[]): { label: string; countries: CountryOption[] }[] {
	const unique = [...new Set([organizationCountry, ...codes])];
	const options = unique.map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
	const groups = [
		{ label: 'Latinoamérica', countries: options.filter((option) => latinAmerica.has(option.code)) },
		{ label: 'Resto del mundo', countries: options.filter((option) => !latinAmerica.has(option.code)) }
	];
	return groups.filter((group) => group.countries.length > 0);
}

/** The buyer's country as the API reads it: trimmed, upper case, the organization's when missing. */
export function formCountry(value: string | undefined): string {
	return (value ?? '').trim().toUpperCase() || organizationCountry;
}

/** The province to send: the chosen one, or what the buyer typed when it is not in the list. */
export function resolveProvince(chosen: string | undefined, typed: string | undefined): string {
	if (chosen && chosen !== OTHER_PROVINCE) return chosen;
	return (typed ?? '').trim();
}

export function subdivisionCode(subdivisions: SubdivisionOption[], name: string): string | undefined {
	return subdivisions.find((subdivision) => subdivision.name === name)?.code;
}

/** A suggestion names its province when the search was not narrowed to one, so homonyms can be told apart. */
export function cityOptionLabel(city: CityOption, narrowed: boolean): string {
	return !narrowed && city.subdivision ? `${city.name}, ${city.subdivision.name}` : city.name;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (...args: A) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	};
}
