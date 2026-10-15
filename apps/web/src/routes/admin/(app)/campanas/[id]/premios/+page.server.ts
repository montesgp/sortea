import { fail } from '@sveltejs/kit';
import { parseEntryNumbers } from '#lib/awards.js';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import { fromLocalInput } from '#lib/tz.js';
import type { Actions, PageServerLoad } from './$types';

export interface AwardView {
	id: string;
	role: 'winner' | 'alternate';
	rank: number;
	status: string;
	entryNumber: number | null;
	entryVoidedAfterClose: boolean;
	active: boolean;
	notes: string | null;
	decidedAt: string | null;
	holder: { name: string; email: string; phone: string | null } | null;
	fulfillment: { status: string; scheduledFor: string | null; deliveredAt: string | null; evidenceUrl: string | null; notes: string | null } | null;
}

export interface AwardBoard {
	campaign: { id: string; title: string; status: string; timezone: string };
	mechanismRecorded: boolean;
	resultsPublished: boolean;
	canOperate: boolean;
	piiVisible: boolean;
	prizes: {
		id: string;
		position: number;
		kind: string;
		title: string;
		quantity: number;
		alternatesCount: number;
		slots: { slot: number; state: string; canRecord: boolean; awards: AwardView[] }[];
	}[];
}

export const load: PageServerLoad = async (event) => ({ board: await adminLoad<AwardBoard>(event, `/admin/campaigns/${event.params.id}/awards`) });

type Event = Parameters<Actions[string]>[0];
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

async function send(event: Event, target: string, path: string, method: 'POST' | 'PUT', body: unknown, done: string) {
	const result = await adminApi(event, path, { method, body });
	if (!result.ok) {
		const details = result.details as { fieldErrors?: Record<string, string[]> } | undefined;
		const field = details?.fieldErrors && Object.values(details.fieldErrors).flat()[0];
		return fail(result.status, { target, ok: false, message: field ?? result.message });
	}
	return { target, ok: true, message: done };
}

export const actions: Actions = {
	record: async (event) => {
		const form = await event.request.formData();
		const prizeId = text(form, 'prizeId');
		const slot = text(form, 'slot');
		const target = `slot-${prizeId}-${slot}`;
		const numbers = parseEntryNumbers([text(form, 'winner'), ...form.getAll('alternate').map(String)]);
		if (!numbers || numbers.length === 0) return fail(400, { target, ok: false, message: 'Escribí números de participación válidos' });
		const [winner, ...alternates] = numbers;
		return send(event, target, `/admin/campaigns/${event.params.id}/awards/${prizeId}/slots/${slot}`, 'PUT', { winner, alternates, notes: text(form, 'notes') || undefined }, 'Resultado registrado');
	},

	decide: async (event) => {
		const form = await event.request.formData();
		const awardId = text(form, 'awardId');
		const decision = text(form, 'decision');
		const done = { accepted: 'Aceptación registrada', declined: 'Rechazo registrado: sigue el próximo suplente', void: 'Anulación registrada: sigue el próximo suplente' }[decision] ?? 'Decisión registrada';
		return send(event, `award-${awardId}`, `/admin/awards/${awardId}/decision`, 'POST', { decision, notes: text(form, 'notes') || undefined }, done);
	},

	fulfill: async (event) => {
		const form = await event.request.formData();
		const awardId = text(form, 'awardId');
		const timezone = text(form, 'timezone');
		const scheduledFor = text(form, 'scheduledFor');
		const deliveredAt = text(form, 'deliveredAt');
		return send(
			event,
			`award-${awardId}`,
			`/admin/awards/${awardId}/fulfillment`,
			'PUT',
			{
				status: text(form, 'status'),
				scheduledFor: scheduledFor ? fromLocalInput(scheduledFor, timezone) : undefined,
				deliveredAt: deliveredAt ? (fromLocalInput(deliveredAt, timezone) ?? undefined) : undefined,
				evidenceUrl: text(form, 'evidenceUrl') || undefined,
				notes: text(form, 'notes') || undefined
			},
			'Entrega actualizada'
		);
	}
};
