import { error, fail } from '@sveltejs/kit';
import type { AppDrawPreview, AppDrawResult } from '#lib/app-draw.js';
import { adminApi } from '#lib/server/admin.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * The presentation screen of the in-app draw (ADR 0024 §5; odd/tasks/owner-feedback-2026-11-11b.md
 * S10, L14). A stored draw is always replayed: the load never draws, and the
 * action's POST answers the stored result (200) when the round was drawn.
 */
export type AppDrawView =
	| { state: 'drawn'; result: AppDrawResult }
	| { state: 'ready'; preview: AppDrawPreview }
	| { state: 'unavailable'; message: string };

export const load: PageServerLoad = async (event) => {
	const path = `/admin/campaigns/${event.params.id}/app-draw`;
	const confirming = event.url.searchParams.has('confirmar');
	const stored = await adminApi<AppDrawResult>(event, path);
	if (stored.ok) return { view: { state: 'drawn', result: stored.data } as AppDrawView, confirming };
	if (stored.code !== 'app_draw_missing') error(stored.status, stored.message);
	const preview = await adminApi<AppDrawPreview>(event, `${path}/preview`);
	if (preview.ok) return { view: { state: 'ready', preview: preview.data } as AppDrawView, confirming };
	// Not awarding, nothing vacant, no coupon left, or drawn a moment ago in another tab.
	if (preview.status === 409) return { view: { state: 'unavailable', message: preview.message } as AppDrawView, confirming: false };
	error(preview.status, preview.message);
};

export const actions: Actions = {
	/** Draws once; `created: false` means the round was already drawn and this is the stored result. */
	sortear: async (event) => {
		const result = await adminApi<AppDrawResult>(event, `/admin/campaigns/${event.params.id}/app-draw`, { method: 'POST' });
		if (!result.ok) return fail(result.status, { message: result.message });
		return { result: result.data, created: result.status === 201 };
	}
};
