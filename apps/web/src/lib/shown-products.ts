/**
 * Products a campaign page or the home shows (feedback 2026-10-18b): the ones
 * chosen in the back office, in catalog order, or the whole catalog when none
 * is chosen or none of the chosen is still for sale.
 */
export function shownProducts<T extends { id: string }>(catalog: readonly T[], chosen: readonly string[] | undefined): T[] {
	const picked = chosen?.length ? catalog.filter((product) => chosen.includes(product.id)) : [];
	return picked.length ? picked : [...catalog];
}
