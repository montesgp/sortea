import { z } from 'zod';

/**
 * The checkout's email fields, checked while typed (S5, feedback 2026-10-18)
 * with the same rules and words as the server. A malformed address is
 * flagged once its field was left; the two addresses are compared as soon as
 * the confirmation is as long as the address, or was left.
 */
export const EMAIL_INVALID = 'Ingresá un email válido';
export const EMAIL_MISMATCH = 'Los emails no coinciden';

const emailSchema = z.email().max(160);

/** Addresses are compared without surrounding spaces and case, here and on the server. */
export function sameEmail(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function emailCheck(
	email: string,
	confirm: string,
	left: { email: boolean; confirm: boolean }
): { email?: string; emailConfirm?: string; matches?: true } {
	const valid = emailSchema.safeParse(email.trim()).success;
	if (!valid) return left.email && email.trim() ? { email: EMAIL_INVALID } : {};
	if (!confirm.trim()) return {};
	if (sameEmail(email, confirm)) return { matches: true };
	return left.confirm || confirm.trim().length >= email.trim().length ? { emailConfirm: EMAIL_MISMATCH } : {};
}
