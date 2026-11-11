import { randomUUID } from 'node:crypto';
import { and, eq, schema as s } from '@sortea/db';
import { WEBHOOK_SECRET_IS_ACCESS_TOKEN } from '@sortea/domain';
import { totpCode, totpStep } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadMercadoPago, loadMercadoPagoAccounts } from '../src/payments/integrations';
import { ProviderError } from '../src/payments/provider';
import { simulatorCollectorId } from '../src/payments/simulator';
import {
	adminHeaders,
	createTenant,
	createTestContext,
	enrolAuthenticator,
	orderByReference,
	placeOrder,
	webhookRequest,
	type Authenticator,
	type TenantFixture,
	type TestContext
} from './helpers';

// The backup Mercado Pago account (odd/tasks/console-polish-2026-11-11.md, S4-S6,
// L2, L3): connected and verified without charging, checked on its own, and made
// the principal with the platform admin's authenticator code, the former
// principal becoming the backup. Every way to change who gets paid needs the code.

let ctx: TestContext;
let auth: Record<string, string>;
let authenticator: Authenticator;
const platformAdmin = '00000000-0000-4000-8000-00000000b4c1';
const lines: string[] = [];

beforeAll(async () => {
	ctx = await createTestContext({ logStream: { write: (line) => void lines.push(line) } });
	await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: platformAdmin, email: 'backup@test' }).onConflictDoNothing());
	auth = { 'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN, authorization: `Bearer ${await ctx.signAdmin(platformAdmin, 'backup@test')}` };
	authenticator = await enrolAuthenticator(ctx, platformAdmin);
});
afterAll(() => ctx.close());

const token = () => `TEST-${randomUUID().replaceAll('-', '')}`;
const secret = () => `whsec-${randomUUID().replaceAll('-', '')}`;
const url = (tenant: TenantFixture) => `/platform/organizations/${tenant.id}/integrations/mercadopago`;
const connect = (tenant: TenantFixture, payload: Record<string, unknown>, as = auth) =>
	ctx.app.inject({ method: 'PUT', url: url(tenant), headers: as, payload: { mode: 'sandbox', ...payload } });
const connectBackup = (tenant: TenantFixture, accessToken = token(), webhookSecret = secret()) => connect(tenant, { accessToken, webhookSecret, role: 'backup' });
const activate = (tenant: TenantFixture, integrationId: string, payload?: Record<string, unknown>, as = auth) =>
	ctx.app.inject({ method: 'POST', url: `${url(tenant)}/${integrationId}/activate`, headers: as, ...(payload ? { payload } : {}) });
const verify = (tenant: TenantFixture, integrationId: string, as = auth) => ctx.app.inject({ method: 'POST', url: `${url(tenant)}/${integrationId}/verify`, headers: as });
const rows = (tenant: TenantFixture) =>
	ctx.db.withPlatform((db) =>
		db
			.select()
			.from(s.organizationIntegrations)
			.where(and(eq(s.organizationIntegrations.organizationId, tenant.id), eq(s.organizationIntegrations.provider, 'mercadopago')))
			.orderBy(s.organizationIntegrations.createdAt)
	);
const active = async (tenant: TenantFixture) => (await ctx.db.withTenant(tenant.id, (tx) => loadMercadoPago(tx, tenant.id, ctx.deps.keyRing)))!;
const opened = async (tenant: TenantFixture, integrationId: string) =>
	(await ctx.db.withTenant(tenant.id, (tx) => loadMercadoPagoAccounts(tx, tenant.id, ctx.deps.keyRing))).find((account) => account.id === integrationId)!;
const audits = (tenant: TenantFixture, action: string) =>
	ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.organizationId, tenant.id), eq(s.auditEvents.action, action))));
const userAudits = (action: string) =>
	ctx.db.withPlatform((db) => db.select().from(s.auditEvents).where(and(eq(s.auditEvents.targetId, platformAdmin), eq(s.auditEvents.action, action))));
