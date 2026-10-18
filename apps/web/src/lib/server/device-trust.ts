import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Known-device cookie for the admin sign-in (OWASP "device cookies"). After a
 * successful sign-in the browser keeps a signed token bound to that account;
 * on the next attempts it is recognized, so failures from other devices
 * cannot lock that admin out (docs/spec/SECURITY.md). The cookie carries only
 * a hash of the email, a random device id and its issue time.
 */
export const DEVICE_COOKIE = 'sortea_device';

export function createDeviceTrust({ secret, now = Date.now, ttlMs = 90 * 24 * 60 * 60_000 }: { secret: string; now?: () => number; ttlMs?: number }) {
	// Its own key, derived from the shared secret, so the cookie signature serves no other purpose.
	const key = createHash('sha256').update(`sortea-device-trust:${secret}`).digest();
	const account = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('base64url').slice(0, 22);
	const sign = (body: string) => createHmac('sha256', key).update(body).digest('base64url');

	return {
		issue(email: string): string {
			const body = Buffer.from(JSON.stringify({ a: account(email), d: randomBytes(16).toString('base64url'), t: now() })).toString('base64url');
			return `${body}.${sign(body)}`;
		},
		/** The device id when the cookie is genuine, current and for this account; null otherwise. */
		verify(cookie: string | undefined, email: string): string | null {
			const [body, signature, extra] = (cookie ?? '').split('.');
			if (!body || !signature || extra !== undefined) return null;
			const expected = Buffer.from(sign(body));
			const given = Buffer.from(signature);
			if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
			try {
				const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { a?: unknown; d?: unknown; t?: unknown };
				if (claims.a !== account(email) || typeof claims.d !== 'string' || typeof claims.t !== 'number') return null;
				return now() - claims.t < ttlMs ? claims.d : null;
			} catch {
				return null;
			}
		}
	};
}
