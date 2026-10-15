import { describe, expect, it } from 'vitest';
import { cardChances, cardChancesText, chancesText } from './chances';

describe('chances copy', () => {
	it('counts chances in es-AR', () => {
		expect(chancesText(1)).toBe('1 chance');
		expect(chancesText(6)).toBe('6 chances');
	});

	const chances = { campaign: { slug: 'moto', title: 'Moto 0 km' }, perUnit: { manual: 3, tapa: 3, remera: 1, buzo: 2 }, maxPerIdentity: null };

	it('shows on a card only what the locked rules grant for the product variants', () => {
		expect(cardChances(chances, ['manual'])).toEqual({ count: 3, upTo: false, campaign: 'Moto 0 km' });
		expect(cardChances(chances, ['sticker'])).toBeNull();
		expect(cardChances(chances, [])).toBeNull();
		expect(cardChances(null, ['manual'])).toBeNull();
	});

	it('words equal chances plainly and different ones as a maximum, ignoring variants that grant none', () => {
		expect(cardChancesText(cardChances(chances, ['manual', 'tapa', 'sticker'])!)).toBe('Suma 3 chances para Moto 0 km');
		expect(cardChancesText(cardChances(chances, ['remera', 'buzo', 'sticker'])!)).toBe('Suma hasta 2 chances para Moto 0 km');
		expect(cardChancesText(cardChances(chances, ['remera'])!)).toBe('Suma 1 chance para Moto 0 km');
	});
});
