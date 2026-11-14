import { describe, expect, it } from 'vitest';
import {
	DEFAULT_QUINIELA_SOURCE,
	draftHasContent,
	draftKey,
	drawRoomAllows,
	drawRoomOnly,
	emptyDraft,
	extractInput,
	extractRows,
	onAirHash,
	onAirRow,
	parseDraft,
	positionAfterInput,
	positionAfterKey,
	recordedExtractRows,
	storeDraft,
	tableProgress,
	tiradaPick,
	typedPrefix,
	unitRows,
	type DrawRoomView,
	type QuinielaLivePreview
} from './draw-room';

// odd/tasks/draw-room.md T5 (S3, S4, L1): the draw room's pure pieces.

const prizes: DrawRoomView['prizes'] = [
	{ id: 'moto', position: 1, title: 'Moto', quantity: 1, mechanism: 'quiniela', imageUrl: null },
	{ id: 'cash', position: 2, title: '$100.000', quantity: 2, mechanism: 'quiniela', imageUrl: null },
	{ id: 'kit', position: 3, title: 'Kit', quantity: 1, mechanism: 'manual', imageUrl: null }
];
const view = (overrides: Partial<DrawRoomView> = {}, awardOrder: 'first_to_last' | 'last_to_first' = 'last_to_first'): DrawRoomView => ({
	campaign: { id: 'c1', slug: 'moto', title: 'Moto 0 km', subtitle: null, status: 'awarding', timezone: 'America/Argentina/Buenos_Aires', drawAt: null, entryDigits: 4, awardOrder, round: 1 },
	prizes,
	coupons: { eligible: 12 },
	manifest: { round: 1, sha256: 'ab'.repeat(32), eligibleCount: 12, publishedAt: '2026-11-29T01:00:00.000Z' },
	quinielaDraw: null,
	winners: [],
	appDraw: { tiradas: [], units: [], candidateCount: null, reason: 'Primero registrá el resultado de la Quiniela de esta ronda' },
	...overrides
});
const preview = (extracts: QuinielaLivePreview['extracts'], slots: QuinielaLivePreview['slots'] = [], holders: QuinielaLivePreview['holders'] = []): QuinielaLivePreview => ({ extracts, slots, vacant: [], holders, digest: null });

describe('who sees only the draw room', () => {
	it('is a session that runs the draw without managing campaigns', () => {
		expect(drawRoomOnly(['draws.run'])).toBe(true);
		expect(drawRoomOnly(['dashboard.view', 'campaigns.view', 'campaigns.operate', 'draws.run'])).toBe(false);
		expect(drawRoomOnly(['audit.view'])).toBe(false);
	});

	it('may open the room, its own account and /admin, nothing else', () => {
		for (const path of ['/admin', '/admin/', '/admin/sala-de-sorteo', '/admin/sala-de-sorteo/c1', '/admin/cuenta']) expect(drawRoomAllows(path), path).toBe(true);
		for (const path of ['/admin/pedidos', '/admin/campanas/c1', '/admin/campanas/c1/en-vivo', '/admin/sala-de-sorteos', '/admin/cuentas', '/admin/plataforma']) expect(drawRoomAllows(path), path).toBe(false);
	});
});

