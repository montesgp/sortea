import { describe, expect, it } from 'vitest';
import { createDeviceTrust } from './server/device-trust';

// Known-device cookie (OWASP "device cookies"): a browser that signed in to an
// account before is recognized, so failures from other devices cannot lock
// that admin out.

function setup() {
	const clock = { now: 1_000_000 };
	const trust = createDeviceTrust({ secret: 'test-secret-0123456789', now: () => clock.now, ttlMs: 90 * 24 * 60 * 60_000 });
	return { clock, trust };
}

describe('device trust', () => {
	it('recognizes the cookie it issued for that account only, comparing emails case-insensitively', () => {
		const { trust } = setup();
		const cookie = trust.issue('Owner@Moto.test ');
		const device = trust.verify(cookie, 'owner@moto.test');
		expect(device).toMatch(/^[A-Za-z0-9_-]{16,}$/);
		expect(trust.verify(cookie, 'other@moto.test')).toBeNull();
		expect(trust.issue('owner@moto.test')).not.toBe(cookie);
	});

	it('never puts the email in the cookie', () => {
		const { trust } = setup();
		expect(Buffer.from(trust.issue('owner@moto.test').split('.')[0]!, 'base64url').toString()).not.toContain('owner');
	});

	it('rejects a tampered, foreign, malformed or expired cookie', () => {
		const { trust, clock } = setup();
		const cookie = trust.issue('owner@moto.test');
		const [body, signature] = cookie.split('.');
		const other = createDeviceTrust({ secret: 'another-secret-0123456789', now: () => clock.now, ttlMs: 1000 });
		for (const value of [`${body}x.${signature}`, `${body}.${signature!.slice(1)}A`, other.issue('owner@moto.test'), 'garbage', '', undefined]) {
			expect(trust.verify(value, 'owner@moto.test'), String(value)).toBeNull();
		}
		clock.now += 90 * 24 * 60 * 60_000 + 1;
		expect(trust.verify(cookie, 'owner@moto.test')).toBeNull();
	});
});
