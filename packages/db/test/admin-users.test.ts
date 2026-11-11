import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { verifyPassword } from '@sortea/domain/server';
import { and, createDatabase, eq, schema as s, sql, type DatabaseHandle } from '../src';
import { runAdminUserCommand } from '../src/admin-user-command';
import { createAdminUser, ensureAdminUser, findAdminUserByEmail } from '../src/admin-users';

// Back-office accounts without Supabase (ADR 0020): the shared user functions
// and `pnpm admin:user`.
let handle: DatabaseHandle;

beforeAll(() => {
	handle = createDatabase(inject('databaseUrl'), { max: 2 });
});

afterAll(async () => {
	await handle.close();
});

const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}@test.local`;

async function userRow(email: string) {
	const [row] = await handle.withPlatform((db) => db.select().from(s.adminUsers).where(sql`lower(${s.adminUsers.email}) = ${email.toLowerCase()}`));
	return row!;
}

async function openSession(userId: string) {
	const [row] = await handle.withPlatform((db) =>
		db
			.insert(s.adminSessions)
			.values({ tokenHash: randomUUID(), userId, expiresAt: new Date(Date.now() + 3_600_000), idleExpiresAt: new Date(Date.now() + 1_800_000) })
			.returning()
	);
	return row!.id;
}

/** A remembered browser of the user (odd/tasks/launch-prep-2026-11-10.md, S1). */
async function rememberDevice(userId: string) {
	const [row] = await handle.withPlatform((db) =>
		db
			.insert(s.adminTrustedDevices)
			.values({ tokenHash: randomUUID(), userId, expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000) })
			.returning()
	);
	return row!.id;
}

async function deviceRevoked(id: string) {
	const [row] = await handle.withPlatform((db) => db.select().from(s.adminTrustedDevices).where(eq(s.adminTrustedDevices.id, id)));
	return row!.revokedAt !== null;
}

async function sessionRevoked(id: string) {
	const [row] = await handle.withPlatform((db) => db.select().from(s.adminSessions).where(eq(s.adminSessions.id, id)));
	return row!.revokedAt !== null;
}

async function auditOf(userId: string) {
	return handle.withPlatform((db) => db.select().from(s.auditEvents).where(and(eq(s.auditEvents.targetType, 'admin_user'), eq(s.auditEvents.targetId, userId))));
}

function capture() {
	const lines: string[] = [];
	return { out: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(`ERR ${line}`) }, lines };
}

describe('admin users', () => {
	it('stores a lowercased email and a scrypt hash, never the password', async () => {
		const email = unique('Mixed.Case');
		const created = await handle.withPlatform((db) => createAdminUser(db, { email, password: 'a-long-local-password' }));
		const row = await userRow(email);
		expect(row.email).toBe(email.toLowerCase());
		expect(row.passwordHash).toMatch(/^scrypt\$N=32768,r=8,p=1\$/);
		expect(row.passwordHash).not.toContain('a-long-local-password');
		expect(await verifyPassword('a-long-local-password', row.passwordHash)).toBe(true);
		expect(created.temporaryPassword).toBeNull();
		expect(row.mustChangePassword).toBe(false);
	});

	it('generates a temporary password that must be changed when none is given', async () => {
		const email = unique('temp');
		const created = await handle.withPlatform((db) => createAdminUser(db, { email }));
		expect(created.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
		const row = await userRow(email);
		expect(row.mustChangePassword).toBe(true);
		expect(await verifyPassword(created.temporaryPassword!, row.passwordHash)).toBe(true);
	});

	it('refuses a second account with the same email in any case', async () => {
		const email = unique('dup');
		await handle.withPlatform((db) => createAdminUser(db, { email, password: 'first-password-123' }));
		await expect(handle.withPlatform((db) => createAdminUser(db, { email: email.toUpperCase(), password: 'other-password-123' }))).rejects.toMatchObject({ code: 'user_exists' });
		expect((await handle.withPlatform((db) => db.select().from(s.adminUsers).where(sql`lower(${s.adminUsers.email}) = ${email}`))).length).toBe(1);
	});

	it('ensures local users: creates once, and resets the password only when asked', async () => {
		const email = unique('seeded');
		const first = await handle.withPlatform((db) => ensureAdminUser(db, email, 'seed-password-1', { resetPassword: true }));
		expect(first.created).toBe(true);
		const kept = await handle.withPlatform((db) => ensureAdminUser(db, email, 'seed-password-2', { resetPassword: false }));
		expect(kept).toEqual({ id: first.id, created: false });
		expect(await verifyPassword('seed-password-1', (await userRow(email)).passwordHash)).toBe(true);
		await handle.withPlatform((db) => ensureAdminUser(db, email, 'seed-password-3', { resetPassword: true }));
		expect(await verifyPassword('seed-password-3', (await userRow(email)).passwordHash)).toBe(true);
	});

	it('is out of reach of the tenant role', async () => {
		const [org] = await handle.withPlatform((db) => db.select({ id: s.organizations.id }).from(s.organizations).limit(1));
		const organizationId = org?.id ?? randomUUID();
		for (const table of [s.adminUsers, s.adminSessions, s.adminSignInThrottle, s.adminTrustedDevices]) {
			await expect(handle.withTenant(organizationId, (tx) => tx.select().from(table))).rejects.toThrow();
		}
	});
});

describe('pnpm admin:user', () => {
	it('creates a user with a temporary password printed once, and a platform admin when asked', async () => {
		const email = unique('boot');
		const { out, lines } = capture();
		expect(await runAdminUserCommand(handle, ['create', email, '--platform-admin'], out)).toBe(0);
		const row = await userRow(email);
		const printed = lines.join('\n');
		const password = /Temporary password \(shown once\): (\S+)/.exec(printed)?.[1];
		expect(password).toBeDefined();
		expect(await verifyPassword(password!, row.passwordHash)).toBe(true);
		expect(row.mustChangePassword).toBe(true);
		expect(printed).not.toContain(row.passwordHash);
		const [admin] = await handle.withPlatform((db) => db.select().from(s.platformAdmins).where(eq(s.platformAdmins.userId, row.id)));
		expect(admin?.email).toBe(email);
		expect((await auditOf(row.id)).map((event) => [event.action, event.organizationId, event.metadata])).toEqual([
			['admin_user.created', null, { via: 'cli', platformAdmin: true }]
		]);
	});

	it('refuses to create an existing user and prints no password', async () => {
		const email = unique('again');
		await runAdminUserCommand(handle, ['create', email], capture().out);
		const { out, lines } = capture();
		expect(await runAdminUserCommand(handle, ['create', email.toUpperCase()], out)).toBe(1);
		expect(lines.join('\n')).toBe(`ERR A user with the email ${email} already exists. Use reset-password to give it a new password.`);
	});

	it('resets the password: new temporary password, must change it, every session ended', async () => {
		const email = unique('reset');
		await runAdminUserCommand(handle, ['create', email], capture().out);
		const before = await userRow(email);
		const session = await openSession(before.id);
		const device = await rememberDevice(before.id);
		await handle.withPlatform((db) => db.update(s.adminUsers).set({ mustChangePassword: false }).where(eq(s.adminUsers.id, before.id)));
		const { out, lines } = capture();
		expect(await runAdminUserCommand(handle, ['reset-password', email], out)).toBe(0);
		const password = /Temporary password \(shown once\): (\S+)/.exec(lines.join('\n'))?.[1];
		const after = await userRow(email);
		expect(await verifyPassword(password!, after.passwordHash)).toBe(true);
		expect(after.mustChangePassword).toBe(true);
		expect(await sessionRevoked(session)).toBe(true);
		expect(await deviceRevoked(device)).toBe(true);
		expect((await auditOf(before.id)).map((event) => event.action)).toContain('admin_user.password_reset');
	});

	it('resets MFA and disables a user, ending their sessions, without printing secrets', async () => {
		const email = unique('mfa');
		await runAdminUserCommand(handle, ['create', email], capture().out);
		const user = await userRow(email);
		await handle.withPlatform((db) => db.update(s.adminUsers).set({ totpSecretSealed: 'v1.sealed', totpConfirmedAt: new Date(), totpLastStep: 5 }).where(eq(s.adminUsers.id, user.id)));
		const first = await openSession(user.id);
		const firstDevice = await rememberDevice(user.id);
		const mfa = capture();
		expect(await runAdminUserCommand(handle, ['reset-mfa', email], mfa.out)).toBe(0);
		expect(mfa.lines).toEqual([`Removed the authenticator app of ${email} and ended its sessions. The next sign-in sets up a new one.`]);
		const reset = await userRow(email);
		expect([reset.totpSecretSealed, reset.totpConfirmedAt, reset.totpLastStep]).toEqual([null, null, null]);
		expect(await sessionRevoked(first)).toBe(true);
		expect(await deviceRevoked(firstDevice)).toBe(true);

		const second = await openSession(user.id);
		const secondDevice = await rememberDevice(user.id);
		const disabled = capture();
		expect(await runAdminUserCommand(handle, ['disable', email], disabled.out)).toBe(0);
		expect(disabled.lines).toEqual([`Disabled ${email} and ended its sessions.`]);
		expect((await userRow(email)).status).toBe('disabled');
		expect(await sessionRevoked(second)).toBe(true);
		expect(await deviceRevoked(secondDevice)).toBe(true);
		expect((await auditOf(user.id)).map((event) => event.action).sort()).toEqual(['admin_user.created', 'admin_user.disabled', 'admin_user.mfa_reset']);
	});

	it('explains its usage and refuses unknown users', async () => {
		for (const argv of [[], ['create'], ['delete', 'x@y.z'], ['create', 'x@y.z', '--force']]) {
			const { out, lines } = capture();
			expect(await runAdminUserCommand(handle, argv, out)).toBe(1);
			expect(lines.at(-1)).toContain('Usage: pnpm admin:user <create|reset-password|reset-mfa|disable> <email> [--platform-admin]');
		}
		const { out, lines } = capture();
		expect(await runAdminUserCommand(handle, ['disable', unique('nobody')], out)).toBe(1);
		expect(lines[0]).toMatch(/^ERR No user with the email nobody-/);
	});
});

describe('findAdminUserByEmail', () => {
	it('the lookup by email ignores case', async () => {
		const email = unique('Case');
		await handle.withPlatform((db) => createAdminUser(db, { email, password: 'case-password-123' }));
		expect((await handle.withPlatform((db) => findAdminUserByEmail(db, ` ${email.toUpperCase()} `)))?.email).toBe(email.toLowerCase());
	});
});
