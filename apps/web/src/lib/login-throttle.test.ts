import { describe, expect, it } from 'vitest';
import { createLoginThrottle } from './server/login-throttle';

// S2 (feedback 2026-10-17b) and the targeted lockout follow-up: bots must not
// guess admin passwords nor spend Supabase's per-IP sign-in limit (it only sees
// the web server), and failures from other devices must not lock an admin out
// of a device they signed in from before.

const MINUTE = 60_000;

function setup(overrides: Parameters<typeof createLoginThrottle>[0] = {}) {
	const clock = { now: 1_000_000 };
	const throttle = createLoginThrottle({ now: () => clock.now, ...overrides });
	return { clock, throttle };
}

describe('login throttle, unknown devices', () => {
	it('lets two failures pass and then makes each next try wait longer, up to a minute', () => {
		const { clock, throttle } = setup();
		throttle.failed('203.0.113.7', 'owner@moto.test', null);
		throttle.failed('203.0.113.7', 'owner@moto.test', null);
		expect(throttle.check('203.0.113.7', 'owner@moto.test', null)).toEqual({ allowed: true });
		const waits: number[] = [];
		for (let failure = 3; failure <= 10; failure++) {
			throttle.failed('203.0.113.7', 'owner@moto.test', null);
			const verdict = throttle.check('198.51.100.4', ' Owner@Moto.test ', null);
			waits.push(verdict.allowed ? 0 : verdict.retryAfterSeconds);
			clock.now += (verdict.allowed ? 0 : verdict.retryAfterSeconds) * 1000;
		}
		expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
		expect(throttle.check('198.51.100.4', 'owner@moto.test', null)).toEqual({ allowed: true });
	});

	it('stops a client that tries many accounts', () => {
		const { throttle } = setup({ maxGlobal: 1000 });
		for (let attempt = 0; attempt < 30; attempt++) throttle.failed('203.0.113.7', `user${attempt}@moto.test`, null);
		expect(throttle.check('203.0.113.7', 'new@moto.test', null)).toEqual({ allowed: false, retryAfterSeconds: 15 * 60 });
		expect(throttle.check('198.51.100.4', 'new@moto.test', null)).toEqual({ allowed: true });
	});

	it('caps failures from every client below Supabase\'s shared limit and forgets them after five minutes', () => {
		const { clock, throttle } = setup();
		for (let bot = 0; bot < 20; bot++) throttle.failed(`203.0.113.${bot}`, `guess${bot}@moto.test`, null);
		expect(throttle.check('192.0.2.9', 'owner@moto.test', null)).toEqual({ allowed: false, retryAfterSeconds: 5 * 60 });
		clock.now += 5 * MINUTE + 1;
		expect(throttle.check('192.0.2.9', 'owner@moto.test', null)).toEqual({ allowed: true });
	});

	it('a successful sign-in clears the account\'s failures', () => {
		const { throttle } = setup();
		for (let failure = 0; failure < 6; failure++) throttle.failed('203.0.113.7', 'owner@moto.test', null);
		throttle.succeeded('203.0.113.7', 'owner@moto.test', null);
		expect(throttle.check('203.0.113.7', 'owner@moto.test', null)).toEqual({ allowed: true });
	});
});

describe('login throttle, a known device of the account', () => {
	it('is not held back by failures on the account from other devices nor by the global cap', () => {
		const { throttle } = setup();
		for (let failure = 0; failure < 10; failure++) throttle.failed(`203.0.113.${failure}`, 'owner@moto.test', null);
		for (let bot = 0; bot < 20; bot++) throttle.failed(`198.51.100.${bot}`, `guess${bot}@moto.test`, null);
		expect(throttle.check('192.0.2.9', 'owner@moto.test', null).allowed).toBe(false);
		expect(throttle.check('192.0.2.9', 'owner@moto.test', 'device-a')).toEqual({ allowed: true });
	});

	it('has its own limit, so a stolen cookie cannot be used to guess', () => {
		const { clock, throttle } = setup();
		for (let failure = 0; failure < 10; failure++) throttle.failed('192.0.2.9', 'owner@moto.test', 'device-a');
		expect(throttle.check('192.0.2.9', 'owner@moto.test', 'device-a')).toEqual({ allowed: false, retryAfterSeconds: 15 * 60 });
		expect(throttle.check('192.0.2.9', 'owner@moto.test', 'device-b')).toEqual({ allowed: true });
		// Its failures do not slow down the account for other devices.
		expect(throttle.check('203.0.113.7', 'owner@moto.test', null)).toEqual({ allowed: true });
		clock.now += 15 * MINUTE + 1;
		expect(throttle.check('192.0.2.9', 'owner@moto.test', 'device-a')).toEqual({ allowed: true });
	});
});
