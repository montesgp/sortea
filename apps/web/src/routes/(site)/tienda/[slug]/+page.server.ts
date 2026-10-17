import { error } from '@sveltejs/kit';
import { api } from '#lib/server/api.js';
import { addToCart } from '#lib/server/add-to-cart.js';
import type { PublicChances } from '#lib/chances.js';
import type { Product } from '#lib/server/types.js';
import type { Actions, PageServerLoad } from './$types';

/** Choosing a variant and quantity on its own page: what the shop's chooser shows without JavaScript (S4). */
export const load: PageServerLoad = async (event) => {
	const result = await api<{ products: Product[]; chances: PublicChances | null }>(event, '/public/products');
	if (!result.ok) error(503, 'La tienda no está disponible en este momento.');
	const product = result.data.products.find((item) => item.slug === event.params.slug);
	if (!product) error(404, 'Ese producto no está a la venta.');
	const campaign = event.url.searchParams.get('campaign');
	return { product, chances: result.data.chances, campaign: campaign && /^[a-z0-9-]{1,80}$/.test(campaign) ? campaign : null };
};

export const actions: Actions = {
	add: addToCart
};
