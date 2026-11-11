import { and, eq, isNull, lt, or, schema as s, type DatabaseHandle } from '@sortea/db';
import { base32Decode, openSecret, verifyTotp, type KeyRing } from '@sortea/domain/server';
import { audit } from './audit';
import { ApiError } from './errors';
import { recordFailure, recordSuccess, reserveAttempt, throttleKeys } from './sign-in-throttle';

/**
 * The sealed TOTP secret is bound to its user, so a value copied to another
 * row does not open. The sign-in's code step (modules/auth.ts) seals it with
 * the same owner.
 */
export const totpOwner = (userId: string) => `admin-user:${userId}:totp`;

/**
 * Confirms a sensitive action with the signed-in admin's current authenticator
 * code (odd/tasks/console-polish-2026-11-11.md, S5, L3; docs/spec/SECURITY.md,
 * "Segundo factor"). The same rules as the sign-in's second factor: one step
 * either side, each step accepted once (the last accepted step is shared with
 * the sign-in, so a code used to sign in cannot be replayed here), and the
 * same per-user limit of 5 wrong codes in 15 minutes, counted on the same key.
 * One transaction holds the user's row from the count to the result, so the
 * checks of a user run one at a time. The code is never logged or audited.
 */
export async function confirmWithAuthenticator(
	deps: { db: DatabaseHandle; keyRing: KeyRing; now: () => Date },
	input: { userId: string; code: string; purpose: string }
): Promise<void> {
	const now = deps.now();
	const keys = [throttleKeys.totp(input.userId)];
	const accepted = await deps.db.withPlatform((db) =>
		db.transaction(async (tx) => {
			const [user] = await tx.select().from(s.adminUsers).where(eq(s.adminUsers.id, input.userId)).for('update');
			if (!user?.totpSecretSealed || !user.totpConfirmedAt) throw authenticatorRequired();
			const reservation = await reserveAttempt(tx, keys, now);
			// Thrown inside the transaction, so the refused attempt is not counted.
			if (!reservation.allowed) {
				throw new ApiError(429, 'too_many_attempts', 'Demasiados intentos fallidos. Esperá unos minutos y probá de nuevo.', { retryAfterSeconds: reservation.retryAfterSeconds });
			}
			const secret = base32Decode(openSecret(deps.keyRing, user.totpSecretSealed, totpOwner(input.userId)));
			const step = verifyTotp(secret, input.code, now, user.totpLastStep);
			const updated =
				step === null
					? []
					: await tx
							.update(s.adminUsers)
							.set({ totpLastStep: step, updatedAt: now })
							.where(and(eq(s.adminUsers.id, input.userId), or(isNull(s.adminUsers.totpLastStep), lt(s.adminUsers.totpLastStep, step))))
							.returning({ id: s.adminUsers.id });
			const signInAudit = (action: string, metadata: Record<string, unknown>) =>
				audit(tx, { organizationId: null, actorType: 'admin', actorId: input.userId, action, targetType: 'admin_user', targetId: input.userId, metadata });
			if (updated.length === 0) {
				const locked = await recordFailure(tx, keys, now);
				await signInAudit('admin.mfa_failed', { purpose: input.purpose });
				if (locked.length) await signInAudit('admin.sign_in_locked', { scope: 'totp' });
				return false;
			}
			await recordSuccess(tx, keys);
			return true;
		})
	);
	if (!accepted) throw new ApiError(400, 'invalid_code', 'El código de tu app de autenticación no es válido, o ya se usó. No se cambió nada: probá con el código que muestra ahora.');
}

const authenticatorRequired = () =>
	new ApiError(
		409,
		'totp_not_configured',
		'Para cambiar o desvincular la cuenta que cobra necesitás tu app de autenticación. Configurala en Mi cuenta, en la verificación en dos pasos, y volvé a intentarlo.'
	);
