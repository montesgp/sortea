import { api } from '#lib/server/api.js';
import { shownProducts } from '#lib/shown-products.js';
import { chancesExample, type PublicChances } from '#lib/chances.js';
import { featuredCampaign } from '#lib/components/campaign/featured.js';
import type { CampaignSummary, Product } from '#lib/server/types.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const [campaigns, products] = await Promise.all([
		api<{ campaigns: CampaignSummary[]; serverTime: string }>(event, '/public/campaigns'),
		api<{ products: Product[]; chances: PublicChances | null }>(event, '/public/products')
	]);
	const featured = featuredCampaign(campaigns.ok ? campaigns.data.campaigns : []);
	const catalog = products.ok ? products.data.products : [];
	const chances = products.ok ? products.data.chances : null;
	return {
		featured,
		serverTime: campaigns.ok ? campaigns.data.serverTime : new Date().toISOString(),
		// Picked from the whole catalog, not only the products the home shows.
		example: featured ? chancesExample(chances, catalog, featured.slug) : null,
		// Chosen in the site editor; every active product when none is (2026-10-18b).
		products: shownProducts(catalog, (event.locals.site?.content.home as { productIds?: string[] } | undefined)?.productIds),
		chances
	};
};
