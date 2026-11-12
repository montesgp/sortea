import { describe, expect, it } from 'vitest';
import { appDrawCandidateText, drawVacantSlots, maskHolderName, type AppDrawSlot } from '../src';

/**
 * ADR 0024: a vacant prize is drawn in the application among the eligible
 * coupons that hold no award. The random index is injected here; the API
 * passes `crypto.randomInt`.
 */

/** Always takes the first remaining candidate, so the expected picks can be read off the list. */
const first = () => 0;
/** Always takes the last remaining candidate. */
const last = (size: number) => size - 1;

const slot = (prizeId: string, number: number, alternatesCount: number): AppDrawSlot => ({ prizeId, slot: number, alternatesCount });
const listed = (picks: ReturnType<typeof drawVacantSlots>) => picks.map((pick) => `${pick.prizeId}#${pick.slot} ${pick.role}${pick.role === 'alternate' ? pick.rank : ''} ${pick.entryNumber}`);

describe('maskHolderName (ADR 0024)', () => {
	it('keeps the first two letters of the first name and the initial of the last name', () => {
		expect(maskHolderName('Juana', 'Pérez')).toBe('Ju*** P.');
		expect(maskHolderName('JUAN CARLOS', 'de la Fuente')).toBe('Ju*** D.');
		expect(maskHolderName('  ángel ', ' ñandú')).toBe('Án*** Ñ.');
	});

	it('never shows more than it has, and nothing but letters', () => {
		expect(maskHolderName('J', 'P')).toBe('J*** P.');
		expect(maskHolderName("O'Neil", 'Smith')).toBe('On*** S.');
		expect(maskHolderName('Ana', '')).toBe('An***');
		expect(maskHolderName('', '')).toBe('***');
		expect(maskHolderName('42', '7')).toBe('***');
	});
});

describe('appDrawCandidateText (ADR 0024)', () => {
	it('lists the coupons ascending, zero-padded, one per line, without a final newline', () => {
		expect(appDrawCandidateText([12, 3, 7], 4)).toBe('0003\n0007\n0012');
		expect(appDrawCandidateText([5], 6)).toBe('000005');
	});
});

describe('drawVacantSlots (ADR 0024)', () => {
	it('picks every winner in slot order first, then each slot its alternates, never the same coupon twice', () => {
		const picks = drawVacantSlots({ slots: [slot('moto', 1, 2), slot('cash', 1, 1), slot('cash', 2, 0)], candidates: [9, 2, 5, 7, 4, 8], randomIndex: first });
		expect(listed(picks)).toEqual(['moto#1 winner 2', 'cash#1 winner 4', 'cash#2 winner 5', 'moto#1 alternate1 7', 'moto#1 alternate2 8', 'cash#1 alternate1 9']);
		expect(new Set(picks.map((pick) => pick.entryNumber)).size).toBe(picks.length);
		expect(picks.map((pick) => pick.rank)).toEqual([1, 1, 1, 1, 2, 1]);
	});

	it('draws from what remains: the index points into the coupons not picked yet, ascending', () => {
		const picks = drawVacantSlots({ slots: [slot('moto', 1, 1)], candidates: [1, 2, 3], randomIndex: last });
		expect(listed(picks)).toEqual(['moto#1 winner 3', 'moto#1 alternate1 2']);
	});

	it('stops when the coupons run out: winners first, so a later slot is never left for an earlier alternate', () => {
		expect(listed(drawVacantSlots({ slots: [slot('moto', 1, 2), slot('cash', 1, 1)], candidates: [4, 6], randomIndex: first }))).toEqual(['moto#1 winner 4', 'cash#1 winner 6']);
		expect(listed(drawVacantSlots({ slots: [slot('moto', 1, 2), slot('cash', 1, 1)], candidates: [4], randomIndex: first }))).toEqual(['moto#1 winner 4']);
		expect(drawVacantSlots({ slots: [slot('moto', 1, 2)], candidates: [], randomIndex: first })).toEqual([]);
	});

	it('asks for an index below the size of what remains and refuses one outside it', () => {
		const sizes: number[] = [];
		drawVacantSlots({ slots: [slot('moto', 1, 2)], candidates: [1, 2, 3, 4], randomIndex: (size) => (sizes.push(size), 0) });
		expect(sizes).toEqual([4, 3, 2]);
		expect(() => drawVacantSlots({ slots: [slot('moto', 1, 0)], candidates: [1, 2], randomIndex: () => 2 })).toThrow(/random index/);
		expect(() => drawVacantSlots({ slots: [slot('moto', 1, 0)], candidates: [1, 2], randomIndex: () => 0.5 })).toThrow(/random index/);
	});

	it('gives every candidate the same chance with a uniform index', () => {
		// A deterministic linear congruential generator stands in for crypto.randomInt.
		let state = 12_345;
		const uniform = (size: number) => {
			state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
			return Math.floor((state / 2 ** 32) * size);
		};
		const wins = new Map<number, number>();
		const runs = 20_000;
		for (let run = 0; run < runs; run++) {
			const [winner] = drawVacantSlots({ slots: [slot('moto', 1, 0)], candidates: [0, 1, 2, 3, 4], randomIndex: uniform });
			wins.set(winner!.entryNumber, (wins.get(winner!.entryNumber) ?? 0) + 1);
		}
		// Chi-square with 4 degrees of freedom stays below 18.47 (p = 0.001) for a fair draw.
		const expected = runs / 5;
		const chiSquare = [0, 1, 2, 3, 4].reduce((sum, number) => sum + ((wins.get(number) ?? 0) - expected) ** 2 / expected, 0);
		expect(chiSquare).toBeLessThan(18.47);
	});
});
