import { describe, expect, it } from 'vitest';
import { prizeDrawListFile, prizeDrawListHref, verifyAppDrawCommand } from './app-draw';
import {
	DRAND_POLL_MS,
	DRAND_WAIT_MS,
	appPrizeRows,
	drawConfirmText,
	drawStep,
	prizeDrawPicks,
	prizeTiradaRows,
	showQuinielaEntry,
	waitingText,
	type AppPrizeTirada,
	type AppPrizeView,
	type DrawRoomView
} from './draw-room';

// odd/tasks/draw-room.md T9 (S6, S8; ADR 0026): one drand-backed tirada per `app` prize, as the
// draw room shows it. The API decides the order, the states and the picks; these only word them.

const hash = 'c0ffee00'.repeat(8);
const tirada = (overrides: Partial<AppPrizeTirada> = {}): AppPrizeTirada => ({
	prizeId: 'cash',
	prizeTitle: 'Efectivo',
	round: 1,
	sequence: 1,
	attempt: 1,
	state: 'drawn',
	units: [1, 2, 3],
	drandRound: 5_000_000,
	drandRoundAt: '2026-11-30T01:15:03.000Z',
	committedAt: '2026-11-30T01:15:00.000Z',
	candidateCount: 12,
	candidateSha256: hash,
	beacon: { signature: 'ab'.repeat(48), randomness: 'cd'.repeat(32), url: 'https://api.drand.sh/x/public/5000000' },
	picks: [
		{ slot: 1, entryNumber: '0004', maskedName: 'Ma*** G.' },
		{ slot: 2, entryNumber: '0009', maskedName: 'Pe*** R.' },
		{ slot: 3, entryNumber: '0000', maskedName: 'Ju*** P.' }
	],
	revealedAt: '2026-11-30T01:15:04.000Z',
	...overrides
});
const prize = (overrides: Partial<AppPrizeView> & Pick<AppPrizeView, 'prizeId' | 'prizeTitle'>): AppPrizeView => ({
	position: 1,
	quantity: 1,
	state: 'pending',
	units: [{ slot: 1, state: 'pending' }],
	pendingUnits: [1],
	tiradas: [],
	reason: null,
	...overrides
});
// Award order last_to_first: the API lists the cash prize (position 2) first.
const view = (appPrizes: AppPrizeView[], overrides: Partial<DrawRoomView> = {}): DrawRoomView => ({
	campaign: { id: 'c1', slug: 'moto', title: 'Moto 0 km', subtitle: null, status: 'awarding', timezone: 'America/Argentina/Buenos_Aires', drawAt: null, entryDigits: 4, awardOrder: 'last_to_first', round: 1 },
	prizes: [
		{ id: 'moto', position: 1, title: 'Moto', quantity: 1, mechanism: 'app', imageUrl: 'https://cdn.example/moto.jpg' },
		{ id: 'cash', position: 2, title: 'Efectivo', quantity: 3, mechanism: 'app', imageUrl: null }
	],
	coupons: { eligible: 12 },
	manifest: { round: 1, sha256: hash, eligibleCount: 12, publishedAt: '2026-11-29T01:00:00.000Z' },
	quinielaDraw: null,
	winners: [],
	appDraw: { tiradas: [], units: [], candidateCount: null, reason: 'No hay premios vacantes para sortear en la aplicación' },
	appPrizes: { prizes: appPrizes, candidateCount: 12, reason: null },
	...overrides
});
const pendingCash = prize({ prizeId: 'cash', prizeTitle: 'Efectivo', position: 2, quantity: 3, units: [1, 2, 3].map((slot) => ({ slot, state: 'pending' as const })), pendingUnits: [1, 2, 3] });
const pendingMoto = prize({ prizeId: 'moto', prizeTitle: 'Moto' });

