import { describe, expect, it } from 'vitest';
import { newCampaignFromForm } from './campaign-form';
import { parseDateInput, parseDateTimeInput, parseTimeInput } from './date-input';
import { drawRoomAllows } from './draw-room';
import { dateTime } from './format';
import { drawnAtFromInput } from './quiniela';

// Independent verification probes of odd/tasks/draw-room.md: the dd/mm/aaaa fields post the same
// instants the native date-time inputs did (values taken from the base fromLocalInput), and the
// draw-room gate lets a draw host reach only its room and its account.
const form = (values: Record<string, string>) => {
	const data = new FormData();
	for (const [key, value] of Object.entries(values)) data.set(key, value);
	return data;
};

describe('dd/mm/aaaa fields (S1)', () => {
	it.each([
		['America/Argentina/Buenos_Aires', '2026-12-26T00:00:00.000Z'],
		['America/New_York', '2026-12-26T02:00:00.000Z'],
		['UTC', '2026-12-25T21:00:00.000Z'],
		['Asia/Kolkata', '2026-12-25T15:30:00.000Z']
	])('25/12/2026 21:00 in %s posts %s', (timezone, iso) => {
		expect(drawnAtFromInput('25/12/2026', '21:00', timezone)).toEqual({ ok: true, value: iso });
		const body = newCampaignFromForm(form({ title: 'T', slug: 't', summary: 'S', timezone, opensAt: '25/12/2026', opensAtTime: '21:00' }));
		expect(body.body!.opensAt).toBe(iso);
	});

	it.each(['31/02/2026', '29/02/2027', '00/01/2026', '01/13/2026', '25/12/26', '2026-02-30', 'mañana'])('refuses the date %s', (value) => {
		expect(parseDateInput(value).ok).toBe(false);
	});

	it.each(['24:00', '23:60', '9:5', '21:00:00'])('refuses the time %s', (value) => {
		expect(parseTimeInput(value).ok).toBe(false);
	});

	it('a date and a time go together', () => {
		expect(parseDateTimeInput('25/12/2026', '').ok).toBe(false);
		expect(parseDateTimeInput('', '21:00').ok).toBe(false);
		expect(parseDateTimeInput('', '')).toEqual({ ok: true, value: null });
	});

	it('shows dd/MM/yyyy HH:mm across midnight', () => {
		expect(dateTime('2026-12-01T02:30:00Z', 'America/Argentina/Buenos_Aires')).toBe('30/11/2026 23:30');
	});
});

describe('draw-room gate (T5)', () => {
	it.each([
		['/admin', true],
		['/admin/sala-de-sorteo/x', true],
		['/admin/cuenta', true],
		['/admin/sala-de-sorteo-x', false],
		['/admin/cuentas', false],
		['/admin/campanas', false],
		['/admin/plataforma', false]
	])('%s → %s', (path, allowed) => {
		expect(drawRoomAllows(path as string)).toBe(allowed);
	});
});
