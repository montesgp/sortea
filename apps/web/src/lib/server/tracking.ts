import { dev } from '$app/env';
import { trackingCodeSchema } from '@sortea/domain';
import { redirect, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { addTouch, attributionOf, classifyReferrer, guessChannel, parseTracking, serializeTracking, TRACKING_COOKIE, trackingExpires, withoutSrc, type Tracking } from '../tracking';
import { api } from './api';

/**
 * Landing capture (odd/tasks/tracking-links.md S2). A public page opened with `?src=<code>`
 * remembers the touch when the code is an active link of a campaign that has not closed,
 * then redirects to the same address without the code. A visit without a code, from a known
 * social network, and with no cookie yet, remembers only that network. No personal data, no
 * third-party scripts.
 */

const CACHE_MS = 60_000;
const CACHE_MAX = 1_000;
const resolved = new Map<string, { until: number | null; expires: number }>();

/** When the touch of `code` is remembered until (Unix seconds), or null for a code that is not an active link; cached briefly per host. */
async function resolveCode(event: Pick<RequestEvent, 'url' | 'getClientAddress' | 'fetch'>, code: string): Promise<number | null> {
	const key = `${event.url.hostname} ${code}`;
	const hit = resolved.get(key);
	if (hit && hit.expires > Date.now()) return hit.until;
	const result = await api<{ code: string; until: string }>(event, `/public/tracking-links/${code}`);
	// An outage is not remembered: the next visit asks again.
	if (!result.ok && result.status !== 404) return null;
	const until = result.ok ? Math.floor(Date.parse(result.data.until) / 1000) : null;
	if (resolved.size >= CACHE_MAX) resolved.clear();
	resolved.set(key, { until: Number.isFinite(until) ? until : null, expires: Date.now() + CACHE_MS });
	return until;
}

function writeTracking(cookies: Cookies, state: Tracking) {
	const expires = trackingExpires(state);
	if (!expires) return;
	cookies.set(TRACKING_COOKIE, serializeTracking(state), { path: '/', httpOnly: true, secure: !dev, sameSite: 'lax', expires });
}

/** Runs before the page; redirects (303) when the address carries a code. Pages of the panel and data requests are left alone. */
export async function captureTracking(event: RequestEvent): Promise<void> {
	if (event.request.method !== 'GET' || event.isDataRequest) return;
	const path = event.url.pathname;
	if (path === '/admin' || path.startsWith('/admin/') || path.startsWith('/_app/')) return;

	const now = Date.now();
	const src = event.url.searchParams.get('src');
	if (src !== null) {
		const code = trackingCodeSchema.safeParse(src);
		const until = code.success ? await resolveCode(event, code.data) : null;
		if (code.success && until && until * 1000 > now) {
			writeTracking(event.cookies, addTouch(parseTracking(event.cookies.get(TRACKING_COOKIE), now), { code: code.data, at: Math.floor(now / 1000), until }));
		}
		// Invalid or expired codes are ignored silently; the code never stays in the address.
		redirect(303, withoutSrc(event.url));
	}

	if (event.cookies.get(TRACKING_COOKIE)) return;
	const channel = classifyReferrer(event.request.headers.get('referer'));
	if (channel) writeTracking(event.cookies, guessChannel(parseTracking(undefined, now), channel, now));
}

/** The touches and network guess a checkout forwards to the API; the API checks every code again. */
export function trackingAttribution(cookies: Cookies) {
	return attributionOf(parseTracking(cookies.get(TRACKING_COOKIE), Date.now()));
}
