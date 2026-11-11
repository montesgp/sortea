import { beforeEach, describe, expect, it, vi } from 'vitest';

// The web keeps only the API's opaque session token, in an httpOnly cookie on
// /admin (ADR 0020, "Back-office sign-in").
const api = vi.fn();
vi.mock('./server/api', () => ({ api: (...args: unknown[]) => api(...args) }));
vi.mock('$app/env', () => ({ dev: true }));

const { adminToken, forgetTrustedDevices, signIn, signOut, trustedDeviceCount, verifiedAdminPermissions, verifyCode } = await import('./server/admin-session');

function fakeEvent(protocol = 'https:', userAgent = 'Firefox/140') {
	const jar = new Map<string, { value: string; options: Record<string, unknown> }>();
	const deleted: { name: string; path: unknown }[] = [];
	const cookies = {
		get: (name: string) => jar.get(name)?.value,
		set: (name: string, value: string, options: Record<string, unknown>) => void jar.set(name, { value, options }),
		delete: (name: string, options: { path: string }) => {
			deleted.push({ name, path: options.path });
			jar.delete(name);
		}
	};
	const event = {
		cookies,
		url: new URL(`${protocol}//demo.localhost/admin/login`),
		getClientAddress: () => '203.0.113.7',
		fetch,
		request: new Request(`${protocol}//demo.localhost/admin/login`, { headers: { 'user-agent': userAgent } })
	};
	return { event: event as never, cookies: cookies as never as import('@sveltejs/kit').Cookies, jar, deleted };
}

beforeEach(() => api.mockReset());

describe('admin session cookie', () => {
	it('stores the token httpOnly, SameSite=Lax, on /admin, Secure over https, until the session ends', async () => {
		const expiresAt = new Date(Date.now() + 12 * 3_600_000).toISOString();
		api.mockResolvedValue({ ok: true, status: 200, data: { token: 'opaque-token', expiresAt, mustChangePassword: false, totpConfirmed: true, mfaRequired: true } });
		const { event, cookies, jar } = fakeEvent();
		const result = await signIn(event, 'owner@tallerdemo.local', 'secret-password', 'device-1');
		expect(result).toEqual({ ok: true, mustChangePassword: false, totpConfirmed: true, mfaRequired: true, verified: false });
		expect(api).toHaveBeenCalledWith(event, '/auth/sign-in', {
			method: 'POST',
			body: { email: 'owner@tallerdemo.local', password: 'secret-password', device: 'device-1', userAgent: 'Firefox/140' }
		});
		const cookie = jar.get('sortea_admin_session')!;
		expect(cookie.value).toBe('opaque-token');
		expect(cookie.options).toMatchObject({ path: '/admin', httpOnly: true, secure: true, sameSite: 'lax' });
		expect(cookie.options.maxAge).toBeGreaterThan(12 * 3600 - 5);
		expect(cookie.options.maxAge).toBeLessThanOrEqual(12 * 3600);
		expect(await adminToken(cookies)).toBe('opaque-token');
	});

	it('is not Secure on the plain-http dev server', async () => {
		api.mockResolvedValue({ ok: true, status: 200, data: { token: 't', expiresAt: new Date(Date.now() + 60_000).toISOString(), mustChangePassword: false, totpConfirmed: false, mfaRequired: false } });
		const { event, jar } = fakeEvent('http:');
		await signIn(event, 'a@b.c', 'p', null);
		expect(jar.get('sortea_admin_session')!.options.secure).toBe(false);
		expect((api.mock.calls[0]![2] as { body: Record<string, unknown> }).body).not.toHaveProperty('device');
	});

	it('maps wrong credentials and the API lock without storing anything', async () => {
		const { event, jar } = fakeEvent();
		api.mockResolvedValueOnce({ ok: false, status: 401, code: 'invalid_credentials', message: 'Email o contraseña incorrectos' });
		expect(await signIn(event, 'a@b.c', 'p', null)).toEqual({ ok: false, wrongCredentials: true, retryAfterSeconds: null, message: 'Email o contraseña incorrectos' });
		api.mockResolvedValueOnce({ ok: false, status: 429, code: 'too_many_attempts', message: 'x', details: { retryAfterSeconds: 840 } });
		expect(await signIn(event, 'a@b.c', 'p', null)).toMatchObject({ ok: false, wrongCredentials: false, retryAfterSeconds: 840 });
		expect(jar.size).toBe(0);
	});

	it('signs out at the API and clears the cookie, with the old Supabase ones', async () => {
		const { event, cookies, jar, deleted } = fakeEvent();
		cookies.set('sortea_admin_session', 'opaque-token', {});
		cookies.set('sortea_admin_access', 'old-jwt', {});
		api.mockResolvedValue({ ok: true, status: 204, data: null });
		await signOut(event);
		expect(api).toHaveBeenCalledWith(event, '/auth/sign-out', { method: 'POST', adminToken: 'opaque-token' });
		expect(jar.size).toBe(0);
		expect(deleted).toEqual([
			{ name: 'sortea_admin_session', path: '/admin' },
			{ name: 'sortea_admin_access', path: '/' }
		]);
	});

	it('counts a pending second factor or password change as a session without permissions', async () => {
		const { event, cookies } = fakeEvent();
		expect(await verifiedAdminPermissions(event)).toBeNull();
		cookies.set('sortea_admin_session', 'opaque-token', {});
		for (const code of ['mfa_required', 'password_change_required']) {
			api.mockResolvedValueOnce({ ok: false, status: 403, code, message: '' });
			expect(await verifiedAdminPermissions(event)).toEqual({ permissions: [] });
		}
		api.mockResolvedValueOnce({ ok: false, status: 401, code: 'unauthenticated', message: '' });
		expect(await verifiedAdminPermissions(event)).toBeNull();
	});

	it('sends the session this browser still holds, so the API ends it on a new sign-in', async () => {
		api.mockResolvedValue({ ok: true, status: 200, data: { token: 'new-token', expiresAt: new Date(Date.now() + 60_000).toISOString(), mustChangePassword: false, totpConfirmed: false, mfaRequired: false } });
		const { event, cookies, jar } = fakeEvent();
		cookies.set('sortea_admin_session', 'old-token', {});
		await signIn(event, 'a@b.c', 'p', null);
		expect((api.mock.calls[0]![2] as { body: Record<string, unknown> }).body.previousToken).toBe('old-token');
		expect(jar.get('sortea_admin_session')!.value).toBe('new-token');
	});

	it('replaces the cookie with the token the API returns after the second factor', async () => {
		const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
		const { event, cookies, jar } = fakeEvent();
		cookies.set('sortea_admin_session', 'password-token', {});
		api.mockResolvedValueOnce({ ok: true, status: 200, data: { assurance: 'mfa', token: 'mfa-token', expiresAt } });
		expect((await verifyCode(event, '/auth/totp/verify', '123456')).ok).toBe(true);
		expect(api).toHaveBeenCalledWith(event, '/auth/totp/verify', { method: 'POST', body: { code: '123456' }, adminToken: 'password-token' });
		expect(jar.get('sortea_admin_session')).toMatchObject({ value: 'mfa-token', options: { path: '/admin', httpOnly: true, sameSite: 'lax' } });
		api.mockResolvedValueOnce({ ok: false, status: 400, code: 'invalid_code', message: 'El código no es válido' });
		expect((await verifyCode(event, '/auth/totp/verify', '000000')).ok).toBe(false);
		expect(jar.get('sortea_admin_session')!.value).toBe('mfa-token');
	});
});

