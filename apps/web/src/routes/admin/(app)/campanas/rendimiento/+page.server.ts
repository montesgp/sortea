import { adminLoad } from '#lib/server/admin.js';
import type { PerformanceBlock } from '../[id]/links/rendimiento/+page.server';
import type { PageServerLoad } from './$types';

/** One row per campaign of the organization, with its paid purchases with and without a link (odd/tasks/tracking-links.md S4). */
export interface CampaignsComparison {
	currency: string;
	campaigns: (PerformanceBlock & { id: string; title: string; status: string; opensAt: string | null; closesAt: string | null; timezone: string; links: number; withLink: number; withoutLink: number })[];
}

export const load: PageServerLoad = async (event) => ({ comparison: await adminLoad<CampaignsComparison>(event, '/admin/tracking-links/campaigns-comparison') });
