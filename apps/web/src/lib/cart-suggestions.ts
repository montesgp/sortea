import { cardChances, type PublicChances } from './chances.js';
import type { Product } from './server/types.js';

export interface CartSuggestion {
	variantId: string;
	name: string;
	kind: Product['kind'];
	pitch: string | null;
	priceMinor: number;
	currency: string;
	/** Set when the product has several options: it is added through its chooser (S3). */
	product: Product | null;
	chances: ReturnType<typeof cardChances>;
}

/**
 * What the cart offers (owner feedback 2026-11-15 S5): every other product that
 * gives chances in the campaign the shop cards show, in catalog order, then the
 * extras the shop configured as offers. Each product once, never one the cart
 * holds in any option, never one without stock. Offered, never added for the
 * buyer (FR-COM-02).
 */
export function cartSuggestions(products: readonly Product[], chances: PublicChances | null, inCart: readonly string[]): CartSuggestion[] {
	const held = new Set(products.filter((product) => product.variants.some((variant) => inCart.includes(variant.id))).map((product) => product.id));
	const byVariant = new Map(products.flatMap((product) => product.variants.map((variant) => [variant.id, product] as const)));
	// The shop writes one pitch per suggested product; it follows the product wherever it is offered.
	const pitches = new Map<string, string>();
	for (const offer of products.flatMap((product) => product.upsells)) {
		const target = byVariant.get(offer.variantId);
		if (target && offer.pitch && !pitches.has(target.id)) pitches.set(target.id, offer.pitch);
	}

	const campaign = products.filter((product) => cardChances(chances, product.variants.map((variant) => variant.id)) !== null);
	const configured = products
		.filter((product) => held.has(product.id))
		.flatMap((product) => product.upsells)
		.map((offer) => byVariant.get(offer.variantId))
		.filter((product) => product !== undefined);

	const seen = new Set<string>();
	const suggestions: CartSuggestion[] = [];
	for (const product of [...campaign, ...configured]) {
		if (held.has(product.id) || seen.has(product.id)) continue;
		seen.add(product.id);
		const available = product.variants.filter((variant) => variant.inStock);
		if (available.length === 0) continue;
		const choices = product.variants.length > 1;
		const first = available[0]!;
		suggestions.push({
			variantId: first.id,
			name: product.name,
			kind: product.kind,
			pitch: pitches.get(product.id) ?? null,
			priceMinor: choices ? Math.min(...product.variants.map((variant) => variant.priceMinor)) : first.priceMinor,
			currency: first.currency,
			product: choices ? product : null,
			// What one unit adds before it is in the cart (feedback 2026-10-21); "up to" across its options.
			chances: cardChances(chances, product.variants.map((variant) => variant.id))
		});
	}
	return suggestions;
}
