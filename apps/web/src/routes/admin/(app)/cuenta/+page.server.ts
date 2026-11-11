import { dev } from '$app/env';
import { fail, redirect } from '@sveltejs/kit';
import { ADMIN_MODE_COOKIE, adminMode, adminModeChoice, adminModeChoices } from '#lib/admin-theme.js';
import { authSession, forgetTrustedDevices, trustedDeviceCount } from '#lib/server/admin-session.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * "Mi cuenta" (owner feedback 2026-11-10 S11): everything about the signed-in
 * user in one place. Password and second factor keep their own pages; this one
 * says where each stands, keeps the back-office theme of this browser and
 * forgets the remembered devices (odd/tasks/launch-prep-2026-11-10.md, S1).
 */
export const load: PageServerLoad = async (event) => {
	const session = await authSession(event);
	if (!session) redirect(303, '/admin/login?next=/admin/cuenta');
	const twoStep = session.assurance === 'mfa' ? 'verified' : session.totp.confirmed ? 'unverified' : session.totp.pending ? 'pending' : 'off';
	return {
		// The option shown as chosen is the mode the panel has now; without a choice, the site's default.
		theme: adminMode(adminModeChoice(event.cookies.get(ADMIN_MODE_COOKIE)), event.locals.site?.theme.defaultMode).mode,
		twoStep: twoStep as 'verified' | 'unverified' | 'pending' | 'off',
		mfaRequired: session.mfaRequired,
		/** Browsers that skip the code for 30 days; null when the API cannot say. */
		trustedDevices: await trustedDeviceCount(event)
	};
};

const devices = (count: number) => (count === 1 ? '1 dispositivo' : `${count} dispositivos`);

const YEAR = 365 * 24 * 60 * 60;

export const actions: Actions = {
	/** A redirect, not a result: the next load renders the page in the new mode, also without JavaScript. */
	theme: async (event) => {
		const value = String((await event.request.formData()).get('theme') ?? '');
		if (!adminModeChoices.some((choice) => choice.value === value)) return fail(400, { message: 'Elegí uno de los temas de la lista' });
		event.cookies.set(ADMIN_MODE_COOKIE, value, { path: '/admin', httpOnly: true, sameSite: 'lax', secure: !dev || event.url.protocol === 'https:', maxAge: YEAR });
		redirect(303, '/admin/cuenta');
	},
	/**
	 * Two steps without JavaScript, like the rest of the panel: the first post
	 * asks for confirmation, and only "Sí, olvidarlos" posts again with confirm=yes.
	 */
	forgetDevices: async (event) => {
		const form = await event.request.formData();
		if (form.get('confirm') !== 'yes') return { action: 'forgetDevices', confirm: true };
		const result = await forgetTrustedDevices(event);
		if (!result.ok) return fail(result.status, { action: 'forgetDevices', ok: false, message: result.message });
		return {
			action: 'forgetDevices',
			ok: true,
			message: `Listo: olvidamos ${devices(result.data.forgotten)}. La próxima vez te vamos a pedir el código en cada uno.`
		};
	}
};
