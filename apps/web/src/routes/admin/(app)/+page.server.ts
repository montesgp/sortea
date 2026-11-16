import { error, fail, redirect } from '@sveltejs/kit';
import { DRAW_ROOM_PATH } from '#lib/draw-room.js';
import { dateFieldValue, parseDateInput } from '#lib/date-input.js';
import type { CampaignBalance, CampaignExpense, ExpenseInput } from '#lib/finance.js';
import { parseMoneyInput } from '#lib/money-input.js';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import { toLocalInput } from '#lib/tz.js';
import type { Actions, PageServerLoad } from './$types';

export interface OverviewCampaign {
	id: string;
	title: string;
	status: string;
}

export interface Overview {
	generatedAt: string;
	/** Sequence of the last change notice included in this snapshot; the live stream resumes after it. */
	lastEventId: number;
	/** The campaign the figures count, or null for the whole organization (odd/tasks/campaign-finance.md S1). */
	scope: { campaign: OverviewCampaign | null };
	/** The organization's campaigns, for the scope selector. */
	campaigns: OverviewCampaign[];
	kpis: {
		grossApprovedMinor: number;
		paidOrders: number;
		pendingOrders: number;
		refundedMinor: number;
		participants: number;
		entries: number;
		prizesCommittedMinor: number;
		prizesDeliveredMinor: number;
		feesMinor: number;
		/** Approved payments Mercado Pago has not reported a fee for yet (S5). */
		feesPendingPayments: number;
		expensesMinor: number;
		/** sales − refunds − fees − prizes − expenses (ADR 0025). */
		projectedNetMinor: number;
	};
	/** Only with a campaign scope. */
	balance: CampaignBalance | null;
	daily: { day: string; totalMinor: number; orders: number }[];
	recent: { reference: string; status: string; totalMinor: number; buyer: string; updatedAt: string }[];
	alerts: { kind: string; count: number; message: string }[];
}

export interface ExpenseList {
	expenses: CampaignExpense[];
	totalMinor: number;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unknownCampaign = 'No encontramos esa campaña: se muestra el resumen general.';

export const load: PageServerLoad = async (event) => {
	// The draw host has no overview: it lands in the draw room (odd/tasks/draw-room.md T5, S3).
	const { session } = await event.parent();
	if (!session.permissions.includes('dashboard.view') && session.permissions.includes('draws.run')) redirect(303, DRAW_ROOM_PATH);

	// The scope lives in the URL (?campana=<id>), so reload, back and the live refresh keep it (S1).
	const query = event.url.searchParams;
	const requested = query.get('campana')?.trim() ?? '';
	const today = dateFieldValue(toLocalInput(new Date().toISOString(), session.organization.timezone).slice(0, 10));
	const general = async (scopeError: string | null) => ({
		overview: await adminLoad<Overview>(event, '/admin/overview'),
		scope: null,
		scopeError,
		expenses: null,
		editing: null,
		removing: null,
		notice: null,
		today
	});
	if (!requested) return general(null);
	// An old or edited link falls back to the general view instead of an error page.
	if (!uuidPattern.test(requested)) return general(unknownCampaign);

	const [scoped, list] = await Promise.all([
		adminApi<Overview>(event, `/admin/overview?campaign=${requested}`),
		adminApi<ExpenseList>(event, `/admin/campaigns/${requested}/expenses`)
	]);
	if (!scoped.ok && scoped.status === 404) return general(unknownCampaign);
	if (!scoped.ok) error(scoped.status, scoped.message);
	if (!list.ok) error(list.status, list.message);
	return {
		overview: scoped.data,
		scope: requested,
		scopeError: null,
		expenses: list.data,
		// The row edited in the form, or asked to confirm its deletion (S2).
		editing: query.get('editar'),
		removing: query.get('eliminar'),
		// What the last save did: a fixed message per code, so the address never chooses the text.
		notice: savedNotice[query.get('hecho') ?? ''] ?? null,
		today
	};
};

type Event = Parameters<Actions[string]>[0];
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

function refused(status: number, message: string, input?: ExpenseInput) {
	return fail(status, { target: 'expense', ok: false, message, ...(input ? { input } : {}) });
}

/** The message each save leaves after its redirect (`?hecho=`). */
const savedNotice: Record<string, string> = { cargado: 'Gasto cargado', actualizado: 'Gasto actualizado', eliminado: 'Gasto eliminado' };

/**
 * Sends the change; on success the page is read again by GET (303), so a reload never sends the
 * same expense twice.
 */
async function send(event: Event, path: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown, done: 'cargado' | 'actualizado' | 'eliminado', campaign: string, input?: ExpenseInput) {
	const result = await adminApi(event, path, body === undefined ? { method } : { method, body });
	if (!result.ok) {
		const details = result.details as { fieldErrors?: Record<string, string[]> } | undefined;
		const field = details?.fieldErrors && Object.values(details.fieldErrors).flat()[0];
		return refused(result.status, field ?? result.message, input);
	}
	redirect(303, `/admin?campana=${campaign}&hecho=${done}`);
}

/** The selected campaign, from the action URL (`?campana=<id>&/addExpense`). */
function campaignOf(event: Event): string | null {
	const id = event.url.searchParams.get('campana') ?? '';
	return uuidPattern.test(id) ? id : null;
}

/** Reads the typed expense: pesos in es-AR as minor units, the day as YYYY-MM-DD (S2). */
function readExpense(input: ExpenseInput) {
	const amount = parseMoneyInput(input.amount);
	if (!amount.ok) return amount;
	const day = parseDateInput(input.spentOn);
	if (!day.ok) return { ok: false as const, message: `Fecha: ${day.message}` };
	if (!day.value) return { ok: false as const, message: 'Indicá la fecha del gasto' };
	return { ok: true as const, body: { category: input.category, detail: input.detail, amountMinor: amount.value, spentOn: day.value } };
}

async function saveExpense(event: Event, editing: boolean) {
	const form = await event.request.formData();
	const input: ExpenseInput = { id: text(form, 'id'), category: text(form, 'category'), detail: text(form, 'detail'), amount: text(form, 'amount'), spentOn: text(form, 'spentOn') };
	const campaign = campaignOf(event);
	if (!campaign) return refused(400, 'Elegí una campaña para cargar el gasto', input);
	if (editing && !uuidPattern.test(input.id)) return refused(400, 'No encontramos ese gasto', input);
	const expense = readExpense(input);
	if (!expense.ok) return refused(400, expense.message, input);
	return editing
		? send(event, `/admin/campaigns/${campaign}/expenses/${input.id}`, 'PATCH', expense.body, 'actualizado', campaign, input)
		: send(event, `/admin/campaigns/${campaign}/expenses`, 'POST', expense.body, 'cargado', campaign, input);
}

export const actions: Actions = {
	addExpense: (event) => saveExpense(event, false),
	updateExpense: (event) => saveExpense(event, true),
	deleteExpense: async (event) => {
		const id = text(await event.request.formData(), 'id');
		const campaign = campaignOf(event);
		if (!campaign) return refused(400, 'Elegí una campaña');
		if (!uuidPattern.test(id)) return refused(400, 'No encontramos ese gasto');
		return send(event, `/admin/campaigns/${campaign}/expenses/${id}`, 'DELETE', undefined, 'eliminado', campaign);
	}
};
