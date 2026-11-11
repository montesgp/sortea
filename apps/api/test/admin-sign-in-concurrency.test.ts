import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, schema as s, sql } from '@sortea/db';
import { createAdminUser } from '@sortea/db/admin-users';
import { hashPassword, parsePasswordHash } from '@sortea/domain/server';
import { createTenant, createTestContext, headers, INTERNAL_TOKEN, type TenantFixture, type TestContext } from './helpers';

// docs/spec/SECURITY.md, "Acceso al panel": limits hold under concurrent requests; MFA gate on platform routes.
const PASSWORD = 'una-clave-larga-de-prueba';
let ctx: TestContext;
let tenant: TenantFixture;
let strict: TestContext;
let strictTenant: TenantFixture;
beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'burst');
	strict = await createTestContext({ requireMfa: true });
	strictTenant = await createTenant(strict, 'burstmfa');
});
afterAll(async () => {
	await ctx.close();
	await strict.close();
});
const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}@burst.test`;
let n = 0;
const address = () => `10.77.${Math.floor(++n / 250)}.${n % 250}`;
const signIn = (c: TestContext, host: string, body: Record<string, unknown>) =>
	c.app.inject({ method: 'POST', url: '/auth/sign-in', headers: { 'x-internal-token': INTERNAL_TOKEN, 'x-tenant-host': host, 'x-client-ip': address() }, payload: body });
const bearer = (f: { host: string }, token: string) => headers(f, { authorization: `Bearer ${token}` });
async function member(c: TestContext, organizationId: string) {
	const email = unique('m');
	const user = await c.db.withPlatform((db) => createAdminUser(db, { email, password: PASSWORD, mustChangePassword: false }));
	await c.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId, userId: user.id, email, role: 'org_owner' }));
	return { id: user.id, email };
}

describe('throttles under concurrent requests', () => {
	it('checks at most 10 passwords of one account in a burst', async () => {
		const user = await member(ctx, tenant.id);
		const codes = (await Promise.all(Array.from({ length: 30 }, (_, i) => signIn(ctx, tenant.host, { email: user.email, password: `wrong-${i}` })))).map((r) => r.statusCode);
		expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(10);
		expect(codes.every((c) => c === 401 || c === 429)).toBe(true);
	});
	it('refuses the right password once a burst passed the limit', async () => {
		const user = await member(ctx, tenant.id);
		for (let i = 0; i < 9; i++) await signIn(ctx, tenant.host, { email: user.email, password: `w${i}` });
		const burst = await Promise.all([
			...Array.from({ length: 10 }, (_, i) => signIn(ctx, tenant.host, { email: user.email, password: `b${i}` })),
			signIn(ctx, tenant.host, { email: user.email, password: PASSWORD })
		]);
		expect(burst.at(-1)!.statusCode).toBe(429);
	});
	it('never fails with 500 when failures race a success', async () => {
		const user = await member(ctx, tenant.id);
		for (let round = 0; round < 3; round++) {
			const rs = await Promise.all([
				signIn(ctx, tenant.host, { email: user.email, password: PASSWORD }),
				...Array.from({ length: 8 }, (_, i) => signIn(ctx, tenant.host, { email: user.email, password: `w${i}` })),
				signIn(ctx, tenant.host, { email: user.email, password: PASSWORD })
			]);
			expect(rs.map((r) => r.statusCode)).not.toContain(500);
		}
	});
	it('checks at most 5 TOTP codes in a burst', async () => {
		const user = await member(strict, strictTenant.id);
		const token = (await signIn(strict, strictTenant.host, { email: user.email, password: PASSWORD })).json().token;
		await strict.app.inject({ method: 'POST', url: '/auth/totp/enrol', headers: bearer(strictTenant, token) });
		const rs = await Promise.all(
			Array.from({ length: 20 }, (_, i) => strict.app.inject({ method: 'POST', url: '/auth/totp/confirm', headers: bearer(strictTenant, token), payload: { code: String(100000 + i) } }))
		);
		expect(rs.filter((r) => r.statusCode === 400).length).toBeLessThanOrEqual(5);
	});
});

describe('password change under concurrent requests', () => {
	it('checks at most 5 current passwords in a burst and never fails with 500', async () => {
		const user = await member(ctx, tenant.id);
		const token = (await signIn(ctx, tenant.host, { email: user.email, password: PASSWORD })).json().token;
		const rs = await Promise.all(
			Array.from({ length: 15 }, (_, i) =>
				ctx.app.inject({ method: 'POST', url: '/auth/password', headers: bearer(tenant, token), payload: { currentPassword: `wrong-${i}`, newPassword: 'otra-clave-nueva-larga' } })
			)
		);
		const codes = rs.map((r) => r.statusCode);
		expect(codes.filter((c) => c === 400).length).toBeLessThanOrEqual(5);
		expect(codes.every((c) => c === 400 || c === 429)).toBe(true);
	});
});

describe('gates and hashes', () => {
	it('REQUIRE_ADMIN_MFA blocks every platform route for a password-only platform admin', async () => {
		const email = unique('staff');
		const created = await strict.db.withPlatform((db) => createAdminUser(db, { email, password: PASSWORD, mustChangePassword: false }));
		await strict.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: created.id, email }));
		const token = (await signIn(strict, strictTenant.host, { email, password: PASSWORD })).json().token;
		const slug = `gate-${randomUUID().slice(0, 6)}`;
		const calls = [
			['GET', '/platform/users', undefined],
			['POST', '/platform/users', { email: unique('x'), platformAdmin: true }],
			['POST', '/platform/organizations', { name: 'X', slug, orderPrefix: 'XX', hostname: `${slug}.test`, ownerEmail: unique('o') }],
			['GET', '/platform/organizations', undefined]
		] as const;
		for (const [method, url, payload] of calls) {
			const r = await strict.app.inject({ method, url, headers: bearer(strictTenant, token), payload: payload as never });
			expect([r.statusCode, r.json().error?.code]).toEqual([403, 'mfa_required']);
		}
		expect(await strict.db.withPlatform((db) => db.select().from(s.organizations).where(eq(s.organizations.slug, slug)))).toHaveLength(0);
	});
	it('raises a weaker hash at sign-in and never lowers a stronger one', async () => {
		const weak = await member(ctx, tenant.id);
		const strong = await member(ctx, tenant.id);
		await ctx.db.withPlatform(async (db) => {
			await db.update(s.adminUsers).set({ passwordHash: await hashPassword(PASSWORD, { N: 16384, r: 8, p: 1 }) }).where(eq(s.adminUsers.id, weak.id));
			await db.update(s.adminUsers).set({ passwordHash: await hashPassword(PASSWORD, { N: 65536, r: 8, p: 1 }) }).where(eq(s.adminUsers.id, strong.id));
		});
		for (const u of [weak, strong]) expect((await signIn(ctx, tenant.host, { email: u.email, password: PASSWORD })).statusCode).toBe(200);
		const rows = await ctx.db.withPlatform((db) => db.select().from(s.adminUsers).where(sql`${s.adminUsers.id} in (${weak.id}, ${strong.id})`));
		const n = Object.fromEntries(rows.map((r) => [r.id, parsePasswordHash(r.passwordHash)!.N]));
		expect([n[weak.id], n[strong.id]]).toEqual([32768, 65536]);
	});
});

// Independent re-verification of cd52e3b: a lock reached late in a window used to end with the window.
describe('a lock holds its full 15 minutes, even past the window', () => {
	it('account: the right password and further guesses get 429 after the window ends', async () => {
		const user = await member(ctx, tenant.id);
		await signIn(ctx, tenant.host, { email: user.email, password: 'w-first' });
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 14 * 60_000 + 50_000);
		for (let i = 0; i < 9; i++) await signIn(ctx, tenant.host, { email: user.email, password: `w${i}` });
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 20_000);
		expect((await signIn(ctx, tenant.host, { email: user.email, password: PASSWORD })).statusCode).toBe(429);
		expect((await signIn(ctx, tenant.host, { email: user.email, password: 'w-more' })).statusCode).toBe(429);
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 15 * 60_000);
		expect((await signIn(ctx, tenant.host, { email: user.email, password: PASSWORD })).statusCode).toBe(200);
	});

	it('TOTP: codes after a late lock get 429', async () => {
		const user = await member(strict, strictTenant.id);
		const token = (await signIn(strict, strictTenant.host, { email: user.email, password: PASSWORD })).json().token;
		await strict.app.inject({ method: 'POST', url: '/auth/totp/enrol', headers: bearer(strictTenant, token) });
		const confirm = (code: string) => strict.app.inject({ method: 'POST', url: '/auth/totp/confirm', headers: bearer(strictTenant, token), payload: { code } });
		await confirm('000000');
		strict.clock.now = new Date(strict.clock.now.getTime() + 14 * 60_000 + 50_000);
		for (let i = 1; i <= 4; i++) await confirm(String(i).padStart(6, '0'));
		strict.clock.now = new Date(strict.clock.now.getTime() + 20_000);
		expect((await confirm('000009')).statusCode).toBe(429);
	});
});

describe('a new sign-in ends only its own previous session', () => {
	it("another user's token sent as previousToken is left alone", async () => {
		const a = await member(ctx, tenant.id);
		const b = await member(ctx, tenant.id);
		const tokenA = (await signIn(ctx, tenant.host, { email: a.email, password: PASSWORD })).json().token;
		expect((await signIn(ctx, tenant.host, { email: b.email, password: PASSWORD, previousToken: tokenA })).statusCode).toBe(200);
		const session = await ctx.app.inject({ method: 'GET', url: '/auth/session', headers: bearer(tenant, tokenA) });
		expect(session.statusCode).toBe(200);
	});
});
