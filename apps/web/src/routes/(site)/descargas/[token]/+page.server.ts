import { error, redirect } from '@sveltejs/kit';
import { api } from '#lib/server/api.js';
import { serverEnv } from '#lib/server/config.js';
import { storageRedirect } from '#lib/storage-redirect.js';
import type { PageServerLoad } from './$types';

/**
 * Exchanges an emailed download link for a one-minute presigned file URL. The
 * file is served by the S3 bucket, so the redirect leaves the site, but only to
 * the origin files are served from (MEDIA_PUBLIC_ORIGIN, ADR 0020).
 */
export const load: PageServerLoad = async (event) => {
	const result = await api<{ url: string }>(event, `/downloads/${encodeURIComponent(event.params.token)}`);
	if (result.ok) {
		const filesOrigin = serverEnv('MEDIA_PUBLIC_ORIGIN');
		const location = storageRedirect(result.data.url, filesOrigin);
		if (!location) error(502, 'La descarga no está disponible en este momento. Probá de nuevo en unos minutos');
		redirect(302, location, { external: [new URL(filesOrigin).origin] });
	}
	return { message: result.message };
};
