import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromLocalInput } from '#lib/tz.js';
import CampaignAdminPage from './+page.svelte';

// odd/tasks/draw-room.md T1 (S1): the panel's date fields are our own dd/mm/aaaa and hh:mm text
// inputs, read by the server, so the actions send the API the same instants as the browser's
// datetime-local fields did.
const adminApi = vi.fn();
vi.mock('#lib/server/admin.js', () => ({ adminApi: (...args: unknown[]) => adminApi(...args), adminLoad: vi.fn() }));

const { actions } = await import('./+page.server');
const timezone = 'America/Argentina/Buenos_Aires';

function event(action: string, form: Record<string, string>) {
	return {
		params: { id: 'c1' },
		url: new URL(`https://demo.localhost/admin/campanas/c1?/${action}`),
		request: new Request(`https://demo.localhost/admin/campanas/c1?/${action}`, { method: 'POST', body: new URLSearchParams(form) })
	} as never;
}

const details = (dates: Record<string, string>) => ({ timezone, title: 'Moto', subtitle: '', summary: 'Sorteamos una moto.', streamUrl: '', replayUrl: '', ...dates });

beforeEach(() => adminApi.mockReset());

describe('campaign page date fields', () => {
	const campaign = {
		id: 'c1',
		productIds: [],
		products: [],
		slug: 'moto',
		title: 'Moto',
		subtitle: null,
		summary: 'S',
		status: 'draft',
		isDemo: false,
		timezone,
		opensAt: '2026-10-20T00:00:00Z',
		closesAt: '2026-12-26T00:00:00Z',
		drawAt: null,
		streamUrl: null,
		replayUrl: null,
		video: null,
		requiredApprovals: [],
		gate: { allowed: false, missing: [], rejected: [] },
		allowedTransitions: [],
		canClose: false,
		approvals: [],
		rules: [],
		chanceVariants: [],
		prizes: [],
		events: [],
		manifest: null,
		totals: { eligibleEntries: 0, participants: 0 }
	};
	const body = render(CampaignAdminPage as Component, {
		props: { data: { campaign, prizeEditor: { prizes: [], editable: false, videoEditable: false, videos: [] }, session: { organization: { currency: 'ARS' }, permissions: ['campaigns.manage', 'campaigns.operate'] } }, form: null } as never
	}).body;
	const input = (name: string) => body.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';

	it('renders dd/mm/aaaa and hh:mm text fields instead of the browser pickers', () => {
		expect(body).not.toMatch(/type="(date|datetime-local|time)"/);
		for (const name of ['opensAt', 'closesAt', 'drawAt', 'occurredAt']) {
			expect(input(name)).toContain('type="text"');
			expect(input(name)).toContain('placeholder="dd/mm/aaaa"');
			expect(input(name)).toContain('inputmode="numeric"');
			expect(input(`${name}Time`)).toContain('placeholder="hh:mm"');
		}
	});

	it('fills them with the stored dates in the campaign time zone', () => {
		expect(input('opensAt')).toContain('value="19/10/2026"');
		expect(input('opensAtTime')).toContain('value="21:00"');
		expect(input('closesAt')).toContain('value="25/12/2026"');
		expect(input('closesAtTime')).toContain('value="21:00"');
		expect(input('drawAt')).toContain('value=""');
	});
});

describe('saving typed dates', () => {
	it('sends 25/12/2026 21:00 as the same instant the datetime-local field sent for 2026-12-25T21:00', async () => {
		adminApi.mockResolvedValueOnce({ ok: true, status: 200, data: {} });
		const result = await actions.details!(event('details', details({ opensAt: '01/12/2026', opensAtTime: '9:00', closesAt: '24/12/2026', closesAtTime: '20:00', drawAt: '25/12/2026', drawAtTime: '21:00' })));
		expect(result).toEqual({ action: 'details', ok: true, message: 'Cambios guardados' });
		const sent = adminApi.mock.calls[0]![2].body;
		expect(sent).toMatchObject({ opensAt: '2026-12-01T12:00:00.000Z', closesAt: '2026-12-24T23:00:00.000Z', drawAt: fromLocalInput('2026-12-25T21:00', timezone) });
		expect(sent.drawAt).toBe('2026-12-26T00:00:00.000Z');
	});

	it('clears an emptied date as before', async () => {
		adminApi.mockResolvedValueOnce({ ok: true, status: 200, data: {} });
		await actions.details!(event('details', details({ drawAt: '', drawAtTime: '' })));
		expect(adminApi.mock.calls[0]![2].body).toMatchObject({ drawAt: null });
		expect(adminApi.mock.calls[0]![2].body).not.toHaveProperty('opensAt');
	});

	it('refuses a day that does not exist or 24:00 with a Spanish message, without calling the API', async () => {
		const day = (await actions.details!(event('details', details({ drawAt: '31/02/2027', drawAtTime: '21:00' })))) as { status: number; data: unknown };
		expect(day.status).toBe(400);
		expect(day.data).toEqual({ action: 'details', ok: false, message: 'Transmisión: La fecha 31/02/2027 no existe' });
		const hour = (await actions.details!(event('details', details({ opensAt: '25/12/2026', opensAtTime: '24:00', closesAt: '', closesAtTime: '' })))) as { status: number; data: unknown };
		expect(hour.data).toEqual({ action: 'details', ok: false, message: 'Apertura: Escribí la hora como hh:mm, de 00:00 a 23:59' });
		expect(adminApi).not.toHaveBeenCalled();
	});

	it('records a public event at the typed date and time', async () => {
		adminApi.mockResolvedValueOnce({ ok: true, status: 200, data: {} });
		await actions.drawEvent!(event('drawEvent', { timezone, kind: 'note', title: 'Nota', detail: '', evidenceUrl: '', occurredAt: '25/12/2026', occurredAtTime: '21:00' }));
		expect(adminApi.mock.calls[0]![2].body).toMatchObject({ occurredAt: '2026-12-26T00:00:00.000Z' });
	});
});
