import { fail, redirect } from '@sveltejs/kit';
import { authSession, authStep, verifyCode } from '#lib/server/admin-session.js';
import type { Actions, PageServerLoad } from './$types';

/** Two-step verification: enrol an authenticator app once, then confirm a code on each sign-in (ADR 0020). */
export const load: PageServerLoad = async (event) => {
	const session = await authSession(event);
	if (!session) redirect(303, '/admin/login');
	return {
		assurance: session.assurance,
		confirmed: session.totp.confirmed,
		// When the API demands the second factor the panel sends people back here, so there is no panel to return to.
		required: session.mfaRequired
	};
};

/** The API draws the QR as SVG; as a data URL it is shown at its own pixel size. */
function qrImage(svg: string) {
	const size = Number(/<svg[^>]*\swidth="(\d+)"/.exec(svg)?.[1] ?? 240);
	return { qr: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`, qrSize: size };
}

export const actions: Actions = {
	enroll: async (event) => {
		const result = await authStep<{ secret: string; qrSvg: string }>(event, '/auth/totp/enrol');
		if (!result.ok && result.status === 401) redirect(303, '/admin/login');
		if (!result.ok) return fail(result.status, { message: result.message });
		return { enrollment: { ...qrImage(result.data.qrSvg), secret: result.data.secret } };
	},
	/** Abandons a pending enrolment (a confirmed app stays) and goes back to the panel. */
	cancel: async (event) => {
		const result = await authStep(event, '/auth/totp/cancel');
		if (!result.ok && result.status === 401) redirect(303, '/admin/login');
		redirect(303, '/admin');
	},
	verify: async (event) => {
		const session = await authSession(event);
		if (!session) redirect(303, '/admin/login');
		const form = await event.request.formData();
		const code = String(form.get('code') ?? '').replace(/\s/g, '');
		// "Recordar este dispositivo por 30 días": the next sign-ins on this browser skip the code.
		const remember = form.get('remember') === 'yes';
		// The first code of a new app confirms it; afterwards each sign-in verifies one. The
		// API's limit (5 wrong codes per user in 15 minutes, counted atomically) is the throttle here.
		const result = await verifyCode(event, session.totp.confirmed ? '/auth/totp/verify' : '/auth/totp/confirm', code, remember);
		if (!result.ok) return fail(result.status === 429 ? 429 : 400, { message: result.status === 429 ? result.message : 'El código no es válido', retry: true });
		redirect(303, session.mustChangePassword ? '/admin/contrasena' : '/admin');
	}
};
