import { z } from 'zod';

/**
 * The checkout's email field, checked while typed (S5, feedback 2026-10-18) with the same rules
 * and words as the server. A malformed address is flagged once its field was left. Since the
 * checkout in two steps (S5) there is one field, no confirmation: a likely typo in a common
 * domain is pointed out at the moment, and support can correct an order's email afterwards.
 */
export const EMAIL_INVALID = 'Ingresá un email válido';

const emailSchema = z.email().max(160);

/** Whether the address has the server's format; the field shows a green check while it does (S8). */
export function emailValid(email: string): boolean {
	return emailSchema.safeParse(email.trim()).success;
}

/** The message under the field, once the buyer left it with something that is not an address. */
export function emailCheck(email: string, left: boolean): string | undefined {
	return left && email.trim() && !emailValid(email) ? EMAIL_INVALID : undefined;
}

/** The domains most buyers use; a domain one or two keystrokes away from one of them is offered the fix. */
const COMMON_DOMAINS = ['gmail.com', 'hotmail.com', 'hotmail.com.ar', 'outlook.com', 'outlook.com.ar', 'yahoo.com', 'yahoo.com.ar', 'live.com', 'live.com.ar', 'icloud.com'];
/** Real domains close to a common one: never "corrected". */
const OTHER_REAL_DOMAINS = ['mail.com', 'email.com', 'me.com', 'mac.com', 'msn.com', 'ymail.com', 'gmx.com', 'aol.com', 'proton.me', 'protonmail.com', 'hotmail.es', 'outlook.es', 'live.com.mx', 'hotmail.com.mx', 'yahoo.es'];
const KNOWN = new Set([...COMMON_DOMAINS, ...OTHER_REAL_DOMAINS]);
/** Mistakes too far for the distance rule, seen often enough to name. */
const ALIASES: Record<string, string> = { 'gmail.com.ar': 'gmail.com', 'googlemail.com.ar': 'gmail.com' };

/** Edits (insert, delete, replace, swap two neighbours) that turn one string into the other. */
function distance(a: string, b: string): number {
	const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i]![j] = Math.min(rows[i]![j]!, rows[i - 2]![j - 2]! + 1);
		}
	}
	return rows[a.length]![b.length]!;
}

const countryCode = (domain: string) => (/\.([a-z]{2})$/.exec(domain)?.[1] ?? null);

/**
 * The address with the common domain the buyer most likely meant ("¿Quisiste decir …?"), or null
 * when the domain is a known one or not close to any. What is before the @ is kept as typed.
 */
export function emailSuggestion(email: string): string | null {
	const value = email.trim();
	const at = value.lastIndexOf('@');
	if (at <= 0) return null;
	const local = value.slice(0, at);
	const domain = value.slice(at + 1).toLowerCase();
	if (domain.length < 4 || KNOWN.has(domain)) return null;
	if (ALIASES[domain]) return `${local}@${ALIASES[domain]}`;
	let best: { domain: string; edits: number } | null = null;
	for (const common of COMMON_DOMAINS) {
		// "gmail" with no ending at all is compared with the provider's name.
		const edits = domain.includes('.') ? distance(domain, common) : common.endsWith('.com') ? distance(domain, common.slice(0, -4)) : Infinity;
		const allowed = !domain.includes('.') ? 1 : common.length >= 9 ? 2 : 1;
		// A country ending that differs (yahoo.com.br) is another real domain, not a typo.
		const otherCountry = countryCode(domain) && countryCode(common) && countryCode(domain) !== countryCode(common);
		if (edits <= allowed && !otherCountry && (!best || edits < best.edits)) best = { domain: common, edits };
	}
	return best ? `${local}@${best.domain}` : null;
}
