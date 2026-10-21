import { dev } from '$app/env';
import { fail, redirect } from '@sveltejs/kit';
import { api } from '#lib/server/api.js';
import type { Actions, PageServerLoad } from './$types';

const LOOKUP = 'sortea_lookup';
const cookieOptions = { path: '/', httpOnly: true, secure: !dev, sameSite: 'strict' as const, maxAge: 60 * 30 };

interface LookupResult {
	holder: { firstName: string; scope: 'order' | 'contact' };
	orders: {
		id: string;
		reference: string;
		status: string;
		totalMinor: number;
		currency: string;
		createdAt: string;
		items: { name: string; quantity: number; kind: string }[];
		downloads: { assetId: string; filename: string }[];
	}[];
	campaigns: { slug: string; title: string; status: string; entryDigits: number; entries: { number: number; status: string }[] }[];
}

export const load: PageServerLoad = async (event) => {
	const token = event.cookies.get(LOOKUP);
	if (!token) return { result: null };
	const result = await api<LookupResult>(event, '/lookup/me', { lookupToken: token });
	if (!result.ok) {
		event.cookies.delete(LOOKUP, { path: '/' });
		return { result: null, expired: true };
	}
	return { result: result.data };
};

export const actions: Actions = {
	start: async (event) => {
		const form = await event.request.formData();
		const documentType = String(form.get('documentType') ?? 'DNI');
		const documentNumber = String(form.get('documentNumber') ?? '').trim();
		if (documentNumber.length < 5) return fail(400, { step: 'start' as const, message: 'Ingresá tu número de documento' });
		const result = await api<{ challengeId: string; message: string }>(event, '/lookup/start', { method: 'POST', body: { documentType, documentNumber } });
		if (!result.ok) return fail(result.status, { step: 'start' as const, message: result.message });
		return { step: 'verify' as const, challengeId: result.data.challengeId, message: result.data.message };
	},
	verify: async (event) => {
		const form = await event.request.formData();
		const challengeId = String(form.get('challengeId') ?? '');
		const code = String(form.get('code') ?? '').replace(/\s/g, '');
		const result = await api<{ token: string }>(event, '/lookup/verify', { method: 'POST', body: { challengeId, code } });
		if (!result.ok) return fail(400, { step: 'verify' as const, challengeId, error: result.message });
		event.cookies.set(LOOKUP, result.data.token, cookieOptions);
		redirect(303, '/consulta');
	},
	receipt: async (event) => {
		const form = await event.request.formData();
		const reference = String(form.get('reference') ?? '').trim().toUpperCase();
		const accessCode = String(form.get('accessCode') ?? '').trim().toUpperCase();
		const result = await api<{ token: string }>(event, '/lookup/receipt', { method: 'POST', body: { reference, accessCode } });
		if (!result.ok) return fail(result.status === 429 ? 429 : 400, { step: 'receipt' as const, message: result.message });
		event.cookies.set(LOOKUP, result.data.token, cookieOptions);
		redirect(303, '/consulta');
	},
	download: async (event) => {
		const token = event.cookies.get(LOOKUP);
		if (!token) redirect(303, '/consulta');
		const form = await event.request.formData();
		const result = await api<{ token: string }>(event, '/lookup/downloads', {
			method: 'POST',
			lookupToken: token,
			body: { orderId: String(form.get('orderId')), assetId: String(form.get('assetId')) }
		});
		if (!result.ok) return fail(400, { step: 'result' as const, message: result.message });
		redirect(303, `/descargas/${result.data.token}`);
	},
	logout: async ({ cookies }) => {
		cookies.delete(LOOKUP, { path: '/' });
		redirect(303, '/consulta');
	}
};