describe('typing the 20 positions', () => {
	it('keeps 4 digits of what is typed or pasted', () => {
		expect(extractInput('12a3')).toBe('123');
		expect(extractInput(' 0042 ')).toBe('0042');
		expect(extractInput('123456')).toBe('1234');
	});

	it('moves on after 4 digits and with Enter, back with Backspace on an empty field, never past the ends', () => {
		expect(positionAfterInput(0, '004')).toBeNull();
		expect(positionAfterInput(0, '0042')).toBe(1);
		expect(positionAfterInput(19, '0042')).toBeNull();
		expect(positionAfterKey(3, 'Enter', '')).toBe(4);
		expect(positionAfterKey(19, 'Enter', '0042')).toBeNull();
		expect(positionAfterKey(3, 'Backspace', '')).toBe(2);
		expect(positionAfterKey(3, 'Backspace', '1')).toBeNull();
		expect(positionAfterKey(0, 'ArrowUp', '')).toBeNull();
		expect(positionAfterKey(3, 'a', '')).toBeNull();
	});

	it('sends the complete numbers from the 1st on, up to the first gap', () => {
		expect(typedPrefix(['0042', '1234', '', '9999'])).toEqual([42, 1234]);
		expect(typedPrefix(['0042', '12', '9999'])).toEqual([42]);
		expect(typedPrefix(['', '0042'])).toEqual([]);
	});

	it('words what each number did, and waits for a gap before it', () => {
		const label = (prizeId: string, slot: number) => `${prizeId}#${slot}`;
		const values = ['9999', '0004', '0004', '12', '0007', ...Array.from({ length: 15 }, () => '')];
		const rows = extractRows(
			values,
			preview([
				{ position: 1, number: 9999, outcome: 'no_match', prizeId: null, slot: null, rank: null },
				{ position: 2, number: 4, outcome: 'winner', prizeId: 'moto', slot: 1, rank: null },
				{ position: 3, number: 4, outcome: 'repeated', prizeId: null, slot: null, rank: null }
			]),
			label
		);
		expect(rows.slice(0, 6).map((row) => [row.label, row.state, row.outcome])).toEqual([
			['1.º', 'other', 'Sin coincidencia'],
			['2.º', 'won', 'Ganador: moto#1'],
			['3.º', 'other', 'Repetido, no cuenta'],
			['4.º', 'typing', null],
			['5.º', 'waiting', 'Falta un número anterior'],
			['6.º', 'empty', null]
		]);
		// A number changed after the preview is checked again, not shown with the old outcome.
		const changed = extractRows(['0005', ...Array.from({ length: 19 }, () => '')], preview([{ position: 1, number: 4, outcome: 'winner', prizeId: 'moto', slot: 1, rank: null }]), label);
		expect(changed[0]).toMatchObject({ state: 'checking', outcome: 'Buscando…' });
	});
});

describe('the recorded extracts', () => {
	it('show each number, and the unit its coupon holds by the Quiniela', () => {
		const rows = recordedExtractRows(
			view({
				quinielaDraw: { round: 1, source: 'Q', drawnAt: '2026-11-30T00:00:00Z', extracts: [9999, 4, ...Array.from({ length: 18 }, (_, index) => 1000 + index)], evidenceUrl: 'https://x.example' },
				winners: [{ prizeId: 'cash', prizeTitle: '$100.000', position: 2, slot: 1, round: 1, role: 'winner', source: 'quiniela', entryNumber: '0004', maskedName: 'Lu*** Ñ.', identity: null }]
			})
		);
		expect(rows).toHaveLength(20);
		expect(rows.slice(0, 2).map((row) => [row.label, row.value, row.state, row.outcome])).toEqual([
			['1.º', '9999', 'other', null],
			['2.º', '0004', 'won', 'Ganador: $100.000, unidad 1']
		]);
	});
});

