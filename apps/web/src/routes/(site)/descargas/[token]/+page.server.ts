import { redirect } from '@sveltejs/kit';
import { api } from '#lib/server/api.js';
import type { PageServerLoad } from './$types';

/** Exchanges an emailed download link for a one-minute signed file URL. */
export const load: PageServerLoad = async (event) => {
	const result = await api<{ url: string }>(event, `/downloads/${encodeURIComponent(event.params.token)}`);
	if (result.ok) redirect(302, result.data.url);
	return { message: result.message };
};
