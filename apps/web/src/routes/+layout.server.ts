import { error } from '@sveltejs/kit';
import { cartCount, readCart } from '#lib/server/cart.js';
import { PAYMENTS_FAKE_PROVIDER } from '$app/env/private';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, cookies, url }) => {
	if (!locals.site && !url.pathname.startsWith('/admin')) {
		error(404, 'No hay ningún sitio publicado en esta dirección');
	}
	return {
		site: locals.site,
		mode: locals.mode,
		cartCount: cartCount(readCart(cookies)),
		simulator: PAYMENTS_FAKE_PROVIDER
	};
};
