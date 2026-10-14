import { api } from '#lib/server/api.js';
import type { CampaignSummary } from '#lib/server/types.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const result = await api<{ campaigns: CampaignSummary[]; serverTime: string }>(event, '/public/campaigns');
	const campaigns = result.ok ? result.data.campaigns : [];
	const current = ['published', 'open'];
	return {
		active: campaigns.filter((campaign) => current.includes(campaign.status)),
		past: campaigns.filter((campaign) => !current.includes(campaign.status)),
		unavailable: !result.ok
	};
};
