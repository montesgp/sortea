import { fail, redirect } from '@sveltejs/kit';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import type { Actions, PageServerLoad } from './$types';

interface ProductList {
	canManage: boolean;
	/** Archived products, listed apart under "Archivados" (S10). */
	archivedCount: number;
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

/** What removing a product would do, shown before it happens (S10). */
export interface RemovalPreview {
	product: { id: string; name: string; status: string };
	outcome: 'delete' | 'archive' | 'refuse';
	reason?: 'ordered' | 'campaign_history' | 'in_campaign';
	campaigns?: { id: string; title: string; status: string }[];
	message: string;
}

export const load: PageServerLoad = async (event) => {
	const archived = event.url.searchParams.get('vista') === 'archivados';
	return { archived, list: await adminLoad<ProductList>(event, archived ? '/admin/products?archived=1' : '/admin/products') };
};

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
	},

	/** First step of "Eliminar": the server says what will happen and the page asks to confirm. */
	confirmRemove: async (event) => {
		const id = text(await event.request.formData(), 'id');
		if (!uuid.test(id)) return fail(400, { ok: false, action: 'remove', message: 'Elegí un producto de la lista' });
		const result = await adminApi<RemovalPreview>(event, `/admin/products/${id}/removal`);
		if (!result.ok) return fail(result.status, { ok: false, action: 'remove', message: result.message });
		return { ok: true, action: 'confirm', confirm: result.data };
	},

	/** Second step: deletes the product, or archives it when it has orders (S10). */
	remove: async (event) => {
		const id = text(await event.request.formData(), 'id');
		if (!uuid.test(id)) return fail(400, { ok: false, action: 'remove', message: 'Elegí un producto de la lista' });
		const result = await adminApi<{ outcome: 'deleted' | 'archived'; message: string }>(event, `/admin/products/${id}`, { method: 'DELETE' });
		if (!result.ok) return fail(result.status, { ok: false, action: 'remove', message: result.message });
		return { ok: true, action: 'remove', outcome: result.data.outcome, message: result.data.message };
	},

	/** Brings an archived product back as a draft: it goes on sale again only when someone activates it. */
	restore: async (event) => {
		const id = text(await event.request.formData(), 'id');
		if (!uuid.test(id)) return fail(400, { ok: false, action: 'remove', message: 'Elegí un producto de la lista' });
		const result = await adminApi<{ name: string }>(event, `/admin/products/${id}/status`, { method: 'POST', body: { status: 'draft' } });
		if (!result.ok) return fail(result.status, { ok: false, action: 'remove', message: result.message });
		return { ok: true, action: 'remove', message: `${result.data.name} volvió como borrador: está en Productos y se vende cuando lo pongas a la venta` };
	}
};
