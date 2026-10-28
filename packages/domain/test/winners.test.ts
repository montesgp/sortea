import { describe, expect, it } from 'vitest';
import { checkoutRequestSchema, liveIdentityApplies, orderPublicity, winnerIdentityPublic, type PublicityDecision } from '../src';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 28, 12, minute));
const decision = (orderId: string | null, granted: boolean, minute: number): PublicityDecision => ({ orderId, granted, recordedAt: at(minute) });

describe('winnerIdentityPublic (S5)', () => {
	it('publishes the identity when the winning purchase granted it and nothing later declined', () => {
		expect(winnerIdentityPublic([decision('a', true, 1)], 'a')).toBe(true);
		expect(winnerIdentityPublic([decision('a', true, 1), decision('b', true, 5)], 'a')).toBe(true);
		// An earlier refusal on another purchase does not touch a later consent.
		expect(winnerIdentityPublic([decision('z', false, 0), decision('a', true, 1)], 'a')).toBe(true);
	});

	it('withholds it when the winning purchase did not grant it or recorded no decision', () => {
		expect(winnerIdentityPublic([decision('a', false, 1)], 'a')).toBe(false);
		expect(winnerIdentityPublic([], 'a')).toBe(false);
		expect(winnerIdentityPublic([decision('b', true, 1)], 'a')).toBe(false);
	});

	it('lets a newer refusal of the same person withdraw an older consent', () => {
		expect(winnerIdentityPublic([decision('a', true, 1), decision('b', false, 5)], 'a')).toBe(false);
		// Recorded at the same instant: the refusal wins.
		expect(winnerIdentityPublic([decision('a', true, 1), decision('b', false, 1)], 'a')).toBe(false);
	});

	it('never lets a newer consent publish a purchase that declined (a document typed at checkout proves no identity)', () => {
		expect(winnerIdentityPublic([decision('a', false, 1), decision('b', true, 5)], 'a')).toBe(false);
	});

	it('lets a withdrawal recorded without a purchase withdraw every earlier consent of the person', () => {
		expect(winnerIdentityPublic([decision('a', true, 1), decision(null, false, 5)], 'a')).toBe(false);
		expect(winnerIdentityPublic([decision('a', true, 1), decision('b', true, 2), decision(null, false, 5)], 'b')).toBe(false);
		// Recorded at the same instant: the withdrawal wins.
		expect(winnerIdentityPublic([decision('a', true, 1), decision(null, false, 1)], 'a')).toBe(false);
	});

	it('keeps a consent given on a purchase after the withdrawal, for that purchase only', () => {
		const decisions = [decision('a', true, 1), decision(null, false, 5), decision('b', true, 9)];
		expect(winnerIdentityPublic(decisions, 'b')).toBe(true);
		expect(winnerIdentityPublic(decisions, 'a')).toBe(false);
		// A withdrawal is never a purchase: it never publishes anything by itself.
		expect(winnerIdentityPublic([decision(null, false, 1)], 'a')).toBe(false);
	});
});

describe('orderPublicity (S9)', () => {
	it('withdraws a later purchase too when asked from an older order', () => {
		const decisions = [decision('a', true, 1), decision('b', true, 3), decision(null, false, 5)];
		expect(orderPublicity(decisions, 'a')).toEqual({ publishable: false, withdrawable: false, withdrawnAt: at(5) });
		expect(orderPublicity(decisions, 'b')).toEqual({ publishable: false, withdrawable: false, withdrawnAt: at(5) });
	});

	it('never lets a withdrawal recorded before a consent block it', () => {
		expect(winnerIdentityPublic([decision(null, false, 1), decision('a', true, 2)], 'a')).toBe(true);
	});

	it('says whether the purchase is publishable and whether a withdrawal would change anything', () => {
		expect(orderPublicity([decision('a', true, 1)], 'a')).toEqual({ publishable: true, withdrawable: true, withdrawnAt: null });
		expect(orderPublicity([decision('a', false, 1)], 'a')).toEqual({ publishable: false, withdrawable: false, withdrawnAt: null });
		// This purchase declined, another one consented: withdrawing still matters.
		expect(orderPublicity([decision('a', false, 1), decision('b', true, 2)], 'a')).toEqual({ publishable: false, withdrawable: true, withdrawnAt: null });
	});

	it('names the withdrawal that took the consent back, and only for the purchases it covers', () => {
		const decisions = [decision('a', true, 1), decision(null, false, 5), decision(null, false, 7), decision('b', true, 9)];
		expect(orderPublicity(decisions, 'a')).toEqual({ publishable: false, withdrawable: true, withdrawnAt: at(5) });
		expect(orderPublicity(decisions, 'b')).toEqual({ publishable: true, withdrawable: true, withdrawnAt: null });
		expect(orderPublicity(decisions.slice(0, 3), 'a')).toEqual({ publishable: false, withdrawable: false, withdrawnAt: at(5) });
	});
});

describe('checkout consents', () => {
	const body = {
		lines: [{ variantId: '7f8c1c4e-8c55-4b0e-9a64-0f4b8f1f2a10', quantity: 1 }],
		buyer: { documentType: 'DNI', documentNumber: '30123456', firstName: 'Juana', lastName: 'Pérez', email: 'juana@example.com', province: 'Córdoba', city: 'Río Cuarto' },
		delivery: { method: 'digital' }
	};

	it('keeps winner publicity optional and off unless asked', () => {
		const parsed = checkoutRequestSchema.parse({ ...body, consents: { terms: true, privacy: true, marketingEmail: false } });
		expect(parsed.consents).toEqual({ terms: true, privacy: true, marketingEmail: false, winnerPublicity: false });
		expect(checkoutRequestSchema.parse({ ...body, consents: { terms: true, privacy: true, marketingEmail: false, winnerPublicity: true } }).consents.winnerPublicity).toBe(true);
	});
});

describe('liveIdentityApplies (S7)', () => {
	it('applies to a coupon that holds an award, in any round', () => {
		expect(liveIdentityApplies({ holdsAward: true })).toBe(true);
	});

	it('never applies to a coupon without an award, even one that plays the draw: the consent covers winning only', () => {
		expect(liveIdentityApplies({ holdsAward: false })).toBe(false);
	});
});
