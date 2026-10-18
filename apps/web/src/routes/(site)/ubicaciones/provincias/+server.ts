import { countryCodeSchema } from '@sortea/domain';
import { json } from '@sveltejs/kit';
import { api } from '#lib/server/api.js';
import type { SubdivisionOption } from '#lib/location.js';
import type { RequestHandler } from './$types';

/** The checkout's province list for a country (S6). The browser asks here; only the server talks to the API. */
export const GET: RequestHandler = async (event) => {
	const country = countryCodeSchema.safeParse(event.url.searchParams.get('pais') ?? '');
	if (!event.locals.site || !country.success) return json({ subdivisions: [] }, { status: 400 });
	const result = await api<{ subdivisions: SubdivisionOption[] }>(event, `/geo/countries/${country.data}/subdivisions`);
	if (!result.ok) return json({ subdivisions: [] }, { status: result.status === 404 ? 404 : 502 });
	// The same for every visitor and rarely changes.
	return json(result.data, { headers: { 'cache-control': 'public, max-age=3600' } });
};
