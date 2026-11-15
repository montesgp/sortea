import { describe, expect, it } from 'vitest';
import { checkoutRequestSchema, liveIdentityApplies } from '../src';

describe('checkout consents', () => {
	const body = {
		lines: [{ variantId: '7f8c1c4e-8c55-4b0e-9a64-0f4b8f1f2a10', quantity: 1 }],
		buyer: { documentType: 'DNI', documentNumber: '30123456', firstName: 'Juana', lastName: 'Pérez', email: 'juana@example.com', phone: '+54 9 11 2345-6789', province: 'Córdoba', city: 'Río Cuarto' },
		delivery: { method: 'digital' }
	};

	it('S3 (owner-feedback-2026-11-14): asks no winner publicity choice, and drops one sent by an old form', () => {
		const consents = { terms: true, privacy: true, marketingEmail: false };
		expect(checkoutRequestSchema.parse({ ...body, consents }).consents).toEqual({ terms: true, privacy: true, marketingEmail: false, adultDeclaration: false });
		expect(checkoutRequestSchema.parse({ ...body, consents: { ...consents, winnerPublicity: true } }).consents).not.toHaveProperty('winnerPublicity');
	});

	it('S11: takes the adult declaration, off unless sent (the API requires it only where chances are given)', () => {
		const consents = { terms: true, privacy: true, marketingEmail: false };
		expect(checkoutRequestSchema.parse({ ...body, consents }).consents.adultDeclaration).toBe(false);
		expect(checkoutRequestSchema.parse({ ...body, consents: { ...consents, adultDeclaration: true } }).consents.adultDeclaration).toBe(true);
		expect(checkoutRequestSchema.safeParse({ ...body, consents: { ...consents, adultDeclaration: 'yes' } }).success).toBe(false);
	});
});

describe('liveIdentityApplies (S7)', () => {
	it('applies to a coupon that holds an award, in any round', () => {
		expect(liveIdentityApplies({ holdsAward: true })).toBe(true);
	});

	it('never applies to a coupon without an award, even one that plays the draw: only winners and alternates are named', () => {
		expect(liveIdentityApplies({ holdsAward: false })).toBe(false);
	});
});
