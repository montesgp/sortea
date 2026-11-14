import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, schema as s } from '@sortea/db';
import { createAdminUser, disableAdminUser } from '@sortea/db/admin-users';
import { base32Decode, totpCode, totpStep } from '@sortea/domain/server';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, tokenHash } from '../src/lib/admin-auth';
import { createTenant, createTestContext, headers, INTERNAL_TOKEN, type TenantFixture, type TestContext } from './helpers';

// Back-office sign-in owned by the API (ADR 0020, "Back-office sign-in";
// docs/spec/SECURITY.md, "Acceso al panel").
const PASSWORD = 'una-clave-larga-de-prueba';
const lines: string[] = [];
let ctx: TestContext;
let tenant: TenantFixture;

beforeAll(async () => {
	ctx = await createTestContext({ logStream: { write: (line) => void lines.push(line) } });
	tenant = await createTenant(ctx, 'signin');
});
afterAll(() => ctx.close());

const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}@signin.test`;
let addressCounter = 0;
const freshAddress = () => `10.9.${Math.floor(++addressCounter / 250)}.${addressCounter % 250}`;

async function member(context: TestContext, organizationId: string, options: { mustChangePassword?: boolean; email?: string } = {}) {
	const email = options.email ?? unique('member');
	const user = await context.db.withPlatform((db) => createAdminUser(db, { email, password: PASSWORD, mustChangePassword: options.mustChangePassword ?? false }));
	await context.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId, userId: user.id, email, role: 'org_owner' }));
	return { id: user.id, email };
}

function signIn(context: TestContext, host: string, body: Record<string, unknown>, address = freshAddress()) {
	return context.app.inject({ method: 'POST', url: '/auth/sign-in', headers: { 'x-internal-token': INTERNAL_TOKEN, 'x-tenant-host': host, 'x-client-ip': address }, payload: body });
}

const bearer = (fixture: Pick<TenantFixture, 'host'>, token: string) => headers(fixture, { authorization: `Bearer ${token}` });

async function signedIn(context: TestContext, fixture: TenantFixture, email: string) {
	const response = await signIn(context, fixture.host, { email, password: PASSWORD });
	expect(response.statusCode).toBe(200);
	return response.json().token as string;
}

const panel = (context: TestContext, fixture: TenantFixture, token: string) => context.app.inject({ method: 'GET', url: '/admin/session', headers: bearer(fixture, token) });

async function auditActions(context: TestContext, userId: string) {
	const rows = await context.db.withPlatform((db) => db.select().from(s.auditEvents).where(and(eq(s.auditEvents.targetType, 'admin_user'), eq(s.auditEvents.targetId, userId))));
	return rows.map((row) => row.action);
}

describe('sign-in', () => {
	it('returns an opaque token whose hash is all the database keeps', async () => {
		const user = await member(ctx, tenant.id);
		const response = await signIn(ctx, tenant.host, { email: user.email.toUpperCase(), password: PASSWORD, userAgent: 'Mozilla/5.0 '.repeat(40) });
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(Object.keys(body).sort()).toEqual(['assurance', 'expiresAt', 'mfaRequired', 'mustChangePassword', 'token', 'totpConfirmed']);
		expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const sessions = await ctx.db.withPlatform((db) => db.select().from(s.adminSessions).where(eq(s.adminSessions.userId, user.id)));
		expect(sessions).toHaveLength(1);
		expect(JSON.stringify(sessions)).not.toContain(body.token);
		expect(sessions[0]!.tokenHash).toBe(tokenHash(body.token));
		expect(sessions[0]!.assurance).toBe('password');
		expect(sessions[0]!.userAgent).toHaveLength(160);
		expect((await panel(ctx, tenant, body.token)).json().user).toEqual({ id: user.id, email: user.email, alias: null, assurance: 'password' });
		expect(await auditActions(ctx, user.id)).toContain('admin.signed_in');
	});

	it('answers an unknown email, a wrong password and a disabled account the same way', async () => {
		const user = await member(ctx, tenant.id);
		const disabled = await member(ctx, tenant.id);
		await ctx.db.withPlatform((db) => disableAdminUser(db, disabled.id));
		const attempts = [
			{ email: unique('nobody'), password: PASSWORD },
			{ email: user.email, password: 'otra-clave-equivocada' },
			{ email: disabled.email, password: PASSWORD }
		];
		const answers = [];
		for (const attempt of attempts) {
			const response = await signIn(ctx, tenant.host, attempt);
			answers.push([response.statusCode, response.body]);
		}
		expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
		expect(answers[0]).toEqual([401, JSON.stringify({ error: { code: 'invalid_credentials', message: 'Email o contraseña incorrectos' } })]);
		const reasons = await ctx.db.withPlatform((db) => db.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'admin.sign_in_failed')));
		expect(reasons.map((row) => row.metadata.reason)).toEqual(expect.arrayContaining(['unknown_account', 'wrong_password', 'disabled']));
		expect(JSON.stringify(reasons)).not.toMatch(/nobody-|otra-clave/);
	});

	it('spends one password verification on an unknown email too', async () => {
		const user = await member(ctx, tenant.id);
		const time = async (body: Record<string, unknown>) => {
			const started = performance.now();
			await signIn(ctx, tenant.host, body);
			return performance.now() - started;
		};
		await time({ email: unique('warm'), password: 'x' });
		const wrong = Math.min(await time({ email: user.email, password: 'wrong-1' }), await time({ email: user.email, password: 'wrong-2' }));
		const unknown = Math.min(await time({ email: unique('ghost'), password: 'wrong-1' }), await time({ email: unique('ghost'), password: 'wrong-2' }));
		// scrypt with the default parameters dominates both paths.
		expect(unknown).toBeGreaterThan(wrong * 0.5);
	});
});

describe('throttle', () => {
	it('locks an account for unknown devices after 10 failures, audits it once, and forgets it after 15 minutes', async () => {
		const user = await member(ctx, tenant.id);
		for (let attempt = 0; attempt < 10; attempt++) expect((await signIn(ctx, tenant.host, { email: user.email, password: `guess-${attempt}` })).statusCode).toBe(401);
		const locked = await signIn(ctx, tenant.host, { email: user.email, password: PASSWORD });
		expect(locked.statusCode).toBe(429);
		expect(locked.json().error).toEqual({ code: 'too_many_attempts', message: 'Demasiados intentos fallidos. Esperá unos minutos y probá de nuevo.', details: { retryAfterSeconds: 900 } });
		expect((await auditActions(ctx, user.id)).filter((action) => action === 'admin.sign_in_locked')).toHaveLength(1);

		// A browser the account signed in from before has its own budget.
		const known = await signIn(ctx, tenant.host, { email: user.email, password: PASSWORD, device: 'device-of-the-owner-123' });
		expect(known.statusCode).toBe(200);

		ctx.clock.now = new Date(ctx.clock.now.getTime() + 15 * 60_000);
		expect((await signIn(ctx, tenant.host, { email: user.email, password: PASSWORD })).statusCode).toBe(200);
	});

	it('counts unknown emails like known ones, so a lock reveals nothing', async () => {
		const email = unique('ghost');
		for (let attempt = 0; attempt < 10; attempt++) await signIn(ctx, tenant.host, { email, password: `guess-${attempt}` });
		expect((await signIn(ctx, tenant.host, { email, password: 'guess' })).statusCode).toBe(429);
		const rows = await ctx.db.withPlatform((db) => db.select().from(s.adminSignInThrottle));
		expect(JSON.stringify(rows)).not.toContain(email);
	});

	it('limits one address to 30 failures over any accounts', async () => {
		const address = freshAddress();
		for (let attempt = 0; attempt < 30; attempt++) await signIn(ctx, tenant.host, { email: unique('spray'), password: 'guess' }, address);
		const user = await member(ctx, tenant.id);
		expect((await signIn(ctx, tenant.host, { email: user.email, password: PASSWORD }, address)).statusCode).toBe(429);
		expect((await signIn(ctx, tenant.host, { email: user.email, password: PASSWORD })).statusCode).toBe(200);
	});
});

describe('sessions', () => {
	it('end after 30 idle minutes, and each use pushes that forward', async () => {
		const user = await member(ctx, tenant.id);
		const token = await signedIn(ctx, tenant, user.email);
		const start = ctx.clock.now.getTime();
		ctx.clock.now = new Date(start + 20 * 60_000);
		expect((await panel(ctx, tenant, token)).statusCode).toBe(200);
		ctx.clock.now = new Date(start + 45 * 60_000);
		expect((await panel(ctx, tenant, token)).statusCode).toBe(200);
		ctx.clock.now = new Date(start + 45 * 60_000 + SESSION_IDLE_MS);
		const expired = await panel(ctx, tenant, token);
		expect(expired.statusCode).toBe(401);
		expect(expired.json().error.code).toBe('unauthenticated');
	});

	it('end 12 hours after sign-in even when used all along', async () => {
		const user = await member(ctx, tenant.id);
		const token = await signedIn(ctx, tenant, user.email);
		const start = ctx.clock.now.getTime();
		for (let at = 25 * 60_000; at < SESSION_ABSOLUTE_MS; at += 25 * 60_000) {
			ctx.clock.now = new Date(start + at);
			expect((await panel(ctx, tenant, token)).statusCode).toBe(200);
		}
		ctx.clock.now = new Date(start + SESSION_ABSOLUTE_MS);
		expect((await panel(ctx, tenant, token)).statusCode).toBe(401);
	});

	it('end at once on sign-out and when the user is disabled', async () => {
		const user = await member(ctx, tenant.id);
		const first = await signedIn(ctx, tenant, user.email);
		const signOut = await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: bearer(tenant, first) });
		expect(signOut.statusCode).toBe(204);
		expect((await panel(ctx, tenant, first)).statusCode).toBe(401);
		expect(await auditActions(ctx, user.id)).toContain('admin.signed_out');

		const second = await signedIn(ctx, tenant, user.email);
		await ctx.db.withPlatform((db) => db.update(s.adminUsers).set({ status: 'disabled' }).where(eq(s.adminUsers.id, user.id)));
		expect((await panel(ctx, tenant, second)).statusCode).toBe(401);
	});

	it('a new sign-in from the same browser ends the session it held before', async () => {
		const user = await member(ctx, tenant.id);
		const first = await signedIn(ctx, tenant, user.email);
		const other = await signedIn(ctx, tenant, user.email);
		const again = await signIn(ctx, tenant.host, { email: user.email, password: PASSWORD, previousToken: first });
		expect(again.statusCode).toBe(200);
		expect((await panel(ctx, tenant, first)).statusCode).toBe(401);
		expect((await panel(ctx, tenant, again.json().token)).statusCode).toBe(200);
		// Another browser's session is not touched.
		expect((await panel(ctx, tenant, other)).statusCode).toBe(200);
		// A failed sign-in leaves the held session alone.
		const held = again.json().token as string;
		expect((await signIn(ctx, tenant.host, { email: user.email, password: 'otra-clave-equivocada', previousToken: held })).statusCode).toBe(401);
		expect((await panel(ctx, tenant, held)).statusCode).toBe(200);
	});

	it('refuse forged and missing tokens', async () => {
		for (const token of ['', 'x'.repeat(43), 'a'.repeat(300)]) {
			expect((await ctx.app.inject({ method: 'GET', url: '/admin/session', headers: headers(tenant, token ? { authorization: `Bearer ${token}` } : {}) })).statusCode).toBe(401);
		}
	});
});

describe('second factor', () => {
	let strict: TestContext;
	let strictTenant: TenantFixture;

	beforeAll(async () => {
		strict = await createTestContext({ requireMfa: true });
		strictTenant = await createTenant(strict, 'mfa');
	});
	afterAll(() => strict.close());

	async function enrol(token: string) {
		const response = await strict.app.inject({ method: 'POST', url: '/auth/totp/enrol', headers: bearer(strictTenant, token) });
		expect(response.statusCode).toBe(200);
		return response.json() as { uri: string; secret: string; qrSvg: string };
	}
	const confirm = (token: string, code: string) => strict.app.inject({ method: 'POST', url: '/auth/totp/confirm', headers: bearer(strictTenant, token), payload: { code } });
	const verify = (token: string, code: string) => strict.app.inject({ method: 'POST', url: '/auth/totp/verify', headers: bearer(strictTenant, token), payload: { code } });

	it('is required for the panel with REQUIRE_ADMIN_MFA, enrolled once and confirmed with a code', async () => {
		const user = await member(strict, strictTenant.id);
		const token = await signedIn(strict, strictTenant, user.email);
		const refused = await panel(strict, strictTenant, token);
		expect([refused.statusCode, refused.json().error.code]).toEqual([403, 'mfa_required']);

		const first = await enrol(token);
		const second = await enrol(token);
		expect(second.secret).not.toBe(first.secret);
		expect(second.uri).toBe(`otpauth://totp/${strictTenant.host}:${encodeURIComponent(user.email)}?secret=${second.secret}&issuer=${strictTenant.host}&algorithm=SHA1&digits=6&period=30`);
		expect(second.qrSvg.startsWith('<svg')).toBe(true);
		const [row] = await strict.db.withPlatform((db) => db.select().from(s.adminUsers).where(eq(s.adminUsers.id, user.id)));
		expect(row!.totpSecretSealed).toMatch(/^v1\./);
		expect(row!.totpSecretSealed).not.toContain(second.secret);
		expect(row!.totpConfirmedAt).toBeNull();

		const secret = base32Decode(second.secret);
		expect((await confirm(token, totpCode(base32Decode(first.secret), totpStep(strict.clock.now)))).statusCode).toBe(400);
		const confirmed = await confirm(token, totpCode(secret, totpStep(strict.clock.now)));
		expect(confirmed.json()).toEqual({ assurance: 'mfa', token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(String) });
		const upgraded = confirmed.json().token as string;
		expect((await panel(strict, strictTenant, upgraded)).statusCode).toBe(200);
		const again = await strict.app.inject({ method: 'POST', url: '/auth/totp/enrol', headers: bearer(strictTenant, upgraded) });
		expect([again.statusCode, again.json().error.code]).toEqual([409, 'totp_confirmed']);
	});

	it('accepts a code one step either side, each step once', async () => {
		const user = await member(strict, strictTenant.id);
		const enrolling = await signedIn(strict, strictTenant, user.email);
		const { secret: encoded } = await enrol(enrolling);
		const secret = base32Decode(encoded);
		const step = totpStep(strict.clock.now);
		expect((await confirm(enrolling, totpCode(secret, step - 1))).statusCode).toBe(200);

		const next = await signedIn(strict, strictTenant, user.email);
		// The step used to confirm, and older ones, are spent.
		for (const used of [step - 1, step - 2]) {
			const replay = await verify(next, totpCode(secret, used));
			expect([replay.statusCode, replay.json().error.code]).toEqual([400, 'invalid_code']);
		}
		expect((await verify(next, totpCode(secret, step + 1))).statusCode).toBe(200);
		const later = await signedIn(strict, strictTenant, user.email);
		expect((await verify(later, totpCode(secret, step + 1))).statusCode).toBe(400);
		expect((await verify(later, totpCode(secret, step + 2))).statusCode).toBe(400);
		strict.clock.now = new Date(strict.clock.now.getTime() + 60_000);
		expect((await verify(later, totpCode(secret, step + 2))).statusCode).toBe(200);
		expect(await auditActions(strict, user.id)).toEqual(expect.arrayContaining(['admin.mfa_enrolment_started', 'admin.mfa_enrolled', 'admin.mfa_verified', 'admin.mfa_failed']));
	});

	it('rotates the session token when the code is accepted: the token from before the code no longer works', async () => {
		const user = await member(strict, strictTenant.id);
		const before = await signedIn(strict, strictTenant, user.email);
		const { secret } = await enrol(before);
		const [original] = await strict.db.withPlatform((db) => db.select().from(s.adminSessions).where(eq(s.adminSessions.tokenHash, tokenHash(before))));
		strict.clock.now = new Date(strict.clock.now.getTime() + 5 * 60_000);
		const confirmed = await confirm(before, totpCode(base32Decode(secret), totpStep(strict.clock.now)));
		const after = confirmed.json().token as string;
		expect(after).not.toBe(before);
		expect((await panel(strict, strictTenant, before)).statusCode).toBe(401);
		expect((await panel(strict, strictTenant, after)).statusCode).toBe(200);
		// The new session keeps the absolute expiry of the sign-in: a code never extends it.
		const [rotated] = await strict.db.withPlatform((db) => db.select().from(s.adminSessions).where(eq(s.adminSessions.tokenHash, tokenHash(after))));
		expect(rotated!.assurance).toBe('mfa');
		expect(rotated!.expiresAt.toISOString()).toBe(original!.expiresAt.toISOString());
		expect(confirmed.json().expiresAt).toBe(original!.expiresAt.toISOString());

		// The same for each later sign-in's code.
		const next = await signedIn(strict, strictTenant, user.email);
		strict.clock.now = new Date(strict.clock.now.getTime() + 60_000);
		const verified = await verify(next, totpCode(base32Decode(secret), totpStep(strict.clock.now)));
		expect(verified.json().token).not.toBe(next);
		expect((await panel(strict, strictTenant, next)).statusCode).toBe(401);
	});

	it('locks the code check after 5 wrong codes', async () => {
		const user = await member(strict, strictTenant.id);
		const token = await signedIn(strict, strictTenant, user.email);
		const { secret } = await enrol(token);
		for (let attempt = 0; attempt < 5; attempt++) expect((await confirm(token, '000000')).statusCode).toBe(400);
		const locked = await confirm(token, totpCode(base32Decode(secret), totpStep(strict.clock.now)));
		expect(locked.statusCode).toBe(429);
	});

	it('cancels an enrolment that never got a code, and keeps a confirmed one', async () => {
		const user = await member(strict, strictTenant.id);
		const token = await signedIn(strict, strictTenant, user.email);
		await enrol(token);
		expect((await strict.app.inject({ method: 'POST', url: '/auth/totp/cancel', headers: bearer(strictTenant, token) })).statusCode).toBe(204);
		const session = await strict.app.inject({ method: 'GET', url: '/auth/session', headers: bearer(strictTenant, token) });
		expect(session.json()).toMatchObject({ assurance: 'password', totp: { confirmed: false, pending: false }, mfaRequired: true, mustChangePassword: false });
	});
});

