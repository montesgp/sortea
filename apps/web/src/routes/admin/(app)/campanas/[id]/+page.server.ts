import { fail } from '@sveltejs/kit';
import { MEDIA_MAX_BYTES } from '@sortea/domain';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import { parseMoneyInput } from '#lib/catalog.js';
import { entriesPerUnitFromProductForm } from '#lib/product-chances.js';
import { fromLocalInput } from '#lib/tz.js';
import { videoFromForm } from '#lib/video-form.js';
import type { Actions, PageServerLoad } from './$types';

export interface CampaignAdmin {
	id: string;
	productIds: string[];
	products: { id: string; name: string; status: string }[];
	slug: string;
	title: string;
	subtitle: string | null;
	summary: string;
	status: string;
	isDemo: boolean;
	timezone: string;
	opensAt: string;
	closesAt: string;
	drawAt: string | null;
	streamUrl: string | null;
	replayUrl: string | null;
	/** `media:` reference of a library video or a YouTube link (S9). */
	video: string | null;
	requiredApprovals: string[];
	/** `demo` when the local compliance demo mode waived the missing approvals (ADR 0013). */
	gate: { allowed: boolean; missing: string[]; rejected: string[]; demo?: true };
	allowedTransitions: string[];
	canClose: boolean;
	/** ADR 0014 §5: the round being played, its vacant quiniela units, and whether a new round can be opened. */
	currentRound: number;
	vacantSlots: { prize: string; slot: number }[];
	canReopen: boolean;
	/** Why a new round waits although a unit is vacant (the round results are not published yet). */
	reopenBlocked: string | null;
	approvals: { kind: 'legal' | 'psp'; status: string; reference: string | null; authority: string | null; notes: string | null; decidedAt: string | null }[];
	rules: {
		id: string;
		version: number;
		status: string;
		bodyMarkdown: string;
		entryRule: { mode: 'per_unit'; entriesPerUnit: Record<string, number>; maxEntriesPerIdentity: number | null };
		contentHash: string | null;
		lockedAt: string | null;
		announcement: string | null;
	}[];
	chanceVariants: { id: string; name: string; active: boolean; productId: string; productName: string; productStatus: string }[];
	prizes: { id: string; position: number; kind: string; title: string; declaredValueMinor: number; quantity: number; alternatesCount: number; mechanism: 'quiniela' | 'manual' }[];
	events: { kind: string; title: string; detail: string | null; evidenceUrl: string | null; occurredAt: string }[];
	/** The latest published manifest, one per round. */
	manifest: { round: number; sha256: string; eligibleCount: number; voidCount: number; publishedAt: string } | null;
	totals: { eligibleEntries: number; participants: number };
}

export interface PrizeAdmin {
	id: string;
	position: number;
	kind: string;
	title: string;
	description: string | null;
	declaredValueMinor: number;
	quantity: number;
	alternatesCount: number;
	/** Decided by the Quiniela extracts or recorded by hand (ADR 0014 §2). */
	mechanism: 'quiniela' | 'manual';
	conditions: string | null;
	/** `media:` reference of a library image, a same-site path or an https URL (S2, 2026-10-22). */
	imageUrl: string | null;
	/** The image as the browser loads it, for the thumbnail. */
	imagePreviewUrl: string | null;
	video: string | null;
}

export interface LibraryVideo {
	ref: string;
	filename: string;
	url: string;
}

export type LibraryImage = LibraryVideo;

export interface PrizeEditor {
	prizes: PrizeAdmin[];
	editable: boolean;
	videoEditable: boolean;
	imageEditable: boolean;
	videos: LibraryVideo[];
	images: LibraryImage[];
}

export const load: PageServerLoad = async (event) => {
	const [campaign, prizeEditor] = await Promise.all([
		adminLoad<CampaignAdmin>(event, `/admin/campaigns/${event.params.id}`),
		adminLoad<PrizeEditor>(event, `/admin/campaigns/${event.params.id}/prizes`)
	]);
	return { campaign, prizeEditor };
};

type Event = Parameters<Actions[string]>[0];

