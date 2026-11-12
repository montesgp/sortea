import { fail } from '@sveltejs/kit';
import { parseMoneyInput } from '#lib/catalog.js';
import { chosenProductFile, productFileUploadPath } from '#lib/product-files.js';
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
	/** The files buyers download, in order, one link each (owner-feedback-2026-11-11b, S2). */
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

/**
 * Sends the chosen file to the API as the raw body, its name in the query (like the site library's
 * uploads). These two actions are the only ones of the page allowed a large body (#lib/body-limit).
 */
async function sendFile(event: Event, replace: boolean) {
	const form = await event.request.formData();
	const fileId = replace ? text(form, 'fileId') : undefined;
	if (replace && !fileId) return fail(400, { target: 'files', ok: false, message: 'Elegí qué archivo reemplazar' });
	const target = fileId ? `file-${fileId}` : 'files';
	const chosen = chosenProductFile(form);
	if (!chosen.ok) return fail(400, { target, ok: false, message: chosen.message });
	const result = await adminApi<ProductAdmin>(event, productFileUploadPath(event.params.id!, chosen.file.name, text(form, 'name'), fileId), {
		method: fileId ? 'PUT' : 'POST',
		raw: { bytes: await chosen.file.arrayBuffer(), contentType: 'application/octet-stream' },
		timeoutMs: 120_000
	});
	if (!result.ok) return fail(result.status, { target, ok: false, message: result.message });
	const saved = fileId ? result.data.assets.find((asset) => asset.id === fileId) : result.data.assets.at(-1);
	return { target, ok: true, message: fileId ? `Archivo reemplazado: ${saved?.filename ?? ''}` : `Archivo agregado: ${saved?.filename ?? ''}` };
}

export const actions: Actions = {
	addFile: (event) => sendFile(event, false),

	replaceFile: (event) => sendFile(event, true),

	removeFile: async (event) => {
		const form = await event.request.formData();
		const fileId = text(form, 'fileId');
		const result = await adminApi<ProductAdmin>(event, `/admin/products/${event.params.id}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
		if (!result.ok) return fail(result.status, { target: 'files', ok: false, message: result.message });
		return { target: 'files', ok: true, message: `Archivo quitado: ${text(form, 'filename')}` };
	},

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