describe('the prize list of the room', () => {
	it('keeps the API award order, joins each prize with its image and units, and highlights only the next prize to draw', () => {
		const rows = appPrizeRows(view([pendingCash, pendingMoto]));
		expect(rows.map((row) => row.title)).toEqual(['Efectivo', 'Moto']);
		expect(rows.map((row) => row.drawLabel)).toEqual(['Sortear Efectivo', 'Sortear Moto']);
		expect(rows.map((row) => row.primary)).toEqual([true, false]);
		expect(rows.map((row) => row.drawable)).toEqual([true, true]);
		expect(rows[0]).toMatchObject({ imageUrl: null, quantity: 3, unitsLabel: '3 unidades', state: 'pending', stateLabel: 'Pendiente', winners: [], pendingCount: 3 });
		expect(rows[1]).toMatchObject({ imageUrl: 'https://cdn.example/moto.jpg', unitsLabel: '1 unidad' });
	});

	it('words each state and lists the winners with the consented public name or the masked one', () => {
		const drawn = { ...pendingCash, state: 'drawn' as const, units: [1, 2, 3].map((slot) => ({ slot, state: 'held' as const })), pendingUnits: [], tiradas: [tirada()], reason: appPrizeDone };
		const committed = { ...pendingMoto, state: 'committed' as const, tiradas: [tirada({ prizeId: 'moto', prizeTitle: 'Moto', sequence: 2, state: 'committed', units: [1], beacon: null, picks: null, revealedAt: null })] };
		const winners: DrawRoomView['winners'] = [
			{ prizeId: 'cash', prizeTitle: 'Efectivo', position: 2, slot: 2, round: 1, role: 'winner', source: 'app_draw', entryNumber: '0009', maskedName: 'Pe*** R.', identity: { name: 'Pedro Ruiz', city: null, chances: 3 } },
			{ prizeId: 'cash', prizeTitle: 'Efectivo', position: 2, slot: 1, round: 1, role: 'winner', source: 'app_draw', entryNumber: '0004', maskedName: 'Ma*** G.', identity: null }
		];
		const rows = appPrizeRows(view([drawn, committed], { winners }));
		expect(rows[0]).toMatchObject({ state: 'drawn', stateLabel: 'Sorteado', drawable: false, primary: false });
		expect(rows[0]!.winners).toEqual([
			{ slot: 1, entryNumber: '0004', name: 'Ma*** G.' },
			{ slot: 2, entryNumber: '0009', name: 'Pedro Ruiz' }
		]);
		// The pending tirada is the one to resume: it is the next action.
		expect(rows[1]).toMatchObject({ state: 'committed', stateLabel: 'Comprometido: esperando el número de drand', drawable: true, primary: true, drandRound: 5_000_000 });
	});

	it('keeps a prize the API refuses visible but not drawable, with its reason', () => {
		const blocked = { ...pendingMoto, reason: 'Hay una tirada de «Efectivo» esperando su ronda de drand: terminala con «Sortear» antes de seguir' };
		const committed = { ...pendingCash, state: 'committed' as const };
		const rows = appPrizeRows(view([committed, blocked]));
		expect(rows[1]).toMatchObject({ drawable: false, primary: false, reason: blocked.reason });
		expect(rows[0]).toMatchObject({ drawable: true, primary: true });
	});

	it('has no rows for a campaign without app prizes (or an API without them)', () => {
		expect(appPrizeRows(view([]))).toEqual([]);
		expect(appPrizeRows({ ...view([]), appPrizes: undefined })).toEqual([]);
	});

	it('says in the confirmation how many winners the tirada draws, and among how many coupons', () => {
		const [cash, moto] = appPrizeRows(view([pendingCash, pendingMoto]));
		expect(drawConfirmText(cash!, 12)).toBe('Se sortean 3 ganadores de «Efectivo» entre 12 cupones sin premio.');
		expect(drawConfirmText(moto!, 1)).toBe('Se sortea 1 ganador de «Moto» entre 1 cupón sin premio.');
		expect(drawConfirmText(moto!, null)).toBe('Se sortea 1 ganador de «Moto» entre los cupones sin premio.');
	});
});

const appPrizeDone = 'Todas las unidades de este premio ya tienen ganador: no hay nada para sortear';

describe('Quiniela entry', () => {
	it('shows only while the campaign still has Quiniela prizes', () => {
		expect(showQuinielaEntry(view([pendingCash]))).toBe(false);
		const mixed = view([pendingCash]);
		mixed.prizes = [...mixed.prizes, { id: 'q', position: 3, title: 'Kit', quantity: 1, mechanism: 'quiniela', imageUrl: null }];
		expect(showQuinielaEntry(mixed)).toBe(true);
	});
});

