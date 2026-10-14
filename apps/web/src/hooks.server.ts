import { dev } from '$app/env';
import type { Handle } from '@sveltejs/kit/hooks';
import { api } from '#lib/server/api.js';
import type { SiteData } from '#lib/server/types.js';

const cache = new Map<string, { site: SiteData | null; expires: number }>();
const SITE_TTL_MS = dev ? 2_000 : 30_000;

async function loadSite(event: Parameters<Handle>[0]['event']): Promise<SiteData | null> {
	const host = event.url.hostname;
	const hit = cache.get(host);
	if (hit && hit.expires > Date.now()) return hit.site;
	const result = await api<SiteData>(event, '/public/site');
	const site = result.ok ? result.data : null;
	// Do not cache outages; do cache "unknown host" briefly.
	if (result.ok || result.status === 404) cache.set(host, { site, expires: Date.now() + SITE_TTL_MS });
	return site;
}

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
