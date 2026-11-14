import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { parseDateInput } from '../date-input';
import { adminToken } from './admin-session';
import { api, type ApiOptions, type ApiResult } from './api';

export interface AdminSession {
	/** `alias` is optional: the panel names the user by it when the API sends one. */
	user: { id: string; email: string; alias?: string | null; assurance: 'password' | 'mfa' };
	role: string;
	permissions: string[];
	organization: {
		name: string;
		slug: string;
		/** `suspended`: only platform staff reach the panel, and the public site is paused (S13). */
		status: 'active' | 'suspended';
		timezone: string;
		currency: string;
	};
}

/** API call on behalf of the signed-in admin; session problems become redirects. */
export async function adminApi<T>(event: RequestEvent, path: string, options: Omit<ApiOptions, 'adminToken'> = {}): Promise<ApiResult<T>> {
	const token = await adminToken(event.cookies);
	if (!token) redirect(303, `/admin/login?next=${encodeURIComponent(event.url.pathname)}`);
	const result = await api<T>(event, path, { ...options, adminToken: token });
	if (!result.ok && result.status === 401) redirect(303, `/admin/login?next=${encodeURIComponent(event.url.pathname)}`);
	if (!result.ok && result.code === 'mfa_required') redirect(303, '/admin/mfa');
	if (!result.ok && result.code === 'password_change_required') redirect(303, '/admin/contrasena');
	return result;
}

/** For loads: unwraps the data or renders the API error. */
export async function adminLoad<T>(event: RequestEvent, path: string): Promise<T> {
	const result = await adminApi<T>(event, path);
	if (!result.ok) error(result.status, result.message);
	return result.data;
}

/**
 * For filtered lists (orders, audit): forwards the named query parameters to
 * the API and returns them for the form. A filter the API refuses (400, such as
 * a reversed date range) comes back as `error` instead of an error page, so the
 * operator can fix it in place. Day filters (`dates`, by label) are typed as
 * dd/mm/aaaa (draw room S1) and sent to the API as YYYY-MM-DD; a day that does
 * not exist comes back as `error` the same way, without calling the API.
 */
export async function adminListLoad<T>(
	event: RequestEvent,
	path: string,
	keys: readonly string[],
	dates: Record<string, string> = {}
): Promise<{ result: T | null; error: string | null; filters: Record<string, string> }> {
	const filters: Record<string, string> = {};
	const params = new URLSearchParams();
	let invalid: string | null = null;
	for (const key of keys) {
		let value = event.url.searchParams.get(key)?.trim() ?? '';
		filters[key] = value;
		if (value && dates[key]) {
			const day = parseDateInput(value);
			if (!day.ok) invalid ??= `${dates[key]}: ${day.message}`;
			value = day.ok ? (day.value ?? '') : '';
		}
		if (value) params.set(key, value);
	}
	if (invalid) return { result: null, error: invalid, filters };
	const response = await adminApi<T>(event, `${path}?${params}`);
	if (response.ok) return { result: response.data, error: null, filters };
	if (response.status === 400) return { result: null, error: response.message, filters };
	error(response.status, response.message);
}
