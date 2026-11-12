import { describe, expect, it } from 'vitest';
import { drawVacantSlots, maskHolderName } from '../src';

/** Verifier probes (ADR 0024 §5, L14): masking never leaks more than two letters and an initial. */
describe('maskHolderName probes', () => {
	it('handles emojis, decomposed accents, leading spaces and a full name typed in the first name', () => {
		expect(maskHolderName('😀Ana', '🙂Pérez')).toBe('An*** P.');
		expect(maskHolderName('🙂', '🙂')).toBe('***');
		expect(maskHolderName('Ángel', 'Ñañez')).toBe('Án*** Ñ.');
		expect(maskHolderName('   lu', '   de la Cruz')).toBe('Lu*** D.');
		expect(maskHolderName('Juan Pérez', '')).toBe('Ju***');
		expect(maskHolderName('José-María', 'Gómez')).toBe('Jo*** G.');
		expect(maskHolderName('Ñ', 'ñ')).toBe('Ñ*** Ñ.');
		expect(maskHolderName('ab12cd', 'x')).toBe('Ab*** X.');
	});

	it('never contains three consecutive letters of the first name or two of the last name', () => {
		const names: [string, string][] = [
			['Juana', 'Pérez'],
			['MARÍA JOSÉ', 'FERNÁNDEZ'],
			[' Ö', 'Ñáñez'],
			['Zoë', "O'Brien"]
		];
		for (const [first, last] of names) {
			const masked = maskHolderName(first, last);
			expect(masked).toMatch(/^\p{L}{0,2}\*\*\*( \p{Lu}\.)?$/u);
		}
	});
});

describe('drawVacantSlots probes', () => {
	it('dedupes repeated candidates so a coupon never gets two seats', () => {
		const picks = drawVacantSlots({ slots: [{ prizeId: 'a', slot: 1, alternatesCount: 3 }], candidates: [5, 5, 5, 6], randomIndex: () => 0 });
		expect(picks.map((pick) => pick.entryNumber)).toEqual([5, 6]);
	});
});
