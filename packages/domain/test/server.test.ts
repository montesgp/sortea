import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildManifest, contrastRatio, parseManifest, resolveTheme, serializeManifest, themeToCss } from '../src';
import {
	generateOrderReference,
	hashManifest,
	holderPseudonym,
	openSecret,
	parseKeyRing,
	sealSecret,
	signWebhook,
	verifyManifestHash,
	verifyMercadoPagoSignature
} from '../src/server';

describe('Mercado Pago signature', () => {
	const secret = 'webhook-secret';

	it('accepts the documented manifest and rejects tampering', () => {
		const ts = '1704908010';
		const v1 = signWebhook(secret, '123456', 'req-1', ts);
		const header = `ts=${ts},v1=${v1}`;
		expect(verifyMercadoPagoSignature({ secret, signatureHeader: header, requestId: 'req-1', dataId: '123456' }).valid).toBe(true);
		expect(verifyMercadoPagoSignature({ secret, signatureHeader: header, requestId: 'req-2', dataId: '123456' })).toEqual({
			valid: false,
			reason: 'bad_signature'
		});
		expect(verifyMercadoPagoSignature({ secret: 'other', signatureHeader: header, requestId: 'req-1', dataId: '123456' }).valid).toBe(false);
	});

	it('lower-cases alphanumeric data ids as the provider does', () => {
		const v1 = signWebhook(secret, 'abc', 'r', '1');
		expect(verifyMercadoPagoSignature({ secret, signatureHeader: `ts=1,v1=${v1}`, requestId: 'r', dataId: 'ABC' }).valid).toBe(true);
	});

	it('rejects missing and malformed headers', () => {
		expect(verifyMercadoPagoSignature({ secret, signatureHeader: undefined, requestId: 'r', dataId: '1' })).toEqual({
			valid: false,
			reason: 'missing_header'
		});
		expect(verifyMercadoPagoSignature({ secret, signatureHeader: 'ts=1,v1=zz', requestId: 'r', dataId: '1' })).toEqual({
			valid: false,
			reason: 'malformed_header'
		});
	});

	it('can enforce a freshness window', () => {
		const v1 = signWebhook(secret, '1', 'r', '1000');
		const check = verifyMercadoPagoSignature({
			secret,
			signatureHeader: `ts=1000,v1=${v1}`,
			requestId: 'r',
			dataId: '1',
			now: new Date(5_000_000),
			maxAgeSeconds: 300
		});
		expect(check).toEqual({ valid: false, reason: 'stale' });
	});
});

describe('sealed secrets', () => {
	const ring = parseKeyRing(`v1:${randomBytes(32).toString('base64')}`);

	it('round-trips and binds the secret to its owner', () => {
		const sealed = sealSecret(ring, 'APP_USR-token', 'org-a:mercadopago');
		expect(sealed).not.toContain('APP_USR');
		expect(openSecret(ring, sealed, 'org-a:mercadopago')).toBe('APP_USR-token');
		expect(() => openSecret(ring, sealed, 'org-b:mercadopago')).toThrow();
	});

	it('decrypts older versions after a rotation', () => {
		const sealed = sealSecret(ring, 'old', 'owner');
		const rotated = parseKeyRing(`v1:${ring.keys.get(1)!.toString('base64')},v2:${randomBytes(32).toString('base64')}`);
		expect(rotated.current).toBe(2);
		expect(openSecret(rotated, sealed, 'owner')).toBe('old');
		expect(sealSecret(rotated, 'new', 'owner').startsWith('v2.')).toBe(true);
	});
});

