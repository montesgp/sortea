import { error } from '@sveltejs/kit';
import { adminApi, type AdminSession } from '#lib/server/admin.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async (event) => {
	const result = await adminApi<AdminSession>(event, '/admin/session');
	if (!result.ok) error(result.status, result.message);
	return { session: result.data };
};