type Listed = { id: string; role: string; isActive: boolean; retiredAt: string | null; status: string; collectorId: string | null; lastWebhook: unknown };
const listed = (response: { json(): { integrations: Listed[] } }) => response.json().integrations;
const detail = async (tenant: TenantFixture) => listed(await ctx.app.inject({ method: 'GET', url: `/platform/organizations/${tenant.id}`, headers: auth }));

/** A tenant charging with the fixture's account (the principal) and a backup connected with known credentials. */
async function withBackup(label: string) {
	const tenant = await createTenant(ctx, label);
	const principal = await active(tenant);
	const credentials = { accessToken: token(), webhookSecret: secret() };
	const response = await connectBackup(tenant, credentials.accessToken, credentials.webhookSecret);
	expect(response.statusCode, response.body).toBe(200);
	const backup = listed(response).find((integration) => integration.role === 'backup')!;
	return { tenant, principal, backup, credentials };
}

describe('connecting a backup account (S4)', () => {
	it('checks it with Mercado Pago and stores it verified without changing the account that charges', async () => {
		const tenant = await createTenant(ctx, 'bk-connect');
		const principal = await active(tenant);
		const accessToken = token();
		const response = await connectBackup(tenant, accessToken);
		expect(response.statusCode, response.body).toBe(200);
		expect(response.body).not.toContain(accessToken);

		const integrations = listed(response);
		expect(integrations.find((integration) => integration.id === principal.id)).toMatchObject({ role: 'principal', isActive: true, retiredAt: null });
		const backup = integrations.find((integration) => integration.role === 'backup')!;
		expect(backup).toMatchObject({ isActive: false, retiredAt: null, status: 'verified', collectorId: simulatorCollectorId(accessToken) });
		expect((await active(tenant)).id).toBe(principal.id);

		// Checkout keeps charging the principal.
		const order = await placeOrder(ctx, tenant);
		expect((await orderByReference(ctx, tenant, order.reference)).paymentIntegrationId).toBe(principal.id);
		expect(ctx.simulator.orders.get(order.checkoutId)!.accessToken).toBe(principal.credentials.accessToken);

		const [event] = await audits(tenant, 'integration.mercadopago_backup_connected');
		expect(event).toMatchObject({ actorId: platformAdmin, targetId: backup.id, metadata: { mode: 'sandbox', collectorId: simulatorCollectorId(accessToken) } });
		expect(JSON.stringify(event)).not.toContain(accessToken);
		expect(await audits(tenant, 'integration.mercadopago_updated')).toEqual([]);
	});

	it('validates like connecting: a refused token, a token pasted as the secret and a sandbox token in production store nothing', async () => {
		const tenant = await createTenant(ctx, 'bk-validate');
		const before = await rows(tenant);
		const refused = await connectBackup(tenant, 'APP_USR-1234567890-rejected-by-provider');
		expect([refused.statusCode, refused.json().error.code]).toEqual([400, 'credentials_rejected']);
		const pasted = await connectBackup(tenant, token(), token());
		expect(pasted.json().error).toMatchObject({ code: 'invalid_webhook_secret', message: WEBHOOK_SECRET_IS_ACCESS_TOKEN });
		const production = await connect(tenant, { mode: 'production', accessToken: token(), webhookSecret: secret(), role: 'backup' });
		expect(production.json().error).toMatchObject({ code: 'invalid_token' });
		expect(await rows(tenant)).toEqual(before);
	});

	it('refuses the principal itself as the backup, and a backup without a principal', async () => {
		const tenant = await createTenant(ctx, 'bk-self');
		const principal = await active(tenant);
		const before = await rows(tenant);
		const same = await connectBackup(tenant, principal.credentials.accessToken, principal.credentials.webhookSecret);
		expect(same.statusCode).toBe(409);
		expect(same.json().error).toMatchObject({
			code: 'already_principal',
			message: 'Esa cuenta ya es la principal. Para renovar sus credenciales, usá «Actualizar credenciales» en la cuenta principal.'
		});
		expect(await rows(tenant)).toEqual(before);

		const empty = await createTenant(ctx, 'bk-empty', { mercadoPago: false });
		const orphan = await connectBackup(empty);
		expect(orphan.statusCode).toBe(409);
		expect(orphan.json().error).toMatchObject({ code: 'principal_required', message: 'Primero conectá la cuenta principal; la de respaldo se suma después.' });
		expect(await rows(empty)).toEqual([]);
	});

	it('keeps at most one backup: another one moves the previous backup to the previous accounts', async () => {
		const { tenant, principal, backup } = await withBackup('bk-one');
		const replacement = token();
		const response = await connectBackup(tenant, replacement);
		expect(response.statusCode, response.body).toBe(200);
		const after = await rows(tenant);
		expect(after.filter((row) => !row.isActive && row.retiredAt === null).map((row) => row.publicConfig.collectorId)).toEqual([simulatorCollectorId(replacement)]);
		expect(after.find((row) => row.id === backup.id)!.retiredAt).not.toBeNull();
		expect(after.filter((row) => row.isActive).map((row) => row.id)).toEqual([principal.id]);
		expect(listed(response).find((integration) => integration.id === backup.id)!.role).toBe('previous');
		const events = await audits(tenant, 'integration.mercadopago_backup_connected');
		// Audit rows come back unordered: the replacement is the event of the other account.
		expect(events.find((event) => event.targetId !== backup.id)!.metadata).toMatchObject({ replacedBackupId: backup.id, replacedCollectorId: backup.collectorId });
	});

	it('the same backup merchant saved again rotates its credentials in place', async () => {
		const { tenant, backup } = await withBackup('bk-rotate');
		const [before] = (await rows(tenant)).filter((row) => row.id === backup.id);
		const spy = vi.spyOn(ctx.simulator, 'verifyAccount').mockResolvedValueOnce({ collectorId: backup.collectorId!, nickname: null, testUser: true, simulator: true });
		const renewed = { accessToken: token(), webhookSecret: secret() };
		try {
			expect((await connectBackup(tenant, renewed.accessToken, renewed.webhookSecret)).statusCode).toBe(200);
		} finally {
			spy.mockRestore();
		}
		const after = await rows(tenant);
		expect(after).toHaveLength(2);
		expect(after.find((row) => row.id === backup.id)).toMatchObject({ isActive: false, retiredAt: null, version: before!.version + 1 });
		expect((await opened(tenant, backup.id)).credentials).toEqual(renewed);
	});

	it('updates its credentials in place and it stays the backup', async () => {
		const { tenant, backup, credentials } = await withBackup('bk-patch');
		const renewed = secret();
		const response = await ctx.app.inject({ method: 'PATCH', url: `${url(tenant)}/${backup.id}`, headers: auth, payload: { webhookSecret: renewed } });
		expect(response.statusCode, response.body).toBe(200);
		expect(listed(response).find((integration) => integration.id === backup.id)).toMatchObject({ role: 'backup', isActive: false, retiredAt: null });
		expect((await opened(tenant, backup.id)).credentials).toEqual({ accessToken: credentials.accessToken, webhookSecret: renewed });
	});
});

