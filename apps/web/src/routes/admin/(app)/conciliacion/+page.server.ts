import { fail } from '@sveltejs/kit';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import { applyOutcomeLabel, type Facts } from '#lib/reconciliation.js';
import { fromLocalInput } from '#lib/tz.js';
import type { Actions, PageServerLoad } from './$types';

export interface ReconciliationRun {
	id: string;
	kind: 'operations' | 'settlements';
	trigger: 'scheduled' | 'manual' | 'upload';
	status: 'running' | 'completed' | 'failed';
	windowFrom: string;
	windowTo: string;
	startedAt: string;
	finishedAt: string | null;
	summary: { examined?: number; matched?: number; discrepancies?: number; cleared?: number; file?: { name: string; rows: number; inserted: number } };
	error: string | null;
}

interface Overview {
	currency: string;
	finance: {
		grossMinor: number;
		feesMinor: number;
		feesUnknown: number;
		reversedMinor: number;
		netEstimatedMinor: number;
		netUnknown: number;
		payments: number;
		creditedMinor: number;
		settlementMovements: number;
		availableMinor: number | null;
		payoutsMinor: number | null;
	};
	open: { critical: number; warning: number };
	runs: ReconciliationRun[];
	canReconcile: boolean;
}

export interface ReconciliationItem {
	id: string;
	kind: string;
	severity: 'critical' | 'warning';
	status: 'open' | 'resolved';
	providerPaymentId: string | null;
	orderReference: string | null;
	orderId: string | null;
	expected: Facts;
	observed: Facts;
	firstSeenAt: string;
	lastSeenAt: string;
	resolution: string | null;
	resolutionNote: string | null;
	resolvedAt: string | null;
	canApplyProviderState: boolean;
}

interface ItemsPage {
	items: ReconciliationItem[];
	page: number;
	pageSize: number;
	total: number;
}

/** Report uploads go through the web tier's default body limit; reports are split by period instead of raising it. */
const MAX_REPORT_BYTES = 480 * 1024;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export const load: PageServerLoad = async (event) => {
	const { session } = await event.parent();
	const timezone = session.organization.timezone;
	const query = event.url.searchParams;
	const desde = datePattern.test(query.get('desde') ?? '') ? query.get('desde')! : '';
	const hasta = datePattern.test(query.get('hasta') ?? '') ? query.get('hasta')! : '';
	const period = new URLSearchParams();
	if (desde) period.set('from', fromLocalInput(`${desde}T00:00`, timezone)!);
	if (hasta) period.set('to', new Date(new Date(fromLocalInput(`${hasta}T00:00`, timezone)!).getTime() + 86_400_000 - 1).toISOString());

	const estado = query.get('estado') === 'resueltas' ? 'resolved' : 'open';
	const items = new URLSearchParams({ status: estado });
	const tipo = query.get('tipo');
	if (tipo) items.set('kind', tipo);
	const pagina = query.get('pagina');
	if (pagina && /^\d{1,3}$/.test(pagina)) items.set('page', pagina);

	const [overview, list] = await Promise.all([
		adminLoad<Overview>(event, `/admin/reconciliation?${period}`),
		adminLoad<ItemsPage>(event, `/admin/reconciliation/items?${items}`)
	]);
	return { overview, list, filters: { desde, hasta, estado, tipo: tipo ?? '' }, exportQuery: period.toString() };
};

type Event = Parameters<Actions[string]>[0];

function failure(action: string, result: { status: number; message: string }) {
	return fail(result.status, { action, ok: false, message: result.message });
}

const itemId = (form: FormData) => String(form.get('itemId') ?? '');

export const actions: Actions = {
	run: async (event: Event) => {
		const result = await adminApi<{ summary: { examined: number; discrepancies: number; cleared: number } }>(event, '/admin/reconciliation/runs', { method: 'POST', body: {} });
		if (!result.ok) return failure('run', result);
		const { examined, discrepancies, cleared } = result.data.summary;
		return {
			action: 'run',
			ok: true,
			message: `Conciliación completa: ${examined} pagos revisados, ${discrepancies} diferencias${cleared ? `, ${cleared} resueltas solas` : ''}.`
		};
	},

	upload: async (event: Event) => {
		const form = await event.request.formData();
		const file = form.get('report');
		if (!(file instanceof File) || file.size === 0) return fail(400, { action: 'upload', ok: false, message: 'Elegí el archivo del reporte de liquidaciones' });
		if (file.size > MAX_REPORT_BYTES) {
			return fail(400, { action: 'upload', ok: false, message: 'El archivo supera 480 KB. Generá reportes por períodos más cortos (por ejemplo, quincenales)' });
		}
		const result = await adminApi<{ summary: { discrepancies: number; file: { rows: number; inserted: number } } }>(event, '/admin/reconciliation/settlements', {
			method: 'POST',
			body: { filename: file.name.slice(0, 200), content: await file.text() }
		});
		if (!result.ok) return failure('upload', result);
		const { file: stored, discrepancies } = result.data.summary;
		return {
			action: 'upload',
			ok: true,
			message: `Reporte procesado: ${stored.rows} movimientos (${stored.inserted} nuevos), ${discrepancies} diferencias.`
		};
	},

	apply: async (event: Event) => {
		const form = await event.request.formData();
		const result = await adminApi<{ outcome: string; resolved: boolean }>(event, `/admin/reconciliation/items/${itemId(form)}/resolve`, {
			method: 'POST',
			body: { action: 'apply_provider_state' }
		});
		if (!result.ok) return failure('apply', result);
		const outcome = applyOutcomeLabel[result.data.outcome] ?? result.data.outcome;
		return result.data.resolved
			? { action: 'apply', ok: true, message: `Estado de Mercado Pago aplicado: ${outcome}.` }
			: { action: 'apply', ok: false, message: `Se releyó el pago, pero la diferencia sigue (${outcome}). Revisala y, si corresponde, aceptala con una explicación.` };
	},

	accept: async (event: Event) => {
		const form = await event.request.formData();
		const result = await adminApi(event, `/admin/reconciliation/items/${itemId(form)}/resolve`, {
			method: 'POST',
			body: { action: 'accept', note: String(form.get('note') ?? '').trim() }
		});
		if (!result.ok) {
			const details = result.details as { fieldErrors?: { note?: string[] } } | undefined;
			return failure('accept', { status: result.status, message: details?.fieldErrors?.note?.[0] ?? result.message });
		}
		return { action: 'accept', ok: true, message: 'Diferencia aceptada y registrada en la auditoría.' };
	}
};
