import { afterEach, describe, expect, it, vi } from 'vitest';

// odd/tasks/owner-feedback-2026-11-11b.md T13 (S12, L18): the candidate list of an in-app draw is
// a plain-text download whose SHA-256 is the published one. The site passes the API's bytes
// through untouched, so `sha256sum` of the file equals `candidateSha256`.
vi.mock('#lib/server/config.js', () => ({ serverEnv: (name: string) => ({ API_INTERNAL_URL: 'http://api.internal', INTERNAL_API_TOKEN: 'token' })[name] }));

const { GET } = await import('./+server');

const list = '0000\n0001\n0003';
const call = (round: string) => GET({ params: { slug: 'moto', round }, url: new URL(`https://demo.localhost/sorteos/moto/sorteo-app/${round}/cupones.txt`) } as never);

afterEach(() => vi.unstubAllGlobals());

describe('downloading the candidate list', () => {
	it('passes the plain text through byte for byte, from the tenant of the host', async () => {
		const fetch = vi.fn(async () => new Response(list, { headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-sha256': 'ab'.repeat(32) } }));
		vi.stubGlobal('fetch', fetch);
		const response = await call('1');
		expect(fetch).toHaveBeenCalledWith('http://api.internal/public/campaigns/moto/app-draws/1/candidates.txt', {
			headers: { 'x-internal-token': 'token', 'x-tenant-host': 'demo.localhost' }
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(list);
		expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(response.headers.get('content-disposition')).toBe('attachment; filename="moto-cupones-sorteo-app-ronda-1.txt"');
		expect(response.headers.get('x-content-sha256')).toBe('ab'.repeat(32));
		expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
	});

	it('answers 404 for a round without an in-app draw, and never asks the API for a malformed round', async () => {
		const fetch = vi.fn(async () => new Response('{}', { status: 404 }));
		vi.stubGlobal('fetch', fetch);
		await expect(call('2')).rejects.toMatchObject({ status: 404 });
		await expect(call('uno')).rejects.toMatchObject({ status: 404 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
