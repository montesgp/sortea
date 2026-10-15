import { error } from '@sveltejs/kit';
import { api } from '#lib/server/api.js';
import { renderMarkdown } from '#lib/markdown.js';
import type { CampaignDetail, Product } from '#lib/server/types.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const [campaign, catalog] = await Promise.all([
		api<CampaignDetail>(event, `/public/campaigns/${encodeURIComponent(event.params.slug)}`),
		api<{ products: Product[] }>(event, '/public/products')
	]);
	if (!campaign.ok) error(campaign.status === 404 ? 404 : 503, campaign.status === 404 ? 'Campaña no encontrada' : campaign.message);
	const products = catalog.ok ? catalog.data.products : [];
	const qualifying = products.filter((product) => product.variants.some((variant) => campaign.data.qualifyingVariants.includes(variant.id)));
	const { slug, title, chancesPerUnit, maxChancesPerIdentity, acceptingParticipations } = campaign.data;
	return {
		campaign: campaign.data,
		// Locked chances, shown only while a purchase counts for this campaign (FR-CAMP-05).
		chances: acceptingParticipations ? { campaign: { slug, title }, perUnit: chancesPerUnit, maxPerIdentity: maxChancesPerIdentity } : null,
		rulesHtml: campaign.data.rules ? renderMarkdown(campaign.data.rules.body) : null,
		products: qualifying.length ? qualifying : products.slice(0, 3)
	};
};
