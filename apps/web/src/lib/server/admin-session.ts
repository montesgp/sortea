import { randomUUID } from 'node:crypto';
import { dev } from '$app/env';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { api } from './api';
import { serverEnv } from './config';

/**
 * Admin sessions use Supabase Auth through its REST API from the server.
 * Tokens live in httpOnly cookies; no auth SDK or token ever reaches the
 * browser, and the API re-verifies every token it receives.
 */
const ACCESS = 'sortea_admin_access';
const REFRESH = 'sortea_admin_refresh';

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

export interface TokenClaims {
	sub: string;
	email: string;
	exp: number;
	aal: 'aal1' | 'aal2';
}

const cookieOptions = (maxAge: number) => ({ path: '/', httpOnly: true, secure: !dev, sameSite: 'lax' as const, maxAge });

async function auth<T>(path: string, init: { body?: unknown; token?: string; method?: string }): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
	const response = await fetch(`${serverEnv('SUPABASE_URL')}/auth/v1${path}`, {
		method: init.method ?? 'POST',
		headers: {
			apikey: serverEnv('SUPABASE_PUBLISHABLE_KEY'),
			'content-type': 'application/json',
			...(init.token ? { authorization: `Bearer ${init.token}` } : {})
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
		signal: AbortSignal.timeout(10_000)
	}).catch(() => null);
	if (!response) return { ok: false, status: 503, message: 'No pudimos contactar el servicio de autenticación' };
	const data = await response.json().catch(() => ({}));
	if (!response.ok) return { ok: false, status: response.status, message: (data as { msg?: string; message?: string }).msg ?? 'Error de autenticación' };
	return { ok: true, data: data as T };
}

export function decodeClaims(token: string): TokenClaims | null {
	try {
		const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
		return { sub: payload.sub, email: payload.email, exp: payload.exp, aal: payload.aal === 'aal2' ? 'aal2' : 'aal1' };
	} catch {
		return null;
	}
}

function store(cookies: Cookies, tokens: TokenResponse) {
	cookies.set(ACCESS, tokens.access_token, cookieOptions(tokens.expires_in));
	cookies.set(REFRESH, tokens.refresh_token, cookieOptions(60 * 60 * 24 * 7));
}

export function clearAdminSession(cookies: Cookies) {
	cookies.delete(ACCESS, { path: '/' });
	cookies.delete(REFRESH, { path: '/' });
}

export async function signIn(cookies: Cookies, email: string, password: string) {
	const result = await auth<TokenResponse>('/token?grant_type=password', { body: { email, password } });
	if (!result.ok) return { ok: false as const, message: result.status === 400 ? 'Email o contraseña incorrectos' : result.message };
	store(cookies, result.data);
	return { ok: true as const, claims: decodeClaims(result.data.access_token)! };
}

/** Current access token, refreshed when it is about to expire. Claims are decoded for routing only; the API verifies the signature. */
export async function adminToken(cookies: Cookies): Promise<string | null> {
	const access = cookies.get(ACCESS);
	const claims = access ? decodeClaims(access) : null;
	if (access && claims && claims.exp * 1000 > Date.now() + 30_000) return access;
	const refresh = cookies.get(REFRESH);
	if (!refresh) return null;
	const result = await auth<TokenResponse>('/token?grant_type=refresh_token', { body: { refresh_token: refresh } });
	if (!result.ok) {
		clearAdminSession(cookies);
		return null;
	}
	store(cookies, result.data);
	return result.data.access_token;
}

/**
 * Permissions of the signed-in admin as the API sees them, after it verified
 * the token; null without a valid session. A pending second factor counts as
 * a session without permissions. For guards that must not trust the cookie.
 */
export async function verifiedAdminPermissions(event: Pick<RequestEvent, 'cookies' | 'url' | 'getClientAddress' | 'fetch'>): Promise<{ permissions: string[] } | null> {
	const token = await adminToken(event.cookies);
	if (!token) return null;
	const result = await api<{ permissions: string[] }>(event, '/admin/session', { adminToken: token });
	if (result.ok) return { permissions: result.data.permissions };
	return result.code === 'mfa_required' ? { permissions: [] } : null;
}

export async function signOut(cookies: Cookies) {
	const token = await adminToken(cookies);
	if (token) await auth('/logout', { token });
	clearAdminSession(cookies);
}

interface Factor {
	id: string;
	factor_type: string;
	status: 'verified' | 'unverified';
	friendly_name?: string;
}

export async function listFactors(token: string): Promise<Factor[]> {
	const result = await auth<{ factors?: Factor[] }>('/user', { token, method: 'GET' });
	return result.ok ? (result.data.factors ?? []) : [];
}

/**
 * Removes the user's own TOTP factors that were never verified: an abandoned
 * enrolment must not block the next one. Verified factors are never touched.
 */
export async function removePendingTotp(token: string): Promise<void> {
	const pending = (await listFactors(token)).filter((factor) => factor.factor_type === 'totp' && factor.status === 'unverified');
	for (const factor of pending) await auth(`/factors/${factor.id}`, { token, method: 'DELETE' });
}

export async function enrollTotp(token: string) {
	await removePendingTotp(token);
	return auth<{ id: string; totp: { qr_code: string; secret: string; uri: string } }>('/factors', {
		token,
		// Supabase requires unique names per user; a suffix keeps two enrolments from colliding.
		body: { factor_type: 'totp', friendly_name: `Sortea ${new Date().toISOString().slice(0, 10)} ${randomUUID().slice(0, 8)}` }
	});
}

/** Completes a TOTP challenge; on success the session is upgraded to aal2. */
export async function verifyTotp(cookies: Cookies, token: string, factorId: string, code: string) {
	const challenge = await auth<{ id: string }>(`/factors/${factorId}/challenge`, { token, body: {} });
	if (!challenge.ok) return { ok: false as const, message: challenge.message };
	const verified = await auth<TokenResponse>(`/factors/${factorId}/verify`, { token, body: { challenge_id: challenge.data.id, code } });
	if (!verified.ok) return { ok: false as const, message: 'El código no es válido' };
	store(cookies, verified.data);
	return { ok: true as const };
}
