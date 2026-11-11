import { createObjectStore, createS3Client, MEDIA_CACHE_CONTROL, type ObjectStoreConfig } from '@sortea/db/object-store';
import { describe, expect, it, vi } from 'vitest';
import { createS3FileStorage, createS3MediaStorage, MEDIA_URL_WINDOW_SECONDS, mediaUrlWindow } from '../src/storage';

// Product files and site media live in one S3 bucket under two prefixes (ADR 0020, "Files").

const config: ObjectStoreConfig = {
	endpoint: 'http://127.0.0.1:9000',
	region: 'us-east-1',
	bucket: 'sortea-test',
	accessKeyId: 'test-access-key',
	secretAccessKey: 'test-secret-key-0123456789',
	forcePathStyle: true
};
const mediaPath = `0b0e3c55-8f5e-4c39-9b8a-6c1c2f0e9a11/${'a'.repeat(64)}.jpg`;

describe('product file downloads', () => {
	it('presign a GET under product-assets/ for the given seconds, with the download name', async () => {
		const files = createS3FileStorage(createObjectStore(config));
		const url = new URL(await files.signedUrl('org/product/0123456789abcdef.pdf', 60, 'Manual-Tecnico.pdf'));
		expect(url.origin).toBe('http://127.0.0.1:9000');
		expect(url.pathname).toBe('/sortea-test/product-assets/org/product/0123456789abcdef.pdf');
		expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
		expect(url.searchParams.get('response-content-disposition')).toContain('attachment; filename="Manual-Tecnico.pdf"');
	});
});

describe('site media', () => {
	it('is addressed by the site as /media/<path>, on its own origin', () => {
		expect(createS3MediaStorage(createObjectStore(config)).publicUrl(mediaPath)).toBe(`/media/${mediaPath}`);
	});

	it('uploads under site-media/ with its type and a cache that never expires (content-addressed)', async () => {
		const client = createS3Client(config);
		const sent: { input: unknown }[] = [];
		vi.spyOn(client, 'send').mockImplementation((async (command: { input: unknown }) => void sent.push(command)) as never);
		await createS3MediaStorage(createObjectStore(config, client)).upload(mediaPath, new Uint8Array([1, 2, 3]), 'image/jpeg');
		expect(sent).toHaveLength(1);
		expect(sent[0]!.input).toMatchObject({ Bucket: 'sortea-test', Key: `site-media/${mediaPath}`, ContentType: 'image/jpeg', CacheControl: MEDIA_CACHE_CONTROL });
	});

	it('presigns one URL per fixed window: the same within it, a new one in the next', async () => {
		const media = createS3MediaStorage(createObjectStore(config));
		const windowStart = new Date('2026-11-09T12:00:00Z');
		const atStart = await media.signedUrl(mediaPath, windowStart);
		const laterInWindow = await media.signedUrl(mediaPath, new Date(windowStart.getTime() + MEDIA_URL_WINDOW_SECONDS * 1000 - 1000));
		const nextWindow = await media.signedUrl(mediaPath, new Date(windowStart.getTime() + MEDIA_URL_WINDOW_SECONDS * 1000));

		expect(laterInWindow.url).toBe(atStart.url);
		expect(nextWindow.url).not.toBe(atStart.url);
		const url = new URL(atStart.url);
		expect(url.pathname).toBe(`/sortea-test/site-media/${mediaPath}`);
		expect(url.searchParams.get('X-Amz-Date')).toBe('20261109T120000Z');
		// Valid for two windows from the start of its own, so a cached redirect never points to an expired URL.
		expect(url.searchParams.get('X-Amz-Expires')).toBe(String(2 * MEDIA_URL_WINDOW_SECONDS));
		expect(atStart.maxAgeSeconds).toBe(MEDIA_URL_WINDOW_SECONDS);
		expect(laterInWindow.maxAgeSeconds).toBe(1);
	});

	it('windows are twelve hours, aligned to UTC, and the redirect is cached until the window ends', () => {
		expect(MEDIA_URL_WINDOW_SECONDS).toBe(12 * 3600);
		expect(mediaUrlWindow(new Date('2026-11-09T17:30:00Z'))).toEqual({
			signedAt: new Date('2026-11-09T12:00:00Z'),
			expiresInSeconds: 24 * 3600,
			maxAgeSeconds: 6.5 * 3600
		});
	});
});
