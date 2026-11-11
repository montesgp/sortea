import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner feedback 2026-11-10 S11: everything about the signed-in user lives in one
// account section (password, two-step verification, theme, sign out), reached
// from the user menu; the main navigation keeps only the panel's sections.
const authSession = vi.fn();
const trustedDeviceCount = vi.fn();
const forgetTrustedDevices = vi.fn();
vi.mock('#lib/server/admin-session.js', () => ({
	authSession: (...args: unknown[]) => authSession(...args),
	trustedDeviceCount: (...args: unknown[]) => trustedDeviceCount(...args),
	forgetTrustedDevices: (...args: unknown[]) => forgetTrustedDevices(...args)
}));
vi.mock('$app/env', () => ({ dev: false }));
vi.mock('$app/state', () => ({ page: { url: new URL('https://demo.localhost/admin/pedidos') } }));

const { actions, load } = await import('./+page.server');
const AccountPage = (await import('./+page.svelte')).default;
const PanelLayout = (await import('../+layout.svelte')).default;

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

function fakeEvent(cookie?: string, form?: Record<string, string>, action = 'theme') {
	const jar = new Map<string, { value: string; options: Record<string, unknown> }>();
	if (cookie !== undefined) jar.set('sortea_admin_mode', { value: cookie, options: {} });
	const deleted: { name: string; options: Record<string, unknown> }[] = [];
	const cookies = {
		get: (name: string) => jar.get(name)?.value,
		set: (name: string, value: string, options: Record<string, unknown>) => void jar.set(name, { value, options }),
		delete: (name: string, options: Record<string, unknown>) => {
			deleted.push({ name, options });
			jar.delete(name);
		}
	};
	const body = new URLSearchParams(form ?? {});
	const event = {
		cookies,
		url: new URL('https://demo.localhost/admin/cuenta'),
		locals: { site: { theme: { css: '', defaultMode: 'light' } }, mode: 'light', followSystem: false },
		getClientAddress: () => '203.0.113.7',
		fetch,
		request: new Request(`https://demo.localhost/admin/cuenta?/${action}`, { method: 'POST', body })
	};
	return { event: event as never, jar, deleted };
}

const session = (assurance: 'password' | 'mfa', totp: { confirmed: boolean; pending: boolean }, mfaRequired = false) => ({
	user: { id: 'u1', email: 'owner@tallerdemo.local' },
	assurance,
	mustChangePassword: false,
	totp,
	mfaRequired,
	expiresAt: new Date(Date.now() + 3_600_000).toISOString()
});

beforeEach(() => {
	authSession.mockReset();
	trustedDeviceCount.mockReset();
	forgetTrustedDevices.mockReset();
	trustedDeviceCount.mockResolvedValue(0);
});

describe('account page load', () => {
	it('picks the stored theme and the state of the second factor', async () => {
		authSession.mockResolvedValue(session('mfa', { confirmed: true, pending: false }));
		const { event } = fakeEvent('dark');
		trustedDeviceCount.mockResolvedValue(2);
		expect(await load(event)).toEqual({ theme: 'dark', twoStep: 'verified', mfaRequired: false, trustedDevices: 2 });
	});

	it('shows the mode the panel has now: the site default without a stored theme, with an invalid one or with the old device setting (S2)', async () => {
		authSession.mockResolvedValue(session('password', { confirmed: false, pending: false }, true));
		expect(await load(fakeEvent().event)).toMatchObject({ theme: 'light', twoStep: 'off', mfaRequired: true });
		expect(await load(fakeEvent('neon').event)).toMatchObject({ theme: 'light' });
		expect(await load(fakeEvent('system').event)).toMatchObject({ theme: 'light' });
	});

	it('tells an unverified session and an unfinished enrolment apart', async () => {
		authSession.mockResolvedValue(session('password', { confirmed: true, pending: false }));
		expect(await load(fakeEvent().event)).toMatchObject({ twoStep: 'unverified' });
		authSession.mockResolvedValue(session('password', { confirmed: false, pending: true }));
		expect(await load(fakeEvent().event)).toMatchObject({ twoStep: 'pending' });
	});

	it('sends someone without a session to sign in', async () => {
		authSession.mockResolvedValue(null);
		await expect(load(fakeEvent().event)).rejects.toMatchObject({ status: 303, location: '/admin/login?next=/admin/cuenta' });
	});
});

