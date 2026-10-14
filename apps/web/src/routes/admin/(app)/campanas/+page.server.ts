import { adminLoad } from '#lib/server/admin.js';
import type { PageServerLoad } from './$types';

interface CampaignList {
	campaigns: { id: string; slug: string; title: string; status: string; isDemo: boolean; opensAt: string; closesAt: string; entries: number }[];
}

export const load: PageServerLoad = async (event) => adminLoad<CampaignList>(event, '/admin/campaigns');
