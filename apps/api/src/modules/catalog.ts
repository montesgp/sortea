import { and, asc, eq, inArray, schema as s, type Executor } from '@sortea/db';
import { lineName, type CatalogEntry, type CurrencyCode } from '@sortea/domain';

/**
 * Reads the variants a cart names. `lockProducts` share-locks their products for the rest of the
 * transaction, so a product deleted meanwhile is simply missing (the cart changed) and one deleted
 * later sees the new order and is archived instead (S10).
 */
export async function loadCatalogEntries(executor: Executor, variantIds: readonly string[], lockProducts = false): Promise<Map<string, CatalogEntry>> {
	if (variantIds.length === 0) return new Map();
	if (lockProducts) {
		const productIds = executor.select({ id: s.productVariants.productId }).from(s.productVariants).where(inArray(s.productVariants.id, [...variantIds]));
		await executor.select({ id: s.products.id }).from(s.products).where(inArray(s.products.id, productIds)).for('share');
	}
	// A new statement: after waiting on a deletion it no longer sees the deleted rows.
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
				name: lineName(product.name, variant.name),
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
	// Cheapest first (owner feedback 2026-11-11b S3); the sort is stable, so equal prices keep the admin's order.
	const cheapest = (product: { variants: { priceMinor: number }[] }) => Math.min(...product.variants.map((variant) => variant.priceMinor));
	return [...products.values()].sort((a, b) => cheapest(a) - cheapest(b));
}
