import { randomUUID } from 'node:crypto';
import { and, eq, schema as s } from '@sortea/db';
import { WEBHOOK_SECRET_IS_ACCESS_TOKEN } from '@sortea/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadMercadoPagoAccounts } from '../src/payments/integrations';
import { simulatorCollectorId } from '../src/payments/simulator';
import {
	adminHeaders,
	createTenant,
	createTestContext,
	enrolAuthenticator,
	switchMercadoPago,
	webhookRequest,
	type Authenticator,
	type TenantFixture,
	type TestContext
} from './helpers';

// Platform staff update an account's credentials in place, without
// disconnecting or switching (owner, 2026-11-10: "no puedo editar la
// integracion de mercado pago"), and see whether the last webhook passed its
// signature check, to confirm the "Firma secreta" of Mercado Pago's Webhooks.

let ctx: TestContext;
let auth: Record<string, string>;
let authenticator: Authenticator;
const platformAdmin = '00000000-0000-4000-8000-00000000c7e1';

beforeAll(async () => {
	ctx = await createTestContext();
	await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: platformAdmin, email: 'credentials@test' }).onConflictDoNothing());
	auth = { 'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN, authorization: `Bearer ${await ctx.signAdmin(platformAdmin, 'credentials@test')}` };
	authenticator = await enrolAuthenticator(ctx, platformAdmin);
});
afterAll(() => ctx.close());

const token = () => `TEST-${randomUUID().replaceAll('-', '')}`;
const secret = () => `whsec-${randomUUID().replaceAll('-', '')}`;
const base = (tenant: TenantFixture) => `/platform/organizations/${tenant.id}/integrations/mercadopago`;
const connect = (tenant: TenantFixture, accessToken: string, webhookSecret: string, role: 'principal' | 'backup' = 'principal') =>
	ctx.app.inject({ method: 'PUT', url: base(tenant), headers: auth, payload: { mode: 'sandbox', accessToken, webhookSecret, role } });
const update = (tenant: TenantFixture, integrationId: string, payload: Record<string, unknown>, as: Record<string, string> = auth) =>
	ctx.app.inject({ method: 'PATCH', url: `${base(tenant)}/${integrationId}`, headers: as, payload });
const rows = (tenant: TenantFixture) =>
	ctx.db.withPlatform((db) =>
		db
			.select()
			.from(s.organizationIntegrations)
			.where(and(eq(s.organizationIntegrations.organizationId, tenant.id), eq(s.organizationIntegrations.provider, 'mercadopago')))
	);
const credentials = async (tenant: TenantFixture, integrationId: string) =>
	(await ctx.db.withTenant(tenant.id, (tx) => loadMercadoPagoAccounts(tx, tenant.id, ctx.deps.keyRing))).find((account) => account.id === integrationId)!.credentials;
const audits = (tenant: TenantFixture) =>
	ctx.db.withTenant(tenant.id, (tx) =>
		tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.organizationId, tenant.id), eq(s.auditEvents.action, 'integration.mercadopago.credentials_updated')))
	);
const detail = (tenant: TenantFixture) => ctx.app.inject({ method: 'GET', url: `/platform/organizations/${tenant.id}`, headers: auth });

/** A tenant whose only account, the principal, was connected with these known credentials. */
async function connected(label: string) {
	const tenant = await createTenant(ctx, label, { mercadoPago: false });
	const accessToken = token();
	const webhookSecret = secret();
	const response = await connect(tenant, accessToken, webhookSecret);
	expect(response.statusCode).toBe(200);
	const active = response.json().integrations.find((integration: { isActive: boolean }) => integration.isActive) as { id: string; version: number };
	return { tenant, accessToken, webhookSecret, integrationId: active.id, version: active.version, collectorId: simulatorCollectorId(accessToken) };
}

