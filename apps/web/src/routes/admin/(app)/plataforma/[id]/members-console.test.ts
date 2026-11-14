import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The members tab of a platform organization (odd/tasks/draw-room.md T4, S3):
// "Agregar persona" with a role, "Conductor del sorteo" included, a role change
// and removing or giving back the access of a member. The API decides; the page
// forwards the form and shows the answer.

const adminApi = vi.fn();
const page = { url: new URL('https://consola.test/admin/plataforma/org?tab=miembros') };
vi.mock('#lib/server/admin.js', () => ({ adminApi: (...args: unknown[]) => adminApi(...args), adminLoad: vi.fn() }));
vi.mock('#lib/server/site.js', () => ({ invalidateSite: vi.fn() }));
vi.mock('$app/state', () => ({ page }));

const { actions } = await import('./+page.server');
const OrganizationPage = (await import('./+page.svelte')).default;

const ORG = '6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7';
const OWNER = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';

function postEvent(action: string, fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		params: { id: ORG },
		url: new URL(`https://consola.test/admin/plataforma/${ORG}?tab=miembros`),
		request: new Request(`https://consola.test/admin/plataforma/${ORG}?tab=miembros&/${action}`, { method: 'POST', body })
	} as never;
}

const organization = {
	id: ORG,
	name: 'Taller Demo',
	slug: 'taller-demo',
	status: 'active',
	orderPrefix: 'TD',
	timezone: 'America/Argentina/Buenos_Aires',
	contact: {},
	social: {},
	domains: [],
	members: [
		{ userId: OWNER, email: 'duenio@taller.test', alias: null, role: 'org_owner', status: 'active' },
		{ userId: HOST, email: 'conductor@taller.test', alias: 'Conductor', role: 'draw_host', status: 'disabled' }
	],
	integrations: [],
	webhookUrl: `https://api.test/webhooks/mercadopago/${ORG}`,
	lastWebhook: null,
	theme: {}
};

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

function renderPage(form: Record<string, unknown> | null = null) {
	return render(OrganizationPage, { props: { data: { organization }, form } as never }).body;
}

beforeEach(() => adminApi.mockReset());

describe('members actions', () => {
	it('adds a person with a role and shows a new account temporary password once', async () => {
		adminApi.mockResolvedValue({ ok: true, status: 201, data: { member: { email: 'nuevo@taller.test', role: 'draw_host', created: true, temporaryPassword: 'Temp-123456789012345678' } } });
		const result = await actions.addMember!(postEvent('addMember', { email: ' nuevo@taller.test ', role: 'draw_host' }));
		expect(adminApi).toHaveBeenCalledWith(expect.anything(), `/platform/organizations/${ORG}/members`, { method: 'POST', body: { email: 'nuevo@taller.test', role: 'draw_host' } });
		expect(result).toEqual({ action: 'members', ok: true, message: 'Cuenta creada para nuevo@taller.test y agregada a la organización.', temporaryPassword: 'Temp-123456789012345678' });
		expect(text(renderPage(result as never))).toContain('Contraseña temporal (se muestra una sola vez): Temp-123456789012345678');
	});

	it('keeps what was typed when the API refuses, with its message', async () => {
		adminApi.mockResolvedValue({ ok: false, status: 409, code: 'member_exists', message: 'Esa persona ya es miembro de la organización: cambiale el rol desde la lista' });
		const result = (await actions.addMember!(postEvent('addMember', { email: 'conductor@taller.test', role: 'auditor' }))) as { status: number; data: Record<string, unknown> };
		expect(result.status).toBe(409);
		expect(result.data).toEqual({ action: 'members', ok: false, message: 'Esa persona ya es miembro de la organización: cambiale el rol desde la lista', email: 'conductor@taller.test', role: 'auditor' });
		const html = renderPage(result.data);
		expect(html).toContain('value="conductor@taller.test"');
		expect(text(html)).toContain('Esa persona ya es miembro de la organización');
	});

	it('changes a role and removes an access through the API', async () => {
		adminApi.mockResolvedValue({ ok: true, status: 200, data: organization });
		expect(await actions.updateMember!(postEvent('updateMember', { userId: HOST, role: 'draw_host' }))).toEqual({ action: 'members', ok: true, message: 'Rol actualizado.' });
		expect(adminApi).toHaveBeenLastCalledWith(expect.anything(), `/platform/organizations/${ORG}/members/${HOST}`, { method: 'PATCH', body: { role: 'draw_host' } });
		expect(await actions.updateMember!(postEvent('updateMember', { userId: OWNER, status: 'disabled' }))).toEqual({
			action: 'members',
			ok: true,
			message: 'Acceso desactivado: ya no entra al panel de esta organización.'
		});
		expect(adminApi).toHaveBeenLastCalledWith(expect.anything(), `/platform/organizations/${ORG}/members/${OWNER}`, { method: 'PATCH', body: { status: 'disabled' } });
	});
});

describe('members tab', () => {
	it('lists each member with a role select including the draw host, and the add form', () => {
		const html = renderPage();
		const plain = text(html);
		expect(plain).toContain('duenio@taller.test');
		expect(plain).toContain('Conductor conductor@taller.test Sin acceso');
		expect(html).toMatch(/<option value="draw_host"[^>]*>Conductor del sorteo<\/option>/);
		expect(html).toMatch(/<option value="draw_host" selected[^>]*>Conductor del sorteo<\/option>/);
		expect(plain).toContain('Quitar acceso');
		expect(plain).toContain('Devolver acceso');
		expect(plain).toContain('Agregar persona');
		expect(html).toContain('action="?tab=miembros&amp;/addMember"');
	});
});