describe('the principal cannot be switched without the code (S5)', () => {
	it('connecting another merchant or mode as the principal is refused while one charges; a rotation of the principal is not', async () => {
		const tenant = await createTenant(ctx, 'bk-no-put-switch');
		const principal = await active(tenant);
		const before = await rows(tenant);
		const other = await connect(tenant, { accessToken: token(), webhookSecret: secret() });
		expect(other.statusCode).toBe(409);
		expect(other.json().error).toMatchObject({
			code: 'switch_requires_backup',
			message: 'Esta organización ya cobra con otra cuenta. Conectá la nueva como cuenta de respaldo y después usá «Usar como principal», que pide el código de tu app de autenticación.'
		});
		// The same merchant in the other mode is another account too.
		const spy = vi.spyOn(ctx.simulator, 'verifyAccount').mockResolvedValueOnce({ collectorId: principal.collectorId!, nickname: null, testUser: false });
		try {
			const otherMode = await connect(tenant, { mode: 'production', accessToken: `APP_USR-${randomUUID().replaceAll('-', '')}`, webhookSecret: secret() });
			expect(otherMode.json().error.code).toBe('switch_requires_backup');
		} finally {
			spy.mockRestore();
		}
		expect(await rows(tenant)).toEqual(before);

		const rotated = await connect(tenant, { accessToken: principal.credentials.accessToken, webhookSecret: secret() });
		expect(rotated.statusCode, rotated.body).toBe(200);
		expect((await rows(tenant)).map((row) => [row.id, row.isActive])).toEqual([[principal.id, true]]);
	});

	it("a backup's credentials connected as the principal are refused too", async () => {
		const { tenant, credentials } = await withBackup('bk-put-backup');
		const before = await rows(tenant);
		const response = await connect(tenant, credentials);
		expect(response.json().error.code).toBe('switch_requires_backup');
		expect(await rows(tenant)).toEqual(before);
	});
});

