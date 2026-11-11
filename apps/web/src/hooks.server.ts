import { dev } from '$app/env';
import type { Handle } from '@sveltejs/kit/hooks';
import { ADMIN_MODE_COOKIE, pageMode } from '#lib/admin-theme.js';
import { bodyRejection, videoUploaderRejection } from '#lib/body-limit.js';
import { healthResponse } from '#lib/health.js';
import { verifiedAdminPermissions } from '#lib/server/admin-session.js';
import { pausedSiteResponse, pausesRequest } from '#lib/server/paused-site.js';
import { loadSite } from '#lib/server/site.js';
import { captureTracking } from '#lib/server/tracking.js';
import { allowThemeStyle, themeStyleText } from '#lib/theme-style-csp.js';

export const handle: Handle = async ({ event, resolve }) => {
	const health = healthResponse(event.request.method, event.url.pathname);
	if (health) return health;

	// Before anything reads the body: only the video upload may be large (ADR 0009).
	const bodyRequest = { method: event.request.method, url: event.url, headers: event.request.headers };
	const rejected = bodyRejection(bodyRequest) ?? (await videoUploaderRejection(bodyRequest, () => verifiedAdminPermissions(event)));
	if (rejected) return new Response(rejected.message, { status: rejected.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

	const { site, suspended } = await loadSite(event);
	// A suspended organization's site is paused before any page loads; its panel stays reachable (S13).
	if (suspended && pausesRequest(event.url.pathname)) return pausedSiteResponse();
	event.locals.site = site;
	// Visits through a tracking link of this site's organization (odd/tasks/tracking-links.md S2); may redirect.
	if (event.locals.site) await captureTracking(event);
	// Every public load uses the site's default; the visitor's switch is not stored (feedback 2026-10-19).
	// The back office uses the theme this browser chose in "Mi cuenta" (owner feedback 2026-11-10 S11).
	const mode = pageMode({ pathname: event.url.pathname, adminCookie: event.cookies.get(ADMIN_MODE_COOKIE), siteDefault: event.locals.site?.theme.defaultMode });
	event.locals.mode = mode.mode;
	event.locals.followSystem = mode.followSystem;

	const themeCss = event.locals.site?.theme.css ?? '';
	const response = await resolve(event, {
		transformPageChunk: ({ html }) =>
			html
				.replace('%sortea.mode%', event.locals.mode)
				.replace('%sortea.mode-follow%', event.locals.followSystem ? 'system' : '')
				.replace('/*sortea-theme*/', themeStyleText(themeCss))
	});
	// The CSP allows only the site's own stylesheets; the inlined theme is allowed by its exact hash.
	const policy = response.headers.get('content-security-policy');
	const withTheme = allowThemeStyle(policy, themeCss);
	if (withTheme && withTheme !== policy) response.headers.set('content-security-policy', withTheme);

	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
	response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
	if (!dev) response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
	// The panel is never linked from the site; search engines must not list it either.
	if (event.url.pathname === '/admin' || event.url.pathname.startsWith('/admin/')) response.headers.set('x-robots-tag', 'noindex, nofollow');
	return response;
};
