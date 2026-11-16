import type { CheckoutStep } from '#lib/checkout-steps.js';

/**
 * What the buyer typed in the checkout, kept so an interruption costs nothing (feedback
 * 2026-10-19; checkout in two steps S3): a trip back to the cart, a closed tab or browser, a
 * phone that ran out of battery. It lives in this device's localStorage for 24 hours from the
 * last change, with the step the buyer was in, and is never sent to the server. It is removed
 * when the purchase is handed to the payment (the result page, a closed 'done' checkout) and with
 * "Borrar mis datos"; an expired draft is ignored and removed.
 *
 * Kept: name, last name, email, phone, document, country, province, city and the delivery choice
 * and address, which is what the buyer would have to type again. Never kept: the consents (terms,
 * privacy, adult declaration), which the buyer checks again on every purchase, and the attempt id.
 */
const KEY = 'sortea_checkout_draft';

export const CHECKOUT_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export const CHECKOUT_DRAFT_FIELDS = [
	'firstName',
	'lastName',
	'documentType',
	'documentNumber',
	'email',
	'phone',
	'country',
	'province',
	'provinceOther',
	'city',
	'deliveryMethod',
	'street',
	'postalCode'
] as const;

export type CheckoutDraftFields = Partial<Record<(typeof CHECKOUT_DRAFT_FIELDS)[number], string>>;
export interface CheckoutDraft {
	fields: CheckoutDraftFields;
	step: CheckoutStep;
}

const kept = new Set<string>(CHECKOUT_DRAFT_FIELDS);

export function saveCheckoutDraft(storage: Storage, form: FormData, step: CheckoutStep, now = Date.now()): void {
	const fields: CheckoutDraftFields = {};
	for (const [name, value] of form.entries()) {
		if (kept.has(name) && typeof value === 'string' && value !== '') fields[name as keyof CheckoutDraftFields] = value;
	}
	try {
		storage.setItem(KEY, JSON.stringify({ savedAt: now, step, fields }));
	} catch {
		// Storage full or disabled: the form still works, it just is not kept.
	}
}

export function readCheckoutDraft(storage: Storage, now = Date.now()): CheckoutDraft | null {
	let parsed: unknown;
	try {
		const raw = storage.getItem(KEY);
		if (!raw) return null;
		parsed = JSON.parse(raw);
	} catch {
		clearCheckoutDraft(storage);
		return null;
	}
	const stored = (parsed && typeof parsed === 'object' ? parsed : {}) as { savedAt?: unknown; step?: unknown; fields?: unknown };
	const fresh = typeof stored.savedAt === 'number' && now - stored.savedAt < CHECKOUT_DRAFT_TTL_MS;
	if (!fresh || !stored.fields || typeof stored.fields !== 'object') {
		clearCheckoutDraft(storage);
		return null;
	}
	const fields: CheckoutDraftFields = {};
	for (const [name, value] of Object.entries(stored.fields)) {
		if (kept.has(name) && typeof value === 'string' && value !== '') fields[name as keyof CheckoutDraftFields] = value.slice(0, 200);
	}
	if (!Object.keys(fields).length) return null;
	return { fields, step: stored.step === 2 ? 2 : 1 };
}

export function clearCheckoutDraft(storage: Storage): void {
	try {
		storage.removeItem(KEY);
	} catch {
		// Nothing to clear.
	}
}

/**
 * The attempt id of the checkout page this tab sent last (2026-10-30). When
 * that page is shown again, or a new checkout opens, the page asks the server
 * whether it already created an order, and then locks itself or drops the draft.
 * Kept apart from the draft: the result page clears the draft, not this mark.
 */
const SUBMITTED = 'sortea_checkout_submitted';

export function markCheckoutSubmitted(storage: Storage, attempt: string): void {
	try {
		storage.setItem(SUBMITTED, attempt);
	} catch {
		// The server still refuses a second order for the same page.
	}
}

export function readSubmittedCheckout(storage: Storage): string | null {
	try {
		const attempt = storage.getItem(SUBMITTED);
		return attempt && attempt.length <= 64 ? attempt : null;
	} catch {
		return null;
	}
}

export function forgetSubmittedCheckout(storage: Storage): void {
	try {
		storage.removeItem(SUBMITTED);
	} catch {
		// Nothing to forget.
	}
}
