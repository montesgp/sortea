import {
	CompleteMultipartUploadCommand,
	DeleteObjectsCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	UploadPartCommand
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
	createObjectStore,
	isLocalEndpoint,
	objectStoreConfigFromEnv,
	ObjectStoreConfigError,
	PRODUCT_ASSETS_PREFIX,
	scopedStore,
	SITE_MEDIA_PREFIX,
	type ObjectStoreConfig
} from '../src/object-store';

// The bucket is reached only through the S3 API (ADR 0020, "Files"). Presigning is computed
// locally, so these tests need no storage service; listing and deleting use a stubbed client.

const local: ObjectStoreConfig = {
	endpoint: 'http://127.0.0.1:9000',
	region: 'us-east-1',
	bucket: 'sortea-local',
	accessKeyId: 'test-access-key',
	secretAccessKey: 'test-secret-key-0123456789',
	forcePathStyle: true
};

describe('object store configuration', () => {
	it('reads the S3 variables, one per credential of a Railway bucket', () => {
		const config = objectStoreConfigFromEnv({
			S3_ENDPOINT: 'https://storage.example.test',
			S3_REGION: 'auto',
			S3_BUCKET: 'sortea-staging',
			S3_ACCESS_KEY_ID: 'key',
			S3_SECRET_ACCESS_KEY: 'secret',
			S3_FORCE_PATH_STYLE: 'true'
		});
		expect(config).toEqual({ endpoint: 'https://storage.example.test', region: 'auto', bucket: 'sortea-staging', accessKeyId: 'key', secretAccessKey: 'secret', forcePathStyle: true });
	});

	it('defaults to virtual-hosted style and to AWS when no endpoint is set', () => {
		expect(objectStoreConfigFromEnv({ S3_REGION: 'sa-east-1', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' })).toMatchObject({ endpoint: null, forcePathStyle: false });
	});

	it('names every missing variable, and never a value', () => {
		expect(() => objectStoreConfigFromEnv({ S3_BUCKET: 'b', S3_SECRET_ACCESS_KEY: 'do-not-print' })).toThrow(ObjectStoreConfigError);
		expect(() => objectStoreConfigFromEnv({ S3_BUCKET: 'b', S3_SECRET_ACCESS_KEY: 'do-not-print' })).toThrow('Set S3_REGION, S3_ACCESS_KEY_ID');
		try {
			objectStoreConfigFromEnv({ S3_BUCKET: 'b', S3_SECRET_ACCESS_KEY: 'do-not-print' });
		} catch (error) {
			expect(String(error)).not.toContain('do-not-print');
		}
	});

	it('tells a local endpoint from a deployed one', () => {
		for (const endpoint of ['http://127.0.0.1:9000', 'http://localhost:9000', 'http://minio:9000']) expect(isLocalEndpoint(endpoint), endpoint).toBe(true);
		for (const endpoint of [null, 'https://storage.example.test', 'https://s3.sa-east-1.amazonaws.com', 'http://127.0.0.1.example.test']) expect(isLocalEndpoint(endpoint), String(endpoint)).toBe(false);
	});
});

describe('presigned GET', () => {
	it('signs a download under product-assets/ with its expiry and download name', async () => {
		const files = scopedStore(createObjectStore(local), PRODUCT_ASSETS_PREFIX);
		const url = new URL(await files.presignGet('org/product/abc.pdf', { expiresInSeconds: 60, downloadName: 'Manual-Tecnico.pdf' }));
		expect(url.origin).toBe('http://127.0.0.1:9000');
		expect(url.pathname).toBe('/sortea-local/product-assets/org/product/abc.pdf');
		expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
		expect(url.searchParams.get('response-content-disposition')).toBe(`attachment; filename="Manual-Tecnico.pdf"; filename*=UTF-8''Manual-Tecnico.pdf`);
		expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^test-access-key\/\d{8}\/us-east-1\/s3\/aws4_request$/);
		expect(url.href).not.toContain(local.secretAccessKey);
	});

	it('quotes a download name that is not plain ASCII', async () => {
		const store = createObjectStore(local);
		const url = new URL(await store.presignGet('product-assets/a.pdf', { expiresInSeconds: 60, downloadName: 'Guía "visual".pdf' }));
		expect(url.searchParams.get('response-content-disposition')).toBe(`attachment; filename="Gu_a _visual_.pdf"; filename*=UTF-8''Gu%C3%ADa%20%22visual%22.pdf`);
	});

	it('gives the same URL for the same signing time, so a window can be cached', async () => {
		const store = createObjectStore(local);
		const signedAt = new Date('2026-11-09T12:00:00Z');
		const first = await store.presignGet('site-media/a.jpg', { expiresInSeconds: 3600, signedAt });
		const again = await store.presignGet('site-media/a.jpg', { expiresInSeconds: 3600, signedAt });
		const later = await store.presignGet('site-media/a.jpg', { expiresInSeconds: 3600, signedAt: new Date('2026-11-09T13:00:00Z') });
		expect(again).toBe(first);
		expect(later).not.toBe(first);
		expect(new URL(first).searchParams.get('X-Amz-Date')).toBe('20261109T120000Z');
	});

	it('reports the origin its URLs use, in both addressing styles', async () => {
		const pathStyle = createObjectStore(local);
		expect(new URL(await pathStyle.presignGet('k', { expiresInSeconds: 60 })).origin).toBe(pathStyle.origin);
		expect(pathStyle.origin).toBe('http://127.0.0.1:9000');

		const virtual = createObjectStore({ ...local, endpoint: 'https://storage.example.test', forcePathStyle: false });
		const url = new URL(await virtual.presignGet('k', { expiresInSeconds: 60 }));
		expect(url.origin).toBe(virtual.origin);
		expect(virtual.origin).toBe('https://sortea-local.storage.example.test');
	});
});

/** A real client whose network calls are answered here, recording each command. */
function stubbedStore(answer: (command: unknown) => unknown) {
	const client = new S3Client({ region: local.region, endpoint: local.endpoint!, forcePathStyle: true, credentials: { accessKeyId: 'k', secretAccessKey: 's' } });
	const sent: unknown[] = [];
	vi.spyOn(client, 'send').mockImplementation((async (command: unknown) => {
		sent.push(command);
		return answer(command);
	}) as never);
	return { store: createObjectStore(local, client), sent };
}

describe('listing and deleting', () => {
	it('lists every key under a prefix across pages, relative to its scope', async () => {
		const pages: Record<string, { Contents: { Key: string }[]; IsTruncated: boolean; NextContinuationToken?: string }> = {
			start: { Contents: [{ Key: 'site-media/org-1/a.jpg' }, { Key: 'site-media/org-1/b.mp4' }], IsTruncated: true, NextContinuationToken: 'next' },
			next: { Contents: [{ Key: 'site-media/org-1/c.png' }], IsTruncated: false }
		};
		const { store, sent } = stubbedStore((command) => pages[(command as ListObjectsV2Command).input.ContinuationToken ?? 'start']);
		const media = scopedStore(store, SITE_MEDIA_PREFIX);

		expect(await media.list('org-1/')).toEqual(['org-1/a.jpg', 'org-1/b.mp4', 'org-1/c.png']);
		expect(sent.map((command) => (command as ListObjectsV2Command).input)).toEqual([
			{ Bucket: 'sortea-local', Prefix: 'site-media/org-1/', ContinuationToken: undefined },
			{ Bucket: 'sortea-local', Prefix: 'site-media/org-1/', ContinuationToken: 'next' }
		]);
	});

	it('an empty prefix lists nothing', async () => {
		const { store } = stubbedStore(() => ({ IsTruncated: false }));
		expect(await scopedStore(store, PRODUCT_ASSETS_PREFIX).list('org-1/')).toEqual([]);
	});

	it('deletes in batches of at most 1000 keys under its scope, and fails on any key the bucket refused', async () => {
		const { store, sent } = stubbedStore(() => ({}));
		const files = scopedStore(store, PRODUCT_ASSETS_PREFIX);
		await files.remove(Array.from({ length: 1001 }, (_, index) => `org-1/${index}.pdf`));
		const batches = sent.map((command) => (command as DeleteObjectsCommand).input.Delete!.Objects!.map((object) => object.Key));
		expect(batches.map((batch) => batch.length)).toEqual([1000, 1]);
		expect(batches[0]![0]).toBe('product-assets/org-1/0.pdf');

		const refusing = stubbedStore(() => ({ Errors: [{ Key: 'product-assets/org-1/x.pdf', Code: 'AccessDenied', Message: 'Access Denied' }] }));
		await expect(scopedStore(refusing.store, PRODUCT_ASSETS_PREFIX).remove(['org-1/x.pdf'])).rejects.toThrow('Could not delete product-assets/org-1/x.pdf: AccessDenied');
	});

	it('removing nothing sends nothing', async () => {
		const { store, sent } = stubbedStore(() => ({}));
		await store.remove([]);
		expect(sent).toEqual([]);
	});
});

describe('streaming uploads (database backups)', () => {
	async function* chunks(sizes: number[]) {
		for (const size of sizes) yield new Uint8Array(size).fill(7);
	}
	const name = (command: unknown) => (command as { constructor: { name: string } }).constructor.name;

	it('sends a stream that fits in one part as a single PUT', async () => {
		const { store, sent } = stubbedStore(() => ({}));
		expect(await store.putStream('backups/x/a.dump', chunks([1000, 2000]), { contentType: 'application/octet-stream' })).toBe(3000);
		expect(sent.map(name)).toEqual(['PutObjectCommand']);
		expect(((sent[0] as PutObjectCommand).input.Body as Buffer).byteLength).toBe(3000);
	});

	it('sends a larger stream as a multipart upload of 8 MiB parts', async () => {
		const { store, sent } = stubbedStore((command) => (name(command) === 'CreateMultipartUploadCommand' ? { UploadId: 'u1' } : name(command) === 'UploadPartCommand' ? { ETag: `"${sent.length}"` } : {}));
		const mib = 1024 * 1024;
		expect(await store.putStream('backups/x/b.dump', chunks([5 * mib, 5 * mib, 7 * mib]), { contentType: 'application/octet-stream' })).toBe(17 * mib);
		expect(sent.map(name)).toEqual(['CreateMultipartUploadCommand', 'UploadPartCommand', 'UploadPartCommand', 'UploadPartCommand', 'CompleteMultipartUploadCommand']);
		const parts = sent.filter((c) => name(c) === 'UploadPartCommand').map((c) => (c as UploadPartCommand).input);
		expect(parts.map((p) => [p.PartNumber, (p.Body as Buffer).byteLength])).toEqual([
			[1, 8 * mib],
			[2, 8 * mib],
			[3, mib]
		]);
		expect((sent.at(-1) as CompleteMultipartUploadCommand).input.MultipartUpload?.Parts?.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
	});

	it('aborts the multipart upload when the stream fails, so no partial object stays', async () => {
		const { store, sent } = stubbedStore((command) => (name(command) === 'CreateMultipartUploadCommand' ? { UploadId: 'u1' } : {}));
		async function* broken() {
			yield new Uint8Array(17 * 1024 * 1024);
			throw new Error('pg_dump died');
		}
		await expect(store.putStream('backups/x/c.dump', broken(), { contentType: 'application/octet-stream' })).rejects.toThrow('pg_dump died');
		expect(sent.map(name)).toEqual(['CreateMultipartUploadCommand', 'UploadPartCommand', 'UploadPartCommand', 'AbortMultipartUploadCommand']);
	});
});