/** The simulator answering for this merchant whatever the token, as Mercado Pago does for a renewed token. */
const sameMerchant = (collectorId: string, account: { testUser?: boolean; simulator?: true } = { testUser: true, simulator: true }) =>
	vi.spyOn(ctx.simulator, 'verifyAccount').mockResolvedValueOnce({ collectorId, nickname: 'SIMULADOR', testUser: account.testUser ?? false, ...(account.simulator ? { simulator: true } : {}) });

describe('update credentials', () => {
	// Independent verification 2026-11-10: the console showed Zod's English default for a short secret.
	it('explains in Spanish why a webhook secret is too short, without echoing it', async () => {
		const account = await connected('creds-short');
		const response = await update(account.tenant, account.integrationId, { webhookSecret: 'shortsecret' });
		expect(response.statusCode).toBe(400);
		expect(response.json().error.details.fieldErrors.webhookSecret[0]).toMatch(/firma secreta del webhook/i);
		expect(response.body).not.toContain('shortsecret');
	});

	it('replaces the access token of the same merchant, keeps the webhook secret and audits only which fields changed', async () => {
		const account = await connected('creds-token');
		const renewed = token();
		const spy = sameMerchant(account.collectorId);
		let response;
		try {
			response = await update(account.tenant, account.integrationId, { accessToken: renewed });
		} finally {
			spy.mockRestore();
		}
		expect(response.statusCode).toBe(200);
		expect(response.body).not.toContain(renewed);
		const shown = response.json().integrations.find((integration: { id: string }) => integration.id === account.integrationId);
		expect(shown).toMatchObject({ isActive: true, status: 'verified', collectorId: account.collectorId, version: account.version + 1, lastError: null });
		expect(await credentials(account.tenant, account.integrationId)).toEqual({ accessToken: renewed, webhookSecret: account.webhookSecret });
		// Updating adds no account.
		expect(await rows(account.tenant)).toHaveLength(1);

		const [event, ...rest] = await audits(account.tenant);
		expect(rest).toEqual([]);
		expect(event).toMatchObject({
			actorType: 'platform_admin',
			actorId: platformAdmin,
			targetType: 'integration',
			targetId: account.integrationId,
			metadata: { fields: ['accessToken'], mode: 'sandbox', collectorId: account.collectorId, active: true, version: account.version + 1, testUser: true }
		});
		expect(JSON.stringify(event)).not.toContain(renewed);
		expect(JSON.stringify(event)).not.toContain(account.webhookSecret);
	});

	it('replaces only the webhook secret without calling Mercado Pago, sealed, and webhooks then verify with it', async () => {
		const account = await connected('creds-secret');
		const renewed = secret();
		const spy = vi.spyOn(ctx.simulator, 'verifyAccount');
		let response;
		try {
			response = await update(account.tenant, account.integrationId, { webhookSecret: renewed });
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
		expect(response.statusCode).toBe(200);
		expect(response.body).not.toContain(renewed);
		expect(await credentials(account.tenant, account.integrationId)).toEqual({ accessToken: account.accessToken, webhookSecret: renewed });
		const row = (await rows(account.tenant)).find((candidate) => candidate.id === account.integrationId);
		expect(row!.sealedSecrets).not.toContain(renewed);
		expect(row!.version).toBe(account.version + 1);

		const [event] = await audits(account.tenant);
		expect(event?.metadata).toMatchObject({ fields: ['webhookSecret'] });
		expect(JSON.stringify(event)).not.toContain(renewed);

		const tenant = { ...account.tenant, webhookSecret: renewed };
		const accepted = await ctx.app.inject(webhookRequest(tenant, 'ORD01SECRETCHECK', renewed, 'payment'));
		expect(accepted.statusCode).toBe(200);
		const refused = await ctx.app.inject(webhookRequest(tenant, 'ORD01SECRETCHECK', account.webhookSecret));
		expect(refused.statusCode).toBe(401);
	});

	it('replaces both at once and refreshes the account kind like a verification', async () => {
		const account = await connected('creds-both');
		const renewedToken = token();
		const renewedSecret = secret();
		const spy = sameMerchant(account.collectorId, { testUser: false });
		let response;
		try {
			response = await update(account.tenant, account.integrationId, { accessToken: renewedToken, webhookSecret: renewedSecret });
		} finally {
			spy.mockRestore();
		}
		expect(response.statusCode).toBe(200);
		const shown = response.json().integrations.find((integration: { id: string }) => integration.id === account.integrationId);
		expect(shown).toMatchObject({ testUser: false, simulator: false });
		expect(await credentials(account.tenant, account.integrationId)).toEqual({ accessToken: renewedToken, webhookSecret: renewedSecret });
		const [event] = await audits(account.tenant);
		expect(event?.metadata).toMatchObject({ fields: ['accessToken', 'webhookSecret'], testUser: false });
	});

	it('refuses a token of another merchant: that is switching accounts', async () => {
		const account = await connected('creds-other');
		const before = await rows(account.tenant);
		const other = token();
		const response = await update(account.tenant, account.integrationId, { accessToken: other, webhookSecret: secret() });
		expect(response.statusCode).toBe(409);
		expect(response.json().error).toMatchObject({
			code: 'collector_mismatch',
			message: `El access token nuevo es de otra cuenta de Mercado Pago (${simulatorCollectorId(other)}), no de la cuenta ${account.collectorId}. Para cobrar con otra cuenta, conectala como cuenta de respaldo y usá «Usar como principal».`
		});
		expect(await rows(account.tenant)).toEqual(before);
		expect(await audits(account.tenant)).toEqual([]);
	});

	it('refuses a token Mercado Pago rejects, and a malformed one, changing nothing', async () => {
		const account = await connected('creds-rejected');
		const before = await rows(account.tenant);
		const rejected = await update(account.tenant, account.integrationId, { accessToken: 'APP_USR-1234567890-rejected-by-provider' });
		expect(rejected.statusCode).toBe(400);
		expect(rejected.json().error).toMatchObject({
			code: 'credentials_rejected',
			message: 'Mercado Pago rechazó el access token nuevo (HTTP 401). Revisá que sea el de esta cuenta y de este entorno.'
		});
		const malformed = await update(account.tenant, account.integrationId, { accessToken: 'not-a-token' });
		expect(malformed.statusCode).toBe(400);
		expect(malformed.json().error).toMatchObject({ code: 'invalid_request' });
		expect(await rows(account.tenant)).toEqual(before);
		expect(await audits(account.tenant)).toEqual([]);
	});

	it('refuses an empty update', async () => {
		const account = await connected('creds-empty');
		for (const payload of [{}, { accessToken: '', webhookSecret: '  ' }]) {
			const response = await update(account.tenant, account.integrationId, payload);
			expect(response.statusCode).toBe(400);
			expect(response.json().error).toMatchObject({
				code: 'nothing_to_update',
				message: 'Cargá un access token nuevo, una firma secreta del webhook nueva o ambos.'
			});
		}
		expect(await audits(account.tenant)).toEqual([]);
	});

	it('refuses an access token pasted as the webhook secret, here and when connecting', async () => {
		const account = await connected('creds-guard');
		const before = await rows(account.tenant);
		const pasted = token();
		const response = await update(account.tenant, account.integrationId, { webhookSecret: pasted });
		expect(response.statusCode).toBe(400);
		expect(response.json().error).toMatchObject({ code: 'invalid_webhook_secret', message: WEBHOOK_SECRET_IS_ACCESS_TOKEN });
		const connecting = await connect(account.tenant, token(), pasted);
		expect(connecting.statusCode).toBe(400);
		expect(connecting.json().error).toMatchObject({ code: 'invalid_webhook_secret', message: WEBHOOK_SECRET_IS_ACCESS_TOKEN });
		expect(await rows(account.tenant)).toEqual(before);
	});

	it('a production account needs an APP_USR token', async () => {
		const account = await connected('creds-production');
		await ctx.db.withPlatform((db) => db.update(s.organizationIntegrations).set({ mode: 'production' }).where(eq(s.organizationIntegrations.id, account.integrationId)));
		const response = await update(account.tenant, account.integrationId, { accessToken: token() });
		expect(response.statusCode).toBe(400);
		expect(response.json().error).toMatchObject({ code: 'invalid_token', message: 'Producción requiere un access token APP_USR' });
	});

	it('updates a previous account in place: it stays retired and the active account is untouched', async () => {
		const first = await connected('creds-retired');
		// The first account becomes the backup after the switch, and a previous account once another backup is connected.
		expect((await switchMercadoPago(ctx, first.tenant, auth, authenticator, { accessToken: token(), webhookSecret: secret() })).statusCode).toBe(200);
		expect((await connect(first.tenant, token(), secret(), 'backup')).statusCode).toBe(200);
		const activeBefore = (await rows(first.tenant)).find((row) => row.isActive)!;
		const renewed = secret();
		const response = await update(first.tenant, first.integrationId, { webhookSecret: renewed });
		expect(response.statusCode).toBe(200);
		const after = await rows(first.tenant);
		expect(after.find((row) => row.id === first.integrationId)).toMatchObject({ isActive: false });
		expect(after.find((row) => row.id === first.integrationId)!.retiredAt).not.toBeNull();
		expect(after.find((row) => row.id === activeBefore.id)).toEqual(activeBefore);
		expect(await credentials(first.tenant, first.integrationId)).toEqual({ accessToken: first.accessToken, webhookSecret: renewed });
		const [event] = await audits(first.tenant);
		expect(event?.metadata).toMatchObject({ fields: ['webhookSecret'], active: false });
	});

	it("cannot update another organization's account, and only platform staff can update", async () => {
		const account = await connected('creds-own');
		const other = await connected('creds-foreign');
		const before = await rows(other.tenant);
		const foreign = await update(account.tenant, other.integrationId, { webhookSecret: secret() });
		expect(foreign.statusCode).toBe(404);
		expect(await rows(other.tenant)).toEqual(before);
		const staff = await update(account.tenant, account.integrationId, { webhookSecret: secret() }, await adminHeaders(ctx, account.tenant));
		expect(staff.statusCode).toBe(403);
		expect(await audits(account.tenant)).toEqual([]);
		expect(await audits(other.tenant)).toEqual([]);
	});
});

describe('webhook diagnostics', () => {
	it('shows when the last notification arrived and whether its signature was accepted', async () => {
		const tenant = await createTenant(ctx, 'creds-diagnostics');
		expect((await detail(tenant)).json().lastWebhook).toBeNull();

		expect((await ctx.app.inject(webhookRequest(tenant, 'ORD01DIAGNOSTIC', 'wrong-secret-0123456789'))).statusCode).toBe(401);
		const refused = (await detail(tenant)).json().lastWebhook;
		expect(refused).toMatchObject({ signatureValid: false, outcome: 'rejected_signature', topic: 'order' });
		expect(new Date(refused.receivedAt).getTime()).not.toBeNaN();
		expect(JSON.stringify(refused)).not.toContain('ORD01DIAGNOSTIC');

		expect((await ctx.app.inject(webhookRequest(tenant, 'ORD01DIAGNOSTIC', tenant.webhookSecret, 'payment'))).statusCode).toBe(200);
		expect((await detail(tenant)).json().lastWebhook).toMatchObject({ signatureValid: true, outcome: 'ignored_topic', topic: 'payment' });
	});

	it("an organization never sees another organization's notifications", async () => {
		const tenant = await createTenant(ctx, 'creds-diag-own');
		const other = await createTenant(ctx, 'creds-diag-other');
		expect((await ctx.app.inject(webhookRequest(other, 'ORD01OTHER', other.webhookSecret, 'payment'))).statusCode).toBe(200);
		expect((await detail(tenant)).json().lastWebhook).toBeNull();
	});
});
