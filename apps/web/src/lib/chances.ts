/**
 * Chances a purchase earns in the campaign accepting participations (S5).
 * The numbers always come from the API's locked rules; these helpers only
 * word them. Each chance becomes a numbered coupon once the payment is confirmed.
 */
export interface PublicChances {
	campaign: { slug: string; title: string };
	perUnit: Record<string, number>;
	maxPerIdentity: number | null;
}

export function chancesText(count: number): string {
	return count === 1 ? '1 chance' : `${count} chances`;
}

/** What one unit of a product adds: the most any of its variants grants, and whether they differ. Null when none grants chances. */
export function cardChances(chances: PublicChances | null, variantIds: readonly string[]): { count: number; upTo: boolean; campaign: string } | null {
	if (!chances) return null;
	const counts = variantIds.map((id) => chances.perUnit[id] ?? 0).filter((count) => count > 0);
	if (counts.length === 0) return null;
	const count = Math.max(...counts);
	return { count, upTo: counts.some((other) => other !== count), campaign: chances.campaign.title };
}

export function cardChancesText(grants: { count: number; upTo: boolean; campaign: string }): string {
	return `Suma ${grants.upTo ? 'hasta ' : ''}${chancesText(grants.count)} para ${grants.campaign}`;
}

export interface ChancesExample {
	product: string;
	count: number;
	upTo: boolean;
	campaign: string;
}

/**
 * The example shown in the campaign block (S4): the digital product whose
 * variants grant the most chances, the first in catalog order on a tie. Null
 * unless that campaign accepts participations and some digital product counts.
 */
export function chancesExample(
	chances: PublicChances | null,
	products: readonly { name: string; kind: 'digital' | 'physical'; variants: readonly { id: string }[] }[],
	campaignSlug: string
): ChancesExample | null {
	if (!chances || chances.campaign.slug !== campaignSlug) return null;
	let best: ChancesExample | null = null;
	for (const product of products) {
		if (product.kind !== 'digital') continue;
		const grants = cardChances(chances, product.variants.map((variant) => variant.id));
		if (grants && (!best || grants.count > best.count)) best = { product: product.name, ...grants };
	}
	return best;
}

export function chancesExampleText(example: ChancesExample): string {
	return `Ejemplo: comprando ${example.product} sumás ${example.upTo ? 'hasta ' : ''}${chancesText(example.count)} para ${example.campaign}`;
}
