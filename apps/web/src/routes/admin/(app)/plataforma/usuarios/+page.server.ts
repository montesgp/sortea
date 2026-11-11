import { error, fail } from '@sveltejs/kit';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import type { Actions, PageServerLoad } from './$types';

export interface PlatformUser {
	id: string;
	email: string;
	/** Optional display name set by platform staff (S4). */
	alias: string | null;
	status: 'active' | 'disabled';
	mustChangePassword: boolean;
	mfa: boolean;
	platformAdmin: boolean;
	organizations: { name: string; role: string }[];
	lastSignInAt: string | null;
}

/** Back-office accounts (ADR 0020). Recovery (new password, new authenticator app, disabling) is `pnpm admin:user`. */
export const load: PageServerLoad = async (event) => {
	const { session } = await event.parent();
	if (session.role !== 'platform_superadmin') error(403, 'Solo el equipo de plataforma accede a esta sección');
	return adminLoad<{ users: PlatformUser[] }>(event, '/platform/users');
};

/** The API's first field error ("El alias puede tener hasta 60 caracteres") says more than its generic message. */
const firstFieldError = (details: unknown) => Object.values((details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors ?? {})[0]?.[0];

export const actions: Actions = {
	create: async (event) => {
		const form = await event.request.formData();
		const email = String(form.get('email') ?? '').trim();
		const alias = String(form.get('alias') ?? '').trim();
		const platformAdmin = form.get('platformAdmin') === 'on';
		const result = await adminApi<{ user: { email: string; alias: string | null }; temporaryPassword: string }>(event, '/platform/users', {
			method: 'POST',
			body: { email, alias, platformAdmin }
		});
		if (!result.ok) return fail(result.status, { email, alias, message: firstFieldError(result.details) ?? result.message });
		// Shown once: the API keeps only its hash.
		return { created: { email: result.data.user.email, alias: result.data.user.alias, temporaryPassword: result.data.temporaryPassword } };
	},
	/** Sets or removes (empty) the alias of one user, from its row of the list (S4). */
	alias: async (event) => {
		const form = await event.request.formData();
		const id = String(form.get('id') ?? '');
		const alias = String(form.get('alias') ?? '').trim();
		const result = await adminApi<{ user: { email: string; alias: string | null } }>(event, `/platform/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: { alias } });
		if (!result.ok) return fail(result.status, { aliasOf: id, ok: false, alias, message: firstFieldError(result.details) ?? result.message });
		const user = result.data.user;
		return { aliasOf: id, ok: true, message: user.alias ? `Alias de ${user.email}: ${user.alias}` : `${user.email} quedó sin alias` };
	}
};
