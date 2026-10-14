import { adminLoad } from '#lib/server/admin.js';
import type { PageServerLoad } from './$types';

interface AuditList {
	events: { action: string; actorType: string; targetType: string; targetId: string | null; metadata: Record<string, unknown>; createdAt: string }[];
}

export const load: PageServerLoad = async (event) => adminLoad<AuditList>(event, '/admin/audit');
