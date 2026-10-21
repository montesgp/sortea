import { fail } from '@sveltejs/kit';
import { parseEntryNumbers } from '#lib/awards.js';
import { drawnAtFromInput, parseExtracts } from '#lib/quiniela.js';
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
	/** Decisions and delivery are open for it now: the current round while awarding, earlier published rounds too (ADR 0014 §5). */
	operable: boolean;
	notes: string | null;
	decidedAt: string | null;
	holder: { name: string; email: string; phone: string | null; location: string | null } | null;
	fulfillment: { status: string; scheduledFor: string | null; deliveredAt: string | null; evidenceUrl: string | null; notes: string | null } | null;
}

export interface QuinielaDraw {
	round: number;
	source: string;
	/** Official time of the draw, UTC. */
	drawnAt: string;
	extracts: number[];
	evidenceUrl: string;
	recordedAt: string;
}

export interface AwardBoard {
	campaign: { id: string; title: string; status: string; timezone: string; entryDigits: number; round: number };
	mechanismRecorded: boolean;
	resultsPublished: boolean;
	canOperate: boolean;
	piiVisible: boolean;
	/** The current round's recorded Quiniela draw, if any (ADR 0014 §3, §5). */
	quinielaDraw: QuinielaDraw | null;
	prizes: {
		id: string;
		position: number;
		kind: string;
		title: string;
		quantity: number;
		alternatesCount: number;
		mechanism: 'quiniela' | 'manual';
		slots: { slot: number; state: string; canRecord: boolean; awards: AwardView[] }[];
	}[];
}

/** What the API would award with the typed extracts (ADR 0014 §4). */
export interface QuinielaPreview {
	entryDigits: number;
	extracts: { position: number; number: number; outcome: string; prizeId: string | null; slot: number | null; rank: number | null }[];
	slots: { prizeId: string; prizeTitle: string; slot: number; winner: { entryNumber: number; extract: number } | null; alternates: { entryNumber: number; extract: number; rank: number }[] }[];
	vacant: { prizeId: string; prizeTitle: string; slot: number }[];
	/** Sent back on confirmation; the API refuses it if the result changed since. */
	digest: string;
}

/** The draw form as typed; sent back so the confirmation carries exactly what was previewed. */
export interface QuinielaInput {
	source: string;
	/** Date and time as typed, in the campaign time zone. */
	drawDate: string;
	drawTime: string;
	extracts: string;
	evidenceUrl: string;
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

function quinielaInput(form: FormData): QuinielaInput {
	return {
		source: text(form, 'source'),
		drawDate: text(form, 'drawDate'),
		drawTime: text(form, 'drawTime'),
		extracts: text(form, 'extracts'),
		evidenceUrl: text(form, 'evidenceUrl')
	};
}

async function sendDraw(event: Event, path: string, done: string) {
	const form = await event.request.formData();
	const input = quinielaInput(form);
	const parsed = parseExtracts(input.extracts);
	if (!parsed.ok) return fail(400, { target: 'quiniela', ok: false, message: parsed.message, input });
	const drawnAt = drawnAtFromInput(input.drawDate, input.drawTime, text(form, 'timezone'));
	if (!drawnAt) return fail(400, { target: 'quiniela', ok: false, message: 'Indicá la fecha y la hora oficial del sorteo', input });
	const result = await adminApi<QuinielaPreview>(event, `/admin/campaigns/${event.params.id}${path}`, {
		method: 'POST',
		body: { source: input.source, drawnAt, extracts: parsed.extracts, evidenceUrl: input.evidenceUrl, digest: text(form, 'digest') || undefined }
	});
	if (!result.ok) {
		const details = result.details as { fieldErrors?: Record<string, string[]> } | undefined;
		const field = details?.fieldErrors && Object.values(details.fieldErrors).flat()[0];
		return fail(result.status, { target: 'quiniela', ok: false, message: field ?? result.message, input });
	}
	return { target: 'quiniela', ok: true, message: done, input, preview: path.endsWith('/preview') ? result.data : undefined };
}

export const actions: Actions = {
	quinielaPreview: (event) => sendDraw(event, '/quiniela/preview', 'Revisá el resultado antes de confirmarlo: todavía no se guardó nada'),
	quinielaConfirm: (event) => sendDraw(event, '/quiniela', 'Sorteo registrado: ganadores y suplentes cargados'),

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
