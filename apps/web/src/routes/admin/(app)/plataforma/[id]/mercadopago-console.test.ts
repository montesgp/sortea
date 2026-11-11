import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Mercado Pago tab of a platform organization (odd/tasks/console-polish-2026-11-11.md,
// S1, S4-S6): the principal and the backup side by side, each verified on its own,
// "Usar como principal" in two steps with the platform admin's authenticator code,
// and the primary domain's pill spaced and green.

const adminApi = vi.fn();
const invalidateSite = vi.fn();
const page = { url: new URL('https://consola.test/admin/plataforma/org?tab=mercadopago') };
vi.mock('#lib/server/admin.js', () => ({ adminApi: (...args: unknown[]) => adminApi(...args), adminLoad: vi.fn() }));
vi.mock('#lib/server/site.js', () => ({ invalidateSite: (...args: unknown[]) => invalidateSite(...args) }));
vi.mock('$app/state', () => ({ page }));

const { actions } = await import('./+page.server');
const OrganizationPage = (await import('./+page.svelte')).default;

const ORG = '6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7';
const PRINCIPAL = '11111111-1111-4111-8111-111111111111';
const BACKUP = '22222222-2222-4222-8222-222222222222';
const PREVIOUS = '33333333-3333-4333-8333-333333333333';

function postEvent(action: string, fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		params: { id: ORG },
		url: new URL(`https://consola.test/admin/plataforma/${ORG}?tab=mercadopago`),
		request: new Request(`https://consola.test/admin/plataforma/${ORG}?tab=mercadopago&/${action}`, { method: 'POST', body })
	} as never;
}

const account = (id: string, role: 'principal' | 'backup' | 'previous', overrides: Record<string, unknown> = {}) => ({
	id,
	provider: 'mercadopago',
	mode: 'sandbox',
	status: 'verified',
	role,
	isActive: role === 'principal',
	retiredAt: role === 'previous' ? '2026-11-01T12:00:00.000Z' : null,
	secretHint: 'TEST••••abcd',
	collectorId: `collector-${role}`,
	simulator: false,
	testUser: false,
	version: 1,
	keyVersion: 1,
	lastVerifiedAt: '2026-11-11T12:00:00.000Z',
	lastError: null,
	lastWebhook: null,
	...overrides
});

const organization = (integrations: unknown[], overrides: Record<string, unknown> = {}) => ({
	id: ORG,
	name: 'Taller Demo',
	slug: 'taller-demo',
	status: 'active',
	orderPrefix: 'TD',
	timezone: 'America/Argentina/Buenos_Aires',
	contact: {},
	social: {},
	domains: [
		{ hostname: 'www.una-organizacion-con-un-nombre-muy-largo.example.com', isPrimary: true, verifiedAt: null },
		{ hostname: 'tallerdemo.test', isPrimary: false, verifiedAt: null }
	],
	members: [],
	integrations,
	webhookUrl: `https://api.test/webhooks/mercadopago/${ORG}`,
	lastWebhook: null,
	theme: {},
	...overrides
});

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

function renderPage(org: ReturnType<typeof organization>, form: Record<string, unknown> | null = null, tab = 'mercadopago') {
	page.url = new URL(`https://consola.test/admin/plataforma/${ORG}?tab=${tab}`);
	return render(OrganizationPage, { props: { data: { organization: org }, form } as never }).body;
}

/** The markup of the group labelled by the heading with this text. */
function group(html: string, heading: string): string {
	const title = new RegExp(`<h3 id="([^"]+)"[^>]*>${heading}</h3>`).exec(html);
	expect(title, heading).not.toBeNull();
	const start = html.lastIndexOf('<div', title!.index);
	const opening = html.slice(start, html.indexOf('>', start) + 1);
	expect(opening).toContain(`aria-labelledby="${title![1]}"`);
	let depth = 0;
	const tag = /<\/?div\b[^>]*>/g;
	tag.lastIndex = start;
	for (let match = tag.exec(html); match; match = tag.exec(html)) {
		depth += match[0].startsWith('</') ? -1 : 1;
		if (depth === 0) return html.slice(start, match.index + match[0].length);
	}
	throw new Error(`unclosed group ${heading}`);
}

beforeEach(() => {
	adminApi.mockReset();
	invalidateSite.mockReset();
});

