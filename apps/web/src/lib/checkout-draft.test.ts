import { describe, expect, it } from 'vitest';
import { CHECKOUT_DRAFT_TTL_MS, clearCheckoutDraft, forgetSubmittedCheckout, markCheckoutSubmitted, readCheckoutDraft, readSubmittedCheckout, saveCheckoutDraft } from './checkout-draft';

// Feedback 2026-10-19: a buyer who goes back from the checkout finds what they typed.
// Checkout in two steps T2 (S3): kept 24 hours on this device, with the step the buyer was in;
// consents are never kept.

function memoryStorage(): Storage {
	const items = new Map<string, string>();
	return {
		get length() {
			return items.size;
		},
		clear: () => items.clear(),
		getItem: (key) => items.get(key) ?? null,
		key: (index) => [...items.keys()][index] ?? null,
		removeItem: (key) => void items.delete(key),
		setItem: (key, value) => void items.set(key, String(value))
	};
}

function form(entries: Record<string, string>): FormData {
	const data = new FormData();
	for (const [key, value] of Object.entries(entries)) data.append(key, value);
	return data;
}

const now = Date.UTC(2026, 10, 16, 15, 0);

describe('checkout draft', () => {
	it('keeps what the buyer typed and the step, and gives them back', () => {
		const storage = memoryStorage();
		saveCheckoutDraft(storage, form({ firstName: 'Ana', email: 'ana@example.com', country: 'AR', province: 'Córdoba', city: 'Río Cuarto', deliveryMethod: 'shipping', street: 'San Martín 123' }), 2, now);
		expect(readCheckoutDraft(storage, now)).toEqual({
			step: 2,
			fields: { firstName: 'Ana', email: 'ana@example.com', country: 'AR', province: 'Córdoba', city: 'Río Cuarto', deliveryMethod: 'shipping', street: 'San Martín 123' }
		});
		saveCheckoutDraft(storage, form({ firstName: 'Ana' }), 1, now);
		expect(readCheckoutDraft(storage, now)).toEqual({ step: 1, fields: { firstName: 'Ana' } });
	});

	it('never keeps consents, the old email confirmation or fields it does not know, nor empty ones', () => {
		const storage = memoryStorage();
		saveCheckoutDraft(storage, form({ firstName: 'Ana', terms: 'on', privacy: 'on', adultDeclaration: 'on', marketingEmail: 'on', emailConfirm: 'ana@example.com', attempt: 'a-1', other: 'x', lastName: '' }), 1, now);
		expect(readCheckoutDraft(storage, now)).toEqual({ step: 1, fields: { firstName: 'Ana' } });
		expect(JSON.stringify([...Array(storage.length).keys()].map((index) => storage.getItem(storage.key(index)!)))).not.toMatch(/terms|privacy|adultDeclaration|emailConfirm|attempt/);
	});

	it('lasts 24 hours from the last save: an expired draft is ignored and removed', () => {
		const storage = memoryStorage();
		saveCheckoutDraft(storage, form({ firstName: 'Ana' }), 2, now);
		expect(readCheckoutDraft(storage, now + CHECKOUT_DRAFT_TTL_MS - 1)).toEqual({ step: 2, fields: { firstName: 'Ana' } });
		expect(CHECKOUT_DRAFT_TTL_MS).toBe(24 * 60 * 60 * 1000);
		expect(readCheckoutDraft(storage, now + CHECKOUT_DRAFT_TTL_MS)).toBeNull();
		expect(storage.getItem('sortea_checkout_draft')).toBeNull();
		// Saving again starts the 24 hours again.
		saveCheckoutDraft(storage, form({ firstName: 'Ana' }), 1, now + CHECKOUT_DRAFT_TTL_MS);
		expect(readCheckoutDraft(storage, now + 2 * CHECKOUT_DRAFT_TTL_MS - 1)).toEqual({ step: 1, fields: { firstName: 'Ana' } });
	});

	it('reads nothing from a missing, broken, undated or foreign value, removes it, and clears on demand', () => {
		const storage = memoryStorage();
		expect(readCheckoutDraft(storage, now)).toBeNull();
		storage.setItem('sortea_checkout_draft', '{broken');
		expect(readCheckoutDraft(storage, now)).toBeNull();
		expect(storage.getItem('sortea_checkout_draft')).toBeNull();
		// The draft of the earlier, tab-only format had no date: it is not trusted.
		storage.setItem('sortea_checkout_draft', JSON.stringify({ firstName: 'Ana' }));
		expect(readCheckoutDraft(storage, now)).toBeNull();
		storage.setItem('sortea_checkout_draft', JSON.stringify({ savedAt: now, step: 7, fields: { firstName: 3, terms: 'on', city: 'Rosario' } }));
		expect(readCheckoutDraft(storage, now)).toEqual({ step: 1, fields: { city: 'Rosario' } });
		clearCheckoutDraft(storage);
		expect(readCheckoutDraft(storage, now)).toBeNull();
	});

	it('remembers which checkout page this tab sent, apart from the draft', () => {
		const storage = memoryStorage();
		expect(readSubmittedCheckout(storage)).toBeNull();
		saveCheckoutDraft(storage, form({ firstName: 'Ana' }), 2, now);
		markCheckoutSubmitted(storage, 'attempt-1');
		expect(readSubmittedCheckout(storage)).toBe('attempt-1');
		// The result page clears the draft; the mark stays, so a page shown again by Back is still checked.
		clearCheckoutDraft(storage);
		expect(readSubmittedCheckout(storage)).toBe('attempt-1');
		markCheckoutSubmitted(storage, 'attempt-2');
		expect(readSubmittedCheckout(storage)).toBe('attempt-2');
		forgetSubmittedCheckout(storage);
		expect(readSubmittedCheckout(storage)).toBeNull();
		storage.setItem('sortea_checkout_submitted', 'x'.repeat(200));
		expect(readSubmittedCheckout(storage)).toBeNull();
	});

	it('does not break when storage is unavailable', () => {
		const failing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } } as unknown as Storage;
		expect(() => saveCheckoutDraft(failing, form({ firstName: 'Ana' }), 1, now)).not.toThrow();
		expect(readCheckoutDraft(failing, now)).toBeNull();
		expect(() => clearCheckoutDraft(failing)).not.toThrow();
		expect(() => markCheckoutSubmitted(failing, 'attempt-1')).not.toThrow();
		expect(readSubmittedCheckout(failing)).toBeNull();
		expect(() => forgetSubmittedCheckout(failing)).not.toThrow();
	});
});
