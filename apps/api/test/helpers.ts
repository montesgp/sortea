import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, eq, schema as s, type DatabaseHandle } from '@sortea/db';
import { parseKeyRing, sealSecret, signWebhook } from '@sortea/domain/server';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { inject } from 'vitest';
import { buildApp } from '../src/app';
import type { AppDeps } from '../src/context';
import { createAdminTokenVerifier } from '../src/lib/admin-auth';
import { integrationOwner } from '../src/payments/integrations';
import { createPaymentSimulator, simulatorCollectorId } from '../src/payments/simulator';

export const INTERNAL_TOKEN = 'test-internal-token-0123456789';
const ISSUER = 'http://supabase.test/auth/v1';

export interface TestContext {
	app: Awaited<ReturnType<typeof buildApp>>;
	db: DatabaseHandle;
	deps: AppDeps;
	simulator: ReturnType<typeof createPaymentSimulator>;
	clock: { now: Date };
	signAdmin(userId: string, email: string, aal?: 'aal1' | 'aal2'): Promise<string>;
	close(): Promise<void>;
}

export async function createTestContext(options: { live?: { lifetimeMs?: number; heartbeatMs?: number } } = {}): Promise<TestContext> {
	const db = createDatabase(inject('databaseUrl'), { max: 8 });
	const clock = { now: new Date('2026-10-25T15:00:00Z') };
	const keyRing = parseKeyRing(`v1:${randomBytes(32).toString('base64')}`);
	const simulator = createPaymentSimulator({ webOrigin: 'http://localhost:5173', now: () => clock.now });
	const { publicKey, privateKey } = await generateKeyPair('ES256');
	const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'test' }] });

	const deps: AppDeps = {
		config: {
			NODE_ENV: 'test',
			API_PUBLIC_URL: 'http://api.test',
			WEB_FALLBACK_ORIGIN: 'http://localhost:5173',
			LOOKUP_PEPPER: 'lookup-pepper-for-tests-only',
			PSEUDONYM_PEPPER: 'pseudonym-pepper-for-tests-only',
			INTERNAL_API_TOKEN: INTERNAL_TOKEN,
			REQUIRE_ADMIN_MFA: false
		},
		db,
		keyRing,
		payments: simulator,
		simulator,
		storage: { signedUrl: async (path, seconds) => `https://storage.test/${path}?expires=${seconds}` },
		verifyAdminToken: createAdminTokenVerifier({ issuer: ISSUER, keys: jwks }),
		now: () => clock.now
	};
	const app = await buildApp(deps, { logger: process.env.TEST_LOG === '1', live: options.live });

	return {
		app,
		db,
		deps,
		simulator,
		clock,
		signAdmin: (userId, email, aal = 'aal2') =>
			new SignJWT({ email, aal, role: 'authenticated' })
				.setProtectedHeader({ alg: 'ES256', kid: 'test' })
				.setSubject(userId)
				.setIssuer(ISSUER)
				.setAudience('authenticated')
				.setIssuedAt()
				.setExpirationTime('1h')
				.sign(privateKey),
		async close() {
			await app.close();
			await db.close();
		}
	};
}

export interface TenantFixture {
	id: string;
	host: string;
	webhookSecret: string;
	ownerId: string;
	operatorId: string;
	manualVariantId: string;
	stickerVariantId: string;
	campaignId: string;
	campaignSlug: string;
}

