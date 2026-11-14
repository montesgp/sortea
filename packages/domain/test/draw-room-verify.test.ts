import { describe, expect, it } from 'vitest';
import { appDrawableUnits, drawAppUnit, matchQuinielaDraw } from '../src';

// Independent verification probes of odd/tasks/draw-room.md (S4 award order, S4/S5 per-unit draw).
const prizes = [
	{ id: 'moto', mechanism: 'quiniela' as const, position: 1, quantity: 1, alternatesCount: 1 },
	{ id: 'cash', mechanism: 'quiniela' as const, position: 2, quantity: 2, alternatesCount: 0 },
	{ id: 'service', mechanism: 'quiniela' as const, position: 3, quantity: 1, alternatesCount: 0 },
	{ id: 'kit', mechanism: 'manual' as const, position: 4, quantity: 1, alternatesCount: 0 }
];
const eligible = (n: number) => (n < 100 ? 'eligible' : null);

describe('award order (S4)', () => {
	it('last_to_first: service, cash 1, cash 2, moto, then the moto alternate', () => {
		const m = matchQuinielaDraw({ extracts: [9999, 10, 11, 10, 12, 13, 14, 15], prizes, manifestStatus: eligible, awarded: new Set(), awardOrder: 'last_to_first' });
		expect(m.slots.map((s) => [s.prizeId, s.slot, s.winner?.entryNumber ?? null])).toEqual([
			['service', 1, 10],
			['cash', 1, 11],
			['cash', 2, 12],
			['moto', 1, 13]
		]);
		expect(m.slots.find((s) => s.prizeId === 'moto')!.alternates.map((a) => a.entryNumber)).toEqual([14]);
		expect(m.extracts[3]!.outcome).toBe('repeated');
		expect(m.extracts.at(-1)!.outcome).toBe('spare');
	});

	it('the default equals first_to_last', () => {
		const input = { extracts: [10, 11, 12, 13, 14], prizes, manifestStatus: eligible, awarded: new Set<number>() };
		expect(matchQuinielaDraw(input)).toEqual(matchQuinielaDraw({ ...input, awardOrder: 'first_to_last' }));
	});

	it('awarded and void coupons never match', () => {
		const m = matchQuinielaDraw({ extracts: [10, 50, 11], prizes, manifestStatus: (n) => (n === 50 ? 'void' : eligible(n)), awarded: new Set([10]), awardOrder: 'last_to_first' });
		expect(m.extracts.map((e) => e.outcome)).toEqual(['already_awarded', 'no_match', 'winner']);
	});
});

describe('per-unit draw (S4, S5)', () => {
	it('drawAppUnit dedupes and sorts; an empty pool is null; a bad index throws', () => {
		expect(drawAppUnit({ candidates: [5, 3, 3, 9], randomIndex: () => 0 })).toBe(3);
		expect(drawAppUnit({ candidates: [5, 3, 3, 9], randomIndex: (n) => n - 1 })).toBe(9);
		expect(drawAppUnit({ candidates: [], randomIndex: () => 0 })).toBeNull();
		expect(() => drawAppUnit({ candidates: [1], randomIndex: () => 1 })).toThrow(RangeError);
		expect(() => drawAppUnit({ candidates: [1, 2], randomIndex: () => 0.5 })).toThrow(RangeError);
	});

	it('only exhausted or vacant Quiniela units; never one held by an alternate, a manual one or a void one', () => {
		const a = (id: string, prizeId: string, role: 'winner' | 'alternate', status: 'declined' | 'pending_verification' | 'void' | 'accepted') => ({
			id,
			prizeId,
			slot: 1,
			role,
			rank: 1,
			status,
			fulfillmentStatus: null
		});
		const units = appDrawableUnits(
			prizes,
			[a('1', 'moto', 'winner', 'declined'), a('2', 'moto', 'alternate', 'pending_verification'), a('3', 'cash', 'winner', 'void'), a('4', 'service', 'winner', 'accepted')],
			[{ prizeId: 'cash', slot: 2 }]
		);
		expect(units.map((u) => [u.prize.id, u.slot, u.state])).toEqual([['cash', 1, 'exhausted']]);
	});
});
