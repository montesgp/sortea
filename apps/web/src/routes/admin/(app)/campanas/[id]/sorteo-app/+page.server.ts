import { redirect } from '@sveltejs/kit';
import { DRAW_ROOM_PATH } from '#lib/draw-room.js';
import type { PageServerLoad } from './$types';

/**
 * The one-shot presentation screen of ADR 0024 §5 is replaced by the draw room
 * (odd/tasks/draw-room.md T5): its draw is refused by the API now, and every
 * tirada, stored one-shot draws aside, is run and replayed there.
 */
export const load: PageServerLoad = ({ params }) => redirect(308, `${DRAW_ROOM_PATH}/${params.id}`);
