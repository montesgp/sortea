import { redirect } from '@sveltejs/kit';
import { DRAW_ROOM_PATH } from '#lib/draw-room.js';
import { adminLoad } from '#lib/server/admin.js';
import type { PageServerLoad } from './$types';

export interface Overview {
	generatedAt: string;
	/** Sequence of the last change notice included in this snapshot; the live stream resumes after it. */
	lastEventId: number;
	kpis: {
		grossApprovedMinor: number;
		paidOrders: number;
		pendingOrders: number;
		refundedMinor: number;
		participants: number;
		entries: number;
		prizesCommittedMinor: number;
		prizesDeliveredMinor: number;
		projectedNetMinor: number;
	};
	daily: { day: string; totalMinor: number; orders: number }[];
	recent: { reference: string; status: string; totalMinor: number; buyer: string; updatedAt: string }[];
	alerts: { kind: string; count: number; message: string }[];
}

export const load: PageServerLoad = async (event) => {
	// The draw host has no overview: it lands in the draw room (odd/tasks/draw-room.md T5, S3).
	const { session } = await event.parent();
	if (!session.permissions.includes('dashboard.view') && session.permissions.includes('draws.run')) redirect(303, DRAW_ROOM_PATH);
	return { overview: await adminLoad<Overview>(event, '/admin/overview') };
};
