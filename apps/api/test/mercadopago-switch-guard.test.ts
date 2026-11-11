import { randomUUID } from 'node:crypto';
import { and, eq, schema as s } from '@sortea/db';
import { totpCode, totpStep } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMercadoPago, loadMercadoPagoAccounts } from '../src/payments/integrations';
import { simulatorCollectorId } from '../src/payments/simulator';
import {
	checkoutBody,
	createTenant,
	createTestContext,
	enrolAuthenticator,
	headers,
	orderByReference,
	placeOrder,
	webhookRequest,
	type Authenticator,
	type TenantFixture,
	type TestContext
} from './helpers';

// Regression tests from the independent verification of the backup account
// (odd/tasks/console-polish-2026-11-11.md, S5, L3): no request without the
// platform admin's current authenticator code changes or removes the account
// that gets paid, disconnecting included, and the swap keeps its invariants
// under concurrency.

let ctx: TestContext;

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(() => ctx.close());

const token = () => `TEST-${randomUUID().replaceAll('-', '')}`;
const secret = () => `whsec-${randomUUID().replaceAll('-', '')}`;
const url = (tenant: TenantFixture) => `/platform/organizations/${tenant.id}/integrations/mercadopago`;

interface Admin {
	userId: string;
	auth: Record<string, string>;
	authenticator: Authenticator;
}

/** A fresh platform admin with a confirmed authenticator app, so throttles and used steps never leak between tests. */
async function platformAdmin(): Promise<Admin> {
	const userId = randomUUID();
	const email = `guard-${userId.slice(0, 8)}@test`;
	await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId, email }).onConflictDoNothing());
	const auth = { 'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN, authorization: `Bearer ${await ctx.signAdmin(userId, email)}` };
	return { userId, auth, authenticator: await enrolAuthenticator(ctx, userId) };
}

const connect = (admin: Admin, tenant: TenantFixture, payload: Record<string, unknown>) =>
	ctx.app.inject({ method: 'PUT', url: url(tenant), headers: admin.auth, payload: { mode: 'sandbox', ...payload } });
const disconnect = (admin: Admin, tenant: TenantFixture, payload?: Record<string, unknown>) =>
	ctx.app.inject({ method: 'DELETE', url: url(tenant), headers: admin.auth, ...(payload ? { payload } : {}) });
const activate = (admin: Admin, tenant: TenantFixture, integrationId: string, code: string) =>
	ctx.app.inject({ method: 'POST', url: `${url(tenant)}/${integrationId}/activate`, headers: admin.auth, payload: { code } });
const rows = (tenant: TenantFixture) =>
	ctx.db.withPlatform((db) =>
		db
			.select()
			.from(s.organizationIntegrations)
			.where(and(eq(s.organizationIntegrations.organizationId, tenant.id), eq(s.organizationIntegrations.provider, 'mercadopago')))
			.orderBy(s.organizationIntegrations.createdAt)
	);
const active = async (tenant: TenantFixture) => (await ctx.db.withTenant(tenant.id, (tx) => loadMercadoPago(tx, tenant.id, ctx.deps.keyRing)))!;
const accounts = (tenant: TenantFixture) => ctx.db.withTenant(tenant.id, (tx) => loadMercadoPagoAccounts(tx, tenant.id, ctx.deps.keyRing));
const events = (tenant: TenantFixture) => ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.paymentEvents).where(eq(s.paymentEvents.organizationId, tenant.id)));
const wrongCode = (admin: Admin) => {
	const right = totpCode(admin.authenticator.secret, totpStep(ctx.clock.now));
	return right === '000000' ? '111111' : '000000';
};
/** One active account and at most one backup, whatever ran. */
async function expectRoles(tenant: TenantFixture) {
	const all = await rows(tenant);
	expect(all.filter((row) => row.isActive)).toHaveLength(1);
	expect(all.filter((row) => !row.isActive && row.retiredAt === null).length).toBeLessThanOrEqual(1);
}

