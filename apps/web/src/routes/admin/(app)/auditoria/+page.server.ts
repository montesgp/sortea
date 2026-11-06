import { adminListLoad } from '#lib/server/admin.js';
import type { PageServerLoad } from './$types';

interface AuditList {
	events: { action: string; actorType: string; targetType: string; targetId: string | null; metadata: Record<string, unknown>; createdAt: string }[];
	page: number;
	pageSize: number;
	total: number;
	actions: string[];
}

export const load: PageServerLoad = async (event) => adminListLoad<AuditList>(event, '/admin/audit', ['action', 'actor', 'target', 'from', 'to', 'page']);
