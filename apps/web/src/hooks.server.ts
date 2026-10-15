import { dev } from '$app/env';
import type { Handle } from '@sveltejs/kit/hooks';
import { loadSite } from '#lib/server/site.js';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.site = await loadSite(event);
	const preferred = event.cookies.get('sortea_mode');
	event.locals.mode = preferred === 'light' || preferred === 'dark' ? preferred : (event.locals.site?.theme.defaultMode ?? 'dark');

	const themeCss = event.locals.site?.theme.css ?? '';
	const response = await resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replace('%sortea.mode%', event.locals.mode).replace('/*sortea-theme*/', themeCss.replace(/<\/style/gi, ''))
	});

	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
	response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
	if (!dev) response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
	return response;
};
