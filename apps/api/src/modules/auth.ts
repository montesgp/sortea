import { randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, or, schema as s, sql, type Database, type Executor } from '@sortea/db';
import { revokeAdminSessions, revokeAdminTrustedDevices } from '@sortea/db/admin-users';
import {
	base32Decode,
	base32Encode,
	generateTotpSecret,
	hashPassword,
	needsRehash,
	openSecret,
	sealSecret,
	totpUri,
	verifyPassword,
	verifyTotp
} from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
	countTrustedDevices,
	createSession,
	lookupSession,
	rememberDevice,
	revokeSession,
	revokeSessionByToken,
	rotateToMfa,
	useTrustedDevice,
	type AdminIdentity
} from '../lib/admin-auth';
import { requireSession } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { ApiError, parse } from '../lib/errors';
import { qrSvg } from '../lib/qr';
import { recordFailure, recordSuccess, reserveAttempt, throttleKeys, type ThrottleKey } from '../lib/sign-in-throttle';
import { clientKey } from './lookup';

/**
 * Back-office sign-in owned by the API (ADR 0020, "Back-office sign-in";
 * docs/spec/SECURITY.md, "Acceso al panel"). Only the web BFF calls these
 * routes, with the internal token. Responses never carry a password hash, a
 * token hash or a TOTP secret, except the enrolment's own URI and QR code,
 * once, to the person enrolling. Every outcome is audited at platform level.
 */

const signInBody = z.object({
	email: z.string().trim().min(3).max(254),
	password: z.string().min(1).max(200),
	/** The web's known-device id for this account (device-trust.ts), when the browser has a valid one. */
	device: z.string().min(8).max(200).optional(),
	/** The browser's user agent, kept shortened with the session for the person's own review. */
	userAgent: z.string().max(2000).optional(),
	/** The session this browser still held: a successful sign-in ends it. */
	previousToken: z.string().max(200).optional(),
	/** The remembered-device token this browser holds: with the right password it skips the code. A malformed one is ignored, not refused. */
	trustedDevice: z.string().max(200).optional().catch(undefined)
});
const codeBody = z.object({
	code: z.string().trim().regex(/^\d{6}$/, 'Ingresá los 6 dígitos del código'),
	/** "Recordar este dispositivo por 30 días". */
	remember: z.boolean().optional()
});
export const newPassword = z.string().min(12, 'La contraseña nueva necesita al menos 12 caracteres').max(200);
const passwordBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword });

const invalidCredentials = () => new ApiError(401, 'invalid_credentials', 'Email o contraseña incorrectos');
const tooManyAttempts = (retryAfterSeconds: number) =>
	new ApiError(429, 'too_many_attempts', 'Demasiados intentos fallidos. Esperá unos minutos y probá de nuevo.', { retryAfterSeconds });
const invalidCode = () => new ApiError(400, 'invalid_code', 'El código no es válido');
const sessionEnded = () => new ApiError(401, 'unauthenticated', 'Tu sesión venció. Iniciá sesión de nuevo');

interface CodeOutcome {
	session: { token: string; expiresAt: Date };
	trustedDevice: { token: string; expiresAt: Date } | null;
}

/** Thrown inside a reservation's transaction to roll back a refused attempt. */
class Refused extends Error {
	constructor(readonly retryAfterSeconds: number) {
		super('refused');
	}
}

/** The secret is bound to its user, so a sealed value copied to another row does not open. */
const totpOwner = (userId: string) => `admin-user:${userId}:totp`;

/** Checked against when the email is unknown, so both failures cost one scrypt verification. */
let decoy: Promise<string> | null = null;
const decoyHash = () => (decoy ??= hashPassword(randomBytes(24).toString('base64url')));

