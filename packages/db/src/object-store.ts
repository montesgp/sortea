import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateBucketCommand,
	CreateMultipartUploadCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	UploadPartCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * The platform's files in one S3-compatible bucket per environment (ADR 0020,
 * "Files"): Railway Buckets in deployments, MinIO locally, or any other S3 API
 * (AWS S3, Cloudflare R2, Google Cloud Storage interoperability). The bucket is
 * private; files are read only through presigned URLs. The API, the operator
 * commands and the local tools all go through this module.
 *
 * Kinds of file live under fixed prefixes of the bucket. Stored paths
 * (`product_assets.storage_path`, `cms_media.storage_path`) never include the
 * prefix: they stay `<organizationId>/...`, and `scopedStore` adds it.
 */

/** Paid downloads (PDF and ZIP): `product-assets/<organizationId>/<productId>/<hash>.<ext>`. */
export const PRODUCT_ASSETS_PREFIX = 'product-assets/';
/** Site images and videos: `site-media/<organizationId>/<sha256>.<ext>`. */
export const SITE_MEDIA_PREFIX = 'site-media/';
/** Reserved for the nightly database dumps (ADR 0020, "Database"); never an organization's files. */
export const BACKUPS_PREFIX = 'backups/';

/** Media objects are named by their hash, so their content never changes under a URL. */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export interface ObjectStoreConfig {
	/** S3 API endpoint; null means AWS S3 itself. */
	endpoint: string | null;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key` (MinIO needs it). */
	forcePathStyle: boolean;
}

export class ObjectStoreConfigError extends Error {}

/**
 * The bucket from the environment. The variables map one to one to the
 * credentials a Railway Bucket shows (README, "Deploy"). Errors name the
 * missing variables, never a value.
 */
export function objectStoreConfigFromEnv(env: Record<string, string | undefined> = process.env): ObjectStoreConfig {
	const required = ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;
	const missing = required.filter((key) => !env[key]);
	if (missing.length > 0) throw new ObjectStoreConfigError(`Set ${missing.join(', ')} for the bucket of this environment (S3_ENDPOINT too, unless it is AWS S3).`);
	return {
		endpoint: env.S3_ENDPOINT || null,
		region: env.S3_REGION!,
		bucket: env.S3_BUCKET!,
		accessKeyId: env.S3_ACCESS_KEY_ID!,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
		forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true'
	};
}

/** An S3 endpoint on this machine or in the local Docker network (the compose `minio` service). */
export function isLocalEndpoint(endpoint: string | null | undefined): boolean {
	if (!endpoint) return false;
	try {
		return ['127.0.0.1', 'localhost', 'minio'].includes(new URL(endpoint).hostname);
	} catch {
		return false;
	}
}

export function createS3Client(config: ObjectStoreConfig): S3Client {
	return new S3Client({
		region: config.region,
		...(config.endpoint ? { endpoint: config.endpoint } : {}),
		forcePathStyle: config.forcePathStyle,
		credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
		// Checksums only where S3 requires them: several S3-compatible stores refuse the newer defaults.
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED'
	});
}

export interface PresignOptions {
	expiresInSeconds: number;
	/** Served as an attachment with this name (product downloads). */
	downloadName?: string;
	/** Signing time; the same time, key and options give the same URL (media windows). */
	signedAt?: Date;
}

export interface PutOptions {
	contentType: string;
	cacheControl?: string;
}

export interface ObjectStore {
	readonly bucket: string;
	/** Origin of the presigned URLs: what the web allows as redirect target and in its CSP (MEDIA_PUBLIC_ORIGIN). */
	readonly origin: string;
	/** Where the bucket is, for operator output: host and bucket, never credentials. */
	readonly location: string;
	put(key: string, bytes: Uint8Array, options: PutOptions): Promise<void>;
	/**
	 * Uploads a stream of unknown length without holding it in memory: one PUT
	 * when it fits in a part, otherwise a multipart upload that is aborted on
	 * any error, so a failed upload leaves no object. Returns the bytes written.
	 */
	putStream(key: string, chunks: AsyncIterable<Uint8Array>, options: PutOptions): Promise<number>;
	/** The object's bytes as a stream. */
	getStream(key: string): Promise<AsyncIterable<Uint8Array>>;
	exists(key: string): Promise<boolean>;
	/** Every key under `prefix`, across pages. */
	list(prefix: string): Promise<string[]>;
	remove(keys: string[]): Promise<void>;
	presignGet(key: string, options: PresignOptions): Promise<string>;
	/** Creates the bucket when it is missing. Local development only; deployed buckets are created by the platform. */
	ensureBucket(): Promise<'created' | 'exists'>;
}

const DELETE_BATCH = 1000;
/** Multipart part size: S3 needs at least 5 MiB for every part but the last. */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

/** Re-chunks a stream into parts of exactly `size` bytes (the last one may be shorter). */
async function* parts(chunks: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Buffer> {
	let pending: Buffer[] = [];
	let length = 0;
	for await (const chunk of chunks) {
		pending.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		length += chunk.byteLength;
		while (length >= size) {
			const joined = Buffer.concat(pending, length);
			yield joined.subarray(0, size);
			pending = [joined.subarray(size)];
			length -= size;
		}
	}
	if (length > 0 || pending.length === 0) yield Buffer.concat(pending, length);
}

function httpStatus(error: unknown): number | undefined {
	return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

/** `attachment` with an ASCII fallback name and the exact name in RFC 5987 form. */
function contentDisposition(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
	const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function originOf(config: ObjectStoreConfig): string {
	const endpoint = new URL(config.endpoint ?? `https://s3.${config.region}.amazonaws.com`);
	return config.forcePathStyle ? endpoint.origin : `${endpoint.protocol}//${config.bucket}.${endpoint.host}`;
}