describe('verifying each account on its own (S6)', () => {
	it('checks the backup with its own credentials and records it on the backup only, never switching', async () => {
		const { tenant, principal, backup, credentials } = await withBackup('bk-verify');
		const before = await rows(tenant);
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const calls = vi.spyOn(ctx.simulator, 'verifyAccount');
		let response;
		try {
			response = await verify(tenant, backup.id);
			expect(calls.mock.calls.map(([used]) => used.accessToken)).toEqual([credentials.accessToken]);
		} finally {
			calls.mockRestore();
		}
		expect(response.statusCode, response.body).toBe(200);
		const after = await rows(tenant);
		expect(after.find((row) => row.id === backup.id)).toMatchObject({ status: 'verified', lastVerifiedAt: ctx.clock.now, isActive: false, retiredAt: null });
		expect(after.find((row) => row.id === principal.id)).toEqual(before.find((row) => row.id === principal.id));
		const [event] = await audits(tenant, 'integration.mercadopago_verified');
		expect(event).toMatchObject({ targetId: backup.id, metadata: { status: 'verified', role: 'backup' } });
	});

	it('a refused backup is recorded with its error while the principal keeps charging', async () => {
		const { tenant, principal, backup } = await withBackup('bk-verify-bad');
		const before = (await rows(tenant)).find((row) => row.id === principal.id);
		const spy = vi.spyOn(ctx.simulator, 'verifyAccount').mockRejectedValueOnce(new ProviderError('unauthorized', 401));
		try {
			expect((await verify(tenant, backup.id)).statusCode).toBe(200);
		} finally {
			spy.mockRestore();
		}
		const shown = await detail(tenant);
		expect(shown.find((integration) => integration.id === backup.id)).toMatchObject({ status: 'error', role: 'backup' });
		expect(shown.find((integration) => integration.id === principal.id)).toMatchObject({ status: before!.status, role: 'principal' });
		expect((await rows(tenant)).find((row) => row.id === principal.id)).toEqual(before);
		expect((await active(tenant)).id).toBe(principal.id);
	});

	it('checks the principal and a previous account by id; another organization account answers 404', async () => {
		const { tenant, principal, backup } = await withBackup('bk-verify-any');
		expect((await connectBackup(tenant)).statusCode).toBe(200);
		for (const id of [principal.id, backup.id]) expect((await verify(tenant, id)).statusCode).toBe(200);
		const verified = (await audits(tenant, 'integration.mercadopago_verified')).map((event) => [event.targetId, event.metadata.role]);
		expect(verified.sort()).toEqual(
			[
				[principal.id, 'principal'],
				[backup.id, 'previous']
			].sort()
		);
		const other = await withBackup('bk-verify-other');
		expect((await verify(tenant, other.backup.id)).statusCode).toBe(404);
		expect((await verify(tenant, other.backup.id, await adminHeaders(ctx, tenant))).statusCode).toBe(403);
	});
});

