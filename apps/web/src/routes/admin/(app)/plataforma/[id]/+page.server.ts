import { error, fail } from '@sveltejs/kit';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import { invalidateSite } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';

interface OrganizationDetail {
	id: string;
	name: string;
	slug: string;
	status: string;
	orderPrefix: string;
	timezone: string;
	contact: { whatsapp?: string; mapsUrl?: string };
	social: Partial<Record<'instagram' | 'tiktok' | 'youtube' | 'facebook', string>>;
	domains: { hostname: string; isPrimary: boolean; verifiedAt: string | null }[];
	members: { email: string; alias: string | null; role: string; status: string }[];
	integrations: {
		id: string;
		provider: string;
		mode: string;
		status: string;
		/** principal charges new purchases; backup is ready to take over; previous only settles its purchases (ADR 0017). */
		role: 'principal' | 'backup' | 'previous';
		isActive: boolean;
		retiredAt: string | null;
		secretHint: string;
		collectorId: string | null;
		simulator: boolean;
		/** Mercado Pago reported a test user at the last check (ADR 0013). */
		testUser: boolean;
		version: number;
		keyVersion: number;
		lastVerifiedAt: string | null;
		lastError: string | null;
		/** The last notification this account's webhook secret validated. */
		lastWebhook: Webhook | null;
	}[];
	webhookUrl: string;
	/** The organization's last Mercado Pago notification; an invalid signature means no stored webhook secret matched. */
	lastWebhook: Webhook | null;
	theme: Record<string, unknown>;
}

interface Webhook {
	receivedAt: string;
	topic: string;
	signatureValid: boolean;
	outcome: string;
}

export const load: PageServerLoad = async (event) => {
	const { session } = await event.parent();
	if (session.role !== 'platform_superadmin') error(403, 'Solo el equipo de plataforma accede a esta sección');
	return { organization: await adminLoad<OrganizationDetail>(event, `/platform/organizations/${event.params.id}`) };
};

const base = (id: string) => `/platform/organizations/${id}`;

