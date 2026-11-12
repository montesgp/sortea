import type { Cookies } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner feedback 2026-11-11b, S7: "No encontramos tu compra en este navegador" right after a purchase.
// The page polls the status while it waits; a refused or failed status request is not "no order".

const api = vi.fn();
vi.mock('#lib/server/api.js', () => ({ api: (...args: unknown[]) => api(...args) }));
vi.mock('$app/env', () => ({ dev: true }));

const { load } = await import('./+page.server');

function event(receipt: unknown, ref?: string) {
	const cookies = { get: () => (receipt ? JSON.stringify(receipt) : undefined) } as unknown as Cookies;
	return { cookies, url: new URL(`https://demo.test/checkout/resultado${ref ? `?ref=${ref}` : ''}`) } as never;
}

const receipt = { reference: 'MG-NBAK33CK', accessCode: 'Y6GZQ6SUXF' };
const unknown = { order: null, accessCode: null, reference: null, unavailable: false };

beforeEach(() => api.mockReset());

describe('result page load', () => {
	it('shows the order the browser holds', async () => {
		api.mockResolvedValue({ ok: true, status: 200, data: { reference: 'MG-NBAK33CK', status: 'expired' } });
		expect(await load(event(receipt, 'MG-NBAK33CK'))).toEqual({ order: { reference: 'MG-NBAK33CK', status: 'expired' }, accessCode: 'Y6GZQ6SUXF', reference: 'MG-NBAK33CK', unavailable: false });
	});

	it('a status the API cannot give now (rate limit, outage) keeps the order known to this browser', async () => {
		for (const status of [429, 503]) {
			api.mockResolvedValue({ ok: false, status, code: 'x', message: 'x' });
			expect(await load(event(receipt, 'MG-NBAK33CK'))).toEqual({ order: null, accessCode: 'Y6GZQ6SUXF', reference: 'MG-NBAK33CK', unavailable: true });
		}
	});

	it("without a receipt, or with another order's, the browser has no order", async () => {
		expect(await load(event(null, 'MG-NBAK33CK'))).toEqual(unknown);
		expect(await load(event(receipt, 'MG-OTHER000'))).toEqual(unknown);
		expect(api).not.toHaveBeenCalled();
	});

	it('an order the API does not know is not found', async () => {
		api.mockResolvedValue({ ok: false, status: 404, code: 'order_not_found', message: 'x' });
		expect(await load(event(receipt))).toEqual(unknown);
	});
});
