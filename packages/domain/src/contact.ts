import { z } from 'zod';

const WHATSAPP_FORMAT = 'Ingresá el número con código de país, por ejemplo +54 9 2478 40-7084';

/**
 * Normalizes a phone written for people ("+54 9 2478 40-7084") to the digits
 * wa.me expects ("5492478407084"), or null when it is not an international
 * number. Without a leading + or 00 only Argentine numbers (54...) are
 * accepted, because a bare national number cannot be told apart from a foreign one.
 */
export function normalizeWhatsApp(value: string): string | null {
	const compact = value.trim().replace(/[\s().-]/g, '');
	const match = /^(\+|00)?(\d+)$/.exec(compact);
	if (!match) return null;
	const [, prefix, digits = ''] = match;
	if (!prefix && !digits.startsWith('54')) return null;
	// E.164: a country code never starts with 0 and the whole number has at most 15 digits.
	if (digits.startsWith('0') || digits.length < 8 || digits.length > 15) return null;
	// Argentina: 54, the optional mobile 9, then 10 digits of area code (starting 1, 2 or 3) and subscriber number.
	if (digits.startsWith('54') && !/^549?[1-3]\d{9}$/.test(digits)) return null;
	return digits;
}

/** Organization WhatsApp number as stored in settings: digits, or null to remove it. */
export const whatsappNumberSchema = z
	.string()
	.trim()
	.max(40, WHATSAPP_FORMAT)
	.transform((value, context) => {
		if (!value) return null;
		const digits = normalizeWhatsApp(value);
		if (!digits) {
			context.addIssue({ code: 'custom', message: WHATSAPP_FORMAT });
			return z.NEVER;
		}
		return digits;
	});

/**
 * A saved number: the schema stores international digits without the +, so
 * bare digits are read as international here (any country), while typed input
 * keeps the stricter rule above.
 */
export function storedWhatsApp(value: string): string | null {
	return normalizeWhatsApp(/^\d+$/.test(value) ? `+${value}` : value);
}

export function whatsappLink(value: string | null | undefined, text?: string): string | null {
	const digits = value ? storedWhatsApp(value) : null;
	if (!digits) return null;
	return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export interface PublicContact {
	email?: string;
	phone?: string;
	whatsapp?: string;
	address?: string;
	city?: string;
}

/** The contact fields a public page may show; other stored keys never leave the API. */
export function publicContact(contact: Partial<Record<keyof PublicContact, unknown>>): PublicContact {
	const result: PublicContact = {};
	for (const key of ['email', 'phone', 'address', 'city'] as const) {
		const value = contact[key];
		if (typeof value === 'string' && value.trim()) result[key] = value.trim();
	}
	const whatsapp = typeof contact.whatsapp === 'string' ? storedWhatsApp(contact.whatsapp) : null;
	if (whatsapp) result.whatsapp = whatsapp;
	return result;
}
