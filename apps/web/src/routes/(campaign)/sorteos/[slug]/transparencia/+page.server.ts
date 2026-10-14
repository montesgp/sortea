import { error } from '@sveltejs/kit';
import { api } from '#lib/server/api.js';
import type { Transparency } from '#lib/server/types.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const result = await api<Transparency>(event, `/public/campaigns/${encodeURIComponent(event.params.slug)}/transparency`);
	if (!result.ok) error(result.status === 404 ? 404 : 503, result.status === 404 ? 'Campaña no encontrada' : result.message);
	return { transparency: result.data };
};