describe('Mercado Pago actions (S4-S6)', () => {
	it('connects a backup account with role backup, and says it does not charge yet', async () => {
		adminApi.mockResolvedValue({ ok: true, status: 200, data: organization([account(PRINCIPAL, 'principal'), account(BACKUP, 'backup')]) });
		const result = await actions.mercadopago!(postEvent('mercadopago', { role: 'backup', mode: 'sandbox', accessToken: ' TEST-token ', webhookSecret: ' whsec-0123456789abcdef ' }));
		expect(adminApi).toHaveBeenCalledWith(expect.anything(), `/platform/organizations/${ORG}/integrations/mercadopago`, {
			method: 'PUT',
			body: { mode: 'sandbox', accessToken: 'TEST-token', webhookSecret: 'whsec-0123456789abcdef', publicKey: undefined, role: 'backup' }
		});
		expect(result).toEqual({
			action: 'mercadopago',
			ok: true,
			message: 'Cuenta de respaldo conectada: Mercado Pago confirmó las credenciales. No cobra hasta que uses «Usar como principal».'
		});
	});

	it('connects the first account as the principal', async () => {
		adminApi.mockResolvedValue({ ok: true, status: 200, data: organization([account(PRINCIPAL, 'principal')]) });
		const result = await actions.mercadopago!(postEvent('mercadopago', { mode: 'sandbox', accessToken: 'TEST-token', webhookSecret: 'whsec-0123456789abcdef' }));
		expect(adminApi.mock.calls[0]![2].body.role).toBe('principal');
		expect(result).toEqual({ action: 'mercadopago', ok: true, message: 'Cuenta conectada: Mercado Pago confirmó las credenciales y ya se puede cobrar.' });
	});

	it('verifies the account it is asked for and reports its result on that account', async () => {
		adminApi.mockResolvedValue({ ok: true, status: 200, data: organization([account(PRINCIPAL, 'principal'), account(BACKUP, 'backup')]) });
		const verified = await actions.verify!(postEvent('verify', { integrationId: BACKUP }));
		expect(adminApi).toHaveBeenCalledWith(expect.anything(), `/platform/organizations/${ORG}/integrations/mercadopago/${BACKUP}/verify`, { method: 'POST' });
		expect(verified).toEqual({ action: 'verify', integrationId: BACKUP, ok: true, message: 'Conexión verificada: Mercado Pago respondió por la cuenta collector-backup.' });

		adminApi.mockResolvedValue({ ok: true, status: 200, data: organization([account(PRINCIPAL, 'principal'), account(BACKUP, 'backup', { status: 'error', lastError: 'HTTP 401' })]) });
		expect(await actions.verify!(postEvent('verify', { integrationId: BACKUP }))).toEqual({
			action: 'verify',
			integrationId: BACKUP,
			ok: false,
			message: 'Mercado Pago no aceptó las credenciales de esta cuenta (HTTP 401). Cargá credenciales nuevas en «Actualizar credenciales».'
		});
	});

	it('"Usar como principal" first shows what will happen and asks for the code, without calling the API', async () => {
		expect(await actions.activate!(postEvent('activate', { integrationId: BACKUP }))).toEqual({ action: 'activate', confirm: BACKUP });
		expect(adminApi).not.toHaveBeenCalled();
	});

	it('asks again for a missing or malformed code, keeping the confirmation open', async () => {
		for (const code of ['', '12345', 'abcdef']) {
			const result = (await actions.activate!(postEvent('activate', { integrationId: BACKUP, confirm: 'yes', code }))) as { status: number; data: unknown };
			expect([result.status, result.data]).toEqual([
				400,
				{ action: 'activate', confirm: BACKUP, ok: false, message: 'Ingresá los 6 dígitos que muestra tu app de autenticación.' }
			]);
		}
		expect(adminApi).not.toHaveBeenCalled();
	});

	it('switches with the code and says the former principal is now the backup', async () => {
		adminApi.mockResolvedValue({ ok: true, status: 200, data: organization([account(BACKUP, 'principal'), account(PRINCIPAL, 'backup')]) });
		const result = await actions.activate!(postEvent('activate', { integrationId: BACKUP, confirm: 'yes', code: ' 123456 ', from: 'backup' }));
		expect(adminApi).toHaveBeenCalledWith(expect.anything(), `/platform/organizations/${ORG}/integrations/mercadopago/${BACKUP}/activate`, {
			method: 'POST',
			body: { code: '123456' }
		});
		expect(result).toEqual({
			action: 'activate',
			ok: true,
			message:
				'La cuenta de respaldo ahora es la principal: las compras nuevas se cobran con ella. La que cobraba quedó como respaldo, y las compras ya iniciadas siguen con la cuenta con la que se crearon.'
		});
	});

	it('reactivates a previous account with the code', async () => {
		adminApi.mockResolvedValue({ ok: true, status: 200, data: organization([account(PREVIOUS, 'principal'), account(PRINCIPAL, 'previous')]) });
		const result = await actions.activate!(postEvent('activate', { integrationId: PREVIOUS, confirm: 'yes', code: '654321', from: 'previous' }));
		expect(result).toEqual({
			action: 'activate',
			ok: true,
			message:
				'La cuenta volvió a estar activa: Mercado Pago confirmó sus credenciales. Las compras nuevas se cobran con esta cuenta; las ya iniciadas siguen con la cuenta con la que se crearon.'
		});
	});

	it("shows the API's refusal of the code and keeps the confirmation open", async () => {
		adminApi.mockResolvedValue({ ok: false, status: 400, message: 'El código de tu app de autenticación no es válido, o ya se usó. No se cambió nada: probá con el código que muestra ahora.' });
		const result = (await actions.activate!(postEvent('activate', { integrationId: BACKUP, confirm: 'yes', code: '000000', from: 'backup' }))) as { status: number; data: unknown };
		expect([result.status, result.data]).toEqual([
			400,
			{ action: 'activate', confirm: BACKUP, ok: false, message: 'El código de tu app de autenticación no es válido, o ya se usó. No se cambió nada: probá con el código que muestra ahora.' }
		]);
	});
});