describe('manifest (AC-11)', () => {
	const entries = [
		{ entryNumber: 2, holder: 'b', status: 'eligible' as const },
		{ entryNumber: 1, holder: 'a', status: 'eligible' as const },
		{ entryNumber: 3, holder: 'a', status: 'void' as const }
	];
	const manifest = buildManifest({ campaignId: 'c-1', round: 1, ruleVersion: 1, entryDigits: 4, closedAt: new Date('2026-11-08T22:00:00Z'), entries });

	it('orders entries and produces a hash anyone can recompute from the file', () => {
		expect(manifest.entries.map((entry) => entry.entryNumber)).toEqual([1, 2, 3]);
		expect(manifest.header.eligibleCount).toBe(2);
		const hash = hashManifest(manifest);
		expect(verifyManifestHash(serializeManifest(manifest), hash)).toBe(true);
		expect(verifyManifestHash(serializeManifest(manifest).replace('"b"', '"x"'), hash)).toBe(false);
	});

	it('does not depend on input order', () => {
		const reversed = buildManifest({ campaignId: 'c-1', round: 1, ruleVersion: 1, entryDigits: 4, closedAt: new Date('2026-11-08T22:00:00Z'), entries: [...entries].reverse() });
		expect(hashManifest(reversed)).toBe(hashManifest(manifest));
	});

	it('refuses duplicate entry numbers', () => {
		expect(() =>
			buildManifest({ campaignId: 'c', round: 1, ruleVersion: 1, entryDigits: 4, closedAt: new Date(), entries: [entries[0]!, entries[0]!] })
		).toThrow(/Duplicate/);
	});

	it('v2 records the round and the coupon digits in its header (ADR 0014 §5)', () => {
		const second = buildManifest({ campaignId: 'c-1', round: 2, ruleVersion: 1, entryDigits: 4, closedAt: new Date('2026-12-20T23:00:00Z'), entries });
		const [header] = serializeManifest(second).split('\n');
		expect(header).toBe(
			'{"format":"sortea.manifest.v2","campaignId":"c-1","round":2,"ruleVersion":1,"entryDigits":4,"closedAt":"2026-12-20T23:00:00.000Z","eligibleCount":2,"voidCount":1}'
		);
		expect(parseManifest(serializeManifest(second))).toEqual(second);
		// Each round's manifest has its own hash.
		expect(hashManifest(second)).not.toBe(hashManifest(manifest));
	});

	it('v1 manifests published before rounds existed still parse and verify byte for byte', () => {
		const v1 =
			'{"format":"sortea.manifest.v1","campaignId":"c-1","ruleVersion":1,"closedAt":"2026-11-08T22:00:00.000Z","eligibleCount":2,"voidCount":1}\n' +
			'{"entryNumber":1,"holder":"a","status":"eligible"}\n{"entryNumber":2,"holder":"b","status":"eligible"}\n{"entryNumber":3,"holder":"a","status":"void"}\n';
		const parsed = parseManifest(v1);
		expect(parsed.header).toEqual({ format: 'sortea.manifest.v1', campaignId: 'c-1', ruleVersion: 1, closedAt: '2026-11-08T22:00:00.000Z', eligibleCount: 2, voidCount: 1 });
		expect(parsed.entries.map((entry) => entry.entryNumber)).toEqual([1, 2, 3]);
		expect(serializeManifest(parsed)).toBe(v1);
		expect(verifyManifestHash(v1, hashManifest(parsed))).toBe(true);
		expect(() => parseManifest(v1.replace('sortea.manifest.v1', 'sortea.manifest.v9'))).toThrow(/Unsupported manifest format/);
	});
});

describe('pseudonyms and references', () => {
	it('are campaign-scoped and do not contain the source identifiers', () => {
		const a = holderPseudonym('pepper', 'campaign-1', 'contact-1');
		expect(a).toBe(holderPseudonym('pepper', 'campaign-1', 'contact-1'));
		expect(a).not.toBe(holderPseudonym('pepper', 'campaign-2', 'contact-1'));
		expect(a).not.toContain('contact');
	});

	it('generates readable order references', () => {
		expect(generateOrderReference('mg')).toMatch(/^MG-[A-HJ-NP-Z2-9]{8}$/);
	});
});

describe('theme', () => {
	it('falls back to platform tokens when a tenant pair fails WCAG AA', () => {
		const { tokens, issues } = resolveTheme({ dark: { text: '#222222' } });
		expect(issues.some((issue) => issue.pair === 'text/bg')).toBe(true);
		expect(contrastRatio(tokens.dark.text, tokens.dark.bg)).toBeGreaterThanOrEqual(4.5);
	});

	it('keeps compliant overrides and emits CSS for both modes', () => {
		const { tokens, issues } = resolveTheme({ dark: { accent: '#E01E25' }, defaultMode: 'dark' });
		expect(issues).toEqual([]);
		const css = themeToCss(tokens);
		expect(css).toContain('--accent:#E01E25');
		expect(css).toContain(':root[data-mode="light"]');
	});

	it('rejects values that are not plain hex colors', () => {
		expect(() => resolveTheme({ dark: { accent: 'red;}body{display:none' } })).toThrow();
	});
});
