/**
 * Throttles failed admin sign-ins (docs/spec/SECURITY.md, "Acceso al panel").
 * Supabase Auth limits sign-ins per IP but only sees this web server, so all
 * visitors share one Supabase budget.
 *
 * - Unknown devices: an account's third failure starts a growing wait (1 s,
 *   2 s, 4 s ... up to a minute) instead of a lockout, a client address may
 *   fail 30 times in 15 minutes, and all clients together 20 times in 5
 *   minutes, below Supabase's 30.
 * - A known device of the account (device-trust.ts) skips those, so failures
 *   from elsewhere never lock its admin out; it has its own limit of 10
 *   failures in 15 minutes, so a stolen cookie cannot be used to guess.
 *
 * Only failures count. Kept in memory per web instance; the client address
 * needs ADDRESS_HEADER behind a proxy.
 */
export interface LoginThrottleOptions {
	now?: () => number;
	maxPerClient?: number;
	maxPerDevice?: number;
	windowMs?: number;
	maxGlobal?: number;
	globalWindowMs?: number;
}

export type ThrottleVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const MAX_TRACKED = 10_000;
const FREE_FAILURES = 2;
const MAX_WAIT_MS = 60_000;

export function createLoginThrottle({
	now = Date.now,
	maxPerClient = 30,
	maxPerDevice = 10,
	windowMs = 15 * 60_000,
	maxGlobal = 20,
	globalWindowMs = 5 * 60_000
}: LoginThrottleOptions = {}) {
	const failures = new Map<string, number[]>();
	const account = (email: string) => `account:${email.trim().toLowerCase()}`;
	const client = (address: string) => `client:${address}`;
	const device = (id: string) => `device:${id}`;
	const GLOBAL = 'global';

	function recent(key: string, window = windowMs): number[] {
		const since = now() - window;
		const kept = (failures.get(key) ?? []).filter((at) => at > since);
		if (kept.length) failures.set(key, kept);
		else failures.delete(key);
		return kept;
	}

	/** Milliseconds until the window lets one more failure in, or null when it already does. */
	function capped(key: string, max: number, window = windowMs): number | null {
		const kept = recent(key, window);
		return kept.length < max ? null : kept[kept.length - max]! + window - now();
	}

	/** After the free failures, each one doubles the wait before the next try. */
	function cooling(key: string): number | null {
		const kept = recent(key);
		if (kept.length <= FREE_FAILURES) return null;
		const wait = Math.min(MAX_WAIT_MS, 1000 * 2 ** (kept.length - FREE_FAILURES - 1));
		const left = kept[kept.length - 1]! + wait - now();
		return left > 0 ? left : null;
	}

	function record(key: string, window = windowMs) {
		failures.set(key, [...recent(key, window), now()]);
	}

	return {
		check(address: string, email: string, knownDevice: string | null): ThrottleVerdict {
			const waits = knownDevice
				? [capped(device(knownDevice), maxPerDevice)]
				: [cooling(account(email)), capped(client(address), maxPerClient), capped(GLOBAL, maxGlobal, globalWindowMs)];
			const longest = Math.max(0, ...waits.filter((wait): wait is number => wait !== null));
			return longest > 0 ? { allowed: false, retryAfterSeconds: Math.ceil(longest / 1000) } : { allowed: true };
		},
		failed(address: string, email: string, knownDevice: string | null) {
			// A flood of distinct keys must not grow memory without bound.
			if (failures.size > MAX_TRACKED) for (const key of failures.keys()) recent(key);
			if (knownDevice) return record(device(knownDevice));
			record(account(email));
			record(client(address));
			record(GLOBAL, globalWindowMs);
		},
		succeeded(_address: string, email: string, knownDevice: string | null) {
			failures.delete(account(email));
			if (knownDevice) failures.delete(device(knownDevice));
		}
	};
}

export const loginThrottle = createLoginThrottle();

/** "45 segundos", "1 minuto", "5 minutos". */
export function waitText(seconds: number): string {
	if (seconds < 60) return `${seconds} ${seconds === 1 ? 'segundo' : 'segundos'}`;
	const minutes = Math.ceil(seconds / 60);
	return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
}
