import { api } from '#lib/server/api.js';
import { addToCart } from '#lib/server/add-to-cart.js';
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

export const actions: Actions = {
	add: addToCart
};
