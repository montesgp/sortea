import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, schema as s } from '@sortea/db';
import { createAdminUser, disableAdminUser, resetAdminMfa, resetAdminPassword } from '@sortea/db/admin-users';
import { base32Decode, totpCode, totpStep } from '@sortea/domain/server';
import { TRUSTED_DEVICE_MS, trustedDeviceHash } from '../src/lib/admin-auth';
import { createTenant, createTestContext, headers, INTERNAL_TOKEN, type TenantFixture, type TestContext } from './helpers';

// Remember this device for 30 days after the second factor
// (odd/tasks/launch-prep-2026-11-10.md, T1, S1, L4; docs/spec/SECURITY.md,
// "Acceso al panel"). A remembered browser still needs the password; it only
// skips the code.
const PASSWORD = 'una-clave-larga-de-prueba';
const DAY = 24 * 60 * 60_000;
let ctx: TestContext;
let tenant: TenantFixture;

beforeAll(async () => {
	ctx = await createTestContext({ requireMfa: true });
	tenant = await createTenant(ctx, 'trusted');
});
afterAll(() => ctx.close());

const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}@trusted.test`;
let addressCounter = 0;
const freshAddress = () => `10.8.${Math.floor(++addressCounter / 250)}.${addressCounter % 250}`;
const bearer = (token: string) => headers(tenant, { authorization: `Bearer ${token}` });

function signIn(body: Record<string, unknown>, address = freshAddress()) {
	return ctx.app.inject({ method: 'POST', url: '/auth/sign-in', headers: { 'x-internal-token': INTERNAL_TOKEN, 'x-tenant-host': tenant.host, 'x-client-ip': address }, payload: body });
}
const panel = (token: string) => ctx.app.inject({ method: 'GET', url: '/admin/session', headers: bearer(token) });
const code = (secret: Uint8Array) => totpCode(secret, totpStep(ctx.clock.now));
/** Each code is accepted once per step, so every new code comes a step later. */
const nextStep = () => void (ctx.clock.now = new Date(ctx.clock.now.getTime() + 30_000));

async function member(options: { mustChangePassword?: boolean } = {}) {
	const email = unique('member');
	const user = await ctx.db.withPlatform((db) => createAdminUser(db, { email, password: PASSWORD, mustChangePassword: options.mustChangePassword ?? false }));
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: user.id, email, role: 'org_owner' }));
	return { id: user.id, email };
}

async function passwordSession(email: string, extra: Record<string, unknown> = {}) {
	const response = await signIn({ email, password: PASSWORD, ...extra });
	expect(response.statusCode).toBe(200);
	return response.json() as { token: string; assurance: 'password' | 'mfa'; mustChangePassword: boolean };
}

/** A user with a confirmed authenticator app, and its secret. */
async function enrolled(options: { mustChangePassword?: boolean } = {}) {
	const user = await member(options);
	const { token } = await passwordSession(user.email);
	const enrolment = await ctx.app.inject({ method: 'POST', url: '/auth/totp/enrol', headers: bearer(token) });
	const secret = base32Decode(enrolment.json().secret);
	const confirmed = await ctx.app.inject({ method: 'POST', url: '/auth/totp/confirm', headers: bearer(token), payload: { code: code(secret) } });
	expect(confirmed.statusCode).toBe(200);
	nextStep();
	return { ...user, secret };
}

/** Signs in with the password and verifies a code asking to remember the browser; returns the device token. */
async function remembered(user: { email: string; secret: Uint8Array }, userAgent = 'Firefox/140') {
	const { token } = await passwordSession(user.email, { userAgent });
	const verified = await ctx.app.inject({ method: 'POST', url: '/auth/totp/verify', headers: bearer(token), payload: { code: code(user.secret), remember: true } });
	expect(verified.statusCode).toBe(200);
	nextStep();
	return verified.json().trustedDevice.token as string;
}

const devicesOf = (userId: string) => ctx.db.withPlatform((db) => db.select().from(s.adminTrustedDevices).where(eq(s.adminTrustedDevices.userId, userId)));

async function auditOf(userId: string) {
	return ctx.db.withPlatform((db) => db.select().from(s.auditEvents).where(and(eq(s.auditEvents.targetType, 'admin_user'), eq(s.auditEvents.targetId, userId))));
}

describe('remembering a device', () => {
	it('after a correct code with "remember", returns a device token whose hash is all the database keeps, for 30 days', async () => {
		const user = await enrolled();
		const { token } = await passwordSession(user.email, { userAgent: 'Mozilla/5.0 '.repeat(40) });
		const verified = await ctx.app.inject({ method: 'POST', url: '/auth/totp/verify', headers: bearer(token), payload: { code: code(user.secret), remember: true } });
		expect(verified.statusCode).toBe(200);
		const body = verified.json();
		expect(Object.keys(body).sort()).toEqual(['assurance', 'expiresAt', 'token', 'trustedDevice']);
		expect(body.trustedDevice).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: new Date(ctx.clock.now.getTime() + 30 * DAY).toISOString() });
		expect(TRUSTED_DEVICE_MS).toBe(30 * DAY);

		const devices = await devicesOf(user.id);
		expect(devices).toHaveLength(1);
		expect(devices[0]!.tokenHash).toBe(trustedDeviceHash(body.trustedDevice.token));
		expect(JSON.stringify(devices)).not.toContain(body.trustedDevice.token);
		expect(devices[0]!.userAgent).toHaveLength(160);
		expect([devices[0]!.revokedAt, devices[0]!.lastUsedAt]).toEqual([null, null]);
		expect(devices[0]!.expiresAt.toISOString()).toBe(body.trustedDevice.expiresAt);

		const audit = await auditOf(user.id);
		expect(audit.filter((event) => event.action === 'admin.device_remembered').map((event) => event.metadata)).toEqual([{ expiresAt: body.trustedDevice.expiresAt }]);
		expect(JSON.stringify(audit)).not.toContain(body.trustedDevice.token);
	});

	it('remembers nothing without the choice or with a wrong code', async () => {
		const user = await enrolled();
		const { token } = await passwordSession(user.email);
		const wrong = await ctx.app.inject({ method: 'POST', url: '/auth/totp/verify', headers: bearer(token), payload: { code: '000000', remember: true } });
		expect([wrong.statusCode, wrong.json().error.code]).toEqual([400, 'invalid_code']);
		const plain = await ctx.app.inject({ method: 'POST', url: '/auth/totp/verify', headers: bearer(token), payload: { code: code(user.secret) } });
		expect(Object.keys(plain.json()).sort()).toEqual(['assurance', 'expiresAt', 'token']);
		expect(await devicesOf(user.id)).toEqual([]);
	});

	it('can be chosen with the first code of a new app too', async () => {
		const user = await member();
		const { token } = await passwordSession(user.email);
		const secret = base32Decode((await ctx.app.inject({ method: 'POST', url: '/auth/totp/enrol', headers: bearer(token) })).json().secret);
		const confirmed = await ctx.app.inject({ method: 'POST', url: '/auth/totp/confirm', headers: bearer(token), payload: { code: code(secret), remember: true } });
		expect(confirmed.json().trustedDevice.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		nextStep();
		expect((await passwordSession(user.email, { trustedDevice: confirmed.json().trustedDevice.token })).assurance).toBe('mfa');
	});
});

describe('signing in on a remembered device', () => {
	it('with the correct password skips the code: the session is `mfa` and opens the panel', async () => {
		const user = await enrolled();
		const device = await remembered(user);
		const plain = await passwordSession(user.email);
		expect(plain.assurance).toBe('password');
		expect((await panel(plain.token)).json().error.code).toBe('mfa_required');

		const signedIn = await passwordSession(user.email, { trustedDevice: device });
		expect(signedIn.assurance).toBe('mfa');
		expect((await panel(signedIn.token)).statusCode).toBe(200);
		const [row] = await devicesOf(user.id);
		expect(row!.lastUsedAt?.toISOString()).toBe(ctx.clock.now.toISOString());
		const signIns = (await auditOf(user.id)).filter((event) => event.action === 'admin.signed_in');
		expect(signIns.at(-1)!.metadata).toMatchObject({ rememberedDevice: true });
	});

	it('expires 30 days after it was remembered, however often it is used', async () => {
		const user = await enrolled();
		const device = await remembered(user);
		const [created] = await devicesOf(user.id);
		const start = ctx.clock.now.getTime();
		for (const day of [10, 20, 29]) {
			ctx.clock.now = new Date(start + day * DAY);
			expect((await passwordSession(user.email, { trustedDevice: device })).assurance).toBe('mfa');
		}
		const [used] = await devicesOf(user.id);
		expect(used!.expiresAt.toISOString()).toBe(created!.expiresAt.toISOString());
		ctx.clock.now = new Date(created!.expiresAt.getTime());
		expect((await passwordSession(user.email, { trustedDevice: device })).assurance).toBe('password');
	});

	it('is refused for another user, a tampered or unknown token, and a revoked device', async () => {
		const user = await enrolled();
		const other = await enrolled();
		const device = await remembered(user);
		const tampered = `${device.slice(0, -1)}${device.endsWith('A') ? 'B' : 'A'}`;
		for (const trustedDevice of [tampered, 'x'.repeat(43), 'a'.repeat(300)]) {
			expect((await passwordSession(user.email, { trustedDevice })).assurance).toBe('password');
		}
		// Another user's device token never verifies this account, nor does it end it.
		expect((await passwordSession(other.email, { trustedDevice: device })).assurance).toBe('password');
		expect((await passwordSession(user.email, { trustedDevice: device })).assurance).toBe('mfa');

		await ctx.db.withPlatform((db) => db.update(s.adminTrustedDevices).set({ revokedAt: ctx.clock.now }).where(eq(s.adminTrustedDevices.userId, user.id)));
		expect((await passwordSession(user.email, { trustedDevice: device })).assurance).toBe('password');
	});

	it('still needs the right password, an active account, the throttle and a new password when one is due', async () => {
		const user = await enrolled();
		const device = await remembered(user);
		const wrong = await signIn({ email: user.email, password: 'otra-clave-equivocada', trustedDevice: device });
		expect([wrong.statusCode, wrong.json().error.code]).toEqual([401, 'invalid_credentials']);
		expect(wrong.json()).not.toHaveProperty('token');

		// 10 failures lock the account for unknown browsers; a remembered device token is no way around it.
		for (let attempt = 0; attempt < 10; attempt++) await signIn({ email: user.email, password: `guess-${attempt}` });
		const locked = await signIn({ email: user.email, password: PASSWORD, trustedDevice: device });
		expect([locked.statusCode, locked.json().error.code]).toEqual([429, 'too_many_attempts']);
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 15 * 60_000);

		await ctx.db.withPlatform((db) => db.update(s.adminUsers).set({ mustChangePassword: true }).where(eq(s.adminUsers.id, user.id)));
		const due = await passwordSession(user.email, { trustedDevice: device });
		expect([due.assurance, due.mustChangePassword]).toEqual(['mfa', true]);
		expect((await panel(due.token)).json().error.code).toBe('password_change_required');

		await ctx.db.withPlatform((db) => db.update(s.adminUsers).set({ status: 'disabled', mustChangePassword: false }).where(eq(s.adminUsers.id, user.id)));
		const disabled = await signIn({ email: user.email, password: PASSWORD, trustedDevice: device });
		expect([disabled.statusCode, disabled.json().error.code]).toEqual([401, 'invalid_credentials']);
	});
});

describe('forgetting devices', () => {
	const change = (token: string, payload: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/auth/password', headers: bearer(token), payload });
	const count = (token: string) => ctx.app.inject({ method: 'GET', url: '/auth/trusted-devices', headers: bearer(token) });
	const forget = (token: string) => ctx.app.inject({ method: 'POST', url: '/auth/trusted-devices/forget', headers: bearer(token) });

	it('"Mi cuenta" counts the active devices and forgets them all, audited without tokens', async () => {
		const user = await enrolled();
		const other = await enrolled();
		const first = await remembered(user);
		const second = await remembered(user, 'Chrome/140');
		const others = await remembered(other);
		const expired = await remembered(user);
		await ctx.db.withPlatform((db) => db.update(s.adminTrustedDevices).set({ expiresAt: ctx.clock.now }).where(eq(s.adminTrustedDevices.tokenHash, trustedDeviceHash(expired))));

		const session = await passwordSession(user.email, { trustedDevice: first });
		expect((await count(session.token)).json()).toEqual({ active: 2 });
		const forgotten = await forget(session.token);
		expect([forgotten.statusCode, forgotten.json()]).toEqual([200, { forgotten: 2 }]);
		expect((await count(session.token)).json()).toEqual({ active: 0 });
		// The current session stays open; only the devices are forgotten.
		expect((await panel(session.token)).statusCode).toBe(200);
		for (const device of [first, second]) expect((await passwordSession(user.email, { trustedDevice: device })).assurance).toBe('password');
		expect((await passwordSession(other.email, { trustedDevice: others })).assurance).toBe('mfa');

		const audit = await auditOf(user.id);
		expect(audit.filter((event) => event.action === 'admin.trusted_devices_forgotten').map((event) => event.metadata)).toEqual([{ count: 2 }]);
		expect(JSON.stringify(audit)).not.toContain(first);
		expect((await count('not-a-session')).statusCode).toBe(401);
		expect((await forget('not-a-session')).statusCode).toBe(401);
	});

	it('signing out keeps the device remembered', async () => {
		const user = await enrolled();
		const device = await remembered(user);
		const session = await passwordSession(user.email, { trustedDevice: device });
		expect((await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: bearer(session.token) })).statusCode).toBe(204);
		expect((await passwordSession(user.email, { trustedDevice: device })).assurance).toBe('mfa');
	});

	it('changing the password forgets every device of the user, this one included', async () => {
		const user = await enrolled();
		const device = await remembered(user);
		const other = await remembered(user);
		const session = await passwordSession(user.email, { trustedDevice: device });
		const done = await change(session.token, { currentPassword: PASSWORD, newPassword: 'una-nueva-clave-larga' });
		expect(done.statusCode).toBe(200);
		for (const trustedDevice of [device, other]) {
			const again = await signIn({ email: user.email, password: 'una-nueva-clave-larga', trustedDevice });
			expect(again.json().assurance).toBe('password');
		}
		expect((await devicesOf(user.id)).every((row) => row.revokedAt !== null)).toBe(true);
		const changed = (await auditOf(user.id)).find((event) => event.action === 'admin.password_changed');
		expect(changed!.metadata).toMatchObject({ forgottenDevices: 2 });
	});

	it('a platform password reset, MFA reset or disable forgets every device', async () => {
		for (const reset of [
			(userId: string) => ctx.db.withPlatform((db) => resetAdminPassword(db, userId, ctx.clock.now)),
			(userId: string) => ctx.db.withPlatform((db) => resetAdminMfa(db, userId, ctx.clock.now)),
			(userId: string) => ctx.db.withPlatform((db) => disableAdminUser(db, userId, ctx.clock.now))
		]) {
			const user = await enrolled();
			await remembered(user);
			await remembered(user);
			await reset(user.id);
			const devices = await devicesOf(user.id);
			expect(devices).toHaveLength(2);
			expect(devices.every((row) => row.revokedAt?.toISOString() === ctx.clock.now.toISOString())).toBe(true);
		}
	});
});

// Independent verification of S1 (launch prep 2026-11-10): the device never stands in for the
// password, the throttle, a confirmed app or the user, and a bad cookie value never blocks a sign-in.
describe('remembered device: verification probes (S1)', () => {
	it('wrong passwords sent with a valid device still count and lock', async () => {
		const user = await enrolled();
		const device = await remembered(user);
		for (let i = 0; i < 10; i++) await signIn({ email: user.email, password: `bad-${i}`, trustedDevice: device }, `10.99.${i}.1`);
		const response = await signIn({ email: user.email, password: PASSWORD, trustedDevice: device });
		expect(response.statusCode).toBe(429);
		expect((await devicesOf(user.id))[0]!.lastUsedAt).toBeNull();
	});

	it('needs a confirmed app; after an MFA reset the old device stays refused, also once a new app is enrolled', async () => {
		const user = await enrolled();
		const device = await remembered(user);
		await ctx.db.withPlatform((db) => resetAdminMfa(db, user.id, ctx.clock.now));
		const first = await passwordSession(user.email, { trustedDevice: device });
		expect(first.assurance).toBe('password');
		const secret = base32Decode((await ctx.app.inject({ method: 'POST', url: '/auth/totp/enrol', headers: bearer(first.token) })).json().secret);
		await ctx.app.inject({ method: 'POST', url: '/auth/totp/confirm', headers: bearer(first.token), payload: { code: code(secret) } });
		nextStep();
		expect((await passwordSession(user.email, { trustedDevice: device })).assurance).toBe('password');
	});

	it("another user's device is neither accepted nor marked used", async () => {
		const a = await enrolled();
		const b = await enrolled();
		const device = await remembered(a);
		expect((await passwordSession(b.email, { trustedDevice: device })).assurance).toBe('password');
		expect((await devicesOf(a.id))[0]!.lastUsedAt).toBeNull();
	});

	it('stores a domain-separated hash with an absolute 30-day expiry; device and session tokens never cross', async () => {
		const user = await enrolled();
		const device = await remembered(user);
		expect(device).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const [row] = await devicesOf(user.id);
		expect(row!.tokenHash).toBe(trustedDeviceHash(device));
		expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(TRUSTED_DEVICE_MS);
		expect((await panel(device)).statusCode).toBe(401);
		const signedIn = await signIn({ email: user.email, password: PASSWORD, trustedDevice: device });
		expect(signedIn.body).not.toContain(device);
		expect(JSON.stringify(await auditOf(user.id))).not.toContain(row!.tokenHash);
	});

	it('ignores an unusable device value instead of refusing the sign-in', async () => {
		const user = await enrolled();
		for (const trustedDevice of ['', ' ', 'a'.repeat(201), 'a'.repeat(2001), 'a'.repeat(4000)]) {
			expect((await passwordSession(user.email, { trustedDevice })).assurance, `length ${trustedDevice.length}`).toBe('password');
		}
	});
});
