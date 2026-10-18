import { fail, redirect } from '@sveltejs/kit';
import { adminToken, signIn } from '#lib/server/admin-session.js';
import { loginThrottle } from '#lib/server/login-throttle.js';
import type { Actions, PageServerLoad } from './$types';

const safeNext = (value: string | null) => (value && value.startsWith('/admin') && !value.startsWith('//') ? value : '/admin');

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
		// Checked before asking Supabase, so a guessing bot never reaches it (S2).
		const address = getClientAddress();
		const verdict = loginThrottle.check(address, email);
		if (!verdict.allowed) {
			const minutes = verdict.retryAfterMinutes;
			return fail(429, { email, message: `Demasiados intentos fallidos. Esperá ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} y probá de nuevo.` });
		}
		const result = await signIn(cookies, email, password);
		if (!result.ok) {
			if (result.wrongCredentials) loginThrottle.failed(address, email);
			return fail(400, { email, message: result.message });
		}
		loginThrottle.succeeded(address, email);
		redirect(303, safeNext(url.searchParams.get('next')));
	}
};
