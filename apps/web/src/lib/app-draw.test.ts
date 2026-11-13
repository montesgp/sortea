import { describe, expect, it } from 'vitest';
import {
	REEL_FRAME_RATE,
	REEL_RADIUS,
	appDrawSummary,
	awardSourceLabel,
	displayOrder,
	pickAnnouncement,
	pickRole,
	planSpin,
	reelStrip,
	reelWindow,
	rowLabel,
	shortHash,
	spinAnnouncement,
	spinPosition,
	spinVelocity,
	tallyProgress,
	tallyRowState,
	tickTone,
	type AppDrawPick
} from './app-draw';

// ADR 0024 §5 (odd/tasks/owner-feedback-2026-11-11b.md S10, L14): the presentation
// screen spins every candidate through the centre and stops exactly on the
// stored pick. The motion is a deterministic function of the list length, the
// target row and the durations, so it can be checked without a browser.

const sample = (plan: ReturnType<typeof planSpin>, step = 1 / REEL_FRAME_RATE) => {
	const times: number[] = [];
	for (let t = 0; t < plan.duration; t += step) times.push(t);
	times.push(plan.duration);
	return times;
};

describe('reel landing', () => {
	for (const [length, target, start] of [
		[1, 0, 0],
		[2, 1, 0],
		[6, 4, 3],
		[300, 17, 0],
		[300, 299, 120],
		[5000, 4321, 9]
	] as const) {
		for (const kind of ['winner', 'alternate'] as const) {
			it(`stops exactly on row ${target} of ${length} (${kind}, from ${start})`, () => {
				const plan = planSpin({ length, target, start, kind });
				const end = spinPosition(plan, plan.duration);
				expect(end).toBe(plan.start + plan.distance);
				expect(Number.isInteger(end)).toBe(true);
				expect(((end % length) + length) % length).toBe(target);
				// After the stop it stays there.
				expect(spinPosition(plan, plan.duration + 5)).toBe(end);
				expect(spinVelocity(plan, plan.duration)).toBe(0);
			});
		}
	}

	it('is the same motion every time for the same inputs (a replay looks identical)', () => {
		expect(planSpin({ length: 300, target: 17, kind: 'winner' })).toEqual(planSpin({ length: 300, target: 17, kind: 'winner' }));
	});
});

describe('reel motion', () => {
	it('never moves backwards and only slows down once it decelerates', () => {
		for (const kind of ['winner', 'alternate'] as const) {
			const plan = planSpin({ length: 300, target: 42, kind });
			let previous = -Infinity;
			let previousSpeed = Infinity;
			for (const t of sample(plan, 0.01)) {
				const position = spinPosition(plan, t);
				expect(position).toBeGreaterThanOrEqual(previous);
				previous = position;
				if (t >= plan.accel) {
					const speed = spinVelocity(plan, t);
					expect(speed).toBeLessThanOrEqual(previousSpeed + 1e-9);
					previousSpeed = speed;
				}
			}
		}
	});

	it('runs about 8 s for a winner and 3 s for an alternate with a usual list', () => {
		for (const length of [6, 40, 300]) {
			const winner = planSpin({ length, target: 0, kind: 'winner' });
			expect(winner.duration).toBeGreaterThanOrEqual(7);
			expect(winner.duration).toBeLessThanOrEqual(9);
			expect(planSpin({ length, target: 0, kind: 'alternate' }).duration).toBeCloseTo(3, 5);
		}
	});

	it('decelerates smoothly: ease-out continuous with the fast phase', () => {
		const plan = planSpin({ length: 300, target: 5, kind: 'winner' });
		const junction = plan.accel + plan.cruise;
		expect(spinVelocity(plan, junction - 1e-6)).toBeCloseTo(spinVelocity(plan, junction + 1e-6), 2);
		expect(plan.decel).toBeGreaterThanOrEqual(5);
	});

	it('never passes more rows per frame than the window shows, so a paused frame shows readable rows', () => {
		for (const length of [6, 300, 5000]) {
			const plan = planSpin({ length, target: 3, kind: 'winner' });
			expect(plan.velocity / REEL_FRAME_RATE).toBeLessThanOrEqual(REEL_RADIUS);
		}
	});

	it('shows every candidate in the centre window at least once during a winner spin', () => {
		for (const length of [6, 300, 2000]) {
			const plan = planSpin({ length, target: length - 1, kind: 'winner' });
			const seen = new Set<number>();
			for (const t of sample(plan)) for (const row of reelWindow(spinPosition(plan, t), length)) seen.add(row.index);
			expect(seen.size).toBe(length);
		}
	});
});

describe('reel window (virtualized)', () => {
	it('renders a fixed number of rows around the centre, whatever the list length', () => {
		for (const position of [0, 0.5, 12.25, 4999.9]) {
			const rows = reelWindow(position, 5000);
			expect(rows).toHaveLength(2 * REEL_RADIUS + 2);
			expect(rows.some((row) => Math.abs(row.offset) <= 0.5)).toBe(true);
			for (const row of rows) {
				expect(row.offset).toBeCloseTo(row.row - position, 9);
				expect(row.index).toBe(((row.row % 5000) + 5000) % 5000);
			}
		}
	});

	it('wraps around a short list', () => {
		const rows = reelWindow(0, 3);
		expect(rows.map((row) => row.index)).toEqual(rows.map((row) => ((row.row % 3) + 3) % 3));
		expect(new Set(rows.map((row) => row.row)).size).toBe(rows.length);
	});
});