/** A complete tenant: domain, payment account, catalog and a published campaign awaiting approvals. */
export async function createTenant(ctx: TestContext, label: string): Promise<TenantFixture> {
	const id = randomUUID();
	const host = `${label}-${id.slice(0, 8)}.test`;
	const webhookSecret = `whsec-${randomBytes(16).toString('hex')}`;
	const accessToken = `TEST-${randomBytes(16).toString('hex')}`;
	const ownerId = randomUUID();
	const operatorId = randomUUID();
	const ids = { manual: randomUUID(), sticker: randomUUID(), campaign: randomUUID(), manualProduct: randomUUID(), stickerProduct: randomUUID() };

	await ctx.db.withPlatform(async (db) => {
		await db.insert(s.organizations).values({
			id,
			slug: `${label}-${id.slice(0, 8)}`,
			name: label,
			orderPrefix: 'TT',
			settings: {
				contact: {},
				social: {},
				delivery: { pickupEnabled: true, shippingEnabled: true, shippingFeeMinor: 500_000 },
				legal: { termsVersion: 't1', privacyVersion: 'p1' },
				retentionDays: 30
			}
		});
		await db.insert(s.organizationDomains).values({ organizationId: id, hostname: host, isPrimary: true });
		await db.insert(s.organizationMembers).values([
			{ organizationId: id, userId: ownerId, email: `owner@${host}`, role: 'org_owner' },
			{ organizationId: id, userId: operatorId, email: `operator@${host}`, role: 'campaign_operator' }
		]);
		const integrationId = randomUUID();
		await db.insert(s.organizationIntegrations).values({
			id: integrationId,
			organizationId: id,
			provider: 'mercadopago',
			mode: 'sandbox',
			publicConfig: { collectorId: simulatorCollectorId(accessToken), simulator: 'true' },
			sealedSecrets: sealSecret(ctx.deps.keyRing, JSON.stringify({ accessToken, webhookSecret }), integrationOwner(id, integrationId)),
			keyVersion: 1,
			secretHint: 'TEST••••'
		});
		await db.insert(s.products).values([
			{ id: ids.manualProduct, organizationId: id, slug: 'manual', name: 'Manual', description: 'PDF', kind: 'digital', status: 'active' },
			{ id: ids.stickerProduct, organizationId: id, slug: 'sticker', name: 'Calcomanía', description: 'Vinilo', kind: 'physical', status: 'active' }
		]);
		await db.insert(s.productVariants).values([
			{ id: ids.manual, organizationId: id, productId: ids.manualProduct, sku: 'M', name: 'Manual', priceMinor: 1_200_000 },
			{ id: ids.sticker, organizationId: id, productId: ids.stickerProduct, sku: 'S', name: 'Calcomanía', priceMinor: 350_000, stock: 2 }
		]);
		await db.insert(s.productAssets).values({
			organizationId: id,
			productId: ids.manualProduct,
			storagePath: `${id}/manual.pdf`,
			filename: 'manual.pdf',
			contentType: 'application/pdf',
			sizeBytes: 100
		});
		await db.insert(s.campaigns).values({
			id: ids.campaign,
			organizationId: id,
			slug: 'moto',
			title: 'Moto 0 km',
			summary: 'Campaña de prueba',
			status: 'published',
			timezone: 'America/Argentina/Buenos_Aires',
			opensAt: new Date('2026-10-20T00:00:00Z'),
			closesAt: new Date('2026-11-28T23:00:00Z')
		});
		await db.insert(s.campaignApprovals).values([
			{ organizationId: id, campaignId: ids.campaign, kind: 'legal' },
			{ organizationId: id, campaignId: ids.campaign, kind: 'psp' }
		]);
		await db.insert(s.campaignRuleVersions).values({
			organizationId: id,
			campaignId: ids.campaign,
			version: 1,
			bodyMarkdown: 'Bases de prueba con texto suficiente.',
			eligibility: { minAge: 18, residency: 'AR', excluded: [] },
			entryRule: { mode: 'per_unit', entriesPerUnit: { [ids.manual]: 1 }, maxEntriesPerIdentity: null }
		});
		// AC-06: one vehicle, ten cash prizes and five physical prizes.
		await db.insert(s.prizes).values([
			{ organizationId: id, campaignId: ids.campaign, position: 1, kind: 'vehicle', title: 'Moto', declaredValueMinor: 800_000_000, quantity: 1, alternatesCount: 2 },
			{ organizationId: id, campaignId: ids.campaign, position: 2, kind: 'cash', title: '$100.000', declaredValueMinor: 10_000_000, quantity: 10 },
			{ organizationId: id, campaignId: ids.campaign, position: 3, kind: 'product', title: 'Kit', declaredValueMinor: 5_000_000, quantity: 5 }
		]);
	});
	ctx.app.tenants.invalidate();

	return {
		id,
		host,
		webhookSecret,
		ownerId,
		operatorId,
		manualVariantId: ids.manual,
		stickerVariantId: ids.sticker,
		campaignId: ids.campaign,
		campaignSlug: 'moto'
	};
}

export function headers(tenant: Pick<TenantFixture, 'host'>, extra: Record<string, string> = {}): Record<string, string> {
	return { 'x-internal-token': INTERNAL_TOKEN, 'x-tenant-host': tenant.host, 'x-client-ip': `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...extra };
}

export async function adminHeaders(ctx: TestContext, tenant: TenantFixture, userId = tenant.ownerId) {
	return headers(tenant, { authorization: `Bearer ${await ctx.signAdmin(userId, `user-${userId.slice(0, 4)}@test`)}` });
}

export function checkoutBody(tenant: TenantFixture, overrides: Record<string, unknown> = {}) {
	return {
		lines: [{ variantId: tenant.manualVariantId, quantity: 2 }],
		buyer: { documentType: 'DNI', documentNumber: '30.123.456', firstName: 'Juana', lastName: 'Pérez', email: 'juana@example.com' },
		delivery: { method: 'digital' },
		consents: { terms: true, privacy: true, marketingEmail: false },
		campaignSlug: tenant.campaignSlug,
		...overrides
	};
}

/** Opens the fixture campaign the legitimate way: approvals with evidence, then the transition. */
export async function openCampaign(ctx: TestContext, tenant: TenantFixture) {
	const auth = await adminHeaders(ctx, tenant);
	for (const kind of ['legal', 'psp']) {
		const response = await ctx.app.inject({
			method: 'PUT',
			url: `/admin/campaigns/${tenant.campaignId}/approvals/${kind}`,
			headers: auth,
			payload: { status: 'approved', reference: `EXP-${kind}-1`, authority: 'Autoridad de prueba' }
		});
		if (response.statusCode !== 200) throw new Error(`approval failed: ${response.body}`);
	}
	const opened = await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/transition`, headers: auth, payload: { to: 'open' } });
	if (opened.statusCode !== 200) throw new Error(`open failed: ${opened.body}`);
}

export async function placeOrder(ctx: TestContext, tenant: TenantFixture, overrides: Record<string, unknown> = {}) {
	const response = await ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant, overrides) });
	if (response.statusCode !== 201) throw new Error(`checkout failed: ${response.body}`);
	const body = response.json() as { reference: string; accessCode: string; redirectUrl: string; totalMinor: number };
	const preferenceId = new URL(body.redirectUrl).searchParams.get('pref')!;
	return { ...body, preferenceId };
}

export function webhookRequest(tenant: TenantFixture, paymentId: string, secret = tenant.webhookSecret) {
	const requestId = randomUUID();
	const ts = '1793000000';
	return {
		method: 'POST' as const,
		url: `/webhooks/mercadopago/${tenant.id}?data.id=${paymentId}&type=payment`,
		headers: { 'x-signature': `ts=${ts},v1=${signWebhook(secret, paymentId, requestId, ts)}`, 'x-request-id': requestId },
		payload: { type: 'payment', data: { id: paymentId } }
	};
}

export async function orderByReference(ctx: TestContext, tenant: TenantFixture, reference: string) {
	const [order] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.orders).where(eq(s.orders.reference, reference)));
	return order!;
}
