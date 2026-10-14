import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { adminToken } from './admin-session';
import { api, type ApiOptions, type ApiResult } from './api';

export interface AdminSession {
	user: { id: string; email: string; aal: 'aal1' | 'aal2' };
	role: string;
	permissions: string[];
	organization: { name: string; slug: string; timezone: string; currency: string };
}

/** API call on behalf of the signed-in admin; session problems become redirects. */
export async function adminApi<T>(event: RequestEvent, path: string, options: Omit<ApiOptions, 'adminToken'> = {}): Promise<ApiResult<T>> {
	const token = await adminToken(event.cookies);
	if (!token) redirect(303, `/admin/login?next=${encodeURIComponent(event.url.pathname)}`);
	const result = await api<T>(event, path, { ...options, adminToken: token });
	if (!result.ok && result.status === 401) redirect(303, `/admin/login?next=${encodeURIComponent(event.url.pathname)}`);
	if (!result.ok && result.code === 'mfa_required') redirect(303, '/admin/mfa');
	return result;
}

/** For loads: unwraps the data or renders the API error. */
export async function adminLoad<T>(event: RequestEvent, path: string): Promise<T> {
	const result = await adminApi<T>(event, path);
	if (!result.ok) error(result.status, result.message);
	return result.data;
}