describe('using the backup as the principal (S5, L2, L3)', () => {
	it('with the right code swaps the roles, keeps every credential and audits who switched from which account to which', async () => {
		const { tenant, principal, backup, credentials } = await withBackup('bk-swap');
		const before = await rows(tenant);
		const code = authenticator.code();
		const response = await activate(tenant, backup.id, { code });
		expect(response.statusCode, response.body).toBe(200);

		const integrations = listed(response);
		expect(integrations.find((integration) => integration.id === backup.id)).toMatchObject({ role: 'principal', isActive: true, retiredAt: null });
		expect(integrations.find((integration) => integration.id === principal.id)).toMatchObject({ role: 'backup', isActive: false, retiredAt: null });
		for (const row of await rows(tenant)) expect(row.sealedSecrets).toBe(before.find((previous) => previous.id === row.id)!.sealedSecrets);
		expect((await active(tenant)).credentials).toEqual(credentials);

		const [event] = await audits(tenant, 'integration.mercadopago_promoted');
		expect(event).toMatchObject({
			actorType: 'platform_admin',
			actorId: platformAdmin,
			targetId: backup.id,
			metadata: { mode: 'sandbox', collectorId: backup.collectorId, previousIntegrationId: principal.id, previousCollectorId: principal.collectorId, confirmedWith: 'totp' }
		});
		expect(JSON.stringify(event)).not.toContain(credentials.accessToken);
		expect(Object.keys(event!.metadata)).not.toContain('code');
		expect(lines.join('\n')).not.toContain(`"code":"${code}"`);

		// Going back is the same action.
		const back = await activate(tenant, principal.id, { code: authenticator.code() });
		expect(back.statusCode, back.body).toBe(200);
		expect((await active(tenant)).id).toBe(principal.id);
		expect(listed(back).find((integration) => integration.id === backup.id)!.role).toBe('backup');
	});

	it('charges new purchases to the new principal, keeps started purchases on their account, and accepts both webhooks', async () => {
		const { tenant, principal, backup, credentials } = await withBackup('bk-orders');
		const before = await placeOrder(ctx, tenant);
		expect((await activate(tenant, backup.id, { code: authenticator.code() })).statusCode).toBe(200);
		const after = await placeOrder(ctx, tenant);

		expect((await orderByReference(ctx, tenant, before.reference)).paymentIntegrationId).toBe(principal.id);
		expect((await orderByReference(ctx, tenant, after.reference)).paymentIntegrationId).toBe(backup.id);
		expect(ctx.simulator.orders.get(after.checkoutId)!.accessToken).toBe(credentials.accessToken);

		const old = ctx.simulator.pay(before.checkoutId, 'approved');
		expect((await ctx.app.inject(webhookRequest(tenant, old.id))).statusCode).toBe(200);
		const current = ctx.simulator.pay(after.checkoutId, 'approved');
		expect((await ctx.app.inject(webhookRequest(tenant, current.id, credentials.webhookSecret))).statusCode).toBe(200);
		expect((await orderByReference(ctx, tenant, before.reference)).status).toBe('paid');
		expect((await orderByReference(ctx, tenant, after.reference)).status).toBe('paid');
	});

	it('refuses a wrong or a missing code in Spanish, changes nothing and never calls Mercado Pago', async () => {
		const { tenant, backup } = await withBackup('bk-wrong');
		const before = await rows(tenant);
		const calls = vi.spyOn(ctx.simulator, 'verifyAccount');
		try {
			const right = authenticator.code();
			const wrong = await activate(tenant, backup.id, { code: right === '000000' ? '111111' : '000000' });
			expect(wrong.statusCode).toBe(400);
			expect(wrong.json().error).toEqual({
				code: 'invalid_code',
				message: 'El código de tu app de autenticación no es válido, o ya se usó. No se cambió nada: probá con el código que muestra ahora.'
			});


			for (const payload of [undefined, {}, { code: '12345' }, { code: 'abcdef' }]) {
				const missing = await activate(tenant, backup.id, payload);
				expect(missing.statusCode).toBe(400);
				expect(missing.json().error.code).toBe('invalid_request');
			}
			expect(calls).not.toHaveBeenCalled();
		} finally {
			calls.mockRestore();
		}
		expect(await rows(tenant)).toEqual(before);
		expect(await audits(tenant, 'integration.mercadopago_promoted')).toEqual([]);
		expect((await userAudits('admin.mfa_failed')).map((event) => event.metadata)).toContainEqual({ purpose: 'integration.mercadopago_activate' });
	});

	it('accepts each code once: a replayed code is refused and changes nothing', async () => {
		const { tenant, principal, backup } = await withBackup('bk-replay');
		const code = authenticator.code();
		expect((await activate(tenant, backup.id, { code })).statusCode).toBe(200);
		const swapped = await rows(tenant);
		const replayed = await activate(tenant, principal.id, { code });
		expect([replayed.statusCode, replayed.json().error.code]).toEqual([400, 'invalid_code']);
		// An older code of the same app is refused too.
		const older = await activate(tenant, principal.id, { code: totpCode(authenticator.secret, totpStep(ctx.clock.now) - 1) });
		expect(older.statusCode).toBe(400);
		expect(await rows(tenant)).toEqual(swapped);
	});

	it('locks after 5 wrong codes in 15 minutes, even for the right one, and accepts it once the lock passes', async () => {
		const guesser = randomUUID();
		await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: guesser, email: `guesser-${guesser.slice(0, 6)}@test` }).onConflictDoNothing());
		const guesserAuth = { 'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN, authorization: `Bearer ${await ctx.signAdmin(guesser, `guesser-${guesser.slice(0, 6)}@test`)}` };
		const app = await enrolAuthenticator(ctx, guesser);
		const { tenant, backup } = await withBackup('bk-throttle');
		const before = await rows(tenant);
		const right = totpCode(app.secret, totpStep(ctx.clock.now));
		const wrong = right === '000000' ? '111111' : '000000';
		for (let attempt = 0; attempt < 5; attempt++) expect((await activate(tenant, backup.id, { code: wrong }, guesserAuth)).statusCode).toBe(400);
		const locked = await activate(tenant, backup.id, { code: right }, guesserAuth);
		expect(locked.statusCode).toBe(429);
		expect(locked.json().error).toMatchObject({ code: 'too_many_attempts', message: 'Demasiados intentos fallidos. Esperá unos minutos y probá de nuevo.' });
		expect(await rows(tenant)).toEqual(before);

		ctx.clock.now = new Date(ctx.clock.now.getTime() + 15 * 60_000);
		expect((await activate(tenant, backup.id, { code: app.code() }, guesserAuth)).statusCode).toBe(200);
	});

	it('needs a confirmed authenticator app', async () => {
		const plain = randomUUID();
		await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: plain, email: `plain-${plain.slice(0, 6)}@test` }).onConflictDoNothing());
		const plainAuth = { 'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN, authorization: `Bearer ${await ctx.signAdmin(plain, `plain-${plain.slice(0, 6)}@test`)}` };
		const { tenant, backup } = await withBackup('bk-no-app');
		const before = await rows(tenant);
		const response = await activate(tenant, backup.id, { code: '123456' }, plainAuth);
		expect(response.statusCode).toBe(409);
		expect(response.json().error).toMatchObject({
			code: 'totp_not_configured',
			message: 'Para cambiar o desvincular la cuenta que cobra necesitás tu app de autenticación. Configurala en Mi cuenta, en la verificación en dos pasos, y volvé a intentarlo.'
		});
		expect(await rows(tenant)).toEqual(before);
	});

	it('checks the stored credentials with Mercado Pago first: a refusal or another merchant changes nothing', async () => {
		const { tenant, backup } = await withBackup('bk-precheck');
		const before = await rows(tenant);
		const refused = vi.spyOn(ctx.simulator, 'verifyAccount').mockRejectedValueOnce(new ProviderError('unauthorized', 401));
		try {
			const response = await activate(tenant, backup.id, { code: authenticator.code() });
			expect(response.statusCode).toBe(400);
			expect(response.json().error).toMatchObject({
				code: 'credentials_rejected',
				message:
					'Mercado Pago rechazó las credenciales guardadas de esta cuenta (HTTP 401). Cargá credenciales nuevas en «Actualizar credenciales», o conectala de nuevo como cuenta de respaldo.'
			});
		} finally {
			refused.mockRestore();
		}
		const other = vi.spyOn(ctx.simulator, 'verifyAccount').mockResolvedValueOnce({ collectorId: 'another-merchant', nickname: null, testUser: true, simulator: true });
		try {
			const response = await activate(tenant, backup.id, { code: authenticator.code() });
			expect([response.statusCode, response.json().error.code]).toEqual([409, 'collector_mismatch']);
		} finally {
			other.mockRestore();
		}
		expect(await rows(tenant)).toEqual(before);
		expect(await audits(tenant, 'integration.mercadopago_promoted')).toEqual([]);
	});

	it('refuses the principal itself and organization roles before asking for the code', async () => {
		const { tenant, principal, backup } = await withBackup('bk-scope');
		const already = await activate(tenant, principal.id, { code: authenticator.code() });
		expect([already.statusCode, already.json().error.code]).toEqual([409, 'already_active']);
		for (const roleHeaders of [await adminHeaders(ctx, tenant), await adminHeaders(ctx, tenant, tenant.operatorId)]) {
			expect((await activate(tenant, backup.id, { code: '123456' }, roleHeaders)).statusCode).toBe(403);
		}
		expect((await active(tenant)).id).toBe(principal.id);
	});
});

