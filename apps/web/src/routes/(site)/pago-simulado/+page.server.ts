import { PAYMENTS_FAKE_PROVIDER } from '$app/env/private';
import { error, fail, redirect } from '@sveltejs/kit';
import { api } from '#lib/server/api.js';
import type { Actions, PageServerLoad } from './$types';

interface Preference {
	id: string;
	reference: string;
	items: { title: string; quantity: number; unitPriceMinor: number; currency: string }[];
	totalMinor: number;
	returnUrl: string;
}

/** Local payment simulator (development only). It drives the same signed-webhook path as Mercado Pago. */
export const load: PageServerLoad = async (event) => {
	if (!PAYMENTS_FAKE_PROVIDER) error(404, 'No encontrado');
	const id = event.url.searchParams.get('pref') ?? '';
	const result = await api<Preference>(event, `/dev/simulator/preferences/${encodeURIComponent(id)}`);
	if (!result.ok) error(404, 'Pago simulado no encontrado');
	return { preference: result.data };
};

export const actions: Actions = {
	default: async (event) => {
		if (!PAYMENTS_FAKE_PROVIDER) error(404, 'No encontrado');
		const form = await event.request.formData();
		const result = await api<{ returnUrl: string }>(event, '/dev/simulator/pay', {
			method: 'POST',
			body: { preferenceId: String(form.get('preferenceId')), outcome: String(form.get('outcome')) }
		});
		if (!result.ok) return fail(400, { message: result.message });
		redirect(303, result.data.returnUrl);
	}
};