// Remember this device for 30 days after the second factor (odd/tasks/launch-prep-2026-11-10.md, S1).
describe('remembered device cookie', () => {
	const THIRTY_DAYS = 30 * 24 * 60 * 60;
	const signedIn = (assurance: 'password' | 'mfa') => ({
		ok: true,
		status: 200,
		data: { token: 'session-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), assurance, mustChangePassword: false, totpConfirmed: true, mfaRequired: true }
	});

	it('stores the device token after a code with "remember": httpOnly, SameSite=Lax, on /admin, Secure over https, for 30 days', async () => {
		const { event, cookies, jar } = fakeEvent();
		cookies.set('sortea_admin_session', 'password-token', {});
		const expiresAt = new Date(Date.now() + THIRTY_DAYS * 1000).toISOString();
		api.mockResolvedValueOnce({ ok: true, status: 200, data: { assurance: 'mfa', token: 'mfa-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), trustedDevice: { token: 'device-token', expiresAt } } });
		expect((await verifyCode(event, '/auth/totp/verify', '123456', true)).ok).toBe(true);
		expect(api).toHaveBeenCalledWith(event, '/auth/totp/verify', { method: 'POST', body: { code: '123456', remember: true }, adminToken: 'password-token' });
		const cookie = jar.get('sortea_admin_trusted')!;
		expect(cookie.value).toBe('device-token');
		expect(cookie.options).toMatchObject({ path: '/admin', httpOnly: true, secure: true, sameSite: 'lax' });
		expect(cookie.options.maxAge).toBeGreaterThan(THIRTY_DAYS - 5);
		expect(cookie.options.maxAge).toBeLessThanOrEqual(THIRTY_DAYS);
	});

	it('is not Secure on the plain-http dev server, and is not set without "remember"', async () => {
		const plain = fakeEvent('http:');
		api.mockResolvedValueOnce({ ok: true, status: 200, data: { assurance: 'mfa', token: 't', expiresAt: new Date(Date.now() + 60_000).toISOString(), trustedDevice: { token: 'd', expiresAt: new Date(Date.now() + 60_000).toISOString() } } });
		await verifyCode(plain.event, '/auth/totp/confirm', '123456', true);
		expect(plain.jar.get('sortea_admin_trusted')!.options.secure).toBe(false);

		const { event, jar } = fakeEvent();
		api.mockResolvedValueOnce({ ok: true, status: 200, data: { assurance: 'mfa', token: 'mfa-token', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
		await verifyCode(event, '/auth/totp/verify', '123456', false);
		expect((api.mock.calls[1]![2] as { body: unknown }).body).toEqual({ code: '123456' });
		expect(jar.has('sortea_admin_trusted')).toBe(false);
	});

	it('sends the device token with the password; a verified sign-in keeps it, a refused one forgets it', async () => {
		const { event, cookies, jar, deleted } = fakeEvent();
		cookies.set('sortea_admin_trusted', 'device-token', {});
		api.mockResolvedValueOnce(signedIn('mfa'));
		expect(await signIn(event, 'a@b.c', 'p', null)).toMatchObject({ ok: true, verified: true });
		expect((api.mock.calls[0]![2] as { body: Record<string, unknown> }).body.trustedDevice).toBe('device-token');
		expect(jar.get('sortea_admin_trusted')!.value).toBe('device-token');

		// Expired, revoked or forgotten at the API: the browser drops it.
		api.mockResolvedValueOnce(signedIn('password'));
		expect(await signIn(event, 'a@b.c', 'p', null)).toMatchObject({ ok: true, verified: false });
		expect(jar.has('sortea_admin_trusted')).toBe(false);
		expect(deleted).toContainEqual({ name: 'sortea_admin_trusted', path: '/admin' });
	});

	it('never sends a device value no token can have, and drops it after a correct password', async () => {
		const { event, cookies, jar } = fakeEvent();
		cookies.set('sortea_admin_trusted', 'a'.repeat(2001), {});
		api.mockResolvedValueOnce(signedIn('password'));
		expect(await signIn(event, 'a@b.c', 'p', null)).toMatchObject({ ok: true, verified: false });
		expect((api.mock.calls[0]![2] as { body: Record<string, unknown> }).body).not.toHaveProperty('trustedDevice');
		expect(jar.has('sortea_admin_trusted')).toBe(false);
	});

	it('a wrong password leaves the device token alone, and signing out keeps it', async () => {
		const { event, cookies, jar } = fakeEvent();
		cookies.set('sortea_admin_trusted', 'device-token', {});
		api.mockResolvedValueOnce({ ok: false, status: 401, code: 'invalid_credentials', message: 'Email o contraseña incorrectos' });
		await signIn(event, 'a@b.c', 'wrong', null);
		cookies.set('sortea_admin_session', 'session-token', {});
		api.mockResolvedValueOnce({ ok: true, status: 204, data: null });
		await signOut(event);
		expect(jar.get('sortea_admin_trusted')!.value).toBe('device-token');
		expect(jar.has('sortea_admin_session')).toBe(false);
	});

	it("counts and forgets the devices at the API, and clears this browser's token", async () => {
		const { event, cookies, jar } = fakeEvent();
		cookies.set('sortea_admin_session', 'session-token', {});
		cookies.set('sortea_admin_trusted', 'device-token', {});
		api.mockResolvedValueOnce({ ok: true, status: 200, data: { active: 2 } });
		expect(await trustedDeviceCount(event)).toBe(2);
		expect(api).toHaveBeenLastCalledWith(event, '/auth/trusted-devices', { adminToken: 'session-token' });
		api.mockResolvedValueOnce({ ok: false, status: 503, code: 'api_unreachable', message: '' });
		expect(await trustedDeviceCount(event)).toBeNull();

		api.mockResolvedValueOnce({ ok: true, status: 200, data: { forgotten: 2 } });
		expect(await forgetTrustedDevices(event)).toEqual({ ok: true, status: 200, data: { forgotten: 2 } });
		expect(api).toHaveBeenLastCalledWith(event, '/auth/trusted-devices/forget', { method: 'POST', adminToken: 'session-token' });
		expect(jar.has('sortea_admin_trusted')).toBe(false);
		expect(jar.get('sortea_admin_session')!.value).toBe('session-token');
	});
});
