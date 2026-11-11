/**
 * The tabs of a platform organization page (S2, owner feedback 2026-11-10),
 * one per box, in the format of /admin/sitio. The tab lives in `?tab=`, so it
 * survives a form post (every action keeps it in its URL), a reload and a
 * shared link, without JavaScript.
 */
export const platformTabs = [
	{ id: 'mercadopago', label: 'Mercado Pago' },
	{ id: 'contacto', label: 'Contacto' },
	{ id: 'tema', label: 'Tema' },
	{ id: 'dominios', label: 'Dominios' },
	{ id: 'miembros', label: 'Miembros' },
	{ id: 'estado', label: 'Estado' }
] as const;

export type PlatformTab = (typeof platformTabs)[number]['id'];

export function platformTab(params: Pick<URLSearchParams, 'get'>): PlatformTab {
	return platformTabs.find((tab) => tab.id === params.get('tab'))?.id ?? 'mercadopago';
}
