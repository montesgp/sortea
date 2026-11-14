import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from './client';
import {
	AdminUserError,
	MembershipError,
	addOrganizationMember,
	auditAdminUser,
	createAdminUser,
	disableAdminUser,
	findAdminUserByEmail,
	isOrgRole,
	normalizeEmail,
	type OrgRole,
	resetAdminMfa,
	resetAdminPassword
} from './admin-users';
import * as s from './schema';

export const adminUserUsage = [
	'Usage: pnpm admin:user <create|reset-password|reset-mfa|disable> <email> [--platform-admin]',
	'       pnpm admin:user add-member <email> --org <organization slug> --role <role>'
].join('\n');

const commands = ['create', 'reset-password', 'reset-mfa', 'disable', 'add-member'] as const;
type Command = (typeof commands)[number];
/** Options that take a value, as `--org slug` or `--org=slug`. */
const valued = ['--org', '--role'] as const;

interface Output {
	log(line: string): void;
	error(line: string): void;
}

/** Positional arguments, bare flags and valued options; null when a valued option has no value. */
function parseArgs(argv: string[]) {
	const positional: string[] = [];
	const flags: string[] = [];
	const options = new Map<string, string>();
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		const [key, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
		if ((valued as readonly string[]).includes(key)) {
			const value = inline ?? argv[++index];
			if (!value || value.startsWith('-')) return null;
			options.set(key, value);
		} else if (arg.startsWith('-')) flags.push(arg);
		else positional.push(arg);
	}
	return { positional, flags, options };
}

/**
 * `pnpm admin:user`: the operator's way to bootstrap the first platform
 * administrator of an environment, to recover an account (ADR 0020,
 * "Recovery") and to give a person a role in an organization, the draw host
 * included (odd/tasks/draw-room.md T4). A generated password is the only secret
 * it ever prints, once. Every change is audited as made by the system.
 */
export async function runAdminUserCommand(handle: DatabaseHandle, argv: string[], out: Output, now = new Date()): Promise<number> {
	const parsed = parseArgs(argv);
	const [command, email] = parsed?.positional ?? [];
	const platformAdmin = parsed?.flags.includes('--platform-admin') ?? false;
	const org = parsed?.options.get('--org');
	const role = parsed?.options.get('--role');
	const valid =
		parsed !== null &&
		commands.includes(command as Command) &&
		email !== undefined &&
		parsed.positional.length === 2 &&
		parsed.flags.every((flag) => flag === '--platform-admin') &&
		(!platformAdmin || command === 'create') &&
		(command === 'add-member' ? org !== undefined && role !== undefined : parsed.options.size === 0);
	if (!valid) {
		out.error(adminUserUsage);
		return 1;
	}
	if (command === 'add-member' && !isOrgRole(role!)) {
		out.error(`Unknown role ${role}. Roles: ${s.orgRoles.join(', ')}.`);
		return 1;
	}
	const memberRole = role as OrgRole;
	try {
		return await handle.withPlatform((db) =>
			db.transaction(async (tx) => {
				if (command === 'add-member') {
					const [organization] = await tx.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.slug, org!));
					if (!organization) {
						out.error(`No organization with the slug ${org}.`);
						return 1;
					}
					const member = await addOrganizationMember(tx, { organizationId: organization.id, email, role: memberRole }, now);
					if (member.created) {
						await auditAdminUser(tx, { action: 'admin_user.created', userId: member.userId, actorType: 'system', organizationId: organization.id, metadata: { via: 'cli', platformAdmin: false } });
					}
					await auditAdminUser(tx, { action: 'organization.member_added', userId: member.userId, actorType: 'system', organizationId: organization.id, metadata: { via: 'cli', role } });
					if (!member.created) {
						out.log(`Added ${member.email} to ${org} as ${role}.`);
						return 0;
					}
					out.log(`Created ${member.email} and added it to ${org} as ${role}.`);
					out.log(`Temporary password (shown once): ${member.temporaryPassword}`);
					out.log('The panel asks for a new password at the first sign-in.');
					return 0;
				}
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
		if (error instanceof MembershipError && error.code === 'member_exists') {
			out.error(`${normalizeEmail(email)} is already a member of ${org}${error.role ? ` (${error.role})` : ''}. Change its role from the platform console.`);
			return 1;
		}
		if (error instanceof AdminUserError) {
			out.error(error.code === 'user_exists' ? `${error.message}. Use reset-password to give it a new password.` : error.message);
			return 1;
		}
		throw error;
	}
}
