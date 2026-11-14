import { beforeEach, describe, expect, it, vi } from 'vitest';

// odd/tasks/owner-feedback-2026-11-11b.md T13 (S12, L18): the awards page shows the coupons in
// play from the board's count, never by loading the draw screen's candidate list, and a unit
// nobody can win any more is declared void with a reason.
const adminApi = vi.fn();
const adminLoad = vi.fn();
vi.mock('#lib/server/admin.js', () => ({ adminApi: (...args: unknown[]) => adminApi(...args), adminLoad: (...args: unknown[]) => adminLoad(...args) }));

const { actions, load } = await import('./+page.server');

const board = { campaign: { id: 'c1' }, canOperate: true, appDraw: { state: 'ready', round: 1, drawnAt: null, reason: null, candidateCount: 4_812 }, prizes: [] };

function event(form: Record<string, string> = {}) {
	return {
		params: { id: 'c1' },
		url: new URL('https://demo.localhost/admin/campanas/c1/premios'),
		request: new Request('https://demo.localhost/admin/campanas/c1/premios?/declareVoid', { method: 'POST', body: new URLSearchParams(form) })
	} as never;
}

beforeEach(() => {
	adminApi.mockReset();
	adminLoad.mockReset();
});

describe('loading the awards page', () => {
	it('reads the board only: the count of coupons in play comes with it', async () => {
		adminLoad.mockResolvedValueOnce(board);
		const data = (await load(event())) as { board: typeof board };
		expect(adminLoad).toHaveBeenCalledTimes(1);
		expect(adminLoad.mock.calls[0]![1]).toBe('/admin/campaigns/c1/awards');
		expect(adminApi).not.toHaveBeenCalled();
		expect(data.board.appDraw.candidateCount).toBe(4_812);
	});
});

describe('declaring a unit void', () => {
	it('sends the unit and its reason to the API', async () => {
		adminApi.mockResolvedValueOnce({ ok: true, status: 200, data: board });
		const result = await actions.declareVoid!(event({ prizeId: 'moto', slot: '1', reason: '  No quedan cupones para sortear ' }));
		expect(adminApi).toHaveBeenCalledWith(expect.anything(), '/admin/campaigns/c1/awards/moto/slots/1/void', { method: 'POST', body: { reason: 'No quedan cupones para sortear' } });
		expect(result).toEqual({ target: 'slot-moto-1', ok: true, message: 'Unidad declarada desierta' });
	});

	it('shows the refusal on the unit', async () => {
		const message = 'Todavía hay cupones sin premio: sorteá la unidad en la aplicación antes de declararla desierta';
		adminApi.mockResolvedValueOnce({ ok: false, status: 409, code: 'app_draw_possible', message });
		const result = (await actions.declareVoid!(event({ prizeId: 'moto', slot: '1', reason: 'Sin cupones' }))) as { status: number; data: unknown };
		expect(result.status).toBe(409);
		expect(result.data).toEqual({ target: 'slot-moto-1', ok: false, message });
	});
});

// odd/tasks/draw-room.md T1 (S1): the official date and time are typed as dd/mm/aaaa and hh:mm.
describe('previewing the Quiniela draw', () => {
	const extracts = Array.from({ length: 20 }, (_, index) => String(index)).join(' ');
	const quiniela = (drawDate: string, drawTime: string) =>
		event({ timezone: 'America/Argentina/Buenos_Aires', source: 'Quiniela de la Ciudad, Nocturna', drawDate, drawTime, extracts, evidenceUrl: 'https://loteria.example/x.pdf' });

	it('sends the typed day and time as the same UTC instant the date and time pickers gave', async () => {
		adminApi.mockResolvedValueOnce({ ok: true, status: 200, data: {} });
		await actions.quinielaPreview!(quiniela('29/11/2026', '21:00'));
		expect(adminApi.mock.calls[0]![1]).toBe('/admin/campaigns/c1/quiniela/preview');
		expect(adminApi.mock.calls[0]![2].body).toMatchObject({ drawnAt: '2026-11-30T00:00:00.000Z' });
	});

	it('refuses a day that does not exist without calling the API, keeping what was typed', async () => {
		const result = (await actions.quinielaPreview!(quiniela('31/02/2027', '21:00'))) as { status: number; data: { message: string; input: { drawDate: string } } };
		expect(result.status).toBe(400);
		expect(result.data.message).toBe('La fecha 31/02/2027 no existe');
		expect(result.data.input.drawDate).toBe('31/02/2027');
		expect(adminApi).not.toHaveBeenCalled();
	});
});
