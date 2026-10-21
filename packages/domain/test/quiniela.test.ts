import { describe, expect, it } from 'vitest';
import { matchQuinielaDraw, quinielaConfirmInputSchema, quinielaDigestPayload, quinielaDrawInputSchema, vacantQuinielaSlots, type QuinielaPrize } from '../src';

/**
 * ADR 0014 §4: the 20 extracts are read in order; matches fill the `quiniela`
 * slots in prize order, leftovers fill the alternates, nothing is random.
 */
const prize = (id: string, position: number, quantity: number, alternatesCount: number, mechanism: 'quiniela' | 'manual' = 'quiniela'): QuinielaPrize => ({
	id,
	position,
	quantity,
	alternatesCount,
	mechanism
});

/** Coupons 0..n-1 are eligible; `voided` are in the manifest but void. */
const manifest = (count: number, voided: number[] = []) => (entryNumber: number) =>
	entryNumber < count ? (voided.includes(entryNumber) ? ('void' as const) : ('eligible' as const)) : null;

/** Pads the extracts to the official 20 with numbers nobody holds. */
const twenty = (...head: number[]) => [...head, ...Array.from({ length: 20 - head.length }, (_, index) => 9_000 + index)];

const winners = (result: ReturnType<typeof matchQuinielaDraw>) => result.slots.map((slot) => [slot.prizeId, slot.slot, slot.winner?.entryNumber ?? null]);
const alternates = (result: ReturnType<typeof matchQuinielaDraw>) =>
	result.slots.map((slot) => [slot.prizeId, slot.slot, slot.alternates.map((alternate) => [alternate.rank, alternate.entryNumber, alternate.extract])]);

