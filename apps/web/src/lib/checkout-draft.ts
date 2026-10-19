/**
 * What the buyer typed in the checkout, kept while they go back to the cart
 * (feedback 2026-10-19). It lives in the tab's sessionStorage only: never sent
 * to the server, gone when the tab closes, cleared once the payment result is
 * shown. Consents are never kept; the buyer checks them again.
 */
const KEY = 'sortea_checkout_draft';

export const CHECKOUT_DRAFT_FIELDS = [
	'firstName',
	'lastName',
	'documentType',
	'documentNumber',
	'email',
	'emailConfirm',
	'phone',
	'country',
	'province',
	'provinceOther',
	'city',
	'deliveryMethod',
	'street',
	'postalCode'
] as const;

export type CheckoutDraft = Partial<Record<(typeof CHECKOUT_DRAFT_FIELDS)[number], string>>;

const kept = new Set<string>(CHECKOUT_DRAFT_FIELDS);

export function saveCheckoutDraft(storage: Storage, form: FormData): void {
	const draft: CheckoutDraft = {};
	for (const [name, value] of form.entries()) {
		if (kept.has(name) && typeof value === 'string' && value !== '') draft[name as keyof CheckoutDraft] = value;
	}
	try {
		storage.setItem(KEY, JSON.stringify(draft));
	} catch {
		// Storage full or disabled: the form still works, it just is not kept.
	}
}

export function readCheckoutDraft(storage: Storage): CheckoutDraft | null {
	let parsed: unknown;
	try {
		const raw = storage.getItem(KEY);
		if (!raw) return null;
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const draft: CheckoutDraft = {};
	for (const [name, value] of Object.entries(parsed)) {
		if (kept.has(name) && typeof value === 'string' && value !== '') draft[name as keyof CheckoutDraft] = value.slice(0, 200);
	}
	return Object.keys(draft).length ? draft : null;
}

export function clearCheckoutDraft(storage: Storage): void {
	try {
		storage.removeItem(KEY);
	} catch {
		// Nothing to clear.
	}
}
