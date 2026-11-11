import { fail, redirect } from '@sveltejs/kit';
import { authSession, authStep } from '#lib/server/admin-session.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * "Cambiar contraseña" (ADR 0020). Required after an account was created or
 * reset with a temporary password; otherwise reached from the panel. The API
 * checks the current password and ends every other session of the user.
 */
export const load: PageServerLoad = async (event) => {
	const session = await authSession(event);
	if (!session) redirect(303, '/admin/login?next=/admin/contrasena');
	// With an authenticator app, its code comes first.
	if (session.totp.confirmed && session.assurance !== 'mfa') redirect(303, '/admin/mfa');
	return { required: session.mustChangePassword, email: session.user.email };
};

export const actions: Actions = {
	default: async (event) => {
		const session = await authSession(event);
		if (!session) redirect(303, '/admin/login?next=/admin/contrasena');
		const form = await event.request.formData();
		const currentPassword = String(form.get('currentPassword') ?? '');
		const newPassword = String(form.get('newPassword') ?? '');
		if (newPassword !== String(form.get('confirmPassword') ?? '')) return fail(400, { ok: false, message: 'Las contraseñas nuevas no coinciden' });
		const result = await authStep<{ endedSessions: number }>(event, '/auth/password', { currentPassword, newPassword });
		if (!result.ok) {
			const fieldError = (result.details as { fieldErrors?: { newPassword?: string[] } } | undefined)?.fieldErrors?.newPassword?.[0];
			return fail(result.status, { ok: false, message: fieldError ?? result.message });
		}
		if (session.mustChangePassword) redirect(303, '/admin');
		const ended = result.data.endedSessions;
		return { ok: true, message: ended > 0 ? `Contraseña cambiada. Cerramos ${ended === 1 ? 'tu otra sesión abierta' : `tus otras ${ended} sesiones abiertas`}.` : 'Contraseña cambiada.' };
	}
};
