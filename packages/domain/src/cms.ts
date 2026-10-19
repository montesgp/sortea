import { z } from 'zod';
import { imageUrlSchema } from './catalog-admin';
import { imageMediaRefSchema, youtubeUrlSchema } from './media';

/**
 * Public site content (FR-CMS-04). Each block is edited as a draft and
 * published explicitly; the shapes here are the only content the public site
 * renders, so anything outside them is rejected rather than stored.
 */

/** An uploaded image (`media:<path>`), an image on the same site or an https URL. Never a video. */
export const imageRefSchema = z.union([imageMediaRefSchema, imageUrlSchema]);

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
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
	heroVideoUrl: youtubeUrlSchema.nullable().default(null),
	servicesTitle: optionalText(80),
	services: z.array(item).max(8).default([]),
	processTitle: optionalText(80),
	process: z.array(item).max(8).default([]),
	ctaTitle: optionalText(80),
	ctaBody: optionalText(400),
	/** Products the home shows, in catalog order; empty shows every active product (2026-10-18b). */
	productIds: z
		.array(z.uuid())
		.max(50)
		.default([])
		.transform((ids) => [...new Set(ids)])
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
 * Photos shown on their own page and, when the organization turns them on,
 * teased on the home and linked from the menu. Photos taken by others keep
 * their author, license and source, so the site never presents them as the
 * organization's own work.
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
	showOnHome: z.boolean().default(false),
	showInMenu: z.boolean().default(false),
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
