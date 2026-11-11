import { fail } from '@sveltejs/kit';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import type { Actions, PageServerLoad } from './$types';

/** A tracking link per video (odd/tasks/tracking-links.md S1). */
export interface TrackingLinkView {
	id: string;
	name: string;
	channel: string;
	note: string | null;
	code: string;
	/** Full address to paste in the video: the organization's primary hostname with `?src=<code>`. */
	url: string;
	createdAt: string;
	archivedAt: string | null;
}

export interface TrackingLinks {
	campaign: { id: string; title: string; status: string; closesAt: string | null; timezone: string; takesTouches: boolean };
	links: TrackingLinkView[];
}

export const load: PageServerLoad = async (event) => ({ board: await adminLoad<TrackingLinks>(event, `/admin/campaigns/${event.params.id}/tracking-links`) });

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

export const actions: Actions = {
	create: async (event) => {
		const form = await event.request.formData();
		const values = { name: text(form, 'name'), channel: text(form, 'channel'), note: text(form, 'note') };
		const result = await adminApi<{ link: TrackingLinkView }>(event, `/admin/campaigns/${event.params.id}/tracking-links`, {
			method: 'POST',
			body: { name: values.name, channel: values.channel, note: values.note || undefined }
		});
		if (!result.ok) {
			const details = result.details as { fieldErrors?: Record<string, string[]> } | undefined;
			const message = details?.fieldErrors?.name
				? 'Escribí el nombre del video (2 a 80 caracteres)'
				: details?.fieldErrors?.channel
					? 'Elegí la red donde se publica'
					: details?.fieldErrors?.note
						? 'La nota puede tener hasta 300 caracteres'
						: result.message;
			return fail(result.status, { target: 'create', ok: false, message, values });
		}
		return { target: 'create', ok: true, message: `Link creado: ${result.data.link.url}`, created: result.data.link.id };
	},

	archive: async (event) => {
		const form = await event.request.formData();
		const linkId = text(form, 'linkId');
		const result = await adminApi(event, `/admin/campaigns/${event.params.id}/tracking-links/${encodeURIComponent(linkId)}/archive`, { method: 'POST' });
		if (!result.ok) return fail(result.status, { target: 'archive', ok: false, message: result.message });
		return { target: 'archive', ok: true, message: 'Link archivado: ya no suma visitas nuevas' };
	}
};
