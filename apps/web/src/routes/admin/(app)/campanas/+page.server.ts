import { adminLoad } from '#lib/server/admin.js';
import type { PageServerLoad } from './$types';

interface CampaignList {
	/** Dates are null while a draft waits for them (S5, owner feedback 2026-11-10). */
	campaigns: { id: string; slug: string; title: string; status: string; isDemo: boolean; opensAt: string | null; closesAt: string | null; entries: number }[];
}

export const load: PageServerLoad = async (event) => adminLoad<CampaignList>(event, '/admin/campaigns');
