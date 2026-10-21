import { z } from 'zod';
import type { CampaignStatus } from './campaign';
import { campaignVideoSchema } from './media';
import { prizeMechanisms } from './quiniela';

/**
 * Catalog and prize administration (FR-COM-01, FR-CAMP-03, FR-OPS-04).
 *
 * Nothing that an order, an entry or an award may point to is ever deleted:
 * products are archived and variants deactivated. Orders keep their own price
 * snapshot, so editing a price only affects future checkouts.
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
	imageUrl: imageUrlSchema.nullable().optional(),
	/** An uploaded video or a YouTube link showing the prize (S9). */
	video: campaignVideoSchema.optional(),
	position: z.number().int().min(1).max(1000).optional()
});

export type ProductStatus = 'draft' | 'active' | 'archived';

export type ProductStatusCheck = { ok: true } | { ok: false; reason: 'needs_active_variant' | 'invalid_transition' };

/** A product goes on sale only with something to buy; archived products can come back as drafts. */
export function canSetProductStatus(from: ProductStatus, to: ProductStatus, activeVariants: number): ProductStatusCheck {
	if (from === to) return { ok: true };
	if (from === 'archived' && to === 'active') return { ok: false, reason: 'invalid_transition' };
	if (to === 'active' && activeVariants < 1) return { ok: false, reason: 'needs_active_variant' };
	return { ok: true };
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

/**
 * The video only shows the prize; it is not part of what the rules promise, so
 * it can change after the campaign opens, until it is archived (S9).
 */
export function prizeChangeAllowed(status: CampaignStatus, fields: readonly string[]): boolean {
	if (prizesEditable(status)) return true;
	return status !== 'archived' && fields.length > 0 && fields.every((field) => field === 'video');
}

/** A published campaign must keep at least one prize: it is already announced with them. */
export function canRemovePrize(status: CampaignStatus, remaining: number): boolean {
	return prizesEditable(status) && (status !== 'published' || remaining > 1);
}
