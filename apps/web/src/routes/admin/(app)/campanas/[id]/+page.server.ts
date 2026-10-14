import { fail } from '@sveltejs/kit';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import { fromLocalInput } from '#lib/tz.js';
import type { Actions, PageServerLoad } from './$types';

export interface CampaignAdmin {
	id: string;
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
	requiredApprovals: string[];
	gate: { allowed: boolean; missing: string[]; rejected: string[] };
	allowedTransitions: string[];
	canClose: boolean;
	approvals: { kind: 'legal' | 'psp'; status: string; reference: string | null; authority: string | null; notes: string | null; decidedAt: string | null }[];
	rules: { id: string; version: number; status: string; bodyMarkdown: string; contentHash: string | null; lockedAt: string | null; announcement: string | null }[];
	prizes: { id: string; position: number; kind: string; title: string; declaredValueMinor: number; quantity: number; alternatesCount: number }[];
	events: { kind: string; title: string; detail: string | null; evidenceUrl: string | null; occurredAt: string }[];
	manifest: { sha256: string; eligibleCount: number; voidCount: number; publishedAt: string } | null;
	totals: { eligibleEntries: number; participants: number };
}

export const load: PageServerLoad = async (event) => ({ campaign: await adminLoad<CampaignAdmin>(event, `/admin/campaigns/${event.params.id}`) });

type Event = Parameters<Actions[string]>[0];

async function send(event: Event, action: string, path: string, method: 'POST' | 'PUT' | 'PATCH', body?: unknown) {
	const result = await adminApi(event, `/admin/campaigns/${event.params.id}${path}`, { method, body });
	if (!result.ok) return fail(result.status, { action, ok: false, message: result.message });
	return { action, ok: true, message: 'Cambios guardados' };
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const optional = (form: FormData, key: string) => text(form, key) || undefined;

export const actions: Actions = {
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
	details: async (event) => {
		const form = await event.request.formData();
		const timezone = text(form, 'timezone');
		const date = (key: string) => (form.has(key) ? fromLocalInput(text(form, key), timezone) : undefined);
		return send(event, 'details', '', 'PATCH', {
			title: text(form, 'title'),
			subtitle: text(form, 'subtitle') || null,
			summary: text(form, 'summary'),
			streamUrl: text(form, 'streamUrl') || null,
			replayUrl: text(form, 'replayUrl') || null,
			...(form.has('opensAt') ? { opensAt: date('opensAt'), closesAt: date('closesAt') } : {}),
			drawAt: date('drawAt') ?? null
		});
	},
	rules: async (event) => {
		const form = await event.request.formData();
		return send(event, 'rules', '/rules', 'PUT', { bodyMarkdown: text(form, 'bodyMarkdown'), announcement: optional(form, 'announcement') });
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
