import { describe, expect, it } from 'vitest';
import { clearCheckoutDraft, readCheckoutDraft, saveCheckoutDraft } from './checkout-draft';

// Feedback 2026-10-19: a buyer who goes back from the checkout finds what they
// typed. Kept in the tab's sessionStorage only; consents are never kept.

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

describe('checkout draft', () => {
	it('keeps what the buyer typed and gives it back', () => {
		const storage = memoryStorage();
		saveCheckoutDraft(storage, form({ firstName: 'Ana', email: 'ana@example.com', country: 'AR', province: 'Córdoba', city: 'Río Cuarto', deliveryMethod: 'shipping', street: 'San Martín 123' }));
		expect(readCheckoutDraft(storage)).toEqual({ firstName: 'Ana', email: 'ana@example.com', country: 'AR', province: 'Córdoba', city: 'Río Cuarto', deliveryMethod: 'shipping', street: 'San Martín 123' });
	});

	it('never keeps consents or fields it does not know, nor empty ones', () => {
		const storage = memoryStorage();
		saveCheckoutDraft(storage, form({ firstName: 'Ana', terms: 'on', privacy: 'on', marketingEmail: 'on', other: 'x', lastName: '' }));
		expect(readCheckoutDraft(storage)).toEqual({ firstName: 'Ana' });
	});

	it('reads nothing from a missing, broken or foreign value, and clears on demand', () => {
		const storage = memoryStorage();
		expect(readCheckoutDraft(storage)).toBeNull();
		storage.setItem('sortea_checkout_draft', '{broken');
		expect(readCheckoutDraft(storage)).toBeNull();
		storage.setItem('sortea_checkout_draft', JSON.stringify({ firstName: 3, terms: 'on', city: 'Rosario' }));
		expect(readCheckoutDraft(storage)).toEqual({ city: 'Rosario' });
		clearCheckoutDraft(storage);
		expect(readCheckoutDraft(storage)).toBeNull();
	});

	it('does not break when storage is unavailable', () => {
		const failing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } } as unknown as Storage;
		expect(() => saveCheckoutDraft(failing, form({ firstName: 'Ana' }))).not.toThrow();
		expect(readCheckoutDraft(failing)).toBeNull();
		expect(() => clearCheckoutDraft(failing)).not.toThrow();
	});
});