async function send(event: Event, action: string, path: string, method: 'POST' | 'PUT' | 'PATCH', body?: unknown, done = 'Cambios guardados') {
	const result = await adminApi(event, `/admin/campaigns/${event.params.id}${path}`, { method, body });
	if (!result.ok) {
		const details = result.details as { fieldErrors?: Record<string, string[]> } | undefined;
		const field = details?.fieldErrors && Object.values(details.fieldErrors).flat()[0];
		return fail(result.status, { action, ok: false, message: field ?? result.message });
	}
	return { action, ok: true, message: done };
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const optional = (form: FormData, key: string) => text(form, key) || undefined;

/** The prize image: one from the library (`imageMedia`) or a path or https URL (`imageUrl`); absent fields leave it as it is. */
function imageFromForm(form: FormData): { ok: true; imageUrl: string | null | undefined } | { ok: false; message: string } {
	if (!form.has('imageMedia') && !form.has('imageUrl')) return { ok: true, imageUrl: undefined };
	const media = text(form, 'imageMedia');
	const url = text(form, 'imageUrl');
	if (media && url) return { ok: false, message: 'Elegí una imagen de la biblioteca o escribí una dirección, no las dos' };
	return { ok: true, imageUrl: media || url || null };
}

/** Prize fields from a form; amounts are typed in es-AR format. */
function prizeFields(form: FormData): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
	const declaredValueMinor = parseMoneyInput(text(form, 'declaredValue'));
	if (declaredValueMinor === null) return { ok: false, message: 'Escribí el valor declarado, por ejemplo 8.500.000' };
	const video = videoFromForm(form);
	if (!video.ok) return video;
	const image = imageFromForm(form);
	if (!image.ok) return image;
	return {
		ok: true,
		body: {
			kind: text(form, 'kind'),
			title: text(form, 'title'),
			description: text(form, 'description') || null,
			declaredValueMinor,
			quantity: Number(text(form, 'quantity') || '1'),
			alternatesCount: Number(text(form, 'alternatesCount') || '0'),
			mechanism: text(form, 'mechanism') || undefined,
			conditions: text(form, 'conditions') || null,
			...(image.imageUrl !== undefined ? { imageUrl: image.imageUrl } : {}),
			...(video.video !== undefined ? { video: video.video } : {}),
			...(text(form, 'position') ? { position: Number(text(form, 'position')) } : {})
		}
	};
}

async function sendPrize(event: Event, action: string, path: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown, done: string) {
	const result = await adminApi(event, path, { method, body });
	if (!result.ok) {
		const details = result.details as { fieldErrors?: Record<string, string[]> } | undefined;
		const field = details?.fieldErrors && Object.values(details.fieldErrors).flat()[0];
		return fail(result.status, { action, ok: false, message: field ?? result.message });
	}
	return { action, ok: true, message: done };
}

