import { createHash } from 'node:crypto';

/**
 * The public site of a suspended organization (S13, owner feedback
 * 2026-11-10): a plain 503 page instead of "Sitio no encontrado", saying
 * nothing about the organization or why. `handle` answers it before any page
 * loads, so nothing is sold or shown; the panel (/admin) keeps working, so
 * platform staff can reactivate the organization from its own domain.
 */

const style =
	':root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:1.5rem}main{max-width:32rem;display:grid;gap:.75rem}h1{margin:0;font-size:clamp(1.6rem,1.2rem + 2vw,2.4rem);line-height:1.1}p{margin:0;opacity:.75}';

const html = `<!doctype html><html lang="es-AR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Sitio pausado</title><style>${style}</style></head><body><main><h1>Este sitio está pausado momentáneamente</h1><p>Volvé a visitarlo en un rato.</p></main></body></html>`;

// The page is answered outside SvelteKit's rendering, so it carries its own CSP: only this style.
const policy = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(style).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export function pausedSiteResponse(): Response {
	return new Response(html, {
		status: 503,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'retry-after': '3600',
			'content-security-policy': policy,
			'x-content-type-options': 'nosniff',
			'referrer-policy': 'strict-origin-when-cross-origin',
			'x-robots-tag': 'noindex, nofollow'
		}
	});
}

/** Every path of a suspended organization's domain is paused except the panel. */
export function pausesRequest(pathname: string): boolean {
	return pathname !== '/admin' && !pathname.startsWith('/admin/');
}
