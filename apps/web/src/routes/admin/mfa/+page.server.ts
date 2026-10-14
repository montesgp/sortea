import { fail, redirect } from '@sveltejs/kit';
import { adminToken, decodeClaims, enrollTotp, listFactors, verifyTotp } from '#lib/server/admin-session.js';
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

export const actions: Actions = {
	enroll: async ({ cookies }) => {
		const token = await adminToken(cookies);
		if (!token) redirect(303, '/admin/login');
		const result = await enrollTotp(token);
		if (!result.ok) return fail(400, { message: result.message });
		return { enrollment: { factorId: result.data.id, qr: result.data.totp.qr_code, secret: result.data.totp.secret } };
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
