/**
 * Throttles failed admin sign-ins (S2, feedback 2026-10-17b). Supabase Auth
 * limits sign-ins per IP, but it only sees this web server, so without this a
 * bot could guess passwords and spend that shared limit until no admin can
 * sign in. Only failures count: people and tests signing in correctly never
 * wait. Kept in memory per web instance, which is enough for one instance;
 * the client address needs ADDRESS_HEADER behind a proxy (README, Deploy).
 */
export interface LoginThrottleOptions {
	now?: () => number;
	/** Failures allowed on one account in the window, from any address. */
	maxPerAccount?: number;
	/** Failures allowed from one client address in the window, across accounts. */
	maxPerClient?: number;
	windowMs?: number;
}

export type ThrottleVerdict = { allowed: true } | { allowed: false; retryAfterMinutes: number };

const MAX_TRACKED = 10_000;

export function createLoginThrottle({ now = Date.now, maxPerAccount = 5, maxPerClient = 30, windowMs = 15 * 60_000 }: LoginThrottleOptions = {}) {
	const failures = new Map<string, number[]>();
	const account = (email: string) => `account:${email.trim().toLowerCase()}`;
	const client = (address: string) => `client:${address}`;

	function recent(key: string): number[] {
		const since = now() - windowMs;
		const kept = (failures.get(key) ?? []).filter((at) => at > since);
		if (kept.length) failures.set(key, kept);
		else failures.delete(key);
		return kept;
	}

	function blockedFor(key: string, max: number): number | null {
		const kept = recent(key);
		if (kept.length < max) return null;
		// Unblocked when the oldest failure that keeps it over the limit leaves the window.
		const releaseAt = kept[kept.length - max]! + windowMs;
		return Math.max(1, Math.ceil((releaseAt - now()) / 60_000));
	}

	return {
		check(address: string, email: string): ThrottleVerdict {
			const waits = [blockedFor(account(email), maxPerAccount), blockedFor(client(address), maxPerClient)].filter((wait): wait is number => wait !== null);
			return waits.length ? { allowed: false, retryAfterMinutes: Math.max(...waits) } : { allowed: true };
		},
		failed(address: string, email: string) {
			// A flood of distinct keys must not grow memory without bound.
			if (failures.size > MAX_TRACKED) for (const key of failures.keys()) recent(key);
			for (const key of [account(email), client(address)]) failures.set(key, [...recent(key), now()]);
		},
		succeeded(_address: string, email: string) {
			failures.delete(account(email));
		}
	};
}

export const loginThrottle = createLoginThrottle();