describe('waiting for drand and resuming the same tirada', () => {
	it('reveals on 201 and on 200 (revealed by another request)', () => {
		expect(drawStep({ status: 201 }, 0)).toBe('reveal');
		expect(drawStep({ status: 200 }, 59_000)).toBe('reveal');
	});

	it('asks again every 2 s while the round is pending (202) or the answer is lost, for up to a minute', () => {
		expect(DRAND_POLL_MS).toBe(2_000);
		expect(DRAND_WAIT_MS).toBe(60_000);
		expect(drawStep({ status: 202 }, 0)).toBe('retry');
		expect(drawStep(null, 10_000)).toBe('retry');
		expect(drawStep({ status: 503, transient: true }, 20_000)).toBe('retry');
		expect(drawStep({ status: 202 }, 57_999)).toBe('retry');
		// Past the minute: offer "Reintentar", which resumes the same round, never a new tirada.
		expect(drawStep({ status: 202 }, 58_000)).toBe('stalled');
		expect(drawStep(null, 61_000)).toBe('stalled');
	});

	it('stops on a refusal (another prize pending, nothing left), whatever the time', () => {
		expect(drawStep({ status: 409 }, 0)).toBe('refused');
		expect(drawStep({ status: 503, transient: false }, 0)).toBe('refused');
		expect(drawStep({ status: 404 }, 0)).toBe('refused');
	});

	it('words the wait with the committed drand round once it is known', () => {
		expect(waitingText(5_000_000)).toBe('Esperando el número público de drand (ronda 5000000)…');
		expect(waitingText(null)).toBe('Esperando el número público de drand…');
	});
});

describe('the reel of a prize tirada', () => {
	it('stops once per unit, in drawing order, each a winner of its unit', () => {
		const picks = prizeDrawPicks(tirada(), 3);
		expect(picks.map((pick) => [pick.slot, pick.entryNumber, pick.prizeTitle, pick.role])).toEqual([
			[1, '0004', 'Efectivo, unidad 1', 'winner'],
			[2, '0009', 'Efectivo, unidad 2', 'winner'],
			[3, '0000', 'Efectivo, unidad 3', 'winner']
		]);
		expect(prizeDrawPicks(tirada({ prizeTitle: 'Moto', units: [1], picks: [{ slot: 1, entryNumber: '0004', maskedName: 'Ma*** G.' }] }), 1).map((pick) => pick.prizeTitle)).toEqual(['Moto']);
		expect(prizeDrawPicks(tirada({ state: 'committed', picks: null }), 3)).toEqual([]);
	});
});

describe('the tirada record', () => {
	it('lists each tirada with its prize, units, drand round, time, count and short hash, in order', () => {
		const second = tirada({ prizeId: 'moto', prizeTitle: 'Moto', sequence: 2, state: 'committed', units: [1], candidateCount: 9, drandRound: 5_000_100, beacon: null, picks: null, revealedAt: null });
		const rows = prizeTiradaRows(view([{ ...pendingCash, tiradas: [tirada()] }, { ...pendingMoto, tiradas: [second] }]));
		expect(rows).toEqual([
			{ key: '1-1', sequence: 1, prizeTitle: 'Efectivo', units: '3 unidades', drandRound: 5_000_000, committedAt: '2026-11-30T01:15:00.000Z', candidates: 'Entre 12 cupones', hash: 'c0ffee00…c0ffee00', state: 'drawn' },
			{ key: '1-2', sequence: 2, prizeTitle: 'Moto', units: '1 unidad', drandRound: 5_000_100, committedAt: '2026-11-30T01:15:00.000Z', candidates: 'Entre 9 cupones', hash: 'c0ffee00…c0ffee00', state: 'committed' }
		]);
	});
});

describe('verifying a prize tirada on the public site', () => {
	it('serves each list under the prize tirada address and names it like the API', () => {
		expect(prizeDrawListHref('moto', 1, 2)).toBe('/sorteos/moto/sorteo-app/1/premios/2/cupones.txt');
		expect(prizeDrawListFile('moto', 1, 2)).toBe('moto-cupones-sorteo-app-ronda-1-premio-2.txt');
	});

	it('gives the exact command of scripts/verify-app-draw.mjs', () => {
		expect(verifyAppDrawCommand({ file: 'moto-cupones-sorteo-app-ronda-1-premio-2.txt', count: 3, drandRound: 5_000_000 })).toBe(
			'node scripts/verify-app-draw.mjs --candidates moto-cupones-sorteo-app-ronda-1-premio-2.txt --count 3 --round 5000000'
		);
	});
});
