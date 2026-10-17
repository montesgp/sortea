import { error, fail } from '@sveltejs/kit';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import type { Actions, PageServerLoad } from './$types';

interface OrganizationDetail {
	id: string;
	name: string;
	slug: string;
	status: string;
	orderPrefix: string;
	timezone: string;
	contact: { whatsapp?: string };
	domains: { hostname: string; isPrimary: boolean; verifiedAt: string | null }[];
	members: { email: string; role: string; status: string }[];
	integrations: {
		provider: string;
		mode: string;
		status: string;
		isActive: boolean;
		secretHint: string;
		collectorId: string | null;
		simulator: boolean;
		version: number;
		keyVersion: number;
		lastVerifiedAt: string | null;
		lastError: string | null;
	}[];
	theme: Record<string, unknown>;
}

export const load: PageServerLoad = async (event) => {
	const { session } = await event.parent();
	if (session.role !== 'platform_superadmin') error(403, 'Solo el equipo de plataforma accede a esta sección');
	return { organization: await adminLoad<OrganizationDetail>(event, `/platform/organizations/${event.params.id}`) };
};

const base = (id: string) => `/platform/organizations/${id}`;

export const actions: Actions = {
	mercadopago: async (event) => {
		const form = await event.request.formData();
		const result = await adminApi(event, `${base(event.params.id)}/integrations/mercadopago`, {
			method: 'PUT',
			body: {
				mode: String(form.get('mode')),
				accessToken: String(form.get('accessToken') ?? '').trim(),
				webhookSecret: String(form.get('webhookSecret') ?? '').trim(),
				publicKey: String(form.get('publicKey') ?? '').trim() || undefined
			}
		});
		// Secrets are never echoed back into the form, not even on error.
		if (!result.ok) return fail(result.status, { action: 'mercadopago', ok: false, message: result.message });
		return { action: 'mercadopago', ok: true, message: 'Credenciales guardadas y cifradas. Verificá la conexión.' };
	},
	verify: async (event) => {
		const result = await adminApi(event, `${base(event.params.id)}/integrations/mercadopago/verify`, { method: 'POST' });
		if (!result.ok) return fail(result.status, { action: 'verify', ok: false, message: result.message });
		return { action: 'verify', ok: true, message: 'Verificación ejecutada' };
	},
	contact: async (event) => {
		const form = await event.request.formData();
		const whatsapp = String(form.get('whatsapp') ?? '').trim();
		const result = await adminApi(event, `${base(event.params.id)}/contact`, { method: 'PUT', body: { whatsapp } });
		if (!result.ok) {
			const details = result.details as { fieldErrors?: { whatsapp?: string[] } } | undefined;
			return fail(result.status, { action: 'contact', ok: false, message: details?.fieldErrors?.whatsapp?.[0] ?? result.message, whatsapp });
		}
		return { action: 'contact', ok: true, message: whatsapp ? 'Contacto guardado' : 'Contacto guardado, sin WhatsApp' };
	},
	theme: async (event) => {
		const form = await event.request.formData();
		let tokens: unknown;
		try {
			tokens = JSON.parse(String(form.get('tokens') ?? '{}'));
		} catch {
			return fail(400, { action: 'theme', ok: false, message: 'El tema no es un JSON válido' });
		}
		const result = await adminApi<{ issues: { mode: string; pair: string; ratio: number; required: number }[] }>(event, `${base(event.params.id)}/theme`, {
			method: 'PUT',
			body: { tokens }
		});
		if (!result.ok) return fail(result.status, { action: 'theme', ok: false, message: result.message });
		const issues = result.data.issues;
		return {
			action: 'theme',
			ok: true,
			message: issues.length
				? `Tema guardado. ${issues.length} combinación(es) no cumplen contraste AA y usan el color por defecto: ${issues.map((issue) => `${issue.mode} ${issue.pair} (${issue.ratio}:1)`).join(', ')}`
				: 'Tema guardado. Todas las combinaciones cumplen contraste AA.'
		};
	},
	domain: async (event) => {
		const form = await event.request.formData();
		const result = await adminApi(event, `${base(event.params.id)}/domains`, {
			method: 'POST',
			body: { hostname: String(form.get('hostname') ?? '').trim(), isPrimary: form.get('isPrimary') === 'on' }
		});
		if (!result.ok) return fail(result.status, { action: 'domain', ok: false, message: result.message });
		return { action: 'domain', ok: true, message: 'Dominio agregado' };
	},
	status: async (event) => {
		const form = await event.request.formData();
		const result = await adminApi(event, `${base(event.params.id)}/status`, { method: 'POST', body: { status: String(form.get('status')) } });
		if (!result.ok) return fail(result.status, { action: 'status', ok: false, message: result.message });
		return { action: 'status', ok: true, message: 'Estado actualizado' };
	}
};
