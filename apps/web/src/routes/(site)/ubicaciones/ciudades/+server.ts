import { citySearchSchema, countryCodeSchema } from '@sortea/domain';
import { json } from '@sveltejs/kit';
import { api } from '#lib/server/api.js';
import type { CityOption } from '#lib/location.js';
import type { RequestHandler } from './$types';

/** City suggestions while the buyer types (S6). Any typed city is still accepted at checkout (S7). */
export const GET: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const country = countryCodeSchema.safeParse(params.get('pais') ?? '');
	const search = citySearchSchema.safeParse({ q: params.get('q') ?? '', subdivision: params.get('provincia') || undefined, limit: 8 });
	if (!event.locals.site || !country.success || !search.success) return json({ cities: [] }, { status: 400 });
	const query = new URLSearchParams({ q: search.data.q, limit: String(search.data.limit) });
	if (search.data.subdivision) query.set('subdivision', search.data.subdivision);
	const result = await api<{ cities: CityOption[] }>(event, `/geo/countries/${country.data}/cities?${query}`);
	if (!result.ok) return json({ cities: [] }, { status: result.status === 404 ? 404 : 502 });
	return json(result.data, { headers: { 'cache-control': 'public, max-age=3600' } });
};
