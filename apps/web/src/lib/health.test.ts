import { describe, expect, it } from 'vitest';
import { healthResponse } from './health';

describe('web health check (/healthz, README "Deploy")', () => {
	it('answers 200 on GET and HEAD, without asking the API or caching', async () => {
		const get = healthResponse('GET', '/healthz');
		expect(get?.status).toBe(200);
		expect(get?.headers.get('cache-control')).toBe('no-store');
		expect(await get?.text()).toBe('ok');
		expect(healthResponse('HEAD', '/healthz')?.status).toBe(200);
	});

	it('leaves every other request to the site', () => {
		expect(healthResponse('GET', '/')).toBeNull();
		expect(healthResponse('GET', '/healthz/')).toBeNull();
		expect(healthResponse('GET', '/health')).toBeNull();
		expect(healthResponse('POST', '/healthz')).toBeNull();
	});
});