describe('reel order', () => {
	it('shuffles for display only: a permutation, the same for the same seed', () => {
		const order = displayOrder(50, 'a'.repeat(64));
		expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, index) => index));
		expect(displayOrder(50, 'a'.repeat(64))).toEqual(order);
		expect(displayOrder(50, 'b'.repeat(64))).not.toEqual(order);
	});

	const candidates = ['0000', '0001', '0002', '0003', '0004'].map((entryNumber) => ({ entryNumber, maskedName: 'Ju*** P.' }));
	const pick = (entryNumber: string, role: 'winner' | 'alternate', rank = 1): AppDrawPick => ({ prizeId: 'moto', prizeTitle: 'Moto', slot: 1, role, rank, entryNumber, maskedName: 'Ju*** P.' });

	it('spins every candidate still in play and lands on the pick', () => {
		const picks = [pick('0003', 'winner'), pick('0001', 'alternate')];
		const first = reelStrip(candidates, picks, 0, 'c'.repeat(64));
		expect(first.strip).toHaveLength(5);
		expect(first.strip[first.target]!.entryNumber).toBe('0003');
		// An earlier pick cannot win again, so it leaves the reel.
		const second = reelStrip(candidates, picks, 1, 'c'.repeat(64));
		expect(second.strip.map((candidate) => candidate.entryNumber).sort()).toEqual(['0000', '0001', '0002', '0004']);
		expect(second.strip[second.target]!.entryNumber).toBe('0001');
	});
});

describe('labels', () => {
	const winner: AppDrawPick = { prizeId: 'moto', prizeTitle: 'Moto Honda Tornado', slot: 1, role: 'winner', rank: 1, entryNumber: '0342', maskedName: 'Ju*** P.' };

	it('shows a row as the full coupon number and the masked name only', () => {
		expect(rowLabel({ entryNumber: '0342', maskedName: 'Ju*** P.' })).toBe('0342 · Ju*** P.');
	});

	it('names the role of each pick', () => {
		expect(pickRole(winner)).toBe('Ganador');
		expect(pickRole({ ...winner, role: 'alternate', rank: 2 })).toBe('Suplente 2');
	});

	it('announces the result in words', () => {
		expect(pickAnnouncement(winner)).toBe('Ganador del Moto Honda Tornado: cupón 0342, Ju*** P.');
		expect(pickAnnouncement({ ...winner, role: 'alternate', rank: 1, slot: 2 }, true)).toBe('Suplente 1 del Moto Honda Tornado, unidad 2: cupón 0342, Ju*** P.');
	});

	it('announces the spin when it starts, before the result', () => {
		expect(spinAnnouncement(winner)).toBe('Sorteando: Ganador del Moto Honda Tornado.');
		expect(spinAnnouncement({ ...winner, role: 'alternate', rank: 1, slot: 2 }, true)).toBe('Sorteando: Suplente 1 del Moto Honda Tornado, unidad 2.');
	});

	it('shortens the list hash for the screen', () => {
		expect(shortHash('0123456789abcdef'.repeat(4))).toBe('01234567…89abcdef');
	});

	it('explains what the in-app draw does, in the counts of the campaign', () => {
		expect(appDrawSummary(1, 3)).toBe('La Quiniela dejó 1 premio vacante. La plataforma lo sortea entre los 3 cupones sin premio con un número aleatorio criptográfico.');
		expect(appDrawSummary(2, 1)).toBe('La Quiniela dejó 2 premios vacantes. La plataforma los sortea con el único cupón sin premio que queda.');
	});

	it('labels the awards of the in-app draw', () => {
		expect(awardSourceLabel('app_draw')).toBe('Sorteo en la app');
		expect(awardSourceLabel('quiniela')).toBeNull();
		expect(awardSourceLabel('manual')).toBeNull();
		expect(awardSourceLabel(undefined)).toBeNull();
	});
});

// odd/tasks/owner-feedback-2026-11-12.md S3 (T3): a side table lists every pick of the
// run and fills in each one as it lands.
describe('side table', () => {
	it('marks the picks before the current one as done, the current one as spinning and the rest as pending', () => {
		expect([0, 1, 2, 3].map((row) => tallyRowState(row, 1, false))).toEqual(['done', 'current', 'pending', 'pending']);
	});

	it('marks the current pick as done once it lands', () => {
		expect([0, 1, 2, 3].map((row) => tallyRowState(row, 1, true))).toEqual(['done', 'done', 'pending', 'pending']);
		expect(tallyRowState(0, 0, false)).toBe('current');
		expect(tallyRowState(3, 3, true)).toBe('done');
	});

	it('counts the picks already shown', () => {
		expect(tallyProgress(0, 4, false)).toBe('0 de 4');
		expect(tallyProgress(1, 4, true)).toBe('2 de 4');
		expect(tallyProgress(3, 4, true)).toBe('4 de 4');
	});
});

describe('tick sound', () => {
	it('rises in pitch and volume with the reel speed, within a quiet range', () => {
		const slow = tickTone(0.05);
		const fast = tickTone(1);
		expect(fast.frequency).toBeGreaterThan(slow.frequency);
		expect(fast.gain).toBeGreaterThan(slow.gain);
		for (const tone of [slow, fast, tickTone(-1), tickTone(5)]) {
			expect(tone.gain).toBeGreaterThan(0);
			expect(tone.gain).toBeLessThanOrEqual(0.3);
		}
		expect(tickTone(5)).toEqual(tickTone(1));
	});
});