describe('disconnecting needs the code (S5)', () => {
	it('first shows what will happen, without calling the API', async () => {
		expect(await actions.disconnect!(postEvent('disconnect', {}))).toEqual({ action: 'disconnect', confirm: 'yes' });
		expect(adminApi).not.toHaveBeenCalled();
	});

	it('asks again for a missing or malformed code, keeping the confirmation open', async () => {
		for (const code of ['', '12345', 'abcdef']) {
			const result = (await actions.disconnect!(postEvent('disconnect', { confirm: 'yes', code }))) as { status: number; data: unknown };
			expect([result.status, result.data]).toEqual([
				400,
				{ action: 'disconnect', confirm: 'yes', ok: false, message: 'Ingresá los 6 dígitos que muestra tu app de autenticación.' }
			]);
		}
		expect(adminApi).not.toHaveBeenCalled();
	});

	it('disconnects with the code', async () => {
		adminApi.mockResolvedValue({ ok: true, status: 200, data: organization([]) });
		const result = await actions.disconnect!(postEvent('disconnect', { confirm: 'yes', code: ' 123456 ' }));
		expect(adminApi).toHaveBeenCalledWith(expect.anything(), `/platform/organizations/${ORG}/integrations/mercadopago`, { method: 'DELETE', body: { code: '123456' } });
		expect(result).toEqual({ action: 'disconnect', ok: true, message: 'Mercado Pago desvinculado: se borraron las credenciales de todas las cuentas y el sitio dejó de cobrar.' });
	});

	it("shows the API's refusal and keeps the confirmation open", async () => {
		adminApi.mockResolvedValue({ ok: false, status: 409, message: 'Hay 1 pago en curso.' });
		const result = (await actions.disconnect!(postEvent('disconnect', { confirm: 'yes', code: '123456' }))) as { status: number; data: unknown };
		expect([result.status, result.data]).toEqual([409, { action: 'disconnect', confirm: 'yes', ok: false, message: 'Hay 1 pago en curso.' }]);
	});

	it('the second step says what will happen and asks for the authenticator code', () => {
		const html = renderPage(organization([account(PRINCIPAL, 'principal'), account(BACKUP, 'backup')]), { action: 'disconnect', confirm: 'yes' });
		const shown = text(html);
		expect(shown).toContain('¿Desvincular Mercado Pago?');
		expect(shown).toContain('Se borran todas las cuentas, la principal, la de respaldo y las anteriores, con sus credenciales.');
		expect(shown).toContain('El sitio deja de cobrar en el acto.');
		expect(shown).toContain('Confirmar desvinculación');
		expect(html).toMatch(/<form[^>]*action="\?tab=mercadopago&amp;\/disconnect"[\s\S]*?name="code"[^>]*autocomplete="one-time-code"/);
	});

	it('the first step is a single button', () => {
		const html = renderPage(organization([account(PRINCIPAL, 'principal')]));
		expect(text(html)).toContain('Desvincular cuenta');
		expect(text(html)).not.toContain('Confirmar desvinculación');
		expect(html).not.toContain('Entiendo que se borran las credenciales');
	});
});