describe('password change', () => {
	const change = (context: TestContext, fixture: TenantFixture, token: string, payload: Record<string, unknown>) =>
		context.app.inject({ method: 'POST', url: '/auth/password', headers: bearer(fixture, token), payload });

	it('needs the current password and ends every other session', async () => {
		const user = await member(ctx, tenant.id);
		const other = await signedIn(ctx, tenant, user.email);
		const current = await signedIn(ctx, tenant, user.email);
		const wrong = await change(ctx, tenant, current, { currentPassword: 'no-es-esta', newPassword: 'una-nueva-clave-larga' });
		expect([wrong.statusCode, wrong.json().error.code]).toEqual([400, 'wrong_password']);
		const short = await change(ctx, tenant, current, { currentPassword: PASSWORD, newPassword: 'corta' });
		expect(short.statusCode).toBe(400);
		const done = await change(ctx, tenant, current, { currentPassword: PASSWORD, newPassword: 'una-nueva-clave-larga' });
		expect(done.json()).toEqual({ endedSessions: 1 });
		expect((await panel(ctx, tenant, other)).statusCode).toBe(401);
		expect((await panel(ctx, tenant, current)).statusCode).toBe(200);
		expect((await signIn(ctx, tenant.host, { email: user.email, password: PASSWORD })).statusCode).toBe(401);
		expect((await signIn(ctx, tenant.host, { email: user.email, password: 'una-nueva-clave-larga' })).statusCode).toBe(200);
		expect(await auditActions(ctx, user.id)).toEqual(expect.arrayContaining(['admin.password_change_failed', 'admin.password_changed']));
	});

	it('is required before the panel when someone else chose the password', async () => {
		const user = await member(ctx, tenant.id, { mustChangePassword: true });
		const login = await signIn(ctx, tenant.host, { email: user.email, password: PASSWORD });
		expect(login.json().mustChangePassword).toBe(true);
		const token = login.json().token;
		const refused = await panel(ctx, tenant, token);
		expect([refused.statusCode, refused.json().error]).toEqual([403, { code: 'password_change_required', message: 'Elegí una contraseña nueva para continuar' }]);
		expect((await change(ctx, tenant, token, { currentPassword: PASSWORD, newPassword: 'mi-clave-propia-larga' })).statusCode).toBe(200);
		expect((await panel(ctx, tenant, token)).statusCode).toBe(200);
	});

	it('with an authenticator app, asks for its code before the password change', async () => {
		const strict = await createTestContext({ requireMfa: true });
		try {
			const fixture = await createTenant(strict, 'order');
			const user = await member(strict, fixture.id, { mustChangePassword: true });
			await strict.db.withPlatform((db) => db.update(s.adminUsers).set({ totpConfirmedAt: new Date(), totpSecretSealed: 'v1.x.y.z' }).where(eq(s.adminUsers.id, user.id)));
			const token = await signedIn(strict, fixture, user.email);
			expect((await panel(strict, fixture, token)).json().error.code).toBe('mfa_required');
			expect((await change(strict, fixture, token, { currentPassword: PASSWORD, newPassword: 'mi-clave-propia-larga' })).json().error.code).toBe('mfa_required');
		} finally {
			await strict.close();
		}
	});
});

