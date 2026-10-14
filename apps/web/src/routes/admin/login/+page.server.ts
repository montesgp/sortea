import { fail, redirect } from '@sveltejs/kit';
import { adminToken, signIn } from '#lib/server/admin-session.js';
import type { Actions, PageServerLoad } from './$types';

const safeNext = (value: string | null) => (value && value.startsWith('/admin') && !value.startsWith('//') ? value : '/admin');

export const load: PageServerLoad = async ({ cookies, url }) => {
	if (await adminToken(cookies)) redirect(303, safeNext(url.searchParams.get('next')));
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		if (!email || !password) return fail(400, { email, message: 'Ingresá tu email y contraseña' });
		const result = await signIn(cookies, email, password);
		if (!result.ok) return fail(400, { email, message: result.message });
		redirect(303, safeNext(url.searchParams.get('next')));
	}
};
