import type { DatabaseHandle } from './client';
import { AdminUserError, auditAdminUser, createAdminUser, disableAdminUser, findAdminUserByEmail, normalizeEmail, resetAdminMfa, resetAdminPassword } from './admin-users';
import * as s from './schema';

export const adminUserUsage = 'Usage: pnpm admin:user <create|reset-password|reset-mfa|disable> <email> [--platform-admin]';

const commands = ['create', 'reset-password', 'reset-mfa', 'disable'] as const;
type Command = (typeof commands)[number];

interface Output {
	log(line: string): void;
	error(line: string): void;
}

/**
 * `pnpm admin:user`: the operator's way to bootstrap the first platform
 * administrator of an environment and to recover an account (ADR 0020,
 * "Recovery"). A generated password is the only secret it ever prints, once.
 * Every change is audited as a platform-level entry made by the system.
 */
export async function runAdminUserCommand(handle: DatabaseHandle, argv: string[], out: Output, now = new Date()): Promise<number> {
	const positional = argv.filter((arg) => !arg.startsWith('-'));
	const flags = argv.filter((arg) => arg.startsWith('-'));
	const [command, email] = positional;
	const platformAdmin = flags.includes('--platform-admin');
	const valid =
		commands.includes(command as Command) &&
		email !== undefined &&
		positional.length === 2 &&
		flags.every((flag) => flag === '--platform-admin') &&
		(!platformAdmin || command === 'create');
	if (!valid) {
		out.error(adminUserUsage);
		return 1;
	}
	try {
		return await handle.withPlatform((db) =>
			db.transaction(async (tx) => {
				if (command === 'create') {
					const created = await createAdminUser(tx, { email }, now);
					if (platformAdmin) await tx.insert(s.platformAdmins).values({ userId: created.id, email: created.email }).onConflictDoNothing();
					await auditAdminUser(tx, { action: 'admin_user.created', userId: created.id, actorType: 'system', metadata: { via: 'cli', platformAdmin } });
					out.log(`Created ${created.email}${platformAdmin ? ' as a platform administrator' : ''}.`);
					out.log(`Temporary password (shown once): ${created.temporaryPassword}`);
					out.log('The panel asks for a new password at the first sign-in.');
					return 0;
				}
				const user = await findAdminUserByEmail(tx, email);
				if (!user) {
					out.error(`No user with the email ${normalizeEmail(email)}.`);
					return 1;
				}
				if (command === 'reset-password') {
					const password = await resetAdminPassword(tx, user.id, now);
					await auditAdminUser(tx, { action: 'admin_user.password_reset', userId: user.id, actorType: 'system', metadata: { via: 'cli' } });
					out.log(`New password for ${user.email}; its sessions were ended.`);
					out.log(`Temporary password (shown once): ${password}`);
					out.log('The panel asks for a new password at the next sign-in.');
				} else if (command === 'reset-mfa') {
					await resetAdminMfa(tx, user.id, now);
					await auditAdminUser(tx, { action: 'admin_user.mfa_reset', userId: user.id, actorType: 'system', metadata: { via: 'cli' } });
					out.log(`Removed the authenticator app of ${user.email} and ended its sessions. The next sign-in sets up a new one.`);
				} else {
					await disableAdminUser(tx, user.id, now);
					await auditAdminUser(tx, { action: 'admin_user.disabled', userId: user.id, actorType: 'system', metadata: { via: 'cli' } });
					out.log(`Disabled ${user.email} and ended its sessions.`);
				}
				return 0;
			})
		);
	} catch (error) {
		if (error instanceof AdminUserError) {
			out.error(error.code === 'user_exists' ? `${error.message}. Use reset-password to give it a new password.` : error.message);
			return 1;
		}
		throw error;
	}
}
