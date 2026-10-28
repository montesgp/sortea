import { fail } from '@sveltejs/kit';
import { HISTORY_LIMIT, historyItem, parseHistory, type CouponLookup, type LookupContext } from '#lib/coupon-lookup.js';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import type { Actions, PageServerLoad } from './$types';

/** The live coupon lookup for the draw stream (S7). */
export const load: PageServerLoad = async (event) => ({
	context: await adminLoad<LookupContext>(event, `/admin/campaigns/${event.params.id}/coupon-lookup/context`),
	presentation: event.url.searchParams.has('presentacion')
});

export const actions: Actions = {
	/** One API call per search. Without JavaScript the session list travels in a hidden field; with it, the page keeps it. */
	buscar: async (event) => {
		const form = await event.request.formData();
		const coupon = String(form.get('cupon') ?? '').slice(0, 40);
		const history = parseHistory(String(form.get('history') ?? ''));
		const result = await adminApi<CouponLookup>(event, `/admin/campaigns/${event.params.id}/coupon-lookup?coupon=${encodeURIComponent(coupon)}`);
		if (!result.ok) return fail(result.status, { message: result.message, coupon, history });
		return { result: result.data, history: [...history, historyItem(result.data)].slice(-HISTORY_LIMIT) };
	}
};
