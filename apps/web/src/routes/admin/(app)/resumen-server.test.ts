import { beforeEach, describe, expect, it, vi } from 'vitest';

// odd/tasks/campaign-finance.md T3 (S1, S2): the scope comes from ?campana= and the expense
// actions send the API pesos typed in es-AR as integer minor units.
const adminApi = vi.fn();
const adminLoad = vi.fn();
vi.mock('#lib/server/admin.js', () => ({ adminApi: (...args: unknown[]) => adminApi(...args), adminLoad: (...args: unknown[]) => adminLoad(...args) }));

const { actions, load } = await import('./+page.server');

const campaignId = '11111111-1111-4111-8111-111111111111';
const expenseId = '33333333-3333-4333-8333-333333333333';
const session = { permissions: ['dashboard.view', 'finance.expenses'], organization: { timezone: 'America/Argentina/Buenos_Aires', currency: 'ARS' } };
const overview = (campaign: unknown) => ({ scope: { campaign }, campaigns: [], kpis: {}, balance: null, daily: [], recent: [], alerts: [], generatedAt: '', lastEventId: 0 });

function loadEvent(query: string) {
	return { url: new URL(`https://demo.localhost/admin${query}`), parent: async () => ({ session }) } as never;
}

function actionEvent(action: string, form: Record<string, string>) {
	const url = `https://demo.localhost/admin?campana=${campaignId}&/${action}`;
	return { url: new URL(url), request: new Request(url, { method: 'POST', body: new URLSearchParams(form) }) } as never;
}

beforeEach(() => {
	adminApi.mockReset();
	adminLoad.mockReset();
});

describe('overview load (S1)', () => {
	it('reads the general overview without a campaign', async () => {
		adminLoad.mockResolvedValueOnce(overview(null));
		const data = (await load(loadEvent(''))) as Record<string, unknown>;
		expect(adminLoad).toHaveBeenCalledWith(expect.anything(), '/admin/overview');
		expect(adminApi).not.toHaveBeenCalled();
		expect(data).toMatchObject({ scope: null, scopeError: null, expenses: null });
	});

	it('reads the campaign overview and its expenses, and the row being edited or deleted', async () => {
		adminApi.mockImplementation(async (_event: unknown, path: string) =>
			path.startsWith('/admin/overview') ? { ok: true, data: overview({ id: campaignId }) } : { ok: true, data: { expenses: [], totalMinor: 0 } }
		);
		const data = (await load(loadEvent(`?campana=${campaignId}&editar=${expenseId}`))) as Record<string, unknown>;
		expect(adminApi).toHaveBeenCalledWith(expect.anything(), `/admin/overview?campaign=${campaignId}`);
		expect(adminApi).toHaveBeenCalledWith(expect.anything(), `/admin/campaigns/${campaignId}/expenses`);
		expect(data).toMatchObject({ scope: campaignId, scopeError: null, expenses: { expenses: [], totalMinor: 0 }, editing: expenseId, removing: null });
		expect(data.today).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
	});

	it('shows what the last save did from the address, only with the known codes', async () => {
		adminApi.mockImplementation(async (_event: unknown, path: string) =>
			path.startsWith('/admin/overview') ? { ok: true, data: overview({ id: campaignId }) } : { ok: true, data: { expenses: [], totalMinor: 0 } }
		);
		for (const [code, notice] of [['cargado', 'Gasto cargado'], ['actualizado', 'Gasto actualizado'], ['eliminado', 'Gasto eliminado'], ['<b>hola</b>', null]] as const) {
			expect(await load(loadEvent(`?campana=${campaignId}&hecho=${encodeURIComponent(code)}`)), code).toMatchObject({ notice });
		}
		expect(await load(loadEvent(`?campana=${campaignId}`))).toMatchObject({ notice: null });
	});

	it('falls back to the general view for a campaign the organization does not have', async () => {
		adminApi.mockResolvedValue({ ok: false, status: 404, code: 'not_found', message: 'Campaña no encontrada' });
		adminLoad.mockResolvedValueOnce(overview(null));
		const data = (await load(loadEvent(`?campana=${campaignId}`))) as Record<string, unknown>;
		expect(data).toMatchObject({ scope: null, scopeError: 'No encontramos esa campaña: se muestra el resumen general.', expenses: null });
	});

	it('does not ask the API for something that is not a campaign id', async () => {
		adminLoad.mockResolvedValueOnce(overview(null));
		const data = (await load(loadEvent('?campana=moto'))) as Record<string, unknown>;
		expect(adminApi).not.toHaveBeenCalled();
		expect(data).toMatchObject({ scope: null, scopeError: 'No encontramos esa campaña: se muestra el resumen general.' });
	});
});

