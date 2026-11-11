import { and, eq, gte, inArray, isNull, schema as s, sql, type Executor } from '@sortea/db';
import { sha256Hex } from '@sortea/domain/server';

/**
 * The API's failed sign-in counters (docs/spec/SECURITY.md, "Acceso al
 * panel"), kept in the database so they hold across restarts and instances,
 * behind the web's in-memory throttle. Each key counts attempts in a window
 * that starts with the first one. An attempt is counted before the password or
 * code is checked and given back when it succeeds, so concurrent requests
 * cannot all pass the check and only failures remain. The failure that reaches
 * the limit locks the key until the lock window passes; the count then starts
 * again.
 */
export interface ThrottleLimit {
	readonly max: number;
	readonly windowMs: number;
	readonly lockMs: number;
}

const MINUTES_15 = 15 * 60_000;

export const throttleLimits = {
	/** An account from devices it never signed in from. */
	account: { max: 10, windowMs: MINUTES_15, lockMs: MINUTES_15 },
	/** A browser the account signed in from before (the web's known-device cookie). */
	device: { max: 10, windowMs: MINUTES_15, lockMs: MINUTES_15 },
	/** One client address, over every account. */
	address: { max: 30, windowMs: MINUTES_15, lockMs: MINUTES_15 },
	/** Wrong TOTP codes of a user, and wrong current passwords when changing it. */
	totp: { max: 5, windowMs: MINUTES_15, lockMs: MINUTES_15 },
	password: { max: 5, windowMs: MINUTES_15, lockMs: MINUTES_15 }
} as const satisfies Record<string, ThrottleLimit>;

export type ThrottleKind = keyof typeof throttleLimits;
export interface ThrottleKey {
	readonly kind: ThrottleKind;
	readonly key: string;
}

/** Keys never hold an email or a device id, only their hashes. */
export const throttleKeys = {
	account: (email: string): ThrottleKey => ({ kind: 'account', key: `account:${sha256Hex(email.trim().toLowerCase())}` }),
	device: (deviceId: string): ThrottleKey => ({ kind: 'device', key: `device:${sha256Hex(deviceId)}` }),
	address: (address: string): ThrottleKey => ({ kind: 'address', key: `address:${address}` }),
	totp: (userId: string): ThrottleKey => ({ kind: 'totp', key: `totp:${userId}` }),
	password: (userId: string): ThrottleKey => ({ kind: 'password', key: `password:${userId}` })
};

export type Reservation = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Counts this attempt on every key, one upsert per key, before the password or
 * code is checked. The attempt that would pass a key's limit, and any attempt
 * while the key is locked, is refused. A window that ended, or a lock that
 * passed, starts the count again. Run it in a transaction and roll that back
 * when refused, so a refused attempt is not counted.
 */
export async function reserveAttempt(db: Executor, keys: readonly ThrottleKey[], now: Date): Promise<Reservation> {
	let wait = 0;
	const at = sql`${now.toISOString()}::timestamptz`;
	for (const item of keys) {
		const limit = throttleLimits[item.kind];
		// A lock always lasts its full time: an unlocked key restarts when its window ends, a locked one only when its lock ends.
		const restart = sql`((t.locked_until is null and t.window_started_at + (${limit.windowMs} * interval '1 millisecond') <= ${at}) or (t.locked_until is not null and t.locked_until <= ${at}))`;
		const [row] = await db.execute<{ failures: number; window_started_at: string | Date; locked_until: string | Date | null }>(sql`
			insert into app.admin_sign_in_throttle as t (key, failures, window_started_at, locked_until)
			values (${item.key}, 1, ${at}, null)
			on conflict (key) do update set
				failures = case when ${restart} then 1 else t.failures + 1 end,
				window_started_at = case when ${restart} then ${at} else t.window_started_at end,
				locked_until = case when ${restart} then null else t.locked_until end
			returning failures, window_started_at, locked_until`);
		const lockedUntil = row!.locked_until ? new Date(row!.locked_until).getTime() : null;
		const windowEnds = new Date(row!.window_started_at).getTime() + limit.windowMs;
		if (lockedUntil !== null && lockedUntil > now.getTime()) wait = Math.max(wait, lockedUntil - now.getTime());
		else if (row!.failures > limit.max) wait = Math.max(wait, windowEnds - now.getTime());
	}
	return wait > 0 ? { allowed: false, retryAfterSeconds: Math.ceil(wait / 1000) } : { allowed: true };
}

/**
 * The reserved attempt failed: it stays counted, and a key that reached its
 * limit is locked from now. Returns the keys this failure locked. A row that a
 * concurrent success removed is simply not there.
 */
export async function recordFailure(db: Executor, keys: readonly ThrottleKey[], now: Date): Promise<ThrottleKey[]> {
	const locked: ThrottleKey[] = [];
	for (const item of keys) {
		const limit = throttleLimits[item.kind];
		const rows = await db
			.update(s.adminSignInThrottle)
			.set({ lockedUntil: new Date(now.getTime() + limit.lockMs) })
			.where(and(eq(s.adminSignInThrottle.key, item.key), gte(s.adminSignInThrottle.failures, limit.max), isNull(s.adminSignInThrottle.lockedUntil)))
			.returning({ key: s.adminSignInThrottle.key });
		if (rows.length > 0) locked.push(item);
	}
	return locked;
}

/**
 * The reserved attempt succeeded. Account, device, code and password keys
 * forget their failures; an address only gives this attempt back, so a success
 * neither consumes its budget nor wipes the failures of others.
 */
export async function recordSuccess(db: Executor, keys: readonly ThrottleKey[]): Promise<void> {
	const cleared = keys.filter((item) => item.kind !== 'address').map((item) => item.key);
	if (cleared.length > 0) await db.delete(s.adminSignInThrottle).where(inArray(s.adminSignInThrottle.key, cleared));
	for (const item of keys.filter((key) => key.kind === 'address')) {
		await db
			.update(s.adminSignInThrottle)
			.set({ failures: sql`greatest(${s.adminSignInThrottle.failures} - 1, 0)` })
			.where(eq(s.adminSignInThrottle.key, item.key));
	}
}
