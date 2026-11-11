import { generateTemporaryPassword, hashPassword } from '@sortea/domain/server';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Executor } from './client';
import * as s from './schema';

/**
 * Back-office accounts (ADR 0020, "Back-office sign-in"), shared by the API's
 * platform console, `pnpm admin:user`, the seed and `pnpm client:load`, so every
 * path creates and resets users the same way: a lowercased email, a scrypt
 * hash, and every session and remembered device revoked on a reset.
 * Call with the owner connection (`withPlatform`) or a transaction of it.
 */

export class AdminUserError extends Error {
	constructor(
		readonly code: 'user_exists' | 'user_not_found' | 'invalid_email',
		message: string
	) {
		super(message);
	}
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AdminUserRow {
	id: string;
	email: string;
	status: 'active' | 'disabled';
	mustChangePassword: boolean;
	totpConfirmed: boolean;
}

function summary(row: typeof s.adminUsers.$inferSelect): AdminUserRow {
	return { id: row.id, email: row.email, status: row.status, mustChangePassword: row.mustChangePassword, totpConfirmed: row.totpConfirmedAt !== null };
}

export async function findAdminUserByEmail(db: Executor, email: string): Promise<AdminUserRow | null> {
	const [row] = await db.select().from(s.adminUsers).where(sql`lower(${s.adminUsers.email}) = ${normalizeEmail(email)}`);
	return row ? summary(row) : null;
}

/**
 * Creates an account. Without a password a temporary one is generated and
 * returned, to be shown once; the person must replace it at the first sign-in.
 */
export async function createAdminUser(
	db: Executor,
	input: { email: string; alias?: string | null; password?: string; mustChangePassword?: boolean; id?: string },
	now = new Date()
): Promise<{ id: string; email: string; temporaryPassword: string | null }> {
	const email = normalizeEmail(input.email);
	if (!emailShape.test(email)) throw new AdminUserError('invalid_email', `${input.email} is not an email address`);
	const temporaryPassword = input.password === undefined ? generateTemporaryPassword() : null;
	const passwordHash = await hashPassword(input.password ?? temporaryPassword!);
	const [row] = await db
		.insert(s.adminUsers)
		.values({
			...(input.id ? { id: input.id } : {}),
			email,
			alias: input.alias ?? null,
			passwordHash,
			mustChangePassword: input.mustChangePassword ?? temporaryPassword !== null,
			passwordChangedAt: now,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoNothing()
		.returning({ id: s.adminUsers.id });
	if (!row) throw new AdminUserError('user_exists', `A user with the email ${email} already exists`);
	return { id: row.id, email, temporaryPassword };
}

/** Sets or removes (null) the display name shown next to the email; null for an unknown user. */
export async function setAdminUserAlias(db: Executor, userId: string, alias: string | null, now = new Date()): Promise<{ id: string; email: string; alias: string | null } | null> {
	const [row] = await db
		.update(s.adminUsers)
		.set({ alias, updatedAt: now })
		.where(eq(s.adminUsers.id, userId))
		.returning({ id: s.adminUsers.id, email: s.adminUsers.email, alias: s.adminUsers.alias });
	return row ?? null;
}

/**
 * Finds or creates the user with this email, for local data (seed, client
 * packs on a local database). `resetPassword` also sets the password of an
 * existing user, as the seed does for its local accounts.
 */
export async function ensureAdminUser(db: Executor, email: string, password: string, options: { resetPassword: boolean }): Promise<{ id: string; created: boolean }> {
	const existing = await findAdminUserByEmail(db, email);
	if (existing) {
		if (options.resetPassword) await setAdminPassword(db, existing.id, password, { mustChange: false });
		return { id: existing.id, created: false };
	}
	const created = await createAdminUser(db, { email, password, mustChangePassword: false });
	return { id: created.id, created: true };
}

/** Ends every session of the user, or every other one when `exceptSessionId` is given. Returns how many it ended. */
export async function revokeAdminSessions(db: Executor, userId: string, now = new Date(), exceptSessionId?: string): Promise<number> {
	const revoked = await db
		.update(s.adminSessions)
		.set({ revokedAt: now })
		.where(and(eq(s.adminSessions.userId, userId), isNull(s.adminSessions.revokedAt), exceptSessionId ? ne(s.adminSessions.id, exceptSessionId) : undefined))
		.returning({ id: s.adminSessions.id });
	return revoked.length;
}

/**
 * Forgets every browser the user chose to remember after a code
 * (odd/tasks/launch-prep-2026-11-10.md, S1): the next sign-in there asks for the
 * code again. Returns how many were still active.
 */
export async function revokeAdminTrustedDevices(db: Executor, userId: string, now = new Date()): Promise<number> {
	const revoked = await db
		.update(s.adminTrustedDevices)
		.set({ revokedAt: now })
		.where(and(eq(s.adminTrustedDevices.userId, userId), isNull(s.adminTrustedDevices.revokedAt)))
		.returning({ id: s.adminTrustedDevices.id, expiresAt: s.adminTrustedDevices.expiresAt });
	return revoked.filter((row) => row.expiresAt > now).length;
}

/** Ends every session and forgets every remembered device: what any reset of a credential does. */
async function signOutEverywhere(db: Executor, userId: string, now: Date): Promise<void> {
	await revokeAdminSessions(db, userId, now);
	await revokeAdminTrustedDevices(db, userId, now);
}

/** Sets a new password and signs the user out everywhere, forgetting the remembered devices. */
export async function setAdminPassword(db: Executor, userId: string, password: string, options: { mustChange: boolean }, now = new Date()): Promise<void> {
	const passwordHash = await hashPassword(password);
	await db.update(s.adminUsers).set({ passwordHash, mustChangePassword: options.mustChange, passwordChangedAt: now, updatedAt: now }).where(eq(s.adminUsers.id, userId));
	await signOutEverywhere(db, userId, now);
}

/** A generated temporary password, returned to be shown once; the user must change it and is signed out everywhere. */
export async function resetAdminPassword(db: Executor, userId: string, now = new Date()): Promise<string> {
	const temporaryPassword = generateTemporaryPassword();
	await setAdminPassword(db, userId, temporaryPassword, { mustChange: true }, now);
	return temporaryPassword;
}

/** Removes the authenticator app: the next sign-in enrols a new one. Ends every session and forgets the remembered devices. */
export async function resetAdminMfa(db: Executor, userId: string, now = new Date()): Promise<void> {
	await db.update(s.adminUsers).set({ totpSecretSealed: null, totpConfirmedAt: null, totpLastStep: null, updatedAt: now }).where(eq(s.adminUsers.id, userId));
	await signOutEverywhere(db, userId, now);
}

/** Blocks the account, ends its sessions and forgets its remembered devices at once. */
export async function disableAdminUser(db: Executor, userId: string, now = new Date()): Promise<void> {
	await db.update(s.adminUsers).set({ status: 'disabled', updatedAt: now }).where(eq(s.adminUsers.id, userId));
	await signOutEverywhere(db, userId, now);
}

/**
 * A platform-level audit entry (no organization) for account changes made
 * outside a request, such as the operator commands. Same row shape as the
 * API's audit helper; metadata never carries a password or a full email.
 */
export async function auditAdminUser(
	db: Executor,
	input: { action: string; userId: string | null; actorType: 'system' | 'platform_admin' | 'admin'; actorId?: string | null; organizationId?: string | null; metadata?: Record<string, unknown> }
): Promise<void> {
	await db.insert(s.auditEvents).values({
		organizationId: input.organizationId ?? null,
		actorType: input.actorType,
		actorId: input.actorId ?? null,
		action: input.action,
		targetType: 'admin_user',
		targetId: input.userId,
		metadata: input.metadata ?? {}
	});
}
