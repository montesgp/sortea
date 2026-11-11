// SvelteKit 3: `$app/env` is the module; `$app/environment` is deprecated (it warns on import).
import { dev } from '$app/env';
import { fail, redirect } from '@sveltejs/kit';
import { authSession, signIn } from '#lib/server/admin-session.js';
import { serverEnv } from '#lib/server/config.js';
import { createDeviceTrust, DEVICE_COOKIE } from '#lib/server/device-trust.js';
import { loginThrottle, waitText } from '#lib/server/login-throttle.js';
import type { Actions, PageServerLoad } from './$types';

const safeNext = (value: string | null) => (value && value.startsWith('/admin') && !value.startsWith('//') ? value : '/admin');
const DEVICE_DAYS = 90;

let trust: ReturnType<typeof createDeviceTrust> | null = null;
const deviceTrust = () => (trust ??= createDeviceTrust({ secret: serverEnv('INTERNAL_API_TOKEN'), ttlMs: DEVICE_DAYS * 24 * 60 * 60_000 }));

const tooMany = (seconds: number) => `Demasiados intentos fallidos. Esperá ${waitText(seconds)} y probá de nuevo.`;

export const load: PageServerLoad = async (event) => {
	if (await authSession(event)) redirect(303, safeNext(event.url.searchParams.get('next')));
	return {};
};

export const actions: Actions = {
	default: async (event) => {
		const { request, cookies, url, getClientAddress } = event;
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		if (!email || !password) return fail(400, { email, message: 'Ingresá tu email y contraseña' });
		// Checked before asking the API, so a guessing bot never makes it hash a password; a known
		// device of this account is not held back by failures from elsewhere (docs/spec/SECURITY.md).
		const address = getClientAddress();
		const device = deviceTrust().verify(cookies.get(DEVICE_COOKIE), email);
		// Checked and counted in one step, so concurrent attempts cannot all slip past the check.
		const verdict = loginThrottle.reserve(address, email, device);
		if (!verdict.allowed) return fail(429, { email, message: tooMany(verdict.retryAfterSeconds) });
		const result = await signIn(event, email, password, device);
		if (!result.ok) {
			if (result.wrongCredentials) verdict.attempt.failed();
			else verdict.attempt.release();
			if (result.retryAfterSeconds !== null) return fail(429, { email, message: tooMany(result.retryAfterSeconds) });
			return fail(result.wrongCredentials ? 400 : 503, { email, message: result.message });
		}
		verdict.attempt.succeeded();
		cookies.set(DEVICE_COOKIE, deviceTrust().issue(email), { path: '/admin', httpOnly: true, secure: !dev, sameSite: 'strict', maxAge: DEVICE_DAYS * 24 * 60 * 60 });
		// A code of the authenticator app comes first when it is required (unless this browser is remembered),
		// then a password someone else chose is replaced.
		if (result.mfaRequired && result.totpConfirmed && !result.verified) redirect(303, '/admin/mfa');
		if (result.mustChangePassword) redirect(303, '/admin/contrasena');
		redirect(303, safeNext(url.searchParams.get('next')));
	}
};
