import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createObjectStore, MEDIA_CACHE_CONTROL, scopedStore, SITE_MEDIA_PREFIX, type ObjectStoreConfig } from '../src/object-store';

/**
 * Against a real S3 API: the local MinIO of docker-compose.yml. Opt-in, because
 * the suite must run without Docker: set S3_TEST_ENDPOINT (for example
 * http://127.0.0.1:9000) and, unless they are the compose defaults,
 * S3_TEST_ACCESS_KEY_ID and S3_TEST_SECRET_ACCESS_KEY. It uses its own bucket
 * (`sortea-test`) and removes every object it writes.
 */
const endpoint = process.env.S3_TEST_ENDPOINT;

const config: ObjectStoreConfig = {
	endpoint: endpoint ?? 'http://127.0.0.1:9000',
	region: 'us-east-1',
	bucket: 'sortea-test',
	accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'sortea-local',
	secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'sortea-local-secret',
	forcePathStyle: true
};
const store = createObjectStore(config);
const media = scopedStore(store, SITE_MEDIA_PREFIX);
const org = randomUUID();

describe.skipIf(!endpoint)('object store on MinIO', () => {
	afterAll(async () => {
		await store.remove(await store.list(`${SITE_MEDIA_PREFIX}${org}/`));
		await store.remove(await store.list(`backups/test-${org}/`));
	});

	it('streams an upload larger than a part as a multipart upload, and reads it back', async () => {
		await store.ensureBucket();
		const key = `backups/test-${org}/big.dump`;
		const part = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
		async function* chunks() {
			for (let i = 0; i < 6; i++) yield part;
		}
		expect(await store.putStream(key, chunks(), { contentType: 'application/octet-stream' })).toBe(18 * 1024 * 1024);
		let length = 0;
		let sample = -1;
		for await (const chunk of await store.getStream(key)) {
			if (sample < 0) sample = chunk[1000]!;
			length += chunk.byteLength;
		}
		expect(length).toBe(18 * 1024 * 1024);
		expect(sample).toBe(1000 % 251);
	});

	it('creates its bucket once', async () => {
		expect(['created', 'exists']).toContain(await store.ensureBucket());
		expect(await store.ensureBucket()).toBe('exists');
	});

	it('stores, lists, serves with Range through a presigned URL, and removes', async () => {
		const bytes = new TextEncoder().encode('0123456789abcdef');
		const path = `${org}/${'e'.repeat(64)}.mp4`;
		await media.put(path, bytes, { contentType: 'video/mp4', cacheControl: MEDIA_CACHE_CONTROL });

		expect(await media.exists(path)).toBe(true);
		expect(await media.list(`${org}/`)).toEqual([path]);

		const url = await media.presignGet(path, { expiresInSeconds: 600, signedAt: new Date(Date.now() - 60_000) });
		const whole = await fetch(url);
		expect(whole.status).toBe(200);
		expect(whole.headers.get('content-type')).toBe('video/mp4');
		expect(whole.headers.get('cache-control')).toBe(MEDIA_CACHE_CONTROL);
		const part = await fetch(url, { headers: { range: 'bytes=4-7' } });
		expect(part.status).toBe(206);
		expect(await part.text()).toBe('4567');

		const download = await fetch(await store.presignGet(`${SITE_MEDIA_PREFIX}${path}`, { expiresInSeconds: 60, downloadName: 'Video.mp4' }));
		expect(download.headers.get('content-disposition')).toContain('attachment; filename="Video.mp4"');

		await media.remove([path]);
		expect(await media.exists(path)).toBe(false);
		expect(await media.list(`${org}/`)).toEqual([]);
	});
});
