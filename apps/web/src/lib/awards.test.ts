import { describe, expect, it } from 'vitest';
import { deliveredLabel, fulfillmentOptions, parseEntryNumbers, roleLabel, WINNER_IDENTITY_WITHHELD, winnerIdentityLabel } from './awards';

describe('award form helpers', () => {
	it('reads entry numbers, skipping blank alternates', () => {
		expect(parseEntryNumbers(['17', ' #42 ', ''])).toEqual([17, 42]);
		expect(parseEntryNumbers(['17', 'abc'])).toBeNull();
		// Coupons start at 0000 and are typed as shown (ADR 0014 §1); the API bounds them by the pool.
		expect(parseEntryNumbers(['0', '0042', 'N.º 0007'])).toEqual([0, 42, 7]);
		expect(parseEntryNumbers(['-1'])).toBeNull();
	});

	it('offers only the delivery steps the API accepts', () => {
		expect(fulfillmentOptions('pending')).toEqual(['scheduled', 'delivered', 'failed']);
		expect(fulfillmentOptions('failed')).toEqual(['scheduled', 'pending']);
		expect(fulfillmentOptions('delivered')).toEqual([]);
	});

	it('names each place in the alternate order', () => {
		expect(roleLabel('winner', 1)).toBe('Ganador');
		expect(roleLabel('alternate', 2)).toBe('Suplente 2');
	});
});

describe('public winners table (S5)', () => {
	it('names a consenting winner with city and chances', () => {
		expect(winnerIdentityLabel({ name: 'Ana Ganadora', city: 'Zapala', chances: 3 })).toBe('Ana Ganadora, de Zapala, con 3 chances');
		expect(winnerIdentityLabel({ name: 'Ana Ganadora', city: null, chances: 1 })).toBe('Ana Ganadora, con 1 chance');
	});

	it('says the winner reserved their identity otherwise', () => {
		expect(winnerIdentityLabel(null)).toBe('El ganador se reservó el derecho de no mostrar su identidad');
		expect(WINNER_IDENTITY_WITHHELD).toBe('El ganador se reservó el derecho de no mostrar su identidad');
	});

	it('counts the delivered units of a prize', () => {
		expect(deliveredLabel(0, 1)).toBe('0 de 1 entregado');
		expect(deliveredLabel(2, 5)).toBe('2 de 5 entregados');
	});
});
