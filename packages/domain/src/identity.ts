/**
 * Identity documents (FR-ENTRY-01). A document number is never a primary key:
 * it is normalized and stored as a lookup identifier next to an internal UUID.
 */
export const documentTypes = ['DNI', 'CUIT', 'PASSPORT'] as const;
export type DocumentType = (typeof documentTypes)[number];

export type NormalizedDocument =
	| { ok: true; type: DocumentType; number: string }
	| { ok: false; reason: 'empty' | 'invalid_format' | 'invalid_check_digit' };

export function normalizeDocument(type: DocumentType, raw: string): NormalizedDocument {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false, reason: 'empty' };

	switch (type) {
		case 'DNI': {
			const digits = trimmed.replace(/[\s.\-]/g, '');
			if (!/^\d{7,8}$/.test(digits)) return { ok: false, reason: 'invalid_format' };
			return { ok: true, type, number: digits.padStart(8, '0') };
		}
		case 'CUIT': {
			const digits = trimmed.replace(/[\s.\-]/g, '');
			if (!/^\d{11}$/.test(digits)) return { ok: false, reason: 'invalid_format' };
			if (!isValidCuit(digits)) return { ok: false, reason: 'invalid_check_digit' };
			return { ok: true, type, number: digits };
		}
		case 'PASSPORT': {
			const value = trimmed.replace(/\s/g, '').toUpperCase();
			if (!/^[A-Z0-9]{6,12}$/.test(value)) return { ok: false, reason: 'invalid_format' };
			return { ok: true, type, number: value };
		}
	}
}

function isValidCuit(digits: string): boolean {
	const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
	const sum = weights.reduce((acc, weight, index) => acc + weight * Number(digits[index]), 0);
	const remainder = 11 - (sum % 11);
	const expected = remainder === 11 ? 0 : remainder === 10 ? 9 : remainder;
	return expected === Number(digits[10]);
}

/** Shows only the last three digits, e.g. `*****678`, for support and receipts. */
export function maskDocument(number: string): string {
	if (number.length <= 3) return '*'.repeat(number.length);
	return `${'*'.repeat(number.length - 3)}${number.slice(-3)}`;
}

/** `ju***@gmail.com`; used to tell a buyer where a code was sent without revealing the address. */
export function maskEmail(email: string): string {
	const [local = '', domain = ''] = email.split('@');
	const visible = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
	return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}
