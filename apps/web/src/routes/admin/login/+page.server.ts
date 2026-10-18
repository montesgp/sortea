import { dev } from '$app/env';
import { fail, redirect } from '@sveltejs/kit';
import { adminToken, signIn } from '#lib/server/admin-session.js';
import { serverEnv } from '#lib/server/config.js';
import { createDeviceTrust, DEVICE_COOKIE } from '#lib/server/device-trust.js';
import { loginThrottle, waitText } from '#lib/server/login-throttle.js';
import type { Actions, PageServerLoad } from './$types';

const safeNext = (value: string | null) => (value && value.startsWith('/admin') && !value.startsWith('//') ? value : '/admin');
const DEVICE_DAYS = 90;

let trust: ReturnType<typeof createDeviceTrust> | null = null;
const deviceTrust = () => (trust ??= createDeviceTrust({ secret: serverEnv('INTERNAL_API_TOKEN'), ttlMs: DEVICE_DAYS * 24 * 60 * 60_000 }));

export const load: PageServerLoad = async ({ cookies, url }) => {
	if (await adminToken(cookies)) redirect(303, safeNext(url.searchParams.get('next')));
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, url, getClientAddress }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		if (!email || !password) return fail(400, { email, message: 'Ingresá tu email y contraseña' });
		// Checked before asking Supabase, so a guessing bot never reaches it; a known device of
		// this account is not held back by failures from elsewhere (docs/spec/SECURITY.md).
		const address = getClientAddress();
		const device = deviceTrust().verify(cookies.get(DEVICE_COOKIE), email);
		const verdict = loginThrottle.check(address, email, device);
		if (!verdict.allowed) {
			return fail(429, { email, message: `Demasiados intentos fallidos. Esperá ${waitText(verdict.retryAfterSeconds)} y probá de nuevo.` });
		}
		const result = await signIn(cookies, email, password);
		if (!result.ok) {
			if (result.wrongCredentials) loginThrottle.failed(address, email, device);
			return fail(400, { email, message: result.message });
		}
		loginThrottle.succeeded(address, email, device);
		cookies.set(DEVICE_COOKIE, deviceTrust().issue(email), { path: '/admin', httpOnly: true, secure: !dev, sameSite: 'strict', maxAge: DEVICE_DAYS * 24 * 60 * 60 });
		redirect(303, safeNext(url.searchParams.get('next')));
	}
};
