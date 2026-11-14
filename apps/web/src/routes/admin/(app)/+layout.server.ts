import { error } from '@sveltejs/kit';
import { drawRoomAllows, drawRoomOnly } from '#lib/draw-room.js';
import { adminApi, type AdminSession } from '#lib/server/admin.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async (event) => {
	const result = await adminApi<AdminSession>(event, '/admin/session');
	if (!result.ok) error(result.status, result.message);
	const roomOnly = drawRoomOnly(result.data.permissions);
	// The draw host sees the draw room and its account only (odd/tasks/draw-room.md T5, S4). The API refuses
	// everything else anyway (PRD §4); this gives a clean page instead of a broken one.
	if (roomOnly && !drawRoomAllows(event.url.pathname)) error(403, { message: 'Esta sección no es parte de la sala de sorteo.', code: 'draw_room_only' });
	return { session: result.data, drawRoomOnly: roomOnly };
};
