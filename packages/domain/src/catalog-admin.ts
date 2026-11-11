import { z } from 'zod';
import { campaignScheduleIssues, type CampaignStatus } from './campaign';
import { campaignVideoSchema, imageMediaRefSchema } from './media';
import { prizeMechanisms } from './quiniela';

/**
 * Catalog and prize administration (FR-COM-01, FR-CAMP-03, FR-OPS-04).
 *
 * Nothing that an order, an entry or an award may point to is ever deleted:
 * products with orders are archived and variants deactivated; only a product
 * nobody ordered and no campaign names is deleted (`productRemoval`). Orders
 * keep their own price snapshot, so editing a price only affects future checkouts.
 */

export const productSlugSchema = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Usá minúsculas, números y guiones')
	.min(2)
	.max(60);

const httpsUrl = z.url({ protocol: /^https$/, message: 'Usá una dirección https' });

/** An image path on the same site (`/tenants/...`, never `//host`) or an https URL. */
export const imageUrlSchema = z.union([z.string().trim().regex(/^\/(?!\/)[A-Za-z0-9/_.-]{1,200}$/, 'Ruta de imagen inválida'), httpsUrl]);

/** An uploaded image (`media:<path>`), an image on the same site or an https URL. Never a video. */
export const imageRefSchema = z.union([imageMediaRefSchema, imageUrlSchema]);

export const productInputSchema = z.object({
	slug: productSlugSchema,
	name: z.string().trim().min(2).max(120),
	description: z.string().trim().min(10).max(4000),
	kind: z.enum(['digital', 'physical']),
	imageUrl: imageUrlSchema.nullable().optional(),
	position: z.number().int().min(0).max(10_000).optional()
});

export const variantInputSchema = z
	.object({
		sku: z.string().trim().regex(/^[A-Za-z0-9._-]{1,40}$/, 'Usá letras, números, punto, guion o guion bajo'),
		name: z.string().trim().min(2).max(120),
		priceMinor: z.number().int().min(1).max(100_000_000_00),
		stock: z.number().int().min(0).max(1_000_000).nullable(),
		maxPerOrder: z.number().int().min(1).max(100),
		availableFrom: z.coerce.date().nullable().optional(),
		availableUntil: z.coerce.date().nullable().optional(),
		active: z.boolean().optional()
	})
	.refine((value) => !value.availableFrom || !value.availableUntil || value.availableFrom < value.availableUntil, {
		message: 'El fin de la vigencia tiene que ser posterior al inicio',
		path: ['availableUntil']
	});

export const prizeKinds = ['vehicle', 'cash', 'product', 'digital'] as const;

export const prizeInputSchema = z.object({
	kind: z.enum(prizeKinds),
	title: z.string().trim().min(3).max(160),
	description: z.string().trim().max(2000).nullable().optional(),
	declaredValueMinor: z.number().int().min(0).max(100_000_000_000_00),
	quantity: z.number().int().min(1).max(1000),
	alternatesCount: z.number().int().min(0).max(10),
	/** Decided by the Quiniela extracts or recorded by hand; new prizes are manual unless told otherwise (ADR 0014 §2). */
	mechanism: z.enum(prizeMechanisms).optional(),
	conditions: z.string().trim().max(4000).nullable().optional(),
	/** A library image (picked or uploaded in the panel), a same-site path or an https URL (S2, 2026-10-22). */
	imageUrl: imageRefSchema.nullable().optional(),
	/** An uploaded video or a YouTube link showing the prize (S9). */
	video: campaignVideoSchema.optional(),
	position: z.number().int().min(1).max(1000).optional()
});

/** Whether the runtime knows this IANA time zone. */
export function isTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/** A date field of a draft: empty means not decided yet. */
const draftInstant = z.preprocess((value) => (value === '' || value === undefined ? null : value), z.coerce.date({ message: 'Ingresá una fecha válida' }).nullable());

/**
 * A campaign created from the admin (S5, owner feedback 2026-11-10). It starts
 * as a draft, never open or demo; its dates may wait, and those given go in
 * order. The time zone defaults to the organization's. Chances are per product
 * (0 = does not participate) and apply to all its variants, like the chances table.
 */
const CHANCES_PER_UNIT = 'Las chances por unidad son un número entero de 0 a 100';

