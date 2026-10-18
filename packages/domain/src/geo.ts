import { z } from 'zod';

/**
 * World locations (S6, S7, ADR 0012). Countries, first-level subdivisions and
 * cities come from GeoNames and only suggest: a buyer can always type a place
 * that is not listed.
 */

/**
 * The country every organization sells from. Organizations have no country
 * setting yet; when they do, this becomes its default. Orders saved before
 * the buyer's country was asked are read as this country.
 */
export const organizationCountry = 'AR';

/** ISO 3166-1 alpha-2, trimmed and upper-cased. */
export const countryCodeSchema = z
	.string()
	.trim()
	.toUpperCase()
	.regex(/^[A-Z]{2}$/, 'País inválido');

/** Lower case, without accents and with single spaces: how names are compared and searched. */
export function locationSearchKey(text: string): string {
	return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A city prefix search inside one country, optionally inside one subdivision. */
export const citySearchSchema = z.object({
	q: z
		.string()
		.trim()
		.min(1)
		.max(80)
		.refine((value) => /[\p{L}\p{N}]/u.test(value), 'Escribí parte del nombre'),
	/** GeoNames admin1 code, for example `21` for Santa Fe. */
	subdivision: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9]{1,20}$/)
		.optional(),
	limit: z.coerce.number().int().min(1).max(20).default(10)
});
export type CitySearch = z.infer<typeof citySearchSchema>;

const displayNames = new Map<string, Intl.DisplayNames>();

/** The country's name in the given locale (Spanish by default); the code when the runtime does not know it. */
export function countryName(code: string, locale = 'es-AR'): string {
	let names = displayNames.get(locale);
	if (!names) {
		names = new Intl.DisplayNames(locale, { type: 'region', fallback: 'code' });
		displayNames.set(locale, names);
	}
	try {
		return names.of(code) ?? code;
	} catch {
		return code;
	}
}

/** The buyer's country, for orders saved before it was asked too. */
export function buyerCountry(buyer: { country?: string | null }): string {
	return buyer.country ?? organizationCountry;
}

/** Home shipping is offered only inside the organization's country; pickup and digital products are offered everywhere. */
export function shipsTo(country: string): boolean {
	return country === organizationCountry;
}
