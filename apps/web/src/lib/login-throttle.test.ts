import { describe, expect, it } from 'vitest';
import { createLoginThrottle } from './server/login-throttle';

// S2 (feedback 2026-10-17b): bots must not guess admin passwords at speed nor
// spend Supabase's per-IP sign-in limit, which only sees the web server.

function setup() {
	const clock = { now: 1_000_000 };
	const throttle = createLoginThrottle({ now: () => clock.now, maxPerAccount: 5, maxPerClient: 20, windowMs: 15 * 60_000, maxGlobal: 20, globalWindowMs: 5 * 60_000 });
	return { clock, throttle };
}

describe('login throttle', () => {
	it('lets a person try until the fifth failure on one account, then makes them wait', () => {
		const { throttle } = setup();
		for (let attempt = 0; attempt < 5; attempt++) {
			expect(throttle.check('203.0.113.7', 'owner@moto.test')).toEqual({ allowed: true });
			throttle.failed('203.0.113.7', 'owner@moto.test');
		}
		expect(throttle.check('203.0.113.7', 'owner@moto.test')).toEqual({ allowed: false, retryAfterMinutes: 15 });
		// The account is protected from any address, and the email is compared case-insensitively.
		expect(throttle.check('198.51.100.4', ' Owner@Moto.test ')).toEqual({ allowed: false, retryAfterMinutes: 15 });
	});

	it('stops a client that tries many accounts', () => {
		// A high global cap isolates the per-client limit.
		const throttle = createLoginThrottle({ now: () => 1_000_000, maxPerAccount: 5, maxPerClient: 20, windowMs: 15 * 60_000, maxGlobal: 100 });
		for (let attempt = 0; attempt < 20; attempt++) throttle.failed('203.0.113.7', `user${attempt}@moto.test`);
		expect(throttle.check('203.0.113.7', 'new@moto.test')).toEqual({ allowed: false, retryAfterMinutes: 15 });
		expect(throttle.check('198.51.100.4', 'new@moto.test')).toEqual({ allowed: true });
	});

	it('forgets failures once the window passes and says how long is left meanwhile', () => {
		const { clock, throttle } = setup();
		for (let attempt = 0; attempt < 5; attempt++) throttle.failed('203.0.113.7', 'owner@moto.test');
		clock.now += 10 * 60_000;
		expect(throttle.check('203.0.113.7', 'owner@moto.test')).toEqual({ allowed: false, retryAfterMinutes: 5 });
		clock.now += 5 * 60_000 + 1;
		expect(throttle.check('203.0.113.7', 'owner@moto.test')).toEqual({ allowed: true });
	});

	it('caps failures from all clients below Supabase\'s shared limit, but lets in who signed in before from that address', () => {
		const { clock, throttle } = setup();
		throttle.succeeded('198.51.100.4', 'owner@moto.test');
		for (let bot = 0; bot < 20; bot++) throttle.failed(`203.0.113.${bot}`, `guess${bot}@moto.test`);
		expect(throttle.check('192.0.2.9', 'new@moto.test')).toEqual({ allowed: false, retryAfterMinutes: 5 });
		expect(throttle.check('192.0.2.9', 'owner@moto.test')).toEqual({ allowed: false, retryAfterMinutes: 5 });
		expect(throttle.check('198.51.100.4', ' Owner@Moto.test')).toEqual({ allowed: true });
		clock.now += 5 * 60_000 + 1;
		expect(throttle.check('192.0.2.9', 'new@moto.test')).toEqual({ allowed: true });
	});

	it('a successful sign-in clears the account and does not count against the client', () => {
		const { throttle } = setup();
		for (let attempt = 0; attempt < 4; attempt++) throttle.failed('203.0.113.7', 'owner@moto.test');
		throttle.succeeded('203.0.113.7', 'owner@moto.test');
		for (let attempt = 0; attempt < 4; attempt++) throttle.failed('203.0.113.7', 'owner@moto.test');
		expect(throttle.check('203.0.113.7', 'owner@moto.test')).toEqual({ allowed: true });
		for (let attempt = 0; attempt < 50; attempt++) throttle.succeeded('203.0.113.7', `user${attempt}@moto.test`);
		expect(throttle.check('203.0.113.7', 'other@moto.test')).toEqual({ allowed: true });
	});
});
