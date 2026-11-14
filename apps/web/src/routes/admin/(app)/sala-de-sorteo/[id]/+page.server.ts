import { fail } from '@sveltejs/kit';
import type { AppDrawPreview } from '#lib/app-draw.js';
import type { CouponLookup } from '#lib/coupon-lookup.js';
import { BROADCAST_PARAM, EXTRACT_COUNT, typedPrefix, type AppPrizeDrawResult, type DrawRoomTiradaResult, type DrawRoomView, type QuinielaLivePreview } from '#lib/draw-room.js';
import { drawnAtFromInput } from '#lib/quiniela.js';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import type { ApiResult } from '#lib/server/api.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * The draw room (odd/tasks/draw-room.md T5; S3, S4, L1). One screen for the
 * live draw: the campaign, the extracts typed as they come out and matched at
 * once, the winners table, the in-app tiradas and the coupon lookup. Every
 * call goes to the routes the draw host may use (`draws.run`); the API decides
 * the matches, the units that can be drawn and the pick.
 */
export const load: PageServerLoad = async (event) => ({
	room: await adminLoad<DrawRoomView>(event, `/admin/draw-room/campaigns/${event.params.id}`),
	broadcast: event.url.searchParams.has(BROADCAST_PARAM)
});

type Event = Parameters<Actions[string]>[0];
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

/** The API's message, or the first field error it names. */
function refusal<T>(result: Extract<ApiResult<T>, { ok: false }>, extra: Record<string, unknown> = {}) {
	const details = result.details as { fieldErrors?: Record<string, string[]> } | undefined;
	const field = details?.fieldErrors && Object.values(details.fieldErrors).flat()[0];
	return fail(result.status, { message: field ?? result.message, ...extra });
}

/** The 20 positions as posted (a JSON list of what each field holds). */
function postedExtracts(form: FormData): string[] {
	try {
		const parsed: unknown = JSON.parse(text(form, 'extracts') || '[]');
		return Array.isArray(parsed) ? parsed.slice(0, EXTRACT_COUNT).map((value) => String(value)) : [];
	} catch {
		return [];
	}
}

/** The whole draw, as the record needs it: 20 numbers, the source, the official time and the evidence. */
function drawBody(form: FormData) {
	const extracts = typedPrefix(postedExtracts(form));
	if (extracts.length !== EXTRACT_COUNT) return { ok: false as const, message: `Faltan números: cargá los 20 (hay ${extracts.length} seguidos desde el 1.º)` };
	const drawnAt = drawnAtFromInput(text(form, 'drawDate'), text(form, 'drawTime'), text(form, 'timezone'));
	if (!drawnAt.ok) return { ok: false as const, message: drawnAt.message };
	return { ok: true as const, body: { source: text(form, 'source'), drawnAt: drawnAt.value, extracts, evidenceUrl: text(form, 'evidenceUrl') } };
}

async function quinielaPreview(event: Event, body: unknown) {
	return adminApi<QuinielaLivePreview>(event, `/admin/campaigns/${event.params.id}/quiniela/preview`, { method: 'POST', body });
}

export const actions: Actions = {
	/** The matches of the extracts typed so far, written nowhere (draw-room T5): only the numbers, in order. */
	coincidencias: async (event) => {
		const extracts = typedPrefix(postedExtracts(await event.request.formData()));
		if (extracts.length === 0) return { preview: null };
		const result = await quinielaPreview(event, { extracts });
		if (!result.ok) return refusal(result);
		return { preview: result.data };
	},

	/** The confirmation step: the complete preview with the digest the record is checked against (ADR 0014 §4). */
	revisar: async (event) => {
		const draw = drawBody(await event.request.formData());
		if (!draw.ok) return fail(400, { message: draw.message });
		const result = await quinielaPreview(event, draw.body);
		if (!result.ok) return refusal(result);
		return { review: result.data };
	},

	/** Records the 20 numbers once the person confirmed what the review showed. */
	registrar: async (event) => {
		const form = await event.request.formData();
		const draw = drawBody(form);
		if (!draw.ok) return fail(400, { message: draw.message });
		const result = await adminApi(event, `/admin/campaigns/${event.params.id}/quiniela`, { method: 'POST', body: { ...draw.body, digest: text(form, 'digest') } });
		if (!result.ok) return refusal(result);
		return { recorded: true };
	},

	/** Every coupon in play for the next tirada, for the reel and its count; writes nothing. */
	candidatos: async (event) => {
		const result = await adminApi<AppDrawPreview>(event, `/admin/campaigns/${event.params.id}/app-draw/preview`);
		if (!result.ok) return refusal(result);
		return { candidates: result.data };
	},

	/** One tirada for the chosen unit: stored by the API before it answers; the screen only reveals it. */
	sortear: async (event) => {
		const form = await event.request.formData();
		const slot = Number(text(form, 'slot'));
		const result = await adminApi<DrawRoomTiradaResult>(event, `/admin/campaigns/${event.params.id}/app-draw/units`, { method: 'POST', body: { prizeId: text(form, 'prizeId'), slot } });
		if (!result.ok) return refusal(result);
		return { tirada: result.data };
	},

	/**
	 * The one tirada of an `app` prize (draw-room T9, ADR 0026 §4): 201 revealed, 200 revealed by
	 * another request, 202 still waiting for its drand round. Asking again resumes the same round,
	 * never a new tirada. The API waits for the round up to about 18 s before it answers, so the
	 * call waits longer than the default; a lost answer is `transient` and the screen asks again.
	 */
	sortearPremio: async (event) => {
		const prizeId = text(await event.request.formData(), 'prizeId');
		if (!prizeId) return fail(400, { message: 'Elegí el premio que vas a sortear' });
		const result = await adminApi<AppPrizeDrawResult>(event, `/admin/campaigns/${event.params.id}/app-draw/prizes/${encodeURIComponent(prizeId)}`, { method: 'POST', timeoutMs: 30_000 });
		if (!result.ok) return refusal(result, { transient: result.code === 'api_unreachable' });
		return { prizeDraw: result.data, status: result.status };
	},

	/** A stored tirada again, with its candidates, to replay the reel. */
	tirada: async (event) => {
		const sequence = text(await event.request.formData(), 'sequence');
		if (!/^[1-9]\d{0,5}$/.test(sequence)) return fail(400, { message: 'Esa tirada no existe' });
		const result = await adminApi<DrawRoomTiradaResult>(event, `/admin/campaigns/${event.params.id}/app-draw/units/${sequence}`);
		if (!result.ok) return refusal(result);
		return { tirada: result.data, replay: true };
	},

	/** The coupon lookup of the live page (S7): the API decides whether the holder may be named. */
	buscar: async (event) => {
		const coupon = text(await event.request.formData(), 'cupon').slice(0, 40);
		const result = await adminApi<CouponLookup>(event, `/admin/campaigns/${event.params.id}/coupon-lookup?coupon=${encodeURIComponent(coupon)}`);
		if (!result.ok) return refusal(result, { lookup: true });
		return { lookup: result.data };
	}
};