describe('the draft kept in case the page is lost', () => {
	it('restores what was typed, per campaign and round, and survives junk', () => {
		const draft = { ...emptyDraft(), extracts: ['0042', '12', ...Array.from({ length: 18 }, () => '')], drawDate: '29/11/2026', drawTime: '21:00', evidenceUrl: 'https://loteria.example/x.pdf' };
		expect(parseDraft(JSON.stringify(draft))).toEqual(draft);
		expect(parseDraft(null)).toEqual(emptyDraft());
		expect(parseDraft('{not json')).toEqual(emptyDraft());
		expect(parseDraft(JSON.stringify({ extracts: 'x' }))).toEqual(emptyDraft());
		// Short or dirty lists come back as 20 digit-only positions.
		expect(parseDraft(JSON.stringify({ ...draft, extracts: ['00a4'] })).extracts).toEqual(['004', ...Array.from({ length: 19 }, () => '')]);
		expect(draftKey('c1', 1)).not.toBe(draftKey('c1', 2));
		expect(emptyDraft().source).toBe(DEFAULT_QUINIELA_SOURCE);
	});

	it('is stored while it holds something and removed once empty', () => {
		const store = new Map<string, string>();
		const storage = { setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
		const draft = { ...emptyDraft(), extracts: ['0042', ...Array.from({ length: 19 }, () => '')] };
		expect(draftHasContent(emptyDraft())).toBe(false);
		storeDraft(storage, 'k', draft);
		expect(parseDraft(store.get('k')!)).toEqual(draft);
		storeDraft(storage, 'k', emptyDraft());
		expect(store.has('k')).toBe(false);
	});
});

describe('the winners table', () => {
	it('lists every unit in award order, the Quiniela prizes from the last when the campaign says so, then the manual ones', () => {
		expect(unitRows(view()).map((row) => [row.label, row.state])).toEqual([
			['$100.000, unidad 1', 'pending'],
			['$100.000, unidad 2', 'pending'],
			['Moto', 'pending'],
			['Kit', 'manual']
		]);
		expect(unitRows(view({}, 'first_to_last')).map((row) => row.label)).toEqual(['Moto', '$100.000, unidad 1', '$100.000, unidad 2', 'Kit']);
	});

	it('grows with the live matches before the Quiniela is recorded', () => {
		const live = preview([], [{ prizeId: 'cash', prizeTitle: '$100.000', slot: 1, winner: { entryNumber: 4, extract: 2 }, alternates: [] }], [{ entryNumber: 4, maskedName: 'Lu*** Ñ.' }]);
		const rows = unitRows(view(), live);
		expect(rows[0]).toMatchObject({ state: 'live', holder: { entryNumber: '0004', name: 'Lu*** Ñ.', note: 'Extracto 2.º' } });
		expect(tableProgress(rows)).toBe('1 de 4');
	});

	it('after the record shows the winners as the API names them and the units it can draw', () => {
		const recorded = view({
			quinielaDraw: { round: 1, source: 'Q', drawnAt: '2026-11-30T00:00:00Z', extracts: [], evidenceUrl: 'https://x.example' },
			winners: [
				{ prizeId: 'cash', prizeTitle: '$100.000', position: 2, slot: 1, round: 1, role: 'winner', source: 'quiniela', entryNumber: '0000', maskedName: 'Ju*** P.', identity: { name: 'Juana Pérez', city: 'Cafayate', chances: 2 } },
				{ prizeId: 'moto', prizeTitle: 'Moto', position: 1, slot: 1, round: 1, role: 'winner', source: 'app_draw', entryNumber: '0004', maskedName: 'Lu*** Ñ.', identity: null }
			],
			appDraw: { tiradas: [], units: [{ prizeId: 'cash', prizeTitle: '$100.000', slot: 2, state: 'vacant' }], candidateCount: 10, reason: null }
		});
		const rows = unitRows(recorded);
		expect(rows.map((row) => [row.label, row.state, row.holder?.name ?? null, row.drawable])).toEqual([
			['$100.000, unidad 1', 'won', 'Juana Pérez', false],
			['$100.000, unidad 2', 'vacant', null, true],
			['Moto', 'won', 'Lu*** Ñ.', false],
			['Kit', 'manual', null, false]
		]);
		expect(rows[2]!.holder!.note).toBe('Sorteo en la app');
		// With no coupon left the API says why, and nothing is offered.
		const none = unitRows({ ...recorded, appDraw: { ...recorded.appDraw, candidateCount: 0, reason: 'No quedan cupones sin premio para sortear los premios vacantes' } });
		expect(none[1]).toMatchObject({ state: 'vacant', drawable: false });
	});
});

describe('broadcast mode', () => {
	it('never shows a hash in full, and only the name the holder allows', () => {
		const hash = 'ab12cd34'.repeat(8);
		expect(onAirHash(hash)).toBe('ab12cd34…ab12cd34');
		expect(onAirHash(hash)).not.toContain(hash);
		const [row] = unitRows(
			view({
				quinielaDraw: { round: 1, source: 'Q', drawnAt: '2026-11-30T00:00:00Z', extracts: [], evidenceUrl: 'https://x.example' },
				winners: [{ prizeId: 'cash', prizeTitle: '$100.000', position: 2, slot: 1, round: 1, role: 'winner', source: 'quiniela', entryNumber: '0004', maskedName: 'Lu*** Ñ.', identity: null }]
			})
		);
		expect(onAirRow(row!)).toEqual({ label: '$100.000, unidad 1', entryNumber: '0004', name: 'Lu*** Ñ.', state: 'Ganador' });
	});

	it('plays a tirada as one winner, no alternates', () => {
		expect(tiradaPick({ prizeId: 'moto', prizeTitle: 'Moto', slot: 1, pick: { entryNumber: '0007', maskedName: 'Pe*** R.' } })).toEqual({
			prizeId: 'moto',
			prizeTitle: 'Moto',
			slot: 1,
			role: 'winner',
			rank: 1,
			entryNumber: '0007',
			maskedName: 'Pe*** R.'
		});
	});
});
