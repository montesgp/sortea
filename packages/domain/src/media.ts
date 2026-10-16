import { z } from 'zod';

/**
 * Files uploaded to the public media bucket (ADR 0008, ADR 0009): images for
 * the site and videos of what is raffled. The kind is decided by the file's
 * bytes, never by its name or declared type, and every file is stored under
 * its organization, named by its SHA-256, so a path never changes content.
 */

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const pathOf = (extensions: string) => new RegExp(`^${uuid}/[0-9a-f]{64}\\.(?:${extensions})$`);
const anyMediaPath = pathOf('jpg|png|webp|mp4|webm');
const imageMediaPath = pathOf('jpg|png|webp');
const videoMediaPath = pathOf('mp4|webm');
const MEDIA_PREFIX = 'media:';

/** Upload limit for site images; large photos should be exported for the web first. */
export const MEDIA_MAX_BYTES = 2 * 1024 * 1024;
/** Upload limit for videos: a short clip of the prize, not a full recording (those go to YouTube). */
export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

export type ImageExtension = 'jpg' | 'png' | 'webp';
export type VideoExtension = 'mp4' | 'webm';
export type MediaExtension = ImageExtension | VideoExtension;
export type MediaKind = 'image' | 'video';

/** SVG is not accepted: it can carry scripts and is served from a public bucket. */
export function sniffImage(bytes: Uint8Array): { contentType: string; extension: ImageExtension } | null {
	const starts = (signature: number[], offset = 0) => signature.every((byte, index) => bytes[offset + index] === byte);
	if (starts([0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', extension: 'jpg' };
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: 'image/png', extension: 'png' };
	if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return { contentType: 'image/webp', extension: 'webp' };
	return null;
}

/**
 * MP4 major brands browsers play. HEIC and AVIF images and QuickTime movies use
 * the same `ftyp` box with other brands, so they are not taken as video.
 */
const mp4Brands = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'mmp4']);

function ascii(bytes: Uint8Array, start: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** The DocType of an EBML header ("webm" or "matroska"), read from its first bytes. */
function ebmlDocType(bytes: Uint8Array): string | null {
	const head = bytes.subarray(0, 64);
	for (let index = 4; index < head.length - 2; index++) {
		if (head[index] !== 0x42 || head[index + 1] !== 0x82) continue;
		const size = head[index + 2]!;
		// One-byte sizes only: a DocType is a short string.
		if ((size & 0x80) === 0) return null;
		return ascii(head, index + 3, size & 0x7f);
	}
	return null;
}

export function sniffVideo(bytes: Uint8Array): { contentType: string; extension: VideoExtension } | null {
	if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
		const boxSize = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
		if (boxSize >= 16 && mp4Brands.has(ascii(bytes, 8, 4))) return { contentType: 'video/mp4', extension: 'mp4' };
		return null;
	}
	if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 && ebmlDocType(bytes) === 'webm') {
		return { contentType: 'video/webm', extension: 'webm' };
	}
	return null;
}

export type MediaUploadCheck =
	| { ok: true; kind: MediaKind; contentType: string; extension: MediaExtension }
	| { ok: false; reason: 'unsupported' }
	| { ok: false; reason: 'too_large'; kind: MediaKind; maxBytes: number };

/** What an upload is and whether it fits its kind's limit: images 2 MB, videos 50 MB. */
export function checkMediaUpload(bytes: Uint8Array, sizeBytes = bytes.length): MediaUploadCheck {
	const image = sniffImage(bytes);
	const video = image ? null : sniffVideo(bytes);
	const found = image ? { kind: 'image' as const, ...image, maxBytes: MEDIA_MAX_BYTES } : video ? { kind: 'video' as const, ...video, maxBytes: VIDEO_MAX_BYTES } : null;
	if (!found) return { ok: false, reason: 'unsupported' };
	if (sizeBytes > found.maxBytes) return { ok: false, reason: 'too_large', kind: found.kind, maxBytes: found.maxBytes };
	return { ok: true, kind: found.kind, contentType: found.contentType, extension: found.extension };
}

