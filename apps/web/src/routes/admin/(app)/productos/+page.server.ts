import { fail, redirect } from '@sveltejs/kit';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import type { Actions, PageServerLoad } from './$types';

interface ProductList {
	canManage: boolean;
	products: {
		id: string;
		slug: string;
		name: string;
		kind: 'digital' | 'physical';
		status: 'draft' | 'active' | 'archived';
		position: number;
		variants: number;
		activeVariants: number;
		fromPriceMinor: number | null;
		stock: number | null;
	}[];
}

export const load: PageServerLoad = async (event) => ({ list: await adminLoad<ProductList>(event, '/admin/products') });

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

export const actions: Actions = {
	create: async (event) => {
		const form = await event.request.formData();
		const values = { slug: text(form, 'slug'), name: text(form, 'name'), description: text(form, 'description'), kind: text(form, 'kind') };
		const result = await adminApi<{ id: string }>(event, '/admin/products', { method: 'POST', body: values });
		if (!result.ok) {
			const details = result.details as { fieldErrors?: Record<string, string[]> } | undefined;
			const field = details?.fieldErrors && Object.entries(details.fieldErrors)[0];
			return fail(result.status, { ok: false, values, message: field ? `${field[0]}: ${field[1][0]}` : result.message });
		}
		redirect(303, `/admin/productos/${result.data.id}`);
	}
};
