import { api } from '#lib/server/api.js';
import type { PublicChances } from '#lib/chances.js';
import type { CampaignSummary, Product } from '#lib/server/types.js';
import type { PageServerLoad } from './$types';

const priority = ['open', 'published', 'closed', 'awarding', 'fulfilled'];

export const load: PageServerLoad = async (event) => {
	const [campaigns, products] = await Promise.all([
		api<{ campaigns: CampaignSummary[]; serverTime: string }>(event, '/public/campaigns'),
		api<{ products: Product[]; chances: PublicChances | null }>(event, '/public/products')
	]);
	const list = campaigns.ok ? campaigns.data.campaigns : [];
	const featured = [...list].sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status))[0] ?? null;
	return {
		featured,
		serverTime: campaigns.ok ? campaigns.data.serverTime : new Date().toISOString(),
		products: products.ok ? products.data.products.slice(0, 3) : [],
		chances: products.ok ? products.data.chances : null
	};
};
