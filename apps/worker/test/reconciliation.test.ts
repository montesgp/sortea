import { describe, expect, it } from 'vitest';
import { createReconciliationTrigger } from '../src/reconciliation';

describe('scheduled reconciliation trigger', () => {
	it('asks the API to run what is due, with the internal token', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const trigger = createReconciliationTrigger({
			apiUrl: 'http://api.internal:3001',
			internalToken: 'internal-token-0123456789',
			intervalMinutes: 30,
			fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} });
				return Response.json({ results: [{ status: 'completed', discrepancies: 2 }, { status: 'not_due' }, { status: 'completed', discrepancies: 0 }] });
			}) as typeof fetch
		});

		expect(await trigger()).toBe('completed=2 not_due=1, 2 differences');
		expect(calls[0]!.url).toBe('http://api.internal:3001/internal/reconciliation/run-due');
		expect(new Headers(calls[0]!.init.headers).get('x-internal-token')).toBe('internal-token-0123456789');
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ intervalMinutes: 30 });
	});

	it('fails loudly when the API refuses', async () => {
		const trigger = createReconciliationTrigger({
			apiUrl: 'http://api.internal:3001',
			internalToken: 'wrong',
			intervalMinutes: 30,
			fetchImpl: (async () => new Response(null, { status: 401 })) as typeof fetch
		});
		await expect(trigger()).rejects.toThrow('HTTP 401');
	});
});
