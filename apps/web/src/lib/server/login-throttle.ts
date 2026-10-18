/**
 * Throttles failed admin sign-ins (S2, feedback 2026-10-17b). Supabase Auth
 * limits sign-ins per IP, but it only sees this web server, so all visitors
 * share one Supabase budget. Per account and per client limits stop guessing;
 * a global cap below Supabase's budget keeps bots from spending it, and while
 * that cap holds only someone who signed in before from the same address may
 * try. Only failures count: people and tests signing in correctly never wait.
 * Kept in memory per web instance, which is enough for one instance; the
 * client address needs ADDRESS_HEADER behind a proxy (docs/spec/SECURITY.md).
 */
export interface LoginThrottleOptions {
	now?: () => number;
	/** Failures allowed on one account in the window, from any address. */
	maxPerAccount?: number;
	/** Failures allowed from one client address in the window, across accounts. */
	maxPerClient?: number;
	windowMs?: number;
	/** Failures allowed from every client together; below Supabase's 30 sign-ins per 5 minutes. */
	maxGlobal?: number;
	globalWindowMs?: number;
}

export type ThrottleVerdict = { allowed: true } | { allowed: false; retryAfterMinutes: number };

const MAX_TRACKED = 10_000;
const TRUST_MS = 30 * 24 * 60 * 60_000;

export function createLoginThrottle({
	now = Date.now,
	maxPerAccount = 5,
	maxPerClient = 30,
	windowMs = 15 * 60_000,
	maxGlobal = 20,
	globalWindowMs = 5 * 60_000
}: LoginThrottleOptions = {}) {
	const failures = new Map<string, number[]>();
	const trusted = new Map<string, number>();
	const account = (email: string) => `account:${email.trim().toLowerCase()}`;
	const client = (address: string) => `client:${address}`;
	const pair = (address: string, email: string) => `${address}|${email.trim().toLowerCase()}`;
	const GLOBAL = 'global';

	function recent(key: string, window = windowMs): number[] {
		const since = now() - window;
		const kept = (failures.get(key) ?? []).filter((at) => at > since);
		if (kept.length) failures.set(key, kept);
		else failures.delete(key);
		return kept;
	}

	function blockedFor(key: string, max: number, window = windowMs): number | null {
		const kept = recent(key, window);
		if (kept.length < max) return null;
		// Unblocked when the oldest failure that keeps it over the limit leaves the window.
		const releaseAt = kept[kept.length - max]! + window;
		return Math.max(1, Math.ceil((releaseAt - now()) / 60_000));
	}

	function isTrusted(address: string, email: string): boolean {
		const until = trusted.get(pair(address, email));
		return until !== undefined && until > now();
	}

	return {
		check(address: string, email: string): ThrottleVerdict {
			const waits = [blockedFor(account(email), maxPerAccount), blockedFor(client(address), maxPerClient)];
			if (!isTrusted(address, email)) waits.push(blockedFor(GLOBAL, maxGlobal, globalWindowMs));
			const blocked = waits.filter((wait): wait is number => wait !== null);
			return blocked.length ? { allowed: false, retryAfterMinutes: Math.max(...blocked) } : { allowed: true };
		},
		failed(address: string, email: string) {
			// A flood of distinct keys must not grow memory without bound.
			if (failures.size > MAX_TRACKED) for (const key of failures.keys()) recent(key);
			for (const key of [account(email), client(address)]) failures.set(key, [...recent(key), now()]);
			failures.set(GLOBAL, [...recent(GLOBAL, globalWindowMs), now()]);
		},
		succeeded(address: string, email: string) {
			failures.delete(account(email));
			if (trusted.size > MAX_TRACKED) trusted.clear();
			trusted.set(pair(address, email), now() + TRUST_MS);
		}
	};
}

export const loginThrottle = createLoginThrottle();