describe('expense actions (S2)', () => {
	const typed = { category: 'repuestos', detail: 'Juego de cubiertas', amount: '12.500,50', spentOn: '10/11/2026' };

	it('adds an expense in minor units on the selected campaign', async () => {
		adminApi.mockResolvedValueOnce({ ok: true, status: 201, data: { expense: {} } });
		// After saving, the page is read again by GET: a reload never sends the expense twice.
		await expect(actions.addExpense!(actionEvent('addExpense', typed))).rejects.toMatchObject({ status: 303, location: `/admin?campana=${campaignId}&hecho=cargado` });
		expect(adminApi).toHaveBeenCalledWith(expect.anything(), `/admin/campaigns/${campaignId}/expenses`, {
			method: 'POST',
			body: { category: 'repuestos', detail: 'Juego de cubiertas', amountMinor: 1_250_050, spentOn: '2026-11-10' }
		});
	});

	it('refuses an amount it cannot read without calling the API, keeping what was typed', async () => {
		const result = (await actions.addExpense!(actionEvent('addExpense', { ...typed, amount: '12.50' }))) as { status: number; data: unknown };
		expect(adminApi).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data).toEqual({ target: 'expense', ok: false, message: 'Escribí el monto en pesos, por ejemplo 12.500 o 12500,50', input: { id: '', ...typed, amount: '12.50' } });
	});

	it('refuses a day that does not exist', async () => {
		const result = (await actions.addExpense!(actionEvent('addExpense', { ...typed, spentOn: '31/02/2026' }))) as { status: number; data: { message: string } };
		expect(adminApi).not.toHaveBeenCalled();
		expect(result.data.message).toBe('Fecha: La fecha 31/02/2026 no existe');
		const empty = (await actions.addExpense!(actionEvent('addExpense', { ...typed, spentOn: '' }))) as { data: { message: string } };
		expect(empty.data.message).toBe('Indicá la fecha del gasto');
	});

	it('shows the API refusal, its field message first', async () => {
		adminApi.mockResolvedValueOnce({ ok: false, status: 400, message: 'Datos inválidos', details: { fieldErrors: { detail: ['El detalle admite hasta 200 caracteres'] } } });
		const result = (await actions.addExpense!(actionEvent('addExpense', typed))) as { status: number; data: { message: string } };
		expect(result.status).toBe(400);
		expect(result.data.message).toBe('El detalle admite hasta 200 caracteres');
		adminApi.mockResolvedValueOnce({ ok: false, status: 403, message: 'No tenés permiso para esta acción' });
		const denied = (await actions.addExpense!(actionEvent('addExpense', typed))) as { status: number; data: { message: string } };
		expect(denied.status).toBe(403);
		expect(denied.data.message).toBe('No tenés permiso para esta acción');
	});

	it('updates and deletes the expense by id', async () => {
		adminApi.mockResolvedValue({ ok: true, status: 200, data: {} });
		await expect(actions.updateExpense!(actionEvent('updateExpense', { ...typed, id: expenseId }))).rejects.toMatchObject({ status: 303, location: `/admin?campana=${campaignId}&hecho=actualizado` });
		expect(adminApi).toHaveBeenLastCalledWith(expect.anything(), `/admin/campaigns/${campaignId}/expenses/${expenseId}`, {
			method: 'PATCH',
			body: { category: 'repuestos', detail: 'Juego de cubiertas', amountMinor: 1_250_050, spentOn: '2026-11-10' }
		});
		await expect(actions.deleteExpense!(actionEvent('deleteExpense', { id: expenseId }))).rejects.toMatchObject({ status: 303, location: `/admin?campana=${campaignId}&hecho=eliminado` });
		expect(adminApi).toHaveBeenLastCalledWith(expect.anything(), `/admin/campaigns/${campaignId}/expenses/${expenseId}`, { method: 'DELETE' });
	});

	it('never puts something that is not an expense id in the API path', async () => {
		const result = (await actions.deleteExpense!(actionEvent('deleteExpense', { id: '..' }))) as { status: number; data: { message: string } };
		expect(adminApi).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data.message).toBe('No encontramos ese gasto');
	});
});
