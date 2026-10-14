import { and, asc, eq, inArray, schema as s, type Executor } from '@sortea/db';
import type { CatalogEntry, CurrencyCode } from '@sortea/domain';

export async function loadCatalogEntries(executor: Executor, variantIds: readonly string[]): Promise<Map<string, CatalogEntry>> {
	if (variantIds.length === 0) return new Map();
	const rows = await executor
		.select({ variant: s.productVariants, product: s.products })
		.from(s.productVariants)
		.innerJoin(s.products, eq(s.products.id, s.productVariants.productId))
		.where(inArray(s.productVariants.id, [...variantIds]));
	return new Map(
		rows.map(({ variant, product }) => [
			variant.id,
			{
				productId: product.id,
				variantId: variant.id,
				name: variant.name,
				kind: product.kind,
				unitPriceMinor: variant.priceMinor,
				currency: variant.currency as CurrencyCode,
				active: variant.active && product.status === 'active',
				stock: variant.stock,
				maxPerOrder: variant.maxPerOrder,
				availableFrom: variant.availableFrom,
				availableUntil: variant.availableUntil
			}
		])
	);
}

/** Public catalog: active products with their variants and upsell offers. */
export async function listPublicCatalog(executor: Executor) {
	const rows = await executor
		.select({ product: s.products, variant: s.productVariants })
		.from(s.products)
		.innerJoin(s.productVariants, eq(s.productVariants.productId, s.products.id))
		.where(and(eq(s.products.status, 'active'), eq(s.productVariants.active, true)))
		.orderBy(asc(s.products.position));
	const offers = await executor
		.select({ offer: s.offers, item: s.offerItems })
		.from(s.offers)
		.innerJoin(s.offerItems, eq(s.offerItems.offerId, s.offers.id))
		.where(eq(s.offers.active, true))
		.orderBy(asc(s.offerItems.position));

	const products = new Map<string, {
		id: string;
		slug: string;
		name: string;
		description: string;
		kind: 'digital' | 'physical';
		imageUrl: string | null;
		variants: { id: string; name: string; priceMinor: number; currency: string; inStock: boolean; maxPerOrder: number }[];
		upsells: { variantId: string; pitch: string | null; title: string }[];
	}>();
	for (const { product, variant } of rows) {
		const entry = products.get(product.id) ?? {
			id: product.id,
			slug: product.slug,
			name: product.name,
			description: product.description,
			kind: product.kind,
			imageUrl: product.imageUrl,
			variants: [],
			upsells: []
		};
		entry.variants.push({
			id: variant.id,
			name: variant.name,
			priceMinor: variant.priceMinor,
			currency: variant.currency,
			inStock: variant.stock === null || variant.stock > 0,
			maxPerOrder: variant.stock === null ? variant.maxPerOrder : Math.min(variant.maxPerOrder, variant.stock)
		});
		products.set(product.id, entry);
	}
	for (const { offer, item } of offers) {
		if (offer.kind !== 'upsell' || !offer.anchorProductId) continue;
		products.get(offer.anchorProductId)?.upsells.push({ variantId: item.variantId, pitch: item.pitch, title: offer.title });
	}
	return [...products.values()];
}