export async function authRoutes(app: FastifyInstance) {
	const { deps } = app;
	const platform = <T>(fn: (db: Database) => Promise<T>) => deps.db.withPlatform(fn);
	const signInAudit = (db: Executor, action: string, userId: string | null, metadata: Record<string, unknown> = {}) =>
		audit(db, { organizationId: null, actorType: 'admin', actorId: userId, action, targetType: 'admin_user', targetId: userId, metadata });

	app.post('/auth/sign-in', async (request) => {
		const body = parse(signInBody, request.body);
		const now = deps.now();
		const address = clientKey(request);
		// A known device has its own budget, so failures from elsewhere never lock its admin out.
		const keys: ThrottleKey[] = body.device ? [throttleKeys.device(body.device)] : [throttleKeys.account(body.email), throttleKeys.address(address)];
		// Counted before the password is checked, atomically per key: a burst cannot outrun the limit.
		await reserve(keys, now);

		const [row] = await platform((db) => db.select().from(s.adminUsers).where(sql`lower(${s.adminUsers.email}) = ${body.email.toLowerCase()}`));
		const matches = await verifyPassword(body.password, row?.passwordHash ?? (await decoyHash()));
		if (!row || !matches || row.status !== 'active') {
			const reason = !row ? 'unknown_account' : !matches ? 'wrong_password' : 'disabled';
			await platform(async (db) => {
				const locked = await recordFailure(db, keys, now);
				await signInAudit(db, 'admin.sign_in_failed', row?.id ?? null, { reason, address, knownDevice: Boolean(body.device) });
				for (const key of locked) await signInAudit(db, 'admin.sign_in_locked', row?.id ?? null, { scope: key.kind, address });
			});
			throw invalidCredentials();
		}

		const session = await platform((db) =>
			db.transaction(async (tx) => {
				await recordSuccess(tx, keys);
				if (body.previousToken) await revokeSessionByToken(tx, body.previousToken, row.id, now);
				// Checked only here, after the throttle, the password and the account status: a remembered
				// device stands in for the code alone, and only while the user still has a confirmed app.
				const remembered = body.trustedDevice !== undefined && row.totpConfirmedAt !== null && (await useTrustedDevice(tx, body.trustedDevice, row.id, now));
				const assurance = remembered ? 'mfa' : 'password';
				const created = await createSession(tx, { userId: row.id, assurance, now, address, userAgent: body.userAgent ?? null });
				// Raises an old hash to today's parameters while the password is at hand.
				const passwordHash = needsRehash(row.passwordHash) ? await hashPassword(body.password) : row.passwordHash;
				await tx.update(s.adminUsers).set({ lastSignInAt: now, passwordHash }).where(eq(s.adminUsers.id, row.id));
				await signInAudit(tx, 'admin.signed_in', row.id, { address, knownDevice: Boolean(body.device), ...(body.trustedDevice !== undefined ? { rememberedDevice: remembered } : {}) });
				return { ...created, assurance };
			})
		);
		return {
			token: session.token,
			expiresAt: session.expiresAt,
			assurance: session.assurance,
			mustChangePassword: row.mustChangePassword,
			totpConfirmed: row.totpConfirmedAt !== null,
			mfaRequired: deps.config.REQUIRE_ADMIN_MFA
		};
	});

	app.get('/auth/session', async (request) => {
		const identity = await requireSession(request);
		const [user] = await platform((db) => db.select({ pending: s.adminUsers.totpSecretSealed }).from(s.adminUsers).where(eq(s.adminUsers.id, identity.userId)));
		return {
			user: { id: identity.userId, email: identity.email },
			assurance: identity.assurance,
			mustChangePassword: identity.mustChangePassword,
			totp: { confirmed: identity.totpConfirmed, pending: !identity.totpConfirmed && Boolean(user?.pending) },
			mfaRequired: deps.config.REQUIRE_ADMIN_MFA,
			expiresAt: identity.expiresAt
		};
	});

	app.post('/auth/sign-out', async (request, reply) => {
		const header = request.headers.authorization;
		const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
		await platform(async (db) => {
			const identity = await lookupSession(db, token, deps.now());
			if (!identity) return;
			await revokeSession(db, identity.sessionId, deps.now());
			await signInAudit(db, 'admin.signed_out', identity.userId);
		});
		return reply.status(204).send();
	});

	/** Starts (or restarts) the enrolment of an authenticator app; a confirmed one is replaced only by a platform reset. */
	app.post('/auth/totp/enrol', async (request) => {
		const identity = await requireSession(request);
		if (identity.totpConfirmed) throw new ApiError(409, 'totp_confirmed', 'Ya tenés una app de autenticación configurada');
		const secret = generateTotpSecret();
		const encoded = base32Encode(secret);
		await platform(async (db) => {
			await db
				.update(s.adminUsers)
				.set({ totpSecretSealed: sealSecret(deps.keyRing, encoded, totpOwner(identity.userId)), totpConfirmedAt: null, totpLastStep: null, updatedAt: deps.now() })
				.where(and(eq(s.adminUsers.id, identity.userId), isNull(s.adminUsers.totpConfirmedAt)));
			await signInAudit(db, 'admin.mfa_enrolment_started', identity.userId);
		});
		const host = String(request.headers['x-tenant-host'] ?? '').trim() || 'Sortea';
		const uri = totpUri({ issuer: host, account: identity.email, secret: encoded });
		return { uri, secret: encoded, qrSvg: await qrSvg(uri) };
	});

	/** Abandons an enrolment that never got its first code; a confirmed app stays. */
	app.post('/auth/totp/cancel', async (request, reply) => {
		const identity = await requireSession(request);
		await platform((db) =>
			db.update(s.adminUsers).set({ totpSecretSealed: null, updatedAt: deps.now() }).where(and(eq(s.adminUsers.id, identity.userId), isNull(s.adminUsers.totpConfirmedAt)))
		);
		return reply.status(204).send();
	});

	/** The first code of a new enrolment: confirms the app and upgrades this session. */
	app.post('/auth/totp/confirm', async (request) => {
		const identity = await requireSession(request);
		const { code, remember } = parse(codeBody, request.body);
		if (identity.totpConfirmed) throw new ApiError(409, 'totp_confirmed', 'Ya tenés una app de autenticación configurada');
		return codeAccepted(await checkCode(identity, code, 'admin.mfa_enrolled', true, remember ?? false));
	});

	/** A code of the confirmed app: upgrades this session to `mfa`. */
	app.post('/auth/totp/verify', async (request) => {
		const identity = await requireSession(request);
		const { code, remember } = parse(codeBody, request.body);
		if (!identity.totpConfirmed) throw new ApiError(409, 'totp_not_configured', 'Primero configurá tu app de autenticación');
		return codeAccepted(await checkCode(identity, code, 'admin.mfa_verified', false, remember ?? false));
	});

	/** The new `mfa` session and, when asked for, the remembered-device token, which only this response carries. */
	const codeAccepted = ({ session, trustedDevice }: CodeOutcome) => ({
		assurance: 'mfa',
		token: session.token,
		expiresAt: session.expiresAt,
		...(trustedDevice ? { trustedDevice } : {})
	});

	/** "Mi cuenta": how many remembered devices still skip the code. */
	app.get('/auth/trusted-devices', async (request) => {
		const identity = await requireSession(request);
		return { active: await platform((db) => countTrustedDevices(db, identity.userId, deps.now())) };
	});

	/** "Olvidar los dispositivos recordados": every one of them asks for the code again. The session stays open. */
	app.post('/auth/trusted-devices/forget', async (request) => {
		const identity = await requireSession(request);
		const forgotten = await platform((db) =>
			db.transaction(async (tx) => {
				const revoked = await revokeAdminTrustedDevices(tx, identity.userId, deps.now());
				await signInAudit(tx, 'admin.trusted_devices_forgotten', identity.userId, { count: revoked });
				return revoked;
			})
		);
		return { forgotten };
	});

	/** Counts the attempt on `keys` in its own transaction; refused attempts are rolled back and answered 429. */
	async function reserve(keys: readonly ThrottleKey[], now: Date): Promise<void> {
		try {
			await platform((db) =>
				db.transaction(async (tx) => {
					const reservation = await reserveAttempt(tx, keys, now);
					if (!reservation.allowed) throw new Refused(reservation.retryAfterSeconds);
				})
			);
		} catch (error) {
			if (error instanceof Refused) throw tooManyAttempts(error.retryAfterSeconds);
			throw error;
		}
	}

	/**
	 * One transaction holds the user's row from the count to the result, so the
	 * code checks of a user run one at a time: a burst checks at most the limit,
	 * and a refused attempt rolls back without being counted.
	 */
	async function checkCode(identity: AdminIdentity, code: string, action: string, confirming: boolean, remember: boolean): Promise<CodeOutcome> {
		const now = deps.now();
		const keys = [throttleKeys.totp(identity.userId)];
		const session = await platform((db) =>
			db.transaction(async (tx) => {
				const [user] = await tx.select().from(s.adminUsers).where(eq(s.adminUsers.id, identity.userId)).for('update');
				if (!user?.totpSecretSealed) throw new ApiError(409, 'totp_not_configured', 'Primero configurá tu app de autenticación');
				const reservation = await reserveAttempt(tx, keys, now);
				if (!reservation.allowed) throw tooManyAttempts(reservation.retryAfterSeconds);
				const secret = base32Decode(openSecret(deps.keyRing, user.totpSecretSealed, totpOwner(identity.userId)));
				const step = verifyTotp(secret, code, now, user.totpLastStep);
				const failed = async () => {
					const locked = await recordFailure(tx, keys, now);
					await signInAudit(tx, 'admin.mfa_failed', identity.userId, { enrolling: confirming });
					if (locked.length) await signInAudit(tx, 'admin.sign_in_locked', identity.userId, { scope: 'totp' });
					return null;
				};
				if (step === null) return failed();
				// Under the row lock and guarded by the step: two requests with one code cannot both pass.
				const updated = await tx
					.update(s.adminUsers)
					.set({ totpLastStep: step, ...(confirming ? { totpConfirmedAt: now } : {}), updatedAt: now })
					.where(and(eq(s.adminUsers.id, identity.userId), or(isNull(s.adminUsers.totpLastStep), lt(s.adminUsers.totpLastStep, step))))
					.returning({ id: s.adminUsers.id });
				if (updated.length === 0) return failed();
				const rotated = await rotateToMfa(tx, identity.sessionId, now);
				// Rolls the accepted step back too: the code stays usable on a live session.
				if (!rotated) throw sessionEnded();
				await recordSuccess(tx, keys);
				await signInAudit(tx, action, identity.userId);
				if (!remember) return { session: rotated, trustedDevice: null };
				const [held] = await tx.select({ userAgent: s.adminSessions.userAgent }).from(s.adminSessions).where(eq(s.adminSessions.id, identity.sessionId));
				const trustedDevice = await rememberDevice(tx, { userId: identity.userId, now, userAgent: held?.userAgent ?? null });
				await signInAudit(tx, 'admin.device_remembered', identity.userId, { expiresAt: trustedDevice.expiresAt.toISOString() });
				return { session: rotated, trustedDevice };
			})
		);
		if (!session) throw invalidCode();
		return session;
	}

	/**
	 * Changes the signed-in user's password. The current password is required;
	 * a user with an authenticator app must have confirmed a code in this
	 * session. Every other session of the user ends and every remembered device
	 * is forgotten, this browser's too.
	 */
	app.post('/auth/password', async (request) => {
		const identity = await requireSession(request);
		if (identity.totpConfirmed && identity.assurance !== 'mfa') throw new ApiError(403, 'mfa_required', 'Completá la verificación en dos pasos para continuar');
		const body = parse(passwordBody, request.body);
		const now = deps.now();
		const keys = [throttleKeys.password(identity.userId)];
		// Like the code check: one transaction holds the user's row from the count to the result.
		const outcome = await platform((db) =>
			db.transaction(async (tx) => {
				const [user] = await tx.select().from(s.adminUsers).where(eq(s.adminUsers.id, identity.userId)).for('update');
				if (!user) throw sessionEnded();
				const reservation = await reserveAttempt(tx, keys, now);
				if (!reservation.allowed) throw tooManyAttempts(reservation.retryAfterSeconds);
				if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
					const locked = await recordFailure(tx, keys, now);
					await signInAudit(tx, 'admin.password_change_failed', identity.userId);
					if (locked.length) await signInAudit(tx, 'admin.sign_in_locked', identity.userId, { scope: 'password' });
					return { wrong: true as const };
				}
				await recordSuccess(tx, keys);
				if (body.newPassword === body.currentPassword) return { same: true as const };
				const passwordHash = await hashPassword(body.newPassword);
				await tx.update(s.adminUsers).set({ passwordHash, mustChangePassword: false, passwordChangedAt: now, updatedAt: now }).where(eq(s.adminUsers.id, identity.userId));
				const revoked = await revokeAdminSessions(tx, identity.userId, now, identity.sessionId);
				const forgottenDevices = await revokeAdminTrustedDevices(tx, identity.userId, now);
				await signInAudit(tx, 'admin.password_changed', identity.userId, { endedSessions: revoked, forgottenDevices });
				return { endedSessions: revoked };
			})
		);
		if ('wrong' in outcome) throw new ApiError(400, 'wrong_password', 'La contraseña actual no es correcta');
		if ('same' in outcome) throw new ApiError(400, 'same_password', 'La contraseña nueva tiene que ser distinta de la actual');
		return { endedSessions: outcome.endedSessions };
	});
}

