import { redirect } from '@sveltejs/kit';
import { api } from '#lib/server/api.js';
import { serverEnv } from '#lib/server/config.js';
import type { PageServerLoad } from './$types';

/**
 * Exchanges an emailed download link for a one-minute signed file URL. The
 * file is served by Supabase Storage, so the redirect may leave the site, but
 * only to that origin.
 */
export const load: PageServerLoad = async (event) => {
	const result = await api<{ url: string }>(event, `/downloads/${encodeURIComponent(event.params.token)}`);
	if (result.ok) redirect(302, result.data.url, { external: [new URL(serverEnv('SUPABASE_URL')).origin] });
	return { message: result.message };
};
