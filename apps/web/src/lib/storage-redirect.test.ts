import { describe, expect, it } from 'vitest';
import { mediaRedirect, storageRedirect, type MediaSignResult } from './storage-redirect';

// Files are served by the S3 bucket through presigned URLs (ADR 0020, "Files"). The web only
// redirects there: to the origin the files are served from (MEDIA_PUBLIC_ORIGIN), never elsewhere.

const files = 'https://storage.example.test';
const org = '0b0e3c55-8f5e-4c39-9b8a-6c1c2f0e9a11';
const key = `${org}/${'c'.repeat(64)}.jpg`;
const signed = `${files}/sortea/site-media/${key}?X-Amz-Signature=abc`;

describe('storage redirect', () => {
	it('allows a URL on the files origin', () => {
		expect(storageRedirect(signed, files)).toBe(signed);
		expect(storageRedirect('http://127.0.0.1:9000/sortea/product-assets/a.pdf?X-Amz-Signature=1', 'http://127.0.0.1:9000')).toBe(
			'http://127.0.0.1:9000/sortea/product-assets/a.pdf?X-Amz-Signature=1'
		);
	});

	it('refuses any other origin, look-alikes, plain http for an https origin and credentials in the URL', () => {
		for (const url of [
			'https://evil.test/sortea/a.pdf',
			'https://storage.example.test.evil.test/a.pdf',
			'http://storage.example.test/a.pdf',
			'https://storage.example.test:8443/a.pdf',
			'https://user:pass@storage.example.test/a.pdf',
			'javascript:alert(1)',
			'/media/a.jpg',
			'not a url'
		]) {
			expect(storageRedirect(url, files), url).toBeNull();
		}
	});

	it('refuses everything when the files origin is not configured', () => {
		expect(storageRedirect(signed, '')).toBeNull();
	});
});

describe('/media/<key>', () => {
	function signer(result: MediaSignResult) {
		const asked: string[] = [];
		return { asked, sign: async (asking: string) => (asked.push(asking), result) };
	}

	it('redirects to the presigned URL, cached until its window ends', async () => {
		const { asked, sign } = signer({ ok: true, status: 200, data: { url: signed, maxAgeSeconds: 3600 } });
		const response = await mediaRedirect(key, sign, files);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe(signed);
		expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
		expect(asked).toEqual([key]);
	});

	it('answers 404 without asking the API for anything that is not a library path', async () => {
		for (const bad of [
			`${org}/../other/${'c'.repeat(64)}.jpg`,
			`../${key}`,
			`site-media/${key}`,
			`product-assets/${org}/p/0123456789abcdef.pdf`,
			`backups/${key}`,
			`${org}/${'c'.repeat(64)}.svg`,
			`${org}/${'c'.repeat(63)}.jpg`,
			''
		]) {
			const { asked, sign } = signer({ ok: true, status: 200, data: { url: signed, maxAgeSeconds: 3600 } });
			const response = await mediaRedirect(bad, sign, files);
			expect(response.status, bad).toBe(404);
			expect(asked, bad).toEqual([]);
		}
	});

	it('passes on a 404 of the API (another organization’s file, unknown site)', async () => {
		const { sign } = signer({ ok: false, status: 404, code: 'not_found', message: 'Archivo no encontrado' });
		const response = await mediaRedirect(key, sign, files);
		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('never follows a URL off the files origin, and does not cache failures', async () => {
		const { sign } = signer({ ok: true, status: 200, data: { url: 'https://evil.test/a.jpg', maxAgeSeconds: 3600 } });
		const response = await mediaRedirect(key, sign, files);
		expect(response.status).toBe(502);
		expect(response.headers.get('location')).toBeNull();

		const down = await mediaRedirect(key, signer({ ok: false, status: 503, code: 'api_unreachable', message: 'x' }).sign, files);
		expect(down.status).toBe(503);
		expect(down.headers.get('cache-control')).toBe('no-store');
	});
});
