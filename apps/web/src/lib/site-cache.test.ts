import { describe, expect, it } from 'vitest';
import { createSiteCache } from './server/site-cache';

// S3 (feedback 2026-10-17b): no page waits for the site and theme request
// while a cached copy exists; an expired copy is served and refreshed behind.

function setup() {
	const clock = { now: 0 };
	const calls: string[] = [];
	let answer: { ok: true; site: string } | { ok: false; status: number } = { ok: true, site: 'v1' };
	let release: (() => void) | null = null;
	let hold = false;
	const inner = createSiteCache<string>({ ttlMs: 30_000, now: () => clock.now });
	// Like a real server, a request answers with what was current when it was made.
	const load = (host: string) => async () => {
		calls.push(host);
		const current = answer;
		if (hold) await new Promise<void>((resolve) => (release = resolve));
		return current;
	};
	const cache = { get: (host: string) => inner.get(host, load(host)), invalidate: inner.invalidate, settled: inner.settled };
	return {
		clock,
		calls,
		cache,
		answer: (next: typeof answer) => (answer = next),
		hold: () => (hold = true),
		release: () => {
			hold = false;
			release?.();
		}
	};
}

describe('site cache', () => {
	it('waits only for the first request of a host, then serves from memory', async () => {
		const { cache, calls } = setup();
		expect(await cache.get('moto.test')).toBe('v1');
		expect(await cache.get('moto.test')).toBe('v1');
		expect(calls).toEqual(['moto.test']);
	});

	it('serves an expired copy at once and refreshes it once in the background', async () => {
		const { cache, calls, clock, answer, hold, release } = setup();
		await cache.get('moto.test');
		clock.now += 31_000;
		answer({ ok: true, site: 'v2' });
		hold();
		expect(await cache.get('moto.test')).toBe('v1');
		expect(await cache.get('moto.test')).toBe('v1');
		expect(calls).toEqual(['moto.test', 'moto.test']);
		release();
		await cache.settled();
		expect(await cache.get('moto.test')).toBe('v2');
		expect(calls).toHaveLength(2);
	});

	it('keeps the last good copy through an outage and caches an unknown host briefly', async () => {
		const { cache, clock, answer, calls } = setup();
		await cache.get('moto.test');
		clock.now += 31_000;
		answer({ ok: false, status: 503 });
		expect(await cache.get('moto.test')).toBe('v1');
		await cache.settled();
		expect(await cache.get('moto.test')).toBe('v1');

		answer({ ok: false, status: 404 });
		expect(await cache.get('nobody.test')).toBeNull();
		expect(await cache.get('nobody.test')).toBeNull();
		expect(calls.filter((host) => host === 'nobody.test')).toHaveLength(1);
	});

	it('asks again at once for a host that was unknown, so a new domain shows on its next visit', async () => {
		const { cache, clock, answer } = setup();
		answer({ ok: false, status: 404 });
		expect(await cache.get('new.test')).toBeNull();
		clock.now += 31_000;
		answer({ ok: true, site: 'v1' });
		expect(await cache.get('new.test')).toBe('v1');
	});

	it('a refresh that was running when the host was forgotten never brings the old copy back', async () => {
		const { cache, clock, answer, hold, release } = setup();
		await cache.get('moto.test');
		clock.now += 31_000;
		hold();
		expect(await cache.get('moto.test')).toBe('v1');
		// Published while that refresh still waits for the old answer.
		cache.invalidate('moto.test');
		answer({ ok: true, site: 'v2' });
		const fresh = cache.get('moto.test');
		release();
		expect(await fresh).toBe('v2');
		await cache.settled();
		expect(await cache.get('moto.test')).toBe('v2');
	});

	it('forgets a host on demand so a publish shows at once', async () => {
		const { cache, answer } = setup();
		await cache.get('moto.test');
		answer({ ok: true, site: 'v2' });
		cache.invalidate('moto.test');
		expect(await cache.get('moto.test')).toBe('v2');
	});
});
