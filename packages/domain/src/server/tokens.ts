import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * One-time codes and access tokens. Only hashes are stored; codes are peppered
 * with a server secret so a database leak does not reveal them (SECURITY.md).
 */
export function generateOtp(): string {
	return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashWithPepper(pepper: string, value: string): string {
	return createHmac('sha256', pepper).update(value).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
	const left = Buffer.from(a, 'hex');
	const right = Buffer.from(b, 'hex');
	return left.length === right.length && timingSafeEqual(left, right);
}

/** URL-safe random token, e.g. for download links and lookup sessions. */
export function generateToken(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

const receiptAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Human-friendly code printed on receipts; no ambiguous characters (0/O, 1/I). */
export function generateReceiptCode(length = 10): string {
	let code = '';
	for (let index = 0; index < length; index++) code += receiptAlphabet[randomInt(0, receiptAlphabet.length)];
	return code;
}

/** Order reference used as Mercado Pago `external_reference`: `MG-7K2Q9XHD`. */
export function generateOrderReference(prefix: string): string {
	return `${prefix.toUpperCase().slice(0, 4)}-${generateReceiptCode(8)}`;
}

export function sha256Hex(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

/**
 * Campaign-scoped pseudonym used in public manifests. Stable for a holder within
 * one campaign, unlinkable across campaigns, and not reversible to a document.
 */
export function holderPseudonym(pepper: string, campaignId: string, contactId: string): string {
	return createHmac('sha256', pepper).update(`${campaignId}:${contactId}`).digest('hex').slice(0, 16);
}