describe('Mercado Pago tab layout (S4)', () => {
	it('shows the principal and the backup side by side, each with its status, merchant, last notification, verification and credentials', () => {
		const html = renderPage(
			organization([
				account(PRINCIPAL, 'principal', { lastWebhook: { receivedAt: '2026-11-11T13:00:00.000Z', topic: 'order', signatureValid: true, outcome: 'paid' } }),
				account(BACKUP, 'backup'),
				account(PREVIOUS, 'previous')
			])
		);
		expect(html).toMatch(/<section class="panel wide[^"]*"/);
		expect(html).toMatch(/<div class="accounts[^"]*">/);
		const principal = group(html, 'Cuenta principal');
		const backup = group(html, 'Cuenta de respaldo');
		for (const card of [principal, backup]) {
			expect(card).toMatch(/<span class="chip ok[^"]*">Verificada<\/span>/);
			expect(text(card)).toContain('Sandbox');
			expect(text(card)).toContain('Verificar conexión');
			expect(text(card)).toContain('Actualizar credenciales');
		}
		expect(principal).toMatch(/<span class="chip ok[^"]*">Activa<\/span>/);
		expect(text(principal)).toContain('Cuenta collector-principal.');
		expect(text(principal)).toContain('Firma válida');
		expect(text(principal)).not.toContain('Usar como principal');
		expect(text(backup)).toContain('Cuenta collector-backup.');
		expect(text(backup)).toContain('Sin notificaciones de esta cuenta todavía.');
		expect(text(backup)).toContain('Usar como principal');
		expect(backup).toContain(`name="integrationId" value="${BACKUP}"`);

		// The notification URL and its steps are shared, shown once.
		expect(html.split(`value="https://api.test/webhooks/mercadopago/${ORG}"`)).toHaveLength(2);
		expect(text(html)).toContain('Cuentas anteriores');
		expect(text(html)).toContain('Volver a usar esta cuenta');
		expect(text(html)).toContain('Desvincular cuenta');
		// Switching goes through the backup: no form connects another principal.
		expect(text(html)).not.toContain('Cambiar de cuenta');
	});

	it('an empty backup slot offers "Conectar cuenta de respaldo" with the connect form', () => {
		const html = renderPage(organization([account(PRINCIPAL, 'principal')]));
		const slot = group(html, 'Cuenta de respaldo');
		expect(slot).toContain('name="role" value="backup"');
		for (const field of ['name="mode"', 'name="accessToken"', 'name="webhookSecret"']) expect(slot).toContain(field);
		expect(text(slot)).toContain('Conectar cuenta de respaldo');
		expect(text(slot)).not.toContain('Usar como principal');
	});

	it('without any account it offers the first connection only', () => {
		const html = renderPage(organization([]));
		expect(text(html)).toContain('Sin credenciales: esta organización todavía no puede cobrar.');
		expect(text(html)).toContain('Conectar cuenta');
		expect(text(html)).not.toContain('Conectar cuenta de respaldo');
		expect(html).not.toContain('name="role" value="backup"');
	});

	it('"Usar como principal" in its second step says what will happen and asks for the authenticator code', () => {
		const html = renderPage(organization([account(PRINCIPAL, 'principal'), account(BACKUP, 'backup')]), { action: 'activate', confirm: BACKUP });
		const backup = text(group(html, 'Cuenta de respaldo'));
		expect(backup).toContain('Las compras nuevas se cobran con la cuenta collector-backup.');
		expect(backup).toContain('Las compras ya iniciadas siguen con la cuenta con la que se crearon.');
		expect(backup).toContain('La cuenta collector-principal queda como respaldo.');
		expect(backup).toContain('Código de tu app de autenticación');
		expect(backup).toContain('Confirmar cambio');
		expect(backup).toContain('Cancelar');
		expect(group(html, 'Cuenta de respaldo')).toMatch(/<input[^>]*name="code"[^>]*autocomplete="one-time-code"/);
		expect(html).toContain('name="confirm" value="yes"');
	});

	it('shows a rejected signature once, in the shared notifications box', () => {
		const html = renderPage(
			organization([account(PRINCIPAL, 'principal'), account(BACKUP, 'backup')], {
				lastWebhook: { receivedAt: '2026-11-11T13:00:00.000Z', topic: 'order', signatureValid: false, outcome: 'rejected_signature' }
			})
		);
		expect(html.split('Firma rechazada')).toHaveLength(2);
		expect(text(group(html, 'Cuenta principal'))).not.toContain('Firma rechazada');
	});
});

describe('domains tab (S1)', () => {
	it('separates the "Principal" pill from the hostname and gives it the success tone', () => {
		// Without Svelte's hydration markers.
		const html = renderPage(organization([]), null, 'dominios').replace(/<!--[\s\S]*?-->/g, '');
		expect(html).toMatch(
			/<span class="host[^"]*"><span class="hostname[^"]*">www\.una-organizacion-con-un-nombre-muy-largo\.example\.com<\/span> ?<span class="chip ok[^"]*">Principal<\/span><\/span>/
		);
		expect(html.split('>Principal<')).toHaveLength(2);
	});
});
