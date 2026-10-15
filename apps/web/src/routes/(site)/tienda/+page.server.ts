import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { api } from '#lib/server/api.js';
import { readCart, setLine, writeCart } from '#lib/server/cart.js';
import type { PublicChances } from '#lib/chances.js';
import type { Product } from '#lib/server/types.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const result = await api<{ products: Product[]; chances: PublicChances | null }>(event, '/public/products');
	return { products: result.ok ? result.data.products : [], chances: result.ok ? result.data.chances : null, unavailable: !result.ok };
};

const addSchema = z.object({ variantId: z.uuid(), campaign: z.string().regex(/^[a-z0-9-]{1,80}$/).optional() });

export const actions: Actions = {
	add: async ({ request, cookies }) => {
		const form = Object.fromEntries(await request.formData());
		const parsed = addSchema.safeParse({ variantId: form.variantId, campaign: form.campaign || undefined });
		if (!parsed.success) return fail(400, { message: 'No pudimos agregar ese producto' });
		const cart = readCart(cookies);
		const current = cart.lines.find((line) => line.variantId === parsed.data.variantId)?.quantity ?? 0;
		writeCart(cookies, { ...setLine(cart, parsed.data.variantId, current + 1), campaign: parsed.data.campaign ?? cart.campaign });
		redirect(303, '/carrito');
	}
};
