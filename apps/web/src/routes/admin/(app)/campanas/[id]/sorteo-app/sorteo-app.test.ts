import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppDrawReel from '#lib/components/AppDrawReel.svelte';

// ADR 0024 §4-§5 (odd/tasks/owner-feedback-2026-11-11b.md S10, L14): the screen only
// reveals a result the API already stored. Once a round's draw exists, loading the
// screen replays it and never draws again; the POST answers the stored one with 200.
const adminApi = vi.fn();
vi.mock('#lib/server/admin.js', () => ({ adminApi: (...args: unknown[]) => adminApi(...args) }));

const { actions, load } = await import('./+page.server');
const Page = (await import('./+page.svelte')).default;

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
const html = (component: Component<never>, props: Record<string, unknown>) => render(component as Component, { props: props as never }).body;

const hash = 'ab12cd34'.repeat(8);
const campaign = { id: 'c1', title: 'Moto 0 km', round: 1, entryDigits: 4, timezone: 'America/Argentina/Buenos_Aires' };
const candidates = [
	{ entryNumber: '0000', maskedName: 'Ju*** P.' },
	{ entryNumber: '0001', maskedName: 'Ju*** P.' },
	{ entryNumber: '0002', maskedName: 'Ma*** G.' }
];
const preview = { campaign, vacant: [{ prizeId: 'moto', prizeTitle: 'Moto', slot: 1, alternatesCount: 1 }], candidates, candidateCount: 3, candidateSha256: hash };
const result = {
	campaign,
	round: 1,
	drawnAt: '2026-11-30T01:00:00.000Z',
	candidateCount: 3,
	candidateSha256: hash,
	picks: [
		{ prizeId: 'moto', prizeTitle: 'Moto', slot: 1, role: 'winner', rank: 1, entryNumber: '0002', maskedName: 'Ma*** G.' },
		{ prizeId: 'moto', prizeTitle: 'Moto', slot: 1, role: 'alternate', rank: 1, entryNumber: '0000', maskedName: 'Ju*** P.' }
	],
	candidates
};

const ok = (data: unknown, status = 200) => ({ ok: true, status, data });
const refused = (status: number, code: string, message: string) => ({ ok: false, status, code, message });

function event(search = '') {
	return {
		params: { id: 'c1' },
		url: new URL(`https://demo.localhost/admin/campanas/c1/sorteo-app${search}`),
		request: new Request('https://demo.localhost/admin/campanas/c1/sorteo-app?/sortear', { method: 'POST', body: new URLSearchParams() })
	} as never;
}

beforeEach(() => adminApi.mockReset());

describe('loading the presentation screen', () => {
	it('replays a stored draw without asking for a preview or drawing again', async () => {
		adminApi.mockResolvedValueOnce(ok(result));
		const data = await load(event());
		expect(data).toMatchObject({ view: { state: 'drawn', result } });
		expect(adminApi).toHaveBeenCalledTimes(1);
		expect(adminApi.mock.calls[0]![1]).toBe('/admin/campaigns/c1/app-draw');
		expect(adminApi.mock.calls[0]![2]?.method ?? 'GET').toBe('GET');
	});

	it('shows the preview while the round was not drawn yet', async () => {
		adminApi.mockResolvedValueOnce(refused(404, 'app_draw_missing', 'Los premios vacantes de esta ronda todavía no se sortearon en la aplicación')).mockResolvedValueOnce(ok(preview));
		const data = await load(event('?confirmar'));
		expect(data).toMatchObject({ view: { state: 'ready', preview }, confirming: true });
		expect(adminApi.mock.calls[1]![1]).toBe('/admin/campaigns/c1/app-draw/preview');
		expect(adminApi.mock.calls.every((call) => (call[2]?.method ?? 'GET') === 'GET')).toBe(true);
	});

	it('says why nothing can be drawn', async () => {
		adminApi.mockResolvedValueOnce(refused(404, 'app_draw_missing', 'x')).mockResolvedValueOnce(refused(409, 'no_vacant_prizes', 'No hay premios vacantes para sortear en la aplicación'));
		expect(await load(event())).toMatchObject({ view: { state: 'unavailable', message: 'No hay premios vacantes para sortear en la aplicación' } });
	});
});