describe('reactivating a previous account needs the code too', () => {
	it('refuses without a code and reactivates with it, retiring the principal and keeping the backup', async () => {
		const { tenant, principal, backup } = await withBackup('bk-reactivate');
		// The first backup moves to the previous accounts when another one is connected.
		const second = listed(await connectBackup(tenant)).find((integration) => integration.role === 'backup')!;
		const before = await rows(tenant);
		expect((await activate(tenant, backup.id)).statusCode).toBe(400);
		expect(await rows(tenant)).toEqual(before);

		const response = await activate(tenant, backup.id, { code: authenticator.code() });
		expect(response.statusCode, response.body).toBe(200);
		const roles = Object.fromEntries(listed(response).map((integration) => [integration.id, integration.role]));
		expect(roles).toEqual({ [backup.id]: 'principal', [principal.id]: 'previous', [second.id]: 'backup' });
		const [event] = await audits(tenant, 'integration.mercadopago_reactivated');
		expect(event).toMatchObject({ actorId: platformAdmin, targetId: backup.id, metadata: { retiredIntegrationId: principal.id, confirmedWith: 'totp' } });
	});
});

describe('which account signed the last notification (S6)', () => {
	it('shows the last notification of each account, and a rejected signature only organization-wide', async () => {
		const { tenant, principal, backup, credentials } = await withBackup('bk-webhooks');
		expect((await detail(tenant)).every((integration) => integration.lastWebhook === null)).toBe(true);

		expect((await ctx.app.inject(webhookRequest(tenant, 'ORD01PRINCIPAL', tenant.webhookSecret, 'payment'))).statusCode).toBe(200);
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		expect((await ctx.app.inject(webhookRequest(tenant, 'ORD01BACKUP', credentials.webhookSecret, 'payment'))).statusCode).toBe(200);
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		expect((await ctx.app.inject(webhookRequest(tenant, 'ORD01NOBODY', secret()))).statusCode).toBe(401);

		const events = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.paymentEvents).where(eq(s.paymentEvents.organizationId, tenant.id)));
		expect(Object.fromEntries(events.map((event) => [event.providerPaymentId, event.integrationId]))).toEqual({
			ORD01PRINCIPAL: principal.id,
			ORD01BACKUP: backup.id,
			ORD01NOBODY: null
		});
		const response = await ctx.app.inject({ method: 'GET', url: `/platform/organizations/${tenant.id}`, headers: auth });
		const shown = listed(response);
		expect(shown.find((integration) => integration.id === principal.id)!.lastWebhook).toMatchObject({ topic: 'payment', signatureValid: true, outcome: 'ignored_topic' });
		expect(shown.find((integration) => integration.id === backup.id)!.lastWebhook).toMatchObject({ topic: 'payment', signatureValid: true, outcome: 'ignored_topic' });
		expect(response.json().lastWebhook).toMatchObject({ signatureValid: false, outcome: 'rejected_signature' });
		expect(response.body).not.toMatch(/ORD01/);
	});
});
