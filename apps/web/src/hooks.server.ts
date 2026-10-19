import { dev } from '$app/env';
import type { Handle } from '@sveltejs/kit/hooks';
import { bodyRejection, videoUploaderRejection } from '#lib/body-limit.js';
import { verifiedAdminPermissions } from '#lib/server/admin-session.js';
import { loadSite } from '#lib/server/site.js';

export const handle: Handle = async ({ event, resolve }) => {
	// Before anything reads the body: only the video upload may be large (ADR 0009).
	const bodyRequest = { method: event.request.method, url: event.url, headers: event.request.headers };
	const rejected = bodyRejection(bodyRequest) ?? (await videoUploaderRejection(bodyRequest, () => verifiedAdminPermissions(event)));
	if (rejected) return new Response(rejected.message, { status: rejected.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

	event.locals.site = await loadSite(event);
	// Every load uses the site's default; the visitor's switch is not stored (feedback 2026-10-19).
	event.locals.mode = event.locals.site?.theme.defaultMode ?? 'dark';

	const themeCss = event.locals.site?.theme.css ?? '';
	const response = await resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replace('%sortea.mode%', event.locals.mode).replace('/*sortea-theme*/', themeCss.replace(/<\/style/gi, ''))
	});

	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
	response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
	if (!dev) response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
	// The panel is never linked from the site; search engines must not list it either.
	if (event.url.pathname === '/admin' || event.url.pathname.startsWith('/admin/')) response.headers.set('x-robots-tag', 'noindex, nofollow');
	return response;
};
