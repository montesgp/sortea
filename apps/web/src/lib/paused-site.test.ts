import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// S13 (owner feedback 2026-11-10): the public site of a suspended organization
// says it is paused, with 503, instead of "Sitio no encontrado"; the panel on
// the same domain keeps working so platform staff can reactivate it.

const api = vi.fn();
vi.mock('./server/api', () => ({ api: (...args: unknown[]) => api(...args) }));
vi.mock('$app/env', () => ({ dev: false }));

const { pausedSiteResponse, pausesRequest } = await import('./server/paused-site');
const { loadSite, invalidateSite } = await import('./server/site');

const event = (host: string) => ({ url: new URL(`https://${host}/`), getClientAddress: () => '203.0.113.9', fetch }) as never;

beforeEach(() => api.mockReset());

describe('paused site', () => {
	it('answers 503 with a plain page, not indexed, not cached, and nothing about the organization', async () => {
		const response = pausedSiteResponse();
		expect(response.status).toBe(503);
		expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
		expect(response.headers.get('retry-after')).toBe('3600');
		const html = await response.text();
		expect(html).toContain('<h1>Este sitio está pausado momentáneamente</h1>');
		expect(html).toContain('lang="es-AR"');
		expect(html).not.toMatch(/suspend|organizaci/i);
	});

	it('allows only its own inline style through its CSP', async () => {
		const response = pausedSiteResponse();
		const html = await response.text();
		const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
		const hash = createHash('sha256').update(style).digest('base64');
		expect(response.headers.get('content-security-policy')).toBe(
			`default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
		);
	});

	it('pauses every path but the panel', () => {
		for (const path of ['/', '/carrito', '/campanas/moto', '/media/x.jpg', '/administrar', '/adminx']) expect(pausesRequest(path)).toBe(true);
		for (const path of ['/admin', '/admin/', '/admin/login', '/admin/plataforma/abc']) expect(pausesRequest(path)).toBe(false);
	});
});

describe('site state per host', () => {
	it('remembers a suspended site, and forgets it when told', async () => {
		api.mockResolvedValue({ ok: false, status: 503, code: 'site_suspended', message: 'Este sitio está pausado momentáneamente' });
		expect(await loadSite(event('pausado.test'))).toEqual({ site: null, suspended: true });
		expect(await loadSite(event('pausado.test'))).toEqual({ site: null, suspended: true });
		expect(api).toHaveBeenCalledTimes(1);
		invalidateSite('pausado.test');
		api.mockResolvedValue({ ok: true, status: 200, data: { organization: { name: 'Taller Demo' } } });
		expect(await loadSite(event('pausado.test'))).toEqual({ site: { organization: { name: 'Taller Demo' } }, suspended: false });
	});

	it('an unknown host and an unreachable API are not a paused site', async () => {
		api.mockResolvedValue({ ok: false, status: 404, code: 'unknown_tenant', message: 'Sitio no encontrado' });
		expect(await loadSite(event('nadie.test'))).toEqual({ site: null, suspended: false });
		api.mockResolvedValue({ ok: false, status: 503, code: 'api_unreachable', message: 'El servicio no está disponible' });
		expect(await loadSite(event('caido.test'))).toEqual({ site: null, suspended: false });
	});
});