describe('theme action', () => {
	it('stores the choice for this browser on /admin and reloads the account page', async () => {
		const { event, jar } = fakeEvent(undefined, { theme: 'light' });
		await expect(actions.theme(event)).rejects.toMatchObject({ status: 303, location: '/admin/cuenta' });
		const cookie = jar.get('sortea_admin_mode')!;
		expect(cookie.value).toBe('light');
		expect(cookie.options).toMatchObject({ path: '/admin', sameSite: 'lax', httpOnly: true, secure: true });
		expect(cookie.options.maxAge).toBe(365 * 24 * 60 * 60);
	});

	it('refuses anything but light or dark, the retired choices included, and keeps the stored choice (S2)', async () => {
		for (const theme of ['neon', 'site', 'system']) {
			const { event, jar, deleted } = fakeEvent('dark', { theme });
			const result = (await actions.theme(event)) as { status: number; data: unknown };
			expect(result, theme).toMatchObject({ status: 400, data: { message: 'Elegí uno de los temas de la lista' } });
			expect(jar.get('sortea_admin_mode')!.value).toBe('dark');
			expect(deleted).toEqual([]);
		}
	});
});

const panelSession = (alias?: string | null) => ({
	user: { id: 'u1', email: 'owner@tallerdemo.local', assurance: 'mfa' as const, ...(alias === undefined ? {} : { alias }) },
	role: 'org_owner',
	permissions: ['dashboard.view', 'orders.view', 'campaigns.view', 'settings.manage'],
	organization: { name: 'Taller Demo', slug: 'taller-demo', timezone: 'America/Argentina/Buenos_Aires', currency: 'ARS' }
});

const accountPage = (data: Record<string, unknown>, form: Record<string, unknown> | null = null) =>
	render(AccountPage, { props: { data: { session: panelSession(), theme: 'dark', twoStep: 'verified', mfaRequired: false, trustedDevices: 0, ...data }, form } as never }).body;

describe('account page', () => {
	it('groups password, two-step verification, theme and sign out', () => {
		const html = accountPage({});
		const shown = text(html);
		expect(html).toMatch(/<h1[^>]*>Mi cuenta<\/h1>/);
		expect(shown).toContain('owner@tallerdemo.local');
		expect(html).toMatch(/<a class="button[^"]*" href="\/admin\/contrasena">Cambiar contraseña<\/a>/);
		expect(shown).toContain('Verificación en dos pasos');
		expect(shown).toContain('Activa');
		expect(html).toMatch(/<form method="POST" action="\/admin\/salir"[^>]*><button class="button[^"]*">Cerrar sesión<\/button><\/form>/);
		expect(html).toMatch(/<form method="POST" action="\?\/theme"/);
		for (const label of ['Claro', 'Oscuro']) expect(shown).toContain(label);
		for (const label of ['Como el sitio', 'Según el sistema']) expect(shown).not.toContain(label);
		expect(html.match(/<input type="radio" name="theme"/g)).toHaveLength(2);
		expect(html).toMatch(/<input type="radio" name="theme" value="dark"[^>]*checked/);
		expect(html).toMatch(/<button class="button[^"]*">Guardar tema<\/button>/);
	});

	it('marks the stored theme as chosen', () => {
		const html = accountPage({ theme: 'light' });
		expect(html).toMatch(/<input type="radio" name="theme" value="light"[^>]*checked/);
		expect(html).not.toMatch(/<input type="radio" name="theme" value="dark"[^>]*checked/);
	});

	it('links each state of the second factor to its next step', () => {
		expect(accountPage({ twoStep: 'off' })).toMatch(/<a class="button[^"]*" href="\/admin\/mfa">Configurar app de autenticación<\/a>/);
		expect(accountPage({ twoStep: 'pending' })).toMatch(/<a class="button[^"]*" href="\/admin\/mfa">Continuar la configuración<\/a>/);
		expect(accountPage({ twoStep: 'unverified' })).toMatch(/<a class="button[^"]*" href="\/admin\/mfa">Verificar esta sesión<\/a>/);
		expect(accountPage({ twoStep: 'verified' })).not.toContain('href="/admin/mfa"');
	});

	it('shows the alias when the account has one', () => {
		const shown = text(render(AccountPage, { props: { data: { session: panelSession('Patri'), theme: 'dark', twoStep: 'verified', mfaRequired: false, trustedDevices: 0 }, form: null } as never }).body);
		expect(shown).toContain('Patri');
		expect(shown).toContain('owner@tallerdemo.local');
	});
});

