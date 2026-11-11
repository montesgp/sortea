import { describe, expect, it } from 'vitest';
import { buyerSchema, checkoutRequestSchema, PHONE_INVALID, PHONE_REQUIRED } from '../src';

const buyer = {
	documentType: 'DNI',
	documentNumber: '30123456',
	firstName: 'Juana',
	lastName: 'Pérez',
	email: 'juana@example.com',
	phone: '+54 9 11 2345-6789',
	province: 'Córdoba',
	city: 'Río Cuarto'
};

function issuePaths(input: unknown): string[] {
	const result = buyerSchema.safeParse(input);
	return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

function phoneIssues(input: unknown): { path: string; message: string }[] {
	const result = buyerSchema.safeParse(input);
	return result.success ? [] : result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

// Owner feedback 2026-11-10 S8: the phone is required, because it is how the organization tells a winner.
describe('buyer phone (owner feedback 2026-11-10 S8)', () => {
	it('requires a phone, saying why, when it is missing, empty or blank', () => {
		const { phone: _phone, ...withoutPhone } = buyer;
		for (const input of [withoutPhone, { ...buyer, phone: '' }, { ...buyer, phone: '   ' }, { ...buyer, phone: null }]) {
			expect(phoneIssues(input)).toEqual([{ path: 'phone', message: PHONE_REQUIRED }]);
		}
		expect(PHONE_REQUIRED).toBe('Ingresá tu teléfono: lo usamos para avisarte si ganás');
	});

	it('accepts the Argentine and international formats it accepted before, trimmed', () => {
		for (const phone of ['+54 9 11 2345-6789', '011 4567-8901', '(0351) 456-7890', '3515551234', '+1 (415) 555-0100', '+598 99 123 456']) {
			expect(buyerSchema.parse({ ...buyer, phone }).phone, phone).toBe(phone);
		}
		expect(buyerSchema.parse({ ...buyer, phone: '  +54 9 11 2345-6789 ' }).phone).toBe('+54 9 11 2345-6789');
	});

	it('refuses a phone with letters or outside 8..20 characters, with its own message', () => {
		for (const phone of ['llamame', '1234567', '--------', '(((())))', '+54 (11) 234', '+54 9 11 2345-6789 int 2', '1'.repeat(21), '+54 9 11 2345.6789']) {
			expect(phoneIssues({ ...buyer, phone }), phone).toEqual([{ path: 'phone', message: PHONE_INVALID }]);
		}
		expect(phoneIssues({ ...buyer, phone: '1'.repeat(20) })).toEqual([]);
	});

	it('a checkout without a phone is rejected', () => {
		const { phone: _phone, ...withoutPhone } = buyer;
		const request = { lines: [{ variantId: '00000000-0000-4000-8000-000000000001', quantity: 1 }], buyer: withoutPhone, delivery: { method: 'digital' }, consents: { terms: true, privacy: true, marketingEmail: false } };
		expect(checkoutRequestSchema.safeParse(request).error?.issues.map((issue) => issue.path.join('.'))).toEqual(['buyer.phone']);
		expect(checkoutRequestSchema.safeParse({ ...request, buyer }).success).toBe(true);
	});
});

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
