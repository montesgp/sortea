import { api } from '#lib/server/api.js';
import { addToCart } from '#lib/server/add-to-cart.js';
import { chancesExample, type PublicChances } from '#lib/chances.js';
import { featuredCampaign } from '#lib/components/campaign/featured.js';
import { renderMarkdown } from '#lib/markdown.js';
import type { CampaignDetail, CampaignSummary, Product } from '#lib/server/types.js';
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
	// The shop shows everything the campaign page shows after its products (owner feedback 2026-11-15c S2).
	const detail = featured ? await api<CampaignDetail>(event, `/public/campaigns/${encodeURIComponent(featured.slug)}`) : null;
	const campaign = detail?.ok ? detail.data : null;
	return {
		products,
		chances,
		unavailable: !result.ok,
		featured,
		campaign,
		rulesHtml: campaign?.rules ? renderMarkdown(campaign.rules.body) : null,
		// Link previews need absolute addresses (2026-11-15c S1).
		origin: event.url.origin,
		serverTime: campaigns.ok ? campaigns.data.serverTime : new Date().toISOString(),
		example: featured ? chancesExample(chances, products, featured.slug) : null
	};
};

export const actions: Actions = {
	add: addToCart
};
