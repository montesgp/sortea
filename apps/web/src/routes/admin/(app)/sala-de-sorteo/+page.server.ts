import type { DrawRoomCampaignSummary } from '#lib/draw-room.js';
import { adminLoad } from '#lib/server/admin.js';
import type { PageServerLoad } from './$types';

/** The campaigns with a draw to run or to show (odd/tasks/draw-room.md T5): open, closed, awarding and fulfilled. */
export const load: PageServerLoad = async (event) => ({
	campaigns: (await adminLoad<{ campaigns: DrawRoomCampaignSummary[] }>(event, '/admin/draw-room/campaigns')).campaigns
});