/** The API's first field error ("Access token inválido") says more than its generic message. */
const firstFieldError = (details: unknown) => Object.values((details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors ?? {})[0]?.[0];

export const actions: Actions = {
	/**
	 * Connects the first account (the principal) or the backup (S4). Changing who
	 * gets paid is never done here: the backup becomes the principal with "Usar
	 * como principal" and the admin's code.
	 */
	mercadopago: async (event) => {
		const form = await event.request.formData();
		const role = form.get('role') === 'backup' ? 'backup' : 'principal';
		const result = await adminApi<OrganizationDetail>(event, `${base(event.params.id)}/integrations/mercadopago`, {
			method: 'PUT',
			body: {
				mode: String(form.get('mode')),
				accessToken: String(form.get('accessToken') ?? '').trim(),
				webhookSecret: String(form.get('webhookSecret') ?? '').trim(),
				publicKey: String(form.get('publicKey') ?? '').trim() || undefined,
				role
			}
		});
		// Secrets are never echoed back into the form, not even on error.
		if (!result.ok) return fail(result.status, { action: 'mercadopago', ok: false, message: firstFieldError(result.details) ?? result.message });
		if (role === 'backup') {
			return { action: 'mercadopago', ok: true, message: 'Cuenta de respaldo conectada: Mercado Pago confirmó las credenciales. No cobra hasta que uses «Usar como principal».' };
		}
		return { action: 'mercadopago', ok: true, message: 'Cuenta conectada: Mercado Pago confirmó las credenciales y ya se puede cobrar.' };
	},
	/** Replaces the access token, the webhook secret or both of one account, without switching (2026-11-10). */
	credentials: async (event) => {
		const form = await event.request.formData();
		const integrationId = String(form.get('integrationId') ?? '');
		const accessToken = String(form.get('accessToken') ?? '').trim();
		const webhookSecret = String(form.get('webhookSecret') ?? '').trim();
		const result = await adminApi(event, `${base(event.params.id)}/integrations/mercadopago/${encodeURIComponent(integrationId)}`, {
			method: 'PATCH',
			body: { accessToken, webhookSecret }
		});
		if (!result.ok) return fail(result.status, { action: 'credentials', integrationId, ok: false, message: firstFieldError(result.details) ?? result.message });
		const parts = [
			accessToken ? 'Mercado Pago confirmó el access token nuevo.' : null,
			webhookSecret ? 'Para comprobar la firma secreta del webhook, usá «Simular notificación» en Mercado Pago y revisá la última notificación de esa cuenta.' : null
		].filter(Boolean);
		return { action: 'credentials', integrationId, ok: true, message: `Credenciales actualizadas. ${parts.join(' ')}` };
	},
	/**
	 * "Usar como principal" on the backup and "Volver a usar esta cuenta" on a
	 * previous account, in two steps without JavaScript (S5): the first post
	 * shows what will happen and asks for the authenticator code; the second
	 * posts the code with confirm=yes. A refused code keeps the confirmation open.
	 */
	activate: async (event) => {
		const form = await event.request.formData();
		const integrationId = String(form.get('integrationId') ?? '');
		if (form.get('confirm') !== 'yes') return { action: 'activate', confirm: integrationId };
		const code = String(form.get('code') ?? '').trim();
		if (!/^\d{6}$/.test(code)) {
			return fail(400, { action: 'activate', confirm: integrationId, ok: false, message: 'Ingresá los 6 dígitos que muestra tu app de autenticación.' });
		}
		const result = await adminApi(event, `${base(event.params.id)}/integrations/mercadopago/${encodeURIComponent(integrationId)}/activate`, { method: 'POST', body: { code } });
		if (!result.ok) return fail(result.status, { action: 'activate', confirm: integrationId, ok: false, message: firstFieldError(result.details) ?? result.message });
		return {
			action: 'activate',
			ok: true,
			message:
				form.get('from') === 'backup'
					? 'La cuenta de respaldo ahora es la principal: las compras nuevas se cobran con ella. La que cobraba quedó como respaldo, y las compras ya iniciadas siguen con la cuenta con la que se crearon.'
					: 'La cuenta volvió a estar activa: Mercado Pago confirmó sus credenciales. Las compras nuevas se cobran con esta cuenta; las ya iniciadas siguen con la cuenta con la que se crearon.'
		};
	},
	/**
	 * "Desvincular cuenta" in two steps without JavaScript, like "Usar como
	 * principal" (S5): the first post says what will happen, the second posts the
	 * authenticator code with confirm=yes. A refusal keeps the confirmation open.
	 */
	disconnect: async (event) => {
		const form = await event.request.formData();
		if (form.get('confirm') !== 'yes') return { action: 'disconnect', confirm: 'yes' };
		const code = String(form.get('code') ?? '').trim();
		if (!/^\d{6}$/.test(code)) {
			return fail(400, { action: 'disconnect', confirm: 'yes', ok: false, message: 'Ingresá los 6 dígitos que muestra tu app de autenticación.' });
		}
		const result = await adminApi(event, `${base(event.params.id)}/integrations/mercadopago`, { method: 'DELETE', body: { code } });
		if (!result.ok) return fail(result.status, { action: 'disconnect', confirm: 'yes', ok: false, message: firstFieldError(result.details) ?? result.message });
		return { action: 'disconnect', ok: true, message: 'Mercado Pago desvinculado: se borraron las credenciales de todas las cuentas y el sitio dejó de cobrar.' };
	},
	/** "Verificar conexión" of one account, whichever charges (S6); the result shows on that account. */
	verify: async (event) => {
		const form = await event.request.formData();
		const integrationId = String(form.get('integrationId') ?? '');
		const result = await adminApi<OrganizationDetail>(event, `${base(event.params.id)}/integrations/mercadopago/${encodeURIComponent(integrationId)}/verify`, { method: 'POST' });
		if (!result.ok) return fail(result.status, { action: 'verify', integrationId, ok: false, message: result.message });
		const checked = result.data.integrations.find((integration) => integration.id === integrationId);
		if (checked?.status === 'verified') {
			return { action: 'verify', integrationId, ok: true, message: `Conexión verificada: Mercado Pago respondió por la cuenta ${checked.collectorId ?? 'sin identificar'}.` };
		}
		return {
			action: 'verify',
			integrationId,
			ok: false,
			message: `Mercado Pago no aceptó las credenciales de esta cuenta (${checked?.lastError ?? 'sin respuesta'}). Cargá credenciales nuevas en «Actualizar credenciales».`
		};
	},
	contact: async (event) => {
		const form = await event.request.formData();
		const whatsapp = String(form.get('whatsapp') ?? '').trim();
		const mapsUrl = String(form.get('mapsUrl') ?? '').trim();
		const result = await adminApi<OrganizationDetail>(event, `${base(event.params.id)}/contact`, { method: 'PUT', body: { whatsapp, mapsUrl } });
		if (!result.ok) {
			const details = result.details as { fieldErrors?: { whatsapp?: string[]; mapsUrl?: string[] } } | undefined;
			const message = details?.fieldErrors?.whatsapp?.[0] ?? details?.fieldErrors?.mapsUrl?.[0] ?? result.message;
			return fail(result.status, { action: 'contact', ok: false, message, whatsapp, mapsUrl });
		}
		// The organization's public pages show the change at once, not after the site cache expires.
		for (const domain of result.data.domains) invalidateSite(domain.hostname);
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
	/**
	 * Two steps without JavaScript: "Quitar" asks for confirmation on that row,
	 * and "Sí, quitar" posts again with confirm=yes.
	 */
	removeDomain: async (event) => {
		const form = await event.request.formData();
		const hostname = String(form.get('hostname') ?? '').trim();
		if (form.get('confirm') !== 'yes') return { action: 'removeDomain', confirm: hostname };
		const result = await adminApi(event, `${base(event.params.id)}/domains/${encodeURIComponent(hostname)}`, { method: 'DELETE' });
		if (!result.ok) return fail(result.status, { action: 'domain', ok: false, message: result.message });
		// The web tier's site cache stops serving the removed host at once.
		invalidateSite(hostname);
		return { action: 'domain', ok: true, message: `Dominio quitado: ${hostname} ya no abre el sitio de la organización.` };
	},
	/**
	 * Two steps without JavaScript, like removing a domain (S13): the first post
	 * asks for confirmation, and only "Sí, …" posts again with confirm=yes.
	 */
	status: async (event) => {
		const form = await event.request.formData();
		const status = String(form.get('status') ?? '');
		if (status !== 'active' && status !== 'suspended') return fail(400, { action: 'status', ok: false, message: 'Estado desconocido' });
		if (form.get('confirm') !== 'yes') return { action: 'status', confirm: status };
		const result = await adminApi<OrganizationDetail>(event, `${base(event.params.id)}/status`, { method: 'POST', body: { status } });
		if (!result.ok) return fail(result.status, { action: 'status', ok: false, message: result.message });
		// This process shows the paused or restored site at once; other instances when their cache expires.
		for (const domain of result.data.domains) invalidateSite(domain.hostname);
		return {
			action: 'status',
			ok: true,
			message:
				status === 'suspended'
					? 'Organización suspendida: el sitio muestra «Este sitio está pausado momentáneamente» y no vende. El equipo de plataforma sigue entrando a esta consola.'
					: 'Organización reactivada: el sitio vuelve a publicarse y a vender.'
		};
	}
};
