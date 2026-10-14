import { API_INTERNAL_URL, INTERNAL_API_TOKEN } from '$app/env/private';
import type { RequestEvent } from '@sveltejs/kit';

export type ApiResult<T> =
	| { ok: true; status: number; data: T }
	| { ok: false; status: number; code: string; message: string; details?: unknown };

export interface ApiOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	body?: unknown;
	/** Supabase access token of a signed-in admin. */
	adminToken?: string | null;
	/** Buyer lookup session token. */
	lookupToken?: string | null;
}

/**
 * The only way the web tier talks to the API. It forwards the real request
 * hostname (how the API picks the tenant), the client IP for rate limiting and
 * the internal token. Browsers never call the API directly.
 */
export async function api<T>(event: Pick<RequestEvent, 'url' | 'getClientAddress' | 'fetch'>, path: string, options: ApiOptions = {}): Promise<ApiResult<T>> {
	const headers: Record<string, string> = {
		'x-internal-token': INTERNAL_API_TOKEN,
		'x-tenant-host': event.url.hostname,
		'x-client-ip': safeClientAddress(event)
	};
	if (options.body !== undefined) headers['content-type'] = 'application/json';
	if (options.adminToken) headers.authorization = `Bearer ${options.adminToken}`;
	if (options.lookupToken) headers['x-lookup-token'] = options.lookupToken;

	let response: Response;
	try {
		response = await fetch(`${API_INTERNAL_URL}${path}`, {
			method: options.method ?? 'GET',
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: AbortSignal.timeout(15_000)
		});
	} catch {
		return { ok: false, status: 503, code: 'api_unreachable', message: 'El servicio no está disponible en este momento. Probá de nuevo en unos minutos' };
	}

	const text = await response.text();
	const body = text ? safeJson(text) : null;
	if (response.ok) return { ok: true, status: response.status, data: body as T };
	const error = (body as { error?: { code: string; message: string; details?: unknown } } | null)?.error;
	return {
		ok: false,
		status: response.status,
		code: error?.code ?? 'unknown',
		message: error?.message ?? 'No se pudo completar la operación',
		details: error?.details
	};
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function safeClientAddress(event: Pick<RequestEvent, 'getClientAddress'>): string {
	try {
		return event.getClientAddress();
	} catch {
		return 'unknown';
	}
}
