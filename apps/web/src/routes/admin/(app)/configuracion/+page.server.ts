import { fail } from '@sveltejs/kit';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import { invalidateSite } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';

interface OrganizationSettings {
	contact: { whatsapp?: string };
	social: Partial<Record<SocialNetwork, string>>;
}

const NETWORKS = ['instagram', 'tiktok', 'youtube', 'facebook'] as const;
type SocialNetwork = (typeof NETWORKS)[number];

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
	},
	/** Links shown in the home and the footer (S8); an empty field removes that network. */
	social: async (event) => {
		const form = await event.request.formData();
		const links = Object.fromEntries(NETWORKS.map((network) => [network, String(form.get(network) ?? '').trim()]));
		const result = await adminApi(event, '/admin/settings/social', { method: 'PUT', body: links });
		if (!result.ok) {
			const details = result.details as { fieldErrors?: Partial<Record<SocialNetwork, string[]>> } | undefined;
			const errors = Object.fromEntries(NETWORKS.flatMap((network) => (details?.fieldErrors?.[network]?.[0] ? [[network, details.fieldErrors[network]![0]]] : [])));
			return fail(result.status, { social: { ok: false, message: Object.keys(errors).length ? 'Revisá los enlaces marcados' : result.message, links, errors } });
		}
		invalidateSite(event.url.hostname);
		return { social: { ok: true, message: 'Redes guardadas', links, errors: {} } };
	}
};