export function createObjectStore(config: ObjectStoreConfig, client: S3Client = createS3Client(config)): ObjectStore {
	const Bucket = config.bucket;
	const origin = originOf(config);

	return {
		bucket: Bucket,
		origin,
		location: `${new URL(origin).host}${config.forcePathStyle ? `/${Bucket}` : ''}`,

		async put(key, bytes, options) {
			await client.send(new PutObjectCommand({ Bucket, Key: key, Body: bytes, ContentType: options.contentType, ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}) }));
		},

		async putStream(key, chunks, options) {
			const headers = { ContentType: options.contentType, ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}) };
			const iterator = parts(chunks, UPLOAD_PART_BYTES)[Symbol.asyncIterator]();
			const first = await iterator.next();
			const firstPart = first.done ? Buffer.alloc(0) : first.value;
			const second = first.done ? first : await iterator.next();
			if (second.done) {
				await client.send(new PutObjectCommand({ Bucket, Key: key, Body: firstPart, ...headers }));
				return firstPart.byteLength;
			}
			const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ...headers }));
			try {
				const done: { ETag: string | undefined; PartNumber: number }[] = [];
				let written = 0;
				const upload = async (body: Buffer) => {
					const PartNumber = done.length + 1;
					const { ETag } = await client.send(new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber, Body: body }));
					done.push({ ETag, PartNumber });
					written += body.byteLength;
				};
				await upload(firstPart);
				await upload(second.value);
				for (let next = await iterator.next(); !next.done; next = await iterator.next()) await upload(next.value);
				await client.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId, MultipartUpload: { Parts: done } }));
				return written;
			} catch (error) {
				await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId })).catch(() => {});
				throw error;
			}
		},

		async getStream(key) {
			const { Body } = await client.send(new GetObjectCommand({ Bucket, Key: key }));
			if (!Body) throw new Error(`Empty response for ${key}`);
			return Body as AsyncIterable<Uint8Array>;
		},

		async exists(key) {
			try {
				await client.send(new HeadObjectCommand({ Bucket, Key: key }));
				return true;
			} catch (error) {
				// Only a missing object is "no"; any other storage error is reported.
				if (httpStatus(error) === 404) return false;
				throw error;
			}
		},

		async list(prefix) {
			const keys: string[] = [];
			let token: string | undefined;
			do {
				const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
				for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
				token = page.IsTruncated ? page.NextContinuationToken : undefined;
			} while (token);
			return keys;
		},

		async remove(keys) {
			for (let i = 0; i < keys.length; i += DELETE_BATCH) {
				const batch = keys.slice(i, i + DELETE_BATCH);
				const result = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
				const failed = result?.Errors ?? [];
				if (failed.length > 0) throw new Error(failed.map((entry) => `Could not delete ${entry.Key}: ${entry.Code ?? 'error'}`).join('; '));
			}
		},

		async presignGet(key, options) {
			const command = new GetObjectCommand({ Bucket, Key: key, ...(options.downloadName ? { ResponseContentDisposition: contentDisposition(options.downloadName) } : {}) });
			return getSignedUrl(client, command, { expiresIn: options.expiresInSeconds, ...(options.signedAt ? { signingDate: options.signedAt } : {}) });
		},

		async ensureBucket() {
			try {
				await client.send(new HeadBucketCommand({ Bucket }));
				return 'exists';
			} catch (error) {
				if (httpStatus(error) !== 404) throw error;
			}
			await client.send(new CreateBucketCommand({ Bucket }));
			return 'created';
		}
	};
}

/** One kind of file: keys and listings relative to its prefix of the bucket. */
export interface ScopedStore {
	readonly prefix: string;
	put(path: string, bytes: Uint8Array, options: PutOptions): Promise<void>;
	getStream(path: string): Promise<AsyncIterable<Uint8Array>>;
	exists(path: string): Promise<boolean>;
	/** Paths (without the scope's prefix) under `prefix`. */
	list(prefix: string): Promise<string[]>;
	remove(paths: string[]): Promise<void>;
	presignGet(path: string, options: PresignOptions): Promise<string>;
}

export function scopedStore(store: ObjectStore, prefix: string): ScopedStore {
	const key = (path: string) => `${prefix}${path}`;
	return {
		prefix,
		put: (path, bytes, options) => store.put(key(path), bytes, options),
		getStream: (path) => store.getStream(key(path)),
		exists: (path) => store.exists(key(path)),
		list: async (inner) => (await store.list(key(inner))).map((found) => found.slice(prefix.length)),
		remove: (paths) => store.remove(paths.map(key)),
		presignGet: (path, options) => store.presignGet(key(path), options)
	};
}