describe('platform console accounts', () => {
	let staff: Record<string, string>;
	beforeAll(async () => {
		const adminId = randomUUID();
		await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: adminId, email: 'staff-users@test' }));
		staff = { 'x-internal-token': INTERNAL_TOKEN, authorization: `Bearer ${await ctx.signAdmin(adminId, 'staff-users@test')}` };
	});

	it('creates a user with a temporary password shown once, which must be changed', async () => {
		const email = unique('Nueva');
		const created = await ctx.app.inject({ method: 'POST', url: '/platform/users', headers: staff, payload: { email } });
		expect(created.statusCode).toBe(201);
		const body = created.json();
		expect(body.user).toEqual({ id: expect.any(String), email: email.toLowerCase(), alias: null, platformAdmin: false });
		expect(body.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
		const login = await signIn(ctx, tenant.host, { email, password: body.temporaryPassword });
		expect(login.json().mustChangePassword).toBe(true);
		expect((await ctx.app.inject({ method: 'POST', url: '/platform/users', headers: staff, payload: { email: email.toUpperCase() } })).statusCode).toBe(409);
		const list = await ctx.app.inject({ method: 'GET', url: '/platform/users', headers: staff });
		const listed = list.json().users.find((user: { email: string }) => user.email === email.toLowerCase());
		expect(listed).toMatchObject({ status: 'active', mustChangePassword: true, mfa: false, platformAdmin: false, organizations: [] });
		expect(list.body).not.toMatch(/scrypt|password_hash|passwordHash|totp_secret|v1\./);
		expect(await auditActions(ctx, body.user.id)).toContain('admin_user.created');
	});

	it('is refused to organization staff', async () => {
		const owner = await ctx.signAdmin(tenant.ownerId, `owner-${tenant.id.slice(0, 4)}@test`);
		expect((await ctx.app.inject({ method: 'POST', url: '/platform/users', headers: bearer(tenant, owner), payload: { email: unique('x') } })).statusCode).toBe(403);
	});

	it('creates an organization with its owner, new or existing', async () => {
		const slug = `own-${randomUUID().slice(0, 6)}`;
		const newOwner = unique('dueno');
		const created = await ctx.app.inject({
			method: 'POST',
			url: '/platform/organizations',
			headers: staff,
			payload: { name: 'Con dueño', slug, orderPrefix: 'CD', hostname: `${slug}.test`, ownerEmail: newOwner }
		});
		expect(created.statusCode).toBe(201);
		const owner = created.json().owner;
		expect(owner).toEqual({ email: newOwner, created: true, temporaryPassword: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/) });
		expect(created.json().members).toEqual([{ userId: expect.any(String), email: newOwner, alias: null, role: 'org_owner', status: 'active' }]);
		const login = await signIn(ctx, `${slug}.test`, { email: newOwner, password: owner.temporaryPassword });
		expect(login.statusCode).toBe(200);

		const existing = await member(ctx, tenant.id);
		const slug2 = `own-${randomUUID().slice(0, 6)}`;
		const linked = await ctx.app.inject({
			method: 'POST',
			url: '/platform/organizations',
			headers: staff,
			payload: { name: 'Con dueño existente', slug: slug2, orderPrefix: 'CE', hostname: `${slug2}.test`, ownerEmail: existing.email.toUpperCase() }
		});
		expect(linked.json().owner).toEqual({ email: existing.email, created: false, temporaryPassword: null });
		expect(await signIn(ctx, `${slug2}.test`, { email: existing.email, password: PASSWORD }).then((response) => response.statusCode)).toBe(200);

		const slug3 = `own-${randomUUID().slice(0, 6)}`;
		const none = await ctx.app.inject({ method: 'POST', url: '/platform/organizations', headers: staff, payload: { name: 'Sin dueño', slug: slug3, orderPrefix: 'SD', hostname: `${slug3}.test`, ownerEmail: '' } });
		expect([none.statusCode, none.json().owner, none.json().members]).toEqual([201, null, []]);
	});
});

describe('logs', () => {
	it('never carry passwords, tokens or TOTP secrets', async () => {
		lines.length = 0;
		const user = await member(ctx, tenant.id);
		const token = await signedIn(ctx, tenant, user.email);
		await signIn(ctx, tenant.host, { email: user.email, password: 'otra-clave-equivocada' });
		const enrolment = (await ctx.app.inject({ method: 'POST', url: '/auth/totp/enrol', headers: bearer(tenant, token) })).json();
		const log = lines.join('\n');
		expect(log).toContain('/auth/sign-in');
		for (const secret of [PASSWORD, 'otra-clave-equivocada', token, enrolment.secret]) expect(log).not.toContain(secret);
	});
});
