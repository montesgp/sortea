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
