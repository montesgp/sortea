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
	social: Partial<Record<'instagram' | 'tiktok' | 'youtube' | 'facebook', string>>;
	domains: { hostname: string; isPrimary: boolean; verifiedAt: string | null }[];
	members: { email: string; role: string; status: string }[];
	integrations: {
		id: string;
		provider: string;
		mode: string;
		status: string;
		isActive: boolean;
		retiredAt: string | null;
		secretHint: string;
		collectorId: string | null;
		simulator: boolean;
		version: number;
		keyVersion: number;
		lastVerifiedAt: string | null;
		lastError: string | null;
	}[];
	webhookUrl: string;
	theme: Record<string, unknown>;
}

export const load: PageServerLoad = async (event) => {
	const { session } = await event.parent();
	if (session.role !== 'platform_superadmin') error(403, 'Solo el equipo de plataforma accede a esta sección');
	return { organization: await adminLoad<OrganizationDetail>(event, `/platform/organizations/${event.params.id}`) };
};

const base = (id: string) => `/platform/organizations/${id}`;

/** An account is a merchant in a mode; the same pair saved again is a credential rotation. */
const accountKey = (integration: { mode: string; collectorId: string | null }) => `${integration.mode}:${integration.collectorId ?? ''}`;

export const actions: Actions = {
	mercadopago: async (event) => {
		const form = await event.request.formData();
		// The account shown when the form was sent, to tell a switch from a first connection or a rotation.
		const previous = String(form.get('previous') ?? '');
		const result = await adminApi<OrganizationDetail>(event, `${base(event.params.id)}/integrations/mercadopago`, {
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
		const active = result.data.integrations.find((integration) => integration.provider === 'mercadopago' && integration.isActive);
		if (previous && active && accountKey(active) !== previous) {
			return {
				action: 'mercadopago',
				ok: true,
				message: 'Cuenta cambiada: Mercado Pago confirmó las credenciales. Las compras nuevas se cobran con esta cuenta; las ya iniciadas siguen con la anterior.'
			};
		}
		return { action: 'mercadopago', ok: true, message: 'Cuenta conectada: Mercado Pago confirmó las credenciales y ya se puede cobrar.' };
	},
	/** Makes a previous account the active one again, with its stored credentials (S6). */
	reactivate: async (event) => {
		const form = await event.request.formData();
		const integrationId = String(form.get('integrationId') ?? '');
		if (form.get('confirm') !== 'yes') {
			return fail(400, { action: 'reactivate', ok: false, message: 'Confirmá que las compras nuevas se van a cobrar con esa cuenta.' });
		}
		const result = await adminApi(event, `${base(event.params.id)}/integrations/mercadopago/${encodeURIComponent(integrationId)}/activate`, { method: 'POST' });
		if (!result.ok) return fail(result.status, { action: 'reactivate', ok: false, message: result.message });
		return {
			action: 'reactivate',
			ok: true,
			message: 'La cuenta volvió a estar activa: Mercado Pago confirmó sus credenciales. Las compras nuevas se cobran con esta cuenta; las ya iniciadas siguen con la cuenta con la que se crearon.'
		};
	},
	disconnect: async (event) => {
		const form = await event.request.formData();
		if (form.get('confirm') !== 'yes') return fail(400, { action: 'disconnect', ok: false, message: 'Confirmá que querés desvincular Mercado Pago.' });
		const result = await adminApi(event, `${base(event.params.id)}/integrations/mercadopago`, { method: 'DELETE' });
		if (!result.ok) return fail(result.status, { action: 'disconnect', ok: false, message: result.message });
		return { action: 'disconnect', ok: true, message: 'Mercado Pago desvinculado: se borraron las credenciales de todas las cuentas y el sitio dejó de cobrar.' };
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
	/** Social links of the organization's public site (S8). */
	social: async (event) => {
		const form = await event.request.formData();
		const links = Object.fromEntries(['instagram', 'tiktok', 'youtube', 'facebook'].map((network) => [network, String(form.get(network) ?? '').trim()]));
		const result = await adminApi(event, `${base(event.params.id)}/social`, { method: 'PUT', body: links });
		if (!result.ok) {
			const details = result.details as { fieldErrors?: Record<string, string[]> } | undefined;
			const first = Object.values(details?.fieldErrors ?? {})[0]?.[0];
			return fail(result.status, { action: 'social', ok: false, message: first ?? result.message });
		}
		return { action: 'social', ok: true, message: 'Redes guardadas' };
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
