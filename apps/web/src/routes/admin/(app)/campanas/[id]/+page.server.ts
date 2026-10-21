import { fail } from '@sveltejs/kit';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import { parseMoneyInput } from '#lib/catalog.js';
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
	prizes: { id: string; position: number; kind: string; title: string; declaredValueMinor: number; quantity: number; alternatesCount: number }[];
	events: { kind: string; title: string; detail: string | null; evidenceUrl: string | null; occurredAt: string }[];
	manifest: { sha256: string; eligibleCount: number; voidCount: number; publishedAt: string } | null;
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
	conditions: string | null;
	imageUrl: string | null;
	video: string | null;
}

export interface LibraryVideo {
	ref: string;
	filename: string;
	url: string;
}

export const load: PageServerLoad = async (event) => {
	const [campaign, prizeEditor] = await Promise.all([
		adminLoad<CampaignAdmin>(event, `/admin/campaigns/${event.params.id}`),
		adminLoad<{ prizes: PrizeAdmin[]; editable: boolean; videoEditable: boolean; videos: LibraryVideo[] }>(event, `/admin/campaigns/${event.params.id}/prizes`)
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

/** Prize fields from a form; amounts are typed in es-AR format. */
function prizeFields(form: FormData): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
	const declaredValueMinor = parseMoneyInput(text(form, 'declaredValue'));
	if (declaredValueMinor === null) return { ok: false, message: 'Escribí el valor declarado, por ejemplo 8.500.000' };
	const video = videoFromForm(form);
	if (!video.ok) return video;
	return {
		ok: true,
		body: {
			kind: text(form, 'kind'),
			title: text(form, 'title'),
			description: text(form, 'description') || null,
			declaredValueMinor,
			quantity: Number(text(form, 'quantity') || '1'),
			alternatesCount: Number(text(form, 'alternatesCount') || '0'),
			conditions: text(form, 'conditions') || null,
			imageUrl: text(form, 'imageUrl') || null,
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
	deletePrize: async (event) => {
		const form = await event.request.formData();
		return sendPrize(event, 'prize-new', `/admin/prizes/${text(form, 'prizeId')}`, 'DELETE', undefined, 'Premio quitado');
	},
	transition: async (event) => {
		const form = await event.request.formData();
		return send(event, 'transition', '/transition', 'POST', { to: text(form, 'to') });
	},
	close: async (event) => send(event, 'close', '/close', 'POST'),
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
	/** Chances per unit of each variant, saved into the editable rules; the API validates ids and ranges. */
	chances: async (event) => {
		const form = await event.request.formData();
		const entriesPerUnit: Record<string, number> = {};
		for (const [key, value] of form.entries()) {
			if (!key.startsWith('chances.')) continue;
			const chances = Number(String(value).trim() || '0');
			if (!Number.isInteger(chances) || chances < 0 || chances > 100) {
				return fail(400, { action: 'chances', ok: false, message: 'Las chances por unidad son un número entero de 0 a 100' });
			}
			entriesPerUnit[key.slice('chances.'.length)] = chances;
		}
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
