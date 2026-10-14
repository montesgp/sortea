import { error, fail, redirect } from '@sveltejs/kit';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import type { Actions, PageServerLoad } from './$types';

interface OrganizationList {
	organizations: { id: string; name: string; slug: string; status: string; domains: string[]; members: number; payments: { mode: string; status: string } | null }[];
}

export const load: PageServerLoad = async (event) => {
	const { session } = await event.parent();
	if (session.role !== 'platform_superadmin') error(403, 'Solo el equipo de plataforma accede a esta sección');
	return adminLoad<OrganizationList>(event, '/platform/organizations');
};

export const actions: Actions = {
	create: async (event) => {
		const form = await event.request.formData();
		const body = {
			name: String(form.get('name') ?? '').trim(),
			slug: String(form.get('slug') ?? '').trim(),
			orderPrefix: String(form.get('orderPrefix') ?? '').trim().toUpperCase(),
			hostname: String(form.get('hostname') ?? '').trim()
		};
		const result = await adminApi<{ id: string }>(event, '/platform/organizations', { method: 'POST', body });
		if (!result.ok) return fail(result.status, { values: body, message: result.message });
		redirect(303, `/admin/plataforma/${result.data.id}`);
	}
};
