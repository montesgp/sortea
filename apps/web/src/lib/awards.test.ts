import { describe, expect, it } from 'vitest';
import { fulfillmentOptions, parseEntryNumbers, roleLabel } from './awards';

describe('award form helpers', () => {
	it('reads entry numbers, skipping blank alternates', () => {
		expect(parseEntryNumbers(['17', ' #42 ', ''])).toEqual([17, 42]);
		expect(parseEntryNumbers(['17', 'abc'])).toBeNull();
		expect(parseEntryNumbers(['0'])).toBeNull();
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
