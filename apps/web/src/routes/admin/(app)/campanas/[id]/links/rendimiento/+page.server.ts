import { adminLoad } from '#lib/server/admin.js';
import type { PageServerLoad } from './$types';

/** Paid purchases, distinct buyers, chances, gross and known net; `netUnknown` purchases have no fee reported yet (odd/tasks/tracking-links.md S4). */
export interface PerformanceBlock {
	purchases: number;
	buyers: number;
	chances: number;
	grossMinor: number;
	netMinor: number;
	netUnknown: number;
}

export interface TrackingReport {
	campaign: { id: string; title: string; status: string; timezone: string };
	currency: string;
	links: {
		id: string;
		name: string;
		channel: string;
		code: string;
		archivedAt: string | null;
		/** Set for a link of another campaign that a purchase of this one passed through. */
		otherCampaign: { id: string; title: string } | null;
		participated: PerformanceBlock;
		last: PerformanceBlock;
	}[];
	withoutLink: (PerformanceBlock & { channel: string | null })[];
	channels: (PerformanceBlock & { channel: string | null })[];
	total: PerformanceBlock;
}

export const load: PageServerLoad = async (event) => ({ report: await adminLoad<TrackingReport>(event, `/admin/campaigns/${event.params.id}/tracking-links/report`) });
