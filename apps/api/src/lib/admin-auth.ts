import { randomBytes } from 'node:crypto';
import { and, count, eq, gt, isNull, schema as s, type Executor } from '@sortea/db';
import { sha256Hex } from '@sortea/domain/server';

/**
 * Opaque back-office sessions (ADR 0020, "Back-office sign-in"). The web keeps
 * the token in an httpOnly cookie and sends it as a bearer token; the database
 * stores only its SHA-256 and is the source of truth, so revoking a session or
 * disabling its user takes effect on the next request.
 */
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;
export const SESSION_IDLE_MS = 30 * 60_000;
/** last_seen is written at most once a minute, so a busy page does not write on every request. */
const TOUCH_AFTER_MS = 60_000;

export type Assurance = 'password' | 'mfa';

export interface AdminIdentity {
	readonly userId: string;
	readonly email: string;
	/** How the panel names the user (S4); null when platform staff set none. */
	readonly alias: string | null;
	readonly sessionId: string;
	/** `mfa` once the session confirmed a TOTP code. */
	readonly assurance: Assurance;
	readonly mustChangePassword: boolean;
	readonly totpConfirmed: boolean;
	readonly expiresAt: Date;
}

export const tokenHash = (token: string) => sha256Hex(`admin-session:${token}`);

export async function createSession(
	db: Executor,
	input: { userId: string; assurance: Assurance; now: Date; address: string | null; userAgent: string | null; expiresAt?: Date }
): Promise<{ token: string; expiresAt: Date }> {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = input.expiresAt ?? new Date(input.now.getTime() + SESSION_ABSOLUTE_MS);
	await db.insert(s.adminSessions).values({
		tokenHash: tokenHash(token),
		userId: input.userId,
		assurance: input.assurance,
		createdAt: input.now,
		lastSeenAt: input.now,
		expiresAt,
		idleExpiresAt: new Date(Math.min(input.now.getTime() + SESSION_IDLE_MS, expiresAt.getTime())),
		address: input.address?.slice(0, 64) ?? null,
		userAgent: input.userAgent?.slice(0, 160) ?? null
	});
	return { token, expiresAt };
}

/**
 * The identity behind a session token, or null when the token is unknown,
 * revoked, past its absolute or idle expiry, or its user is disabled. A valid
 * use pushes the idle expiry forward, never past the absolute one.
 */
export async function lookupSession(db: Executor, token: string, now: Date): Promise<AdminIdentity | null> {
	if (!token || token.length > 200) return null;
	const [row] = await db
		.select({ session: s.adminSessions, user: s.adminUsers })
		.from(s.adminSessions)
		.innerJoin(s.adminUsers, eq(s.adminUsers.id, s.adminSessions.userId))
		.where(and(eq(s.adminSessions.tokenHash, tokenHash(token)), isNull(s.adminSessions.revokedAt)));
	if (!row) return null;
	const { session, user } = row;
	if (user.status !== 'active' || session.expiresAt <= now || session.idleExpiresAt <= now) return null;
	if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_AFTER_MS) {
		const idleExpiresAt = new Date(Math.min(now.getTime() + SESSION_IDLE_MS, session.expiresAt.getTime()));
		await db.update(s.adminSessions).set({ lastSeenAt: now, idleExpiresAt }).where(eq(s.adminSessions.id, session.id));
	}
	return {
		userId: user.id,
		email: user.email,
		alias: user.alias,
		sessionId: session.id,
		assurance: session.assurance,
		mustChangePassword: user.mustChangePassword,
		totpConfirmed: user.totpConfirmedAt !== null,
		expiresAt: session.expiresAt
	};
}

export async function revokeSession(db: Executor, sessionId: string, now: Date): Promise<void> {
	await db.update(s.adminSessions).set({ revokedAt: now }).where(and(eq(s.adminSessions.id, sessionId), isNull(s.adminSessions.revokedAt)));
}

