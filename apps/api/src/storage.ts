import { MEDIA_CACHE_CONTROL, PRODUCT_ASSETS_PREFIX, scopedStore, SITE_MEDIA_PREFIX, type ObjectStore } from '@sortea/db/object-store';
import type { FileStorage, MediaStorage } from './context';

/**
 * Product files and site media in the environment's S3 bucket (ADR 0020,
 * "Files"). The bucket is private and its credentials never leave the API:
 * the web gets presigned URLs only.
 */

/** Paid downloads under `product-assets/`, served as attachments for a few seconds. */
export function createS3FileStorage(store: ObjectStore): FileStorage {
	const files = scopedStore(store, PRODUCT_ASSETS_PREFIX);
	return {
		signedUrl: (path, expiresInSeconds, downloadName) => files.presignGet(path, { expiresInSeconds, downloadName }),
		upload: (path, bytes, contentType) => files.put(path, bytes, { contentType }),
		exists: (path) => files.exists(path),
		remove: (paths) => files.remove(paths)
	};
}

/**
 * Media URLs are signed once per fixed window of this length, aligned to UTC,
 * and stay valid for two windows from its start. Within a window the same file
 * keeps the same URL, so browsers cache the file and the redirect to it.
 */
export const MEDIA_URL_WINDOW_SECONDS = 12 * 60 * 60;

export function mediaUrlWindow(now: Date): { signedAt: Date; expiresInSeconds: number; maxAgeSeconds: number } {
	const windowMs = MEDIA_URL_WINDOW_SECONDS * 1000;
	const start = Math.floor(now.getTime() / windowMs) * windowMs;
	return {
		signedAt: new Date(start),
		expiresInSeconds: 2 * MEDIA_URL_WINDOW_SECONDS,
		// Until the window ends; the URL itself stays valid one window longer.
		maxAgeSeconds: Math.ceil((start + windowMs - now.getTime()) / 1000)
	};
}

/**
 * Site images and videos under `site-media/`. Only the API writes them; objects
 * are named by their hash, so they are cached forever. The site addresses them
 * as `/media/<path>` and the web redirects to `signedUrl`.
 */
export function createS3MediaStorage(store: ObjectStore): MediaStorage {
	const media = scopedStore(store, SITE_MEDIA_PREFIX);
	return {
		upload: (path, bytes, contentType) => media.put(path, bytes, { contentType, cacheControl: MEDIA_CACHE_CONTROL }),
		remove: (path) => media.remove([path]),
		publicUrl: (path) => `/media/${path}`,
		async signedUrl(path, now) {
			const window = mediaUrlWindow(now);
			const url = await media.presignGet(path, { expiresInSeconds: window.expiresInSeconds, signedAt: window.signedAt });
			return { url, maxAgeSeconds: window.maxAgeSeconds };
		}
	};
}
