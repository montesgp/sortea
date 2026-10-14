import { dev } from '$app/env';
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Light/dark preference; a plain form post so it works without JavaScript. */
export const POST: RequestHandler = async ({ request, cookies, url }) => {
	const form = await request.formData();
	const mode = form.get('mode') === 'light' ? 'light' : 'dark';
	cookies.set('sortea_mode', mode, { path: '/', httpOnly: false, secure: !dev, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
	const back = String(form.get('back') ?? '/');
	redirect(303, back.startsWith('/') && !back.startsWith('//') ? back : url.origin);
};