/** A tenant charging with the fixture account and a backup connected with known credentials. */
async function withBackup(admin: Admin, label: string) {
	const tenant = await createTenant(ctx, label);
	const principal = await active(tenant);
	const credentials = { accessToken: token(), webhookSecret: secret() };
	const response = await connect(admin, tenant, { ...credentials, role: 'backup' });
	expect(response.statusCode, response.body).toBe(200);
	const backup = (response.json().integrations as { id: string; role: string }[]).find((integration) => integration.role === 'backup')!;
	return { tenant, principal, backup, credentials };
}

describe('disconnecting needs the code (S5)', () => {
	// From the re-verification of 3c15cdd: the order of the checks before anything is deleted.
	it('nothing to disconnect is 404 without spending the code; no app is 409; a locked counter is 429', async () => {
		const admin = await platformAdmin();
		const tenant = await createTenant(ctx, 'guard-disc-404');
		expect((await disconnect(admin, tenant, { code: admin.authenticator.code() })).statusCode).toBe(200);
		const code = admin.authenticator.code();
		const none = await disconnect(admin, tenant, { code });
		expect([none.statusCode, none.json().error.code]).toEqual([404, 'not_found']);
		expect((await connect(admin, tenant, { accessToken: token(), webhookSecret: secret() })).statusCode).toBe(200);
		expect((await disconnect(admin, tenant, { code })).statusCode).toBe(200);

		const bare = await createTenant(ctx, 'guard-disc-noapp');
		const userId = randomUUID();
		await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId, email: `noapp-${userId.slice(0, 8)}@test` }));
		const noApp = { 'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN, authorization: `Bearer ${await ctx.signAdmin(userId, `noapp-${userId.slice(0, 8)}@test`)}` };
		const before = await rows(bare);
		const refused = await ctx.app.inject({ method: 'DELETE', url: url(bare), headers: noApp, payload: { code: '123456' } });
		expect([refused.statusCode, refused.json().error.code]).toEqual([409, 'totp_not_configured']);
		for (let i = 0; i < 5; i++) expect((await disconnect(admin, bare, { code: wrongCode(admin) })).statusCode).toBe(400);
		const locked = await disconnect(admin, bare, { code: totpCode(admin.authenticator.secret, totpStep(ctx.clock.now)) });
		expect([locked.statusCode, locked.json().error.code]).toEqual([429, 'too_many_attempts']);
		expect(await rows(bare)).toEqual(before);
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 16 * 60_000);
	});

	it('refuses without a code or with a wrong one and deletes nothing; the right code disconnects', async () => {
		const admin = await platformAdmin();
		const { tenant } = await withBackup(admin, 'guard-disc');
		const before = await rows(tenant);
		for (const payload of [undefined, {}, { code: '12345' }]) {
			const missing = await disconnect(admin, tenant, payload);
			expect([missing.statusCode, missing.json().error.code]).toEqual([400, 'invalid_request']);
		}
		const wrong = await disconnect(admin, tenant, { code: wrongCode(admin) });
		expect([wrong.statusCode, wrong.json().error.code]).toEqual([400, 'invalid_code']);
		expect(await rows(tenant)).toEqual(before);

		const done = await disconnect(admin, tenant, { code: admin.authenticator.code() });
		expect(done.statusCode, done.body).toBe(200);
		expect(await rows(tenant)).toEqual([]);
		const [event] = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.organizationId, tenant.id), eq(s.auditEvents.action, 'integration.mercadopago_disconnected')))
		);
		expect(event!.metadata).toMatchObject({ confirmedWith: 'totp' });
	});

	it('a replayed code is refused for disconnecting', async () => {
		const admin = await platformAdmin();
		const { tenant, backup } = await withBackup(admin, 'guard-disc-replay');
		const code = admin.authenticator.code();
		expect((await activate(admin, tenant, backup.id, code)).statusCode).toBe(200);
		const before = await rows(tenant);
		const replayed = await disconnect(admin, tenant, { code });
		expect([replayed.statusCode, replayed.json().error.code]).toEqual([400, 'invalid_code']);
		expect(await rows(tenant)).toEqual(before);
	});

	it('disconnect then connect without a code never leaves another collector active', async () => {
		const admin = await platformAdmin();
		const tenant = await createTenant(ctx, 'guard-disc-connect');
		const collector = (await active(tenant)).collectorId;
		const off = await disconnect(admin, tenant);
		expect(off.statusCode).toBe(400);
		const stranger = token();
		const on = await connect(admin, tenant, { accessToken: stranger, webhookSecret: secret() });
		expect([on.statusCode, on.json().error.code]).toEqual([409, 'switch_requires_backup']);
		expect((await active(tenant)).collectorId).toBe(collector);
		expect((await rows(tenant)).some((row) => row.publicConfig.collectorId === simulatorCollectorId(stranger))).toBe(false);
	});

	it('is still refused while a payment is in progress, checked after the code', async () => {
		const admin = await platformAdmin();
		const tenant = await createTenant(ctx, 'guard-disc-busy');
		await placeOrder(ctx, tenant);
		const wrong = await disconnect(admin, tenant, { code: wrongCode(admin) });
		expect(wrong.json().error.code).toBe('invalid_code');
		const busy = await disconnect(admin, tenant, { code: admin.authenticator.code() });
		expect([busy.statusCode, busy.json().error.code]).toEqual([409, 'payments_in_progress']);
		expect(await rows(tenant)).toHaveLength(1);
	});

	it('keeps the notifications when the accounts are deleted', async () => {
		const admin = await platformAdmin();
		const tenant = await createTenant(ctx, 'guard-disc-events');
		const principal = await active(tenant);
		expect((await ctx.app.inject(webhookRequest(tenant, 'ORD01KEPT', tenant.webhookSecret, 'payment'))).statusCode).toBe(200);
		expect((await disconnect(admin, tenant, { code: admin.authenticator.code() })).statusCode).toBe(200);
		expect((await events(tenant)).map((event) => [event.providerPaymentId, event.integrationId])).toEqual([['ORD01KEPT', principal.id]]);
	});
});

