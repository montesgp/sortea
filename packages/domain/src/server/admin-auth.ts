import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Primitives of the back-office sign-in owned by the API (ADR 0020, "Back-office
 * sign-in"): scrypt password hashes and RFC 6238 TOTP. Shared by the API and the
 * operator commands of packages/db, so both hash and check the same way.
 */

export interface ScryptParameters {
	readonly N: number;
	readonly r: number;
	readonly p: number;
}

/** About 32 MiB and 50-100 ms per hash on a small server: slow for guessing, fine for a few sign-ins. */
export const DEFAULT_SCRYPT: ScryptParameters = { N: 32768, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function derive(password: string, salt: Buffer, params: ScryptParameters): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		// maxmem above 128 * N * r, which is exactly Node's default for the default parameters.
		scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r }, (error, key) =>
			error ? reject(error) : resolve(key)
		);
	});
}

/** `scrypt$N=32768,r=8,p=1$<salt>$<key>` (base64url): the parameters travel with the hash, so they can be raised later. */
export async function hashPassword(password: string, params: ScryptParameters = DEFAULT_SCRYPT): Promise<string> {
	const salt = randomBytes(SALT_LENGTH);
	const key = await derive(password, salt, params);
	return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function parsePasswordHash(stored: string): (ScryptParameters & { salt: Buffer; key: Buffer }) | null {
	const match = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
	if (!match) return null;
	const [N, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
	// N must be a power of two above 1; the bounds keep a corrupted row from exhausting memory.
	if (N < 1024 || N > 1 << 20 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
	const salt = Buffer.from(match[4]!, 'base64url');
	const key = Buffer.from(match[5]!, 'base64url');
	if (salt.length < SALT_LENGTH || key.length !== KEY_LENGTH) return null;
	return { N, r, p, salt, key };
}

/** Constant-time comparison of the derived key; a malformed hash is a refusal, never an exception. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parsed = parsePasswordHash(stored);
	if (!parsed) return false;
	const key = await derive(password, parsed.salt, parsed);
	return timingSafeEqual(key, parsed.key);
}

/** Whether a stored hash uses weaker parameters than today's default. */
export function needsRehash(stored: string): boolean {
	const parsed = parsePasswordHash(stored);
	return !parsed || parsed.N < DEFAULT_SCRYPT.N || parsed.r < DEFAULT_SCRYPT.r || parsed.p < DEFAULT_SCRYPT.p;
}

/** A password for a new or reset account: 18 random bytes, shown once to the person who creates it. */
export function generateTemporaryPassword(): string {
	return randomBytes(18).toString('base64url');
}

// ─── TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits) ─────────────────

const PERIOD_SECONDS = 30;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let output = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
	return output;
}

export function base32Decode(text: string): Buffer {
	const clean = text.toUpperCase().replace(/=+$/, '');
	let bits = 0;
	let value = 0;
	const output: number[] = [];
	for (const char of clean) {
		const index = BASE32.indexOf(char);
		if (index < 0) throw new Error('Invalid base32');
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			output.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(output);
}

/** 160 bits, the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): Buffer {
	return randomBytes(20);
}

export function totpStep(now: Date): number {
	return Math.floor(now.getTime() / 1000 / PERIOD_SECONDS);
}

export function totpCode(secret: Uint8Array, step: number, digits = 6): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const mac = createHmac('sha1', secret).update(counter).digest();
	const offset = mac[mac.length - 1]! & 0x0f;
	const binary = mac.readUInt32BE(offset) & 0x7fffffff;
	return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * The step a code belongs to, within one step either side of `now` and after
 * `lastStep`, the last step this user had accepted; null otherwise. Storing the
 * returned step makes each code (and every older one) usable once.
 */
export function verifyTotp(secret: Uint8Array, code: string, now: Date, lastStep: number | null): number | null {
	if (!/^\d{6}$/.test(code)) return null;
	const current = totpStep(now);
	let matched: number | null = null;
	// Every candidate is compared, in constant time, so timing does not tell which step matched.
	for (const step of [current - 1, current, current + 1]) {
		const equal = timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code));
		if (equal && (lastStep === null || step > lastStep) && matched === null) matched = step;
	}
	return matched;
}

/** The `otpauth://` URI authenticator apps read from the QR code. */
export function totpUri({ issuer, account, secret }: { issuer: string; account: string; secret: string }): string {
	const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
	const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: String(PERIOD_SECONDS) });
	return `otpauth://totp/${label}?${params}`;
}
