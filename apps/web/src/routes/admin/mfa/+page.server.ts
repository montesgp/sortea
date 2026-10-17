import { fail, redirect } from '@sveltejs/kit';
import { adminToken, decodeClaims, enrollTotp, listFactors, removePendingTotp, verifyTotp } from '#lib/server/admin-session.js';
import type { Actions, PageServerLoad } from './$types';

/** Two-step verification: enroll an authenticator app once, then confirm a code on each sign-in. */
export const load: PageServerLoad = async ({ cookies }) => {
	const token = await adminToken(cookies);
	if (!token) redirect(303, '/admin/login');
	const factors = (await listFactors(token)).filter((factor) => factor.factor_type === 'totp');
	return {
		aal: decodeClaims(token)?.aal ?? 'aal1',
		verified: factors.find((factor) => factor.status === 'verified') ?? null
	};
};

/**
 * Supabase returns the QR as `data:image/svg+xml;utf-8,<svg ...>` with the
 * markup unescaped, which browsers fail to decode (a `#` ends the URL). Re-encode
 * it and keep its own pixel size so it is drawn without resampling.
 */
function qrImage(qrCode: string) {
	const comma = qrCode.indexOf(',');
	const header = qrCode.startsWith('data:') ? qrCode.slice(0, comma) : '';
	const body = header ? qrCode.slice(comma + 1) : qrCode;
	const svg = header.endsWith(';base64') ? Buffer.from(body, 'base64').toString('utf8') : body;
	const size = Number(/<svg[^>]*\swidth="(\d+)"/.exec(svg)?.[1] ?? 200);
	return { qr: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`, qrSize: size };
}

export const actions: Actions = {
	enroll: async ({ cookies }) => {
		const token = await adminToken(cookies);
		if (!token) redirect(303, '/admin/login');
		const result = await enrollTotp(token);
		if (!result.ok) return fail(400, { message: result.message });
		return { enrollment: { factorId: result.data.id, ...qrImage(result.data.totp.qr_code), secret: result.data.totp.secret } };
	},
	/** Abandons a pending enrolment; a verified factor stays. */
	cancel: async ({ cookies }) => {
		const token = await adminToken(cookies);
		if (!token) redirect(303, '/admin/login');
		await removePendingTotp(token);
		return { cancelled: true };
	},
	verify: async ({ cookies, request }) => {
		const token = await adminToken(cookies);
		if (!token) redirect(303, '/admin/login');
		const form = await request.formData();
		const factorId = String(form.get('factorId') ?? '');
		const code = String(form.get('code') ?? '').replace(/\s/g, '');
		const result = await verifyTotp(cookies, token, factorId, code);
		if (!result.ok) return fail(400, { message: result.message, retryFactorId: factorId });
		redirect(303, '/admin');
	}
};