describe('the code is shared with the sign-in second factor (S5)', () => {
	const mfaVerify = (bearer: string, code: string) =>
		ctx.app.inject({ method: 'POST', url: '/auth/totp/verify', headers: { 'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN, authorization: `Bearer ${bearer}` }, payload: { code } });
	const passwordSession = (admin: Admin) => ctx.signAdmin(admin.userId, `guard-${admin.userId.slice(0, 8)}@test`, 'password');

	it('a code used to sign in is refused for a switch, and the reverse', async () => {
		const admin = await platformAdmin();
		const { tenant, principal, backup } = await withBackup(admin, 'guard-shared');
		const signInCode = admin.authenticator.code();
		expect((await mfaVerify(await passwordSession(admin), signInCode)).statusCode).toBe(200);
		const before = await rows(tenant);
		expect((await activate(admin, tenant, backup.id, signInCode)).json().error.code).toBe('invalid_code');
		expect(await rows(tenant)).toEqual(before);

		const switchCode = admin.authenticator.code();
		expect((await activate(admin, tenant, backup.id, switchCode)).statusCode).toBe(200);
		expect((await active(tenant)).id).not.toBe(principal.id);
		expect((await mfaVerify(await passwordSession(admin), switchCode)).statusCode).toBe(400);
	});

	it('5 wrong switch codes lock the sign-in second factor too, with the rows unchanged', async () => {
		const admin = await platformAdmin();
		const { tenant, backup } = await withBackup(admin, 'guard-lock');
		const before = await rows(tenant);
		const wrong = wrongCode(admin);
		for (let attempt = 0; attempt < 5; attempt++) expect((await activate(admin, tenant, backup.id, wrong)).statusCode).toBe(400);
		const right = totpCode(admin.authenticator.secret, totpStep(ctx.clock.now));
		const locked = await mfaVerify(await passwordSession(admin), right);
		expect([locked.statusCode, locked.json().error.code]).toEqual([429, 'too_many_attempts']);
		expect(await rows(tenant)).toEqual(before);
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 15 * 60_000);
	});
});

describe('the swap under concurrency', () => {
	it('three activations with one code: exactly one succeeds, one principal and at most one backup', async () => {
		const admin = await platformAdmin();
		const { tenant, backup } = await withBackup(admin, 'guard-race-code');
		const code = admin.authenticator.code();
		const answers = await Promise.all([0, 1, 2].map(() => activate(admin, tenant, backup.id, code)));
		expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 400, 400]);
		expect((await active(tenant)).id).toBe(backup.id);
		await expectRoles(tenant);
	});

	it('an activation racing another backup connection keeps one principal and at most one backup', async () => {
		const admin = await platformAdmin();
		const { tenant, backup } = await withBackup(admin, 'guard-race-backup');
		const [activated, connected] = await Promise.all([
			activate(admin, tenant, backup.id, admin.authenticator.code()),
			connect(admin, tenant, { accessToken: token(), webhookSecret: secret(), role: 'backup' })
		]);
		expect(activated.statusCode, activated.body).toBe(200);
		expect(connected.statusCode, connected.body).toBe(200);
		await expectRoles(tenant);
	});

	it('checkouts racing an activation each end on the principal or the backup, charged with that account', async () => {
		const admin = await platformAdmin();
		const { tenant, principal, backup } = await withBackup(admin, 'guard-race-checkout');
		const tokens = new Map((await accounts(tenant)).map((account) => [account.id, account.credentials.accessToken]));
		const [activated, ...placed] = await Promise.all([
			activate(admin, tenant, backup.id, admin.authenticator.code()),
			...[0, 1, 2, 3].map(() => ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant) }))
		]);
		expect(activated!.statusCode, activated!.body).toBe(200);
		for (const response of placed) {
			expect(response.statusCode, response.body).toBe(201);
			const order = await orderByReference(ctx, tenant, response.json().reference);
			expect([principal.id, backup.id]).toContain(order.paymentIntegrationId);
			const checkoutId = new URL(response.json().redirectUrl).searchParams.get('order_id')!;
			expect(ctx.simulator.orders.get(checkoutId)!.accessToken).toBe(tokens.get(order.paymentIntegrationId!));
		}
		await expectRoles(tenant);
	});
});

