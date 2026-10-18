import { describe, expect, it } from 'vitest';
import { buyerSchema, checkoutRequestSchema } from '../src';

const buyer = {
	documentType: 'DNI',
	documentNumber: '30123456',
	firstName: 'Juana',
	lastName: 'Pérez',
	email: 'juana@example.com',
	province: 'Córdoba',
	city: 'Río Cuarto'
};

function issuePaths(input: unknown): string[] {
	const result = buyerSchema.safeParse(input);
	return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('buyer location (S7, S6)', () => {
	it('accepts a trimmed province and city, typed or chosen', () => {
		const result = buyerSchema.parse({ ...buyer, province: '  Córdoba ', city: '  Río Cuarto  ' });
		expect(result.province).toBe('Córdoba');
		expect(result.city).toBe('Río Cuarto');
		// Any subdivision name is accepted: the list only suggests (S7).
		expect(buyerSchema.parse({ ...buyer, country: 'CL', province: 'Región de Ñuble' }).province).toBe('Región de Ñuble');
	});

	it('requires province and city', () => {
		const { province: _province, city: _city, ...withoutLocation } = buyer;
		expect(issuePaths(withoutLocation).sort()).toEqual(['city', 'province']);
		expect(issuePaths({ ...buyer, province: '', city: '   ' }).sort()).toEqual(['city', 'province']);
	});

	it('bounds the province to 2..80 characters', () => {
		expect(issuePaths({ ...buyer, province: 'A' })).toEqual(['province']);
		expect(issuePaths({ ...buyer, province: 'x'.repeat(80) })).toEqual([]);
		expect(issuePaths({ ...buyer, province: 'x'.repeat(81) })).toEqual(['province']);
	});

	it('takes an optional ISO country, normalized, and rejects anything else', () => {
		expect(buyerSchema.parse(buyer).country).toBeUndefined();
		expect(buyerSchema.parse({ ...buyer, country: ' uy ' }).country).toBe('UY');
		expect(issuePaths({ ...buyer, country: 'Uruguay' })).toEqual(['country']);
		expect(issuePaths({ ...buyer, country: '' })).toEqual(['country']);
	});

	it('bounds the city to 2..80 characters', () => {
		expect(issuePaths({ ...buyer, city: 'A' })).toEqual(['city']);
		expect(issuePaths({ ...buyer, city: 'AB' })).toEqual([]);
		expect(issuePaths({ ...buyer, city: 'x'.repeat(80) })).toEqual([]);
		expect(issuePaths({ ...buyer, city: 'x'.repeat(81) })).toEqual(['city']);
	});

	it('ships only to the buyer city and province', () => {
		const request = (address: Record<string, string>) => ({
			lines: [{ variantId: '00000000-0000-4000-8000-000000000001', quantity: 1 }],
			buyer,
			delivery: { method: 'shipping', address: { street: 'Av. Siempreviva 742', postalCode: '5800', ...address } },
			consents: { terms: true, privacy: true, marketingEmail: false }
		});
		const paths = (input: unknown) => (checkoutRequestSchema.safeParse(input).error?.issues ?? []).map((issue) => issue.path.join('.')).sort();
		expect(paths(request({ city: 'Río Cuarto', province: 'Córdoba' }))).toEqual([]);
		expect(paths(request({ city: ' Río Cuarto ', province: 'Córdoba' }))).toEqual([]);
		expect(paths(request({ city: 'Río Cuarto', province: 'Mendoza' }))).toEqual(['delivery.address.province']);
		expect(paths(request({ city: 'Rosario', province: 'Córdoba' }))).toEqual(['delivery.address.city']);
		expect(paths(request({ city: 'Rosario', province: 'Santa Fe' }))).toEqual(['delivery.address.city', 'delivery.address.province']);
	});

	it('a checkout without the buyer location is rejected', () => {
		const { province: _province, city: _city, ...withoutLocation } = buyer;
		const request = {
			lines: [{ variantId: '00000000-0000-4000-8000-000000000001', quantity: 1 }],
			buyer: withoutLocation,
			delivery: { method: 'digital' },
			consents: { terms: true, privacy: true, marketingEmail: false }
		};
		expect(checkoutRequestSchema.safeParse(request).success).toBe(false);
		expect(checkoutRequestSchema.safeParse({ ...request, buyer }).success).toBe(true);
	});
});