export const campaignCreateSchema = z
	.object({
		title: z.string().trim().min(3, 'Escribí un título de al menos 3 caracteres').max(120, 'El título admite hasta 120 caracteres'),
		slug: productSlugSchema,
		subtitle: z
			.string()
			.trim()
			.max(120, 'El subtítulo admite hasta 120 caracteres')
			.nullish()
			.transform((value) => value || null),
		summary: z.string().trim().min(10, 'Escribí un resumen de al menos 10 caracteres').max(1200, 'El resumen admite hasta 1200 caracteres'),
		timezone: z.string().trim().refine(isTimeZone, 'Elegí una zona horaria válida').optional(),
		opensAt: draftInstant,
		closesAt: draftInstant,
		drawAt: draftInstant,
		seo: z
			.object({
				title: z.string().trim().max(70, 'El título para buscadores admite hasta 70 caracteres').optional(),
				description: z.string().trim().max(200, 'La descripción para buscadores admite hasta 200 caracteres').optional()
			})
			.transform((seo) => Object.fromEntries(Object.entries(seo).filter(([, value]) => value)) as { title?: string; description?: string })
			.default({}),
		eligibility: z
			.object({
				minAge: z.number().int('La edad mínima es un número entero').min(16, 'La edad mínima va de 16 a 99').max(99, 'La edad mínima va de 16 a 99').default(18),
				residency: z.string().trim().min(2, 'Indicá dónde tienen que residir').max(120).default('República Argentina')
			})
			.default({ minAge: 18, residency: 'República Argentina' }),
		chancesPerProduct: z
			.record(z.uuid(), z.number({ error: CHANCES_PER_UNIT }).int(CHANCES_PER_UNIT).min(0, CHANCES_PER_UNIT).max(100, CHANCES_PER_UNIT), {
				error: (issue) => (issue.code === 'invalid_key' ? 'Elegí productos de tu catálogo' : undefined)
			})
			.default({}),
		rulesMarkdown: z.string().trim().min(20, 'Las bases necesitan al menos 20 caracteres').max(50_000, 'Las bases admiten hasta 50.000 caracteres')
	})
	.superRefine((value, context) => {
		for (const issue of campaignScheduleIssues(value)) context.addIssue({ code: 'custom', path: [issue.field], message: issue.message });
	});

export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;

export type ProductStatus = 'draft' | 'active' | 'archived';

export type ProductStatusCheck = { ok: true } | { ok: false; reason: 'needs_active_variant' | 'invalid_transition' };

/** A product goes on sale only with something to buy; archived products can come back as drafts. */
export function canSetProductStatus(from: ProductStatus, to: ProductStatus, activeVariants: number): ProductStatusCheck {
	if (from === to) return { ok: true };
	if (from === 'archived' && to === 'active') return { ok: false, reason: 'invalid_transition' };
	if (to === 'active' && activeVariants < 1) return { ok: false, reason: 'needs_active_variant' };
	return { ok: true };
}

/** Campaigns that may still sell: their products and chances can change until they open, and they sell while open. */
const sellingCampaignStatuses: readonly CampaignStatus[] = ['draft', 'review', 'published', 'open'];

export interface ProductCampaignUse {
	id: string;
	title: string;
	status: CampaignStatus;
}

export type ProductRemoval =
	| { outcome: 'delete' }
	| { outcome: 'archive'; reason: 'ordered' | 'campaign_history' }
	| { outcome: 'refuse'; reason: 'in_campaign'; campaigns: ProductCampaignUse[] };

/**
 * What removing a product from the list does (S10, owner feedback 2026-11-10).
 * `campaigns` are those that show the product or give chances for its variants
 * in any version of their rules. A campaign that may still sell it keeps it
 * (remove it from the campaign first); orders, or the rules of a campaign that
 * already ended, keep pointing to it, so it is archived; otherwise it is deleted.
 */
export function productRemoval(input: { ordered: boolean; campaigns: readonly ProductCampaignUse[] }): ProductRemoval {
	const selling = input.campaigns.filter((campaign) => sellingCampaignStatuses.includes(campaign.status));
	if (selling.length > 0) return { outcome: 'refuse', reason: 'in_campaign', campaigns: selling };
	if (input.ordered) return { outcome: 'archive', reason: 'ordered' };
	if (input.campaigns.length > 0) return { outcome: 'archive', reason: 'campaign_history' };
	return { outcome: 'delete' };
}

/** The kind decides delivery and download grants; it cannot change once someone bought the product. */
export function canChangeProductKind(ordered: boolean): boolean {
	return !ordered;
}

/**
 * Prizes are part of what the published rules promise. They can be edited
 * freely until the campaign opens; after that, any change is a material change
 * that the platform does not allow (FR-CAMP-06, AC-08).
 */
export function prizesEditable(status: CampaignStatus): boolean {
	return status === 'draft' || status === 'review' || status === 'published';
}

/** Fields that only show the prize: its video (S9) and its image (S2, 2026-10-22). */
const presentationFields: readonly string[] = ['video', 'imageUrl'];

/**
 * The video and the image only show the prize; they are not part of what the
 * rules promise, so they can change after the campaign opens, until it is archived.
 */
export function prizeChangeAllowed(status: CampaignStatus, fields: readonly string[]): boolean {
	if (prizesEditable(status)) return true;
	return status !== 'archived' && fields.length > 0 && fields.every((field) => presentationFields.includes(field));
}

/** A published campaign must keep at least one prize: it is already announced with them. */
export function canRemovePrize(status: CampaignStatus, remaining: number): boolean {
	return prizesEditable(status) && (status !== 'published' || remaining > 1);
}
