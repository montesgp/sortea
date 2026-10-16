import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { api } from '#lib/server/api.js';
import { readCart, setLine, writeCart } from '#lib/server/cart.js';
import { chancesExample, type PublicChances } from '#lib/chances.js';
import { featuredCampaign } from '#lib/components/campaign/featured.js';
import type { CampaignSummary, Product } from '#lib/server/types.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const [result, campaigns] = await Promise.all([
		api<{ products: Product[]; chances: PublicChances | null }>(event, '/public/products'),
		api<{ campaigns: CampaignSummary[]; serverTime: string }>(event, '/public/campaigns')
	]);
	const products = result.ok ? result.data.products : [];
	const chances = result.ok ? result.data.chances : null;
	// Buyers land here directly: the campaign goes first as the hook to the products (S8).
	const featured = featuredCampaign(campaigns.ok ? campaigns.data.campaigns : []);
	return {
		products,
		chances,
		unavailable: !result.ok,
		featured,
		serverTime: campaigns.ok ? campaigns.data.serverTime : new Date().toISOString(),
		example: featured ? chancesExample(chances, products, featured.slug) : null
	};
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
