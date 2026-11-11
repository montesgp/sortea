import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '@sortea/db';
import { buildApp } from '../src/app';
import { listenDualStack } from '../src/listen';
import { createTestContext, INTERNAL_TOKEN, type TestContext } from './helpers';

/**
 * Health checks of the deployment (ADR 0020): `/health` is what the platform
 * polls before a release takes traffic, so it reports whether the database
 * answers, without the internal token and without details.
 */
let ctx: TestContext;

beforeAll(async () => {
	ctx = await createTestContext();
});

afterAll(async () => {
	await ctx.close();
});

describe('GET /health', () => {
	it('answers 200 without the internal token while the database answers', async () => {
		const response = await ctx.app.inject({ method: 'GET', url: '/health' });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ ok: true });
	});

	it('answers 503 without details when the database does not', async () => {
		const failing: DatabaseHandle = {
			...ctx.db,
			withPlatform: async () => {
				throw new Error('connect ECONNREFUSED 10.0.0.1:5432 password authentication failed for user "postgres"');
			}
		};
		const app = await buildApp({ ...ctx.deps, db: failing });
		try {
			const response = await app.inject({ method: 'GET', url: '/health' });
			expect(response.statusCode).toBe(503);
			expect(response.json()).toEqual({ ok: false });
			expect(response.body).not.toMatch(/ECONNREFUSED|postgres|5432/);
		} finally {
			await app.close();
		}
	});

	it('is the only route besides the webhooks reachable without the internal token', async () => {
		for (const url of ['/healthz', '/health/../admin/session', '/healthy']) {
			const response = await ctx.app.inject({ method: 'GET', url });
			expect(response.statusCode, url).toBe(401);
		}
		const withQuery = await ctx.app.inject({ method: 'GET', url: '/health?probe=1' });
		expect(withQuery.statusCode).toBe(200);
		const internal = await ctx.app.inject({ method: 'GET', url: '/health', headers: { 'x-internal-token': INTERNAL_TOKEN } });
		expect(internal.statusCode).toBe(200);
	});
});

describe('listening', () => {
	function fakeApp(refuse: string[]) {
		const calls: string[] = [];
		return {
			calls,
			async listen({ host }: { port: number; host: string }) {
				calls.push(host);
				if (refuse.includes(host)) throw Object.assign(new Error(`listen EAFNOSUPPORT ${host}`), { code: 'EAFNOSUPPORT' });
				return `http://${host}`;
			}
		};
	}

	it('listens on :: so the IPv6 private network and IPv4 both reach it', async () => {
		const app = fakeApp([]);
		expect(await listenDualStack(app, 3001)).toBe('::');
		expect(app.calls).toEqual(['::']);
	});

	it('falls back to 0.0.0.0 where the host has no IPv6', async () => {
		const app = fakeApp(['::']);
		expect(await listenDualStack(app, 3001)).toBe('0.0.0.0');
		expect(app.calls).toEqual(['::', '0.0.0.0']);
	});

	it('uses API_HOST as given, without a fallback', async () => {
		const app = fakeApp(['127.0.0.1']);
		await expect(listenDualStack(app, 3001, '127.0.0.1')).rejects.toThrow('EAFNOSUPPORT');
		expect(app.calls).toEqual(['127.0.0.1']);
	});
});
