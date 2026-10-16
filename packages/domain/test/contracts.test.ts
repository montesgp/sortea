import { describe, expect, it } from 'vitest';
import { argentineProvinces, buyerSchema, checkoutRequestSchema } from '../src';

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

describe('buyer location (S7)', () => {
	it('lists the 24 Argentine jurisdictions', () => {
		expect(argentineProvinces).toHaveLength(24);
		expect(argentineProvinces).toContain('Ciudad Autónoma de Buenos Aires');
		expect(argentineProvinces).toContain('Tierra del Fuego');
	});

	it('accepts a province from the list and a trimmed city', () => {
		const result = buyerSchema.parse({ ...buyer, city: '  Río Cuarto  ' });
		expect(result.province).toBe('Córdoba');
		expect(result.city).toBe('Río Cuarto');
	});

	it('requires province and city', () => {
		const { province: _province, city: _city, ...withoutLocation } = buyer;
		expect(issuePaths(withoutLocation).sort()).toEqual(['city', 'province']);
		expect(issuePaths({ ...buyer, province: '', city: '   ' }).sort()).toEqual(['city', 'province']);
	});

	it('rejects a province outside the list', () => {
		expect(issuePaths({ ...buyer, province: 'Narnia' })).toEqual(['province']);
		expect(issuePaths({ ...buyer, province: 'cordoba' })).toEqual(['province']);
	});

	it('bounds the city to 2..80 characters', () => {
		expect(issuePaths({ ...buyer, city: 'A' })).toEqual(['city']);
		expect(issuePaths({ ...buyer, city: 'AB' })).toEqual([]);
		expect(issuePaths({ ...buyer, city: 'x'.repeat(80) })).toEqual([]);
		expect(issuePaths({ ...buyer, city: 'x'.repeat(81) })).toEqual(['city']);
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