describe('matchQuinielaDraw (ADR 0014 §4)', () => {
	it('fills the quiniela slots in prize position, then slot order, with the matches in extract order', () => {
		const result = matchQuinielaDraw({
			// Listed out of position on purpose: position decides, not input order.
			prizes: [prize('cash', 2, 2, 0), prize('moto', 1, 1, 0)],
			extracts: twenty(40, 12, 7),
			manifestStatus: manifest(50),
			awarded: new Set()
		});
		expect(winners(result)).toEqual([
			['moto', 1, 40],
			['cash', 1, 12],
			['cash', 2, 7]
		]);
		expect(result.slots[0]!.winner).toEqual({ entryNumber: 40, extract: 1 });
		expect(result.vacant).toEqual([]);
		expect(result.extracts.slice(0, 4)).toEqual([
			{ position: 1, number: 40, outcome: 'winner', prizeId: 'moto', slot: 1, rank: null },
			{ position: 2, number: 12, outcome: 'winner', prizeId: 'cash', slot: 1, rank: null },
			{ position: 3, number: 7, outcome: 'winner', prizeId: 'cash', slot: 2, rank: null },
			{ position: 4, number: 9_000, outcome: 'no_match', prizeId: null, slot: null, rank: null }
		]);
	});

	it('fills alternates from the leftover matches, slot by slot, up to each prize alternatesCount', () => {
		const result = matchQuinielaDraw({
			prizes: [prize('moto', 1, 1, 2), prize('cash', 2, 2, 1)],
			extracts: twenty(1, 2, 3, 4, 5, 6, 7, 8),
			manifestStatus: manifest(50),
			awarded: new Set()
		});
		expect(winners(result)).toEqual([
			['moto', 1, 1],
			['cash', 1, 2],
			['cash', 2, 3]
		]);
		expect(alternates(result)).toEqual([
			['moto', 1, [[1, 4, 4], [2, 5, 5]]],
			['cash', 1, [[1, 6, 6]]],
			['cash', 2, [[1, 7, 7]]]
		]);
		// A match with no slot left to fill is reported, not used.
		expect(result.extracts[7]).toMatchObject({ position: 8, number: 8, outcome: 'spare', prizeId: null });
		expect(result.extracts[3]).toMatchObject({ outcome: 'alternate', prizeId: 'moto', slot: 1, rank: 1 });
	});

	it('skips repeated extracts and coupons already awarded in the campaign', () => {
		const result = matchQuinielaDraw({
			prizes: [prize('moto', 1, 1, 1), prize('cash', 2, 1, 0)],
			extracts: twenty(9, 9, 15, 3),
			manifestStatus: manifest(50),
			// Coupon 15 already won a manual prize.
			awarded: new Set([15])
		});
		expect(winners(result)).toEqual([
			['moto', 1, 9],
			['cash', 1, 3]
		]);
		expect(result.slots[0]!.alternates).toEqual([]);
		expect(result.extracts.slice(0, 4).map((extract) => extract.outcome)).toEqual(['winner', 'repeated', 'already_awarded', 'winner']);
	});

	it('does not match coupons outside the manifest or void in it', () => {
		const result = matchQuinielaDraw({
			prizes: [prize('moto', 1, 1, 0)],
			extracts: twenty(60, 4, 5),
			manifestStatus: manifest(50, [4]),
			awarded: new Set()
		});
		expect(result.extracts.slice(0, 3).map((extract) => extract.outcome)).toEqual(['no_match', 'no_match', 'winner']);
		expect(winners(result)).toEqual([['moto', 1, 5]]);
	});

	it('reports slots without a match as vacant', () => {
		const result = matchQuinielaDraw({
			prizes: [prize('moto', 1, 1, 2), prize('cash', 2, 3, 1)],
			extracts: twenty(11, 22),
			manifestStatus: manifest(30),
			awarded: new Set()
		});
		expect(winners(result)).toEqual([
			['moto', 1, 11],
			['cash', 1, 22],
			['cash', 2, null],
			['cash', 3, null]
		]);
		expect(result.vacant).toEqual([
			{ prizeId: 'cash', slot: 2 },
			{ prizeId: 'cash', slot: 3 }
		]);
		expect(result.slots.every((slot) => slot.alternates.length === 0)).toBe(true);
	});

	it('lets one person win several prizes with different coupons: every coupon is independent', () => {
		// Coupons 20 and 21 belong to the same buyer; matching only sees coupons.
		const result = matchQuinielaDraw({
			prizes: [prize('moto', 1, 1, 0), prize('cash', 2, 1, 0)],
			extracts: twenty(20, 21),
			manifestStatus: manifest(30),
			awarded: new Set()
		});
		expect(winners(result)).toEqual([
			['moto', 1, 20],
			['cash', 1, 21]
		]);
	});

	it('ignores manual prizes: they keep their manual entry', () => {
		const result = matchQuinielaDraw({
			prizes: [prize('kit', 1, 5, 1, 'manual'), prize('moto', 2, 1, 0)],
			extracts: twenty(3, 4),
			manifestStatus: manifest(10),
			awarded: new Set()
		});
		expect(result.slots.map((slot) => slot.prizeId)).toEqual(['moto']);
		expect(winners(result)).toEqual([['moto', 1, 3]]);
		expect(result.extracts[1]).toMatchObject({ number: 4, outcome: 'spare' });
	});

	it('matches extract 0000 to coupon 0000', () => {
		const result = matchQuinielaDraw({ prizes: [prize('moto', 1, 1, 0)], extracts: twenty(0), manifestStatus: manifest(5), awarded: new Set() });
		expect(winners(result)).toEqual([['moto', 1, 0]]);
	});

	it('assigns each coupon to at most one slot, even across roles', () => {
		const result = matchQuinielaDraw({
			prizes: [prize('moto', 1, 2, 3)],
			extracts: [5, 6, 5, 6, 7, 5, 8, 9, 10, 11, 12, 13, 14, 5, 6, 7, 8, 9, 10, 11],
			manifestStatus: manifest(20),
			awarded: new Set()
		});
		const used = result.slots.flatMap((slot) => [slot.winner?.entryNumber, ...slot.alternates.map((alternate) => alternate.entryNumber)]);
		expect(new Set(used).size).toBe(used.length);
		expect(winners(result)).toEqual([
			['moto', 1, 5],
			['moto', 2, 6]
		]);
		expect(alternates(result)).toEqual([
			['moto', 1, [[1, 7, 5], [2, 8, 7], [3, 9, 8]]],
			['moto', 2, [[1, 10, 9], [2, 11, 10], [3, 12, 11]]]
		]);
	});

	it('leaves slots that already have a winner alone', () => {
		const result = matchQuinielaDraw({
			prizes: [{ ...prize('cash', 1, 2, 0), filledSlots: [1] }],
			extracts: twenty(3),
			manifestStatus: manifest(10),
			awarded: new Set()
		});
		expect(winners(result)).toEqual([['cash', 2, 3]]);
		expect(result.vacant).toEqual([]);
	});
});