describe('after a swap', () => {
	it('"Verificar conexión" without an account checks the new principal, and nothing switches', async () => {
		const admin = await platformAdmin();
		const { tenant, backup, credentials } = await withBackup(admin, 'guard-verify');
		expect((await activate(admin, tenant, backup.id, admin.authenticator.code())).statusCode).toBe(200);
		const checked: string[] = [];
		const original = ctx.simulator.verifyAccount.bind(ctx.simulator);
		ctx.simulator.verifyAccount = async (used) => {
			checked.push(used.accessToken);
			return original(used);
		};
		try {
			expect((await ctx.app.inject({ method: 'POST', url: `${url(tenant)}/verify`, headers: admin.auth })).statusCode).toBe(200);
		} finally {
			ctx.simulator.verifyAccount = original;
		}
		expect(checked).toEqual([credentials.accessToken]);
		expect((await active(tenant)).id).toBe(backup.id);
	});

	it("updating an account's credentials with the other account's token is collector_mismatch on both, rows unchanged", async () => {
		const admin = await platformAdmin();
		const { tenant, principal, backup, credentials } = await withBackup(admin, 'guard-cross-token');
		const before = await rows(tenant);
		for (const [target, foreign] of [
			[principal.id, credentials.accessToken],
			[backup.id, principal.credentials.accessToken]
		] as const) {
			const response = await ctx.app.inject({ method: 'PATCH', url: `${url(tenant)}/${target}`, headers: admin.auth, payload: { accessToken: foreign } });
			expect([response.statusCode, response.json().error.code]).toEqual([409, 'collector_mismatch']);
		}
		expect(await rows(tenant)).toEqual(before);
	});

	it('an order placed before the swap and paid after it records the notification on the former principal', async () => {
		const admin = await platformAdmin();
		const { tenant, principal, backup } = await withBackup(admin, 'guard-pinned-event');
		const order = await placeOrder(ctx, tenant);
		expect((await activate(admin, tenant, backup.id, admin.authenticator.code())).statusCode).toBe(200);
		const payment = ctx.simulator.pay(order.checkoutId, 'approved');
		expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('paid');
		const [event] = (await events(tenant)).filter((candidate) => candidate.providerPaymentId === payment.id);
		expect(event).toMatchObject({ integrationId: principal.id, outcome: 'paid' });
	});
});
