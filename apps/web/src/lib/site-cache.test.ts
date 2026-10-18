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
	const load = (host: string) => async () => {
		calls.push(host);
		if (hold) await new Promise<void>((resolve) => (release = resolve));
		return answer;
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

	it('forgets a host on demand so a publish shows at once', async () => {
		const { cache, answer } = setup();
		await cache.get('moto.test');
		answer({ ok: true, site: 'v2' });
		cache.invalidate('moto.test');
		expect(await cache.get('moto.test')).toBe('v2');
	});
});
