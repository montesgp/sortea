import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner feedback 2026-11-10 (odd/tasks/owner-feedback-2026-11-10.md): the
// platform organization page is split in tabs that survive posts and reloads
// (S2), and suspending or reactivating an organization asks first (S13).

const adminApi = vi.fn();
const invalidateSite = vi.fn();
vi.mock('#lib/server/admin.js', () => ({ adminApi: (...args: unknown[]) => adminApi(...args), adminLoad: vi.fn() }));
vi.mock('#lib/server/site.js', () => ({ invalidateSite: (...args: unknown[]) => invalidateSite(...args) }));

const { platformTab, platformTabs } = await import('./platform-tabs');
const { actions } = await import('../routes/admin/(app)/plataforma/[id]/+page.server');

const ORG = '6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7';

function statusEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		params: { id: ORG },
		url: new URL(`https://consola.test/admin/plataforma/${ORG}?tab=estado`),
		request: new Request(`https://consola.test/admin/plataforma/${ORG}?tab=estado&/status`, { method: 'POST', body })
	} as never;
}

beforeEach(() => {
	adminApi.mockReset();
	invalidateSite.mockReset();
});

describe('organization page tabs (S2)', () => {
	it('has one tab per box, in order', () => {
		expect(platformTabs.map((tab) => tab.label)).toEqual(['Mercado Pago', 'Contacto', 'Tema', 'Dominios', 'Miembros', 'Estado']);
	});

	it('reads the tab from ?tab=, defaulting to Mercado Pago for a missing or unknown one', () => {
		expect(platformTab(new URLSearchParams('tab=dominios'))).toBe('dominios');
		expect(platformTab(new URLSearchParams('tab=estado'))).toBe('estado');
		expect(platformTab(new URLSearchParams(''))).toBe('mercadopago');
		expect(platformTab(new URLSearchParams('tab=nada'))).toBe('mercadopago');
	});
});

describe('organization status (S13)', () => {
	it('asks for confirmation first and changes nothing', async () => {
		expect(await actions.status!(statusEvent({ status: 'suspended' }))).toEqual({ action: 'status', confirm: 'suspended' });
		expect(await actions.status!(statusEvent({ status: 'active' }))).toEqual({ action: 'status', confirm: 'active' });
		expect(adminApi).not.toHaveBeenCalled();
		expect(invalidateSite).not.toHaveBeenCalled();
	});

	it('suspends once confirmed, and the site of every domain shows it at once', async () => {
		adminApi.mockResolvedValue({ ok: true, status: 200, data: { status: 'suspended', domains: [{ hostname: 'tienda.test' }, { hostname: 'www.tienda.test' }] } });
		const result = await actions.status!(statusEvent({ status: 'suspended', confirm: 'yes' }));
		expect(adminApi).toHaveBeenCalledWith(expect.anything(), `/platform/organizations/${ORG}/status`, { method: 'POST', body: { status: 'suspended' } });
		expect(result).toEqual({
			action: 'status',
			ok: true,
			message: 'Organización suspendida: el sitio muestra «Este sitio está pausado momentáneamente» y no vende. El equipo de plataforma sigue entrando a esta consola.'
		});
		expect(invalidateSite.mock.calls).toEqual([['tienda.test'], ['www.tienda.test']]);
	});

	it('reactivates once confirmed', async () => {
		adminApi.mockResolvedValue({ ok: true, status: 200, data: { status: 'active', domains: [{ hostname: 'tienda.test' }] } });
		const result = await actions.status!(statusEvent({ status: 'active', confirm: 'yes' }));
		expect(result).toEqual({ action: 'status', ok: true, message: 'Organización reactivada: el sitio vuelve a publicarse y a vender.' });
		expect(invalidateSite.mock.calls).toEqual([['tienda.test']]);
	});

	it('refuses an unknown status without calling the API', async () => {
		const result = (await actions.status!(statusEvent({ status: 'deleted', confirm: 'yes' }))) as { status: number; data: unknown };
		expect([result.status, result.data]).toEqual([400, { action: 'status', ok: false, message: 'Estado desconocido' }]);
		expect(adminApi).not.toHaveBeenCalled();
	});
});
