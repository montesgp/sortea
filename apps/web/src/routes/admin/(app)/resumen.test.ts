import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import OverviewPage from './+page.svelte';

// odd/tasks/campaign-finance.md T3: the overview of the organization or of one campaign (S1),
// the campaign's expenses (S2) and its balance, projected while it sells and final after (S3, S5).

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

const organization = { name: 'Taller Demo', slug: 'taller-demo', status: 'active', currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires' };
const sessionWith = (permissions: string[]) => ({ user: { id: 'u1', email: 'owner@tallerdemo.local', assurance: 'mfa' }, role: 'org_owner', permissions, organization });
const editor = sessionWith(['dashboard.view', 'finance.expenses']);
const viewer = sessionWith(['dashboard.view']);

const moto = { id: '11111111-1111-4111-8111-111111111111', title: 'Moto de prueba 0 km', status: 'open' };
const casco = { id: '22222222-2222-4222-8222-222222222222', title: 'Casco de prueba', status: 'fulfilled' };

const kpis = {
	grossApprovedMinor: 9_500_000,
	paidOrders: 19,
	pendingOrders: 2,
	refundedMinor: 500_000,
	participants: 15,
	entries: 40,
	prizesCommittedMinor: 3_000_000,
	prizesDeliveredMinor: 0,
	feesMinor: 400_000,
	feesPendingPayments: 0,
	expensesMinor: 1_450_000,
	projectedNetMinor: 4_650_000
};
const balance = {
	salesMinor: 10_000_000,
	refundsMinor: 500_000,
	feesMinor: 400_000,
	feesPendingPayments: 3,
	prizesCommittedMinor: 3_000_000,
	prizesDeliveredMinor: 1_000_000,
	expensesByCategory: [
		{ category: 'tecnologia', totalMinor: 250_000 },
		{ category: 'repuestos', totalMinor: 1_200_000 }
	],
	expensesMinor: 1_450_000,
	resultMinor: 4_650_000,
	final: false
};
const overview = (campaign: typeof moto | null, extra: Record<string, unknown> = {}) => ({
	generatedAt: '2026-11-15T15:00:00.000Z',
	lastEventId: 7,
	scope: { campaign },
	campaigns: [moto, casco],
	kpis: { ...kpis, ...(extra.kpis as object) },
	balance: campaign ? { ...balance, ...(extra.balance as object) } : null,
	daily: [{ day: '2026-11-15', totalMinor: 0, orders: 0 }],
	recent: [],
	alerts: []
});
const expense = (id: string, category: string, detail: string, amountMinor: number, spentOn: string) => ({
	id,
	category,
	detail,
	amountMinor,
	currency: 'ARS',
	spentOn,
	createdAt: '2026-11-15T15:00:00.000Z',
	updatedAt: '2026-11-15T15:00:00.000Z'
});
const expenses = {
	expenses: [
		expense('e1', 'repuestos', 'Juego de cubiertas', 1_200_000, '2026-11-10'),
		expense('e2', 'tecnologia', 'Hosting de noviembre', 250_000, '2026-11-02')
	],
	totalMinor: 1_450_000
};

const general = (session = editor) => ({ session, overview: overview(null), scope: null, scopeError: null, expenses: null, editing: null, removing: null, today: '15/11/2026' });
const campaignView = (session = editor, extra: Record<string, unknown> = {}) => ({
	session,
	overview: overview(moto, extra),
	scope: moto.id,
	scopeError: null,
	expenses,
	editing: null,
	removing: null,
	today: '15/11/2026',
	...(extra.data as object)
});
const page = (data: unknown, form: unknown = null) => render(OverviewPage as Component, { props: { data, form } as never }).body;

describe('overview scope (S1)', () => {
	it('offers General and every campaign, kept in the URL as ?campana=', () => {
		const body = page(general());
		expect(body).toMatch(/<form[^>]*method="GET"[^>]*action="\/admin"/);
		expect(body).toMatch(/<select id="scope" name="campana"/);
		expect(body).toMatch(/<option value="" selected[^>]*>General<\/option>/);
		expect(body).toMatch(new RegExp(`<option value="${moto.id}"[^>]*>Moto de prueba 0 km</option>`));
		expect(body).toMatch(new RegExp(`<option value="${casco.id}"[^>]*>Casco de prueba</option>`));
		expect(text(body)).toContain('Resumen General: toda la organización');
	});

	it('marks the selected campaign and names it as the active scope', () => {
		const body = page(campaignView());
		expect(body).toMatch(new RegExp(`<option value="${moto.id}" selected[^>]*>Moto de prueba 0 km</option>`));
		expect(body).not.toMatch(/<option value="" selected/);
		expect(text(body)).toContain('Resumen Campaña: Moto de prueba 0 km');
	});

	it('says when the requested campaign does not exist and shows the general view', () => {
		const body = text(page({ ...general(), scopeError: 'No encontramos esa campaña: se muestra el resumen general.' }));
		expect(body).toContain('No encontramos esa campaña: se muestra el resumen general.');
		expect(body).toContain('General: toda la organización');
	});
});

describe('cards (S1, S5)', () => {
	it('adds Mercado Pago fees and expenses, and the net names every deduction', () => {
		const body = text(page(general()));
		expect(body).toContain('Comisiones de Mercado Pago $ 4.000 Informadas por Mercado Pago');
		expect(body).toContain('Gastos $ 14.500 De todas las campañas');
		expect(body).toContain('Neto proyectado $ 46.500 Ventas − reintegros − comisiones − premios − gastos');
		expect(body).toContain('Ventas aprobadas $ 95.000 19 órdenes pagadas');
	});

	it('counts the payments still without a reported fee', () => {
		const one = text(page({ ...general(), overview: overview(null, { kpis: { feesPendingPayments: 1 } }) }));
		expect(one).toContain('Comisiones de Mercado Pago $ 4.000 1 pago sin comisión informada');
		const many = text(page({ ...general(), overview: overview(null, { kpis: { feesPendingPayments: 4 } }) }));
		expect(many).toContain('4 pagos sin comisión informada');
	});

	it('marks a negative net', () => {
		const body = page({ ...general(), overview: overview(null, { kpis: { projectedNetMinor: -120_000 } }) });
		expect(body).toMatch(/class="value[^"]* negative"[^>]*>-\s?\$\s?1\.200</);
	});

	it('shows no expenses nor balance panel in the general view', () => {
		const body = text(page(general()));
		expect(body).not.toContain('Balance de la campaña');
		expect(body).not.toContain('Cargar gasto');
	});
});

describe('expenses (S2)', () => {
	it('lists the campaign expenses with day, category, detail, amount and total', () => {
		const body = text(page(campaignView()));
		expect(body).toContain('10/11/2026 Repuestos Juego de cubiertas $ 12.000');
		expect(body).toContain('02/11/2026 Tecnología y hosting Hosting de noviembre $ 2.500');
		expect(body).toContain('Total $ 14.500');
	});

	it('says when nothing was loaded yet', () => {
		const body = text(page(campaignView(editor, { data: { expenses: { expenses: [], totalMinor: 0 } } })));
		expect(body).toContain('Todavía no hay gastos cargados en esta campaña.');
	});

	it('gives the form, edit and delete to who manages expenses, keeping the campaign in every post', () => {
		const body = page(campaignView());
		expect(body).toMatch(new RegExp(`<form method="POST" action="\\?campana=${moto.id}&amp;/addExpense"`));
		expect(body).toMatch(/<select id="expense-category" name="category" required/);
		expect(body).toContain('>Tecnología y hosting</option>');
		expect(body).toContain('>Combustible y traslados</option>');
		expect(body).toMatch(/id="expense-detail" name="detail"/);
		expect(body).toMatch(/id="expense-amount" name="amount"[^>]*inputmode="decimal"/);
		expect(body).toMatch(/id="expense-day" name="spentOn"[^>]*value="15\/11\/2026"/);
		expect(body).toContain(`href="?campana=${moto.id}&amp;editar=e1"`);
		expect(body).toContain(`href="?campana=${moto.id}&amp;eliminar=e1"`);
		expect(body).toContain('aria-label="Editar Juego de cubiertas"');
		expect(body).toContain('aria-label="Eliminar Juego de cubiertas"');
	});

	it('shows the expenses and the balance, without form nor buttons, to who only views the overview', () => {
		const body = page(campaignView(viewer));
		expect(text(body)).toContain('Juego de cubiertas');
		expect(text(body)).toContain('Balance de la campaña');
		expect(body).not.toContain('addExpense');
		expect(body).not.toContain('editar=');
		expect(body).not.toContain('eliminar=');
		expect(body).not.toContain('name="amount"');
	});

	it('edits an expense in the same form, filled with its values', () => {
		const body = page(campaignView(editor, { data: { editing: 'e1' } }));
		expect(body).toMatch(new RegExp(`<form method="POST" action="\\?campana=${moto.id}&amp;/updateExpense"`));
		expect(body).toMatch(/<input type="hidden" name="id" value="e1"/);
		expect(body).toMatch(/<option value="repuestos" selected/);
		expect(body).toMatch(/name="detail"[^>]*value="Juego de cubiertas"/);
		expect(body).toMatch(/name="amount"[^>]*value="12\.000"/);
		expect(body).toMatch(/name="spentOn"[^>]*value="10\/11\/2026"/);
		expect(text(body)).toContain('Guardar cambios');
		expect(body).toContain(`href="?campana=${moto.id}"`);
	});

	it('asks to confirm a deletion before posting it', () => {
		const body = page(campaignView(editor, { data: { removing: 'e2' } }));
		expect(text(body)).toContain('¿Eliminar el gasto «Hosting de noviembre» de $ 2.500?');
		expect(body).toMatch(new RegExp(`<form method="POST" action="\\?campana=${moto.id}&amp;/deleteExpense"[^>]*>\\s*<input type="hidden" name="id" value="e2"`));
		expect(text(body)).toContain('Eliminar gasto Cancelar');
	});

	it('shows what the form typed and the error when the save fails', () => {
		const form = { target: 'expense', ok: false, message: 'Escribí el monto en pesos, por ejemplo 12.500 o 12500,50', input: { id: '', category: 'combustible', detail: 'Nafta', amount: '12.50', spentOn: '14/11/2026' } };
		const body = page(campaignView(), form);
		expect(body).toMatch(/role="alert"[^>]*>Escribí el monto en pesos, por ejemplo 12\.500 o 12500,50/);
		expect(body).toMatch(/<option value="combustible" selected/);
		expect(body).toMatch(/name="amount"[^>]*value="12\.50"/);
		expect(body).toMatch(/name="spentOn"[^>]*value="14\/11\/2026"/);
	});

	it('confirms a saved expense', () => {
		const body = page(campaignView(), { target: 'expense', ok: true, message: 'Gasto cargado' });
		expect(body).toMatch(/role="status"[^>]*>Gasto cargado/);
	});
});

describe('balance (S3, S5)', () => {
	it('lists sales, refunds, fees, prizes and expenses by category, with the projected result', () => {
		const body = text(page(campaignView()));
		expect(body).toContain('Ventas $ 100.000');
		expect(body).toContain('− Reintegros $ 5.000');
		expect(body).toContain('− Comisiones de Mercado Pago $ 4.000 3 pagos sin comisión informada');
		expect(body).toContain('− Premios $ 30.000 Comprometidos; entregados por $ 10.000');
		expect(body).toContain('Tecnología y hosting $ 2.500 Repuestos $ 12.000');
		expect(body).toContain('− Gastos $ 14.500');
		expect(body).toContain('= Resultado proyectado $ 46.500');
		expect(body).not.toContain('Resultado final');
	});

	it('names the result final once the campaign stopped selling', () => {
		const body = text(page(campaignView(editor, { balance: { final: true } })));
		expect(body).toContain('= Resultado final $ 46.500');
		expect(body).not.toContain('Resultado proyectado');
	});

	it('marks a loss', () => {
		const body = page(campaignView(editor, { balance: { resultMinor: -250_000, final: true } }));
		expect(body).toMatch(/class="result[^"]* negative"/);
		expect(text(body)).toMatch(/= Resultado final -\s?\$\s?2\.500 Pérdida/);
	});
});
