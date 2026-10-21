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

/**
 * What one unit of a product adds: the most any of its variants grants, and
 * whether some option grants less (or none), so the number reads as a maximum.
 * Null when none grants chances.
 */
export function cardChances(chances: PublicChances | null, variantIds: readonly string[]): { count: number; upTo: boolean; campaign: string } | null {
	if (!chances) return null;
	const counts = variantIds.map((id) => chances.perUnit[id] ?? 0);
	const count = Math.max(0, ...counts);
	if (count === 0) return null;
	return { count, upTo: counts.some((other) => other !== count), campaign: chances.campaign.title };
}

/**
 * The cart's warning when it asks for more chances than the campaign has coupons
 * left (ADR 0014 §1); checkout refuses it. Null while it fits.
 */
export function poolWarning(chances: { campaign: { title: string }; total: number; remaining: number }): string | null {
	if (chances.total <= chances.remaining) return null;
	const { title } = chances.campaign;
	if (chances.remaining === 0) return `Se agotaron los cupones de ${title}. Quitá los productos que dan chances para continuar.`;
	const left = chances.remaining === 1 ? 'Queda 1 cupón' : `Quedan ${chances.remaining} cupones`;
	return `${left} para ${title} y tu carrito suma ${chancesText(chances.total)}. Quitá algunos productos para continuar.`;
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