describe('the draw action', () => {
	it('returns the new draw the first time', async () => {
		adminApi.mockResolvedValueOnce(ok(result, 201));
		expect(await actions.sortear(event())).toEqual({ result, created: true });
		expect(adminApi.mock.calls[0]![1]).toBe('/admin/campaigns/c1/app-draw');
		expect(adminApi.mock.calls[0]![2]).toMatchObject({ method: 'POST' });
	});

	it('returns the stored draw, marked as a replay, when it already ran', async () => {
		adminApi.mockResolvedValueOnce(ok(result, 200));
		expect(await actions.sortear(event())).toEqual({ result, created: false });
	});

	it('passes the API refusal on', async () => {
		adminApi.mockResolvedValueOnce(refused(409, 'no_candidates', 'No quedan cupones sin premio para sortear los premios vacantes'));
		const response = (await actions.sortear(event())) as unknown as { status: number; data: { message: string } };
		expect(response.status).toBe(409);
		expect(response.data.message).toBe('No quedan cupones sin premio para sortear los premios vacantes');
	});
});

describe('the screen', () => {
	it('before the draw: the vacant prizes, the candidate count, the short hash and the draw button', () => {
		const body = html(Page, { data: { view: { state: 'ready', preview }, confirming: false }, form: null });
		const page = text(body);
		expect(page).toContain('Moto');
		expect(page).toContain('3 cupones sin premio');
		expect(page).toContain('ab12cd34…ab12cd34');
		expect(page).toContain('Copiar SHA-256');
		expect(page).toContain('Sortear');
		expect(body).not.toMatch(/action="\?\/sortear"/);
		expect(page).toContain('Pantalla completa');
		expect(page).toMatch(/Sonido/);
	});

	it('asks for confirmation before drawing, because it cannot be undone', () => {
		const body = html(Page, { data: { view: { state: 'ready', preview }, confirming: true }, form: null });
		expect(body).toMatch(/action="\?\/sortear"/);
		expect(text(body)).toContain('No se puede deshacer');
		expect(text(body)).toContain('Confirmar y sortear');
	});

	it('after the draw: offers the replay and the results, never the draw again', () => {
		const body = html(Page, { data: { view: { state: 'drawn', result }, confirming: true }, form: null });
		const page = text(body);
		expect(page).toContain('Ver la animación');
		expect(body).not.toMatch(/action="\?\/sortear"/);
		expect(page).not.toContain('Confirmar y sortear');
		expect(page).toContain('Ganador 0002 · Ma*** G.');
		expect(page).toContain('Suplente 1 0000 · Ju*** P.');
	});

	it('tells when the screen showed a stored draw instead of a new one', () => {
		const page = text(html(Page, { data: { view: { state: 'ready', preview }, confirming: true }, form: { result, created: false } }));
		expect(page).toContain('Este sorteo ya se había hecho: se muestra el resultado guardado.');
		expect(page).not.toContain('Confirmar y sortear');
	});

	it('without JavaScript, a confirmed draw shows the stored result and the replay, not an empty stage', () => {
		// The form posted before hydration: the action answered the new draw and the page renders it as is.
		const body = html(Page, { data: { view: { state: 'ready', preview }, confirming: true }, form: { result, created: true } });
		const page = text(body);
		expect(page).toContain('Resultado del sorteo');
		expect(page).toContain('Ver la animación');
		expect(page).toContain('Ganador 0002 · Ma*** G.');
		expect(page).not.toContain('Este sorteo ya se había hecho');
		expect(body).not.toMatch(/action="\?\/sortear"/);
	});

	it('the reload after a draw without JavaScript replays the stored draw', async () => {
		adminApi.mockResolvedValueOnce(ok(result));
		const data = await load(event('?confirmar'));
		expect(data).toMatchObject({ view: { state: 'drawn', result } });
		const page = text(html(Page, { data, form: null }));
		expect(page).toContain('Ver la animación');
		expect(page).not.toContain('Confirmar y sortear');
	});

	it('explains why nothing can be drawn', () => {
		const page = text(html(Page, { data: { view: { state: 'unavailable', message: 'No hay premios vacantes para sortear en la aplicación' }, confirming: false }, form: null }));
		expect(page).toContain('No hay premios vacantes para sortear en la aplicación');
		expect(page).not.toContain('Confirmar y sortear');
	});
});

describe('reel rows', () => {
	const many = Array.from({ length: 2000 }, (_, index) => ({ entryNumber: String(index).padStart(4, '0'), maskedName: 'Lu*** Ñ.' }));

	it('render only the rows near the centre, each with the full number and the masked name', () => {
		const body = html(AppDrawReel, { strip: many, position: 100 });
		const rows = body.match(/class="reel-row[^"]*"/g) ?? [];
		expect(rows.length).toBeGreaterThan(5);
		expect(rows.length).toBeLessThan(20);
		expect(text(body)).toContain('0100 Lu*** Ñ.');
		expect(text(body)).not.toContain('0500');
	});

	it('hide the spinning list from screen readers (the result is announced in words)', () => {
		expect(html(AppDrawReel, { strip: many, position: 0 })).toMatch(/aria-hidden="true"/);
	});
});
