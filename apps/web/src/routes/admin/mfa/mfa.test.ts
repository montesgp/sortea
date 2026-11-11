import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Remember this device for 30 days after the second factor
// (odd/tasks/launch-prep-2026-11-10.md, S1): the code form offers the choice.
const authSession = vi.fn();
const verifyCode = vi.fn();
vi.mock('#lib/server/admin-session.js', () => ({
	authSession: (...args: unknown[]) => authSession(...args),
	verifyCode: (...args: unknown[]) => verifyCode(...args),
	authStep: vi.fn()
}));
vi.mock('$app/forms', () => ({ enhance: () => ({}) }));

const { actions } = await import('./+page.server');
const MfaPage = (await import('./+page.svelte')).default;

function fakeEvent(form: Record<string, string>) {
	return {
		cookies: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
		url: new URL('https://demo.localhost/admin/mfa'),
		getClientAddress: () => '203.0.113.7',
		fetch,
		request: new Request('https://demo.localhost/admin/mfa?/verify', { method: 'POST', body: new URLSearchParams(form) })
	} as never;
}

const session = (confirmed: boolean) => ({
	user: { id: 'u1', email: 'owner@tallerdemo.local' },
	assurance: 'password',
	mustChangePassword: false,
	totp: { confirmed, pending: !confirmed },
	mfaRequired: true,
	expiresAt: new Date(Date.now() + 3_600_000).toISOString()
});

beforeEach(() => {
	authSession.mockReset();
	verifyCode.mockReset();
});

describe('verify action', () => {
	it('asks the API to remember the browser only when the box is ticked', async () => {
		authSession.mockResolvedValue(session(true));
		verifyCode.mockResolvedValue({ ok: true, status: 200, data: { token: 't', expiresAt: '' } });
		await expect(actions.verify(fakeEvent({ code: '123 456', remember: 'yes' }))).rejects.toMatchObject({ status: 303, location: '/admin' });
		expect(verifyCode).toHaveBeenLastCalledWith(expect.anything(), '/auth/totp/verify', '123456', true);
		await expect(actions.verify(fakeEvent({ code: '123456' }))).rejects.toMatchObject({ status: 303 });
		expect(verifyCode).toHaveBeenLastCalledWith(expect.anything(), '/auth/totp/verify', '123456', false);
	});

	it('offers it with the first code of a new app too', async () => {
		authSession.mockResolvedValue(session(false));
		verifyCode.mockResolvedValue({ ok: true, status: 200, data: { token: 't', expiresAt: '' } });
		await expect(actions.verify(fakeEvent({ code: '123456', remember: 'yes' }))).rejects.toMatchObject({ status: 303 });
		expect(verifyCode).toHaveBeenLastCalledWith(expect.anything(), '/auth/totp/confirm', '123456', true);
	});
});

describe('code form', () => {
	const page = (data: Record<string, unknown>) => render(MfaPage, { props: { data: { assurance: 'password', confirmed: true, required: true, ...data }, form: null } as never }).body;

	it('has an unticked "Recordar este dispositivo por 30 días" in the code form', () => {
		const html = page({});
		const form = /<form method="POST" action="\?\/verify"[\s\S]*?<\/form>/.exec(html)![0];
		expect(form).toMatch(/<label class="check[^"]*"><input type="checkbox" name="remember" value="yes"\s*\/?>\s*Recordar este dispositivo por 30 días<\/label>/);
		expect(form).not.toMatch(/name="remember"[^>]*checked/);
		expect(html).toContain('No lo marques en un equipo compartido.');
	});

	it('is not shown once the session is verified', () => {
		expect(page({ assurance: 'mfa' })).not.toContain('name="remember"');
	});
});