describe('quinielaDrawInputSchema', () => {
	const valid = { source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00.000Z', extracts: twenty(0, 9_999), evidenceUrl: 'https://example.com/extracto.pdf' };

	it('accepts the source, the instant of the draw, 20 extracts within 0000-9999 and an https evidence link', () => {
		expect(quinielaDrawInputSchema.parse(valid)).toEqual({ ...valid, drawnAt: new Date('2026-11-30T00:00:00Z') });
	});

	it('refuses anything but exactly 20 extracts of 4 digits', () => {
		expect(quinielaDrawInputSchema.safeParse({ ...valid, extracts: valid.extracts.slice(1) }).success).toBe(false);
		expect(quinielaDrawInputSchema.safeParse({ ...valid, extracts: [...valid.extracts, 1] }).success).toBe(false);
		expect(quinielaDrawInputSchema.safeParse({ ...valid, extracts: twenty(10_000) }).success).toBe(false);
		expect(quinielaDrawInputSchema.safeParse({ ...valid, extracts: twenty(-1) }).success).toBe(false);
		expect(quinielaDrawInputSchema.safeParse({ ...valid, extracts: twenty(1.5) }).success).toBe(false);
	});

	it('requires an https evidence link and a real date', () => {
		expect(quinielaDrawInputSchema.safeParse({ ...valid, evidenceUrl: 'http://example.com/x' }).success).toBe(false);
		expect(quinielaDrawInputSchema.safeParse({ ...valid, drawnAt: '30/11/2026' }).success).toBe(false);
		expect(quinielaDrawInputSchema.safeParse({ ...valid, drawnAt: undefined }).success).toBe(false);
		expect(quinielaDrawInputSchema.safeParse({ ...valid, source: ' ' }).success).toBe(false);
	});
});

describe('quiniela confirmation digest (ADR 0014 §4)', () => {
	const input = { source: 'Quiniela de la Ciudad, Nocturna', drawnAt: new Date('2026-11-30T00:00:00Z'), extracts: twenty(1, 2), evidenceUrl: 'https://example.com/x.pdf' };
	const run = (awarded: number[]) => matchQuinielaDraw({ prizes: [prize('moto', 1, 1, 0)], extracts: input.extracts, manifestStatus: manifest(10), awarded: new Set(awarded) });

	it('changes when the result or the recorded data change, and only then', () => {
		const base = quinielaDigestPayload(input, run([]));
		expect(quinielaDigestPayload({ ...input }, run([]))).toBe(base);
		// Coupon 1 won something else in between: the moto now goes to coupon 2.
		expect(quinielaDigestPayload(input, run([1]))).not.toBe(base);
		expect(quinielaDigestPayload({ ...input, source: 'Otra' }, run([]))).not.toBe(base);
		expect(quinielaDigestPayload({ ...input, drawnAt: new Date('2026-11-30T00:01:00Z') }, run([]))).not.toBe(base);
	});

	it('is required, as 64 hex characters, to confirm', () => {
		const body = { ...input, drawnAt: input.drawnAt.toISOString() };
		expect(quinielaConfirmInputSchema.safeParse(body).success).toBe(false);
		expect(quinielaConfirmInputSchema.safeParse({ ...body, digest: 'x' }).success).toBe(false);
		expect(quinielaConfirmInputSchema.safeParse({ ...body, digest: 'a'.repeat(64) }).success).toBe(true);
	});
});

describe('prize order tie-break', () => {
	it('orders prizes sharing a position by creation, then id, whatever the input order', () => {
		const older = { ...prize('zeta', 1, 1, 0), createdAt: new Date('2026-01-01') };
		const newer = { ...prize('alfa', 1, 1, 0), createdAt: new Date('2026-01-02') };
		for (const prizes of [
			[older, newer],
			[newer, older]
		]) {
			const result = matchQuinielaDraw({ prizes, extracts: twenty(1, 2), manifestStatus: manifest(10), awarded: new Set() });
			expect(winners(result)).toEqual([
				['zeta', 1, 1],
				['alfa', 1, 2]
			]);
		}
		const sameTime = new Date('2026-01-01');
		for (const order of [
			['b', 'a'],
			['a', 'b']
		]) {
			const prizes = order.map((id) => ({ ...prize(id, 1, 1, 0), createdAt: sameTime }));
			const result = matchQuinielaDraw({ prizes, extracts: twenty(1, 2), manifestStatus: manifest(10), awarded: new Set() });
			expect(winners(result)).toEqual([
				['a', 1, 1],
				['b', 1, 2]
			]);
		}
	});
});

describe('verification probes', () => {
	it('all miss: every slot vacant, no alternates', () => {
		const result = matchQuinielaDraw({ prizes: [prize('moto', 1, 1, 2), prize('cash', 2, 3, 1)], extracts: twenty(), manifestStatus: manifest(100), awarded: new Set() });
		expect(result.vacant).toHaveLength(4);
		expect(result.slots.every((slot) => slot.winner === null && slot.alternates.length === 0)).toBe(true);
		expect(result.extracts.every((extract) => extract.outcome === 'no_match')).toBe(true);
	});

	it('20 matches with 1 slot and 2 alternates leave 17 spare', () => {
		const extracts = Array.from({ length: 20 }, (_, index) => index);
		const result = matchQuinielaDraw({ prizes: [prize('moto', 1, 1, 2)], extracts, manifestStatus: manifest(100), awarded: new Set() });
		expect(result.extracts.map((extract) => extract.outcome)).toEqual(['winner', 'alternate', 'alternate', ...Array<string>(17).fill('spare')]);
	});

	it('the same number 20 times gives one winner and 19 repeats', () => {
		const result = matchQuinielaDraw({ prizes: [prize('moto', 1, 1, 2), prize('cash', 2, 1, 0)], extracts: Array<number>(20).fill(7), manifestStatus: manifest(10), awarded: new Set() });
		expect(winners(result)).toEqual([
			['moto', 1, 7],
			['cash', 1, null]
		]);
		expect(result.extracts.filter((extract) => extract.outcome === 'repeated')).toHaveLength(19);
	});

	it('checks void, then awarded, then repeated, in that order', () => {
		// 4 is void and awarded: void wins. 5 is awarded: awarded the first time, repeated after.
		const result = matchQuinielaDraw({ prizes: [prize('moto', 1, 1, 0)], extracts: twenty(4, 5, 5, 4), manifestStatus: manifest(10, [4]), awarded: new Set([4, 5]) });
		expect(result.extracts.slice(0, 4).map((extract) => extract.outcome)).toEqual(['no_match', 'already_awarded', 'repeated', 'repeated']);
	});

	it('a prize with no alternates passes the leftovers to the next prize', () => {
		const result = matchQuinielaDraw({ prizes: [prize('moto', 1, 1, 0), prize('cash', 2, 1, 2)], extracts: twenty(1, 2, 3, 4), manifestStatus: manifest(10), awarded: new Set() });
		expect(alternates(result)).toEqual([
			['moto', 1, []],
			['cash', 1, [[1, 3, 3], [2, 4, 4]]]
		]);
	});

	it('a manual prize between two quiniela prizes takes no slot', () => {
		const result = matchQuinielaDraw({
			prizes: [prize('moto', 1, 1, 0), prize('kit', 2, 3, 1, 'manual'), prize('cash', 3, 1, 0)],
			extracts: twenty(1, 2),
			manifestStatus: manifest(10),
			awarded: new Set()
		});
		expect(winners(result)).toEqual([
			['moto', 1, 1],
			['cash', 1, 2]
		]);
	});

	it('1000 units get at most 20 winners', () => {
		const extracts = Array.from({ length: 20 }, (_, index) => index * 3);
		const result = matchQuinielaDraw({ prizes: [prize('cash', 1, 1000, 1)], extracts, manifestStatus: manifest(10_000), awarded: new Set() });
		expect(result.slots.filter((slot) => slot.winner)).toHaveLength(20);
		expect(result.vacant).toHaveLength(980);
		expect(result.slots.every((slot) => slot.alternates.length === 0)).toBe(true);
	});

	it('keeps its invariants over 500 seeded random draws', () => {
		// mulberry32: deterministic, so a failure is reproducible.
		let seed = 20_261_021;
		const random = () => {
			seed = (seed + 0x6d2b79f5) | 0;
			let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
			return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
		};
		const int = (max: number) => Math.floor(random() * (max + 1));
		for (let run = 0; run < 500; run++) {
			const prizes = Array.from({ length: 1 + int(3) }, (_, index) => prize(`p${index}`, 1 + int(3), 1 + int(4), int(3), random() < 0.25 ? 'manual' : 'quiniela'));
			const voided = Array.from({ length: int(5) }, () => int(60));
			const status = manifest(int(60), voided);
			const awarded = new Set(Array.from({ length: int(5) }, () => int(60)));
			const extracts = Array.from({ length: 20 }, () => int(80));
			const result = matchQuinielaDraw({ prizes, extracts, manifestStatus: status, awarded });

			const seen = new Set<number>();
			const matches: number[] = [];
			for (const number of extracts) {
				if (seen.has(number)) continue;
				seen.add(number);
				if (status(number) === 'eligible' && !awarded.has(number)) matches.push(number);
			}
			const k = Math.min(matches.length, result.slots.length);
			const cap = (prizeId: string) => prizes.find((candidate) => candidate.id === prizeId)!.alternatesCount;
			expect(result.slots.slice(0, k).map((slot) => slot.winner?.entryNumber), `run ${run}`).toEqual(matches.slice(0, k));
			expect(result.slots.slice(k).every((slot) => slot.winner === null), `run ${run}`).toBe(true);
			const used = result.slots.flatMap((slot) => [...(slot.winner ? [slot.winner.entryNumber] : []), ...slot.alternates.map((alternate) => alternate.entryNumber)]);
			expect(new Set(used).size, `run ${run}`).toBe(used.length);
			for (const slot of result.slots) {
				expect(slot.alternates.length, `run ${run}`).toBeLessThanOrEqual(cap(slot.prizeId));
				if (!slot.winner) expect(slot.alternates, `run ${run}`).toEqual([]);
			}
			const seats = result.slots.filter((slot) => slot.winner).reduce((sum, slot) => sum + cap(slot.prizeId), 0);
			expect(result.slots.flatMap((slot) => slot.alternates.map((alternate) => alternate.entryNumber)), `run ${run}`).toEqual(matches.slice(k, k + seats));
		}
	});
});

describe('vacant quiniela units per round (ADR 0014 §5)', () => {
	const prizes = [
		{ id: 'moto', mechanism: 'quiniela' as const, quantity: 1 },
		{ id: 'cash', mechanism: 'quiniela' as const, quantity: 2 },
		{ id: 'kit', mechanism: 'manual' as const, quantity: 1 }
	];
	const winners = [
		{ prizeId: 'cash', slot: 1, round: 1 },
		{ prizeId: 'moto', slot: 1, round: 2 }
	];
	const units = (through?: number) => vacantQuinielaSlots(prizes, winners, through).map(({ prize, slot }) => `${prize.id}#${slot}`);

	it('lists quiniela units without a winner, never manual ones', () => {
		expect(units()).toEqual(['cash#2']);
	});

	it('counts only the winners recorded up to the given round', () => {
		expect(units(1)).toEqual(['moto#1', 'cash#2']);
		expect(units(2)).toEqual(['cash#2']);
	});
});
