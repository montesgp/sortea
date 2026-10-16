import type { CampaignSummary } from '#lib/server/types.js';

const priority = ['open', 'published', 'closed', 'awarding', 'fulfilled'];

/** The campaign the home and the shop put first: an open one, then one about to open, then the latest results. */
export function featuredCampaign(campaigns: readonly CampaignSummary[]): CampaignSummary | null {
	return [...campaigns].sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status))[0] ?? null;
}
