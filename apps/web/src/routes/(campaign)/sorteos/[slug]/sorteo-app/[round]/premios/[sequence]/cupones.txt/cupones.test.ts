import { afterEach, describe, expect, it, vi } from 'vitest';

// ADR 0026 §6 (odd/tasks/draw-room.md T9): each tirada of an `app` prize has its candidate
// list as a plain-text download whose SHA-256 is the published one. The site passes the API's
// bytes through untouched, so `sha256sum` of the file equals the tirada's `candidateSha256`.
vi.mock('#lib/server/config.js', () => ({ serverEnv: (name: string) => ({ API_INTERNAL_URL: 'http://api.internal', INTERNAL_API_TOKEN: 'token' })[name] }));

const { GET } = await import('./+server');

const list = '0000\n0001\n0003';
const call = (round: string, sequence: string) =>
	GET({ params: { slug: 'moto', round, sequence }, url: new URL(`https://demo.localhost/sorteos/moto/sorteo-app/${round}/premios/${sequence}/cupones.txt`) } as never);

afterEach(() => vi.unstubAllGlobals());

describe('downloading the candidate list of an app prize tirada', () => {
	it('passes the plain text through byte for byte, from the tenant of the host', async () => {
		const fetch = vi.fn(async () => new Response(list, { headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-sha256': 'ab'.repeat(32) } }));
		vi.stubGlobal('fetch', fetch);
		const response = await call('1', '2');
		expect(fetch).toHaveBeenCalledWith('http://api.internal/public/campaigns/moto/app-draws/1/prizes/2/candidates.txt', {
			headers: { 'x-internal-token': 'token', 'x-tenant-host': 'demo.localhost' }
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(list);
		expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(response.headers.get('content-disposition')).toBe('attachment; filename="moto-cupones-sorteo-app-ronda-1-premio-2.txt"');
		expect(response.headers.get('x-content-sha256')).toBe('ab'.repeat(32));
		expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
	});

	it('answers 404 for a tirada the API does not have, and never asks the API for a malformed round or tirada', async () => {
		const fetch = vi.fn(async () => new Response('{}', { status: 404 }));
		vi.stubGlobal('fetch', fetch);
		await expect(call('1', '9')).rejects.toMatchObject({ status: 404 });
		await expect(call('uno', '1')).rejects.toMatchObject({ status: 404 });
		await expect(call('1', '0')).rejects.toMatchObject({ status: 404 });
		await expect(call('1', 'dos')).rejects.toMatchObject({ status: 404 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
