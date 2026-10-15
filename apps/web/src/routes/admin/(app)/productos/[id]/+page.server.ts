import { fail } from '@sveltejs/kit';
import { parseMoneyInput } from '#lib/catalog.js';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import { fromLocalInput } from '#lib/tz.js';
import type { Actions, PageServerLoad } from './$types';

export interface ProductAdmin {
	id: string;
	slug: string;
	name: string;
	description: string;
	kind: 'digital' | 'physical';
	status: 'draft' | 'active' | 'archived';
	imageUrl: string | null;
	position: number;
	kindLocked: boolean;
	variants: {
		id: string;
		sku: string;
		name: string;
		priceMinor: number;
		currency: string;
		stock: number | null;
		maxPerOrder: number;
		availableFrom: string | null;
		availableUntil: string | null;
		active: boolean;
		soldUnits: number;
	}[];
	assets: { id: string; filename: string; contentType: string; sizeBytes: number }[];
	/** Campaigns whose current rules grant chances for this product's variants. */
	chances: { campaignId: string; campaignTitle: string; campaignStatus: string; locked: boolean; perUnit: Record<string, number> }[];
}

export const load: PageServerLoad = async (event) => ({ product: await adminLoad<ProductAdmin>(event, `/admin/products/${event.params.id}`) });

type Event = Parameters<Actions[string]>[0];
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

async function send(event: Event, target: string, path: string, method: 'POST' | 'PATCH', body: unknown, done: string) {
	const result = await adminApi(event, path, { method, body });
	if (!result.ok) {
		const details = result.details as { fieldErrors?: Record<string, string[]> } | undefined;
		const field = details?.fieldErrors && Object.values(details.fieldErrors).flat()[0];
		return fail(result.status, { target, ok: false, message: field ?? result.message });
	}
	return { target, ok: true, message: done };
}

/** Reads the shared variant fields; returns an error message instead of guessing. */
function variantFields(form: FormData, timezone: string): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
	const priceMinor = parseMoneyInput(text(form, 'price'));
	if (priceMinor === null || priceMinor < 1) return { ok: false, message: 'Escribí un precio válido, por ejemplo 12.000 o 12000,50' };
	const stockText = text(form, 'stock');
	if (stockText && !/^\d{1,7}$/.test(stockText)) return { ok: false, message: 'El stock es un número entero, o vacío para no controlarlo' };
	const date = (key: string) => (text(form, key) ? fromLocalInput(text(form, key), timezone) : null);
	return {
		ok: true,
		body: {
			sku: text(form, 'sku'),
			name: text(form, 'name'),
			priceMinor,
			stock: stockText ? Number(stockText) : null,
			maxPerOrder: Number(text(form, 'maxPerOrder') || '5'),
			availableFrom: date('availableFrom'),
			availableUntil: date('availableUntil')
		}
	};
}

export const actions: Actions = {
	update: async (event) => {
		const form = await event.request.formData();
		const body: Record<string, unknown> = {
			name: text(form, 'name'),
			slug: text(form, 'slug'),
			description: text(form, 'description'),
			imageUrl: text(form, 'imageUrl') || null,
			position: Number(text(form, 'position') || '0')
		};
		if (form.has('kind')) body.kind = text(form, 'kind');
		return send(event, 'product', `/admin/products/${event.params.id}`, 'PATCH', body, 'Producto guardado');
	},

	status: async (event) => {
		const form = await event.request.formData();
		const status = text(form, 'status');
		const done = { active: 'El producto está a la venta', draft: 'El producto volvió a borrador', archived: 'Producto archivado: ya no se ofrece' }[status] ?? 'Estado actualizado';
		return send(event, 'status', `/admin/products/${event.params.id}/status`, 'POST', { status }, done);
	},

	addVariant: async (event) => {
		const form = await event.request.formData();
		const fields = variantFields(form, text(form, 'timezone'));
		if (!fields.ok) return fail(400, { target: 'new-variant', ok: false, message: fields.message });
		return send(event, 'new-variant', `/admin/products/${event.params.id}/variants`, 'POST', fields.body, 'Variante agregada');
	},

	updateVariant: async (event) => {
		const form = await event.request.formData();
		const variantId = text(form, 'variantId');
		const fields = variantFields(form, text(form, 'timezone'));
		if (!fields.ok) return fail(400, { target: `variant-${variantId}`, ok: false, message: fields.message });
		return send(event, `variant-${variantId}`, `/admin/variants/${variantId}`, 'PATCH', { ...fields.body, active: form.get('active') === 'on' }, 'Variante guardada');
	}
};
