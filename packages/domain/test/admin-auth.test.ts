import { describe, expect, it } from 'vitest';
import {
	base32Decode,
	base32Encode,
	generateTotpSecret,
	hashPassword,
	needsRehash,
	parsePasswordHash,
	totpCode,
	totpStep,
	totpUri,
	verifyPassword,
	verifyTotp
} from '../src/server';

// Back-office sign-in owned by the API (ADR 0020, "Back-office sign-in").
describe('password hashing (scrypt)', () => {
	const cheap = { N: 1024, r: 8, p: 1 };

	it('stores the algorithm, its parameters and a per-user salt with the hash', async () => {
		const stored = await hashPassword('correct horse battery', cheap);
		expect(stored).toMatch(/^scrypt\$N=1024,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
		expect(stored).not.toContain('correct');
		expect(parsePasswordHash(stored)).toMatchObject({ N: 1024, r: 8, p: 1 });
		const again = await hashPassword('correct horse battery', cheap);
		expect(again).not.toBe(stored);
	});

	it('uses N=32768, r=8, p=1 by default', async () => {
		expect(parsePasswordHash(await hashPassword('another long secret'))).toMatchObject({ N: 32768, r: 8, p: 1 });
	});

	it('accepts the right password and refuses a wrong one', async () => {
		const stored = await hashPassword('correct horse battery', cheap);
		expect(await verifyPassword('correct horse battery', stored)).toBe(true);
		expect(await verifyPassword('correct horse batterz', stored)).toBe(false);
		expect(await verifyPassword('', stored)).toBe(false);
	});

	it('verifies with the parameters stored in the hash, so they can be raised later', async () => {
		const old = await hashPassword('correct horse battery', { N: 2048, r: 8, p: 1 });
		expect(await verifyPassword('correct horse battery', old)).toBe(true);
		expect(needsRehash(old)).toBe(true);
		expect(needsRehash(await hashPassword('correct horse battery'))).toBe(false);
	});

	it('refuses a malformed or foreign hash instead of throwing', async () => {
		for (const stored of ['', 'plain', 'bcrypt$2b$10$abc', 'scrypt$N=3,r=8,p=1$c2FsdA$aGFzaA', 'scrypt$N=1024,r=8,p=1$$']) {
			expect(await verifyPassword('anything', stored)).toBe(false);
		}
	});
});

describe('TOTP (RFC 6238)', () => {
	// RFC 6238 appendix B, SHA-1, 8 digits, secret "12345678901234567890".
	const rfcSecret = Buffer.from('12345678901234567890', 'ascii');
	const vectors: [number, string][] = [
		[59, '94287082'],
		[1111111109, '07081804'],
		[1111111111, '14050471'],
		[1234567890, '89005924'],
		[2000000000, '69279037'],
		[20000000000, '65353130']
	];

	it.each(vectors)('matches the RFC vector at T=%i', (seconds, expected) => {
		expect(totpCode(rfcSecret, totpStep(new Date(seconds * 1000)), 8)).toBe(expected);
	});

	it('uses 6 digits by default (the last 6 of the RFC value)', () => {
		expect(totpCode(rfcSecret, totpStep(new Date(59_000)))).toBe('287082');
	});

	it('accepts the current step and one step either side, nothing further', () => {
		const now = new Date(1_800_000_000_000);
		const step = totpStep(now);
		for (const offset of [-1, 0, 1]) {
			expect(verifyTotp(rfcSecret, totpCode(rfcSecret, step + offset), now, null)).toBe(step + offset);
		}
		for (const offset of [-2, 2]) {
			expect(verifyTotp(rfcSecret, totpCode(rfcSecret, step + offset), now, null)).toBeNull();
		}
	});

	it('accepts a step once: the same code, or an older one, is refused after it was used', () => {
		const now = new Date(1_800_000_000_000);
		const step = totpStep(now);
		const code = totpCode(rfcSecret, step);
		expect(verifyTotp(rfcSecret, code, now, null)).toBe(step);
		expect(verifyTotp(rfcSecret, code, now, step)).toBeNull();
		expect(verifyTotp(rfcSecret, totpCode(rfcSecret, step - 1), now, step)).toBeNull();
		expect(verifyTotp(rfcSecret, totpCode(rfcSecret, step + 1), now, step)).toBe(step + 1);
	});

	it('refuses codes that are not six digits', () => {
		const now = new Date(1_800_000_000_000);
		for (const code of ['', '12345', '1234567', 'abcdef', ' 12345']) expect(verifyTotp(rfcSecret, code, now, null)).toBeNull();
	});

	it('generates 20-byte secrets and round-trips them through base32', () => {
		const secret = generateTotpSecret();
		expect(secret).toHaveLength(20);
		const text = base32Encode(secret);
		expect(text).toMatch(/^[A-Z2-7]{32}$/);
		expect(base32Decode(text).equals(secret)).toBe(true);
		// RFC 4648 test vector.
		expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
		expect(base32Decode('mzxw6ytboi').toString()).toBe('foobar');
	});

	it('builds the otpauth URI apps scan', () => {
		const uri = totpUri({ issuer: 'demo.localhost', account: 'owner@tallerdemo.local', secret: 'MZXW6YTBOI' });
		expect(uri).toBe(
			'otpauth://totp/demo.localhost:owner%40tallerdemo.local?secret=MZXW6YTBOI&issuer=demo.localhost&algorithm=SHA1&digits=6&period=30'
		);
	});
});
