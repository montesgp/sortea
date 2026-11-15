/**
 * Where the transparency page sends the visitor back (owner feedback 2026-11-15 S4):
 * to the shop when "Transparencia y bases" was opened from it, otherwise to the
 * campaign. Only the known value counts, so the query never chooses an address.
 */
export type TransparencyOrigin = 'tienda';

export function transparencyHref(slug: string, from?: TransparencyOrigin): string {
	return `/sorteos/${slug}/transparencia${from ? `?desde=${from}` : ''}`;
}

export function transparencyBack(slug: string, from: string | null): { href: string; label: string } {
	return from === 'tienda' ? { href: '/tienda', label: 'Volver a la tienda' } : { href: `/sorteos/${slug}`, label: 'Volver a la campaña' };
}
