import { dev } from '$app/env';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { api, type ApiResult } from './api';

/**
 * Admin sessions are the API's (ADR 0020, "Back-office sign-in"): it checks the
 * password and the second factor and returns an opaque token, which lives only
 * in an httpOnly cookie on /admin. Browser code never reads it, and the API
 * looks it up on every request, so signing out or disabling a user ends the
 * session at once.
 */
const SESSION = 'sortea_admin_session';
/**
 * A browser remembered after a correct code (odd/tasks/launch-prep-2026-11-10.md,
 * S1): with the right password, the API skips the code for 30 days. Also
 * httpOnly on /admin; signing out keeps it, "Mi cuenta" forgets it.
 */
const TRUSTED = 'sortea_admin_trusted';
/** Cookies of the former Supabase sign-in, cleared when they are seen. */
const LEGACY = ['sortea_admin_access', 'sortea_admin_refresh'];

type Event = Pick<RequestEvent, 'cookies' | 'url' | 'getClientAddress' | 'fetch' | 'request'>;

export interface AuthSession {
	user: { id: string; email: string };
	assurance: 'password' | 'mfa';
	mustChangePassword: boolean;
	totp: { confirmed: boolean; pending: boolean };
	mfaRequired: boolean;
	expiresAt: string;
}

function store(event: Pick<RequestEvent, 'cookies' | 'url'>, token: string, expiresAt: string, name = SESSION) {
	const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
	event.cookies.set(name, token, { path: '/admin', httpOnly: true, secure: !dev || event.url.protocol === 'https:', sameSite: 'lax', maxAge });
}

function forgetTrusted(cookies: Cookies) {
	if (cookies.get(TRUSTED)) cookies.delete(TRUSTED, { path: '/admin' });
}

export function clearAdminSession(cookies: Cookies) {
	cookies.delete(SESSION, { path: '/admin' });
	for (const name of LEGACY) if (cookies.get(name)) cookies.delete(name, { path: '/' });
}

/** The session token of the signed-in admin, as the browser sent it; the API decides whether it is still valid. */
export async function adminToken(cookies: Cookies): Promise<string | null> {
	return cookies.get(SESSION) ?? null;
}

export type SignInResult =
	/** `verified`: a remembered device stood in for the code, so the session is already `mfa`. */
	| { ok: true; mustChangePassword: boolean; totpConfirmed: boolean; mfaRequired: boolean; verified: boolean }
	| { ok: false; wrongCredentials: boolean; retryAfterSeconds: number | null; message: string };

/** `device` is this browser's known-device id for the account, when it has one (device-trust.ts). */
export async function signIn(event: Event, email: string, password: string, device: string | null): Promise<SignInResult> {
	// The session this browser still holds ends with the new sign-in, at the API.
	const previousToken = await adminToken(event.cookies);
	const trustedDevice = event.cookies.get(TRUSTED);
	const result = await api<{ token: string; expiresAt: string; assurance: 'password' | 'mfa'; mustChangePassword: boolean; totpConfirmed: boolean; mfaRequired: boolean }>(
		event,
		'/auth/sign-in',
		{
			method: 'POST',
			body: {
				email,
				password,
				...(device ? { device } : {}),
				userAgent: event.request.headers.get('user-agent') ?? undefined,
				...(previousToken ? { previousToken } : {}),
				// A value no token can have is never sent; after a correct password it is dropped below.
				...(trustedDevice && trustedDevice.length <= 200 ? { trustedDevice } : {})
			}
		}
	);
	if (!result.ok) {
		const retry = (result.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
		return { ok: false, wrongCredentials: result.code === 'invalid_credentials', retryAfterSeconds: result.status === 429 ? (retry ?? 60) : null, message: result.message };
	}
	clearAdminSession(event.cookies);
	store(event, result.data.token, result.data.expiresAt);
	const verified = result.data.assurance === 'mfa';
	// The password was right but the API no longer knows the device (expired, forgotten or revoked): drop it.
	if (trustedDevice && !verified) forgetTrusted(event.cookies);
	return { ok: true, mustChangePassword: result.data.mustChangePassword, totpConfirmed: result.data.totpConfirmed, mfaRequired: result.data.mfaRequired, verified };
}

export async function signOut(event: Event) {
	const token = await adminToken(event.cookies);
	if (token) await api(event, '/auth/sign-out', { method: 'POST', adminToken: token });
	clearAdminSession(event.cookies);
}

/** The session as the sign-in steps need it (no organization involved); null without a valid one. */
export async function authSession(event: Event): Promise<AuthSession | null> {
	const token = await adminToken(event.cookies);
	if (!token) return null;
	const result = await api<AuthSession>(event, '/auth/session', { adminToken: token });
	if (result.ok) return result.data;
	if (result.status === 401) clearAdminSession(event.cookies);
	return null;
}

type CodeAccepted = { token: string; expiresAt: string; trustedDevice?: { token: string; expiresAt: string } };

/**
 * Confirms or verifies a TOTP code. On success the API ends the password-only
 * session and returns a new token for the `mfa` one, which replaces the cookie
 * (no token seen before the code is valid after it). With `remember` it also
 * returns a device token, kept for its 30 days.
 */
export async function verifyCode(event: Event, path: '/auth/totp/confirm' | '/auth/totp/verify', code: string, remember = false): Promise<ApiResult<CodeAccepted>> {
	const result = await authStep<CodeAccepted>(event, path, { code, ...(remember ? { remember: true } : {}) });
	if (result.ok) {
		store(event, result.data.token, result.data.expiresAt);
		if (result.data.trustedDevice) store(event, result.data.trustedDevice.token, result.data.trustedDevice.expiresAt, TRUSTED);
	}
	return result;
}

/** How many remembered devices of the signed-in user skip the code; null when the API cannot say. */
export async function trustedDeviceCount(event: Event): Promise<number | null> {
	const result = await api<{ active: number }>(event, '/auth/trusted-devices', { adminToken: await adminToken(event.cookies) });
	return result.ok ? result.data.active : null;
}

/** Forgets every remembered device of the signed-in user at the API, and this browser's token. */
export async function forgetTrustedDevices(event: Event): Promise<ApiResult<{ forgotten: number }>> {
	const result = await authStep<{ forgotten: number }>(event, '/auth/trusted-devices/forget');
	if (result.ok) forgetTrusted(event.cookies);
	return result;
}

/** A sign-in step of the signed-in admin: second factor or password change. */
export async function authStep<T>(event: Event, path: string, body?: unknown): Promise<ApiResult<T>> {
	return api<T>(event, path, { method: 'POST', body, adminToken: await adminToken(event.cookies) });
}

/**
 * Permissions of the signed-in admin as the API sees them, after it looked the
 * session up; null without a valid session. A pending second factor or password
 * change counts as a session without permissions. For guards that must not
 * trust the cookie.
 */
export async function verifiedAdminPermissions(event: Pick<RequestEvent, 'cookies' | 'url' | 'getClientAddress' | 'fetch'>): Promise<{ permissions: string[] } | null> {
	const token = await adminToken(event.cookies);
	if (!token) return null;
	const result = await api<{ permissions: string[] }>(event, '/admin/session', { adminToken: token });
	if (result.ok) return { permissions: result.data.permissions };
	return result.code === 'mfa_required' || result.code === 'password_change_required' ? { permissions: [] } : null;
}