export function mediaStoragePath(organizationId: string, sha256: string, extension: MediaExtension): string {
	const path = `${organizationId}/${sha256}.${extension}`;
	if (!anyMediaPath.test(path)) throw new Error('Invalid media path');
	return path;
}

export function mediaKindOf(storagePath: string): MediaKind {
	return videoMediaPath.test(storagePath) ? 'video' : 'image';
}

export function mediaRef(storagePath: string): string {
	return `${MEDIA_PREFIX}${storagePath}`;
}

function refTo(path: RegExp) {
	return (value: string) => value.startsWith(MEDIA_PREFIX) && path.test(value.slice(MEDIA_PREFIX.length));
}
const isMediaRef = refTo(anyMediaPath);
const isVideoMediaRef = refTo(videoMediaPath);

/** An uploaded image (`media:<path>` of a JPEG, PNG or WebP). */
export const imageMediaRefSchema = z.string().refine(refTo(imageMediaPath), 'Imagen inválida');

/** Storage paths referenced anywhere in some content, so the API can check they belong to the organization. */
export function collectMediaRefs(content: unknown): string[] {
	const found = new Set<string>();
	const walk = (value: unknown) => {
		if (typeof value === 'string' && isMediaRef(value)) found.add(value.slice(MEDIA_PREFIX.length));
		else if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === 'object') Object.values(value).forEach(walk);
	};
	walk(content);
	return [...found];
}

/** Replaces media references with their public URLs. */
export function resolveMediaRefs<T>(content: T, toUrl: (storagePath: string) => string): T {
	const walk = (value: unknown): unknown => {
		if (typeof value === 'string') return isMediaRef(value) ? toUrl(value.slice(MEDIA_PREFIX.length)) : value;
		if (Array.isArray(value)) return value.map(walk);
		if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
		return value;
	};
	return walk(content) as T;
}

/** The video id of a YouTube link over https, or null for anything else. */
export function youtubeVideoId(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:') return null;
		const host = parsed.hostname.replace(/^www\./, '');
		let id: string | null = null;
		if (host === 'youtu.be') id = parsed.pathname.slice(1);
		else if (host === 'youtube.com' || host === 'm.youtube.com') {
			id = parsed.searchParams.get('v') ?? parsed.pathname.match(/^\/(?:live|embed|shorts)\/([\w-]+)/)?.[1] ?? null;
		}
		return id && /^[\w-]{6,20}$/.test(id) ? id : null;
	} catch {
		return null;
	}
}

export const youtubeUrlSchema = z.string().trim().refine((value) => youtubeVideoId(value) !== null, 'Usá un enlace de YouTube (https)');

/** A video of what is raffled: one uploaded to the library or a YouTube link. */
export const videoRefSchema = z
	.string()
	.trim()
	.refine((value) => isVideoMediaRef(value) || youtubeVideoId(value) !== null, 'Elegí un video de la biblioteca o pegá un enlace de YouTube (https)');

/** The optional video of a campaign or a prize. */
export const campaignVideoSchema = videoRefSchema.nullable();

export type PublicVideo = { kind: 'upload'; url: string; contentType: string } | { kind: 'youtube'; embedUrl: string };

/** What the public site plays: the bucket URL of an upload or the privacy-enhanced YouTube embed. */
export function resolveVideo(value: string | null, toUrl: (storagePath: string) => string): PublicVideo | null {
	if (!value) return null;
	if (isVideoMediaRef(value)) {
		const path = value.slice(MEDIA_PREFIX.length);
		return { kind: 'upload', url: toUrl(path), contentType: path.endsWith('.webm') ? 'video/webm' : 'video/mp4' };
	}
	const id = youtubeVideoId(value);
	return id ? { kind: 'youtube', embedUrl: `https://www.youtube-nocookie.com/embed/${id}` } : null;
}
