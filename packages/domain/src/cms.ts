import { z } from 'zod';
import { imageUrlSchema } from './catalog-admin';

/**
 * Public site content (FR-CMS-04). Each block is edited as a draft and
 * published explicitly; the shapes here are the only content the public site
 * renders, so anything outside them is rejected rather than stored.
 */

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const mediaPath = new RegExp(`^${uuid}/[0-9a-f]{64}\\.(?:jpg|png|webp)$`);
const MEDIA_PREFIX = 'media:';

/** Upload limit for site images; large photos should be exported for the web first. */
export const MEDIA_MAX_BYTES = 2 * 1024 * 1024;

export type MediaExtension = 'jpg' | 'png' | 'webp';

/**
 * The type is decided by the file's bytes, never by its name or declared
 * type. SVG is not accepted: it can carry scripts and is served from a public
 * bucket.
 */
export function sniffImage(bytes: Uint8Array): { contentType: string; extension: MediaExtension } | null {
	const starts = (signature: number[], offset = 0) => signature.every((byte, index) => bytes[offset + index] === byte);
	if (starts([0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', extension: 'jpg' };
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: 'image/png', extension: 'png' };
	if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return { contentType: 'image/webp', extension: 'webp' };
	return null;
}

/** Media lives under the organization's own prefix and is named by its SHA-256, so a path never changes content. */
export function mediaStoragePath(organizationId: string, sha256: string, extension: MediaExtension): string {
	const path = `${organizationId}/${sha256}.${extension}`;
	if (!mediaPath.test(path)) throw new Error('Invalid media path');
	return path;
}

export function mediaRef(storagePath: string): string {
	return `${MEDIA_PREFIX}${storagePath}`;
}

const mediaRefSchema = z.string().refine((value) => value.startsWith(MEDIA_PREFIX) && mediaPath.test(value.slice(MEDIA_PREFIX.length)), 'Imagen inválida');

/** An uploaded image (`media:<path>`), an image on the same site or an https URL. */
export const imageRefSchema = z.union([mediaRefSchema, imageUrlSchema]);

function isMediaRef(value: string): boolean {
	return value.startsWith(MEDIA_PREFIX) && mediaPath.test(value.slice(MEDIA_PREFIX.length));
}

/** Storage paths referenced by a block, so the API can check they belong to the organization. */
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

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const youtubeUrl = z.string().trim().refine((value) => youtubeVideoId(value) !== null, 'Usá un enlace de YouTube (https)');
/** Links go to a page of the site or to an https address; `//host` would leave the site. */
const linkSchema = z.union([z.string().trim().regex(/^\/(?!\/)[A-Za-z0-9/_.?=&#-]{0,200}$/, 'Enlace inválido'), z.url({ protocol: /^https$/, message: 'Usá una dirección https' })]);
const item = z.object({ title: text(80), body: text(400) });

const brandSchema = z.object({
	logo: imageRefSchema.nullable().default(null),
	logoAlt: text(120),
	tagline: text(160)
});

const homeSchema = z.object({
	heroStyle: z.enum(['simple', 'garage']).default('simple'),
	processStyle: z.enum(['list', 'pistons']).default('list'),
	heroTitle: text(120),
	heroLead: text(400),
	heroImage: imageRefSchema.nullable().default(null),
	heroImageAlt: optionalText(200),
	heroVideoUrl: youtubeUrl.nullable().default(null),
	servicesTitle: optionalText(80),
	services: z.array(item).max(8).default([]),
	processTitle: optionalText(80),
	process: z.array(item).max(8).default([]),
	ctaTitle: optionalText(80),
	ctaBody: optionalText(400)
});

/** Site-wide defaults for search engines and link previews. */
const seoSchema = z.object({
	title: text(70),
	description: text(200),
	image: imageRefSchema.nullable().default(null)
});

const announcementSchema = z.object({
	enabled: z.boolean(),
	text: text(200),
	linkUrl: linkSchema.nullable().default(null),
	linkLabel: optionalText(40)
});

/**
 * Photos shown on their own page and teased on the home. Photos taken by
 * others keep their author, license and source, so the site never presents
 * them as the organization's own work.
 */
const galleryItemSchema = z.object({
	image: imageRefSchema,
	alt: text(200),
	title: text(80),
	body: optionalText(400),
	credit: z
		.object({ author: text(160), license: text(60), sourceUrl: z.url({ protocol: /^https$/, message: 'Usá una dirección https' }) })
		.nullable()
		.default(null)
});

const gallerySchema = z.object({
	enabled: z.boolean(),
	title: text(80),
	lead: optionalText(400),
	note: optionalText(300),
	items: z.array(galleryItemSchema).min(1).max(12)
});

/** Legal texts are written by the organization; the platform never supplies them. */
const legalSchema = z.object({
	version: z.string().trim().regex(/^[A-Za-z0-9._-]{1,40}$/, 'Usá letras, números, punto o guion (por ejemplo 2026-10)'),
	sections: z.array(z.object({ title: text(120), body: text(8000) })).min(1).max(40)
});

export const cmsBlockSchemas = {
	brand: brandSchema,
	home: homeSchema,
	seo: seoSchema,
	announcement: announcementSchema,
	gallery: gallerySchema,
	'legal.terms': legalSchema,
	'legal.privacy': legalSchema
} as const;

export type CmsBlockKey = keyof typeof cmsBlockSchemas;
export const cmsBlockKeys = Object.keys(cmsBlockSchemas) as CmsBlockKey[];
export type CmsBlockContent<K extends CmsBlockKey> = z.infer<(typeof cmsBlockSchemas)[K]>;

export function isCmsBlockKey(key: string): key is CmsBlockKey {
	return Object.hasOwn(cmsBlockSchemas, key);
}

export type CmsParseResult = { success: true; data: Record<string, unknown> } | { success: false; issues: { path: string; message: string }[] };

export function parseCmsBlock(key: CmsBlockKey, content: unknown): CmsParseResult {
	if (!isCmsBlockKey(key)) return { success: false, issues: [{ path: '', message: 'Bloque desconocido' }] };
	const parsed = cmsBlockSchemas[key].safeParse(content);
	if (parsed.success) return { success: true, data: parsed.data as Record<string, unknown> };
	return { success: false, issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) };
}

/** Which organization setting records the version a buyer accepts at checkout. */
export const legalVersionSetting = { 'legal.terms': 'termsVersion', 'legal.privacy': 'privacyVersion' } as const;
export type LegalBlockKey = keyof typeof legalVersionSetting;

export function isLegalBlockKey(key: CmsBlockKey): key is LegalBlockKey {
	return Object.hasOwn(legalVersionSetting, key);
}

export type LegalVersionCheck = { ok: true } | { ok: false; reason: 'version_unchanged' | 'version_reserved' | 'version_used' };

/**
 * Consents record the version the buyer accepted. Publishing different text
 * under a version that is in force, or that was published before with other
 * text, would silently change what earlier buyers agreed to. Bringing back an
 * earlier version with exactly its own text is allowed.
 */
export function checkLegalVersion(published: string | null, next: string, history: { usedForOtherText: boolean } = { usedForOtherText: false }): LegalVersionCheck {
	if (next === 'pending') return { ok: false, reason: 'version_reserved' };
	if (published === next) return { ok: false, reason: 'version_unchanged' };
	if (history.usedForOtherText) return { ok: false, reason: 'version_used' };
	return { ok: true };
}

export const faqInputSchema = z.object({
	question: z.string().trim().min(5).max(200),
	answer: z.string().trim().min(5).max(2000),
	position: z.number().int().min(0).max(1000).optional()
});