// Remember this device for 30 days (odd/tasks/launch-prep-2026-11-10.md, S1): the
// account page says how many browsers skip the code and forgets them in two steps.
describe('remembered devices', () => {
	it('"Olvidar" asks first, and only "Sí, olvidarlos" forgets them and clears this browser', async () => {
		const first = fakeEvent(undefined, {}, 'forgetDevices');
		expect(await actions.forgetDevices(first.event)).toEqual({ action: 'forgetDevices', confirm: true });
		expect(forgetTrustedDevices).not.toHaveBeenCalled();

		forgetTrustedDevices.mockResolvedValue({ ok: true, status: 200, data: { forgotten: 2 } });
		const second = fakeEvent(undefined, { confirm: 'yes' }, 'forgetDevices');
		expect(await actions.forgetDevices(second.event)).toEqual({ action: 'forgetDevices', ok: true, message: 'Listo: olvidamos 2 dispositivos. La próxima vez te vamos a pedir el código en cada uno.' });
		expect(forgetTrustedDevices).toHaveBeenCalledWith(second.event);

		forgetTrustedDevices.mockResolvedValue({ ok: true, status: 200, data: { forgotten: 1 } });
		expect(await actions.forgetDevices(fakeEvent(undefined, { confirm: 'yes' }, 'forgetDevices').event)).toMatchObject({ message: 'Listo: olvidamos 1 dispositivo. La próxima vez te vamos a pedir el código en cada uno.' });
	});

	it('reports a failure of the API', async () => {
		forgetTrustedDevices.mockResolvedValue({ ok: false, status: 503, code: 'api_unreachable', message: 'El servicio no está disponible en este momento. Probá de nuevo en unos minutos' });
		const result = (await actions.forgetDevices(fakeEvent(undefined, { confirm: 'yes' }, 'forgetDevices').event)) as { status: number; data: unknown };
		expect(result).toMatchObject({ status: 503, data: { action: 'forgetDevices', ok: false, message: 'El servicio no está disponible en este momento. Probá de nuevo en unos minutos' } });
	});

	it('shows how many are active, with the button only when there are some', () => {
		const some = accountPage({ trustedDevices: 2 });
		expect(text(some)).toContain('Dispositivos recordados');
		expect(text(some)).toContain('2 navegadores entran sin pedirte el código');
		expect(some).toMatch(/<form method="POST" action="\?\/forgetDevices"[^>]*><button class="button[^"]*">Olvidar los dispositivos recordados<\/button><\/form>/);
		expect(text(accountPage({ trustedDevices: 1 }))).toContain('1 navegador entra sin pedirte el código');
		const none = accountPage({ trustedDevices: 0 });
		expect(text(none)).toContain('Ningún navegador entra sin pedirte el código.');
		expect(none).not.toContain('action="?/forgetDevices"');
	});

	it('asks for confirmation in a second form, with a way back', () => {
		const html = accountPage({ trustedDevices: 2 }, { action: 'forgetDevices', confirm: true });
		const confirm = /<form method="POST" action="\?\/forgetDevices"[\s\S]*?<\/form>/.exec(html)![0];
		expect(confirm).toContain('<input type="hidden" name="confirm" value="yes"');
		expect(text(confirm)).toContain('¿Olvidar los 2 dispositivos recordados?');
		expect(confirm).toMatch(/<button class="button[^"]*">Sí, olvidarlos<\/button>/);
		expect(confirm).toMatch(/<a class="button[^"]*" href="\/admin\/cuenta">Cancelar<\/a>/);
	});

	it('says that signing out does not forget this browser', () => {
		expect(text(accountPage({}))).toContain('Cerrar sesión no olvida este navegador si lo marcaste como recordado: para eso usá «Olvidar los dispositivos recordados».');
	});
});

describe('panel layout', () => {
	const children = createRawSnippet(() => ({ render: () => '<p>contenido</p>' }));
	const layout = (alias?: string | null) => render(PanelLayout, { props: { data: { session: panelSession(alias) }, children } as never }).body;
	const navOf = (html: string) => /<nav aria-label="Panel"[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1]!;

	it('keeps the main navigation to the panel sections', () => {
		const nav = navOf(layout());
		for (const out of ['/admin/contrasena', '/admin/mfa', '/admin/salir', '/admin/cuenta', 'Cerrar sesión']) expect(nav).not.toContain(out);
		expect(text(nav)).toBe('Resumen Pedidos Campañas Productos Configuración');
	});

	it('puts the account and sign out in one user menu, once', () => {
		const html = layout();
		const menu = /<details class="account[^"]*"[\s\S]*?<\/details>/.exec(html)![0];
		expect(text(/<summary[\s\S]*?<\/summary>/.exec(menu)![0])).toContain('owner@tallerdemo.local');
		expect(menu).toMatch(/<a [^>]*href="\/admin\/cuenta"[^>]*>Mi cuenta<\/a>/);
		expect(menu).toMatch(/<form method="POST" action="\/admin\/salir"[^>]*><button[^>]*>Cerrar sesión<\/button><\/form>/);
		const count = (href: string) => html.split(`"${href}"`).length - 1;
		expect([count('/admin/cuenta'), count('/admin/salir'), count('/admin/contrasena'), count('/admin/mfa')]).toEqual([1, 1, 0, 0]);
	});

	it('names the user by their alias when there is one, without depending on it', () => {
		const summary = (html: string) => text(/<summary[\s\S]*?<\/summary>/.exec(html)![0]);
		expect(summary(layout('Patri'))).toContain('Patri');
		expect(text(layout('Patri'))).toContain('owner@tallerdemo.local');
		expect(summary(layout(null))).toContain('owner@tallerdemo.local');
	});
});
