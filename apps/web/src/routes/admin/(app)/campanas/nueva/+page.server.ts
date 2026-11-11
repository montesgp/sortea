import { error, fail, redirect } from '@sveltejs/kit';
import { newCampaignErrors, newCampaignFromForm } from '#lib/campaign-form.js';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import type { Actions, PageServerLoad } from './$types';

interface ProductList {
	products: { id: string; name: string; status: 'draft' | 'active' | 'archived' }[];
}

/** Zones of the Americas, where the organizations run, plus the organization's own. */
function timeZones(own: string): string[] {
	const zones = Intl.supportedValuesOf('timeZone').filter((zone) => zone.startsWith('America/'));
	return zones.includes(own) ? zones : [own, ...zones];
}

/** "Nueva campaña" (S5, owner feedback 2026-11-10): a draft, possibly without dates, whose prizes, rules and approvals are managed on its page. */
export const load: PageServerLoad = async (event) => {
	const { session } = await event.parent();
	// The API refuses it too; this only avoids showing a form that cannot be sent.
	if (!session.permissions.includes('campaigns.manage')) error(403, 'No tenés permiso para crear campañas');
	const list = await adminLoad<ProductList>(event, '/admin/products');
	return {
		products: list.products.filter((product) => product.status !== 'archived').map(({ id, name, status }) => ({ id, name, status })),
		timeZones: timeZones(session.organization.timezone)
	};
};

export const actions: Actions = {
	default: async (event) => {
		const read = newCampaignFromForm(await event.request.formData());
		if (!read.body) return fail(400, { values: read.values, errors: read.errors, message: 'Revisá los campos marcados' });
		const result = await adminApi<{ id: string }>(event, '/admin/campaigns', { method: 'POST', body: read.body });
		if (!result.ok) {
			const errors = newCampaignErrors(result.details);
			return fail(result.status, { values: read.values, errors, message: Object.keys(errors).length ? 'Revisá los campos marcados' : result.message });
		}
		redirect(303, `/admin/campanas/${result.data.id}`);
	}
};
