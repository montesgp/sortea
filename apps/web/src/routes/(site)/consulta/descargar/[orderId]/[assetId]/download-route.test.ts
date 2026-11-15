import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner feedback 2026-11-15b S8: from Consultar, a file downloads through a plain link, like the
// email's: this route asks the API for a download grant with the lookup session and sends the
// browser to /descargas/<token>, the page the emailed links open.

const api = vi.fn();
vi.mock('#lib/server/api.js', () => ({ api: (...args: unknown[]) => api(...args) }));
const { GET } = await import('./+server.js');

const orderId = '00000000-0000-4000-8000-0000000000aa';
const assetId = '00000000-0000-4000-8000-0000000000bb';
const event = (params: Record<string, string>, cookie: string | null = 'session-token') =>
	({ params, cookies: { get: (name: string) => (name === 'sortea_lookup' ? (cookie ?? undefined) : undefined) } }) as never;

/** What SvelteKit's redirect or error throws, as { status, location } or { status, message }. */
async function outcome(run: () => unknown) {
	try {
		await run();
		return null;
	} catch (thrown) {
		const value = thrown as { status: number; location?: string; body?: { message: string } };
		return value.location ? { status: value.status, location: value.location } : { status: value.status, message: value.body?.message };
	}
}

beforeEach(() => api.mockReset());

describe('Consultar download link (S8)', () => {
	it('opens the grant like an emailed link', async () => {
		api.mockResolvedValue({ ok: true, data: { token: 'grant-token-123' } });
		expect(await outcome(() => GET(event({ orderId, assetId })))).toEqual({ status: 303, location: '/descargas/grant-token-123' });
		expect(api).toHaveBeenCalledWith(expect.anything(), '/lookup/downloads', { method: 'POST', lookupToken: 'session-token', body: { orderId, assetId } });
	});

	it('sends back to Consultar without a session, and asks nothing of the API', async () => {
		expect(await outcome(() => GET(event({ orderId, assetId }, null)))).toEqual({ status: 303, location: '/consulta' });
		expect(api).not.toHaveBeenCalled();
	});

	it('refuses ids that are not ids, and a file the API does not grant', async () => {
		expect(await outcome(() => GET(event({ orderId: 'x', assetId })))).toMatchObject({ status: 404 });
		expect(api).not.toHaveBeenCalled();
		api.mockResolvedValue({ ok: false, status: 404, message: 'Archivo no disponible' });
		expect(await outcome(() => GET(event({ orderId, assetId })))).toEqual({ status: 404, message: 'Archivo no disponible' });
	});
});
