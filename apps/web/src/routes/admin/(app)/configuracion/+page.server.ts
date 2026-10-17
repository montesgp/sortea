import { fail } from '@sveltejs/kit';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import { invalidateSite } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';

interface OrganizationSettings {
	contact: { whatsapp?: string };
}

/** Settings the organization runs itself; the API checks the permission (settings.manage). */
export const load: PageServerLoad = async (event) => ({ settings: await adminLoad<OrganizationSettings>(event, '/admin/settings') });

export const actions: Actions = {
	contact: async (event) => {
		const form = await event.request.formData();
		const whatsapp = String(form.get('whatsapp') ?? '').trim();
		const result = await adminApi(event, '/admin/settings/contact', { method: 'PUT', body: { whatsapp } });
		if (!result.ok) {
			const details = result.details as { fieldErrors?: { whatsapp?: string[] } } | undefined;
			return fail(result.status, { ok: false, message: details?.fieldErrors?.whatsapp?.[0] ?? result.message, whatsapp });
		}
		// The public pages of this hostname show the new button right away.
		invalidateSite(event.url.hostname);
		return { ok: true, message: whatsapp ? 'Contacto guardado' : 'Contacto guardado, sin WhatsApp' };
	}
};
