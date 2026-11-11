/**
 * Throttles failed admin sign-ins (docs/spec/SECURITY.md, "Acceso al panel")
 * before they reach the API, whose own counters (apps/api/src/lib/sign-in-throttle.ts)
 * lock an account, a device or an address in the database behind this one.
 *
 * - Unknown devices: an account's third failure starts a growing wait (1 s,
 *   2 s, 4 s ... up to a minute) instead of a lockout, a client address may
 *   fail 30 times in 15 minutes, and all clients together 20 times in 5
 *   minutes, which bounds the password hashing a bot can make the API do.
 * - A known device of the account (device-trust.ts) skips those, so failures
 *   from elsewhere never lock its admin out; it has its own limit of 10
 *   failures in 15 minutes, so a stolen cookie cannot be used to guess.
 *
 * `reserve` checks and counts in one step, before the request goes to the API,
 * so concurrent attempts cannot all pass the check; a success or an attempt
 * that never reached the API gives its count back, so only failures remain.
 * Kept in memory per web instance; the client address needs ADDRESS_HEADER
 * behind a proxy.
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

/** An attempt let through and already counted as a failure until it says otherwise. */
export interface ThrottleAttempt {
	failed(): void;
	succeeded(): void;
	/** It never reached the password check (the API was unreachable): not a failure. */
	release(): void;
}

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

	function record(key: string, window = windowMs, at = now()) {
		failures.set(key, [...recent(key, window), at]);
	}

	/** Removes one entry recorded at `at`, if it is still there. */
	function forget(key: string, at: number) {
		const kept = failures.get(key);
		const index = kept?.indexOf(at) ?? -1;
		if (index < 0) return;
		kept!.splice(index, 1);
		if (kept!.length === 0) failures.delete(key);
	}

	const keysOf = (address: string, email: string, knownDevice: string | null) =>
		knownDevice ? [device(knownDevice)] : [account(email), client(address), GLOBAL];

	const throttle = {
		/** Checks and, when allowed, counts the attempt at once: nothing can slip in between. */
		reserve(address: string, email: string, knownDevice: string | null): { allowed: true; attempt: ThrottleAttempt } | { allowed: false; retryAfterSeconds: number } {
			const verdict = throttle.check(address, email, knownDevice);
			if (!verdict.allowed) return verdict;
			const at = now();
			// The same instant is recorded and given back, so a give-back always finds its entry.
			throttle.failed(address, email, knownDevice, at);
			const giveBack = () => {
				for (const key of keysOf(address, email, knownDevice)) forget(key, at);
			};
			return {
				allowed: true,
				attempt: {
					failed() {},
					succeeded() {
						giveBack();
						throttle.succeeded(address, email, knownDevice);
					},
					release: giveBack
				}
			};
		},
		check(address: string, email: string, knownDevice: string | null): ThrottleVerdict {
			const waits = knownDevice
				? [capped(device(knownDevice), maxPerDevice)]
				: [cooling(account(email)), capped(client(address), maxPerClient), capped(GLOBAL, maxGlobal, globalWindowMs)];
			const longest = Math.max(0, ...waits.filter((wait): wait is number => wait !== null));
			return longest > 0 ? { allowed: false, retryAfterSeconds: Math.ceil(longest / 1000) } : { allowed: true };
		},
		failed(address: string, email: string, knownDevice: string | null, at = now()) {
			// A flood of distinct keys must not grow memory without bound.
			if (failures.size > MAX_TRACKED) for (const key of failures.keys()) recent(key);
			if (knownDevice) return record(device(knownDevice), windowMs, at);
			record(account(email), windowMs, at);
			record(client(address), windowMs, at);
			record(GLOBAL, globalWindowMs, at);
		},
		succeeded(_address: string, email: string, knownDevice: string | null) {
			failures.delete(account(email));
			if (knownDevice) failures.delete(device(knownDevice));
		}
	};
	return throttle;
}

export const loginThrottle = createLoginThrottle();

/** "45 segundos", "1 minuto", "5 minutos". */
export function waitText(seconds: number): string {
	if (seconds < 60) return `${seconds} ${seconds === 1 ? 'segundo' : 'segundos'}`;
	const minutes = Math.ceil(seconds / 60);
	return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
}