/** Ends the session of this token, if it is still open; for a browser that signs in again over its old cookie. */
export async function revokeSessionByToken(db: Executor, token: string, userId: string, now: Date): Promise<void> {
	if (!token || token.length > 200) return;
	// Only a session of the same user: another user's token is never ended through this path.
	await db
		.update(s.adminSessions)
		.set({ revokedAt: now })
		.where(and(eq(s.adminSessions.tokenHash, tokenHash(token)), eq(s.adminSessions.userId, userId), isNull(s.adminSessions.revokedAt)));
}

/**
 * A confirmed second factor ends the password-only session and starts an
 * `mfa` one with a new token, so a token seen before the code (session
 * fixation) is worth nothing after it. The new session keeps the absolute
 * expiry of the sign-in.
 */
export async function rotateToMfa(db: Executor, sessionId: string, now: Date): Promise<{ token: string; expiresAt: Date } | null> {
	const [old] = await db
		.update(s.adminSessions)
		.set({ revokedAt: now })
		.where(and(eq(s.adminSessions.id, sessionId), isNull(s.adminSessions.revokedAt)))
		.returning();
	// Ended meanwhile (signed out, or another request rotated it): nothing to upgrade.
	if (!old) return null;
	return createSession(db, { userId: old.userId, assurance: 'mfa', now, address: old.address, userAgent: old.userAgent, expiresAt: old.expiresAt });
}

/**
 * Remembered browsers (odd/tasks/launch-prep-2026-11-10.md, S1, L4): after a
 * correct code the person may ask not to be asked again on this browser for 30
 * days. The web keeps the token in an httpOnly cookie on /admin; the database
 * keeps only its SHA-256, under its own prefix so it can never be confused with
 * a session token. The expiry is absolute: using the device does not extend it.
 */
export const TRUSTED_DEVICE_MS = 30 * 24 * 60 * 60_000;

export const trustedDeviceHash = (token: string) => sha256Hex(`admin-trusted-device:${token}`);

export async function rememberDevice(db: Executor, input: { userId: string; now: Date; userAgent: string | null }): Promise<{ token: string; expiresAt: Date }> {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(input.now.getTime() + TRUSTED_DEVICE_MS);
	await db.insert(s.adminTrustedDevices).values({
		tokenHash: trustedDeviceHash(token),
		userId: input.userId,
		createdAt: input.now,
		expiresAt,
		userAgent: input.userAgent?.slice(0, 160) ?? null
	});
	return { token, expiresAt };
}

/**
 * Whether this token is a remembered device of this user, still active, and
 * marks it used. Only the sign-in calls it, after the password matched, so a
 * device token alone opens nothing. The lookup is by the hash of a 32-byte
 * random token through a unique index; no secret is compared in application
 * code, and the hash leaks nothing an attacker could narrow a guess with.
 */
export async function useTrustedDevice(db: Executor, token: string, userId: string, now: Date): Promise<boolean> {
	if (!token || token.length > 200) return false;
	const used = await db
		.update(s.adminTrustedDevices)
		.set({ lastUsedAt: now })
		.where(
			and(
				eq(s.adminTrustedDevices.tokenHash, trustedDeviceHash(token)),
				// Another user's token never verifies this account.
				eq(s.adminTrustedDevices.userId, userId),
				isNull(s.adminTrustedDevices.revokedAt),
				gt(s.adminTrustedDevices.expiresAt, now)
			)
		)
		.returning({ id: s.adminTrustedDevices.id });
	return used.length > 0;
}

/** How many remembered devices of the user would still skip the code. */
export async function countTrustedDevices(db: Executor, userId: string, now: Date): Promise<number> {
	const [row] = await db
		.select({ active: count() })
		.from(s.adminTrustedDevices)
		.where(and(eq(s.adminTrustedDevices.userId, userId), isNull(s.adminTrustedDevices.revokedAt), gt(s.adminTrustedDevices.expiresAt, now)));
	return row?.active ?? 0;
}