export const actions: Actions = {
	addPrize: async (event) => {
		const form = await event.request.formData();
		const fields = prizeFields(form);
		if (!fields.ok) return fail(400, { action: 'prize-new', ok: false, message: fields.message });
		return sendPrize(event, 'prize-new', `/admin/campaigns/${event.params.id}/prizes`, 'POST', fields.body, 'Premio agregado');
	},
	updatePrize: async (event) => {
		const form = await event.request.formData();
		const prizeId = text(form, 'prizeId');
		const fields = prizeFields(form);
		if (!fields.ok) return fail(400, { action: `prize-${prizeId}`, ok: false, message: fields.message });
		return sendPrize(event, `prize-${prizeId}`, `/admin/prizes/${prizeId}`, 'PATCH', fields.body, 'Premio guardado');
	},
	/** Only the video: it can change after the campaign opens, when the rest of the prize is fixed (S9). */
	prizeVideo: async (event) => {
		const form = await event.request.formData();
		const prizeId = text(form, 'prizeId');
		const video = videoFromForm(form);
		if (!video.ok) return fail(400, { action: `prize-${prizeId}`, ok: false, message: video.message });
		return sendPrize(event, `prize-${prizeId}`, `/admin/prizes/${prizeId}`, 'PATCH', { video: video.video ?? null }, 'Video del premio guardado');
	},
	/**
	 * Only the image, which can change after the campaign opens like the video (S2, 2026-10-22).
	 * A new file goes to the site library first (same upload as Sitio, Imágenes y videos) and the prize points to it.
	 */
	prizeImage: async (event) => {
		const form = await event.request.formData();
		const prizeId = text(form, 'prizeId');
		const action = `prize-${prizeId}`;
		const file = form.get('imageFile');
		let imageUrl: string | null;
		if (file instanceof File && file.size > 0) {
			if (file.size > MEDIA_MAX_BYTES) return fail(400, { action, ok: false, message: 'La imagen supera 2 MB. Exportala más liviana (por ejemplo, JPEG de 1200 px de ancho)' });
			const uploaded = await adminApi<{ ref: string; kind: 'image' | 'video' }>(event, `/admin/cms/media?filename=${encodeURIComponent(file.name.slice(0, 200))}`, {
				method: 'POST',
				raw: { bytes: await file.arrayBuffer(), contentType: 'application/octet-stream' }
			});
			if (!uploaded.ok) return fail(uploaded.status, { action, ok: false, message: uploaded.message });
			if (uploaded.data.kind !== 'image') return fail(400, { action, ok: false, message: 'Ese archivo es un video: quedó en la biblioteca, pero la imagen del premio tiene que ser JPEG, PNG o WebP' });
			imageUrl = uploaded.data.ref;
		} else {
			const image = imageFromForm(form);
			if (!image.ok) return fail(400, { action, ok: false, message: image.message });
			imageUrl = image.imageUrl ?? null;
		}
		return sendPrize(event, action, `/admin/prizes/${prizeId}`, 'PATCH', { imageUrl }, imageUrl ? 'Imagen del premio guardada' : 'El premio quedó sin imagen');
	},
	deletePrize: async (event) => {
		const form = await event.request.formData();
		return sendPrize(event, 'prize-new', `/admin/prizes/${text(form, 'prizeId')}`, 'DELETE', undefined, 'Premio quitado');
	},
	transition: async (event) => {
		const form = await event.request.formData();
		return send(event, 'transition', '/transition', 'POST', { to: text(form, 'to') });
	},
	close: async (event) => send(event, 'close', '/close', 'POST'),
	/** A new round after a vacancy (ADR 0014 §5): dates typed in the campaign time zone. */
	reopen: async (event) => {
		const form = await event.request.formData();
		const timezone = text(form, 'timezone');
		const closesAt = fromLocalInput(text(form, 'closesAt'), timezone);
		if (!closesAt) return fail(400, { action: 'reopen', ok: false, message: 'Indicá el nuevo cierre' });
		const drawAt = text(form, 'drawAt') ? fromLocalInput(text(form, 'drawAt'), timezone) : null;
		return send(event, 'reopen', '/reopen', 'POST', { closesAt, drawAt }, 'Campaña reabierta para una nueva ronda');
	},
	approval: async (event) => {
		const form = await event.request.formData();
		return send(event, `approval-${text(form, 'kind')}`, `/approvals/${text(form, 'kind')}`, 'PUT', {
			status: text(form, 'status'),
			reference: optional(form, 'reference'),
			authority: optional(form, 'authority'),
			notes: optional(form, 'notes')
		});
	},
	/** Products the campaign page shows; none checked shows every active product (2026-10-18b). */
	products: async (event) => {
		const form = await event.request.formData();
		const productIds = form.getAll('productId').map(String);
		return send(event, 'products', '', 'PATCH', { productIds }, productIds.length ? 'Productos de la campaña guardados' : 'La campaña muestra todos los productos');
	},
	details: async (event) => {
		const form = await event.request.formData();
		const timezone = text(form, 'timezone');
		const date = (key: string) => (form.has(key) ? fromLocalInput(text(form, key), timezone) : undefined);
		const video = videoFromForm(form);
		if (!video.ok) return fail(400, { action: 'details', ok: false, message: video.message });
		return send(event, 'details', '', 'PATCH', {
			title: text(form, 'title'),
			subtitle: text(form, 'subtitle') || null,
			summary: text(form, 'summary'),
			streamUrl: text(form, 'streamUrl') || null,
			replayUrl: text(form, 'replayUrl') || null,
			...(form.has('opensAt') ? { opensAt: date('opensAt'), closesAt: date('closesAt') } : {}),
			drawAt: date('drawAt') ?? null,
			...(video.video !== undefined ? { video: video.video } : {})
		});
	},
	rules: async (event) => {
		const form = await event.request.formData();
		return send(event, 'rules', '/rules', 'PUT', { bodyMarkdown: text(form, 'bodyMarkdown'), announcement: optional(form, 'announcement') });
	},
	/** Chances per unit of each product, applied to all its variants in the editable rules (S1); the API validates ids and ranges. */
	chances: async (event) => {
		const form = await event.request.formData();
		const chances = entriesPerUnitFromProductForm(form);
		if (!chances.ok) return fail(400, { action: 'chances', ok: false, message: chances.message });
		const { entriesPerUnit } = chances;
		const max = text(form, 'maxEntriesPerIdentity');
		const maxEntriesPerIdentity = max ? Number(max) : null;
		if (maxEntriesPerIdentity !== null && (!Number.isInteger(maxEntriesPerIdentity) || maxEntriesPerIdentity < 1)) {
			return fail(400, { action: 'chances', ok: false, message: 'El máximo por persona es un número entero mayor a 0, o vacío para no limitar' });
		}
		return send(event, 'chances', '/rules', 'PUT', { entriesPerUnit, maxEntriesPerIdentity }, 'Chances guardadas');
	},
	drawEvent: async (event) => {
		const form = await event.request.formData();
		return send(event, 'drawEvent', '/draw-events', 'POST', {
			kind: text(form, 'kind'),
			title: text(form, 'title'),
			detail: optional(form, 'detail'),
			evidenceUrl: optional(form, 'evidenceUrl'),
			occurredAt: fromLocalInput(text(form, 'occurredAt'), text(form, 'timezone')) ?? new Date().toISOString()
		});
	}
};
